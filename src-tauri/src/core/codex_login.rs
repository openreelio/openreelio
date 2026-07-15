//! Streamed, visible Codex CLI sign-in.
//!
//! Unlike Claude Code's `setup-token` (an Ink/TUI program that needs a
//! pseudo-terminal), `codex login` is pipe-friendly: it prints its progress to
//! stdout as plain text, opens the browser itself, and — because it uses a
//! LOOPBACK callback (`http://localhost:PORT/auth/callback`) — auto-completes
//! after the user approves in the browser, then writes the credentials into
//! `CODEX_HOME` and exits. There is no authorization code to paste.
//!
//! This module owns the Tauri-free-ish pieces of that flow (it is GUI-gated
//! because it depends on `tauri` and the `open` browser launcher):
//! - the [`CodexLoginEvent`] stream forwarded to the WebView,
//! - the [`parse_codex_login_url`] extractor that recovers the OAuth URL from the
//!   CLI's stdout so we can open it OURSELVES with the FULL URL (belt-and-
//!   suspenders: it still works even if the CLI's own browser launch fails), and
//! - the [`CodexLoginSessionHandle`] plus the spawn/reader plumbing.
//!
//! Completion is detected by the process exiting followed by a re-probe of the
//! managed profile ([`crate::core::codex::probe_codex_status`]): if the re-probe
//! reports an authenticated profile the flow emits `success`, otherwise `error`.
//!
//! The IPC command layer in [`crate::ipc::commands::external_agent`] builds the
//! managed-`CODEX_HOME` command, stores the handle in `AppState`, and wires the
//! finalize callback that drops the session from the map.

use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, ChildStderr, ChildStdout, Command};
use tokio::sync::Mutex;

/// Event-name prefix for Codex in-app login stream events.
pub const CODEX_LOGIN_EVENT_PREFIX: &str = "codex:login";

/// Hard upper bound on a single login attempt. The loopback callback normally
/// auto-completes within seconds of the user approving in the browser; this only
/// guards against a user who never finishes (or a wedged CLI) leaving an orphaned
/// child and a spinner that never resolves.
const CODEX_LOGIN_TIMEOUT: Duration = Duration::from_secs(300);

/// Cap on the rolling tail of output lines retained for a failure message. The
/// login output is a handful of lines; this only guards a runaway process.
const MAX_COLLECTED_LINES: usize = 40;

/// Result of starting a streamed Codex login session.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CodexLoginSessionStartResult {
    /// The session id (used to target `cancel`).
    pub session_id: String,
    /// The Tauri event name that carries this session's stream events.
    pub event_name: String,
}

/// A stream event forwarded from a Codex login session to the WebView.
///
/// Credentials never travel here: the CLI writes them into `CODEX_HOME` and the
/// reader re-probes the profile, emitting only the resulting auth status.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum CodexLoginEvent {
    /// A named UI state transition (currently only `browserOpening`).
    State { state: String },
    /// The OAuth sign-in URL, shown as a fallback link in-app (and opened by us).
    Url { url: String },
    /// A raw stdout/stderr line, so the UI can show progress even if the
    /// higher-level state signals are mis-detected.
    Output { text: String },
    /// Login completed: the re-probe reports an authenticated profile.
    Success { auth_status: String },
    /// A failure was detected (timeout, read error, or exit-without-auth).
    Error { message: String },
    /// The login process ended. Emitted as a lifecycle marker after a terminal
    /// `error`; the UI treats it as "ended" only if no terminal event preceded it.
    Exit,
}

/// Builds the Tauri event name that carries a login session's stream events.
pub fn codex_login_event_name(session_id: &str) -> String {
    format!("{CODEX_LOGIN_EVENT_PREFIX}:{session_id}")
}

/// Returns whether a Codex auth-status string means "signed in".
///
/// Mirrors the private classifier in [`crate::core::external_agent`]; duplicated
/// (rather than exported) to keep this module's dependency surface small.
fn is_codex_authenticated(auth_status: &str) -> bool {
    matches!(auth_status, "signed-in" | "api-key")
}

/// Extracts the OAuth sign-in URL from a chunk of `codex login` output.
///
/// The CLI prints, in order, a `http://localhost:PORT` server line and then the
/// full `https://auth.openai.com/oauth/authorize?...` URL on its own line. This
/// matches only `https://` URLs (so the loopback `http://localhost` line is
/// ignored) and, when several are present, prefers one whose query names an
/// `authorize` endpoint. The URL is returned intact — the CLI does not wrap or
/// truncate it under piped stdio — so we can open the FULL URL ourselves.
pub fn parse_codex_login_url(text: &str) -> Option<String> {
    let mut first: Option<String> = None;
    // Scan for each `https://` occurrence and take up to the first whitespace or
    // quote. A tiny hand-rolled scan avoids a regex dependency in the hot path.
    let bytes = text.as_bytes();
    let mut search_from = 0;
    while let Some(rel) = text[search_from..].find("https://") {
        let start = search_from + rel;
        let mut end = start;
        while end < bytes.len() {
            let ch = bytes[end];
            if ch.is_ascii_whitespace() || ch == b'"' || ch == b'\'' || ch == b'<' || ch == b'>' {
                break;
            }
            end += 1;
        }
        let url = text[start..end]
            .trim_end_matches(['.', ',', ')', ']', '}'])
            .to_string();
        if !url.is_empty() {
            if url.contains("authorize") {
                return Some(url);
            }
            if first.is_none() {
                first = Some(url);
            }
        }
        search_from = end.max(start + 1);
    }
    first
}

/// Owns the child process for a streamed login session so it can be reaped on
/// normal exit and killed on cancel / timeout / app shutdown.
pub struct CodexLoginSessionHandle {
    child: Mutex<Option<Child>>,
}

impl CodexLoginSessionHandle {
    fn new(child: Child) -> Self {
        Self {
            child: Mutex::new(Some(child)),
        }
    }

    /// Reaps the child after it has closed its output (normal exit). Does NOT
    /// kill: the CLI has already written credentials and is exiting on its own,
    /// so we wait for it to finish rather than risk truncating that write.
    async fn wait_for_exit(&self) {
        let mut guard = self.child.lock().await;
        if let Some(child) = guard.as_mut() {
            let _ = child.wait().await;
        }
        guard.take();
    }

    /// Kills the child (if still running) and reaps it. Used by cancel, the
    /// hard-timeout guard, and app-shutdown cleanup.
    pub async fn terminate(&self) -> Result<(), String> {
        let mut guard = self.child.lock().await;
        let Some(child) = guard.as_mut() else {
            return Ok(());
        };
        let still_running = child
            .try_wait()
            .map_err(|error| format!("Failed to inspect Codex login process: {error}"))?
            .is_none();
        if still_running {
            child
                .kill()
                .await
                .map_err(|error| format!("Failed to stop Codex login process: {error}"))?;
        }
        let _ = child.wait().await;
        guard.take();
        Ok(())
    }
}

/// Spawns `command` (an already-configured managed-`CODEX_HOME` `codex login`
/// command) with piped stdout/stderr and a null stdin, returning the session
/// handle plus the output streams for the reader.
///
/// The caller registers the handle in `AppState` before starting the reader so a
/// fast-failing process cannot race the handle into the session map.
#[allow(clippy::type_complexity)]
pub fn spawn_codex_login_process(
    mut command: Command,
) -> Result<
    (
        Arc<CodexLoginSessionHandle>,
        ChildStdout,
        Option<ChildStderr>,
    ),
    String,
> {
    command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    let mut child = command.spawn().map_err(|error| {
        crate::core::codex::format_codex_io_error("Failed to start Codex sign-in", &error)
    })?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to open Codex login stdout".to_string())?;
    let stderr = child.stderr.take();

    let handle = Arc::new(CodexLoginSessionHandle::new(child));
    Ok((handle, stdout, stderr))
}

/// Spawns the async reader task that drives the login stream.
///
/// The task forwards each output line as [`CodexLoginEvent::Output`], parses and
/// OPENS the sign-in URL (emitting `url` + `browserOpening`), and — when the
/// process closes its stdout — reaps the child, re-probes the managed profile,
/// and emits `success` or `error`. A hard [`CODEX_LOGIN_TIMEOUT`] kills a wedged
/// child. `on_finished` runs exactly once when the task ends (used by the IPC
/// layer to drop the session from `AppState`); it is async because the removal
/// awaits the session map's lock.
pub fn start_codex_login_reader<F, Fut>(
    app: AppHandle,
    event_name: String,
    handle: Arc<CodexLoginSessionHandle>,
    stdout: ChildStdout,
    stderr: Option<ChildStderr>,
    on_finished: F,
) where
    F: FnOnce() -> Fut + Send + 'static,
    Fut: Future<Output = ()> + Send + 'static,
{
    // Best-effort stderr forwarding: surface any diagnostic lines as Output so
    // the user sees progress, but drive completion solely from stdout + exit.
    if let Some(stderr) = stderr {
        let app_err = app.clone();
        let event_err = event_name.clone();
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if !line.trim().is_empty() {
                    emit(&app_err, &event_err, CodexLoginEvent::Output { text: line });
                }
            }
        });
    }

    tauri::async_runtime::spawn(async move {
        // Drive the stream to a terminal event, THEN finalize exactly once. The
        // finalizer runs on this tokio task, so it must be awaited (not
        // block_on'd, which would panic inside the runtime).
        drive_codex_login_stream(&app, &event_name, &handle, stdout).await;
        on_finished().await;
    });
}

/// Reads stdout to a terminal event: opens the sign-in URL, then on stdout close
/// reaps the child, re-probes, and emits `success` or `error` (+ `exit`). A hard
/// timeout kills a wedged child and emits `error`.
async fn drive_codex_login_stream(
    app: &AppHandle,
    event_name: &str,
    handle: &Arc<CodexLoginSessionHandle>,
    stdout: ChildStdout,
) {
    let mut lines = BufReader::new(stdout).lines();
    let timeout = tokio::time::sleep(CODEX_LOGIN_TIMEOUT);
    tokio::pin!(timeout);

    let mut saw_url = false;
    let mut collected: Vec<String> = Vec::new();
    let mut read_error: Option<String> = None;

    loop {
        tokio::select! {
            line = lines.next_line() => {
                match line {
                    Ok(Some(line)) => {
                        if !line.trim().is_empty() {
                            if collected.len() >= MAX_COLLECTED_LINES {
                                collected.remove(0);
                            }
                            collected.push(line.clone());
                            emit(app, event_name, CodexLoginEvent::Output { text: line.clone() });
                        }
                        if !saw_url {
                            if let Some(url) = parse_codex_login_url(&line) {
                                saw_url = true;
                                // Do NOT open the browser ourselves: unlike Claude,
                                // Codex opens the FULL URL correctly via ShellExecuteW
                                // (no `&` truncation — verified), so a second open here
                                // would just spawn a duplicate tab. The in-app fallback
                                // link (this event) covers the rare case its open fails.
                                emit(app, event_name, CodexLoginEvent::Url { url });
                                emit(
                                    app,
                                    event_name,
                                    CodexLoginEvent::State { state: "browserOpening".to_string() },
                                );
                            }
                        }
                    }
                    Ok(None) => break, // stdout closed: the process is exiting.
                    Err(error) => {
                        read_error = Some(format!("Failed to read Codex sign-in output: {error}"));
                        break;
                    }
                }
            }
            _ = &mut timeout => {
                let _ = handle.terminate().await;
                emit(
                    app,
                    event_name,
                    CodexLoginEvent::Error {
                        message: "Codex sign-in timed out before it completed. Please try again."
                            .to_string(),
                    },
                );
                return;
            }
        }
    }

    // The stream closed. Reap the child (it is exiting on its own), then decide
    // the outcome from a fresh re-probe of the managed profile.
    handle.wait_for_exit().await;

    if let Some(message) = read_error {
        emit(app, event_name, CodexLoginEvent::Error { message });
        emit(app, event_name, CodexLoginEvent::Exit);
        return;
    }

    let after = crate::core::codex::probe_codex_status().await;
    if is_codex_authenticated(&after.auth_status) {
        emit(
            app,
            event_name,
            CodexLoginEvent::Success {
                auth_status: after.auth_status,
            },
        );
    } else {
        let message = after
            .reason
            .filter(|reason| !reason.trim().is_empty())
            .or_else(|| collected.last().cloned())
            .unwrap_or_else(|| "Codex sign-in did not complete. Please try again.".to_string());
        emit(app, event_name, CodexLoginEvent::Error { message });
        emit(app, event_name, CodexLoginEvent::Exit);
    }
}

fn emit(app: &AppHandle, event_name: &str, event: CodexLoginEvent) {
    if let Err(error) = app.emit(event_name, event) {
        tracing::warn!(event = %event_name, "Failed to emit Codex login event: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // The real stdout captured from `codex login` (managed native codex.exe
    // 0.144.4) on this machine, before OAuth completed. The loopback server line
    // (http://localhost) precedes the full https authorize URL.
    const LOGIN_STDOUT: &str = "\
Starting local login server on http://localhost:1455.
If your browser did not open, navigate to this URL to authenticate:
https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_EMoamEEZ73f0CkXaXp7hrann&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&scope=openid+profile+email+offline_access&code_challenge=abc123DEF456&code_challenge_method=S256&id_token_add_organizations=true&state=b4d9e1f2a3c4&originator=codex_cli_rs";

    #[test]
    fn builds_namespaced_event_name() {
        assert_eq!(codex_login_event_name("abc"), "codex:login:abc");
    }

    #[test]
    fn extracts_full_auth_url_from_real_login_stdout() {
        let url = parse_codex_login_url(LOGIN_STDOUT).expect("a sign-in URL");
        // The full authorize URL is recovered, untruncated (all query params).
        assert!(
            url.starts_with("https://auth.openai.com/oauth/authorize?"),
            "unexpected URL: {url}"
        );
        assert!(url.contains("client_id=app_EMoamEEZ73f0CkXaXp7hrann"));
        assert!(url.contains("redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback"));
        assert!(url.contains("state=b4d9e1f2a3c4"));
        // The trailing param survives (proves we did not stop at the first `&`).
        assert!(url.ends_with("originator=codex_cli_rs"), "truncated: {url}");
        // The loopback server line is http:// and must NOT be picked.
        assert!(!url.contains("localhost:1455."));
    }

    #[test]
    fn prefers_authorize_url_over_a_plain_https_url() {
        let text = "see https://example.com/docs then \
                    https://auth.openai.com/oauth/authorize?state=z";
        assert_eq!(
            parse_codex_login_url(text).as_deref(),
            Some("https://auth.openai.com/oauth/authorize?state=z")
        );
    }

    #[test]
    fn ignores_http_localhost_and_returns_none_without_https() {
        assert_eq!(
            parse_codex_login_url("Starting local login server on http://localhost:1455."),
            None
        );
    }

    #[test]
    fn trims_trailing_punctuation_from_a_url() {
        assert_eq!(
            parse_codex_login_url("Open (https://auth.openai.com/authorize?x=1)."),
            Some("https://auth.openai.com/authorize?x=1".to_string())
        );
    }

    #[test]
    fn classifies_codex_auth_status() {
        assert!(is_codex_authenticated("signed-in"));
        assert!(is_codex_authenticated("api-key"));
        assert!(!is_codex_authenticated("signed-out"));
        assert!(!is_codex_authenticated("unknown"));
    }
}
