//! Claude Code external-agent runtime helpers.
//!
//! Mirrors the Codex runtime functions in [`crate::core::external_agent`] for
//! the Anthropic `claude` CLI: configuration/readiness, login/logout, install,
//! update, and a one-shot command runner. All Claude invocations run against the
//! app-managed `CLAUDE_CONFIG_DIR` so the user's global profile is never touched.

use serde::{Deserialize, Serialize};
use specta::Type;
use tokio::time::{timeout, Duration};

use crate::core::claude_code::{
    self, clear_stored_anthropic_api_key, clear_stored_claude_oauth_token, create_claude_command,
    format_claude_io_error, managed_claude_config_dir, probe_claude_status,
    probe_claude_status_with_auth_mode, resolve_native_claude_executable, store_anthropic_api_key,
    store_claude_oauth_token, stored_anthropic_api_key, stored_claude_oauth_token,
    CLAUDE_CODE_OAUTH_TOKEN_ENV_VAR, CLAUDE_CONFIG_DIR_ENV_VAR,
};
/// Input for `configure_claude_agent_runtime`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConfigureClaudeAgentRuntimeInput {
    /// Optional project path (accepted for parity with Codex; currently unused).
    pub project_path: Option<String>,
    /// Optional auth mode (`"subscription"` or `"api-key"`) the probe should
    /// evaluate credential presence against, overriding the persisted global.
    ///
    /// The UI passes its currently-selected mode so a probe issued right after a
    /// mode switch is not evaluated against the stale debounced-save global.
    /// Absent (serde default) preserves the persisted-mode behavior.
    #[serde(default)]
    pub auth_mode: Option<String>,
}

/// Input for `get_claude_status`.
///
/// Optional so the command stays wire-compatible with callers that pass nothing;
/// present callers supply the UI's current auth mode to avoid a stale-mode probe.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GetClaudeStatusInput {
    /// Optional auth mode override for the probe (see
    /// [`ConfigureClaudeAgentRuntimeInput::auth_mode`]).
    #[serde(default)]
    pub auth_mode: Option<String>,
}

/// Result of `configure_claude_agent_runtime`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConfigureClaudeAgentRuntimeResult {
    /// Whether the Claude CLI is installed.
    pub installed: bool,
    /// Detected CLI version.
    pub version: Option<String>,
    /// Auth status (`signed-in`, `api-key`, `signed-out`, `unknown`, `error`).
    pub auth_status: String,
    /// Whether the runtime is ready (installed and authenticated).
    pub ready: bool,
    /// Whether the user must complete a login flow.
    pub requires_login: bool,
    /// Human-readable status message.
    pub message: Option<String>,
    /// Runtime provenance (`managed`, `managed-legacy`, or `system`).
    pub runtime_source: Option<String>,
    /// Managed `CLAUDE_CONFIG_DIR`.
    pub config_home: Option<String>,
    /// Pinned Claude version the app installs/updates to (for staleness UI).
    pub pinned_version: Option<String>,
}

/// Input for `start_claude_login`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct StartClaudeLoginInput {
    /// Login mode:
    /// - `"subscription"`: launch `claude setup-token` in a visible terminal.
    /// - `"oauth-token"`: persist the token the user pasted back after that flow.
    /// - `"api-key"`: persist a raw Anthropic API key.
    pub mode: String,
    /// Credential payload. For `mode == "api-key"` this is the Anthropic API key;
    /// for `mode == "oauth-token"` this same field carries the pasted OAuth token
    /// produced by `claude setup-token`. Unused for `mode == "subscription"`.
    pub api_key: Option<String>,
}

/// Result of `start_claude_login`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct StartClaudeLoginResult {
    /// Whether the login flow completed successfully.
    pub success: bool,
    /// Resulting auth status.
    pub auth_status: String,
    /// Human-readable status message.
    pub message: Option<String>,
}

/// Result of `logout_claude_agent_runtime`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeAgentLogoutResult {
    /// Whether the sign-out completed.
    pub success: bool,
    /// Resulting auth status.
    pub auth_status: String,
    /// Human-readable status message.
    pub message: Option<String>,
}

/// Result of `install_claude_cli`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeCliInstallResult {
    /// Whether an OpenReelio-managed install is present after the attempt.
    pub success: bool,
    /// Detected version after the attempt.
    pub version: Option<String>,
    /// Human-readable description of the install/update action that was attempted.
    pub attempted_command: Option<String>,
    /// Human-readable status message.
    pub message: Option<String>,
}

/// Result of `update_claude_cli`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeCliUpdateResult {
    /// Whether the update completed.
    pub success: bool,
    /// Version before the update.
    pub before_version: Option<String>,
    /// Version after the update.
    pub after_version: Option<String>,
    /// Human-readable description of the install/update action that was attempted.
    pub attempted_command: Option<String>,
    /// Human-readable status message.
    pub message: Option<String>,
}

fn is_claude_authenticated(auth_status: &str) -> bool {
    matches!(auth_status, "signed-in" | "api-key")
}

/// Whether the probe reports the app-managed *native* Claude runtime (not legacy).
#[cfg(feature = "gui")]
fn is_native_managed_claude(status: &claude_code::ClaudeStatusProbeResult) -> bool {
    status.runtime_source.as_deref() == Some("managed")
}

/// Probes the Claude CLI and reports configuration readiness.
pub async fn configure_claude_agent_runtime(
    input: ConfigureClaudeAgentRuntimeInput,
) -> ConfigureClaudeAgentRuntimeResult {
    let status = probe_claude_status_with_auth_mode(input.auth_mode.as_deref()).await;
    if !status.installed {
        return ConfigureClaudeAgentRuntimeResult {
            installed: false,
            version: status.version,
            auth_status: status.auth_status,
            ready: false,
            requires_login: false,
            message: status
                .reason
                .or_else(|| Some("Claude Code CLI is not installed.".to_string())),
            runtime_source: status.runtime_source,
            config_home: status.config_home,
            pinned_version: Some(claude_code::CLAUDE_PINNED_VERSION.to_string()),
        };
    }

    let authenticated = is_claude_authenticated(&status.auth_status);
    let message = if authenticated {
        Some(
            "Claude Code is signed in. OpenReelio is using its managed Claude profile for auth and sessions."
                .to_string(),
        )
    } else {
        status
            .reason
            .or_else(|| Some("Claude Code needs sign-in.".to_string()))
    };

    ConfigureClaudeAgentRuntimeResult {
        installed: true,
        version: status.version,
        auth_status: status.auth_status,
        ready: authenticated,
        requires_login: !authenticated,
        message,
        runtime_source: status.runtime_source,
        config_home: status.config_home,
        pinned_version: Some(claude_code::CLAUDE_PINNED_VERSION.to_string()),
    }
}

/// Starts a Claude login flow.
///
/// - `mode == "api-key"`: persists the provided key so subsequent commands
///   inject `ANTHROPIC_API_KEY`.
/// - `mode == "subscription"`: launches `claude setup-token` in a visible
///   terminal (the OAuth handshake needs a browser and interactive stdin, which
///   a headless child cannot provide). Returns immediately; the user pastes the
///   resulting token back via `mode == "oauth-token"`.
/// - `mode == "oauth-token"`: persists the token pasted back from the terminal
///   flow (carried in the `api_key` field) so sessions inject
///   `CLAUDE_CODE_OAUTH_TOKEN`.
pub async fn start_claude_login(input: StartClaudeLoginInput) -> StartClaudeLoginResult {
    let mode = input.mode.trim().to_ascii_lowercase();
    match mode.as_str() {
        "api-key" | "api_key" | "apikey" => start_api_key_login(input.api_key).await,
        "oauth-token" | "oauth_token" => start_oauth_token_login(input.api_key).await,
        "subscription" | "oauth" | "" => start_subscription_login().await,
        other => StartClaudeLoginResult {
            success: false,
            auth_status: "unknown".to_string(),
            message: Some(format!("Unsupported Claude login mode: {other}")),
        },
    }
}

async fn start_api_key_login(api_key: Option<String>) -> StartClaudeLoginResult {
    let Some(api_key) = api_key
        .map(|key| key.trim().to_string())
        .filter(|key| !key.is_empty())
    else {
        return StartClaudeLoginResult {
            success: false,
            auth_status: "signed-out".to_string(),
            message: Some("An Anthropic API key is required for api-key login.".to_string()),
        };
    };

    if let Err(error) = store_anthropic_api_key(&api_key) {
        return StartClaudeLoginResult {
            success: false,
            auth_status: "error".to_string(),
            message: Some(error),
        };
    }

    // Credentials changed; force the readiness probe to re-run rather than serve a
    // cached spec/version from just before the key was stored.
    claude_code::invalidate_claude_probe_cache();
    let after = probe_claude_status().await;
    StartClaudeLoginResult {
        success: is_claude_authenticated(&after.auth_status),
        auth_status: after.auth_status,
        message: Some("Anthropic API key stored for the OpenReelio managed profile.".to_string()),
    }
}

/// Persists an OAuth token pasted back from the interactive `setup-token` flow.
async fn start_oauth_token_login(token: Option<String>) -> StartClaudeLoginResult {
    let Some(token) = token
        .map(|token| token.trim().to_string())
        .filter(|token| !token.is_empty())
    else {
        return StartClaudeLoginResult {
            success: false,
            auth_status: "signed-out".to_string(),
            message: Some(
                "Paste the token from the Claude login terminal to finish signing in.".to_string(),
            ),
        };
    };

    if let Err(error) = store_claude_oauth_token(&token) {
        return StartClaudeLoginResult {
            success: false,
            auth_status: "error".to_string(),
            message: Some(error),
        };
    }

    // Credentials changed; force the readiness probe to re-run.
    claude_code::invalidate_claude_probe_cache();
    let after = probe_claude_status().await;
    StartClaudeLoginResult {
        success: is_claude_authenticated(&after.auth_status),
        auth_status: after.auth_status,
        message: Some(
            "Claude Code subscription token stored for the OpenReelio managed profile.".to_string(),
        ),
    }
}

/// Launches `claude setup-token` in a visible terminal window.
///
/// The OAuth handshake needs a browser and interactive stdin, so it cannot run
/// headlessly. This returns immediately with a pending result: the user finishes
/// login in the terminal, then pastes the printed token back into OpenReelio
/// (which persists it via `mode == "oauth-token"`).
async fn start_subscription_login() -> StartClaudeLoginResult {
    let before = probe_claude_status().await;
    if !before.installed {
        return StartClaudeLoginResult {
            success: false,
            auth_status: before.auth_status,
            message: before
                .reason
                .or_else(|| Some("Claude Code CLI is not installed.".to_string())),
        };
    }
    if is_claude_authenticated(&before.auth_status) {
        return StartClaudeLoginResult {
            success: true,
            auth_status: before.auth_status,
            message: Some("Claude Code is already signed in.".to_string()),
        };
    }

    let config_home = managed_claude_config_dir();
    let claude_display = resolve_native_claude_executable()
        .map(|path| path.display().to_string())
        .unwrap_or_else(|| "claude".to_string());
    let manual_command =
        manual_setup_token_command(&config_home.display().to_string(), &claude_display);

    match launch_setup_token_terminal(&config_home.display().to_string(), &claude_display) {
        Ok(()) => StartClaudeLoginResult {
            success: true,
            auth_status: before.auth_status,
            message: Some(format!(
                "A terminal window is opening to sign in to Claude Code. Complete the login there, \
                 then copy the printed token and paste it back into OpenReelio to finish. \
                 If no window appears, run this command manually:\n{manual_command}"
            )),
        },
        Err(error) => StartClaudeLoginResult {
            success: false,
            auth_status: before.auth_status,
            message: Some(format!(
                "Could not open a login terminal automatically ({error}). Run this command \
                 manually, then paste the printed token back into OpenReelio:\n{manual_command}"
            )),
        },
    }
}

/// Formats the exact `setup-token` command a user can run by hand as a fallback.
pub(crate) fn manual_setup_token_command(config_home: &str, claude_display: &str) -> String {
    if cfg!(windows) {
        format!(
            "set \"{CLAUDE_CONFIG_DIR_ENV_VAR}={config_home}\" && \"{claude_display}\" setup-token"
        )
    } else {
        format!("{CLAUDE_CONFIG_DIR_ENV_VAR}=\"{config_home}\" \"{claude_display}\" setup-token")
    }
}

/// Opens a visible terminal running `claude setup-token` with the managed
/// `CLAUDE_CONFIG_DIR` exported. Platform-specific; errors when no terminal
/// emulator is available so the caller can surface the manual command.
fn launch_setup_token_terminal(config_home: &str, claude_display: &str) -> Result<(), String> {
    use std::process::Command;

    #[cfg(target_os = "windows")]
    {
        // Run the flow from a generated batch script instead of passing a
        // quoted command line through `cmd /k`: Rust's std escapes embedded
        // quotes as `\"`, which cmd.exe does not parse, so an inline command
        // string arrives mangled and setup-token never runs. A script file
        // sidesteps argument quoting entirely; `pause` keeps the console open
        // so the printed token stays visible for the user to copy.
        let script_path = write_windows_setup_token_script(config_home, claude_display)?;
        let script_arg = script_path.to_string_lossy().to_string();
        let mut command = Command::new("cmd");
        command.args(["/c", "start", "OpenReelio Claude Login", &script_arg]);
        crate::core::process::configure_std_command(&mut command);
        command
            .spawn()
            .map(|_| ())
            .map_err(|error| format!("Failed to open login terminal: {error}"))
    }

    #[cfg(target_os = "macos")]
    {
        let script_path = write_setup_token_script(config_home, claude_display, "command")?;
        let mut command = Command::new("open");
        command.args(["-a", "Terminal"]).arg(&script_path);
        crate::core::process::configure_std_command(&mut command);
        command
            .spawn()
            .map(|_| ())
            .map_err(|error| format!("Failed to open Terminal: {error}"))
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let script_path = write_setup_token_script(config_home, claude_display, "sh")?;
        // `x-terminal-emulator` is a Debian-alternatives symlink that does not
        // exist on Fedora/Arch/openSUSE, so fall through a chain of common
        // emulators before giving up (the caller then shows the manual command).
        let candidates: [(&str, &[&str]); 4] = [
            ("x-terminal-emulator", &["-e", "bash"]),
            ("gnome-terminal", &["--", "bash"]),
            ("konsole", &["-e", "bash"]),
            ("xterm", &["-e", "bash"]),
        ];
        for (terminal, args) in candidates {
            let mut command = Command::new(terminal);
            command.args(args).arg(&script_path);
            crate::core::process::configure_std_command(&mut command);
            if command.spawn().is_ok() {
                return Ok(());
            }
        }
        Err("No supported terminal emulator was found (tried x-terminal-emulator, gnome-terminal, konsole, xterm).".to_string())
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", unix)))]
    {
        let _ = (config_home, claude_display);
        Err("Interactive login is not supported on this platform.".to_string())
    }
}

/// Writes a batch script that sets `CLAUDE_CONFIG_DIR` and runs
/// `claude setup-token`, returning its path. Batch parsing is line-based, so a
/// script file avoids the nested-quote mangling that an inline `cmd /k`
/// command line suffers when spawned from Rust.
#[cfg(target_os = "windows")]
fn write_windows_setup_token_script(
    config_home: &str,
    claude_display: &str,
) -> Result<std::path::PathBuf, String> {
    // CRLF line endings: the cmd batch parser misreads bare-LF scripts in some
    // constructs, so always emit Windows line endings here.
    let script = format!(
        "@echo off\r\n\
         title OpenReelio Claude Login\r\n\
         set \"{CLAUDE_CONFIG_DIR_ENV_VAR}={config_home}\"\r\n\
         \"{claude_display}\" setup-token\r\n\
         echo.\r\n\
         echo Copy the token above and paste it into OpenReelio (Settings ^> AI ^> Save token).\r\n\
         echo You can close this window afterwards.\r\n\
         pause\r\n"
    );
    // Written inside the private managed config dir, NOT the shared temp dir:
    // a fixed filename in a world-writable location invites symlink/TOCTOU
    // swaps by other local users.
    let script_dir = std::path::Path::new(config_home);
    claude_code::ensure_private_claude_config_dir(script_dir)?;
    let path = script_dir.join("openreelio-claude-login.cmd");
    std::fs::write(&path, script.as_bytes())
        .map_err(|error| format!("Failed to write login script: {error}"))?;
    Ok(path)
}

/// Writes a small shell script that exports `CLAUDE_CONFIG_DIR` and runs
/// `claude setup-token`, returning its path. Used on unix-like platforms where
/// the terminal launcher runs a script rather than inheriting the env directly.
#[cfg(unix)]
fn write_setup_token_script(
    config_home: &str,
    claude_display: &str,
    extension: &str,
) -> Result<std::path::PathBuf, String> {
    use std::os::unix::fs::PermissionsExt;

    let script = format!(
        "#!/bin/bash\nexport {CLAUDE_CONFIG_DIR_ENV_VAR}=\"{config_home}\"\n\"{claude_display}\" setup-token\necho\necho \"Copy the token above and paste it back into OpenReelio.\"\n"
    );
    // Written inside the private (0700) managed config dir, NOT the shared
    // temp dir: a fixed filename in /tmp invites symlink/TOCTOU swaps by
    // other local users.
    let script_dir = std::path::Path::new(config_home);
    claude_code::ensure_private_claude_config_dir(script_dir)?;
    let path = script_dir.join(format!("openreelio-claude-login.{extension}"));
    std::fs::write(&path, script.as_bytes())
        .map_err(|error| format!("Failed to write login script: {error}"))?;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))
        .map_err(|error| format!("Failed to make login script executable: {error}"))?;
    Ok(path)
}

/// Signs out of the managed Claude profile and clears any stored API key.
pub async fn logout_claude_agent_runtime() -> ClaudeAgentLogoutResult {
    let before = probe_claude_status().await;
    if !before.installed {
        // Still clear any stored credentials so the managed profile is left clean.
        let _ = clear_stored_anthropic_api_key();
        let _ = clear_stored_claude_oauth_token();
        return ClaudeAgentLogoutResult {
            success: false,
            auth_status: before.auth_status,
            message: before
                .reason
                .or_else(|| Some("Claude Code CLI is not installed.".to_string())),
        };
    }

    let clear_result = clear_stored_anthropic_api_key().and(clear_stored_claude_oauth_token());
    let logout_result = run_claude_command(&["logout"], Duration::from_secs(60)).await;
    // Credentials were cleared; force the readiness probe to re-run.
    claude_code::invalidate_claude_probe_cache();
    let after = probe_claude_status().await;
    let success = after.auth_status == "signed-out";

    let message = if success {
        Some("Claude Code sign-out completed for the OpenReelio managed profile.".to_string())
    } else if let Err(error) = clear_result {
        Some(error)
    } else {
        Some(match logout_result {
            Ok(output) if output.is_empty() => "Claude Code sign-out did not complete.".to_string(),
            Ok(output) => output,
            Err(error) => error,
        })
    };

    ClaudeAgentLogoutResult {
        success,
        auth_status: after.auth_status,
        message,
    }
}

/// Installs the pinned Claude CLI as an official native binary.
///
/// Replaces the previous npm-based install: downloads the pinned version, verifies
/// its checksum against the release manifest, and swaps the managed `current`
/// pointer atomically. `on_progress` streams download/verify/install updates.
#[cfg(feature = "gui")]
pub async fn install_claude_cli<F>(on_progress: F) -> ClaudeCliInstallResult
where
    F: Fn(crate::core::managed_runtime::InstallProgress) + Send + 'static,
{
    let before = probe_claude_status().await;
    if before.installed && is_native_managed_claude(&before) {
        return ClaudeCliInstallResult {
            success: true,
            version: before.version,
            attempted_command: None,
            message: Some("OpenReelio-managed Claude CLI is already installed.".to_string()),
        };
    }

    let version = claude_code::CLAUDE_PINNED_VERSION.to_string();
    let attempted_command = format!("Install Claude Code v{version} (native binary)");
    let install_result = install_claude_version(version, on_progress).await;
    // The binary changed; drop any cached launcher spec/version so the readiness
    // probe below re-discovers the freshly installed runtime.
    claude_code::invalidate_claude_probe_cache();
    let after = probe_claude_status().await;
    // Require the install itself to succeed: a leftover managed binary from an
    // earlier install must not mask a failed download/verify as success.
    let success = install_result.is_ok() && after.installed && is_native_managed_claude(&after);

    ClaudeCliInstallResult {
        success,
        version: after.version,
        attempted_command: Some(attempted_command),
        message: Some(if success {
            "OpenReelio-managed Claude CLI installation completed.".to_string()
        } else {
            match install_result {
                Ok(()) => {
                    "OpenReelio-managed Claude CLI installation did not complete.".to_string()
                }
                Err(error) => error,
            }
        }),
    }
}

/// Updates the managed Claude CLI to the app-pinned KNOWN-GOOD version.
///
/// The distribution model pins one version per release, so update installs
/// exactly [`claude_code::CLAUDE_PINNED_VERSION`] rather than the release
/// channel's latest. This keeps the version the update UI shows/compares against
/// and the version actually installed in agreement (installing a newer "latest"
/// would mislabel the result and could leave the update button permanently
/// offering an update the app never pins to).
#[cfg(feature = "gui")]
pub async fn update_claude_cli<F>(on_progress: F) -> ClaudeCliUpdateResult
where
    F: Fn(crate::core::managed_runtime::InstallProgress) + Send + 'static,
{
    let before = probe_claude_status().await;

    let version = claude_code::CLAUDE_PINNED_VERSION.to_string();
    let attempted_command = format!("Update Claude Code to pinned v{version} (native binary)");
    let install_result = install_claude_version(version, on_progress).await;
    // The binary changed; drop any cached launcher spec/version before re-probing.
    claude_code::invalidate_claude_probe_cache();
    let after = probe_claude_status().await;
    // Require the install itself to succeed: the pre-update managed binary
    // still probing as "managed" must not mask a failed update as success.
    let success = install_result.is_ok() && after.installed && is_native_managed_claude(&after);

    ClaudeCliUpdateResult {
        success,
        before_version: before.version,
        after_version: after.version,
        attempted_command: Some(attempted_command),
        message: Some(if success {
            "OpenReelio-managed Claude CLI update completed.".to_string()
        } else {
            match install_result {
                Ok(()) => "OpenReelio-managed Claude CLI update did not complete.".to_string(),
                Err(error) => error,
            }
        }),
    }
}

/// Resolves + downloads + installs a specific Claude version on a blocking thread.
#[cfg(feature = "gui")]
async fn install_claude_version<F>(version: String, on_progress: F) -> Result<(), String>
where
    F: Fn(crate::core::managed_runtime::InstallProgress) + Send + 'static,
{
    tokio::task::spawn_blocking(move || {
        let descriptor = claude_code::claude_managed_descriptor();
        let artifact = claude_code::resolve_claude_artifact_blocking(&version)?;
        crate::core::managed_runtime::install_version(&descriptor, &version, &artifact, on_progress)
            .map(|_| ())
    })
    .await
    .map_err(|error| format!("Claude install task failed: {error}"))?
}

/// Runs a one-shot Claude CLI command against the managed profile with stdin
/// disabled. Returns the combined stdout/stderr on success.
pub async fn run_claude_command(
    args: &[&str],
    timeout_duration: Duration,
) -> Result<String, String> {
    let mut command = create_claude_command()?;
    command.args(args).stdin(std::process::Stdio::null());

    let output = timeout(timeout_duration, command.output())
        .await
        .map_err(|_| "Claude command timed out.".to_string())?
        .map_err(|error| format_claude_io_error("Failed to run Claude command", &error))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let combined = stdout
        .lines()
        .chain(stderr.lines())
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n");

    if output.status.success() {
        Ok(combined)
    } else if combined.is_empty() {
        Err(format!(
            "Claude command failed with status {}",
            output.status
        ))
    } else {
        Err(combined)
    }
}

/// Outcome of a live token-authentication check.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClaudeAuthProbe {
    /// The token authenticated successfully.
    Authenticated,
    /// The token was explicitly rejected (401 / invalid / expired).
    Rejected,
    /// The check could not complete (network/timeout) — do NOT treat as a
    /// rejection, so a transient failure never blocks an otherwise-valid login.
    Inconclusive,
}

/// Classifies the combined output of a headless `claude -p` auth ping.
///
/// Auth failures surface before inference as a `result` with
/// `api_error_status: 401` / "Invalid bearer token" / "Not logged in"; a valid
/// token proceeds to a normal (non-error) result.
pub(crate) fn classify_auth_probe_output(combined: &str) -> ClaudeAuthProbe {
    let lower = combined.to_ascii_lowercase();
    let rejected = lower.contains("invalid bearer token")
        || lower.contains("\"api_error_status\":401")
        || lower.contains("not logged in")
        || lower.contains("please run /login")
        || lower.contains("authentication_error")
        || lower.contains("failed to authenticate");
    if rejected {
        return ClaudeAuthProbe::Rejected;
    }
    if lower.contains("\"is_error\":false") {
        return ClaudeAuthProbe::Authenticated;
    }
    ClaudeAuthProbe::Inconclusive
}

/// Verifies the currently-stored managed credentials actually authenticate, by
/// running a minimal headless `claude -p` ping.
///
/// Uses a synchronous `std::process` child with a hard, poll-based deadline —
/// deliberately NOT `tokio`/`block_on`, because the sole caller is the login
/// reader (a plain OS thread) and nesting an async runtime there risks a hang.
/// Any spawn/timeout/parse problem returns `Inconclusive` so a transient issue
/// never blocks an otherwise-valid sign-in.
#[cfg(feature = "gui")]
pub fn verify_claude_auth_blocking() -> ClaudeAuthProbe {
    use std::io::Read;
    use std::process::{Command, Stdio};
    use std::time::Instant;

    let Some(executable) = resolve_native_claude_executable() else {
        return ClaudeAuthProbe::Inconclusive;
    };

    let mut command = Command::new(executable);
    crate::core::process::configure_std_command(&mut command);
    command
        .args([
            "-p",
            "--output-format",
            "json",
            "--tools",
            "",
            "--setting-sources",
            "user",
            "hi",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command.env(CLAUDE_CONFIG_DIR_ENV_VAR, managed_claude_config_dir());
    // Inject exactly the credential the managed profile should use, mirroring
    // the headless spawn: stored OAuth token, else stored API key, else none.
    command.env_remove("ANTHROPIC_API_KEY");
    command.env_remove(CLAUDE_CODE_OAUTH_TOKEN_ENV_VAR);
    if let Some(token) = stored_claude_oauth_token() {
        command.env(CLAUDE_CODE_OAUTH_TOKEN_ENV_VAR, token);
    } else if let Some(key) = stored_anthropic_api_key() {
        command.env("ANTHROPIC_API_KEY", key);
    }

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(_) => return ClaudeAuthProbe::Inconclusive,
    };

    let deadline = Instant::now() + Duration::from_secs(45);
    loop {
        match child.try_wait() {
            Ok(Some(_status)) => break,
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return ClaudeAuthProbe::Inconclusive;
                }
                std::thread::sleep(Duration::from_millis(150));
            }
            Err(_) => return ClaudeAuthProbe::Inconclusive,
        }
    }

    // The child has exited; drain the (small, <1 KB) JSON result.
    let mut combined = String::new();
    if let Some(mut stdout) = child.stdout.take() {
        let _ = stdout.read_to_string(&mut combined);
    }
    if let Some(mut stderr) = child.stderr.take() {
        let _ = stderr.read_to_string(&mut combined);
    }
    classify_auth_probe_output(&combined)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_invalid_bearer_token_as_rejected() {
        let out = r#"{"type":"result","is_error":true,"api_error_status":401,"result":"Failed to authenticate. API Error: 401 Invalid bearer token"}"#;
        assert_eq!(classify_auth_probe_output(out), ClaudeAuthProbe::Rejected);
    }

    #[test]
    fn classifies_not_logged_in_as_rejected() {
        let out = r#"{"is_error":true,"result":"Not logged in · Please run /login"}"#;
        assert_eq!(classify_auth_probe_output(out), ClaudeAuthProbe::Rejected);
    }

    #[test]
    fn classifies_successful_result_as_authenticated() {
        let out = r#"{"type":"result","subtype":"success","is_error":false,"result":"hi"}"#;
        assert_eq!(
            classify_auth_probe_output(out),
            ClaudeAuthProbe::Authenticated
        );
    }

    #[test]
    fn classifies_unrecognized_output_as_inconclusive() {
        assert_eq!(
            classify_auth_probe_output("connection reset by peer"),
            ClaudeAuthProbe::Inconclusive
        );
    }

    #[test]
    fn treats_signed_in_and_api_key_as_authenticated() {
        assert!(is_claude_authenticated("signed-in"));
        assert!(is_claude_authenticated("api-key"));
        assert!(!is_claude_authenticated("signed-out"));
        assert!(!is_claude_authenticated("error"));
    }

    #[test]
    fn rejects_unsupported_login_mode() {
        let result = tokio::runtime::Runtime::new()
            .expect("runtime")
            .block_on(start_claude_login(StartClaudeLoginInput {
                mode: "carrier-pigeon".to_string(),
                api_key: None,
            }));
        assert!(!result.success);
        assert!(result
            .message
            .unwrap_or_default()
            .contains("Unsupported Claude login mode"));
    }
}
