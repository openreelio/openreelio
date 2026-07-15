//! Claude Code runtime detection helpers.
//!
//! Mirrors [`crate::core::codex`] for the Anthropic `claude` CLI. OpenReelio runs
//! `claude` against an isolated, app-managed configuration directory
//! (`CLAUDE_CONFIG_DIR`) so that credentials, settings, and session state never
//! leak into (or from) the user's global `~/.claude` profile.

use serde::Serialize;
use specta::Type;
use std::env;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use tokio::process::Command;
use tokio::time::{timeout, Duration};

/// Environment variable that pins the Claude CLI executable path.
pub const CLAUDE_CLI_ENV_VAR: &str = "OPENREELIO_CLAUDE_CLI";
/// Environment variable that overrides the managed Claude config directory.
pub const OPENREELIO_CLAUDE_HOME_ENV_VAR: &str = "OPENREELIO_CLAUDE_HOME";
/// The Claude CLI configuration-directory relocation variable.
pub const CLAUDE_CONFIG_DIR_ENV_VAR: &str = "CLAUDE_CONFIG_DIR";
/// The Anthropic API-key variable understood by the Claude CLI.
pub const ANTHROPIC_API_KEY_ENV_VAR: &str = "ANTHROPIC_API_KEY";
/// The OAuth-token variable understood by the Claude CLI (from `setup-token`).
pub const CLAUDE_CODE_OAUTH_TOKEN_ENV_VAR: &str = "CLAUDE_CODE_OAUTH_TOKEN";
/// Default Claude model alias used by OpenReelio headless sessions.
pub const DEFAULT_CLAUDE_MODEL: &str = "sonnet";
/// Default Claude reasoning effort used by OpenReelio headless sessions.
pub const DEFAULT_CLAUDE_EFFORT: &str = "medium";

/// Pinned Claude Code version, downloaded on demand as an official native binary.
///
/// Claude Code is proprietary and never bundled; the app fetches this exact
/// version from the official release channel and owns updates (disabling the
/// CLI's own updater via [`CLAUDE_DISABLE_UPDATES_ENV_VAR`]).
pub const CLAUDE_PINNED_VERSION: &str = "2.1.202";

/// Environment variable that disables the Claude CLI's built-in self-update.
pub const CLAUDE_DISABLE_UPDATES_ENV_VAR: &str = "DISABLE_UPDATES";

/// When `true`, discovery also considers system PATH / platform / WSL launchers.
#[cfg(feature = "gui")]
static CLAUDE_PREFER_SYSTEM: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

/// Records whether the user opted into system Claude launcher discovery.
#[cfg(feature = "gui")]
pub fn set_claude_prefer_system(prefer_system: bool) {
    let previous = CLAUDE_PREFER_SYSTEM.swap(prefer_system, std::sync::atomic::Ordering::Relaxed);
    // The toggle changes both which launchers are discovered and their priority,
    // so the cached probe (spec + version) must not survive the flip.
    if previous != prefer_system {
        invalidate_claude_probe_cache();
    }
}

/// Whether discovery should include system PATH / platform / WSL launchers.
///
/// Non-GUI builds (the CLI) always include system discovery; the GUI gates it on
/// the user's `claudePreferSystem` setting.
fn claude_include_system_discovery() -> bool {
    #[cfg(feature = "gui")]
    {
        CLAUDE_PREFER_SYSTEM.load(std::sync::atomic::Ordering::Relaxed)
    }
    #[cfg(not(feature = "gui"))]
    {
        true
    }
}

/// Whether system launchers should WIN over the managed runtime.
///
/// The GUI toggle is documented as "prefer a system install over the managed
/// native binary", so an opted-in system launcher must sort first. The CLI
/// always discovers system launchers but keeps them as a fallback behind the
/// managed runtime (no user-facing priority promise there).
fn claude_prefer_system_launcher() -> bool {
    #[cfg(feature = "gui")]
    {
        CLAUDE_PREFER_SYSTEM.load(std::sync::atomic::Ordering::Relaxed)
    }
    #[cfg(not(feature = "gui"))]
    {
        false
    }
}

/// Process-wide record of the user's persisted Claude auth mode (`true` when the
/// user selected `api-key`).
///
/// The credential probe must agree with the mode the headless runtime spawns
/// under: an `api-key` session must not be reported ready off a stored OAuth
/// token, and a `subscription` session must not be reported ready off a stored
/// API key. This mirrors the [`CLAUDE_PREFER_SYSTEM`] pattern so `probe_claude_status`
/// can read the persisted mode without threading settings access through core.
#[cfg(feature = "gui")]
static CLAUDE_AUTH_MODE_IS_API_KEY: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

/// Records the user's persisted Claude auth mode for later probe/spawn decisions.
///
/// Set from the settings-command discovery hook and once at startup so the probe
/// never lags the persisted mode.
#[cfg(feature = "gui")]
pub fn set_claude_auth_mode(auth_mode: &str) {
    CLAUDE_AUTH_MODE_IS_API_KEY.store(
        matches!(
            normalize_claude_auth_mode(auth_mode),
            ClaudeAuthMode::ApiKey
        ),
        std::sync::atomic::Ordering::Relaxed,
    );
}

/// The auth mode the probe should evaluate credential presence against.
///
/// Non-GUI builds (the CLI) do not persist an auth-mode process state, so they
/// default to `subscription` (managed OAuth/credential-file detection).
fn current_claude_auth_mode() -> &'static str {
    #[cfg(feature = "gui")]
    {
        if CLAUDE_AUTH_MODE_IS_API_KEY.load(std::sync::atomic::Ordering::Relaxed) {
            "api-key"
        } else {
            "subscription"
        }
    }
    #[cfg(not(feature = "gui"))]
    {
        "subscription"
    }
}

/// The two Claude auth modes OpenReelio persists.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ClaudeAuthMode {
    /// Managed subscription (OAuth token / `CLAUDE_CONFIG_DIR` credentials).
    Subscription,
    /// Stored Anthropic API key.
    ApiKey,
}

/// Normalizes a persisted/requested auth-mode string, defaulting to subscription.
fn normalize_claude_auth_mode(auth_mode: &str) -> ClaudeAuthMode {
    match auth_mode.trim().to_ascii_lowercase().as_str() {
        "api-key" | "api_key" | "apikey" => ClaudeAuthMode::ApiKey,
        _ => ClaudeAuthMode::Subscription,
    }
}

/// Basename of the file that persists a user-provided Anthropic API key.
const STORED_API_KEY_FILE: &str = "openreelio-anthropic-api-key";

/// Basename of the file that persists a Claude Code OAuth token (subscription
/// login via `claude setup-token`).
const STORED_OAUTH_TOKEN_FILE: &str = "openreelio-claude-oauth-token";

/// Known Claude model aliases accepted by the `--model` flag.
///
/// The Claude CLI does not expose a machine-readable model catalog, so this is a
/// fixed alias set (see the module docs). It is intentionally small and stable.
pub const CLAUDE_MODEL_ALIASES: &[&str] = &["sonnet", "opus", "haiku", "fable"];

/// Supported `--effort` levels accepted by the Claude CLI.
pub const CLAUDE_EFFORT_LEVELS: &[&str] = &["low", "medium", "high", "xhigh", "max"];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ClaudeExecutablePlatform {
    Windows,
    Unix,
}

impl ClaudeExecutablePlatform {
    fn current() -> Self {
        if cfg!(windows) {
            Self::Windows
        } else {
            Self::Unix
        }
    }

    fn executable_names(self) -> &'static [&'static str] {
        match self {
            Self::Windows => &["claude.exe", "claude.cmd", "claude.bat"],
            Self::Unix => &["claude"],
        }
    }
}

/// How a resolved Claude command must be invoked.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ClaudeCommandMode {
    /// Invoke the executable directly on the host OS.
    Native,
    /// Invoke the executable through `wsl.exe` (Windows -> WSL bridge).
    Wsl,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ClaudeCommandSource {
    /// App-managed pinned native binary (the current distribution model).
    Managed,
    /// Legacy npm-managed runtime under `.../claude/runtime` (existing installs).
    ManagedLegacy,
    System,
}

impl ClaudeCommandSource {
    fn as_str(self) -> &'static str {
        match self {
            Self::Managed => "managed",
            Self::ManagedLegacy => "managed-legacy",
            Self::System => "system",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct ClaudeCommandSpec {
    executable: PathBuf,
    prefix_args: Vec<String>,
    label: String,
    mode: ClaudeCommandMode,
    source: ClaudeCommandSource,
    config_home: PathBuf,
}

/// Result of probing the local Claude CLI installation and authentication state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeStatusProbeResult {
    /// Whether a runnable `claude` executable was found.
    pub installed: bool,
    /// Reported CLI version, when available.
    pub version: Option<String>,
    /// One of `signed-in`, `api-key`, `signed-out`, `unknown`, or `error`.
    pub auth_status: String,
    /// Human-readable explanation for non-authenticated / error states.
    pub reason: Option<String>,
    /// Runtime provenance (`managed` or `system`), when resolved.
    pub runtime_source: Option<String>,
    /// The managed `CLAUDE_CONFIG_DIR` used for this runtime.
    pub config_home: Option<String>,
}

fn app_data_root() -> PathBuf {
    dirs::data_dir()
        .or_else(dirs::home_dir)
        .unwrap_or_else(|| env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
}

/// Returns the app-managed `CLAUDE_CONFIG_DIR` for isolated Claude runs.
pub fn managed_claude_config_dir() -> PathBuf {
    if let Some(path) = env::var_os(OPENREELIO_CLAUDE_HOME_ENV_VAR).map(PathBuf::from) {
        return path;
    }

    app_data_root()
        .join("OpenReelio")
        .join("claude")
        .join("home")
}

/// Returns the directory used to house an OpenReelio-managed npm install of the
/// Claude CLI (`@anthropic-ai/claude-code`).
pub fn managed_claude_runtime_dir() -> PathBuf {
    managed_claude_config_dir()
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| app_data_root().join("OpenReelio").join("claude"))
        .join("runtime")
}

/// Path of the file that stores a user-provided Anthropic API key (mode 0600).
fn stored_api_key_path() -> PathBuf {
    managed_claude_config_dir().join(STORED_API_KEY_FILE)
}

/// Returns the persisted Anthropic API key, if the user configured api-key auth.
pub fn stored_anthropic_api_key() -> Option<String> {
    let contents = std::fs::read_to_string(stored_api_key_path()).ok()?;
    let trimmed = contents.trim().to_string();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

/// Persists an Anthropic API key inside the managed config directory (mode 0600).
pub fn store_anthropic_api_key(api_key: &str) -> Result<(), String> {
    let trimmed = api_key.trim();
    if trimmed.is_empty() {
        return Err("Anthropic API key must not be empty".to_string());
    }

    let config_home = managed_claude_config_dir();
    ensure_private_claude_config_dir(&config_home)?;
    let path = stored_api_key_path();
    std::fs::write(&path, trimmed.as_bytes())
        .map_err(|error| format!("Failed to store Anthropic API key: {error}"))?;

    // On unix we tighten the file to 0600. On Windows the file inherits the
    // user-scoped %APPDATA% ACL (already private to the account), which is
    // acceptable here; explicit Job/ACL hardening is deliberately deferred.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("Failed to secure Anthropic API key: {error}"))?;
    }

    Ok(())
}

/// Removes any persisted Anthropic API key. Missing files are treated as success.
pub fn clear_stored_anthropic_api_key() -> Result<(), String> {
    let path = stored_api_key_path();
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Failed to clear Anthropic API key: {error}")),
    }
}

/// Path of the file that stores a Claude Code OAuth token (mode 0600).
fn stored_oauth_token_path() -> PathBuf {
    managed_claude_config_dir().join(STORED_OAUTH_TOKEN_FILE)
}

/// Returns the persisted Claude Code OAuth token, if subscription login
/// completed and the user pasted the resulting token back into OpenReelio.
pub fn stored_claude_oauth_token() -> Option<String> {
    let contents = std::fs::read_to_string(stored_oauth_token_path()).ok()?;
    let trimmed = contents.trim().to_string();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

/// Persists a Claude Code OAuth token inside the managed config dir (mode 0600).
pub fn store_claude_oauth_token(token: &str) -> Result<(), String> {
    let trimmed = token.trim();
    if trimmed.is_empty() {
        return Err("Claude Code OAuth token must not be empty".to_string());
    }

    let config_home = managed_claude_config_dir();
    ensure_private_claude_config_dir(&config_home)?;
    let path = stored_oauth_token_path();
    std::fs::write(&path, trimmed.as_bytes())
        .map_err(|error| format!("Failed to store Claude Code OAuth token: {error}"))?;

    // On unix we tighten the file to 0600. On Windows the file inherits the
    // user-scoped %APPDATA% ACL (already private to the account), which is
    // acceptable here; explicit Job/ACL hardening is deliberately deferred.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("Failed to secure Claude Code OAuth token: {error}"))?;
    }

    Ok(())
}

/// Removes any persisted Claude Code OAuth token. Missing files are success.
pub fn clear_stored_claude_oauth_token() -> Result<(), String> {
    let path = stored_oauth_token_path();
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Failed to clear Claude Code OAuth token: {error}")),
    }
}

/// Resolves the first runnable *native* Claude executable (never the WSL bridge).
///
/// Used to launch an interactive login terminal, where invoking the executable
/// directly is required.
pub fn resolve_native_claude_executable() -> Option<PathBuf> {
    collect_claude_command_specs()
        .into_iter()
        .find(|spec| spec.mode == ClaudeCommandMode::Native)
        .map(|spec| spec.executable)
}

/// Resolves the first runnable Claude executable path, if any.
pub fn resolve_claude_executable() -> Option<PathBuf> {
    resolve_claude_command_spec().map(|spec| spec.executable)
}

/// Returns a human-readable label for the resolved Claude launcher.
pub fn claude_command_label() -> String {
    resolve_claude_command_spec()
        .map(|spec| spec.label)
        .unwrap_or_else(|| "claude".to_string())
}

/// Builds a base [`Command`] for the resolved Claude launcher.
///
/// The command always injects `CLAUDE_CONFIG_DIR` (creating the directory with
/// restrictive permissions) and, when the user configured api-key auth, the
/// persisted `ANTHROPIC_API_KEY`.
pub fn create_claude_command() -> Result<Command, String> {
    let spec = resolve_claude_command_spec().ok_or_else(|| {
        "Claude Code executable was not found in PATH or common install locations.".to_string()
    })?;
    create_claude_command_from_spec(&spec)
}

fn create_claude_command_from_spec(spec: &ClaudeCommandSpec) -> Result<Command, String> {
    ensure_private_claude_config_dir(&spec.config_home)?;
    let mut command = Command::new(&spec.executable);
    crate::core::process::configure_tokio_command(&mut command);
    command.args(&spec.prefix_args);
    command.env(CLAUDE_CONFIG_DIR_ENV_VAR, claude_config_dir_env_value(spec));
    // The app owns runtime updates; disable the CLI's built-in self-update.
    command.env(CLAUDE_DISABLE_UPDATES_ENV_VAR, "1");
    // Only a deliberately stored credential counts as managed auth. An inherited
    // process-env `ANTHROPIC_API_KEY`/`CLAUDE_CODE_OAUTH_TOKEN` (from the user's
    // shell) would silently bill the user's personal/global account and break
    // profile isolation, so strip it unless a stored value replaces it.
    match stored_anthropic_api_key() {
        Some(api_key) => {
            command.env(ANTHROPIC_API_KEY_ENV_VAR, api_key);
        }
        None => {
            command.env_remove(ANTHROPIC_API_KEY_ENV_VAR);
        }
    }
    match stored_claude_oauth_token() {
        Some(oauth_token) => {
            command.env(CLAUDE_CODE_OAUTH_TOKEN_ENV_VAR, oauth_token);
        }
        None => {
            command.env_remove(CLAUDE_CODE_OAUTH_TOKEN_ENV_VAR);
        }
    }
    command.kill_on_drop(true);
    Ok(command)
}

/// Builds the environment pairs for an in-app login PTY invocation against the
/// managed profile.
///
/// Mirrors [`create_claude_command`]'s `CLAUDE_CONFIG_DIR` + `DISABLE_UPDATES`
/// injection (and ensures the config dir exists) but intentionally omits the
/// credential env vars: `claude setup-token` performs a fresh browser login, so
/// injecting an existing key/token would be counterproductive.
#[cfg(feature = "gui")]
pub fn claude_login_pty_env() -> Result<Vec<(String, OsString)>, String> {
    let config_home = managed_claude_config_dir();
    ensure_private_claude_config_dir(&config_home)?;
    Ok(vec![
        (
            CLAUDE_CONFIG_DIR_ENV_VAR.to_string(),
            config_home.into_os_string(),
        ),
        (
            CLAUDE_DISABLE_UPDATES_ENV_VAR.to_string(),
            OsString::from("1"),
        ),
    ])
}

pub(crate) fn ensure_private_claude_config_dir(path: &Path) -> Result<(), String> {
    std::fs::create_dir_all(path)
        .map_err(|error| format!("Failed to create OpenReelio Claude config home: {error}"))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("Failed to secure OpenReelio Claude config home: {error}"))?;
    }

    Ok(())
}

fn claude_config_dir_env_value(spec: &ClaudeCommandSpec) -> OsString {
    if spec.mode == ClaudeCommandMode::Wsl {
        if let Some(path) = crate::core::codex::windows_path_to_wsl_mount_path(&spec.config_home) {
            return OsString::from(path);
        }
    }

    spec.config_home.as_os_str().to_os_string()
}

fn resolve_claude_command_spec() -> Option<ClaudeCommandSpec> {
    collect_claude_command_specs().into_iter().next()
}

fn collect_claude_command_specs() -> Vec<ClaudeCommandSpec> {
    let config_home = managed_claude_config_dir();
    let mut specs: Vec<ClaudeCommandSpec> = Vec::new();

    // 1. Managed native runtime: the pinned official binary installed by the app.
    #[cfg(feature = "gui")]
    if let Some(executable) = claude_managed_descriptor().current_executable() {
        specs.push(ClaudeCommandSpec {
            label: executable.display().to_string(),
            executable,
            prefix_args: Vec::new(),
            mode: ClaudeCommandMode::Native,
            source: ClaudeCommandSource::Managed,
            config_home: config_home.clone(),
        });
    }

    // 2. Legacy npm-managed runtime, kept working for existing installs.
    specs.extend(
        collect_managed_claude_executables()
            .into_iter()
            .map(|executable| ClaudeCommandSpec {
                label: executable.display().to_string(),
                executable,
                prefix_args: Vec::new(),
                mode: ClaudeCommandMode::Native,
                source: ClaudeCommandSource::ManagedLegacy,
                config_home: config_home.clone(),
            }),
    );

    // 3. System PATH / platform locations / WSL — only when the user opts in.
    if claude_include_system_discovery() {
        let mut system_specs: Vec<ClaudeCommandSpec> = collect_system_claude_executables()
            .into_iter()
            .map(|executable| ClaudeCommandSpec {
                label: executable.display().to_string(),
                executable,
                prefix_args: Vec::new(),
                mode: ClaudeCommandMode::Native,
                source: ClaudeCommandSource::System,
                config_home: config_home.clone(),
            })
            .collect();

        if let Some(spec) = resolve_wsl_claude_command_spec() {
            system_specs.push(spec);
        }

        if claude_prefer_system_launcher() {
            // The GUI toggle promises system installs WIN over the managed
            // runtime, so opted-in system launchers sort first.
            system_specs.append(&mut specs);
            specs = system_specs;
        } else {
            specs.append(&mut system_specs);
        }
    }

    dedupe_claude_command_specs(specs)
}

/// Descriptor for the app-managed native Claude runtime install location.
#[cfg(feature = "gui")]
pub(crate) fn claude_managed_descriptor() -> crate::core::managed_runtime::ManagedRuntimeDescriptor
{
    let root_dir = managed_claude_config_dir()
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| app_data_root().join("OpenReelio").join("claude"));
    crate::core::managed_runtime::ManagedRuntimeDescriptor {
        runtime_id: "claude",
        root_dir,
        binary_name: claude_managed_binary_name().to_string(),
    }
}

/// Final installed binary filename for the managed Claude runtime.
#[cfg(feature = "gui")]
fn claude_managed_binary_name() -> &'static str {
    if cfg!(windows) {
        "claude.exe"
    } else {
        "claude"
    }
}

fn dedupe_claude_command_specs(specs: Vec<ClaudeCommandSpec>) -> Vec<ClaudeCommandSpec> {
    let mut deduped: Vec<ClaudeCommandSpec> = Vec::new();
    for spec in specs {
        if !deduped.iter().any(|candidate| {
            candidate.executable == spec.executable
                && candidate.prefix_args == spec.prefix_args
                && candidate.config_home == spec.config_home
        }) {
            deduped.push(spec);
        }
    }
    deduped
}

fn collect_managed_claude_executables() -> Vec<PathBuf> {
    let platform = ClaudeExecutablePlatform::current();
    let mut candidates = Vec::new();
    for directory in managed_claude_executable_directories() {
        push_candidate_names(&mut candidates, &directory, platform);
    }
    resolve_runnable_candidates(candidates, platform)
}

fn managed_claude_executable_directories() -> Vec<PathBuf> {
    let runtime_dir = managed_claude_runtime_dir();
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

fn collect_system_claude_executables() -> Vec<PathBuf> {
    let platform = ClaudeExecutablePlatform::current();
    let mut candidates = Vec::new();

    if let Some(path) = env::var_os(CLAUDE_CLI_ENV_VAR).map(PathBuf::from) {
        candidates.push(path);
    }

    candidates.extend(collect_claude_executable_candidates_for_platform(
        env::var_os("PATH"),
        dirs::home_dir(),
        env::var_os("USERPROFILE").map(PathBuf::from),
        env::var_os("APPDATA").map(PathBuf::from),
        env::var_os("LOCALAPPDATA").map(PathBuf::from),
        platform,
    ));

    candidates.extend(find_wsl_windows_user_claude_candidates(platform));
    resolve_runnable_candidates(candidates, platform)
}

fn collect_claude_executable_candidates_for_platform(
    path_env: Option<OsString>,
    home_dir: Option<PathBuf>,
    user_profile: Option<PathBuf>,
    appdata: Option<PathBuf>,
    local_appdata: Option<PathBuf>,
    platform: ClaudeExecutablePlatform,
) -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    for root in [user_profile.as_ref(), home_dir.as_ref()]
        .into_iter()
        .flatten()
    {
        push_claude_home_candidates(&mut candidates, root, platform);
    }

    for root in [appdata.as_ref(), local_appdata.as_ref()]
        .into_iter()
        .flatten()
    {
        push_candidate_names(&mut candidates, &root.join("npm"), platform);
        push_candidate_names(&mut candidates, &root.join("pnpm"), platform);
    }

    if let Some(path_env) = path_env {
        for directory in env::split_paths(&path_env) {
            push_candidate_names(&mut candidates, &directory, platform);
        }
    }

    for directory in default_claude_search_directories(platform) {
        push_candidate_names(&mut candidates, &directory, platform);
    }

    dedupe_paths(candidates)
}

fn push_claude_home_candidates(
    candidates: &mut Vec<PathBuf>,
    root: &Path,
    platform: ClaudeExecutablePlatform,
) {
    let mut directories = vec![
        // Native installer location for `@anthropic-ai/claude-code`.
        root.join(".claude").join("local"),
        root.join(".local").join("bin"),
        root.join(".npm-global").join("bin"),
        root.join(".volta").join("bin"),
        root.join(".asdf").join("shims"),
        root.join(".mise").join("shims"),
        root.join(".nodenv").join("shims"),
        root.join(".bun").join("bin"),
        root.join(".local").join("share").join("pnpm"),
        root.join("Library").join("pnpm"),
        root.join("AppData").join("Roaming").join("npm"),
    ];
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
}

fn push_candidate_names(
    candidates: &mut Vec<PathBuf>,
    directory: &Path,
    platform: ClaudeExecutablePlatform,
) {
    for name in platform.executable_names() {
        candidates.push(directory.join(name));
    }
}

fn collect_node_version_bin_dirs(
    directory: &Path,
    platform: ClaudeExecutablePlatform,
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
                .find(|candidate| directory_has_claude_executable(candidate, platform))
                .map(|candidate| (candidate, node_version_sort_key(&path)))
        })
        .collect::<Vec<_>>();
    dirs.sort_by(|left, right| right.1.cmp(&left.1));
    dirs.into_iter().map(|(directory, _)| directory).collect()
}

fn directory_has_claude_executable(directory: &Path, platform: ClaudeExecutablePlatform) -> bool {
    platform
        .executable_names()
        .iter()
        .any(|name| directory.join(name).is_file())
}

fn node_version_sort_key(directory: &Path) -> [u64; 3] {
    let Some(name) = directory.file_name().and_then(|name| name.to_str()) else {
        return [0, 0, 0];
    };
    let mut parts = name.trim_start_matches('v').split(['.', '-']);
    [
        parts
            .next()
            .and_then(|part| part.parse::<u64>().ok())
            .unwrap_or_default(),
        parts
            .next()
            .and_then(|part| part.parse::<u64>().ok())
            .unwrap_or_default(),
        parts
            .next()
            .and_then(|part| part.parse::<u64>().ok())
            .unwrap_or_default(),
    ]
}

fn default_claude_search_directories(platform: ClaudeExecutablePlatform) -> Vec<PathBuf> {
    match platform {
        ClaudeExecutablePlatform::Windows => vec![
            PathBuf::from(r"C:\Program Files\Anthropic\Claude"),
            PathBuf::from(r"C:\Program Files\Claude"),
        ],
        ClaudeExecutablePlatform::Unix => vec![
            PathBuf::from("/usr/local/bin"),
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/usr/bin"),
            PathBuf::from("/bin"),
        ],
    }
}

fn find_wsl_windows_user_claude_candidates(platform: ClaudeExecutablePlatform) -> Vec<PathBuf> {
    if platform == ClaudeExecutablePlatform::Windows {
        return Vec::new();
    }

    let users_root = Path::new("/mnt/c/Users");
    let Ok(entries) = std::fs::read_dir(users_root) else {
        return Vec::new();
    };

    let mut candidates = Vec::new();
    for entry in entries.flatten() {
        push_claude_home_candidates(&mut candidates, &entry.path(), platform);
    }
    dedupe_paths(candidates)
}

fn resolve_wsl_claude_command_spec() -> Option<ClaudeCommandSpec> {
    if !cfg!(windows) {
        return None;
    }

    let candidates = collect_wsl_claude_candidates_from_windows_roots(
        dirs::home_dir(),
        env::var_os("USERPROFILE").map(PathBuf::from),
    );
    let wsl_claude = resolve_runnable_candidates(candidates, ClaudeExecutablePlatform::Unix)
        .into_iter()
        .next()?;
    let wsl_claude_path = crate::core::codex::windows_path_to_wsl_mount_path(&wsl_claude)?;
    Some(ClaudeCommandSpec {
        executable: PathBuf::from("wsl.exe"),
        prefix_args: vec!["-e".to_string(), wsl_claude_path.clone()],
        label: format!("wsl.exe -e {wsl_claude_path}"),
        mode: ClaudeCommandMode::Wsl,
        source: ClaudeCommandSource::System,
        config_home: managed_claude_config_dir(),
    })
}

fn collect_wsl_claude_candidates_from_windows_roots(
    home_dir: Option<PathBuf>,
    user_profile: Option<PathBuf>,
) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    for root in [user_profile.as_ref(), home_dir.as_ref()]
        .into_iter()
        .flatten()
    {
        push_candidate_names(
            &mut candidates,
            &root.join(".claude").join("local"),
            ClaudeExecutablePlatform::Unix,
        );
        push_candidate_names(
            &mut candidates,
            &root.join(".local").join("bin"),
            ClaudeExecutablePlatform::Unix,
        );
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

fn is_supported_claude_executable(path: &Path, platform: ClaudeExecutablePlatform) -> bool {
    if !path.is_file() {
        return false;
    }

    match platform {
        ClaudeExecutablePlatform::Windows => path
            .extension()
            .and_then(|extension| extension.to_str())
            .map(|extension| {
                matches!(
                    extension.to_ascii_lowercase().as_str(),
                    "exe" | "cmd" | "bat"
                )
            })
            .unwrap_or(false),
        ClaudeExecutablePlatform::Unix => path
            .file_name()
            .and_then(|file_name| file_name.to_str())
            .map(|file_name| file_name == "claude")
            .unwrap_or(false),
    }
}

fn resolve_runnable_candidates(
    candidates: Vec<PathBuf>,
    platform: ClaudeExecutablePlatform,
) -> Vec<PathBuf> {
    candidates
        .into_iter()
        .filter(|candidate| is_supported_claude_executable(candidate, platform))
        .collect()
}

/// Parses the Claude CLI version string from command output.
pub fn parse_claude_version(stdout: &str, stderr: &str) -> Option<String> {
    stdout
        .lines()
        .chain(stderr.lines())
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(|line| line.to_string())
}

/// Formats an I/O error raised while invoking the Claude CLI.
pub fn format_claude_io_error(action: &str, error: &std::io::Error) -> String {
    if error.kind() == std::io::ErrorKind::NotFound {
        return format!(
            "{action}: Claude Code executable was not found in PATH or common install locations."
        );
    }

    if error.raw_os_error() == Some(193) || error.to_string().contains("Win32") {
        return format!(
            "{action}: The selected Claude launcher is not executable on this OS. Use a native Claude CLI launcher such as claude.cmd or claude.exe."
        );
    }

    format!("{action}: {error}")
}

/// How long a resolved Claude launcher spec + `--version` output stays cached.
#[cfg(feature = "gui")]
const CLAUDE_PROBE_CACHE_TTL: std::time::Duration = std::time::Duration::from_secs(5);

/// Cached expensive part of a Claude probe.
///
/// Only the launcher discovery result (`spec`) and the `claude --version` output
/// are cached — these are the costly parts (a filesystem walk and a subprocess
/// with a 10s timeout). Credential/auth state is deliberately NOT cached so a
/// login/logout is reflected on the very next probe.
#[cfg(feature = "gui")]
struct ClaudeProbeCacheEntry {
    resolved_at: std::time::Instant,
    spec: ClaudeCommandSpec,
    version: Option<String>,
}

#[cfg(feature = "gui")]
static CLAUDE_PROBE_CACHE: std::sync::Mutex<Option<ClaudeProbeCacheEntry>> =
    std::sync::Mutex::new(None);

/// Returns the cached `(spec, version)` when still within the TTL.
#[cfg(feature = "gui")]
fn cached_claude_probe() -> Option<(ClaudeCommandSpec, Option<String>)> {
    let guard = CLAUDE_PROBE_CACHE.lock().ok()?;
    let entry = guard.as_ref()?;
    if entry.resolved_at.elapsed() < CLAUDE_PROBE_CACHE_TTL {
        Some((entry.spec.clone(), entry.version.clone()))
    } else {
        None
    }
}

/// Non-GUI builds (the CLI) do not cache probes.
#[cfg(not(feature = "gui"))]
fn cached_claude_probe() -> Option<(ClaudeCommandSpec, Option<String>)> {
    None
}

/// Stores a freshly resolved `(spec, version)` in the probe cache.
#[cfg(feature = "gui")]
fn store_claude_probe(spec: &ClaudeCommandSpec, version: &Option<String>) {
    if let Ok(mut guard) = CLAUDE_PROBE_CACHE.lock() {
        *guard = Some(ClaudeProbeCacheEntry {
            resolved_at: std::time::Instant::now(),
            spec: spec.clone(),
            version: version.clone(),
        });
    }
}

/// No-op probe-cache store on non-GUI builds.
#[cfg(not(feature = "gui"))]
fn store_claude_probe(_spec: &ClaudeCommandSpec, _version: &Option<String>) {}

/// Invalidates the cached Claude launcher spec + version.
///
/// Called after install/update/login/logout so the next probe re-discovers the
/// launcher and re-runs `claude --version` instead of serving a stale (up to
/// [`CLAUDE_PROBE_CACHE_TTL`]) cache entry after the runtime changed.
#[cfg(feature = "gui")]
pub fn invalidate_claude_probe_cache() {
    if let Ok(mut guard) = CLAUDE_PROBE_CACHE.lock() {
        *guard = None;
    }
}

/// No-op cache invalidation on non-GUI builds.
#[cfg(not(feature = "gui"))]
pub fn invalidate_claude_probe_cache() {}

/// Probes the local Claude CLI for installation and authentication state.
///
/// Authentication is detected without spending model tokens (there is no
/// `claude auth status` subcommand). Detection is gated on the persisted auth
/// mode ([`current_claude_auth_mode`]) so the probe agrees with the mode the
/// headless runtime will spawn under:
/// - `api-key` mode → `api-key` only when a STORED api-key file exists (an
///   inherited process-env `ANTHROPIC_API_KEY` is deliberately ignored), else
///   `signed-out`.
/// - `subscription` mode → `signed-in` only when a stored OAuth token or a
///   `CLAUDE_CONFIG_DIR` credential is present, else `signed-out`.
///
/// The credential-presence check is preferred over a trivial headless
/// invocation because the latter would incur a real model round-trip (and cost)
/// on every probe.
///
/// Reads the persisted auth mode from the process-global atomic. Use
/// [`probe_claude_status_with_auth_mode`] to probe against a caller-supplied mode
/// (e.g. right after a UI mode switch, before the debounced settings save lands).
pub async fn probe_claude_status() -> ClaudeStatusProbeResult {
    probe_claude_status_with_auth_mode(None).await
}

/// Probes Claude status, optionally overriding the persisted auth mode.
///
/// When `auth_mode_override` is `Some`, credential presence is evaluated against
/// that mode instead of the process-global [`current_claude_auth_mode`]. This
/// closes a race where probing within the settings-save debounce window (~500ms)
/// after a subscription↔api-key switch would evaluate the STALE global mode and
/// report the wrong readiness. `None` preserves the persisted-mode behavior.
pub async fn probe_claude_status_with_auth_mode(
    auth_mode_override: Option<&str>,
) -> ClaudeStatusProbeResult {
    let config_home = managed_claude_config_dir();

    // Fast path: reuse a recently resolved launcher spec + `--version` output
    // (the discovery walk and the version subprocess are the costly part of a
    // probe). Auth state is re-evaluated fresh below, so login/logout — and the
    // `auth_mode_override` — are always honored even on a cache hit.
    if let Some((spec, version)) = cached_claude_probe() {
        let auth_mode = match auth_mode_override {
            Some(mode) => mode,
            None => current_claude_auth_mode(),
        };
        let (auth_status, reason) = detect_claude_auth_status(&spec.config_home, auth_mode);
        return ClaudeStatusProbeResult {
            installed: true,
            version,
            auth_status,
            reason,
            runtime_source: Some(spec.source.as_str().to_string()),
            config_home: Some(spec.config_home.display().to_string()),
        };
    }

    let Some(spec) = resolve_claude_command_spec() else {
        return ClaudeStatusProbeResult {
            installed: false,
            version: None,
            auth_status: "unknown".to_string(),
            reason: Some(
                "Claude Code executable was not found in PATH or common install locations."
                    .to_string(),
            ),
            runtime_source: None,
            config_home: Some(config_home.display().to_string()),
        };
    };

    let mut version_command = match create_claude_command_from_spec(&spec) {
        Ok(command) => command,
        Err(reason) => {
            return ClaudeStatusProbeResult {
                installed: false,
                version: None,
                auth_status: "error".to_string(),
                reason: Some(reason),
                runtime_source: Some(spec.source.as_str().to_string()),
                config_home: Some(spec.config_home.display().to_string()),
            };
        }
    };

    let version_output = timeout(
        Duration::from_secs(10),
        version_command.arg("--version").output(),
    )
    .await;

    match version_output {
        Ok(Ok(output)) if output.status.success() => {
            let version = parse_claude_version(
                &String::from_utf8_lossy(&output.stdout),
                &String::from_utf8_lossy(&output.stderr),
            );
            // Cache the costly (spec, version) pair for the short TTL; auth is not
            // cached and is recomputed on every probe (including cache hits).
            store_claude_probe(&spec, &version);
            // A caller-supplied mode wins over the (possibly stale) global so a
            // probe issued right after a UI mode switch is evaluated correctly.
            let auth_mode = match auth_mode_override {
                Some(mode) => mode,
                None => current_claude_auth_mode(),
            };
            let (auth_status, reason) = detect_claude_auth_status(&spec.config_home, auth_mode);
            ClaudeStatusProbeResult {
                installed: true,
                version,
                auth_status,
                reason,
                runtime_source: Some(spec.source.as_str().to_string()),
                config_home: Some(spec.config_home.display().to_string()),
            }
        }
        Ok(Ok(output)) => ClaudeStatusProbeResult {
            installed: false,
            version: None,
            auth_status: "unknown".to_string(),
            reason: Some(format!(
                "{} --version failed with status {}",
                spec.label, output.status
            )),
            runtime_source: Some(spec.source.as_str().to_string()),
            config_home: Some(spec.config_home.display().to_string()),
        },
        Ok(Err(error)) => ClaudeStatusProbeResult {
            installed: false,
            version: None,
            auth_status: "unknown".to_string(),
            reason: Some(format_claude_io_error(
                "Failed to run claude --version",
                &error,
            )),
            runtime_source: Some(spec.source.as_str().to_string()),
            config_home: Some(spec.config_home.display().to_string()),
        },
        Err(_) => ClaudeStatusProbeResult {
            installed: false,
            version: None,
            auth_status: "unknown".to_string(),
            reason: Some("claude --version timed out".to_string()),
            runtime_source: Some(spec.source.as_str().to_string()),
            config_home: Some(spec.config_home.display().to_string()),
        },
    }
}

/// Detects the Claude auth state for the given mode from the managed config dir.
///
/// Reads only STORED credentials (never an inherited process-env key/token) so
/// the probe cannot report ready off a value leaked from the user's shell.
fn detect_claude_auth_status(config_home: &Path, auth_mode: &str) -> (String, Option<String>) {
    resolve_claude_auth_status(
        auth_mode,
        stored_anthropic_api_key().is_some(),
        stored_claude_oauth_token().is_some(),
        claude_has_oauth_credentials(config_home),
    )
}

/// Pure auth-status resolver over the (auth-mode × stored-credential) matrix.
///
/// Kept side-effect free (presence flags are passed in) so the full matrix can
/// be unit-tested without touching the filesystem or process environment.
fn resolve_claude_auth_status(
    auth_mode: &str,
    has_stored_api_key: bool,
    has_stored_oauth_token: bool,
    has_oauth_credentials: bool,
) -> (String, Option<String>) {
    match normalize_claude_auth_mode(auth_mode) {
        ClaudeAuthMode::ApiKey => {
            if has_stored_api_key {
                ("api-key".to_string(), None)
            } else {
                claude_signed_out_status()
            }
        }
        ClaudeAuthMode::Subscription => {
            if has_stored_oauth_token || has_oauth_credentials {
                ("signed-in".to_string(), None)
            } else {
                claude_signed_out_status()
            }
        }
    }
}

/// The canonical `signed-out` status with its user-facing reason.
fn claude_signed_out_status() -> (String, Option<String>) {
    (
        "signed-out".to_string(),
        Some("Claude Code is not signed in. Run the login flow to authenticate.".to_string()),
    )
}

/// Returns whether the managed config dir holds OAuth credentials.
fn claude_has_oauth_credentials(config_home: &Path) -> bool {
    if config_home.join(".credentials.json").is_file() {
        return true;
    }

    // macOS keeps OAuth tokens in the Keychain rather than a credentials file,
    // but the account record is still mirrored into the main config JSON.
    let config_json = config_home.join(".claude.json");
    if let Ok(contents) = std::fs::read_to_string(&config_json) {
        if contents.contains("oauthAccount") || contents.contains("\"accessToken\"") {
            return true;
        }
    }

    false
}

/// Normalizes a requested Claude model to a known alias, defaulting when empty.
pub fn normalize_claude_model(requested_model: Option<String>) -> String {
    requested_model
        .map(|model| model.trim().to_string())
        .filter(|model| !model.is_empty())
        .unwrap_or_else(|| DEFAULT_CLAUDE_MODEL.to_string())
}

/// Normalizes a requested effort level, defaulting when empty/unrecognized.
pub fn normalize_claude_effort(requested_effort: Option<String>) -> String {
    requested_effort
        .map(|effort| effort.trim().to_ascii_lowercase())
        .filter(|effort| CLAUDE_EFFORT_LEVELS.contains(&effort.as_str()))
        .unwrap_or_else(|| DEFAULT_CLAUDE_EFFORT.to_string())
}

// =============================================================================
// Managed native runtime: artifact resolution (official release channel)
// =============================================================================

/// Base URL for the official Claude Code native-binary release channel.
#[cfg(feature = "gui")]
const CLAUDE_RELEASES_BASE: &str = "https://downloads.claude.ai/claude-code-releases";

/// Resolves the release platform key for the current OS/arch, or an error.
#[cfg(feature = "gui")]
fn claude_platform_key() -> Result<&'static str, String> {
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    {
        return Ok("win32-x64");
    }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        return Ok("darwin-x64");
    }
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        return Ok("darwin-arm64");
    }
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        return Ok("linux-x64");
    }
    #[allow(unreachable_code)]
    Err("The managed Claude runtime is not available for this platform.".to_string())
}

/// Builds the URL of the release manifest for a specific Claude version.
#[cfg(feature = "gui")]
fn claude_manifest_url(version: &str) -> String {
    format!("{CLAUDE_RELEASES_BASE}/{version}/manifest.json")
}

/// Builds the download URL of the Claude binary for a version and platform key.
#[cfg(feature = "gui")]
fn claude_binary_url(version: &str, platform_key: &str) -> String {
    let binary = if platform_key.starts_with("win32") {
        "claude.exe"
    } else {
        "claude"
    };
    format!("{CLAUDE_RELEASES_BASE}/{version}/{platform_key}/{binary}")
}

/// Extracts the pinned SHA-256 checksum for a platform from a manifest JSON body.
///
/// Pure (no network) so it can be unit-tested with a fixture manifest.
#[cfg(feature = "gui")]
fn claude_checksum_from_manifest_json(body: &str, platform_key: &str) -> Result<String, String> {
    let value: serde_json::Value = serde_json::from_str(body)
        .map_err(|error| format!("Failed to parse Claude release manifest: {error}"))?;
    let checksum = value
        .get("platforms")
        .and_then(|platforms| platforms.get(platform_key))
        .and_then(|platform| platform.get("checksum"))
        .and_then(|checksum| checksum.as_str())
        .ok_or_else(|| {
            format!("Claude release manifest has no checksum for platform '{platform_key}'.")
        })?
        .trim();

    if checksum.len() == 64 && checksum.chars().all(|ch| ch.is_ascii_hexdigit()) {
        Ok(checksum.to_ascii_lowercase())
    } else {
        Err(format!("Invalid Claude manifest checksum: {checksum}"))
    }
}

/// Builds a blocking reqwest client for the Claude release channel.
///
/// Only small metadata is fetched here (the version manifest and the `stable`
/// pointer), so a 60s total timeout is ample; it also bounds the body read, which
/// the previous connect-only timeout did not.
#[cfg(feature = "gui")]
fn claude_blocking_client() -> Result<reqwest::blocking::Client, String> {
    crate::core::artifact::blocking_http_client(std::time::Duration::from_secs(60))
}

/// Resolves the download URL + checksum for a Claude version (blocking network).
#[cfg(feature = "gui")]
pub(crate) fn resolve_claude_artifact_blocking(
    version: &str,
) -> Result<crate::core::managed_runtime::ResolvedArtifact, String> {
    let platform_key = claude_platform_key()?;
    let client = claude_blocking_client()?;
    let response = client
        .get(claude_manifest_url(version))
        .send()
        .map_err(|error| format!("Failed to fetch Claude release manifest: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "Claude release manifest request failed with HTTP status {}",
            response.status()
        ));
    }
    let body = response
        .text()
        .map_err(|error| format!("Failed to read Claude release manifest: {error}"))?;
    let sha256 = claude_checksum_from_manifest_json(&body, platform_key)?;

    Ok(crate::core::managed_runtime::ResolvedArtifact {
        url: claude_binary_url(version, platform_key),
        sha256,
        format: crate::core::managed_runtime::ArtifactFormat::RawExecutable,
        archive_binary_name: None,
    })
}

/// Fetches the latest stable Claude version from the release channel (blocking).
///
/// Retained for a possible future "check for updates" affordance, but no longer
/// called by the update flow: the app installs the KNOWN-GOOD
/// [`CLAUDE_PINNED_VERSION`] per release (see [`crate::core::claude_agent::update_claude_cli`]).
#[cfg(feature = "gui")]
#[allow(dead_code)]
pub(crate) fn claude_latest_version_blocking() -> Result<String, String> {
    let client = claude_blocking_client()?;
    let response = client
        .get(format!("{CLAUDE_RELEASES_BASE}/stable"))
        .send()
        .map_err(|error| format!("Failed to fetch latest Claude version: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "Latest Claude version request failed with HTTP status {}",
            response.status()
        ));
    }
    let body = response
        .text()
        .map_err(|error| format!("Failed to read latest Claude version: {error}"))?;
    let version = body.trim().to_string();
    if version.is_empty() {
        Err("Latest Claude version response was empty.".to_string())
    } else {
        Ok(version)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn parses_claude_version_from_stdout() {
        assert_eq!(
            parse_claude_version("2.1.202 (Claude Code)\n", ""),
            Some("2.1.202 (Claude Code)".to_string())
        );
    }

    #[test]
    fn returns_none_for_empty_version_output() {
        assert_eq!(parse_claude_version("", "\n"), None);
    }

    #[test]
    fn normalizes_missing_model_to_default() {
        assert_eq!(normalize_claude_model(None), DEFAULT_CLAUDE_MODEL);
        assert_eq!(
            normalize_claude_model(Some("  ".to_string())),
            DEFAULT_CLAUDE_MODEL
        );
        assert_eq!(normalize_claude_model(Some("opus".to_string())), "opus");
    }

    #[test]
    fn normalizes_effort_case_insensitively_and_rejects_unknown() {
        assert_eq!(normalize_claude_effort(Some("HIGH".to_string())), "high");
        assert_eq!(
            normalize_claude_effort(Some("nonsense".to_string())),
            DEFAULT_CLAUDE_EFFORT
        );
        assert_eq!(normalize_claude_effort(None), DEFAULT_CLAUDE_EFFORT);
    }

    #[test]
    fn detects_oauth_credentials_from_credentials_file() {
        let temp = tempfile::tempdir().expect("temp dir");
        fs::write(temp.path().join(".credentials.json"), b"{}").expect("creds");
        assert!(claude_has_oauth_credentials(temp.path()));
    }

    #[test]
    fn detects_signed_out_without_credentials() {
        let temp = tempfile::tempdir().expect("temp dir");
        assert!(!claude_has_oauth_credentials(temp.path()));
    }

    #[test]
    fn normalizes_claude_auth_mode_aliases() {
        assert_eq!(
            normalize_claude_auth_mode("api-key"),
            ClaudeAuthMode::ApiKey
        );
        assert_eq!(
            normalize_claude_auth_mode("API_KEY"),
            ClaudeAuthMode::ApiKey
        );
        assert_eq!(normalize_claude_auth_mode("apikey"), ClaudeAuthMode::ApiKey);
        assert_eq!(
            normalize_claude_auth_mode("subscription"),
            ClaudeAuthMode::Subscription
        );
        // Unknown / empty defaults to subscription.
        assert_eq!(
            normalize_claude_auth_mode("nonsense"),
            ClaudeAuthMode::Subscription
        );
        assert_eq!(normalize_claude_auth_mode(""), ClaudeAuthMode::Subscription);
    }

    #[test]
    fn api_key_mode_requires_a_stored_api_key() {
        // Stored api key present -> api-key.
        assert_eq!(
            resolve_claude_auth_status("api-key", true, false, false).0,
            "api-key"
        );
        // No stored key -> signed-out, even if an OAuth token/credential exists
        // (mode is authoritative) and regardless of process env (not consulted).
        assert_eq!(
            resolve_claude_auth_status("api-key", false, true, true).0,
            "signed-out"
        );
    }

    #[test]
    fn subscription_mode_requires_stored_oauth_or_credentials() {
        // Stored OAuth token -> signed-in.
        assert_eq!(
            resolve_claude_auth_status("subscription", false, true, false).0,
            "signed-in"
        );
        // Credential file only -> signed-in.
        assert_eq!(
            resolve_claude_auth_status("subscription", false, false, true).0,
            "signed-in"
        );
        // A stored api key does NOT satisfy subscription mode.
        assert_eq!(
            resolve_claude_auth_status("subscription", true, false, false).0,
            "signed-out"
        );
        // Nothing stored -> signed-out with a reason.
        let (status, reason) = resolve_claude_auth_status("subscription", false, false, false);
        assert_eq!(status, "signed-out");
        assert!(reason.is_some());
    }

    #[test]
    fn resolves_claude_from_native_local_install() {
        let temp = tempfile::tempdir().expect("temp dir");
        let claude_path = temp.path().join(".claude/local/claude");
        fs::create_dir_all(claude_path.parent().expect("parent")).expect("dir");
        fs::write(&claude_path, b"").expect("file");

        let candidates = collect_claude_executable_candidates_for_platform(
            None,
            Some(temp.path().to_path_buf()),
            None,
            None,
            None,
            ClaudeExecutablePlatform::Unix,
        );

        assert_eq!(
            resolve_runnable_candidates(candidates, ClaudeExecutablePlatform::Unix)
                .into_iter()
                .next(),
            Some(claude_path)
        );
    }

    #[test]
    fn resolves_claude_from_windows_pnpm_appdata() {
        let temp = tempfile::tempdir().expect("temp dir");
        let claude_path = temp.path().join("pnpm/claude.cmd");
        fs::create_dir_all(claude_path.parent().expect("parent")).expect("dir");
        fs::write(&claude_path, b"@ECHO off").expect("file");

        let candidates = collect_claude_executable_candidates_for_platform(
            None,
            None,
            None,
            Some(temp.path().to_path_buf()),
            None,
            ClaudeExecutablePlatform::Windows,
        );

        assert_eq!(
            resolve_runnable_candidates(candidates, ClaudeExecutablePlatform::Windows)
                .into_iter()
                .next(),
            Some(claude_path)
        );
    }

    #[cfg(feature = "gui")]
    #[test]
    fn builds_claude_manifest_and_binary_urls() {
        let platform_key = claude_platform_key().expect("supported platform");
        assert_eq!(
            claude_manifest_url("2.1.202"),
            "https://downloads.claude.ai/claude-code-releases/2.1.202/manifest.json"
        );

        let binary_url = claude_binary_url("2.1.202", platform_key);
        assert!(binary_url.starts_with("https://downloads.claude.ai/claude-code-releases/2.1.202/"));
        if cfg!(windows) {
            assert!(binary_url.ends_with("/win32-x64/claude.exe"));
        } else {
            assert!(binary_url.ends_with("/claude"));
        }
    }

    #[cfg(feature = "gui")]
    #[test]
    fn extracts_claude_checksum_from_manifest_json() {
        let hex = "d".repeat(64);
        let body = format!(
            r#"{{"platforms":{{
                "win32-x64":{{"checksum":"{win}"}},
                "darwin-x64":{{"checksum":"{hex}"}},
                "darwin-arm64":{{"checksum":"{hex}"}},
                "linux-x64":{{"checksum":"{hex}"}}
            }}}}"#,
            win = "e".repeat(64),
            hex = hex,
        );

        assert_eq!(
            claude_checksum_from_manifest_json(&body, "darwin-arm64"),
            Ok(hex)
        );
        assert!(claude_checksum_from_manifest_json(&body, "unknown-key").is_err());
    }

    #[cfg(feature = "gui")]
    #[test]
    fn rejects_malformed_claude_manifest_checksum() {
        let body = r#"{"platforms":{"linux-x64":{"checksum":"not-a-real-hash"}}}"#;
        assert!(claude_checksum_from_manifest_json(body, "linux-x64").is_err());
    }

    #[test]
    fn managed_legacy_source_label_is_stable() {
        assert_eq!(ClaudeCommandSource::Managed.as_str(), "managed");
        assert_eq!(
            ClaudeCommandSource::ManagedLegacy.as_str(),
            "managed-legacy"
        );
        assert_eq!(ClaudeCommandSource::System.as_str(), "system");
    }

    #[cfg(feature = "gui")]
    #[test]
    fn prefer_system_gates_system_discovery() {
        // Managed-only by default; opting in enables system-launcher discovery.
        set_claude_prefer_system(false);
        assert!(!claude_include_system_discovery());
        set_claude_prefer_system(true);
        assert!(claude_include_system_discovery());
        set_claude_prefer_system(false);
    }
}
