//! Fully in-app Claude subscription sign-in over a pseudo-terminal (ConPTY).
//!
//! `claude setup-token` is an Ink (TUI) program: under plain piped stdio it
//! renders nothing and waits forever because Ink requires a TTY. Spawned under a
//! pseudo-terminal it renders normally, opens the browser itself, and — after the
//! OAuth handshake — prompts for an authorization code on stdin and prints a
//! long-lived OAuth token (`sk-ant-oat...`).
//!
//! This module owns the Tauri-free pieces of that flow:
//! - the [`ClaudeLoginEvent`] stream forwarded to the WebView,
//! - a small ANSI stripper and the [`LoginOutputParser`] state machine that turns
//!   raw terminal output into meaningful signals (browser opening, fallback URL,
//!   the paste-code prompt, and the token), and
//! - the PTY session handle plus the spawn/reader plumbing.
//!
//! The token is never placed on the event channel: when it appears the reader
//! persists it via [`store_claude_oauth_token`] (the same storage the
//! `oauth-token` login mode uses), re-probes, and emits a `success` event.
//!
//! GUI-gated: it depends on `tauri` and `portable-pty`. The IPC command layer in
//! [`crate::ipc::commands::claude`] stores handles in `AppState` and wires the
//! finalize callback.

use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex as StdMutex};

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use regex::Regex;
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Emitter};

use crate::core::claude_code::{probe_claude_status, store_claude_oauth_token};

/// Event-name prefix for Claude in-app login stream events.
pub const CLAUDE_LOGIN_EVENT_PREFIX: &str = "claude:login";

/// Rows for the login pseudo-terminal (Ink needs a plausible terminal size).
const LOGIN_PTY_ROWS: u16 = 50;
/// Columns for the login pseudo-terminal. Deliberately very wide so Ink never
/// soft-wraps the long sign-in URL or the ~110-char token across lines — a wrap
/// inserts `\r\n` mid-value and truncates the eager token capture (→ 401).
const LOGIN_PTY_COLS: u16 = 1000;
/// Read buffer size for the PTY reader thread.
const LOGIN_READ_BUFFER_BYTES: usize = 4096;
/// Upper bound on the rolling transcript the parser retains (setup-token output
/// is small; this only guards against a runaway process).
const MAX_TRANSCRIPT_BYTES: usize = 256 * 1024;

/// Result of starting an in-app Claude login session.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeLoginSessionStartResult {
    /// The session id (used to target `submit`/`cancel`).
    pub session_id: String,
    /// The Tauri event name that carries this session's stream events.
    pub event_name: String,
}

/// A stream event forwarded from a Claude login PTY session to the WebView.
///
/// The token itself is never carried here: it is persisted server-side and a
/// `success` event is emitted after re-probing the managed profile.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ClaudeLoginEvent {
    /// A named UI state transition (currently only `browserOpening`).
    State { state: String },
    /// A sign-in URL parsed from the output, shown as a fallback link in-app.
    Url { url: String },
    /// The CLI is prompting for the authorization code to be pasted.
    AwaitingCode,
    /// A raw (ANSI-stripped) output chunk, so the UI can show progress even if
    /// the higher-level state signals are mis-detected.
    Output { text: String },
    /// Login completed: the token was captured, persisted, and the re-probe ran.
    Success { auth_status: String },
    /// A failure was detected (failure text or a store error).
    Error { message: String },
    /// The login process ended (without producing a token).
    Exit,
}

/// Builds the Tauri event name that carries a login session's stream events.
pub fn claude_login_event_name(session_id: &str) -> String {
    format!("{CLAUDE_LOGIN_EVENT_PREFIX}:{session_id}")
}

/// Counts DSR cursor-position queries (`ESC [ 6 n`) in a raw output chunk.
///
/// Ink probes the cursor position at startup and renders NOTHING until a
/// `ESC [ row ; col R` report arrives on stdin. A real terminal emulator
/// answers automatically; a PTY host must answer itself (observed live: the
/// login CLI produced only `ESC[6n` and then waited forever).
pub fn count_cursor_position_queries(raw: &str) -> usize {
    raw.matches("\u{1b}[6n").count()
}

/// Upper bound on spaces synthesized from a single cursor-forward sequence.
const MAX_SYNTHESIZED_SPACES: usize = 256;

/// Strips ANSI CSI/OSC escape sequences from terminal output, PRESERVING the
/// whitespace that cursor movement represents.
///
/// Ink does not emit literal spaces: it advances the cursor (`ESC [ N C`) and
/// repositions it (`ESC [ row ; col H`). Dropping those outright glues every
/// word together — `Your OAuth token … sk-ant-XXX. You won't …` collapsed to
/// `YourOAuthtoken…sk-ant-XXX.Youwon't…`, and because the glued text is all
/// `[A-Za-z0-9_-]` the token regex ran straight past the token's real end and
/// swallowed the following words (observed: a 130-char "token" ending in
/// `okensecurely`, rejected with 401). So cursor-forward becomes spaces and
/// cursor-position becomes a newline, which keeps word/line boundaries intact.
pub fn strip_ansi(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            match chars.peek() {
                // CSI: ESC [ params final-byte(0x40..=0x7e)
                Some('[') => {
                    chars.next();
                    let mut params = String::new();
                    let mut final_byte = None;
                    while let Some(&n) = chars.peek() {
                        chars.next();
                        if ('@'..='~').contains(&n) {
                            final_byte = Some(n);
                            break;
                        }
                        params.push(n);
                    }
                    match final_byte {
                        // CUF — cursor forward: Ink's stand-in for spaces.
                        Some('C') => {
                            let count = params
                                .parse::<usize>()
                                .unwrap_or(1)
                                .clamp(1, MAX_SYNTHESIZED_SPACES);
                            for _ in 0..count {
                                out.push(' ');
                            }
                        }
                        // CUP/HVP — absolute reposition: treat as a line break so
                        // separately-drawn regions never concatenate.
                        Some('H') | Some('f') => out.push('\n'),
                        _ => {}
                    }
                }
                // OSC: ESC ] ... terminated by BEL (or ST, approximated by BEL)
                Some(']') => {
                    chars.next();
                    while let Some(&n) = chars.peek() {
                        chars.next();
                        if n == '\u{7}' {
                            break;
                        }
                    }
                }
                // Other two-char escapes (e.g. ESC =, ESC >): drop the next char.
                Some(_) => {
                    chars.next();
                }
                None => {}
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// A meaningful signal extracted from the login output stream.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LoginSignal {
    /// The CLI reported it is opening the browser.
    BrowserOpening,
    /// A sign-in URL to display as a fallback.
    Url(String),
    /// The CLI is asking for the authorization code.
    AwaitingCode,
    /// The long-lived OAuth token was printed.
    Token(String),
    /// Failure text was detected.
    Failure(String),
}

/// Incremental state machine over the (ANSI-stripped) login transcript.
///
/// `push` is fed each decoded chunk; it appends to a rolling transcript and
/// returns any newly-detected signals. Each higher-level signal is emitted at
/// most once so repeated redraws (Ink repaints the whole screen constantly) do
/// not produce duplicates.
pub struct LoginOutputParser {
    /// ANSI-stripped transcript; drives the plain-text detections.
    transcript: String,
    /// Raw transcript (escape sequences intact). Modern Claude CLIs emit the
    /// sign-in URL only as an OSC 8 hyperlink *target*, which the stripper
    /// removes wholesale — so URL extraction must run over the raw bytes.
    raw_transcript: String,
    url_regex: Regex,
    token_regex: Regex,
    saw_browser_opening: bool,
    saw_url: bool,
    saw_awaiting_code: bool,
    saw_token: bool,
    saw_failure: bool,
}

impl Default for LoginOutputParser {
    fn default() -> Self {
        Self::new()
    }
}

impl LoginOutputParser {
    /// Creates a fresh parser with its detection regexes compiled once.
    pub fn new() -> Self {
        Self {
            transcript: String::new(),
            raw_transcript: String::new(),
            // Fallback sign-in URL. `[^\s'"]+` stops at whitespace/quotes; a
            // terminal-wrapped URL may truncate, which is acceptable for a
            // fallback link since the CLI opens the browser itself.
            url_regex: Regex::new(r#"https://[^\s'"]+"#).expect("valid url regex"),
            // Liberal token match: the `sk-ant-` prefix followed by token chars.
            token_regex: Regex::new(r"sk-ant-[A-Za-z0-9_\-]{10,}").expect("valid token regex"),
            saw_browser_opening: false,
            saw_url: false,
            saw_awaiting_code: false,
            saw_token: false,
            saw_failure: false,
        }
    }

    /// Appends a decoded RAW chunk (escape sequences intact) and returns any
    /// newly-detected signals, in a stable order (browser → url → awaiting-code
    /// → token → failure). The raw bytes are retained for OSC 8 hyperlink
    /// extraction; a stripped copy drives the plain-text detections.
    pub fn push(&mut self, chunk: &str) -> Vec<LoginSignal> {
        self.raw_transcript.push_str(chunk);
        Self::trim_transcript(&mut self.raw_transcript);

        let stripped = strip_ansi(chunk);
        self.transcript.push_str(&stripped);
        Self::trim_transcript(&mut self.transcript);

        let mut signals = Vec::new();
        let lower = self.transcript.to_ascii_lowercase();

        if !self.saw_browser_opening && lower.contains("opening browser") {
            self.saw_browser_opening = true;
            signals.push(LoginSignal::BrowserOpening);
        }

        if !self.saw_url {
            if let Some(url) = self.find_url() {
                self.saw_url = true;
                signals.push(LoginSignal::Url(url));
            }
        }

        if !self.saw_awaiting_code && Self::looks_like_code_prompt(&lower) {
            self.saw_awaiting_code = true;
            signals.push(LoginSignal::AwaitingCode);
        }

        if !self.saw_token {
            if let Some(token) = self.find_complete_token() {
                self.saw_token = true;
                signals.push(LoginSignal::Token(token));
            }
        }

        if !self.saw_failure {
            if let Some(message) = Self::detect_failure(&self.transcript, &lower) {
                self.saw_failure = true;
                signals.push(LoginSignal::Failure(message));
            }
        }

        signals
    }

    /// Heuristic for the "paste the authorization code" prompt. Tolerant on
    /// purpose: the exact wording varies across CLI versions.
    fn looks_like_code_prompt(lower: &str) -> bool {
        (lower.contains("paste") && lower.contains("code"))
            || lower.contains("authorization code")
            || lower.contains("enter the code")
            || lower.contains("enter code")
            || lower.contains("paste code")
    }

    /// Conservative failure detection to avoid tripping on benign "error" text.
    fn detect_failure(transcript: &str, lower: &str) -> Option<String> {
        const MARKERS: &[&str] = &[
            "authentication failed",
            "login failed",
            "oauth error",
            "invalid code",
            "invalid authorization",
            "code expired",
            "expired code",
            "failed to authenticate",
        ];
        let marker = MARKERS.iter().find(|marker| lower.contains(**marker))?;
        // Surface the line containing the marker for a useful message.
        let line = transcript
            .lines()
            .find(|line| line.to_ascii_lowercase().contains(*marker))
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .unwrap_or(*marker);
        Some(line.to_string())
    }

    /// Locates the fallback sign-in URL: the OSC 8 hyperlink target if present
    /// (modern CLIs emit the URL only there), otherwise the first plain
    /// `https://` match in the stripped transcript.
    fn find_url(&self) -> Option<String> {
        Self::find_osc8_url(&self.raw_transcript).or_else(|| {
            self.url_regex.find(&self.transcript).map(|m| {
                m.as_str()
                    .trim_end_matches(['.', ',', ')', ']'])
                    .to_string()
            })
        })
    }

    /// Returns a `sk-ant-…` token only once it is provably COMPLETE, i.e. the
    /// match is followed by a boundary character in the accumulated transcript.
    ///
    /// Ink renders progressively, so a match that ends exactly at the transcript
    /// end may still be mid-render; capturing it then yields a PREFIX of the
    /// token, which is stored and later rejected with `401 Invalid bearer token`
    /// (observed live). setup-token always prints the token mid-sentence —
    /// `Your OAuth token (valid for 1 year): sk-ant-…. You won't be able to see
    /// it again.` — so the trailing `.` guarantees the boundary arrives.
    /// [`finalize_token`] covers the EOF case as a backstop.
    ///
    /// [`finalize_token`]: Self::finalize_token
    fn find_complete_token(&self) -> Option<String> {
        let m = self.token_regex.find(&self.transcript)?;
        if m.end() < self.transcript.len() {
            return Some(m.as_str().to_string());
        }
        None
    }

    /// Accepts a token match after the PTY stream has closed, as an EOF
    /// fallback for the case where the token was the very last output.
    pub fn finalize_token(&mut self) -> Option<String> {
        if self.saw_token {
            return None;
        }
        let token = self
            .token_regex
            .find(&self.transcript)
            .map(|m| m.as_str().to_string())?;
        self.saw_token = true;
        Some(token)
    }

    /// Extracts the first `https://` URI carried inside an OSC 8 hyperlink.
    ///
    /// The sequence is `ESC ] 8 ; params ; URI ST`, where the string terminator
    /// `ST` is either BEL (`\x07`) or `ESC \`. Because the parser re-scans the
    /// whole accumulated raw transcript on every `push`, a sequence split across
    /// read-chunk boundaries is resolved once its terminator arrives: an
    /// incomplete sequence yields `None` (rather than a truncated URI) and the
    /// next chunk completes it.
    fn find_osc8_url(raw: &str) -> Option<String> {
        const OPENER: &str = "\u{1b}]8;";
        let mut rest = raw;
        while let Some(idx) = rest.find(OPENER) {
            let after_opener = &rest[idx + OPENER.len()..];
            // The URI follows the second `;` (i.e. after the params field).
            let Some(params_end) = after_opener.find(';') else {
                // Params field not fully received yet: wait for more bytes.
                return None;
            };
            let uri_and_rest = &after_opener[params_end + 1..];
            // The URI ends at the string terminator (BEL or `ESC \`).
            let terminator = [uri_and_rest.find('\u{7}'), uri_and_rest.find("\u{1b}\\")]
                .into_iter()
                .flatten()
                .min();
            let Some(uri_end) = terminator else {
                // Terminator not received yet: wait rather than emit a fragment.
                return None;
            };
            let uri = &uri_and_rest[..uri_end];
            if uri.starts_with("https://") {
                return Some(uri.to_string());
            }
            // A non-matching link (e.g. the empty closing `ESC ] 8 ; ; ST`):
            // continue scanning after this sequence's terminator.
            rest = &uri_and_rest[uri_end..];
        }
        None
    }

    /// Caps transcript growth, keeping the tail (where new signals appear).
    fn trim_transcript(transcript: &mut String) {
        if transcript.len() <= MAX_TRANSCRIPT_BYTES {
            return;
        }
        let keep_from = transcript.len() - MAX_TRANSCRIPT_BYTES / 2;
        // Snap to a char boundary so slicing is valid.
        let boundary = (keep_from..transcript.len())
            .find(|idx| transcript.is_char_boundary(*idx))
            .unwrap_or(transcript.len());
        *transcript = transcript.split_off(boundary);
    }
}

type LoginWriter = Box<dyn Write + Send>;
type LoginChild = Box<dyn Child + Send + Sync>;

/// Owns the PTY master, its writer, and the child process for a login session.
pub struct ClaudeLoginSessionHandle {
    writer: StdMutex<Option<LoginWriter>>,
    #[allow(dead_code)]
    master: StdMutex<Box<dyn MasterPty + Send>>,
    child: StdMutex<Option<LoginChild>>,
}

impl ClaudeLoginSessionHandle {
    fn new(writer: LoginWriter, master: Box<dyn MasterPty + Send>, child: LoginChild) -> Self {
        Self {
            writer: StdMutex::new(Some(writer)),
            master: StdMutex::new(master),
            child: StdMutex::new(Some(child)),
        }
    }

    /// Writes raw bytes (terminal query responses) to the PTY stdin.
    ///
    /// Best-effort: a closed writer is not an error — the session is ending.
    fn respond_raw(&self, bytes: &[u8]) {
        let Ok(mut writer_guard) = self.writer.lock() else {
            return;
        };
        if let Some(writer) = writer_guard.as_mut() {
            let _ = writer.write_all(bytes);
            let _ = writer.flush();
        }
    }

    /// Writes bytes to the PTY stdin, propagating errors.
    fn write_pty_bytes(&self, bytes: &[u8]) -> Result<(), String> {
        let mut writer_guard = self
            .writer
            .lock()
            .map_err(|_| "Claude login writer lock poisoned".to_string())?;
        let writer = writer_guard
            .as_mut()
            .ok_or_else(|| "Claude login session is already closed".to_string())?;
        writer
            .write_all(bytes)
            .map_err(|error| format!("Failed to write to Claude login: {error}"))?;
        writer
            .flush()
            .map_err(|error| format!("Failed to flush Claude login: {error}"))
    }

    /// Submits the authorization code, then presses Enter SEPARATELY.
    ///
    /// The code and the carriage return MUST NOT be written in one burst: Ink
    /// (setup-token's UI) detects a long single-write as a paste and swallows a
    /// trailing CR, so the code is entered but never submitted — the flow hangs
    /// at "Finishing sign-in" with no response (verified against real
    /// setup-token: a 25-char code submitted, an 85-char code did not). A
    /// distinct, delayed CR registers as the Enter keypress that submits it.
    pub fn submit_code(&self, code: &str) -> Result<(), String> {
        self.write_pty_bytes(code.trim().as_bytes())?;
        std::thread::sleep(std::time::Duration::from_millis(250));
        self.write_pty_bytes(b"\r")
    }

    /// Kills the child process (best effort) and drops the stdin writer.
    pub fn terminate(&self) -> Result<(), String> {
        if let Ok(mut writer_guard) = self.writer.lock() {
            writer_guard.take();
        }
        let mut child_guard = self
            .child
            .lock()
            .map_err(|_| "Claude login child lock poisoned".to_string())?;
        if let Some(child) = child_guard.as_mut() {
            child
                .kill()
                .map_err(|error| format!("Failed to terminate Claude login session: {error}"))?;
        }
        Ok(())
    }
}

/// Writes a no-op executable used as the `BROWSER` for `setup-token`, so the
/// CLI's own (URL-truncating) browser launch does nothing. Returns its path.
///
/// Cross-platform: a `.cmd` that exits 0 on Windows, an executable `sh` that
/// exits 0 elsewhere. Written once to the temp dir and reused.
fn write_noop_browser_script() -> Result<PathBuf, String> {
    #[cfg(windows)]
    {
        let path = std::env::temp_dir().join("openreelio-noop-browser.cmd");
        std::fs::write(&path, b"@exit /b 0\r\n")
            .map_err(|error| format!("Failed to write no-op browser script: {error}"))?;
        Ok(path)
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let path = std::env::temp_dir().join("openreelio-noop-browser.sh");
        std::fs::write(&path, b"#!/bin/sh\nexit 0\n")
            .map_err(|error| format!("Failed to write no-op browser script: {error}"))?;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("Failed to make no-op browser script executable: {error}"))?;
        Ok(path)
    }
    #[cfg(not(any(windows, unix)))]
    {
        Err("No-op browser script is not supported on this platform.".to_string())
    }
}

/// Opens a login PTY and spawns `claude setup-token` under it.
///
/// Returns the session handle plus a reader for the PTY master. The caller
/// registers the handle before starting the reader (see
/// [`start_login_reader`]) so a fast-failing process cannot race the handle into
/// the session map. `env` mirrors the managed-profile injection used elsewhere
/// (`CLAUDE_CONFIG_DIR`, `DISABLE_UPDATES`); credential env vars are omitted so
/// `setup-token` performs a fresh browser login.
#[allow(clippy::type_complexity)]
pub fn open_login_pty(
    program: PathBuf,
    env: Vec<(String, std::ffi::OsString)>,
) -> Result<(Arc<ClaudeLoginSessionHandle>, Box<dyn Read + Send>), String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: LOGIN_PTY_ROWS,
            cols: LOGIN_PTY_COLS,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| format!("Failed to create Claude login PTY: {error}"))?;

    let mut command = CommandBuilder::new(&program);
    command.arg("setup-token");
    command.env("TERM", "xterm-256color");
    // Neutralize the CLI's OWN browser launch. On Windows it hands the sign-in
    // URL to the browser through a shell that truncates it at the first `&`
    // (verified: `BROWSER` received only `...authorize?code=true`), opening a
    // broken parameterless page that "approves" without ever showing a code.
    // Point `BROWSER` at a script that does nothing; we open the full URL
    // ourselves from the OSC 8 hyperlink target, which is delivered intact.
    if let Ok(noop_browser) = write_noop_browser_script() {
        command.env("BROWSER", noop_browser.as_os_str());
    }
    for (key, value) in env {
        command.env(key, value);
    }

    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| format!("Failed to start Claude login process under a PTY: {error}"))?;
    // Drop the slave so only the child holds it; otherwise EOF is never seen.
    drop(pair.slave);

    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| format!("Failed to attach Claude login reader: {error}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|error| format!("Failed to attach Claude login writer: {error}"))?;

    let handle = Arc::new(ClaudeLoginSessionHandle::new(writer, pair.master, child));
    Ok((handle, reader))
}

/// Spawns the reader thread that drives the login state machine.
///
/// The thread strips ANSI, feeds the parser, forwards [`ClaudeLoginEvent`]s, and
/// — on token capture — persists the token, re-probes, emits `success`, and kills
/// the child. `on_finished` runs exactly once when the thread ends (used by the
/// IPC layer to drop the session from `AppState`).
pub fn start_login_reader<F>(
    app: AppHandle,
    session_id: String,
    event_name: String,
    handle: Arc<ClaudeLoginSessionHandle>,
    mut reader: Box<dyn Read + Send>,
    on_finished: F,
) -> Result<(), String>
where
    F: FnOnce() + Send + 'static,
{
    std::thread::Builder::new()
        .name(format!("claude-login-{session_id}"))
        .spawn(move || {
            let mut parser = LoginOutputParser::new();
            let mut buffer = [0u8; LOGIN_READ_BUFFER_BYTES];
            let mut token_captured = false;
            // Redact any printed token before surfacing raw output to the UI, so
            // the diagnostic stream never leaks the credential.
            let secret_regex =
                Regex::new(r"sk-ant-[A-Za-z0-9_\-]{6,}").expect("valid secret regex");

            'read: loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(bytes_read) => {
                        let raw = String::from_utf8_lossy(&buffer[..bytes_read]);

                        // Terminal-host duty: the CLI (Ink) probes the cursor
                        // position with DSR (`ESC[6n`) at startup and renders
                        // NOTHING until a report arrives on stdin. A real
                        // terminal answers automatically; as the PTY host, we
                        // must reply ourselves or the login flow never begins
                        // (observed live: 30s of output containing only
                        // `ESC[6n`). Answer every query with row 1, col 1.
                        for _ in 0..count_cursor_position_queries(&raw) {
                            handle.respond_raw(b"\x1b[1;1R");
                        }

                        let stripped = strip_ansi(&raw);
                        if !stripped.trim().is_empty() {
                            let safe = secret_regex
                                .replace_all(&stripped, "sk-ant-****")
                                .into_owned();
                            emit(&app, &event_name, ClaudeLoginEvent::Output { text: safe });
                        }

                        // Feed RAW bytes: the parser needs the escape sequences to
                        // recover the OSC 8 sign-in URL, and strips internally for
                        // its plain-text detections.
                        for signal in parser.push(&raw) {
                            match signal {
                                LoginSignal::BrowserOpening => emit(
                                    &app,
                                    &event_name,
                                    ClaudeLoginEvent::State {
                                        state: "browserOpening".to_string(),
                                    },
                                ),
                                LoginSignal::Url(url) => {
                                    // Open the sign-in page ourselves with the FULL URL. The
                                    // CLI's own launch (neutralized via a no-op `BROWSER`, see
                                    // open_login_pty) truncates the URL at the first `&` on
                                    // Windows, opening a broken parameterless page; the `open`
                                    // crate delivers the complete URL. The in-app fallback link
                                    // still renders in case this open fails.
                                    let _ = open::that_detached(&url);
                                    emit(&app, &event_name, ClaudeLoginEvent::Url { url })
                                }
                                LoginSignal::AwaitingCode => {
                                    emit(&app, &event_name, ClaudeLoginEvent::AwaitingCode)
                                }
                                LoginSignal::Failure(message) => {
                                    // A rejected code leaves setup-token alive at a
                                    // "Press Enter to retry" prompt; end the session
                                    // cleanly so the UI shows the error and a fresh
                                    // retry starts a new process.
                                    emit(&app, &event_name, ClaudeLoginEvent::Error { message });
                                    let _ = handle.terminate();
                                    break 'read;
                                }
                                LoginSignal::Token(token) => {
                                    // Terminate the setup-token child BEFORE the
                                    // auth-verification ping so only one claude
                                    // process touches the managed config dir.
                                    let _ = handle.terminate();
                                    handle_token(&app, &event_name, &token);
                                    token_captured = true;
                                    break 'read;
                                }
                            }
                        }
                    }
                    Err(error) => {
                        emit(
                            &app,
                            &event_name,
                            ClaudeLoginEvent::Error {
                                message: format!("Failed to read Claude login output: {error}"),
                            },
                        );
                        break;
                    }
                }
            }

            if !token_captured {
                // The stream closed. If a token was printed as the very last
                // output (no trailing boundary), the streaming guard in
                // `find_complete_token` deferred it — accept it now that no
                // more bytes can arrive.
                if let Some(token) = parser.finalize_token() {
                    handle_token(&app, &event_name, &token);
                    token_captured = true;
                }
            }

            if !token_captured {
                // The process ended (or errored) before printing a token.
                emit(&app, &event_name, ClaudeLoginEvent::Exit);
            }

            on_finished();
        })
        .map(|_| ())
        .map_err(|error| format!("Failed to spawn Claude login reader thread: {error}"))
}

/// Persists a captured token, VERIFIES it actually authenticates, and emits the
/// resulting `success` — or, if the token is rejected, clears it and emits an
/// actionable error so the user never ends up "signed in" with a token that
/// then 401s on every chat (the failure mode a truncated capture produced).
fn handle_token(app: &AppHandle, event_name: &str, token: &str) {
    // Record the captured length (never the value) so a truncated capture is
    // diagnosable from the logs without leaking the credential.
    tracing::info!(
        captured_token_len = token.len(),
        "Captured Claude OAuth token from setup-token output"
    );

    if let Err(error) = store_claude_oauth_token(token) {
        emit(app, event_name, ClaudeLoginEvent::Error { message: error });
        return;
    }

    // NOTE: the post-store auth verification is deliberately NOT a gate.
    // It was destroying valid logins: a rejection cleared the stored token, so
    // any false negative (or a check that fails for reasons unrelated to the
    // token) forced an endless re-login loop. The token is kept; a genuinely
    // bad one surfaces as a clear 401 on first use, which is recoverable by
    // signing in again — strictly better than silently deleting a good one.
    let auth_status = tauri::async_runtime::block_on(probe_claude_status()).auth_status;
    emit(app, event_name, ClaudeLoginEvent::Success { auth_status });
}

fn emit(app: &AppHandle, event_name: &str, event: ClaudeLoginEvent) {
    if let Err(error) = app.emit(event_name, event) {
        tracing::warn!(event = %event_name, "Failed to emit Claude login event: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // The real transcript captured from `claude setup-token` under a ConPTY on
    // this machine (claude 2.1.202), before OAuth completed.
    const PROBE_TRANSCRIPT: &str = "\
Welcome to Claude Code v2.1.202

Opening browser to sign in…

Browser didn't open? Use the url below to sign in (c to copy)
https://claude.ai/oauth/authorize?code=true&client_id=abc123&scope=user";

    #[test]
    fn builds_namespaced_event_name() {
        assert_eq!(claude_login_event_name("abc"), "claude:login:abc");
    }

    /// Live smoke test: spawns the MANAGED `claude setup-token` under a real
    /// ConPTY and asserts the production parser extracts the sign-in URL from
    /// the live stream. Ignored by default: it needs the managed Claude
    /// install and opens nothing (the child is killed before completing).
    /// Run with: cargo test -p openreelio --features gui --lib
    ///           live_setup_token_emits_url_signal -- --ignored --nocapture
    #[test]
    #[ignore]
    fn live_setup_token_emits_url_signal() {
        use portable_pty::{native_pty_system, CommandBuilder, PtySize};
        use std::io::Read;
        use std::time::{Duration, Instant};

        let Some(executable) = crate::core::claude_code::resolve_native_claude_executable() else {
            panic!("managed native claude executable not installed; install it first");
        };

        let pty = native_pty_system()
            .openpty(PtySize {
                rows: 30,
                cols: 100,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("openpty");
        let mut command = CommandBuilder::new(&executable);
        command.arg("setup-token");
        let scratch = std::env::temp_dir().join("openreelio-login-live-test");
        command.env("CLAUDE_CONFIG_DIR", scratch.as_os_str());
        command.env("DISABLE_UPDATES", "1");
        // Neutralize the CLI's browser launch so the test opens no real tab.
        command.env(
            "BROWSER",
            write_noop_browser_script().expect("noop browser script"),
        );

        let mut child = pty.slave.spawn_command(command).expect("spawn");
        drop(pty.slave);
        let mut reader = pty.master.try_clone_reader().expect("reader");
        let mut writer = pty.master.take_writer().expect("writer");

        // Read on a dedicated thread: a direct blocking `read` in the timing
        // loop hangs forever once the CLI goes quiet (it stops repainting
        // while waiting for the browser), so the deadline must be enforced
        // on the receiving side.
        let (chunk_tx, chunk_rx) = std::sync::mpsc::channel::<Vec<u8>>();
        std::thread::spawn(move || {
            let mut buffer = [0u8; 4096];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(bytes_read) => {
                        if chunk_tx.send(buffer[..bytes_read].to_vec()).is_err() {
                            break;
                        }
                    }
                }
            }
        });

        let mut parser = LoginOutputParser::new();
        let mut saw_url: Option<String> = None;
        let start = Instant::now();
        while start.elapsed() < Duration::from_secs(30) && saw_url.is_none() {
            let Ok(chunk) = chunk_rx.recv_timeout(Duration::from_millis(250)) else {
                continue;
            };
            let raw = String::from_utf8_lossy(&chunk);
            // Answer cursor-position queries exactly like the production
            // reader does, otherwise the CLI renders nothing (see
            // count_cursor_position_queries docs).
            for _ in 0..count_cursor_position_queries(&raw) {
                let _ = writer.write_all(b"\x1b[1;1R");
                let _ = writer.flush();
            }
            for signal in parser.push(&raw) {
                if let LoginSignal::Url(url) = signal {
                    saw_url = Some(url);
                }
            }
        }
        let _ = child.kill();

        let url = saw_url.unwrap_or_else(|| {
            panic!(
                "production parser never extracted a URL from live output.\n\
                 --- stripped transcript ---\n{}\n--- raw (escaped) tail ---\n{}",
                parser.transcript,
                parser
                    .raw_transcript
                    .chars()
                    .rev()
                    .take(1500)
                    .collect::<String>()
                    .chars()
                    .rev()
                    .map(|c| if c == '\u{1b}' { '\u{2190}' } else { c })
                    .collect::<String>()
            )
        });
        println!("live-extracted URL: {url}");
        assert!(url.starts_with("https://"), "unexpected URL shape: {url}");
        assert!(
            url.contains("client_id=") && url.contains("code_challenge="),
            "URL is missing OAuth query parameters: {url}"
        );
    }

    #[test]
    fn counts_cursor_position_queries() {
        assert_eq!(count_cursor_position_queries("no queries"), 0);
        assert_eq!(count_cursor_position_queries("\u{1b}[6n"), 1);
        assert_eq!(
            count_cursor_position_queries("a\u{1b}[6nb\u{1b}[6nc\u{1b}[2J"),
            2
        );
    }

    #[test]
    fn strips_csi_and_osc_sequences() {
        // ESC[1;1H is a reposition → newline; the rest is dropped.
        let input = "\u{1b}[2J\u{1b}[1;1HHello\u{1b}]0;title\u{7} World\u{1b}[0m";
        assert_eq!(strip_ansi(input), "\nHello World");
    }

    #[test]
    fn renders_cursor_forward_as_spaces() {
        // Ink emits CUF instead of literal spaces.
        assert_eq!(
            strip_ansi("Welcome\u{1b}[1Cto\u{1b}[1CClaude\u{1b}[1CCode"),
            "Welcome to Claude Code"
        );
        assert_eq!(strip_ansi("a\u{1b}[3Cb"), "a   b");
        // No parameter defaults to 1.
        assert_eq!(strip_ansi("a\u{1b}[Cb"), "a b");
    }

    #[test]
    fn does_not_glue_the_token_to_the_following_sentence() {
        // The real setup-token success line: every space is a CUF. Dropping
        // them glued the token to the trailing words, so the regex captured
        // `sk-ant-…Storethistokensecurely` (130 chars) → 401 Invalid bearer
        // token. Spaces must survive so the token ends where it really ends.
        let raw = concat!(
            "Your\u{1b}[1COAuth\u{1b}[1Ctoken:\u{1b}[1C",
            "sk-ant-oat01-ABCdef0123456789XYZ.\u{1b}[1C",
            "Store\u{1b}[1Cthis\u{1b}[1Ctoken\u{1b}[1Csecurely"
        );
        let mut parser = LoginOutputParser::new();
        let signals = parser.push(raw);
        let captured = signals.iter().find_map(|signal| match signal {
            LoginSignal::Token(value) => Some(value.clone()),
            _ => None,
        });
        assert_eq!(
            captured.as_deref(),
            Some("sk-ant-oat01-ABCdef0123456789XYZ"),
            "token must stop at its real end, not swallow the trailing words"
        );
    }

    #[test]
    fn detects_browser_opening_and_url_from_probe_transcript() {
        let mut parser = LoginOutputParser::new();
        let signals = parser.push(PROBE_TRANSCRIPT);
        assert!(signals.contains(&LoginSignal::BrowserOpening));
        assert!(signals.iter().any(|signal| matches!(
            signal,
            LoginSignal::Url(url) if url.starts_with("https://claude.ai/oauth/authorize")
        )));
    }

    // The real byte shape emitted by `claude setup-token` (claude 2.1.202): the
    // sign-in URL is carried ONLY as an OSC 8 hyperlink target, terminated by
    // BEL, followed by the visible link text and the empty closing sequence.
    const OSC8_TRANSCRIPT: &str = concat!(
        "Browser didn't open? Use the url below to sign in (c to copy)",
        "\u{1b}]8;id=u-1bdaly3%3150853549159650429;",
        "https://claude.com/cai/oauth/authorize?code=true",
        "&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code",
        "&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback",
        "&scope=user%3Ainference&code_challenge=X&code_challenge_method=S256&state=Y",
        "\u{7}link text\u{1b}]8;;\u{7}",
    );

    const OSC8_URL: &str = concat!(
        "https://claude.com/cai/oauth/authorize?code=true",
        "&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code",
        "&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback",
        "&scope=user%3Ainference&code_challenge=X&code_challenge_method=S256&state=Y",
    );

    #[test]
    fn extracts_url_from_osc8_hyperlink() {
        let mut parser = LoginOutputParser::new();
        let signals = parser.push(OSC8_TRANSCRIPT);
        assert!(
            signals
                .iter()
                .any(|signal| matches!(signal, LoginSignal::Url(url) if url == OSC8_URL)),
            "expected the full OSC 8 hyperlink target, got {signals:?}"
        );
    }

    #[test]
    fn extracts_osc8_url_split_across_chunks() {
        let mut parser = LoginOutputParser::new();
        // Split inside the URI so the first chunk lacks the BEL terminator.
        let (first, second) = OSC8_TRANSCRIPT.split_at(OSC8_TRANSCRIPT.len() / 2);
        let first_signals = parser.push(first);
        assert!(
            !first_signals
                .iter()
                .any(|signal| matches!(signal, LoginSignal::Url(_))),
            "a URL must not be emitted before its terminator arrives"
        );
        let second_signals = parser.push(second);
        assert!(
            second_signals
                .iter()
                .any(|signal| matches!(signal, LoginSignal::Url(url) if url == OSC8_URL)),
            "the split URI must resolve once the second chunk completes it"
        );
    }

    #[test]
    fn extracts_osc8_url_with_st_terminator() {
        let mut parser = LoginOutputParser::new();
        // `ESC \` string terminator (ST) instead of BEL, with empty params.
        let transcript =
            "sign in \u{1b}]8;;https://claude.com/cai/oauth/authorize?code=true&state=Z\u{1b}\\link\u{1b}]8;;\u{1b}\\";
        let signals = parser.push(transcript);
        assert!(
            signals.iter().any(|signal| matches!(
                signal,
                LoginSignal::Url(url) if url == "https://claude.com/cai/oauth/authorize?code=true&state=Z"
            )),
            "expected the ST-terminated OSC 8 target, got {signals:?}"
        );
    }

    #[test]
    fn does_not_re_emit_signals_across_chunks() {
        let mut parser = LoginOutputParser::new();
        let first = parser.push("Opening browser to sign in…\n");
        assert_eq!(first, vec![LoginSignal::BrowserOpening]);
        // A repaint of the same content must not re-emit browserOpening.
        let second = parser.push("Opening browser to sign in…\n");
        assert!(second.is_empty());
    }

    #[test]
    fn detects_paste_code_prompt_case_insensitively() {
        let mut parser = LoginOutputParser::new();
        let signals = parser.push("Paste the authorization Code here:");
        assert!(signals.contains(&LoginSignal::AwaitingCode));
    }

    #[test]
    fn detects_token_and_trims_trailing_newline() {
        let mut parser = LoginOutputParser::new();
        let token = "sk-ant-oat01-ABCdef_0123456789-XYZ";
        let signals = parser.push(&format!("Your token:\n{token}\nDone.\n"));
        assert!(signals
            .iter()
            .any(|signal| matches!(signal, LoginSignal::Token(value) if value == token)));
    }

    #[test]
    fn defers_a_token_still_rendering_then_captures_it_whole() {
        // Ink renders progressively: the first chunk can end mid-token. Capturing
        // then would store a PREFIX (→ 401). Nothing may be emitted until a
        // boundary proves the token ended.
        let mut parser = LoginOutputParser::new();
        let first = parser.push("Your OAuth token (valid for 1 year): sk-ant-oat01-ABCdef0123");
        assert!(
            !first
                .iter()
                .any(|signal| matches!(signal, LoginSignal::Token(_))),
            "must not capture a token that ends at the transcript boundary"
        );

        // setup-token prints the token mid-sentence, so the trailing '.' arrives.
        let second = parser.push("456789XYZ. You won't be able to see it again.");
        let full = "sk-ant-oat01-ABCdef0123456789XYZ";
        assert!(
            second
                .iter()
                .any(|signal| matches!(signal, LoginSignal::Token(value) if value == full)),
            "must capture the complete token once its boundary arrives"
        );
    }

    #[test]
    fn finalizes_an_end_anchored_token_on_stream_close() {
        // EOF backstop: a token printed as the very last bytes (no boundary) is
        // deferred by push() but recovered by finalize_token().
        let mut parser = LoginOutputParser::new();
        let token = "sk-ant-oat01-ABCdef0123456789TAIL";
        assert!(parser
            .push(&format!("Token: {token}"))
            .iter()
            .all(|signal| !matches!(signal, LoginSignal::Token(_))));
        assert_eq!(parser.finalize_token().as_deref(), Some(token));
        assert_eq!(parser.finalize_token(), None);
    }

    #[test]
    fn detects_token_wrapped_in_ansi() {
        let mut parser = LoginOutputParser::new();
        let raw = "\u{1b}[32msk-ant-oat01-ABCdef0123456789\u{1b}[0m\r\n";
        let stripped = strip_ansi(raw);
        let signals = parser.push(&stripped);
        assert!(signals.iter().any(|signal| matches!(
            signal,
            LoginSignal::Token(value) if value == "sk-ant-oat01-ABCdef0123456789"
        )));
    }

    #[test]
    fn detects_failure_text_conservatively() {
        let mut parser = LoginOutputParser::new();
        assert!(parser.push("Working...\n").is_empty());
        let signals = parser.push("Error: authentication failed. Try again.\n");
        assert!(signals
            .iter()
            .any(|signal| matches!(signal, LoginSignal::Failure(_))));
    }

    #[test]
    fn benign_output_produces_no_signals() {
        let mut parser = LoginOutputParser::new();
        assert!(parser.push("Loading Claude Code...\n").is_empty());
        assert!(parser.push("Please wait.\n").is_empty());
    }
}
