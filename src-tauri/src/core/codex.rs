//! Codex runtime detection helpers.

use serde::{Deserialize, Serialize};
use specta::Type;
use std::env;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;
use tokio::task::JoinHandle;
use tokio::time::{sleep, timeout, Duration};

pub const CODEX_CLI_ENV_VAR: &str = "OPENREELIO_CODEX_CLI";
pub const DEFAULT_CODEX_MODEL: &str = "gpt-5.5";
pub const DEFAULT_CODEX_REASONING_EFFORT: &str = "medium";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CodexExecutablePlatform {
    Windows,
    Unix,
}

impl CodexExecutablePlatform {
    fn current() -> Self {
        if cfg!(windows) {
            Self::Windows
        } else {
            Self::Unix
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CodexStatusProbeResult {
    pub installed: bool,
    pub version: Option<String>,
    pub auth_status: String,
    pub app_server_ready: Option<bool>,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CodexModelInfo {
    pub slug: String,
    pub display_name: String,
    pub default_reasoning_effort: String,
    pub supported_reasoning_efforts: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CodexModelCatalogResult {
    pub installed: bool,
    pub default_model: String,
    pub default_reasoning_effort: String,
    pub models: Vec<CodexModelInfo>,
    pub reason: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RawCodexModelCatalog {
    #[serde(default)]
    models: Vec<RawCodexModelInfo>,
}

#[derive(Debug, Deserialize)]
struct RawCodexModelInfo {
    slug: String,
    #[serde(default)]
    display_name: Option<String>,
    #[serde(default)]
    default_reasoning_level: Option<String>,
    #[serde(default)]
    supported_reasoning_levels: Vec<RawCodexReasoningLevel>,
    #[serde(default)]
    visibility: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RawCodexReasoningLevel {
    effort: String,
}

pub fn resolve_codex_executable() -> Option<PathBuf> {
    let platform = CodexExecutablePlatform::current();
    if let Some(path) = env::var_os(CODEX_CLI_ENV_VAR)
        .map(PathBuf::from)
        .filter(|path| is_supported_codex_executable(path, platform))
    {
        return Some(path);
    }

    let home_dir = dirs::home_dir();
    let user_profile = env::var_os("USERPROFILE").map(PathBuf::from);
    let appdata = env::var_os("APPDATA").map(PathBuf::from);
    let local_appdata = env::var_os("LOCALAPPDATA").map(PathBuf::from);
    let mut candidates = collect_codex_executable_candidates(
        env::var_os("PATH"),
        home_dir,
        user_profile,
        appdata,
        local_appdata,
    );

    candidates.extend(find_wsl_windows_user_codex_candidates(platform));
    resolve_first_runnable_candidate(candidates, platform)
}

pub fn create_codex_command() -> Result<Command, String> {
    let executable = resolve_codex_executable().ok_or_else(|| {
        "Codex executable was not found in PATH or common install locations.".to_string()
    })?;
    let mut command = Command::new(executable);
    crate::core::process::configure_tokio_command(&mut command);
    command.kill_on_drop(true);
    Ok(command)
}

pub fn codex_command_label() -> String {
    resolve_codex_executable()
        .map(|path| path.display().to_string())
        .unwrap_or_else(|| "codex".to_string())
}

pub fn parse_codex_version(stdout: &str, stderr: &str) -> Option<String> {
    let candidate = stdout
        .lines()
        .chain(stderr.lines())
        .map(str::trim)
        .find(|line| !line.is_empty())?;

    Some(candidate.to_string())
}

pub fn parse_codex_auth_status(
    stdout: &str,
    stderr: &str,
    command_succeeded: bool,
) -> (String, Option<String>) {
    let output = stdout
        .lines()
        .chain(stderr.lines())
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    let normalized = output.to_lowercase();

    if normalized.contains("not logged in")
        || normalized.contains("not signed in")
        || normalized.contains("not authenticated")
        || normalized.contains("login required")
    {
        return ("signed-out".to_string(), Some(output));
    }

    if normalized.contains("api key") || normalized.contains("api-key") {
        return ("api-key".to_string(), None);
    }

    if normalized.contains("logged in")
        || normalized.contains("signed in")
        || normalized.contains("authenticated")
    {
        return ("signed-in".to_string(), None);
    }

    if command_succeeded {
        (
            "unknown".to_string(),
            Some("codex login status returned an unrecognized status".to_string()),
        )
    } else {
        (
            "error".to_string(),
            Some(if output.is_empty() {
                "codex login status failed without output".to_string()
            } else {
                format!("codex login status failed: {output}")
            }),
        )
    }
}

pub async fn probe_codex_status() -> CodexStatusProbeResult {
    let mut version_command = match create_codex_command() {
        Ok(command) => command,
        Err(reason) => {
            return CodexStatusProbeResult {
                installed: false,
                version: None,
                auth_status: "unknown".to_string(),
                app_server_ready: None,
                reason: Some(reason),
            };
        }
    };

    let version_output = match timeout(
        Duration::from_secs(5),
        version_command.arg("--version").output(),
    )
    .await
    {
        Ok(output) => output,
        Err(_) => {
            return CodexStatusProbeResult {
                installed: false,
                version: None,
                auth_status: "unknown".to_string(),
                app_server_ready: None,
                reason: Some("codex --version timed out".to_string()),
            };
        }
    };

    match version_output {
        Ok(output) if output.status.success() => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);
            let version = parse_codex_version(&stdout, &stderr);
            let mut auth_command = match create_codex_command() {
                Ok(command) => command,
                Err(reason) => {
                    return CodexStatusProbeResult {
                        installed: true,
                        version,
                        auth_status: "error".to_string(),
                        app_server_ready: None,
                        reason: Some(reason),
                    };
                }
            };
            let auth_output = match timeout(
                Duration::from_secs(5),
                auth_command.arg("login").arg("status").output(),
            )
            .await
            {
                Ok(output) => output,
                Err(_) => {
                    return CodexStatusProbeResult {
                        installed: true,
                        version,
                        auth_status: "error".to_string(),
                        app_server_ready: None,
                        reason: Some("codex login status timed out".to_string()),
                    };
                }
            };

            match auth_output {
                Ok(output) => {
                    let stdout = String::from_utf8_lossy(&output.stdout);
                    let stderr = String::from_utf8_lossy(&output.stderr);
                    let (auth_status, auth_reason) =
                        parse_codex_auth_status(&stdout, &stderr, output.status.success());
                    let authenticated = auth_status == "signed-in" || auth_status == "api-key";
                    let app_server_probe = if authenticated {
                        let app_server_model = default_codex_model_for_version(version.as_deref());
                        match probe_codex_app_server_initialization(
                            app_server_model,
                            DEFAULT_CODEX_REASONING_EFFORT,
                        )
                        .await
                        {
                            Ok(()) => (Some(true), None),
                            Err(reason) => (Some(false), Some(reason)),
                        }
                    } else {
                        (None, None)
                    };

                    CodexStatusProbeResult {
                        installed: true,
                        version,
                        auth_status,
                        app_server_ready: app_server_probe.0,
                        reason: app_server_probe.1.or(auth_reason),
                    }
                }
                Err(error) => CodexStatusProbeResult {
                    installed: true,
                    version,
                    auth_status: "error".to_string(),
                    app_server_ready: None,
                    reason: Some(format_codex_io_error(
                        "Failed to run codex login status",
                        &error,
                    )),
                },
            }
        }
        Ok(output) => CodexStatusProbeResult {
            installed: false,
            version: None,
            auth_status: "unknown".to_string(),
            app_server_ready: None,
            reason: Some(format!(
                "codex --version failed with status {}",
                output.status
            )),
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => CodexStatusProbeResult {
            installed: false,
            version: None,
            auth_status: "unknown".to_string(),
            app_server_ready: None,
            reason: Some(
                "Codex executable was not found in PATH or common install locations.".to_string(),
            ),
        },
        Err(error) => CodexStatusProbeResult {
            installed: false,
            version: None,
            auth_status: "unknown".to_string(),
            app_server_ready: None,
            reason: Some(format_codex_io_error(
                "Failed to run codex --version",
                &error,
            )),
        },
    }
}

async fn probe_codex_app_server_initialization(model: &str, effort: &str) -> Result<(), String> {
    let mut command = create_codex_command()?;
    command
        .arg("app-server")
        .arg("-c")
        .arg(format!("model={}", quote_toml_string(model)))
        .arg("-c")
        .arg(format!(
            "model_reasoning_effort={}",
            quote_toml_string(effort)
        ))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = command
        .spawn()
        .map_err(|error| format_codex_io_error("Failed to start codex app-server", &error))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to open Codex app-server stdout".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Failed to open Codex app-server stderr".to_string())?;
    let stdout_task = tokio::spawn(read_process_stream(stdout));
    let stderr_task = tokio::spawn(read_process_stream(stderr));

    // The app-server is not an MCP server; requiring an `initialize` response here
    // incorrectly marks older but usable Codex builds as unavailable. A successful
    // smoke test means the process starts and stays alive for the readiness window.
    sleep(Duration::from_millis(1_200)).await;

    match child.try_wait() {
        Ok(Some(status)) => {
            let stdout = await_process_output(stdout_task).await;
            let stderr = await_process_output(stderr_task).await;
            Err(format!(
                "codex app-server exited during startup with status {status}: {}",
                collect_command_output(&stdout, &stderr)
            ))
        }
        Ok(None) => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            Ok(())
        }
        Err(error) => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            Err(format_codex_io_error(
                "Failed to inspect codex app-server startup",
                &error,
            ))
        }
    }
}

async fn read_process_stream<R>(mut stream: R) -> Vec<u8>
where
    R: AsyncRead + Unpin + Send + 'static,
{
    let mut output = Vec::new();
    let _ = stream.read_to_end(&mut output).await;
    output
}

async fn await_process_output(task: JoinHandle<Vec<u8>>) -> Vec<u8> {
    timeout(Duration::from_millis(500), task)
        .await
        .ok()
        .and_then(Result::ok)
        .unwrap_or_default()
}

pub async fn get_codex_model_catalog() -> CodexModelCatalogResult {
    let mut command = match create_codex_command() {
        Ok(command) => command,
        Err(reason) => {
            return CodexModelCatalogResult {
                installed: false,
                default_model: DEFAULT_CODEX_MODEL.to_string(),
                default_reasoning_effort: DEFAULT_CODEX_REASONING_EFFORT.to_string(),
                models: default_codex_models(),
                reason: Some(reason),
            };
        }
    };

    let output = match timeout(
        Duration::from_secs(10),
        command.arg("debug").arg("models").output(),
    )
    .await
    {
        Ok(Ok(output)) => output,
        Ok(Err(error)) => {
            return CodexModelCatalogResult {
                installed: false,
                default_model: DEFAULT_CODEX_MODEL.to_string(),
                default_reasoning_effort: DEFAULT_CODEX_REASONING_EFFORT.to_string(),
                models: default_codex_models(),
                reason: Some(format_codex_io_error(
                    "Failed to read Codex model catalog",
                    &error,
                )),
            };
        }
        Err(_) => {
            return fallback_codex_model_catalog(
                true,
                Some("Codex model catalog request timed out.".to_string()),
            )
            .await;
        }
    };

    if !output.status.success() {
        return fallback_codex_model_catalog(
            true,
            Some(collect_command_output(&output.stdout, &output.stderr)),
        )
        .await;
    }

    match parse_codex_model_catalog(&String::from_utf8_lossy(&output.stdout)) {
        Ok(models) => {
            let (default_model, default_reasoning_effort) = resolve_codex_catalog_default(&models);
            CodexModelCatalogResult {
                installed: true,
                default_model,
                default_reasoning_effort,
                models,
                reason: None,
            }
        }
        Err(reason) => fallback_codex_model_catalog(true, Some(reason)).await,
    }
}

async fn fallback_codex_model_catalog(
    installed: bool,
    reason: Option<String>,
) -> CodexModelCatalogResult {
    let version = if installed {
        read_codex_version_label().await
    } else {
        None
    };
    let default_model = default_codex_model_for_version(version.as_deref()).to_string();

    CodexModelCatalogResult {
        installed,
        default_model,
        default_reasoning_effort: DEFAULT_CODEX_REASONING_EFFORT.to_string(),
        models: default_codex_models_for_version(version.as_deref()),
        reason,
    }
}

fn resolve_codex_catalog_default(models: &[CodexModelInfo]) -> (String, String) {
    let model = models
        .iter()
        .find(|model| model.slug == DEFAULT_CODEX_MODEL)
        .or_else(|| models.first());

    match model {
        Some(model) => (model.slug.clone(), model.default_reasoning_effort.clone()),
        None => (
            DEFAULT_CODEX_MODEL.to_string(),
            DEFAULT_CODEX_REASONING_EFFORT.to_string(),
        ),
    }
}

fn parse_codex_model_catalog(input: &str) -> Result<Vec<CodexModelInfo>, String> {
    let catalog: RawCodexModelCatalog = serde_json::from_str(input)
        .map_err(|error| format!("Failed to parse Codex model catalog: {error}"))?;
    let models = catalog
        .models
        .into_iter()
        .filter(|model| model.visibility.as_deref() != Some("hide"))
        .map(|model| {
            let supported_reasoning_efforts = model
                .supported_reasoning_levels
                .into_iter()
                .map(|level| level.effort)
                .filter(|effort| !effort.trim().is_empty())
                .collect::<Vec<_>>();
            CodexModelInfo {
                display_name: model.display_name.unwrap_or_else(|| model.slug.clone()),
                slug: model.slug,
                default_reasoning_effort: model
                    .default_reasoning_level
                    .unwrap_or_else(|| DEFAULT_CODEX_REASONING_EFFORT.to_string()),
                supported_reasoning_efforts: if supported_reasoning_efforts.is_empty() {
                    default_reasoning_efforts()
                } else {
                    supported_reasoning_efforts
                },
            }
        })
        .collect::<Vec<_>>();

    if models.is_empty() {
        Ok(default_codex_models())
    } else {
        Ok(models)
    }
}

fn default_codex_models() -> Vec<CodexModelInfo> {
    default_codex_models_for_version(None)
}

fn default_codex_models_for_version(version: Option<&str>) -> Vec<CodexModelInfo> {
    let entries: &[(&str, &str)] = if codex_version_supports_gpt_5_5(version) {
        &[
            ("gpt-5.5", "gpt-5.5"),
            ("gpt-5.4", "gpt-5.4"),
            ("gpt-5.4-mini", "GPT-5.4-Mini"),
            ("gpt-5.3-codex", "gpt-5.3-codex"),
            ("gpt-5.3-codex-spark", "GPT-5.3-Codex-Spark"),
            ("gpt-5.2", "gpt-5.2"),
        ]
    } else {
        &[
            ("gpt-5.4", "gpt-5.4"),
            ("gpt-5.4-mini", "GPT-5.4-Mini"),
            ("gpt-5.3-codex", "gpt-5.3-codex"),
            ("gpt-5.3-codex-spark", "GPT-5.3-Codex-Spark"),
            ("gpt-5.2", "gpt-5.2"),
        ]
    };

    entries
        .iter()
        .map(|(slug, display_name)| CodexModelInfo {
            slug: (*slug).to_string(),
            display_name: (*display_name).to_string(),
            default_reasoning_effort: DEFAULT_CODEX_REASONING_EFFORT.to_string(),
            supported_reasoning_efforts: default_reasoning_efforts(),
        })
        .collect()
}

pub fn normalize_codex_model_for_version(requested_model: String, version: Option<&str>) -> String {
    if requested_model == DEFAULT_CODEX_MODEL && !codex_version_supports_gpt_5_5(version) {
        return "gpt-5.4".to_string();
    }

    requested_model
}

pub async fn normalize_codex_model_for_installed_cli(requested_model: String) -> String {
    let version = read_codex_version_label().await;
    normalize_codex_model_for_version(requested_model, version.as_deref())
}

fn default_codex_model_for_version(version: Option<&str>) -> &'static str {
    if codex_version_supports_gpt_5_5(version) {
        DEFAULT_CODEX_MODEL
    } else {
        "gpt-5.4"
    }
}

fn codex_version_supports_gpt_5_5(version: Option<&str>) -> bool {
    let Some((major, minor, _patch)) = version.and_then(parse_codex_version_numbers) else {
        return true;
    };

    major > 0 || minor >= 130
}

pub(crate) fn parse_codex_version_numbers(label: &str) -> Option<(u64, u64, u64)> {
    label.split_whitespace().find_map(|token| {
        let token = token.trim_start_matches('v');
        let numeric = token
            .split(|ch: char| !(ch.is_ascii_digit() || ch == '.'))
            .find(|part| part.contains('.'))?;
        let mut parts = numeric.split('.');
        let major = parts.next()?.parse().ok()?;
        let minor = parts.next()?.parse().ok()?;
        let patch = parts.next().unwrap_or("0").parse().ok()?;
        Some((major, minor, patch))
    })
}

async fn read_codex_version_label() -> Option<String> {
    let mut command = create_codex_command().ok()?;
    let output = timeout(Duration::from_secs(5), command.arg("--version").output())
        .await
        .ok()?
        .ok()?;
    if !output.status.success() {
        return None;
    }

    parse_codex_version(
        &String::from_utf8_lossy(&output.stdout),
        &String::from_utf8_lossy(&output.stderr),
    )
}

fn default_reasoning_efforts() -> Vec<String> {
    ["low", "medium", "high", "xhigh"]
        .into_iter()
        .map(String::from)
        .collect()
}

fn collect_command_output(stdout: &[u8], stderr: &[u8]) -> String {
    let stdout = String::from_utf8_lossy(stdout);
    let stderr = String::from_utf8_lossy(stderr);
    let combined = stdout
        .lines()
        .chain(stderr.lines())
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    if combined.is_empty() {
        "Codex command failed without output.".to_string()
    } else {
        combined
    }
}

fn quote_toml_string(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

pub fn format_codex_io_error(action: &str, error: &std::io::Error) -> String {
    if error.kind() == std::io::ErrorKind::NotFound {
        return format!(
            "{action}: Codex executable was not found in PATH or common install locations."
        );
    }

    if error.raw_os_error() == Some(193) || error.to_string().contains("Win32") {
        return format!(
            "{action}: The selected Codex launcher is not executable on this OS. Use a native Codex CLI launcher such as codex.cmd or codex.exe."
        );
    }

    format!("{action}: {error}")
}

fn collect_codex_executable_candidates(
    path_env: Option<OsString>,
    home_dir: Option<PathBuf>,
    user_profile: Option<PathBuf>,
    appdata: Option<PathBuf>,
    local_appdata: Option<PathBuf>,
) -> Vec<PathBuf> {
    collect_codex_executable_candidates_for_platform(
        path_env,
        home_dir,
        user_profile,
        appdata,
        local_appdata,
        CodexExecutablePlatform::current(),
    )
}

fn collect_codex_executable_candidates_for_platform(
    path_env: Option<OsString>,
    home_dir: Option<PathBuf>,
    user_profile: Option<PathBuf>,
    appdata: Option<PathBuf>,
    local_appdata: Option<PathBuf>,
    platform: CodexExecutablePlatform,
) -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    for root in [user_profile.as_ref(), home_dir.as_ref()]
        .into_iter()
        .flatten()
    {
        push_codex_home_candidates(&mut candidates, root, platform);
    }

    for root in [appdata.as_ref(), local_appdata.as_ref()]
        .into_iter()
        .flatten()
    {
        push_candidate_names(&mut candidates, &root.join("npm"), platform);
    }

    if let Some(path_env) = path_env {
        for directory in env::split_paths(&path_env) {
            push_candidate_names(&mut candidates, &directory, platform);
        }
    }

    for directory in default_codex_search_directories(platform) {
        push_candidate_names(&mut candidates, &directory, platform);
    }

    dedupe_paths(candidates)
}

fn push_codex_home_candidates(
    candidates: &mut Vec<PathBuf>,
    root: &Path,
    platform: CodexExecutablePlatform,
) {
    let mut directories = match platform {
        CodexExecutablePlatform::Windows => vec![
            root.join(".codex").join("bin").join("windows"),
            root.join(".codex").join("bin"),
        ],
        CodexExecutablePlatform::Unix => vec![
            root.join(".codex").join("bin").join("wsl"),
            root.join(".codex").join("bin").join("linux"),
            root.join(".codex").join("bin").join("macos"),
            root.join(".codex").join("bin"),
        ],
    };
    directories.extend([
        root.join(".local").join("bin"),
        root.join(".cargo").join("bin"),
        root.join(".npm-global").join("bin"),
        root.join(".bun").join("bin"),
    ]);

    for directory in directories {
        push_candidate_names(candidates, &directory, platform);
    }

    push_candidate_names(
        candidates,
        &root.join("AppData").join("Roaming").join("npm"),
        platform,
    );
}

fn push_candidate_names(
    candidates: &mut Vec<PathBuf>,
    directory: &Path,
    platform: CodexExecutablePlatform,
) {
    for name in codex_executable_names(platform) {
        candidates.push(directory.join(name));
    }
}

fn codex_executable_names(platform: CodexExecutablePlatform) -> &'static [&'static str] {
    match platform {
        CodexExecutablePlatform::Windows => &["codex.exe", "codex.cmd", "codex.bat"],
        CodexExecutablePlatform::Unix => &["codex"],
    }
}

fn default_codex_search_directories(platform: CodexExecutablePlatform) -> Vec<PathBuf> {
    let mut directories = Vec::new();
    match platform {
        CodexExecutablePlatform::Windows => directories.extend([
            PathBuf::from(r"C:\Program Files\OpenAI\Codex"),
            PathBuf::from(r"C:\Program Files\Codex"),
        ]),
        CodexExecutablePlatform::Unix => directories.extend([
            PathBuf::from("/usr/local/bin"),
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/usr/bin"),
            PathBuf::from("/bin"),
        ]),
    }
    directories
}

fn find_wsl_windows_user_codex_candidates(platform: CodexExecutablePlatform) -> Vec<PathBuf> {
    if platform == CodexExecutablePlatform::Windows {
        return Vec::new();
    }

    let users_root = Path::new("/mnt/c/Users");
    let Ok(entries) = std::fs::read_dir(users_root) else {
        return Vec::new();
    };

    let mut candidates = Vec::new();
    for entry in entries.flatten() {
        let root = entry.path();
        push_codex_home_candidates(&mut candidates, &root, platform);
    }
    dedupe_paths(candidates)
}

fn dedupe_paths(paths: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut deduped = Vec::new();
    for path in paths {
        if !deduped.iter().any(|candidate| candidate == &path) {
            deduped.push(path);
        }
    }
    deduped
}

fn is_supported_codex_executable(path: &Path, platform: CodexExecutablePlatform) -> bool {
    if !path.is_file() {
        return false;
    }

    match platform {
        CodexExecutablePlatform::Windows => path
            .extension()
            .and_then(|extension| extension.to_str())
            .map(|extension| {
                matches!(
                    extension.to_ascii_lowercase().as_str(),
                    "exe" | "cmd" | "bat"
                )
            })
            .unwrap_or(false),
        CodexExecutablePlatform::Unix => path
            .file_name()
            .and_then(|file_name| file_name.to_str())
            .map(|file_name| file_name == "codex")
            .unwrap_or(false),
    }
}

fn resolve_first_runnable_candidate(
    candidates: Vec<PathBuf>,
    platform: CodexExecutablePlatform,
) -> Option<PathBuf> {
    candidates
        .into_iter()
        .find(|candidate| is_supported_codex_executable(candidate, platform))
}

#[cfg(test)]
mod tests {
    use super::{
        collect_codex_executable_candidates_for_platform, default_reasoning_efforts,
        format_codex_io_error, normalize_codex_model_for_version, parse_codex_auth_status,
        parse_codex_model_catalog, parse_codex_version, parse_codex_version_numbers,
        resolve_codex_catalog_default, resolve_first_runnable_candidate, CodexExecutablePlatform,
        DEFAULT_CODEX_MODEL,
    };
    use std::ffi::OsString;
    use std::fs;
    use std::path::PathBuf;

    #[test]
    fn parses_codex_version_from_stdout() {
        assert_eq!(
            parse_codex_version("codex 0.50.0\n", ""),
            Some("codex 0.50.0".to_string())
        );
    }

    #[test]
    fn parses_codex_version_from_stderr_when_stdout_is_empty() {
        assert_eq!(
            parse_codex_version("", "codex-cli 1.2.3\n"),
            Some("codex-cli 1.2.3".to_string())
        );
    }

    #[test]
    fn returns_none_for_empty_output() {
        assert_eq!(parse_codex_version("", "\n"), None);
    }

    #[test]
    fn parses_chatgpt_login_status_as_signed_in() {
        let (auth_status, reason) = parse_codex_auth_status("Logged in using ChatGPT\n", "", true);

        assert_eq!(auth_status, "signed-in");
        assert_eq!(reason, None);
    }

    #[test]
    fn parses_api_key_login_status_as_api_key() {
        let (auth_status, reason) = parse_codex_auth_status("Logged in using API key\n", "", true);

        assert_eq!(auth_status, "api-key");
        assert_eq!(reason, None);
    }

    #[test]
    fn parses_signed_out_status_before_logged_in_substring() {
        let (auth_status, reason) = parse_codex_auth_status("Not logged in\n", "", false);

        assert_eq!(auth_status, "signed-out");
        assert_eq!(reason, Some("Not logged in".to_string()));
    }

    #[test]
    fn reports_unrecognized_successful_login_status_as_unknown() {
        let (auth_status, reason) = parse_codex_auth_status("Account state: pending\n", "", true);

        assert_eq!(auth_status, "unknown");
        assert_eq!(
            reason,
            Some("codex login status returned an unrecognized status".to_string())
        );
    }

    #[test]
    fn reports_unrecognized_failed_login_status_as_error() {
        let (auth_status, reason) = parse_codex_auth_status("", "unexpected auth failure\n", false);

        assert_eq!(auth_status, "error");
        assert_eq!(
            reason,
            Some("codex login status failed: unexpected auth failure".to_string())
        );
    }

    #[test]
    fn prefers_codex_account_binary_locations_before_path() {
        let candidates = collect_codex_executable_candidates_for_platform(
            Some(OsString::from("/tmp/path-bin")),
            Some(PathBuf::from("/home/openreelio")),
            Some(PathBuf::from("/mnt/c/Users/openreelio")),
            Some(PathBuf::from("/mnt/c/Users/openreelio/AppData/Roaming")),
            None,
            CodexExecutablePlatform::Unix,
        );

        assert_eq!(
            candidates.first(),
            Some(&PathBuf::from(
                "/mnt/c/Users/openreelio/.codex/bin/wsl/codex"
            ))
        );
        assert!(candidates.contains(&PathBuf::from(
            "/mnt/c/Users/openreelio/AppData/Roaming/npm/codex"
        )));
        assert!(candidates.contains(&PathBuf::from("/tmp/path-bin/codex")));
    }

    #[test]
    fn resolves_codex_from_user_profile_without_path() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let codex_path = temp_dir.path().join(".codex/bin/wsl/codex");
        fs::create_dir_all(codex_path.parent().expect("codex parent")).expect("codex dir");
        fs::write(&codex_path, b"").expect("codex file");

        let candidates = collect_codex_executable_candidates_for_platform(
            None,
            None,
            Some(temp_dir.path().to_path_buf()),
            None,
            None,
            CodexExecutablePlatform::Unix,
        );

        assert_eq!(
            resolve_first_runnable_candidate(candidates, CodexExecutablePlatform::Unix),
            Some(codex_path)
        );
    }

    #[test]
    fn resolves_windows_codex_cmd_instead_of_wsl_or_shell_shims() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let wsl_codex_path = temp_dir.path().join(".codex/bin/wsl/codex");
        fs::create_dir_all(wsl_codex_path.parent().expect("wsl parent")).expect("wsl dir");
        fs::write(&wsl_codex_path, b"").expect("wsl file");

        let shell_shim_path = temp_dir.path().join("AppData/Roaming/npm/codex");
        let cmd_path = temp_dir.path().join("AppData/Roaming/npm/codex.cmd");
        fs::create_dir_all(cmd_path.parent().expect("cmd parent")).expect("cmd dir");
        fs::write(&shell_shim_path, b"#!/bin/sh").expect("shell shim");
        fs::write(&cmd_path, b"@ECHO off").expect("cmd shim");

        let candidates = collect_codex_executable_candidates_for_platform(
            None,
            None,
            Some(temp_dir.path().to_path_buf()),
            None,
            None,
            CodexExecutablePlatform::Windows,
        );

        assert!(!candidates.contains(&wsl_codex_path));
        assert!(!candidates.contains(&shell_shim_path));
        assert!(candidates.contains(&cmd_path));
        assert_eq!(
            resolve_first_runnable_candidate(candidates, CodexExecutablePlatform::Windows),
            Some(cmd_path)
        );
    }

    #[test]
    fn normalizes_windows_exec_format_errors_to_english() {
        let error = std::io::Error::from_raw_os_error(193);

        let message = format_codex_io_error("Failed to run Codex command", &error);

        assert!(message.contains("not executable on this OS"));
        assert!(message.contains("codex.cmd"));
    }

    #[test]
    fn parses_visible_codex_model_catalog_entries() {
        let models = parse_codex_model_catalog(
            r#"{"models":[{"slug":"gpt-5.5","visibility":"list"},{"slug":"gpt-5.4","display_name":"gpt-5.4","default_reasoning_level":"medium","supported_reasoning_levels":[{"effort":"low"},{"effort":"high"}],"visibility":"list"},{"slug":"hidden","visibility":"hide"}]}"#,
        )
        .expect("models");

        assert_eq!(models.len(), 2);
        assert_eq!(models[0].slug, "gpt-5.5");
        assert_eq!(
            models[0].supported_reasoning_efforts,
            default_reasoning_efforts()
        );
        assert_eq!(models[1].slug, "gpt-5.4");
        assert_eq!(models[1].supported_reasoning_efforts, vec!["low", "high"]);
    }

    #[test]
    fn uses_first_catalog_model_as_default_when_latest_model_is_unavailable() {
        let models = parse_codex_model_catalog(
            r#"{"models":[{"slug":"gpt-5.4","display_name":"gpt-5.4","default_reasoning_level":"high","visibility":"list"}]}"#,
        )
        .expect("models");

        assert_eq!(
            resolve_codex_catalog_default(&models),
            ("gpt-5.4".to_string(), "high".to_string())
        );
    }

    #[test]
    fn parses_codex_cli_semver_from_version_labels() {
        assert_eq!(
            parse_codex_version_numbers("codex-cli 0.130.0-alpha.5"),
            Some((0, 130, 0))
        );
        assert_eq!(parse_codex_version_numbers("codex 1.2.3"), Some((1, 2, 3)));
    }

    #[test]
    fn keeps_latest_codex_model_for_newer_cli_versions() {
        assert_eq!(
            normalize_codex_model_for_version(
                DEFAULT_CODEX_MODEL.to_string(),
                Some("codex-cli 0.130.0-alpha.5"),
            ),
            DEFAULT_CODEX_MODEL
        );
    }

    #[test]
    fn downgrades_latest_codex_model_for_older_cli_versions() {
        assert_eq!(
            normalize_codex_model_for_version(
                DEFAULT_CODEX_MODEL.to_string(),
                Some("codex-cli 0.118.0"),
            ),
            "gpt-5.4"
        );
    }
}
