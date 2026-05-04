//! Terminal IPC commands.
//!
//! Provides PTY-backed integrated terminal sessions for the editor UI.

use std::io::{Read, Write};
use std::path::PathBuf;
#[cfg(windows)]
use std::process::Command;
use std::sync::{Arc, Mutex as StdMutex};
use std::{collections::HashSet, fs};

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
#[cfg(windows)]
use serde_json::Value;
use specta::Type;
use tauri::{Emitter, Manager, State};

use crate::{core::terminal_command_line::parse_terminal_command_line, AppState};

const DEFAULT_TERMINAL_COLS: u16 = 120;
const DEFAULT_TERMINAL_ROWS: u16 = 32;
const MIN_TERMINAL_COLS: u16 = 20;
const MAX_TERMINAL_COLS: u16 = 400;
const MIN_TERMINAL_ROWS: u16 = 5;
const MAX_TERMINAL_ROWS: u16 = 200;
const TERMINAL_READ_BUFFER_BYTES: usize = 8192;

type TerminalWriter = Box<dyn Write + Send>;
type TerminalChild = Box<dyn portable_pty::Child + Send + Sync>;

pub struct TerminalSessionHandle {
    writer: StdMutex<Option<TerminalWriter>>,
    master: StdMutex<Box<dyn MasterPty + Send>>,
    child: StdMutex<Option<TerminalChild>>,
}

impl TerminalSessionHandle {
    fn new(
        writer: TerminalWriter,
        master: Box<dyn MasterPty + Send>,
        child: TerminalChild,
    ) -> Self {
        Self {
            writer: StdMutex::new(Some(writer)),
            master: StdMutex::new(master),
            child: StdMutex::new(Some(child)),
        }
    }

    fn write_input(&self, data: &str) -> Result<(), String> {
        let mut writer_guard = self
            .writer
            .lock()
            .map_err(|_| "Terminal writer lock poisoned".to_string())?;
        let writer = writer_guard
            .as_mut()
            .ok_or_else(|| "Terminal session is already closed".to_string())?;

        writer
            .write_all(data.as_bytes())
            .map_err(|error| format!("Failed to write terminal input: {error}"))?;
        writer
            .flush()
            .map_err(|error| format!("Failed to flush terminal input: {error}"))
    }

    fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        let master_guard = self
            .master
            .lock()
            .map_err(|_| "Terminal PTY lock poisoned".to_string())?;

        master_guard
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| format!("Failed to resize terminal session: {error}"))
    }

    fn terminate(&self) -> Result<(), String> {
        let mut child_guard = self
            .child
            .lock()
            .map_err(|_| "Terminal child lock poisoned".to_string())?;
        let Some(child) = child_guard.as_mut() else {
            return Ok(());
        };

        child
            .kill()
            .map_err(|error| format!("Failed to terminate terminal session: {error}"))
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StartTerminalSessionInput {
    pub session_id: String,
    pub cwd: Option<String>,
    pub cols: Option<u16>,
    pub rows: Option<u16>,
    #[serde(default)]
    pub profile_id: Option<String>,
    #[serde(default)]
    pub shell: Option<String>,
    #[serde(default)]
    pub shell_args: Option<Vec<String>>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSessionStartResult {
    pub session_id: String,
    pub cwd: String,
    pub shell: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminalSessionInput {
    pub session_id: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminalInputWrite {
    pub session_id: String,
    pub data: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminalResizeInput {
    pub session_id: String,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum TerminalStreamEvent {
    Data { data: String },
    Exit { exit_code: Option<i32> },
    Error { message: String },
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DetectedTerminalProfile {
    pub id: String,
    pub label: String,
    pub command_line: String,
    pub source: String,
    pub is_default: bool,
}

#[derive(Clone, Debug)]
struct ResolvedTerminalProfile {
    label: String,
    executable: String,
    args: Vec<String>,
    command_line: String,
}

fn terminal_event_name(session_id: &str) -> String {
    format!("terminal:session:{session_id}")
}

fn clamp_dimension(value: Option<u16>, fallback: u16, min: u16, max: u16) -> u16 {
    value.unwrap_or(fallback).clamp(min, max)
}

fn normalize_session_id(session_id: String) -> Result<String, String> {
    let trimmed = session_id.trim();
    if trimmed.is_empty() {
        return Err("sessionId is required".to_string());
    }
    if trimmed.len() > 128 {
        return Err("sessionId must be 128 characters or fewer".to_string());
    }
    Ok(trimmed.to_string())
}

async fn resolve_terminal_cwd(
    requested_cwd: Option<String>,
    state: &State<'_, AppState>,
) -> Result<PathBuf, String> {
    let cwd = match requested_cwd {
        Some(path) => {
            let path = PathBuf::from(path);
            if path.is_absolute() {
                path
            } else {
                let guard = state.project.lock().await;
                let project = guard
                    .as_ref()
                    .ok_or_else(|| "Relative cwd requires an open project".to_string())?;
                project.path.join(path)
            }
        }
        None => {
            let guard = state.project.lock().await;
            if let Some(project) = guard.as_ref() {
                project.path.clone()
            } else {
                std::env::current_dir()
                    .map_err(|error| format!("Failed to resolve current directory: {error}"))?
            }
        }
    };

    if !cwd.exists() {
        return Err(format!("Terminal cwd does not exist: {}", cwd.display()));
    }
    if !cwd.is_dir() {
        return Err(format!(
            "Terminal cwd is not a directory: {}",
            cwd.display()
        ));
    }

    let canonical_cwd = cwd
        .canonicalize()
        .map_err(|error| format!("Failed to canonicalize terminal cwd: {error}"))?;

    let project_path = {
        let guard = state.project.lock().await;
        guard.as_ref().map(|project| project.path.clone())
    };

    if let Some(project_path) = project_path {
        let canonical_project = project_path
            .canonicalize()
            .map_err(|error| format!("Failed to canonicalize project directory: {error}"))?;
        if !canonical_cwd.starts_with(&canonical_project) {
            return Err(format!(
                "Terminal cwd must stay inside the active project: {}",
                canonical_cwd.display()
            ));
        }
    }

    Ok(canonical_cwd)
}

fn resolve_shell(shell: Option<String>) -> String {
    let requested = shell
        .map(|value| value.trim().trim_matches('"').trim().to_string())
        .filter(|value| !value.is_empty());
    if let Some(shell) = requested {
        return shell;
    }

    if cfg!(windows) {
        "powershell.exe".to_string()
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| {
            if PathBuf::from("/bin/zsh").exists() {
                "/bin/zsh".to_string()
            } else if PathBuf::from("/bin/bash").exists() {
                "/bin/bash".to_string()
            } else {
                "/bin/sh".to_string()
            }
        })
    }
}

fn is_git_bash_shell(shell: &str) -> bool {
    let normalized = shell.replace('/', "\\").to_ascii_lowercase();
    normalized.ends_with("\\git\\bin\\bash.exe")
        || normalized.ends_with("\\git\\usr\\bin\\bash.exe")
        || normalized.ends_with("\\git-bash.exe")
}

fn shell_label(shell: &str) -> String {
    PathBuf::from(shell)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(shell)
        .to_string()
}

fn dedupe_profile_key(command_line: &str) -> String {
    command_line.trim().to_ascii_lowercase()
}

fn sanitize_profile_id(label: &str, source: &str, command_line: &str) -> String {
    let seed = format!("{source}-{label}-{command_line}");
    let sanitized: String = seed
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() {
                ch.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    sanitized.trim_matches('-').to_string()
}

fn push_profile(
    profiles: &mut Vec<DetectedTerminalProfile>,
    seen: &mut HashSet<String>,
    label: String,
    command_line: String,
    source: &str,
    default_command_line: &str,
) {
    let normalized = command_line.trim();
    if normalized.is_empty() {
        return;
    }

    let key = dedupe_profile_key(normalized);
    if !seen.insert(key) {
        return;
    }

    profiles.push(DetectedTerminalProfile {
        id: sanitize_profile_id(&label, source, normalized),
        label,
        command_line: normalized.to_string(),
        source: source.to_string(),
        is_default: dedupe_profile_key(normalized) == dedupe_profile_key(default_command_line),
    });
}

#[cfg(windows)]
fn decode_command_output(bytes: &[u8]) -> String {
    let looks_utf16 = bytes.len() >= 2
        && bytes.len() % 2 == 0
        && bytes
            .iter()
            .skip(1)
            .step_by(2)
            .filter(|byte| **byte == 0)
            .count()
            > bytes.len() / 8;

    if looks_utf16 {
        let units: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
            .collect();
        String::from_utf16_lossy(&units)
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    }
}

#[cfg(windows)]
fn command_exists(command: &str) -> bool {
    let command_path = PathBuf::from(command);
    if command_path.is_absolute() {
        return command_path.is_file();
    }

    let Some(path_var) = std::env::var_os("PATH") else {
        return false;
    };
    let path_exts: Vec<String> = std::env::var_os("PATHEXT")
        .map(|value| {
            value
                .to_string_lossy()
                .split(';')
                .map(|ext| ext.trim().trim_start_matches('.').to_ascii_lowercase())
                .filter(|ext| !ext.is_empty())
                .collect()
        })
        .unwrap_or_else(|| vec!["exe".to_string(), "cmd".to_string(), "bat".to_string()]);

    let has_extension = command_path.extension().is_some();
    for base_dir in std::env::split_paths(&path_var) {
        let candidate = base_dir.join(command);
        if has_extension {
            if candidate.is_file() {
                return true;
            }
        } else {
            for ext in &path_exts {
                if candidate.with_extension(ext).is_file() {
                    return true;
                }
            }
        }
    }

    false
}

#[cfg(windows)]
fn detect_windows_terminal_profiles(
    profiles: &mut Vec<DetectedTerminalProfile>,
    seen: &mut HashSet<String>,
    default_command_line: &str,
) {
    let local_app_data = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
    let Some(local_app_data) = local_app_data else {
        return;
    };

    let candidates = [
        local_app_data
            .join("Packages/Microsoft.WindowsTerminal_8wekyb3d8bbwe/LocalState/settings.json"),
        local_app_data.join(
            "Packages/Microsoft.WindowsTerminalPreview_8wekyb3d8bbwe/LocalState/settings.json",
        ),
        local_app_data.join("Microsoft/Windows Terminal/settings.json"),
    ];

    for path in candidates {
        let Ok(contents) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(json) = serde_json::from_str::<Value>(&contents) else {
            continue;
        };

        let Some(profile_list) = json
            .get("profiles")
            .and_then(|profiles| profiles.get("list"))
            .and_then(|list| list.as_array())
        else {
            continue;
        };

        for profile in profile_list {
            if profile.get("hidden").and_then(|value| value.as_bool()) == Some(true) {
                continue;
            }

            let Some(label) = profile.get("name").and_then(|value| value.as_str()) else {
                continue;
            };
            let Some(command_line) = profile.get("commandline").and_then(|value| value.as_str())
            else {
                continue;
            };

            push_profile(
                profiles,
                seen,
                label.to_string(),
                command_line.to_string(),
                "windows-terminal",
                default_command_line,
            );
        }
    }
}

#[cfg(windows)]
fn detect_windows_profiles(
    profiles: &mut Vec<DetectedTerminalProfile>,
    seen: &mut HashSet<String>,
    default_command_line: &str,
) {
    detect_windows_terminal_profiles(profiles, seen, default_command_line);

    for (label, command_line) in [
        ("PowerShell", "powershell.exe"),
        ("PowerShell 7", "pwsh.exe"),
        ("Command Prompt", "cmd.exe"),
        ("WSL", "wsl.exe"),
    ] {
        if command_exists(command_line) {
            push_profile(
                profiles,
                seen,
                label.to_string(),
                command_line.to_string(),
                "detected",
                default_command_line,
            );
        }
    }

    for path in [
        r#"C:\Program Files\Git\bin\bash.exe"#,
        r#"C:\Program Files (x86)\Git\bin\bash.exe"#,
    ] {
        let path_buf = PathBuf::from(path);
        if path_buf.is_file() {
            push_profile(
                profiles,
                seen,
                "Git Bash".to_string(),
                format!(r#""{}" --login -i"#, path_buf.display()),
                "detected",
                default_command_line,
            );
        }
    }

    if command_exists("wsl.exe") {
        if let Ok(output) = Command::new("wsl.exe").args(["-l", "-q"]).output() {
            let text = decode_command_output(&output.stdout);
            for distro in text.lines().map(str::trim).filter(|line| !line.is_empty()) {
                push_profile(
                    profiles,
                    seen,
                    format!("{} (WSL)", distro),
                    format!(r#"wsl.exe -d "{}""#, distro),
                    "wsl",
                    default_command_line,
                );
            }
        }
    }
}

#[cfg(not(windows))]
fn detect_windows_profiles(
    _profiles: &mut [DetectedTerminalProfile],
    _seen: &mut HashSet<String>,
    _default_command_line: &str,
) {
}

#[cfg(not(windows))]
fn detect_unix_profiles(
    profiles: &mut Vec<DetectedTerminalProfile>,
    seen: &mut HashSet<String>,
    default_command_line: &str,
) {
    if let Ok(shell) = std::env::var("SHELL") {
        let trimmed = shell.trim();
        if !trimmed.is_empty() {
            push_profile(
                profiles,
                seen,
                shell_label(trimmed),
                trimmed.to_string(),
                "default",
                default_command_line,
            );
        }
    }

    if let Ok(contents) = fs::read_to_string("/etc/shells") {
        for shell in contents.lines().map(str::trim) {
            if shell.is_empty() || shell.starts_with('#') {
                continue;
            }
            let shell_path = PathBuf::from(shell);
            if shell_path.is_file() {
                push_profile(
                    profiles,
                    seen,
                    shell_label(shell),
                    shell.to_string(),
                    "detected",
                    default_command_line,
                );
            }
        }
    }

    for shell in [
        "/bin/zsh",
        "/bin/bash",
        "/usr/bin/fish",
        "/opt/homebrew/bin/fish",
        "/usr/bin/nu",
    ] {
        let shell_path = PathBuf::from(shell);
        if shell_path.is_file() {
            push_profile(
                profiles,
                seen,
                shell_label(shell),
                shell.to_string(),
                "detected",
                default_command_line,
            );
        }
    }
}

#[cfg(windows)]
fn detect_unix_profiles(
    _profiles: &mut Vec<DetectedTerminalProfile>,
    _seen: &mut HashSet<String>,
    _default_command_line: &str,
) {
}

fn list_available_terminal_profiles() -> Vec<DetectedTerminalProfile> {
    let default_command_line = resolve_shell(None);
    let mut profiles = Vec::new();
    let mut seen = HashSet::new();

    push_profile(
        &mut profiles,
        &mut seen,
        if cfg!(windows) {
            "PowerShell".to_string()
        } else {
            shell_label(&default_command_line)
        },
        default_command_line.clone(),
        "default",
        &default_command_line,
    );

    detect_windows_profiles(&mut profiles, &mut seen, &default_command_line);
    detect_unix_profiles(&mut profiles, &mut seen, &default_command_line);

    profiles.sort_by(|left, right| {
        right.is_default.cmp(&left.is_default).then_with(|| {
            left.label
                .to_ascii_lowercase()
                .cmp(&right.label.to_ascii_lowercase())
        })
    });

    profiles
}

fn resolve_terminal_profile(
    profile_id: Option<String>,
    legacy_shell: Option<String>,
    legacy_shell_args: Option<Vec<String>>,
) -> Result<ResolvedTerminalProfile, String> {
    if legacy_shell
        .as_deref()
        .map(|shell| !shell.trim().is_empty())
        .unwrap_or(false)
        || legacy_shell_args
            .as_ref()
            .map(|args| !args.is_empty())
            .unwrap_or(false)
    {
        return Err(
            "Arbitrary terminal command lines are not accepted. Select a detected terminal profile."
                .to_string(),
        );
    }

    let profiles = list_available_terminal_profiles();
    let selected = if let Some(profile_id) = profile_id
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty())
    {
        profiles
            .iter()
            .find(|profile| profile.id == profile_id)
            .ok_or_else(|| format!("Terminal profile is not available: {profile_id}"))?
    } else {
        profiles
            .iter()
            .find(|profile| profile.is_default)
            .or_else(|| profiles.first())
            .ok_or_else(|| "No terminal profiles are available".to_string())?
    };

    let (executable, args) = parse_terminal_command_line(&selected.command_line)?;

    Ok(ResolvedTerminalProfile {
        label: selected.label.clone(),
        executable,
        args,
        command_line: selected.command_line.clone(),
    })
}

async fn get_terminal_session(
    state: &State<'_, AppState>,
    session_id: &str,
) -> Result<Arc<TerminalSessionHandle>, String> {
    let sessions = state.terminal_sessions.lock().await;
    sessions
        .get(session_id)
        .cloned()
        .ok_or_else(|| format!("Terminal session not found: {session_id}"))
}

fn emit_terminal_event(app: &tauri::AppHandle, session_id: &str, event: &TerminalStreamEvent) {
    if let Err(error) = app.emit(&terminal_event_name(session_id), event) {
        tracing::warn!(session_id = %session_id, "Failed to emit terminal event: {error}");
    }
}

fn spawn_terminal_reader(
    app: tauri::AppHandle,
    session_id: String,
    session_handle: Arc<TerminalSessionHandle>,
    mut reader: Box<dyn Read + Send>,
) -> Result<(), String> {
    std::thread::Builder::new()
        .name(format!("terminal-reader-{session_id}"))
        .spawn(move || {
            let mut buffer = [0u8; TERMINAL_READ_BUFFER_BYTES];

            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(bytes_read) => {
                        let chunk = String::from_utf8_lossy(&buffer[..bytes_read]).into_owned();
                        emit_terminal_event(
                            &app,
                            &session_id,
                            &TerminalStreamEvent::Data { data: chunk },
                        );
                    }
                    Err(error) => {
                        emit_terminal_event(
                            &app,
                            &session_id,
                            &TerminalStreamEvent::Error {
                                message: format!("Terminal read failed: {error}"),
                            },
                        );
                        break;
                    }
                }
            }

            let exit_code = match session_handle.child.lock() {
                Ok(mut child_guard) => match child_guard.take() {
                    Some(mut child) => match child.wait() {
                        Ok(status) => Some(status.exit_code() as i32),
                        Err(error) => {
                            emit_terminal_event(
                                &app,
                                &session_id,
                                &TerminalStreamEvent::Error {
                                    message: format!(
                                        "Failed to wait for terminal process: {error}"
                                    ),
                                },
                            );
                            None
                        }
                    },
                    None => None,
                },
                Err(_) => {
                    emit_terminal_event(
                        &app,
                        &session_id,
                        &TerminalStreamEvent::Error {
                            message: "Terminal child lock poisoned".to_string(),
                        },
                    );
                    None
                }
            };

            emit_terminal_event(&app, &session_id, &TerminalStreamEvent::Exit { exit_code });

            tauri::async_runtime::block_on(async {
                let state = app.state::<crate::AppState>();
                state.terminal_sessions.lock().await.remove(&session_id);
            });
        })
        .map(|_| ())
        .map_err(|error| format!("Failed to spawn terminal reader thread: {error}"))
}

pub async fn shutdown_all_terminal_sessions(state: &AppState) {
    let sessions: Vec<Arc<TerminalSessionHandle>> = {
        let mut sessions_guard = state.terminal_sessions.lock().await;
        sessions_guard.drain().map(|(_, handle)| handle).collect()
    };

    for session in sessions {
        if let Err(error) = session.terminate() {
            tracing::warn!("Failed to terminate terminal session during cleanup: {error}");
        }
    }
}

#[tauri::command]
#[specta::specta]
pub async fn list_terminal_profiles() -> Result<Vec<DetectedTerminalProfile>, String> {
    tokio::task::spawn_blocking(list_available_terminal_profiles)
        .await
        .map_err(|error| format!("Terminal profile enumeration failed: {error}"))
}

#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip(app, state), fields(session_id = %input.session_id))]
pub async fn start_terminal_session(
    app: tauri::AppHandle,
    input: StartTerminalSessionInput,
    state: State<'_, AppState>,
) -> Result<TerminalSessionStartResult, String> {
    let session_id = normalize_session_id(input.session_id)?;
    let cols = clamp_dimension(
        input.cols,
        DEFAULT_TERMINAL_COLS,
        MIN_TERMINAL_COLS,
        MAX_TERMINAL_COLS,
    );
    let rows = clamp_dimension(
        input.rows,
        DEFAULT_TERMINAL_ROWS,
        MIN_TERMINAL_ROWS,
        MAX_TERMINAL_ROWS,
    );
    let cwd = resolve_terminal_cwd(input.cwd, &state).await?;
    let profile = resolve_terminal_profile(input.profile_id, input.shell, input.shell_args)?;

    {
        let sessions = state.terminal_sessions.lock().await;
        if sessions.contains_key(&session_id) {
            return Err(format!("Terminal session already exists: {session_id}"));
        }
    }

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| format!("Failed to create terminal PTY: {error}"))?;

    let mut command = CommandBuilder::new(profile.executable.clone());
    command.cwd(cwd.clone());
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    if cfg!(windows) && is_git_bash_shell(&profile.executable) {
        command.env("CHERE_INVOKING", "1");
    }
    for arg in &profile.args {
        command.arg(arg);
    }

    let child = pair.slave.spawn_command(command).map_err(|error| {
        format!(
            "Failed to launch terminal profile '{}' ({}): {error}",
            profile.label, profile.command_line
        )
    })?;
    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| format!("Failed to attach terminal reader: {error}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|error| format!("Failed to attach terminal writer: {error}"))?;

    let session_handle = Arc::new(TerminalSessionHandle::new(writer, pair.master, child));

    {
        let mut sessions = state.terminal_sessions.lock().await;
        sessions.insert(session_id.clone(), Arc::clone(&session_handle));
    }

    if let Err(error) =
        spawn_terminal_reader(app, session_id.clone(), Arc::clone(&session_handle), reader)
    {
        state.terminal_sessions.lock().await.remove(&session_id);
        let _ = session_handle.terminate();
        return Err(error);
    }

    Ok(TerminalSessionStartResult {
        session_id,
        cwd: cwd.to_string_lossy().into_owned(),
        shell: profile.command_line,
    })
}

#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip(state), fields(session_id = %input.session_id))]
pub async fn write_terminal_input(
    input: TerminalInputWrite,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let session_id = normalize_session_id(input.session_id)?;
    let session = get_terminal_session(&state, &session_id).await?;

    tokio::task::spawn_blocking(move || session.write_input(&input.data))
        .await
        .map_err(|error| format!("Terminal input task failed: {error}"))?
}

#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip(state), fields(session_id = %input.session_id))]
pub async fn resize_terminal_session(
    input: TerminalResizeInput,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let session_id = normalize_session_id(input.session_id)?;
    let session = get_terminal_session(&state, &session_id).await?;
    let cols = clamp_dimension(
        Some(input.cols),
        DEFAULT_TERMINAL_COLS,
        MIN_TERMINAL_COLS,
        MAX_TERMINAL_COLS,
    );
    let rows = clamp_dimension(
        Some(input.rows),
        DEFAULT_TERMINAL_ROWS,
        MIN_TERMINAL_ROWS,
        MAX_TERMINAL_ROWS,
    );

    tokio::task::spawn_blocking(move || session.resize(cols, rows))
        .await
        .map_err(|error| format!("Terminal resize task failed: {error}"))?
}

#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip(state), fields(session_id = %input.session_id))]
pub async fn kill_terminal_session(
    input: TerminalSessionInput,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let session_id = normalize_session_id(input.session_id)?;
    let session = get_terminal_session(&state, &session_id).await?;

    tokio::task::spawn_blocking(move || session.terminate())
        .await
        .map_err(|error| format!("Terminal kill task failed: {error}"))?
}

#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip(state), fields(session_id = %input.session_id))]
pub async fn close_terminal_session(
    input: TerminalSessionInput,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let session_id = normalize_session_id(input.session_id)?;
    let session = get_terminal_session(&state, &session_id).await?;

    tokio::task::spawn_blocking(move || session.terminate())
        .await
        .map_err(|error| format!("Terminal close task failed: {error}"))?
}
