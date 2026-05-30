//! Codex runtime detection helpers.

use serde::{Deserialize, Serialize};
use specta::Type;
use std::env;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tokio::process::Command;
use tokio::time::{timeout, Duration};

pub const CODEX_CLI_ENV_VAR: &str = "OPENREELIO_CODEX_CLI";
pub const OPENREELIO_CODEX_HOME_ENV_VAR: &str = "OPENREELIO_CODEX_HOME";
pub const CODEX_HOME_ENV_VAR: &str = "CODEX_HOME";
pub const DEFAULT_CODEX_MODEL: &str = "gpt-5.5";
pub const DEFAULT_CODEX_REASONING_EFFORT: &str = "medium";

static VERIFIED_CODEX_COMMAND_SPEC: Mutex<Option<CodexCommandSpec>> = Mutex::new(None);

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

#[derive(Clone, Debug, PartialEq, Eq)]
struct CodexCommandSpec {
    executable: PathBuf,
    prefix_args: Vec<String>,
    label: String,
    mode: CodexCommandMode,
    source: CodexCommandSource,
    codex_home: PathBuf,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CodexCommandSource {
    Managed,
    System,
}

impl CodexCommandSource {
    fn as_str(self) -> &'static str {
        match self {
            Self::Managed => "managed",
            Self::System => "system",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CodexCommandMode {
    Native,
    Wsl,
}

impl CodexCommandMode {
    pub(crate) fn supports_host_path_extension(self) -> bool {
        matches!(self, Self::Native)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CodexStatusProbeResult {
    pub installed: bool,
    pub version: Option<String>,
    pub auth_status: String,
    pub reason: Option<String>,
    pub runtime_source: Option<String>,
    pub codex_home: Option<String>,
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
    collect_codex_command_specs()
        .into_iter()
        .next()
        .map(|spec| spec.executable)
}

pub fn create_codex_command() -> Result<Command, String> {
    let spec = resolve_codex_command_spec().ok_or_else(|| {
        "Codex executable was not found in PATH or common install locations.".to_string()
    })?;
    create_codex_command_from_spec(&spec)
}

pub fn codex_command_label() -> String {
    resolve_codex_command_spec()
        .map(|spec| spec.label)
        .unwrap_or_else(|| "codex".to_string())
}

pub fn codex_shell_command_prefix() -> String {
    resolve_codex_command_spec()
        .map(|spec| codex_shell_command_prefix_from_spec(&spec))
        .unwrap_or_else(|| {
            format!(
                "{}={} codex",
                CODEX_HOME_ENV_VAR,
                quote_shell_arg(&managed_codex_home_dir().display().to_string())
            )
        })
}

pub fn managed_codex_home_dir() -> PathBuf {
    if let Some(path) = env::var_os(OPENREELIO_CODEX_HOME_ENV_VAR).map(PathBuf::from) {
        return path;
    }

    app_data_root()
        .join("OpenReelio")
        .join("codex")
        .join("home")
}

pub fn managed_codex_runtime_dir() -> PathBuf {
    managed_codex_home_dir()
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| app_data_root().join("OpenReelio").join("codex"))
        .join("runtime")
}

fn app_data_root() -> PathBuf {
    dirs::data_dir()
        .or_else(dirs::home_dir)
        .unwrap_or_else(|| env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
}

#[cfg(all(not(test), feature = "gui"))]
pub(crate) fn codex_command_mode() -> Option<CodexCommandMode> {
    resolve_codex_command_spec().map(|spec| spec.mode)
}

fn resolve_codex_command_spec() -> Option<CodexCommandSpec> {
    let specs = collect_codex_command_specs();
    if let Ok(guard) = VERIFIED_CODEX_COMMAND_SPEC.lock() {
        if let Some(spec) = guard.as_ref() {
            if let Some(selected) = select_codex_command_spec(Some(spec), &specs) {
                if &selected == spec {
                    return Some(selected);
                }
            }
        }
    }

    if let Ok(mut guard) = VERIFIED_CODEX_COMMAND_SPEC.lock() {
        if guard.as_ref().is_some_and(|spec| {
            select_codex_command_spec(Some(spec), &specs)
                .as_ref()
                .is_some_and(|selected| selected != spec)
        }) {
            *guard = None;
        }
    }

    select_codex_command_spec(None, &specs)
}

fn select_codex_command_spec(
    cached: Option<&CodexCommandSpec>,
    specs: &[CodexCommandSpec],
) -> Option<CodexCommandSpec> {
    let first = specs.first()?;
    if let Some(cached) = cached {
        let cached_still_available = specs.iter().any(|spec| spec == cached);
        let managed_now_available = cached.source != CodexCommandSource::Managed
            && first.source == CodexCommandSource::Managed;
        if cached_still_available && !managed_now_available {
            return Some(cached.clone());
        }
    }

    Some(first.clone())
}

fn remember_verified_codex_command_spec(spec: &CodexCommandSpec) {
    if let Ok(mut guard) = VERIFIED_CODEX_COMMAND_SPEC.lock() {
        *guard = Some(spec.clone());
    }
}

fn collect_codex_command_specs() -> Vec<CodexCommandSpec> {
    let codex_home = managed_codex_home_dir();
    let mut specs = collect_managed_codex_executables()
        .into_iter()
        .map(|executable| CodexCommandSpec {
            label: executable.display().to_string(),
            executable,
            prefix_args: Vec::new(),
            mode: CodexCommandMode::Native,
            source: CodexCommandSource::Managed,
            codex_home: codex_home.clone(),
        })
        .collect::<Vec<_>>();

    specs.extend(
        collect_system_codex_executables()
            .into_iter()
            .map(|executable| CodexCommandSpec {
                label: executable.display().to_string(),
                executable,
                prefix_args: Vec::new(),
                mode: CodexCommandMode::Native,
                source: CodexCommandSource::System,
                codex_home: codex_home.clone(),
            }),
    );

    if let Some(spec) = resolve_wsl_codex_command_spec() {
        specs.push(spec);
    }

    dedupe_codex_command_specs(specs)
}

fn collect_managed_codex_executables() -> Vec<PathBuf> {
    let platform = CodexExecutablePlatform::current();
    let mut candidates = Vec::new();
    for directory in managed_codex_executable_directories() {
        push_candidate_names(&mut candidates, &directory, platform);
    }
    resolve_runnable_candidates(candidates, platform)
}

fn managed_codex_executable_directories() -> Vec<PathBuf> {
    let runtime_dir = managed_codex_runtime_dir();
    let mut directories = vec![
        runtime_dir.join("node_modules").join(".bin"),
        runtime_dir.join("bin"),
    ];

    if let Ok(exe_path) = env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            directories.push(exe_dir.join("binaries"));
            directories.push(exe_dir.join("resources").join("binaries"));
            if let Some(contents_dir) = exe_dir.parent() {
                directories.push(contents_dir.join("Resources").join("binaries"));
            }
        }
    }

    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    directories.push(manifest_dir.join("binaries"));
    dedupe_paths(directories)
}

fn collect_system_codex_executables() -> Vec<PathBuf> {
    let platform = CodexExecutablePlatform::current();
    let mut candidates = Vec::new();

    if let Some(path) = env::var_os(CODEX_CLI_ENV_VAR).map(PathBuf::from) {
        candidates.push(path);
    }

    let home_dir = dirs::home_dir();
    let user_profile = env::var_os("USERPROFILE").map(PathBuf::from);
    let appdata = env::var_os("APPDATA").map(PathBuf::from);
    let local_appdata = env::var_os("LOCALAPPDATA").map(PathBuf::from);
    candidates.extend(collect_codex_executable_candidates(
        env::var_os("PATH"),
        home_dir,
        user_profile,
        appdata,
        local_appdata,
    ));

    candidates.extend(find_wsl_windows_user_codex_candidates(platform));
    resolve_runnable_candidates(candidates, platform)
}

fn dedupe_codex_command_specs(specs: Vec<CodexCommandSpec>) -> Vec<CodexCommandSpec> {
    let mut deduped = Vec::new();
    for spec in specs {
        if !deduped.iter().any(|candidate: &CodexCommandSpec| {
            candidate.executable == spec.executable
                && candidate.prefix_args == spec.prefix_args
                && candidate.codex_home == spec.codex_home
        }) {
            deduped.push(spec);
        }
    }
    deduped
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
    let managed_codex_home = managed_codex_home_dir();
    let specs = collect_codex_command_specs();
    if specs.is_empty() {
        return CodexStatusProbeResult {
            installed: false,
            version: None,
            auth_status: "unknown".to_string(),
            reason: Some(
                "Codex executable was not found in PATH or common install locations.".to_string(),
            ),
            runtime_source: None,
            codex_home: Some(managed_codex_home.display().to_string()),
        };
    }

    let mut last_failure = None;
    for spec in specs {
        let mut version_command = match create_codex_command_from_spec(&spec) {
            Ok(command) => command,
            Err(reason) => {
                last_failure = Some(reason);
                continue;
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
                last_failure = Some(format!("{} --version timed out", spec.label));
                continue;
            }
        };

        match version_output {
            Ok(output) if output.status.success() => {
                remember_verified_codex_command_spec(&spec);
                let stdout = String::from_utf8_lossy(&output.stdout);
                let stderr = String::from_utf8_lossy(&output.stderr);
                let version = parse_codex_version(&stdout, &stderr);
                let mut auth_command = match create_codex_command_from_spec(&spec) {
                    Ok(command) => command,
                    Err(reason) => {
                        return CodexStatusProbeResult {
                            installed: true,
                            version,
                            auth_status: "error".to_string(),
                            reason: Some(reason),
                            runtime_source: Some(spec.source.as_str().to_string()),
                            codex_home: Some(spec.codex_home.display().to_string()),
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
                            reason: Some("codex login status timed out".to_string()),
                            runtime_source: Some(spec.source.as_str().to_string()),
                            codex_home: Some(spec.codex_home.display().to_string()),
                        };
                    }
                };

                return match auth_output {
                    Ok(output) => {
                        let stdout = String::from_utf8_lossy(&output.stdout);
                        let stderr = String::from_utf8_lossy(&output.stderr);
                        let (auth_status, auth_reason) =
                            parse_codex_auth_status(&stdout, &stderr, output.status.success());
                        CodexStatusProbeResult {
                            installed: true,
                            version,
                            auth_status,
                            reason: auth_reason,
                            runtime_source: Some(spec.source.as_str().to_string()),
                            codex_home: Some(spec.codex_home.display().to_string()),
                        }
                    }
                    Err(error) => CodexStatusProbeResult {
                        installed: true,
                        version,
                        auth_status: "error".to_string(),
                        reason: Some(format_codex_io_error(
                            "Failed to run codex login status",
                            &error,
                        )),
                        runtime_source: Some(spec.source.as_str().to_string()),
                        codex_home: Some(spec.codex_home.display().to_string()),
                    },
                };
            }
            Ok(output) => {
                last_failure = Some(format!(
                    "{} --version failed with status {}",
                    spec.label, output.status
                ));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                last_failure = Some(format!("{} was not found while probing Codex.", spec.label));
            }
            Err(error) => {
                last_failure = Some(format_codex_io_error(
                    "Failed to run codex --version",
                    &error,
                ));
            }
        }
    }

    CodexStatusProbeResult {
        installed: false,
        version: None,
        auth_status: "unknown".to_string(),
        reason: Some(last_failure.unwrap_or_else(|| {
            "Codex executable was not found in PATH or common install locations.".to_string()
        })),
        runtime_source: None,
        codex_home: Some(managed_codex_home.display().to_string()),
    }
}

fn create_codex_command_from_spec(spec: &CodexCommandSpec) -> Result<Command, String> {
    ensure_private_codex_home_dir(&spec.codex_home)?;
    let mut command = Command::new(&spec.executable);
    command.args(&spec.prefix_args);
    command.env(CODEX_HOME_ENV_VAR, codex_home_env_value(spec));
    crate::core::process::configure_tokio_command(&mut command);
    command.kill_on_drop(true);
    Ok(command)
}

fn ensure_private_codex_home_dir(path: &Path) -> Result<(), String> {
    std::fs::create_dir_all(path)
        .map_err(|error| format!("Failed to create OpenReelio Codex home: {error}"))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("Failed to secure OpenReelio Codex home: {error}"))?;
    }

    Ok(())
}

fn codex_shell_command_prefix_from_spec(spec: &CodexCommandSpec) -> String {
    let codex_home = codex_home_env_value(spec).to_string_lossy().into_owned();

    if spec.mode == CodexCommandMode::Wsl
        && spec.prefix_args.first().map(String::as_str) == Some("-e")
    {
        let mut words = vec![
            spec.executable.display().to_string(),
            "-e".to_string(),
            "env".to_string(),
            format!("{CODEX_HOME_ENV_VAR}={codex_home}"),
        ];
        words.extend(spec.prefix_args.iter().skip(1).cloned());
        return shell_join(words);
    }

    let command = shell_join(
        std::iter::once(spec.executable.display().to_string())
            .chain(spec.prefix_args.iter().cloned())
            .collect::<Vec<_>>(),
    );
    format!(
        "{}={} {}",
        CODEX_HOME_ENV_VAR,
        quote_shell_arg(&codex_home),
        command
    )
}

fn shell_join(words: Vec<String>) -> String {
    words
        .iter()
        .map(|word| quote_shell_arg(word))
        .collect::<Vec<_>>()
        .join(" ")
}

fn quote_shell_arg(value: &str) -> String {
    if value
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '.' | '/' | ':' | '='))
    {
        return value.to_string();
    }

    format!("'{}'", value.replace('\'', "'\\''"))
}

fn codex_home_env_value(spec: &CodexCommandSpec) -> OsString {
    if spec.mode == CodexCommandMode::Wsl {
        if let Some(path) = windows_path_to_wsl_mount_path(&spec.codex_home) {
            return OsString::from(path);
        }
    }

    spec.codex_home.as_os_str().to_os_string()
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
        push_candidate_names(&mut candidates, &root.join("pnpm"), platform);
    }

    if let Some(root) = local_appdata.as_ref() {
        let codex_bin = root.join("OpenAI").join("Codex").join("bin");
        for directory in collect_codex_versioned_subdirs(&codex_bin, platform) {
            push_candidate_names(&mut candidates, &directory, platform);
        }
        push_candidate_names(&mut candidates, &codex_bin, platform);
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
    let codex_bin = root.join(".codex").join("bin");
    let mut directories = match platform {
        CodexExecutablePlatform::Windows => {
            let windows_bin = codex_bin.join("windows");
            let mut directories = collect_codex_versioned_subdirs(&windows_bin, platform);
            directories.extend([windows_bin, codex_bin.clone()]);
            directories
        }
        CodexExecutablePlatform::Unix => {
            let wsl_bin = codex_bin.join("wsl");
            let linux_bin = codex_bin.join("linux");
            let macos_bin = codex_bin.join("macos");
            let mut directories = collect_codex_versioned_subdirs(&wsl_bin, platform);
            directories.extend(collect_codex_versioned_subdirs(&linux_bin, platform));
            directories.extend(collect_codex_versioned_subdirs(&macos_bin, platform));
            directories.extend([wsl_bin, linux_bin, macos_bin, codex_bin.clone()]);
            directories
        }
    };
    directories.extend([
        root.join(".local").join("bin"),
        root.join(".cargo").join("bin"),
        root.join(".npm-global").join("bin"),
        root.join(".volta").join("bin"),
        root.join(".asdf").join("shims"),
        root.join(".mise").join("shims"),
        root.join(".nodenv").join("shims"),
        root.join(".bun").join("bin"),
        root.join(".local").join("share").join("pnpm"),
        root.join("Library").join("pnpm"),
    ]);
    directories.extend(collect_node_version_bin_dirs(
        &root.join(".nvm").join("versions").join("node"),
        platform,
    ));
    directories.extend(collect_node_version_bin_dirs(
        &root.join(".fnm").join("node-versions"),
        platform,
    ));
    directories.extend(collect_node_version_bin_dirs(
        &root
            .join(".local")
            .join("share")
            .join("fnm")
            .join("node-versions"),
        platform,
    ));

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

fn collect_codex_versioned_subdirs(
    directory: &Path,
    platform: CodexExecutablePlatform,
) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(directory) else {
        return Vec::new();
    };

    let mut dirs = entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            let name = path.file_name()?.to_str()?;
            if path.is_dir()
                && name.len() >= 8
                && name.chars().all(|ch| ch.is_ascii_hexdigit())
                && codex_executable_names(platform)
                    .iter()
                    .any(|executable_name| path.join(executable_name).is_file())
            {
                Some(path)
            } else {
                None
            }
        })
        .collect::<Vec<_>>();
    dirs.sort_by_key(|path| {
        codex_executable_names(platform)
            .iter()
            .filter_map(|executable_name| {
                std::fs::metadata(path.join(executable_name))
                    .and_then(|metadata| metadata.modified())
                    .ok()
            })
            .max()
    });
    dirs.reverse();
    dirs
}

fn collect_node_version_bin_dirs(
    directory: &Path,
    platform: CodexExecutablePlatform,
) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(directory) else {
        return Vec::new();
    };

    let mut dirs = entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            if !path.is_dir() {
                return None;
            }

            [path.join("bin"), path.join("installation").join("bin")]
                .into_iter()
                .find(|candidate| directory_has_codex_executable(candidate, platform))
        })
        .collect::<Vec<_>>();
    dirs.sort_by_key(|path| latest_codex_executable_modified_at(path, platform));
    dirs.reverse();
    dirs
}

fn directory_has_codex_executable(directory: &Path, platform: CodexExecutablePlatform) -> bool {
    codex_executable_names(platform)
        .iter()
        .any(|executable_name| directory.join(executable_name).is_file())
}

fn latest_codex_executable_modified_at(
    directory: &Path,
    platform: CodexExecutablePlatform,
) -> Option<std::time::SystemTime> {
    codex_executable_names(platform)
        .iter()
        .filter_map(|executable_name| {
            std::fs::metadata(directory.join(executable_name))
                .and_then(|metadata| metadata.modified())
                .ok()
        })
        .max()
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
            dirs::data_local_dir()
                .unwrap_or_else(|| PathBuf::from(r"C:\Users\Default\AppData\Local"))
                .join("OpenAI")
                .join("Codex")
                .join("bin"),
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

fn resolve_wsl_codex_command_spec() -> Option<CodexCommandSpec> {
    if !cfg!(windows) {
        return None;
    }

    let wsl_codex = resolve_first_runnable_candidate(
        collect_wsl_codex_candidates_from_windows_roots(
            dirs::home_dir(),
            env::var_os("USERPROFILE").map(PathBuf::from),
        ),
        CodexExecutablePlatform::Unix,
    )?;
    let wsl_codex_path = windows_path_to_wsl_mount_path(&wsl_codex)?;
    Some(CodexCommandSpec {
        executable: PathBuf::from("wsl.exe"),
        prefix_args: vec!["-e".to_string(), wsl_codex_path.clone()],
        label: format!("wsl.exe -e {wsl_codex_path}"),
        mode: CodexCommandMode::Wsl,
        source: CodexCommandSource::System,
        codex_home: managed_codex_home_dir(),
    })
}

fn collect_wsl_codex_candidates_from_windows_roots(
    home_dir: Option<PathBuf>,
    user_profile: Option<PathBuf>,
) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    for root in [user_profile.as_ref(), home_dir.as_ref()]
        .into_iter()
        .flatten()
    {
        let wsl_bin = root.join(".codex").join("bin").join("wsl");
        let mut directories =
            collect_codex_versioned_subdirs(&wsl_bin, CodexExecutablePlatform::Unix);
        directories.push(wsl_bin);
        for directory in directories {
            push_candidate_names(&mut candidates, &directory, CodexExecutablePlatform::Unix);
        }
    }
    dedupe_paths(candidates)
}

pub(crate) fn windows_path_to_wsl_mount_path(path: &Path) -> Option<String> {
    let normalized = path.display().to_string().replace('\\', "/");
    let mut chars = normalized.chars();
    let drive = chars.next()?;
    if !drive.is_ascii_alphabetic() || chars.next()? != ':' {
        return None;
    }

    let rest = chars.as_str().trim_start_matches('/');
    if rest.is_empty() {
        return Some(format!("/mnt/{}", drive.to_ascii_lowercase()));
    }

    Some(format!("/mnt/{}/{}", drive.to_ascii_lowercase(), rest))
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
    resolve_runnable_candidates(candidates, platform)
        .into_iter()
        .next()
}

fn resolve_runnable_candidates(
    candidates: Vec<PathBuf>,
    platform: CodexExecutablePlatform,
) -> Vec<PathBuf> {
    candidates
        .into_iter()
        .filter(|candidate| is_supported_codex_executable(candidate, platform))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{
        codex_shell_command_prefix_from_spec, collect_codex_executable_candidates_for_platform,
        collect_wsl_codex_candidates_from_windows_roots, default_reasoning_efforts,
        ensure_private_codex_home_dir, format_codex_io_error, normalize_codex_model_for_version,
        parse_codex_auth_status, parse_codex_model_catalog, parse_codex_version,
        parse_codex_version_numbers, resolve_codex_catalog_default,
        resolve_first_runnable_candidate, select_codex_command_spec,
        windows_path_to_wsl_mount_path, CodexCommandMode, CodexCommandSource, CodexCommandSpec,
        CodexExecutablePlatform, DEFAULT_CODEX_MODEL,
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
    fn resolves_path_only_codex_install() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let path_bin = temp_dir.path().join("bin");
        let codex_path = path_bin.join("codex");
        fs::create_dir_all(&path_bin).expect("path bin");
        fs::write(&codex_path, b"").expect("codex file");

        let candidates = collect_codex_executable_candidates_for_platform(
            Some(OsString::from(path_bin.as_os_str())),
            None,
            None,
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
    fn resolves_codex_from_common_user_package_manager_shims() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let volta_path = temp_dir.path().join(".volta/bin/codex");
        fs::create_dir_all(volta_path.parent().expect("volta parent")).expect("volta dir");
        fs::write(&volta_path, b"volta").expect("volta codex");

        let candidates = collect_codex_executable_candidates_for_platform(
            None,
            Some(temp_dir.path().to_path_buf()),
            None,
            None,
            None,
            CodexExecutablePlatform::Unix,
        );

        assert!(candidates.contains(&volta_path));
        assert_eq!(
            resolve_first_runnable_candidate(candidates, CodexExecutablePlatform::Unix),
            Some(volta_path)
        );
    }

    #[test]
    fn resolves_codex_from_nvm_node_version_bin() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let stale_path = temp_dir.path().join(".nvm/versions/node/v20.0.0/bin/codex");
        let latest_path = temp_dir.path().join(".nvm/versions/node/v22.0.0/bin/codex");
        fs::create_dir_all(stale_path.parent().expect("stale parent")).expect("stale dir");
        fs::create_dir_all(latest_path.parent().expect("latest parent")).expect("latest dir");
        fs::write(&stale_path, b"old").expect("stale codex");
        fs::write(&latest_path, b"new").expect("latest codex");

        let candidates = collect_codex_executable_candidates_for_platform(
            None,
            Some(temp_dir.path().to_path_buf()),
            None,
            None,
            None,
            CodexExecutablePlatform::Unix,
        );

        assert!(candidates.contains(&stale_path));
        assert!(candidates.contains(&latest_path));
        assert_eq!(
            resolve_first_runnable_candidate(candidates, CodexExecutablePlatform::Unix),
            Some(latest_path)
        );
    }

    #[test]
    fn resolves_codex_from_windows_pnpm_appdata() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let codex_path = temp_dir.path().join("pnpm/codex.cmd");
        fs::create_dir_all(codex_path.parent().expect("pnpm parent")).expect("pnpm dir");
        fs::write(&codex_path, b"@ECHO off").expect("pnpm codex");

        let candidates = collect_codex_executable_candidates_for_platform(
            None,
            None,
            None,
            Some(temp_dir.path().to_path_buf()),
            None,
            CodexExecutablePlatform::Windows,
        );

        assert_eq!(
            resolve_first_runnable_candidate(candidates, CodexExecutablePlatform::Windows),
            Some(codex_path)
        );
    }

    #[test]
    fn prefers_versioned_wsl_codex_over_stale_flat_launcher() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let stale_path = temp_dir.path().join(".codex/bin/wsl/codex");
        let versioned_path = temp_dir.path().join(".codex/bin/wsl/a1b2c3d4e5f6/codex");
        fs::create_dir_all(stale_path.parent().expect("stale parent")).expect("stale dir");
        fs::create_dir_all(versioned_path.parent().expect("versioned parent"))
            .expect("versioned dir");
        fs::write(&stale_path, b"old").expect("stale codex");
        fs::write(&versioned_path, b"new").expect("versioned codex");

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
            Some(versioned_path)
        );
    }

    #[test]
    fn resolves_versioned_windows_codex_install() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let stale_path = temp_dir.path().join(".codex/bin/windows/codex.exe");
        let versioned_path = temp_dir
            .path()
            .join(".codex/bin/windows/a1b2c3d4e5f6/codex.exe");
        fs::create_dir_all(stale_path.parent().expect("stale parent")).expect("stale dir");
        fs::create_dir_all(versioned_path.parent().expect("versioned parent"))
            .expect("versioned dir");
        fs::write(&stale_path, b"old").expect("stale codex");
        fs::write(&versioned_path, b"new").expect("versioned codex");

        let candidates = collect_codex_executable_candidates_for_platform(
            None,
            None,
            Some(temp_dir.path().to_path_buf()),
            None,
            None,
            CodexExecutablePlatform::Windows,
        );

        assert_eq!(
            resolve_first_runnable_candidate(candidates, CodexExecutablePlatform::Windows),
            Some(versioned_path)
        );
    }

    #[test]
    fn resolves_versioned_local_appdata_codex_install() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let codex_path = temp_dir
            .path()
            .join("OpenAI/Codex/bin/deadbeef1234/codex.exe");
        fs::create_dir_all(codex_path.parent().expect("codex parent")).expect("codex dir");
        fs::write(&codex_path, b"native").expect("native codex");

        let candidates = collect_codex_executable_candidates_for_platform(
            None,
            None,
            None,
            None,
            Some(temp_dir.path().to_path_buf()),
            CodexExecutablePlatform::Windows,
        );

        assert!(candidates.contains(&codex_path));
        assert_eq!(
            resolve_first_runnable_candidate(candidates, CodexExecutablePlatform::Windows),
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
    fn collects_wsl_codex_fallback_candidates_for_windows_hosts() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let stale_path = temp_dir.path().join(".codex/bin/wsl/codex");
        let versioned_path = temp_dir.path().join(".codex/bin/wsl/a1b2c3d4e5f6/codex");
        fs::create_dir_all(stale_path.parent().expect("stale parent")).expect("stale dir");
        fs::create_dir_all(versioned_path.parent().expect("versioned parent"))
            .expect("versioned dir");
        fs::write(&stale_path, b"old").expect("stale codex");
        fs::write(&versioned_path, b"new").expect("versioned codex");

        let candidates =
            collect_wsl_codex_candidates_from_windows_roots(None, Some(temp_dir.path().into()));

        assert_eq!(candidates.first(), Some(&versioned_path));
        assert!(candidates.contains(&stale_path));
    }

    #[test]
    fn converts_windows_codex_path_to_wsl_mount_path() {
        let path = PathBuf::from(r"C:\Users\openreelio\.codex\bin\wsl\a1b2c3d4\codex");

        assert_eq!(
            windows_path_to_wsl_mount_path(&path),
            Some("/mnt/c/Users/openreelio/.codex/bin/wsl/a1b2c3d4/codex".to_string())
        );
    }

    #[test]
    fn labels_wsl_codex_command_specs_as_wsl_mode() {
        let spec = CodexCommandSpec {
            executable: PathBuf::from("wsl.exe"),
            prefix_args: vec![
                "-e".to_string(),
                "/mnt/c/Users/openreelio/.codex/bin/wsl/codex".to_string(),
            ],
            label: "wsl.exe -e /mnt/c/Users/openreelio/.codex/bin/wsl/codex".to_string(),
            mode: CodexCommandMode::Wsl,
            source: CodexCommandSource::System,
            codex_home: PathBuf::from(r"C:\Users\openreelio\AppData\Roaming\OpenReelio\codex\home"),
        };

        assert_eq!(spec.mode, CodexCommandMode::Wsl);
    }

    #[test]
    fn builds_managed_codex_shell_command_for_native_mode() {
        let spec = CodexCommandSpec {
            executable: PathBuf::from("/home/openreelio/.nvm/bin/codex"),
            prefix_args: Vec::new(),
            label: "/home/openreelio/.nvm/bin/codex".to_string(),
            mode: CodexCommandMode::Native,
            source: CodexCommandSource::System,
            codex_home: PathBuf::from("/tmp/OpenReelio Codex/home"),
        };

        assert_eq!(
            codex_shell_command_prefix_from_spec(&spec),
            "CODEX_HOME='/tmp/OpenReelio Codex/home' /home/openreelio/.nvm/bin/codex"
        );
    }

    #[test]
    fn builds_managed_codex_shell_command_for_wsl_mode() {
        let spec = CodexCommandSpec {
            executable: PathBuf::from("wsl.exe"),
            prefix_args: vec![
                "-e".to_string(),
                "/mnt/c/Users/openreelio/.codex/bin/wsl/codex".to_string(),
            ],
            label: "wsl.exe -e /mnt/c/Users/openreelio/.codex/bin/wsl/codex".to_string(),
            mode: CodexCommandMode::Wsl,
            source: CodexCommandSource::System,
            codex_home: PathBuf::from(r"C:\Users\openreelio\AppData\Roaming\OpenReelio\codex\home"),
        };

        assert_eq!(
            codex_shell_command_prefix_from_spec(&spec),
            "wsl.exe -e env CODEX_HOME=/mnt/c/Users/openreelio/AppData/Roaming/OpenReelio/codex/home /mnt/c/Users/openreelio/.codex/bin/wsl/codex"
        );
    }

    #[cfg(unix)]
    #[test]
    fn creates_managed_codex_home_with_private_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let temp_dir = tempfile::tempdir().expect("temp dir");
        let codex_home = temp_dir.path().join("codex/home");

        ensure_private_codex_home_dir(&codex_home).expect("secure codex home");

        let mode = fs::metadata(&codex_home)
            .expect("codex home metadata")
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o700);
    }

    #[test]
    fn only_native_codex_commands_support_host_path_extension() {
        assert!(CodexCommandMode::Native.supports_host_path_extension());
        assert!(!CodexCommandMode::Wsl.supports_host_path_extension());
    }

    #[test]
    fn selects_available_cached_codex_command_spec() {
        let cached = CodexCommandSpec {
            executable: PathBuf::from("/usr/local/bin/codex"),
            prefix_args: Vec::new(),
            label: "/usr/local/bin/codex".to_string(),
            mode: CodexCommandMode::Native,
            source: CodexCommandSource::System,
            codex_home: PathBuf::from("/tmp/openreelio/codex/home"),
        };
        let earlier_stale_candidate = CodexCommandSpec {
            executable: PathBuf::from("/tmp/stale/codex"),
            prefix_args: Vec::new(),
            label: "/tmp/stale/codex".to_string(),
            mode: CodexCommandMode::Native,
            source: CodexCommandSource::System,
            codex_home: cached.codex_home.clone(),
        };

        assert_eq!(
            select_codex_command_spec(Some(&cached), &[earlier_stale_candidate, cached.clone()]),
            Some(cached)
        );
    }

    #[test]
    fn drops_unavailable_cached_codex_command_spec() {
        let cached = CodexCommandSpec {
            executable: PathBuf::from("/tmp/removed/codex"),
            prefix_args: Vec::new(),
            label: "/tmp/removed/codex".to_string(),
            mode: CodexCommandMode::Native,
            source: CodexCommandSource::System,
            codex_home: PathBuf::from("/tmp/openreelio/codex/home"),
        };
        let current = CodexCommandSpec {
            executable: PathBuf::from("/usr/local/bin/codex"),
            prefix_args: Vec::new(),
            label: "/usr/local/bin/codex".to_string(),
            mode: CodexCommandMode::Native,
            source: CodexCommandSource::System,
            codex_home: cached.codex_home.clone(),
        };

        assert_eq!(
            select_codex_command_spec(Some(&cached), &[current.clone()]),
            Some(current)
        );
    }

    #[test]
    fn prefers_new_managed_codex_command_over_cached_system_fallback() {
        let cached_system = CodexCommandSpec {
            executable: PathBuf::from("/usr/local/bin/codex"),
            prefix_args: Vec::new(),
            label: "/usr/local/bin/codex".to_string(),
            mode: CodexCommandMode::Native,
            source: CodexCommandSource::System,
            codex_home: PathBuf::from("/tmp/openreelio/codex/home"),
        };
        let managed = CodexCommandSpec {
            executable: PathBuf::from("/tmp/openreelio/codex/runtime/node_modules/.bin/codex"),
            prefix_args: Vec::new(),
            label: "/tmp/openreelio/codex/runtime/node_modules/.bin/codex".to_string(),
            mode: CodexCommandMode::Native,
            source: CodexCommandSource::Managed,
            codex_home: cached_system.codex_home.clone(),
        };

        assert_eq!(
            select_codex_command_spec(
                Some(&cached_system),
                &[managed.clone(), cached_system.clone()]
            ),
            Some(managed)
        );
    }

    #[test]
    fn includes_native_windows_codex_install_location() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let codex_path = temp_dir.path().join("OpenAI/Codex/bin/codex.exe");
        fs::create_dir_all(codex_path.parent().expect("codex parent")).expect("codex dir");
        fs::write(&codex_path, b"native").expect("native codex");

        let candidates = collect_codex_executable_candidates_for_platform(
            None,
            None,
            None,
            None,
            Some(temp_dir.path().to_path_buf()),
            CodexExecutablePlatform::Windows,
        );

        assert!(candidates.contains(&codex_path));
        assert_eq!(
            resolve_first_runnable_candidate(candidates, CodexExecutablePlatform::Windows),
            Some(codex_path)
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
