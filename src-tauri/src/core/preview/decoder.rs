//! Resident streaming decoder for the canvas timeline preview.
//!
//! The canvas preview used to pay a full FFmpeg process spawn, a JPEG encode, a
//! disk write, an asset-protocol read and a JPEG decode for every displayed
//! frame. This module replaces that with a small pool of long-lived FFmpeg
//! children that stream raw RGBA down a pipe, so advancing one frame during
//! playback costs a single `read_exact`.
//!
//! ## Seeking
//!
//! FFmpeg's accurate seek discards every frame whose presentation time is below
//! `-ss`, so a seek argument even slightly *ahead* of the wanted frame lands on
//! the following one. The seek argument is therefore the frame's exact
//! presentation time `frame_index / fps`, *truncated* (never rounded) to
//! nanoseconds so it can only ever be at or below that time. Measured against a
//! sequential oracle this lands on the requested frame every time, while a
//! forward-biased argument misses roughly a third of the time.
//!
//! ## Constant versus variable frame rate
//!
//! Reading the pipe forward only addresses the right picture when a frame's
//! presentation time is `index / fps`. That holds for a constant-rate source and
//! is false for a variable-rate one — a screen recording that idles at 5 fps and
//! bursts to 30 has no such mapping, and its `avg_frame_rate` is a fiction that
//! puts every requested time on the wrong frame and then *accumulates* the error
//! as the pipe advances one frame per request while the timeline advances by a
//! nominal frame duration.
//!
//! Variable-rate sources therefore do not use the resident stream at all: every
//! request is its own accurate seek to the requested time, which is exactly what
//! the per-frame extraction this module replaced always did. The fast path is
//! kept for constant-rate sources, which is the overwhelming majority of edited
//! footage.
//!
//! ## Lifecycle
//!
//! Every child is owned by exactly one [`ResidentDecoder`], whose `Drop` kills
//! it, reaps it with `wait`, and joins the stderr drain thread. The pool keeps
//! at most [`DEFAULT_MAX_RESIDENT_DECODERS`] of them and evicts the
//! least-recently-used one on overflow, which runs that `Drop`. A read that
//! hangs is bounded by [`READ_TIMEOUT`]: a watchdog kills the child, which
//! closes the pipe and unblocks the read rather than leaking the thread.

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStderr, ChildStdout, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use crate::core::ffmpeg::rotation::rotation_from_probe_stream;
use crate::core::ffmpeg::{display_dimensions, FFmpegError, FFmpegResult};
use crate::core::process::configure_std_command;

/// Bytes per pixel in the `rgba` raw frames the decoder streams.
const BYTES_PER_PIXEL: usize = 4;

/// How many decoders may stay resident before the least-recently-used one is
/// evicted. Each one is a live FFmpeg process, so this is the ceiling on how
/// much the preview costs while idle.
pub const DEFAULT_MAX_RESIDENT_DECODERS: usize = 4;

/// How far ahead of the pipe cursor a request may be before the decoder is
/// respawned instead of read forward.
///
/// Reading forward costs one decode per skipped frame (~3 ms at 1080p) while a
/// respawn costs a process spawn plus an accurate seek (~78 ms measured), so
/// skipping stays cheaper well past this bound. It is kept deliberately short
/// so a scrub that jumps a second does not sit decoding frames nobody sees.
const MAX_FORWARD_SKIP_FRAMES: u64 = 12;

/// Upper bound on reading the next frame off an already-running pipe.
///
/// A decode that has not produced its frame by now is wedged; killing the child
/// closes the pipe, which is what unblocks the read.
const READ_TIMEOUT: Duration = Duration::from_secs(10);

/// Upper bound on the first read after a respawn.
///
/// That read waits for process start, an accurate seek, and a decode from the
/// preceding keyframe, which on 4K long-GOP footage over slow storage can take
/// far longer than a steady-state read. Sharing the steady-state budget would
/// let the watchdog kill a perfectly healthy child and leave the decoder
/// respawning into the same timeout forever.
const FIRST_READ_TIMEOUT: Duration = Duration::from_secs(60);

/// Upper bound on the FFprobe call that resolves a source's frame rate.
const PROBE_TIMEOUT: Duration = Duration::from_secs(30);

/// How much of a child's stderr is kept for error reporting.
const MAX_STDERR_TAIL_BYTES: usize = 4096;

/// How long a child that has closed its output is given to finish exiting.
///
/// Only used to distinguish a clean end of stream from a failed decode, so a
/// child still running when this elapses simply counts as the latter.
const CLEAN_EXIT_GRACE: Duration = Duration::from_millis(500);

/// Largest frame the decoder will allocate for, as a guard against a bad
/// request turning into a multi-gigabyte allocation.
const MAX_FRAME_PIXELS: u64 = 8192 * 8192;

/// Highest frame rate accepted from a probe. Anything above this is a container
/// artefact (some remuxers advertise 1000/1) rather than a real picture rate.
const MAX_PLAUSIBLE_FPS: f64 = 1000.0;

/// A decoded preview frame in straight `rgba`.
#[derive(Debug, Clone, PartialEq)]
pub struct PreviewFrame {
    /// Width of `pixels`, after aspect-preserving downscale and rotation.
    pub width: u32,
    /// Height of `pixels`, after aspect-preserving downscale and rotation.
    pub height: u32,
    /// Index of this frame in the source's frame sequence.
    ///
    /// `None` for a variable-rate source, where a frame's presentation time is
    /// not `index / fps` and an index would be a number the caller could only
    /// misuse.
    pub frame_index: Option<u64>,
    /// Presentation time this frame answers for, in seconds.
    pub source_time: f64,
    /// `width * height * 4` bytes of straight-alpha RGBA.
    pub pixels: Vec<u8>,
}

impl PreviewFrame {
    /// Size of the header [`PreviewFrame::into_wire_bytes`] prepends.
    pub const HEADER_BYTES: usize = 32;

    /// Version tag the frontend checks before reading the rest of the header.
    pub const WIRE_VERSION: u32 = 2;

    /// Header flag: the frame index is meaningful, so the caller may address
    /// this source by frame.
    pub const FLAG_INDEXED: u32 = 1;

    /// The frame as one buffer: a fixed 32-byte little-endian header followed
    /// by the pixels.
    ///
    /// Layout: `u32` version, `u32` width, `u32` height, `u32` frame index,
    /// `f64` source time, `u32` flags, `u32` reserved, then
    /// `width * height * 4` bytes. The `f64` sits at offset 16 and the pixels
    /// start at 32, so both are naturally aligned for a
    /// `DataView`/`Uint8ClampedArray` on the other side.
    pub fn into_wire_bytes(self) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(Self::HEADER_BYTES + self.pixels.len());
        bytes.extend_from_slice(&Self::WIRE_VERSION.to_le_bytes());
        bytes.extend_from_slice(&self.width.to_le_bytes());
        bytes.extend_from_slice(&self.height.to_le_bytes());
        // Saturating: a u32 frame index covers 4.5 years of 30 fps footage, and
        // a wrapped index would be a silent lie about which frame this is.
        let index = self
            .frame_index
            .map(|index| u32::try_from(index).unwrap_or(u32::MAX))
            .unwrap_or(0);
        bytes.extend_from_slice(&index.to_le_bytes());
        bytes.extend_from_slice(&self.source_time.to_le_bytes());
        let flags = if self.frame_index.is_some() {
            Self::FLAG_INDEXED
        } else {
            0
        };
        bytes.extend_from_slice(&flags.to_le_bytes());
        bytes.extend_from_slice(&0u32.to_le_bytes());
        bytes.extend_from_slice(&self.pixels);
        bytes
    }
}

/// How a source's presentation times relate to its frame numbers.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum SourceTiming {
    /// Frame `n` is shown at `n / fps`, so the pipe can be read forward and a
    /// requested time can be snapped to a frame index.
    ConstantRate {
        /// The rate both `avg_frame_rate` and `r_frame_rate` agree on.
        fps: f64,
    },
    /// Presentation times are not derivable from a frame number. Every request
    /// is its own accurate seek to the time asked for.
    VariableRate,
}

impl SourceTiming {
    /// The rate frames can be addressed by, when there is one.
    pub fn constant_fps(&self) -> Option<f64> {
        match self {
            Self::ConstantRate { fps } => Some(*fps),
            Self::VariableRate => None,
        }
    }
}

/// What the pool needs to know about a source file to answer a request.
#[derive(Debug, Clone, PartialEq)]
pub struct SourceInfo {
    /// Whether frames can be addressed by index, and at what rate.
    pub timing: SourceTiming,
    /// Width after the display matrix is applied, as FFmpeg will output it.
    pub display_width: u32,
    /// Height after the display matrix is applied, as FFmpeg will output it.
    pub display_height: u32,
}

/// Where a respawned child should start decoding.
#[derive(Debug, Clone, Copy, PartialEq)]
enum SeekTarget {
    /// A constant-rate source: seek to frame `index`'s exact presentation time
    /// and keep the pipe, because the frames after it are addressable.
    Frame(u64),
    /// A variable-rate source: seek to the requested time. The pipe is not kept,
    /// because nothing downstream can say which picture its next frame is.
    Time(f64),
}

/// Identity of a resident decoder: one source at one output size.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct DecoderKey {
    source: PathBuf,
    width: u32,
    height: u32,
}

/// The child process handle, reachable without holding the decoder lock so a
/// watchdog or a cancellation can kill a child that a read is blocked on.
type ChildSlot = Arc<Mutex<Option<Child>>>;

/// Locks a mutex, taking the value back after a panic elsewhere rather than
/// propagating the poison: every piece of state behind these locks is either
/// re-derived or explicitly reset before use.
fn lock_recovering<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The seek argument for `frame_index` at `fps`, in `S.NNNNNNNNN` form.
///
/// Truncated rather than rounded: FFmpeg's accurate seek drops frames whose
/// presentation time is below `-ss`, so an argument above the frame's own time
/// lands on the *next* frame. Truncation can only ever undershoot, which the
/// seek absorbs by decoding one extra frame.
pub fn seek_argument(frame_index: u64, fps: f64) -> String {
    if !fps.is_finite() || fps <= 0.0 {
        return "0.000000000".to_string();
    }

    seek_argument_seconds(frame_index as f64 / fps)
}

/// The seek argument for `seconds`, truncated to nanoseconds.
///
/// Truncation is what keeps the argument at or below the time asked for, which
/// is the difference between landing on a frame and landing on the one after it.
pub fn seek_argument_seconds(seconds: f64) -> String {
    if !seconds.is_finite() || seconds <= 0.0 {
        return "0.000000000".to_string();
    }

    let nanos = (seconds * 1e9).floor().max(0.0) as u64;
    format!("{}.{:09}", nanos / 1_000_000_000, nanos % 1_000_000_000)
}

/// The frame index whose presentation time is closest to `time_sec`.
///
/// Only meaningful for a constant-rate source; see [`SourceTiming`].
pub fn frame_index_for_time(time_sec: f64, fps: f64) -> u64 {
    if !time_sec.is_finite() || time_sec <= 0.0 || !fps.is_finite() || fps <= 0.0 {
        return 0;
    }

    (time_sec * fps).round().max(0.0) as u64
}

/// How far apart two reported rates may be and still count as the same rate.
const RATE_AGREEMENT_TOLERANCE: f64 = 1e-3;

/// Decides whether frames can be addressed by index.
///
/// A stream is treated as constant-rate only when its average rate and its base
/// rate agree. Anything else — including the field-rate doubling some encoders
/// report for otherwise constant footage — falls back to per-request seeking.
/// That costs speed on a file that did not need it; the opposite mistake shows
/// the wrong picture and then drifts further with every frame.
pub fn classify_timing(avg_frame_rate: Option<f64>, base_frame_rate: Option<f64>) -> SourceTiming {
    match (avg_frame_rate, base_frame_rate) {
        (Some(avg), Some(base)) if avg > 0.0 && base > 0.0 => {
            if ((avg / base) - 1.0).abs() <= RATE_AGREEMENT_TOLERANCE {
                SourceTiming::ConstantRate { fps: avg }
            } else {
                SourceTiming::VariableRate
            }
        }
        // Only one rate is usable, so there is nothing to corroborate it with.
        _ => SourceTiming::VariableRate,
    }
}

/// The output size for a source of `display` dimensions inside a `max` box.
///
/// Downscale only: the preview canvas composites with a contain-fit that reads
/// the drawable's intrinsic size, so upscaling here would only waste bandwidth
/// to produce pixels the canvas would draw at the same size anyway.
pub fn fitted_output_size(
    display_width: u32,
    display_height: u32,
    max_width: u32,
    max_height: u32,
) -> (u32, u32) {
    if display_width == 0 || display_height == 0 {
        return (1, 1);
    }
    if max_width == 0 || max_height == 0 {
        return (display_width.max(1), display_height.max(1));
    }

    let scale = f64::min(
        max_width as f64 / display_width as f64,
        max_height as f64 / display_height as f64,
    )
    .min(1.0);

    let width = ((display_width as f64 * scale).round() as u32).max(1);
    let height = ((display_height as f64 * scale).round() as u32).max(1);
    (width, height)
}

/// Parses an FFprobe rational such as `30000/1001` into a frame rate.
///
/// Returns `None` for the placeholders FFprobe uses when a stream has no usable
/// rate (`0/0`, `N/A`) and for rates outside what a picture stream can be.
fn parse_frame_rate(raw: &str) -> Option<f64> {
    let (numerator, denominator) = raw.trim().split_once('/')?;
    let numerator: f64 = numerator.trim().parse().ok()?;
    let denominator: f64 = denominator.trim().parse().ok()?;
    if denominator == 0.0 {
        return None;
    }

    let fps = numerator / denominator;
    if !fps.is_finite() || fps <= 0.0 || fps > MAX_PLAUSIBLE_FPS {
        return None;
    }

    Some(fps)
}

/// Reads the timing and display size of a source's first video stream.
pub fn probe_source(ffprobe: &Path, source: &Path) -> FFmpegResult<SourceInfo> {
    if !source.exists() {
        return Err(FFmpegError::InvalidInput(format!(
            "Input file does not exist: {}",
            source.display()
        )));
    }

    let mut command = std::process::Command::new(ffprobe);
    configure_std_command(&mut command);
    command
        .args([
            "-v",
            "error",
            "-print_format",
            "json",
            "-select_streams",
            "v:0",
            "-show_streams",
        ])
        .arg(source.as_os_str())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let (status, stdout, stderr) = run_with_timeout(command, PROBE_TIMEOUT)?;
    if !status.success() {
        return Err(FFmpegError::ProbeError(format!(
            "FFprobe failed for {}: {}",
            source.display(),
            String::from_utf8_lossy(&stderr).trim()
        )));
    }

    let parsed: serde_json::Value = serde_json::from_slice(&stdout).map_err(|error| {
        FFmpegError::ParseError(format!("FFprobe output was not JSON: {error}"))
    })?;

    let stream = parsed
        .get("streams")
        .and_then(|streams| streams.as_array())
        .and_then(|streams| streams.first())
        .ok_or_else(|| {
            FFmpegError::ProbeError(format!(
                "No video stream in {} to preview",
                source.display()
            ))
        })?;

    let coded_width = stream.get("width").and_then(serde_json::Value::as_u64);
    let coded_height = stream.get("height").and_then(serde_json::Value::as_u64);
    let (Some(coded_width), Some(coded_height)) = (coded_width, coded_height) else {
        return Err(FFmpegError::ProbeError(format!(
            "Video stream in {} reports no dimensions",
            source.display()
        )));
    };

    let rotation = rotation_from_probe_stream(stream);
    let (display_width, display_height) =
        display_dimensions(coded_width as u32, coded_height as u32, rotation);

    let reported_rate = |field: &str| {
        stream
            .get(field)
            .and_then(serde_json::Value::as_str)
            .and_then(parse_frame_rate)
    };
    let average_rate = reported_rate("avg_frame_rate");
    let base_rate = reported_rate("r_frame_rate");
    if average_rate.is_none() && base_rate.is_none() {
        return Err(FFmpegError::ProbeError(format!(
            "Video stream in {} reports no usable frame rate",
            source.display()
        )));
    }

    Ok(SourceInfo {
        timing: classify_timing(average_rate, base_rate),
        display_width: display_width.max(1),
        display_height: display_height.max(1),
    })
}

/// How often a watchdogged one-shot child is checked for having exited.
const CHILD_POLL_INTERVAL: Duration = Duration::from_millis(5);

/// Runs a one-shot child, killing it if it outlives `timeout`.
///
/// `Command::output` has no deadline, and the input is untrusted, so a file that
/// wedges FFprobe would otherwise wedge a preview thread with it. The pipes are
/// drained on their own threads because a child that fills one would never reach
/// the exit this waits for.
fn run_with_timeout(
    mut command: std::process::Command,
    timeout: Duration,
) -> FFmpegResult<(std::process::ExitStatus, Vec<u8>, Vec<u8>)> {
    let mut child = command.spawn().map_err(FFmpegError::ProcessError)?;
    let stdout_reader = child.stdout.take().map(spawn_pipe_drain);
    let stderr_reader = child.stderr.take().map(spawn_pipe_drain);

    let deadline = Instant::now() + timeout;
    let mut killed = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {}
            Err(error) => return Err(FFmpegError::ProcessError(error)),
        }

        if !killed && Instant::now() >= deadline {
            let _ = child.kill();
            killed = true;
        }

        std::thread::sleep(CHILD_POLL_INTERVAL);
    };

    if killed {
        return Err(FFmpegError::Timeout);
    }

    let stdout = stdout_reader.map(join_pipe_drain).unwrap_or_default();
    let stderr = stderr_reader.map(join_pipe_drain).unwrap_or_default();
    Ok((status, stdout, stderr))
}

/// Reads a pipe to end on its own thread.
fn spawn_pipe_drain<R: Read + Send + 'static>(mut pipe: R) -> JoinHandle<Vec<u8>> {
    std::thread::spawn(move || {
        let mut collected = Vec::new();
        let _ = pipe.read_to_end(&mut collected);
        collected
    })
}

/// Collects what a pipe drain read, treating a panicked reader as no output.
fn join_pipe_drain(handle: JoinHandle<Vec<u8>>) -> Vec<u8> {
    handle.join().unwrap_or_default()
}

/// The deadline a read must finish by, shared with the watchdog thread.
#[derive(Debug, Default)]
struct WatchdogState {
    /// When the running read must be killed, or `None` when none is running.
    deadline: Option<Instant>,
    /// Set once the owning decoder is going away, to end the thread.
    stopped: bool,
}

/// Kills a decoder's child when a read overruns the budget it was armed with.
///
/// One thread per decoder, rearmed per read, rather than one thread per read: a
/// thread spawn and join for every displayed frame — and up to thirteen when the
/// decoder skips forward — is real overhead on the path this module exists to
/// make cheap.
struct ReadWatchdog {
    shared: Arc<(Mutex<WatchdogState>, Condvar)>,
    /// Set by the thread when it actually killed a child, so a read failure
    /// caused by the watchdog can be told apart from a genuine end of stream.
    fired: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl ReadWatchdog {
    /// Starts the watchdog for `child`. It idles until a read arms it.
    fn new(child: ChildSlot) -> Self {
        let shared = Arc::new((Mutex::new(WatchdogState::default()), Condvar::new()));
        let fired = Arc::new(AtomicBool::new(false));

        let thread_shared = Arc::clone(&shared);
        let thread_fired = Arc::clone(&fired);
        let thread = std::thread::spawn(move || {
            let (lock, condvar) = &*thread_shared;
            let mut state = lock_recovering(lock);
            loop {
                if state.stopped {
                    return;
                }

                let Some(deadline) = state.deadline else {
                    state = condvar
                        .wait(state)
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                    continue;
                };

                let now = Instant::now();
                if now >= deadline {
                    if let Some(child) = lock_recovering(&child).as_mut() {
                        let _ = child.kill();
                    }
                    thread_fired.store(true, Ordering::SeqCst);
                    state.deadline = None;
                    continue;
                }

                let (next, _) = condvar
                    .wait_timeout(state, deadline - now)
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                state = next;
            }
        });

        Self {
            shared,
            fired,
            thread: Some(thread),
        }
    }

    /// Starts counting down `budget` against the running read.
    fn arm(&self, budget: Duration) {
        self.fired.store(false, Ordering::SeqCst);
        let (lock, condvar) = &*self.shared;
        lock_recovering(lock).deadline = Some(Instant::now() + budget);
        condvar.notify_all();
    }

    /// Stops the countdown once the read has returned.
    fn disarm(&self) {
        let (lock, condvar) = &*self.shared;
        lock_recovering(lock).deadline = None;
        condvar.notify_all();
    }

    /// Whether the last armed read was ended by the watchdog rather than by the
    /// source running out of frames.
    fn fired(&self) -> bool {
        self.fired.load(Ordering::SeqCst)
    }
}

impl Drop for ReadWatchdog {
    fn drop(&mut self) {
        {
            let (lock, condvar) = &*self.shared;
            let mut state = lock_recovering(lock);
            state.stopped = true;
            state.deadline = None;
            condvar.notify_all();
        }
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// Drains a child's stderr into a bounded tail so a failure can be reported.
///
/// The child would otherwise block once the stderr pipe filled, and the tail is
/// capped so a chatty decoder cannot grow it without bound.
fn spawn_stderr_drain(mut stderr: ChildStderr, tail: Arc<Mutex<String>>) -> JoinHandle<()> {
    std::thread::spawn(move || {
        let mut chunk = [0u8; 1024];
        loop {
            match stderr.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(read) => {
                    let mut tail = lock_recovering(&tail);
                    tail.push_str(&String::from_utf8_lossy(&chunk[..read]));
                    if tail.len() > MAX_STDERR_TAIL_BYTES {
                        let mut cut = tail.len() - MAX_STDERR_TAIL_BYTES;
                        while cut < tail.len() && !tail.is_char_boundary(cut) {
                            cut += 1;
                        }
                        let trimmed = tail[cut..].to_string();
                        *tail = trimmed;
                    }
                }
            }
        }
    })
}

/// One long-lived FFmpeg child streaming a single source at a single size.
struct ResidentDecoder {
    ffmpeg: PathBuf,
    source: PathBuf,
    info: SourceInfo,
    output_width: u32,
    output_height: u32,
    frame_bytes: usize,
    child: ChildSlot,
    stdout: Option<ChildStdout>,
    stderr_tail: Arc<Mutex<String>>,
    stderr_drain: Option<JoinHandle<()>>,
    /// Index of the frame the pipe will yield next, or `None` when no child is
    /// running.
    next_frame_index: Option<u64>,
    /// PID of the running child, kept so tests can prove it was reaped.
    child_pid: Option<u32>,
    /// Set once the pool has released this decoder.
    ///
    /// Releasing kills the child, which makes an in-flight read fail; without
    /// this flag that failure would be recovered from by respawning, and a
    /// decoder the pool had already let go would start a fresh FFmpeg.
    released: Arc<AtomicBool>,
    /// Kills a child whose read has overrun its budget.
    watchdog: ReadWatchdog,
    /// The first address the source was found to have no frame at.
    ///
    /// Requests at or past it are refused without spawning anything, so a clip
    /// whose source range runs off the end of its media does not pay a process
    /// spawn per rendered frame. Cleared by any successful read, and never set
    /// from a watchdog kill, so a slow decode cannot wall off a healthy source.
    first_missing: Option<SeekTarget>,
}

impl ResidentDecoder {
    fn new(
        ffmpeg: PathBuf,
        source: PathBuf,
        info: SourceInfo,
        output_width: u32,
        output_height: u32,
    ) -> FFmpegResult<Self> {
        let pixels = u64::from(output_width) * u64::from(output_height);
        if pixels == 0 || pixels > MAX_FRAME_PIXELS {
            return Err(FFmpegError::InvalidInput(format!(
                "Preview frame size {output_width}x{output_height} is out of range"
            )));
        }

        let child: ChildSlot = Arc::new(Mutex::new(None));
        Ok(Self {
            ffmpeg,
            source,
            info,
            output_width,
            output_height,
            frame_bytes: pixels as usize * BYTES_PER_PIXEL,
            watchdog: ReadWatchdog::new(Arc::clone(&child)),
            child,
            stdout: None,
            stderr_tail: Arc::new(Mutex::new(String::new())),
            stderr_drain: None,
            next_frame_index: None,
            child_pid: None,
            released: Arc::new(AtomicBool::new(false)),
            first_missing: None,
        })
    }

    /// Kills the child, reaps it, and joins the stderr drain thread.
    ///
    /// Killing before dropping the pipes is what guarantees no orphan: on
    /// Windows a child that is merely disconnected from its pipes keeps running.
    fn shutdown(&mut self) {
        if let Some(mut child) = lock_recovering(&self.child).take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        self.child_pid = None;
        // Dropping stdout after the kill closes our end of the pipe; the drain
        // thread's read then returns 0 and it exits, so the join cannot hang.
        self.stdout = None;
        if let Some(drain) = self.stderr_drain.take() {
            let _ = drain.join();
        }
        self.next_frame_index = None;
    }

    /// Restarts the child so the pipe's next frame is the one `target` names.
    fn respawn_at(&mut self, target: SeekTarget) -> FFmpegResult<()> {
        if self.released.load(Ordering::SeqCst) {
            return Err(FFmpegError::ExecutionFailed(
                "The preview decoder was released while this frame was decoding".to_string(),
            ));
        }

        self.shutdown();
        lock_recovering(&self.stderr_tail).clear();

        let seek = match target {
            SeekTarget::Frame(index) => {
                seek_argument(index, self.info.timing.constant_fps().unwrap_or(0.0))
            }
            SeekTarget::Time(seconds) => seek_argument_seconds(seconds),
        };
        let scale = format!("scale={}:{}", self.output_width, self.output_height);

        let mut command = std::process::Command::new(&self.ffmpeg);
        configure_std_command(&mut command);
        command
            .args(["-hide_banner", "-loglevel", "error", "-nostdin"])
            .args(["-ss", &seek])
            .arg("-i")
            .arg(self.source.as_os_str())
            .args(["-an", "-sn", "-dn"])
            // Passthrough keeps one output frame per decoded frame; the default
            // rate conversion would duplicate or drop frames on a
            // variable-rate source and desynchronise the pipe cursor.
            //
            // `-vsync 0` rather than the newer `-fps_mode passthrough` it is an
            // alias for: the resolver can land on a system FFmpeg older than
            // 5.1, which does not know `-fps_mode` and would refuse to start.
            .args(["-vsync", "0"])
            .args(["-vf", &scale])
            .args(["-f", "rawvideo", "-pix_fmt", "rgba"])
            .arg("-")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = command.spawn().map_err(FFmpegError::ProcessError)?;
        self.child_pid = Some(child.id());
        self.stdout = child.stdout.take();
        if let Some(stderr) = child.stderr.take() {
            self.stderr_drain = Some(spawn_stderr_drain(stderr, Arc::clone(&self.stderr_tail)));
        }
        *lock_recovering(&self.child) = Some(child);
        self.next_frame_index = match target {
            SeekTarget::Frame(index) => Some(index),
            // Nothing downstream can say which picture the pipe's next frame is,
            // so there is no cursor to advance.
            SeekTarget::Time(_) => None,
        };
        Ok(())
    }

    /// Reads exactly `buffer.len()` bytes off the pipe, killing the child if the
    /// read has not finished within `budget`.
    ///
    /// A read the watchdog ended is reported as [`std::io::ErrorKind::TimedOut`]
    /// so callers can tell "this source has no such frame" from "this decode was
    /// too slow", which are handled very differently.
    fn read_exact_bounded(&mut self, buffer: &mut [u8], budget: Duration) -> std::io::Result<()> {
        let Self {
            stdout, watchdog, ..
        } = self;
        let Some(stdout) = stdout.as_mut() else {
            return Err(std::io::Error::new(
                std::io::ErrorKind::BrokenPipe,
                "preview decoder is not running",
            ));
        };

        watchdog.arm(budget);
        let result = stdout.read_exact(buffer);
        watchdog.disarm();

        match result {
            Err(error) if watchdog.fired() => Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                format!("preview decode exceeded {budget:?}: {error}"),
            )),
            other => other,
        }
    }

    /// Reads and discards `count` frames so the cursor lands on the wanted one.
    fn skip_frames(&mut self, count: u64) -> std::io::Result<()> {
        let mut scratch = vec![0u8; self.frame_bytes];
        for _ in 0..count {
            self.read_exact_bounded(&mut scratch, READ_TIMEOUT)?;
            self.next_frame_index = self.next_frame_index.map(|index| index + 1);
        }
        Ok(())
    }

    /// Reads the frame the pipe is positioned on.
    fn read_current_frame(&mut self, budget: Duration) -> std::io::Result<Vec<u8>> {
        let mut pixels = vec![0u8; self.frame_bytes];
        self.read_exact_bounded(&mut pixels, budget)?;
        self.next_frame_index = self.next_frame_index.map(|index| index + 1);
        Ok(pixels)
    }

    /// The failure to report when a read came up short, with the child's own
    /// diagnosis when it produced one.
    fn read_failure(&self, target: SeekTarget, error: &std::io::Error) -> FFmpegError {
        let where_ = match target {
            SeekTarget::Frame(index) => format!("index {index}"),
            SeekTarget::Time(seconds) => format!("{seconds:.3}s"),
        };
        let tail = lock_recovering(&self.stderr_tail).trim().to_string();
        if tail.is_empty() {
            FFmpegError::ExecutionFailed(format!(
                "No preview frame at {where_} of {}: {error}",
                self.source.display()
            ))
        } else {
            FFmpegError::ExecutionFailed(format!(
                "No preview frame at {where_} of {}: {error}. FFmpeg said: {tail}",
                self.source.display()
            ))
        }
    }

    /// Whether the source is already known to have nothing at `target`.
    fn is_past_end(&self, target: SeekTarget) -> bool {
        match (self.first_missing, target) {
            (Some(SeekTarget::Frame(missing)), SeekTarget::Frame(index)) => index >= missing,
            (Some(SeekTarget::Time(missing)), SeekTarget::Time(seconds)) => seconds >= missing,
            _ => false,
        }
    }

    /// Whether the running child has already exited reporting success.
    ///
    /// Used to tell "this source ends here" from "this decode went wrong". At a
    /// clean end of stream FFmpeg has closed stdout and is on its way out, so
    /// the wait resolves almost immediately; the poll is bounded anyway so a
    /// child that is doing something else cannot stall the caller.
    fn child_finished_successfully(&self) -> bool {
        let deadline = Instant::now() + CLEAN_EXIT_GRACE;
        loop {
            {
                let mut child = lock_recovering(&self.child);
                let Some(child) = child.as_mut() else {
                    return false;
                };
                match child.try_wait() {
                    Ok(Some(status)) => return status.success(),
                    Ok(None) => {}
                    Err(_) => return false,
                }
            }

            if Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(CHILD_POLL_INTERVAL);
        }
    }

    /// Seeks to `target` and reads the one frame it names.
    ///
    /// On failure the child is reaped rather than left for the next respawn.
    ///
    /// Only a *clean* end of stream is remembered as the end of the source. A
    /// decode that went wrong part-way through a file — a corrupt GOP, say —
    /// leaves FFmpeg exiting non-zero, and treating that as the end would wall
    /// off every later address until something below it succeeded, so a forward
    /// sweep past one bad frame would report "no frame" for the whole rest of
    /// the sweep. A watchdog kill is excluded for the same reason.
    fn seek_and_read(&mut self, target: SeekTarget) -> FFmpegResult<Vec<u8>> {
        self.respawn_at(target)?;
        match self.read_current_frame(FIRST_READ_TIMEOUT) {
            Ok(pixels) => {
                self.first_missing = None;
                Ok(pixels)
            }
            Err(error) => {
                if error.kind() == std::io::ErrorKind::UnexpectedEof
                    && self.child_finished_successfully()
                {
                    self.first_missing = Some(target);
                }
                let failure = self.read_failure(target, &error);
                self.shutdown();
                Err(failure)
            }
        }
    }

    /// The frame at `frame_index` of a constant-rate source, read forward from
    /// the resident pipe when it is close enough and from a fresh seek otherwise.
    fn frame_at_index(&mut self, frame_index: u64) -> FFmpegResult<PreviewFrame> {
        let target = SeekTarget::Frame(frame_index);
        if self.is_past_end(target) {
            return Err(FFmpegError::ExecutionFailed(format!(
                "{} has no frame at index {frame_index}",
                self.source.display()
            )));
        }

        let contiguous = match self.next_frame_index {
            Some(next) if next == frame_index => true,
            Some(next) if frame_index > next && frame_index - next <= MAX_FORWARD_SKIP_FRAMES => {
                let skip = frame_index - next;
                match self.skip_frames(skip) {
                    Ok(()) => true,
                    // A child that died mid-skip is indistinguishable from one
                    // that ran out of frames; the seek below decides which.
                    Err(_) => false,
                }
            }
            _ => false,
        };

        // A failed read here means the resident child died or ran out of
        // frames. Re-seeking is the recovery for the first and what turns the
        // second into a clear error, so both fall through to the seek below.
        if contiguous {
            if let Ok(pixels) = self.read_current_frame(READ_TIMEOUT) {
                self.first_missing = None;
                return Ok(self.finish_frame(target, pixels));
            }
        }

        let pixels = self.seek_and_read(target)?;
        Ok(self.finish_frame(target, pixels))
    }

    /// The frame a variable-rate source shows from `time_sec`, by accurate seek.
    ///
    /// Never read forward: on a variable-rate source the pipe's next frame is at
    /// an unknown time, so advancing the cursor per request would walk away from
    /// the timeline without bound. The pipe is closed straight after the read for
    /// the same reason — there is nothing addressable left in it.
    fn frame_at_time(&mut self, time_sec: f64) -> FFmpegResult<PreviewFrame> {
        let time_sec = if time_sec.is_finite() {
            time_sec.max(0.0)
        } else {
            0.0
        };
        let target = SeekTarget::Time(time_sec);
        if self.is_past_end(target) {
            return Err(FFmpegError::ExecutionFailed(format!(
                "{} has no frame at {time_sec:.3}s",
                self.source.display()
            )));
        }

        let pixels = self.seek_and_read(target)?;
        let frame = self.finish_frame(target, pixels);
        self.shutdown();
        Ok(frame)
    }

    fn finish_frame(&self, target: SeekTarget, pixels: Vec<u8>) -> PreviewFrame {
        let (frame_index, source_time) = match target {
            SeekTarget::Frame(index) => (
                Some(index),
                index as f64 / self.info.timing.constant_fps().unwrap_or(1.0),
            ),
            // The accurate seek landed on the first frame at or after this time,
            // which is the frame this request stands for.
            SeekTarget::Time(seconds) => (None, seconds),
        };

        PreviewFrame {
            width: self.output_width,
            height: self.output_height,
            frame_index,
            source_time,
            pixels,
        }
    }
}

impl Drop for ResidentDecoder {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// A decoder plus the handle needed to kill its child from outside the lock a
/// blocked read is holding.
struct DecoderSlot {
    key: DecoderKey,
    child: ChildSlot,
    released: Arc<AtomicBool>,
    decoder: Mutex<ResidentDecoder>,
    last_used: Mutex<Instant>,
}

/// A bounded pool of resident decoders, keyed by source and output size.
pub struct PreviewDecoderPool {
    ffmpeg: PathBuf,
    ffprobe: PathBuf,
    max_resident: usize,
    slots: Mutex<Vec<Arc<DecoderSlot>>>,
    sources: Mutex<HashMap<PathBuf, SourceInfo>>,
}

impl PreviewDecoderPool {
    /// A pool that spawns `ffmpeg` and probes with `ffprobe`.
    pub fn new(ffmpeg: PathBuf, ffprobe: PathBuf) -> Self {
        Self::with_capacity(ffmpeg, ffprobe, DEFAULT_MAX_RESIDENT_DECODERS)
    }

    /// A pool holding at most `max_resident` live children.
    pub fn with_capacity(ffmpeg: PathBuf, ffprobe: PathBuf, max_resident: usize) -> Self {
        Self {
            ffmpeg,
            ffprobe,
            max_resident: max_resident.max(1),
            slots: Mutex::new(Vec::new()),
            sources: Mutex::new(HashMap::new()),
        }
    }

    /// How many decoders are currently resident.
    pub fn resident_count(&self) -> usize {
        lock_recovering(&self.slots).len()
    }

    /// The frame nearest `time_sec`, downscaled to fit inside `max_width` by
    /// `max_height` without changing its aspect ratio.
    ///
    /// This blocks on a pipe read and must be called off the async runtime.
    pub fn frame_at(
        &self,
        source: &Path,
        time_sec: f64,
        max_width: u32,
        max_height: u32,
    ) -> FFmpegResult<PreviewFrame> {
        let info = self.source_info(source)?;
        let (output_width, output_height) = fitted_output_size(
            info.display_width,
            info.display_height,
            max_width,
            max_height,
        );
        let key = DecoderKey {
            source: source.to_path_buf(),
            width: output_width,
            height: output_height,
        };
        let slot = self.slot_for(key, source, &info, output_width, output_height)?;

        // The pool lock is released before the decode so a slow frame on one
        // asset cannot stall a request for another.
        let mut decoder = lock_recovering(&slot.decoder);
        match info.timing {
            SourceTiming::ConstantRate { fps } => {
                decoder.frame_at_index(frame_index_for_time(time_sec, fps))
            }
            // No index maps onto this source's presentation times, so the
            // request is answered by seeking to the time it asked for.
            SourceTiming::VariableRate => decoder.frame_at_time(time_sec),
        }
    }

    /// Kills every resident child and forgets every probe.
    ///
    /// Children are killed through the slot handles rather than by dropping the
    /// decoders, so this also unblocks a read that is in flight.
    pub fn release_all(&self) {
        let slots: Vec<Arc<DecoderSlot>> = std::mem::take(&mut *lock_recovering(&self.slots));
        for slot in &slots {
            // Flag first, kill second: an in-flight read sees the flag when its
            // read fails and gives up instead of spawning a replacement.
            slot.released.store(true, Ordering::SeqCst);
            if let Some(child) = lock_recovering(&slot.child).as_mut() {
                let _ = child.kill();
            }
        }
        // Reap only once the in-flight reads have unblocked and released the
        // decoder locks. Shutting each one down here rather than leaving it to
        // `Drop` means every child is waited on by the time this returns, even
        // though a caller mid-decode still holds its `Arc`.
        for slot in slots {
            lock_recovering(&slot.decoder).shutdown();
        }
        lock_recovering(&self.sources).clear();
    }

    /// The cached probe for `source`, probing it on first use.
    fn source_info(&self, source: &Path) -> FFmpegResult<SourceInfo> {
        if let Some(info) = lock_recovering(&self.sources).get(source) {
            return Ok(info.clone());
        }

        let info = probe_source(&self.ffprobe, source)?;
        lock_recovering(&self.sources).insert(source.to_path_buf(), info.clone());
        Ok(info)
    }

    /// The slot for `key`, creating it and evicting the least-recently-used
    /// decoder when the pool is already full.
    fn slot_for(
        &self,
        key: DecoderKey,
        source: &Path,
        info: &SourceInfo,
        output_width: u32,
        output_height: u32,
    ) -> FFmpegResult<Arc<DecoderSlot>> {
        let mut slots = lock_recovering(&self.slots);

        if let Some(slot) = slots.iter().find(|slot| slot.key == key) {
            *lock_recovering(&slot.last_used) = Instant::now();
            return Ok(Arc::clone(slot));
        }

        let decoder = ResidentDecoder::new(
            self.ffmpeg.clone(),
            source.to_path_buf(),
            info.clone(),
            output_width,
            output_height,
        )?;
        let slot = Arc::new(DecoderSlot {
            key,
            child: Arc::clone(&decoder.child),
            released: Arc::clone(&decoder.released),
            decoder: Mutex::new(decoder),
            last_used: Mutex::new(Instant::now()),
        });
        slots.push(Arc::clone(&slot));

        while slots.len() > self.max_resident {
            let Some(oldest) = slots
                .iter()
                .enumerate()
                .min_by_key(|(_, slot)| *lock_recovering(&slot.last_used))
                .map(|(index, _)| index)
            else {
                break;
            };
            // Dropping the last `Arc` runs `ResidentDecoder::drop`, which kills
            // and reaps the child.
            let evicted = slots.remove(oldest);
            drop(evicted);
        }

        Ok(slot)
    }
}

impl Drop for PreviewDecoderPool {
    fn drop(&mut self) {
        self.release_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Feature: preview seek accuracy
    /// Scenario: the seek argument is the frame's own presentation time
    #[test]
    fn seek_argument_is_the_exact_frame_time_for_integer_rates() {
        assert_eq!(seek_argument(0, 30.0), "0.000000000");
        assert_eq!(seek_argument(1, 30.0), "0.033333333");
        assert_eq!(seek_argument(60, 30.0), "2.000000000");
        assert_eq!(seek_argument(119, 30.0), "3.966666666");
    }

    /// Feature: preview seek accuracy
    /// Scenario: the seek argument never lands past the frame it names
    ///
    /// FFmpeg drops frames whose presentation time is below `-ss`, so an
    /// argument even one nanosecond above the frame's time returns the next
    /// frame instead. Rounding would do exactly that on fractional rates.
    #[test]
    fn seek_argument_never_exceeds_the_frame_presentation_time() {
        let rates = [
            23.976023976023978,
            29.97002997002997,
            30.0,
            59.94005994005994,
        ];
        for fps in rates {
            for frame_index in [0u64, 1, 7, 59, 100, 1001, 100_000] {
                let argument = seek_argument(frame_index, fps);
                let parsed: f64 = argument
                    .parse()
                    .unwrap_or_else(|error| panic!("`{argument}` must parse: {error}"));
                let exact = frame_index as f64 / fps;
                assert!(
                    parsed <= exact,
                    "seek {argument} for frame {frame_index} at {fps} fps is ahead of {exact}"
                );
                assert!(
                    exact - parsed < 1e-8,
                    "seek {argument} for frame {frame_index} at {fps} fps undershoots by too much"
                );
            }
        }
    }

    /// Feature: preview seek accuracy
    /// Scenario: a nonsensical rate cannot produce a nonsensical seek
    #[test]
    fn seek_argument_is_zero_for_unusable_rates() {
        assert_eq!(seek_argument(10, 0.0), "0.000000000");
        assert_eq!(seek_argument(10, f64::NAN), "0.000000000");
        assert_eq!(seek_argument(10, -30.0), "0.000000000");
    }

    /// Feature: preview frame addressing
    /// Scenario: a source time snaps to the nearest frame
    #[test]
    fn frame_index_snaps_to_the_nearest_frame() {
        assert_eq!(frame_index_for_time(0.0, 30.0), 0);
        assert_eq!(frame_index_for_time(0.016, 30.0), 0);
        assert_eq!(frame_index_for_time(0.017, 30.0), 1);
        assert_eq!(frame_index_for_time(2.0, 30.0), 60);
        assert_eq!(frame_index_for_time(-5.0, 30.0), 0);
        assert_eq!(frame_index_for_time(f64::NAN, 30.0), 0);
    }

    /// Feature: preview frame sizing
    /// Scenario: the frame keeps its aspect ratio inside the canvas box
    ///
    /// The canvas composites with a contain-fit that reads the drawable's
    /// intrinsic size, so a frame stretched to the canvas box would make that
    /// fit a no-op and silently change how every transformed clip is drawn.
    #[test]
    fn fitted_output_preserves_aspect_ratio() {
        assert_eq!(fitted_output_size(1920, 1080, 960, 540), (960, 540));
        assert_eq!(fitted_output_size(1920, 1080, 960, 960), (960, 540));
        assert_eq!(fitted_output_size(1080, 1920, 960, 540), (304, 540));
    }

    /// Feature: preview frame sizing
    /// Scenario: a small source is never upscaled
    #[test]
    fn fitted_output_never_upscales() {
        assert_eq!(fitted_output_size(320, 180, 1920, 1080), (320, 180));
    }

    /// Feature: preview frame sizing
    /// Scenario: degenerate sizes still produce a decodable frame
    #[test]
    fn fitted_output_stays_at_least_one_pixel() {
        assert_eq!(fitted_output_size(1920, 1080, 1, 1), (1, 1));
        assert_eq!(fitted_output_size(0, 0, 960, 540), (1, 1));
        assert_eq!(fitted_output_size(1920, 1080, 0, 0), (1920, 1080));
    }

    /// Feature: preview frame rate resolution
    /// Scenario: FFprobe rationals become frame rates, placeholders do not
    #[test]
    fn frame_rate_parsing_rejects_probe_placeholders() {
        assert_eq!(parse_frame_rate("30/1"), Some(30.0));
        assert_eq!(parse_frame_rate("30000/1001"), Some(30000.0 / 1001.0));
        assert_eq!(parse_frame_rate("0/0"), None);
        assert_eq!(parse_frame_rate("N/A"), None);
        assert_eq!(parse_frame_rate("0/1"), None);
        assert_eq!(parse_frame_rate("90000/1"), None);
        assert_eq!(parse_frame_rate("30"), None);
    }

    /// Reads a little-endian `u32` out of a wire header.
    fn header_u32(bytes: &[u8], offset: usize) -> u32 {
        u32::from_le_bytes([
            bytes[offset],
            bytes[offset + 1],
            bytes[offset + 2],
            bytes[offset + 3],
        ])
    }

    /// Feature: preview frame transport
    /// Scenario: the wire header describes the pixels that follow it
    #[test]
    fn wire_bytes_carry_a_readable_header() {
        let frame = PreviewFrame {
            width: 2,
            height: 1,
            frame_index: Some(7),
            source_time: 0.25,
            pixels: vec![1, 2, 3, 4, 5, 6, 7, 8],
        };
        let bytes = frame.into_wire_bytes();

        assert_eq!(bytes.len(), PreviewFrame::HEADER_BYTES + 8);
        assert_eq!(header_u32(&bytes, 0), PreviewFrame::WIRE_VERSION);
        assert_eq!(header_u32(&bytes, 4), 2);
        assert_eq!(header_u32(&bytes, 8), 1);
        assert_eq!(header_u32(&bytes, 12), 7);
        assert_eq!(
            f64::from_le_bytes([
                bytes[16], bytes[17], bytes[18], bytes[19], bytes[20], bytes[21], bytes[22],
                bytes[23],
            ]),
            0.25
        );
        assert_eq!(header_u32(&bytes, 24), PreviewFrame::FLAG_INDEXED);
        assert_eq!(
            &bytes[PreviewFrame::HEADER_BYTES..],
            &[1, 2, 3, 4, 5, 6, 7, 8]
        );
    }

    /// Feature: preview frame transport
    /// Scenario: an unindexable frame says so rather than shipping a made-up index
    ///
    /// A variable-rate source has no index the frontend could cache or seek by,
    /// and a zero here would be read as "frame zero" if the flag did not say
    /// otherwise.
    #[test]
    fn wire_bytes_mark_a_variable_rate_frame_as_unindexed() {
        let frame = PreviewFrame {
            width: 1,
            height: 1,
            frame_index: None,
            source_time: 1.5,
            pixels: vec![9, 9, 9, 9],
        };
        let bytes = frame.into_wire_bytes();

        assert_eq!(header_u32(&bytes, 12), 0);
        assert_eq!(header_u32(&bytes, 24) & PreviewFrame::FLAG_INDEXED, 0);
    }

    /// Feature: variable frame rate handling
    /// Scenario: a source is only read forward when its two rates agree
    ///
    /// Reading the pipe forward assumes frame `n` is shown at `n / fps`. That is
    /// false for a variable-rate source, and believing it there shows the wrong
    /// picture and then drifts further with every frame.
    #[test]
    fn timing_is_constant_only_when_both_reported_rates_agree() {
        assert_eq!(
            classify_timing(Some(30.0), Some(30.0)),
            SourceTiming::ConstantRate { fps: 30.0 }
        );
        assert_eq!(
            classify_timing(Some(30000.0 / 1001.0), Some(30000.0 / 1001.0)),
            SourceTiming::ConstantRate {
                fps: 30000.0 / 1001.0
            }
        );

        // The screen-recording shape: an average far below the base rate.
        assert_eq!(
            classify_timing(Some(6.0), Some(30.0)),
            SourceTiming::VariableRate
        );
        assert_eq!(
            classify_timing(Some(10.3), Some(30.0)),
            SourceTiming::VariableRate
        );
        // Field-rate doubling: constant footage, but not provably so.
        assert_eq!(
            classify_timing(Some(30.0), Some(60.0)),
            SourceTiming::VariableRate
        );
    }

    /// Feature: variable frame rate handling
    /// Scenario: a rate nothing corroborates is not trusted for indexing
    #[test]
    fn timing_is_variable_when_a_rate_is_missing() {
        assert_eq!(
            classify_timing(Some(30.0), None),
            SourceTiming::VariableRate
        );
        assert_eq!(
            classify_timing(None, Some(30.0)),
            SourceTiming::VariableRate
        );
        assert_eq!(classify_timing(None, None), SourceTiming::VariableRate);
    }

    /// Feature: variable frame rate handling
    /// Scenario: a time seek is truncated the same way a frame seek is
    #[test]
    fn seconds_seek_argument_never_exceeds_the_time_asked_for() {
        for seconds in [0.0, 0.1, 1.0 / 3.0, 2.5, 123.456789012] {
            let argument = seek_argument_seconds(seconds);
            let parsed: f64 = argument
                .parse()
                .unwrap_or_else(|error| panic!("`{argument}` must parse: {error}"));
            assert!(
                parsed <= seconds,
                "seek {argument} is ahead of the requested {seconds}"
            );
            assert!(
                seconds - parsed < 1e-8,
                "seek {argument} undershoots too far"
            );
        }
        assert_eq!(seek_argument_seconds(-1.0), "0.000000000");
        assert_eq!(seek_argument_seconds(f64::NAN), "0.000000000");
    }
}

#[cfg(test)]
mod ffmpeg_backed_tests {
    //! Tests that put a real FFmpeg behind the pool.
    //!
    //! They are `#[ignore]`d because they need a binary the machine may not
    //! have; `require_or_skip_ffmpeg` turns the skip into a failure when
    //! `REQUIRE_FFMPEG_TESTS` is set, so a CI job that installs FFmpeg cannot
    //! report green without having run them.

    use super::*;
    use crate::core::test_ffmpeg::{require_or_skip_ffmpeg, skip_without_ffmpeg};

    const TEST_FPS: f64 = 30.0;
    const TEST_WIDTH: u32 = 160;
    const TEST_HEIGHT: u32 = 90;
    const TEST_FRAMES: u64 = 120;

    /// The FFprobe beside the FFmpeg the tests resolved.
    fn ffprobe_beside(ffmpeg: &Path) -> Option<PathBuf> {
        if let Some(explicit) = std::env::var_os("OPENREELIO_FFPROBE_PATH") {
            return Some(PathBuf::from(explicit));
        }

        let sibling = ffmpeg.with_file_name(if cfg!(windows) {
            "ffprobe.exe"
        } else {
            "ffprobe"
        });
        if sibling.exists() {
            return Some(sibling);
        }

        skip_without_ffmpeg("no FFprobe beside the resolved FFmpeg");
        None
    }

    /// A scratch directory that removes itself.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(label: &str) -> std::io::Result<Self> {
            let path = std::env::temp_dir().join(format!(
                "openreelio-preview-{label}-{}-{:?}",
                std::process::id(),
                std::thread::current().id()
            ));
            let _ = std::fs::remove_dir_all(&path);
            std::fs::create_dir_all(&path)?;
            Ok(Self(path))
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// A variable-rate clip shaped like a screen recording: a burst at 30 fps
    /// for half a second, then a long idle stretch at 5 fps.
    ///
    /// FFprobe reports `r_frame_rate` 30 and `avg_frame_rate` 6 for this, which
    /// is exactly the shape that makes an index-based mapping wrong.
    fn write_variable_rate_source(ffmpeg: &Path, directory: &Path) -> Option<PathBuf> {
        let source = directory.join("variable.mp4");
        let mut command = std::process::Command::new(ffmpeg);
        configure_std_command(&mut command);
        let output = command
            .args(["-y", "-hide_banner", "-loglevel", "error"])
            .args(["-f", "lavfi", "-i"])
            .arg(format!(
                "testsrc2=size={TEST_WIDTH}x{TEST_HEIGHT}:rate=30:duration=3"
            ))
            .args(["-vf", "setpts='(if(lt(N,15),N/30,0.5+(N-15)/5))/TB'"])
            .args(["-vsync", "passthrough"])
            .args(["-c:v", "libx264", "-g", "250", "-pix_fmt", "yuv420p"])
            .arg(&source)
            .output()
            .ok()?;

        if !output.status.success() {
            skip_without_ffmpeg(&format!(
                "could not synthesise a variable-rate source: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
            return None;
        }

        Some(source)
    }

    /// The frame a plain per-request accurate seek returns for `time_sec`.
    ///
    /// This is what the extraction path this module replaced does, so it is the
    /// definition of "no worse than before" for a source the resident stream
    /// cannot address.
    fn seek_oracle(ffmpeg: &Path, source: &Path, time_sec: f64) -> Option<Vec<u8>> {
        let mut command = std::process::Command::new(ffmpeg);
        configure_std_command(&mut command);
        let output = command
            .args(["-hide_banner", "-loglevel", "error", "-nostdin"])
            .args(["-ss", &format!("{time_sec}")])
            .arg("-i")
            .arg(source)
            .args(["-frames:v", "1", "-an", "-sn", "-dn"])
            .args(["-vf", &format!("scale={TEST_WIDTH}:{TEST_HEIGHT}")])
            .args(["-f", "rawvideo", "-pix_fmt", "rgba", "-"])
            .output()
            .ok()?;

        if !output.status.success() || output.stdout.is_empty() {
            return None;
        }

        Some(output.stdout)
    }

    /// A four-second 30 fps clip whose frames all differ from one another.
    fn write_source(ffmpeg: &Path, directory: &Path) -> Option<PathBuf> {
        let source = directory.join("source.mp4");
        let mut command = std::process::Command::new(ffmpeg);
        configure_std_command(&mut command);
        let output = command
            .args(["-y", "-hide_banner", "-loglevel", "error"])
            .args(["-f", "lavfi", "-i"])
            .arg(format!(
                "testsrc2=size={TEST_WIDTH}x{TEST_HEIGHT}:rate={}:duration={}",
                TEST_FPS as u32,
                TEST_FRAMES as f64 / TEST_FPS
            ))
            .args(["-c:v", "libx264", "-g", "250", "-pix_fmt", "yuv420p"])
            .arg(&source)
            .output()
            .ok()?;

        if !output.status.success() {
            skip_without_ffmpeg(&format!(
                "could not synthesise a preview source: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
            return None;
        }

        Some(source)
    }

    /// Every frame of the source, decoded in one sequential pass, as the oracle
    /// a seek is checked against.
    fn decode_all_frames(ffmpeg: &Path, source: &Path) -> Option<Vec<Vec<u8>>> {
        let mut command = std::process::Command::new(ffmpeg);
        configure_std_command(&mut command);
        let output = command
            .args(["-hide_banner", "-loglevel", "error", "-nostdin"])
            .arg("-i")
            .arg(source)
            .args(["-an", "-sn", "-dn", "-vsync", "0"])
            .args(["-vf", &format!("scale={TEST_WIDTH}:{TEST_HEIGHT}")])
            .args(["-f", "rawvideo", "-pix_fmt", "rgba", "-"])
            .output()
            .ok()?;

        if !output.status.success() {
            return None;
        }

        let frame_bytes = TEST_WIDTH as usize * TEST_HEIGHT as usize * BYTES_PER_PIXEL;
        Some(
            output
                .stdout
                .chunks_exact(frame_bytes)
                .map(<[u8]>::to_vec)
                .collect(),
        )
    }

    /// Whether a process id is still alive.
    fn process_is_alive(pid: u32) -> bool {
        let pid = sysinfo::Pid::from_u32(pid);
        let mut system = sysinfo::System::new();
        system.refresh_processes(sysinfo::ProcessesToUpdate::Some(&[pid]), true);
        system.process(pid).is_some()
    }

    /// Feature: resident preview decoding
    /// Scenario: sequential frames come off one resident pipe at the exact size
    #[test]
    #[ignore = "requires FFmpeg"]
    fn resident_decoding_streams_exact_sized_frames_in_order() {
        let Some(ffmpeg) = require_or_skip_ffmpeg() else {
            return;
        };
        let Some(ffprobe) = ffprobe_beside(&ffmpeg) else {
            return;
        };
        let Ok(directory) = TempDir::new("sequential") else {
            return;
        };
        let Some(source) = write_source(&ffmpeg, directory.path()) else {
            return;
        };
        let Some(oracle) = decode_all_frames(&ffmpeg, &source) else {
            panic!("the oracle decode must succeed once FFmpeg is available");
        };

        let pool = PreviewDecoderPool::new(ffmpeg, ffprobe);
        let expected_bytes = TEST_WIDTH as usize * TEST_HEIGHT as usize * BYTES_PER_PIXEL;

        for index in 0..20u64 {
            let frame = pool
                .frame_at(&source, index as f64 / TEST_FPS, TEST_WIDTH, TEST_HEIGHT)
                .unwrap_or_else(|error| panic!("frame {index} must decode: {error}"));

            assert_eq!(frame.width, TEST_WIDTH);
            assert_eq!(frame.height, TEST_HEIGHT);
            assert_eq!(frame.frame_index, Some(index));
            assert_eq!(
                frame.pixels.len(),
                expected_bytes,
                "frame {index} must be exactly width * height * 4 bytes"
            );
            assert_eq!(
                frame.pixels, oracle[index as usize],
                "frame {index} must match the sequential oracle"
            );
        }

        assert_eq!(
            pool.resident_count(),
            1,
            "a sequential pass must reuse a single resident decoder"
        );
    }

    /// Feature: resident preview decoding
    /// Scenario: a seek lands on the frame it was asked for
    ///
    /// This is the assertion the whole seek design turns on: `-ss` is the
    /// frame's own presentation time, truncated, and a forward-biased argument
    /// would land on the following frame instead.
    #[test]
    #[ignore = "requires FFmpeg"]
    fn seeking_lands_on_the_requested_frame() {
        let Some(ffmpeg) = require_or_skip_ffmpeg() else {
            return;
        };
        let Some(ffprobe) = ffprobe_beside(&ffmpeg) else {
            return;
        };
        let Ok(directory) = TempDir::new("seek") else {
            return;
        };
        let Some(source) = write_source(&ffmpeg, directory.path()) else {
            return;
        };
        let Some(oracle) = decode_all_frames(&ffmpeg, &source) else {
            panic!("the oracle decode must succeed once FFmpeg is available");
        };

        let pool = PreviewDecoderPool::new(ffmpeg, ffprobe);
        // Deliberately non-contiguous and far enough apart to force a respawn.
        for index in [97u64, 13, 60, 0, 118, 44, 91, 7, 105, 31] {
            let frame = pool
                .frame_at(&source, index as f64 / TEST_FPS, TEST_WIDTH, TEST_HEIGHT)
                .unwrap_or_else(|error| panic!("frame {index} must decode: {error}"));

            assert_eq!(frame.frame_index, Some(index));
            assert_eq!(
                frame.pixels, oracle[index as usize],
                "seeking to frame {index} returned a different frame"
            );
        }
    }

    /// Feature: resident preview decoding
    /// Scenario: rapid seeking leaves no FFmpeg behind
    ///
    /// This is the risk the whole design lives or dies on: every respawn kills
    /// and reaps its predecessor, and releasing the pool kills what is left.
    #[test]
    #[ignore = "requires FFmpeg"]
    fn rapid_seeking_leaves_no_orphaned_ffmpeg() {
        let Some(ffmpeg) = require_or_skip_ffmpeg() else {
            return;
        };
        let Some(ffprobe) = ffprobe_beside(&ffmpeg) else {
            return;
        };
        let Ok(directory) = TempDir::new("orphans") else {
            return;
        };
        let Some(source) = write_source(&ffmpeg, directory.path()) else {
            return;
        };

        let pool = PreviewDecoderPool::new(ffmpeg, ffprobe);
        let mut seen_pids = Vec::new();

        for step in 0..30u64 {
            // Alternating far-apart targets so every request forces a respawn.
            let index = if step % 2 == 0 {
                step * 3
            } else {
                TEST_FRAMES - 1 - step * 3
            };
            pool.frame_at(&source, index as f64 / TEST_FPS, TEST_WIDTH, TEST_HEIGHT)
                .unwrap_or_else(|error| panic!("seek {step} must decode: {error}"));

            let slots = lock_recovering(&pool.slots);
            for slot in slots.iter() {
                if let Some(pid) = lock_recovering(&slot.decoder).child_pid {
                    if !seen_pids.contains(&pid) {
                        seen_pids.push(pid);
                    }
                }
            }
        }

        assert!(
            seen_pids.len() > 1,
            "the seeks must have respawned the decoder at least once"
        );

        pool.release_all();
        assert_eq!(pool.resident_count(), 0);

        let alive: Vec<u32> = seen_pids
            .into_iter()
            .filter(|pid| process_is_alive(*pid))
            .collect();
        assert!(
            alive.is_empty(),
            "every decoder FFmpeg must be dead after release, but {alive:?} are alive"
        );
    }

    /// Feature: resident preview decoding
    /// Scenario: the pool stays bounded and evicts the least recently used
    #[test]
    #[ignore = "requires FFmpeg"]
    fn the_pool_evicts_the_least_recently_used_decoder() {
        let Some(ffmpeg) = require_or_skip_ffmpeg() else {
            return;
        };
        let Some(ffprobe) = ffprobe_beside(&ffmpeg) else {
            return;
        };
        let Ok(directory) = TempDir::new("eviction") else {
            return;
        };
        let Some(source) = write_source(&ffmpeg, directory.path()) else {
            return;
        };

        let pool = PreviewDecoderPool::with_capacity(ffmpeg, ffprobe, 2);

        // Three distinct output sizes are three distinct decoders for one source.
        let sizes = [(160u32, 90u32), (80, 45), (40, 23)];
        let mut first_pid = None;
        for (index, (width, height)) in sizes.iter().enumerate() {
            pool.frame_at(&source, 0.0, *width, *height)
                .unwrap_or_else(|error| panic!("size {index} must decode: {error}"));

            assert!(
                pool.resident_count() <= 2,
                "the pool must never hold more than its capacity"
            );

            if index == 0 {
                let slots = lock_recovering(&pool.slots);
                first_pid = slots
                    .first()
                    .and_then(|slot| lock_recovering(&slot.decoder).child_pid);
            }
        }

        assert_eq!(pool.resident_count(), 2);

        let Some(first_pid) = first_pid else {
            panic!("the first decoder must have spawned a child");
        };
        assert!(
            !process_is_alive(first_pid),
            "the evicted decoder's FFmpeg must have been killed"
        );
    }

    /// Feature: resident preview decoding
    /// Scenario: dropping a decoder kills its child and closes the pipe
    ///
    /// On Windows a child that is merely disconnected from its pipes keeps
    /// running, so the kill has to come first and the read has to unblock.
    #[test]
    #[ignore = "requires FFmpeg"]
    fn dropping_the_pool_kills_the_child_and_closes_the_pipe() {
        let Some(ffmpeg) = require_or_skip_ffmpeg() else {
            return;
        };
        let Some(ffprobe) = ffprobe_beside(&ffmpeg) else {
            return;
        };
        let Ok(directory) = TempDir::new("drop") else {
            return;
        };
        let Some(source) = write_source(&ffmpeg, directory.path()) else {
            return;
        };

        let info = probe_source(&ffprobe, &source)
            .unwrap_or_else(|error| panic!("the source must probe: {error}"));
        let mut decoder =
            ResidentDecoder::new(ffmpeg, source.clone(), info, TEST_WIDTH, TEST_HEIGHT)
                .unwrap_or_else(|error| panic!("the decoder must build: {error}"));

        decoder
            .frame_at_index(0)
            .unwrap_or_else(|error| panic!("the first frame must decode: {error}"));
        let Some(pid) = decoder.child_pid else {
            panic!("a running decoder must report a child pid");
        };
        assert!(process_is_alive(pid), "the child must be running");

        drop(decoder);

        assert!(
            !process_is_alive(pid),
            "dropping the decoder must kill its FFmpeg"
        );
    }

    /// Feature: resident preview decoding
    /// Scenario: killing a child unblocks a read that is waiting on its pipe
    ///
    /// This is the assumption the read watchdog rests on, and the one most
    /// likely to differ on Windows: a blocking pipe read has no timeout of its
    /// own, so if killing the child did not close the pipe, a wedged decode
    /// would strand a blocking thread forever.
    #[test]
    #[ignore = "requires FFmpeg"]
    fn killing_a_child_unblocks_a_read_waiting_on_its_pipe() {
        let Some(ffmpeg) = require_or_skip_ffmpeg() else {
            return;
        };

        // `-re` paces the source at its own frame rate, so one frame a second
        // arrives and a request for twenty of them is guaranteed to be waiting.
        let mut command = std::process::Command::new(&ffmpeg);
        configure_std_command(&mut command);
        let spawned = command
            .args(["-hide_banner", "-loglevel", "error", "-nostdin", "-re"])
            .args(["-f", "lavfi", "-i", "testsrc2=size=64x64:rate=1"])
            .args(["-f", "rawvideo", "-pix_fmt", "rgba", "-"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn();

        let Ok(mut child) = spawned else {
            skip_without_ffmpeg("could not start a paced FFmpeg for the pipe test");
            return;
        };
        let Some(mut stdout) = child.stdout.take() else {
            let _ = child.kill();
            let _ = child.wait();
            panic!("a piped child must expose stdout");
        };

        let pid = child.id();
        let slot: ChildSlot = Arc::new(Mutex::new(Some(child)));
        let watchdog = ReadWatchdog::new(Arc::clone(&slot));

        // Twenty seconds of paced frames: the read cannot complete on its own.
        let mut buffer = vec![0u8; 64 * 64 * BYTES_PER_PIXEL * 20];
        watchdog.arm(Duration::from_millis(500));
        let started = Instant::now();
        let result = stdout.read_exact(&mut buffer);
        let elapsed = started.elapsed();
        watchdog.disarm();

        assert!(
            result.is_err(),
            "the read must have been cut short by the kill, not satisfied"
        );
        assert!(
            watchdog.fired(),
            "the watchdog must report that it was the one that ended the read"
        );
        assert!(
            elapsed < Duration::from_secs(10),
            "killing the child must unblock the read promptly, but it took {elapsed:?}"
        );
        assert!(
            !process_is_alive(pid),
            "the watchdog's kill must have taken effect"
        );

        drop(watchdog);
        let reaped = lock_recovering(&slot).take();
        if let Some(mut child) = reaped {
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    /// Feature: resident preview decoding
    /// Scenario: one watchdog thread serves every read of a decoder
    ///
    /// A thread spawned and joined per read costs two thread operations for
    /// every displayed frame on the path this module exists to make cheap.
    #[test]
    #[ignore = "requires FFmpeg"]
    fn the_watchdog_is_rearmed_rather_than_respawned_per_read() {
        let Some(ffmpeg) = require_or_skip_ffmpeg() else {
            return;
        };
        let Some(ffprobe) = ffprobe_beside(&ffmpeg) else {
            return;
        };
        let Ok(directory) = TempDir::new("rearm") else {
            return;
        };
        let Some(source) = write_source(&ffmpeg, directory.path()) else {
            return;
        };

        let info = probe_source(&ffprobe, &source)
            .unwrap_or_else(|error| panic!("the source must probe: {error}"));
        let mut decoder = ResidentDecoder::new(ffmpeg, source, info, TEST_WIDTH, TEST_HEIGHT)
            .unwrap_or_else(|error| panic!("the decoder must build: {error}"));

        let thread_id = decoder
            .watchdog
            .thread
            .as_ref()
            .map(|thread| thread.thread().id());
        assert!(
            thread_id.is_some(),
            "a decoder must start with a watchdog thread"
        );

        for index in 0..10u64 {
            decoder
                .frame_at_index(index)
                .unwrap_or_else(|error| panic!("frame {index} must decode: {error}"));
        }

        let after = decoder
            .watchdog
            .thread
            .as_ref()
            .map(|thread| thread.thread().id());
        assert_eq!(
            thread_id, after,
            "ten reads must have shared one watchdog thread"
        );
        assert!(
            !decoder.watchdog.fired(),
            "a healthy decode must not have tripped the watchdog"
        );
    }

    /// Feature: variable frame rate handling
    /// Scenario: a variable-rate source is recognised rather than averaged
    #[test]
    #[ignore = "requires FFmpeg"]
    fn a_variable_rate_source_is_probed_as_variable() {
        let Some(ffmpeg) = require_or_skip_ffmpeg() else {
            return;
        };
        let Some(ffprobe) = ffprobe_beside(&ffmpeg) else {
            return;
        };
        let Ok(directory) = TempDir::new("vfr-probe") else {
            return;
        };
        let Some(variable) = write_variable_rate_source(&ffmpeg, directory.path()) else {
            return;
        };
        let Some(constant) = write_source(&ffmpeg, directory.path()) else {
            return;
        };

        let variable_info = probe_source(&ffprobe, &variable)
            .unwrap_or_else(|error| panic!("the variable source must probe: {error}"));
        assert_eq!(
            variable_info.timing,
            SourceTiming::VariableRate,
            "a source whose average and base rates disagree must not be indexed by frame"
        );

        let constant_info = probe_source(&ffprobe, &constant)
            .unwrap_or_else(|error| panic!("the constant source must probe: {error}"));
        assert_eq!(
            constant_info.timing,
            SourceTiming::ConstantRate { fps: TEST_FPS },
            "an ordinary constant-rate source must keep the fast path"
        );
    }

    /// Feature: variable frame rate handling
    /// Scenario: a requested time returns the picture that time shows
    ///
    /// Reading the resident pipe forward on a variable-rate source shows the
    /// wrong frame immediately and then drifts further with every request, so
    /// these requests are compared against a plain per-request accurate seek —
    /// the extraction this module replaced — at increasing times, which is the
    /// pattern that made the drift unbounded.
    #[test]
    #[ignore = "requires FFmpeg"]
    fn a_variable_rate_source_does_not_drift_across_a_playback_sweep() {
        let Some(ffmpeg) = require_or_skip_ffmpeg() else {
            return;
        };
        let Some(ffprobe) = ffprobe_beside(&ffmpeg) else {
            return;
        };
        let Ok(directory) = TempDir::new("vfr-sweep") else {
            return;
        };
        let Some(source) = write_variable_rate_source(&ffmpeg, directory.path()) else {
            return;
        };

        let pool = PreviewDecoderPool::new(ffmpeg.clone(), ffprobe);

        // Through the 30 fps burst, across the rate change, and into the idle
        // stretch. Under the index mapping the average rate implies, the very
        // first of these already lands almost two seconds late.
        let times = [0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.7, 0.9, 1.1, 1.5, 2.1];
        for time in times {
            let frame = pool
                .frame_at(&source, time, TEST_WIDTH, TEST_HEIGHT)
                .unwrap_or_else(|error| panic!("frame at {time}s must decode: {error}"));

            let Some(expected) = seek_oracle(&ffmpeg, &source, time) else {
                panic!("the per-request seek oracle must produce a frame at {time}s");
            };

            assert_eq!(
                frame.pixels, expected,
                "the frame returned for {time}s is not the one an accurate seek returns"
            );
            assert_eq!(
                frame.frame_index, None,
                "a variable-rate source must not report a frame index"
            );
            assert!(
                (frame.source_time - time).abs() < 1e-6,
                "a variable-rate frame must answer for the time it was asked for, \
                 but {time}s came back as {}s",
                frame.source_time
            );
        }
    }

    /// Feature: variable frame rate handling
    /// Scenario: a variable-rate decode leaves no FFmpeg running behind it
    ///
    /// The per-request seek closes its pipe as soon as the frame is read,
    /// because nothing addressable is left in it.
    #[test]
    #[ignore = "requires FFmpeg"]
    fn a_variable_rate_decode_leaves_no_live_child() {
        let Some(ffmpeg) = require_or_skip_ffmpeg() else {
            return;
        };
        let Some(ffprobe) = ffprobe_beside(&ffmpeg) else {
            return;
        };
        let Ok(directory) = TempDir::new("vfr-lifecycle") else {
            return;
        };
        let Some(source) = write_variable_rate_source(&ffmpeg, directory.path()) else {
            return;
        };

        let pool = PreviewDecoderPool::new(ffmpeg, ffprobe);
        for time in [0.0, 0.2, 0.9, 1.5] {
            pool.frame_at(&source, time, TEST_WIDTH, TEST_HEIGHT)
                .unwrap_or_else(|error| panic!("frame at {time}s must decode: {error}"));

            let slots = lock_recovering(&pool.slots);
            for slot in slots.iter() {
                assert!(
                    lock_recovering(&slot.decoder).child_pid.is_none(),
                    "a variable-rate decode must not leave a child running between requests"
                );
            }
        }
    }

    /// Feature: resident preview decoding
    /// Scenario: requests past the end of a source stop spawning children
    ///
    /// A clip whose source range runs off the end of its media would otherwise
    /// pay a process spawn and an accurate seek for every rendered frame in the
    /// dead zone.
    #[test]
    #[ignore = "requires FFmpeg"]
    fn requests_past_the_end_stop_respawning() {
        let Some(ffmpeg) = require_or_skip_ffmpeg() else {
            return;
        };
        let Some(ffprobe) = ffprobe_beside(&ffmpeg) else {
            return;
        };
        let Ok(directory) = TempDir::new("past-end") else {
            return;
        };
        let Some(source) = write_source(&ffmpeg, directory.path()) else {
            return;
        };

        let info = probe_source(&ffprobe, &source)
            .unwrap_or_else(|error| panic!("the source must probe: {error}"));
        let mut decoder = ResidentDecoder::new(ffmpeg, source, info, TEST_WIDTH, TEST_HEIGHT)
            .unwrap_or_else(|error| panic!("the decoder must build: {error}"));

        // Well past the 120 frames the source holds.
        let beyond = TEST_FRAMES + 500;
        assert!(
            decoder.frame_at_index(beyond).is_err(),
            "there is no frame that far past the end"
        );
        assert_eq!(
            decoder.first_missing,
            Some(SeekTarget::Frame(beyond)),
            "the end of the source must be remembered"
        );
        assert!(
            decoder.child_pid.is_none(),
            "the failed decode's child must have been reaped, not left behind"
        );

        let started = Instant::now();
        assert!(decoder.frame_at_index(beyond + 10).is_err());
        assert!(
            started.elapsed() < Duration::from_millis(50),
            "a request past a known end must be refused without spawning anything"
        );

        // A frame that does exist proves the decoder is not walled off.
        decoder
            .frame_at_index(0)
            .unwrap_or_else(|error| panic!("frame 0 must still decode: {error}"));
        assert_eq!(
            decoder.first_missing, None,
            "a successful read must clear the remembered end"
        );
    }

    /// Feature: resident preview decoding
    /// Scenario: a decode that fails for a reason other than the end of the
    /// source does not wall off the addresses after it
    ///
    /// Only a clean end of stream means "there is nothing here". A child that
    /// died, was killed, or hit a bad frame must fail that one request; treating
    /// it as the end would make a forward sweep past a single bad frame report
    /// "no frame" for everything after it.
    #[test]
    #[ignore = "requires FFmpeg"]
    fn a_failed_decode_that_is_not_the_end_does_not_wall_off_later_frames() {
        let Some(ffmpeg) = require_or_skip_ffmpeg() else {
            return;
        };
        let Some(ffprobe) = ffprobe_beside(&ffmpeg) else {
            return;
        };
        let Ok(directory) = TempDir::new("mid-stream-failure") else {
            return;
        };
        let Some(source) = write_source(&ffmpeg, directory.path()) else {
            return;
        };

        let info = probe_source(&ffprobe, &source)
            .unwrap_or_else(|error| panic!("the source must probe: {error}"));
        let mut decoder = ResidentDecoder::new(ffmpeg, source, info, TEST_WIDTH, TEST_HEIGHT)
            .unwrap_or_else(|error| panic!("the decoder must build: {error}"));

        decoder
            .frame_at_index(10)
            .unwrap_or_else(|error| panic!("frame 10 must decode: {error}"));

        // A child that died mid-file — killed here, but a fatal decode error
        // ends it the same way — exits non-zero, which is what separates it from
        // a source that simply ran out of pictures.
        if let Some(child) = lock_recovering(&decoder.child).as_mut() {
            let _ = child.kill();
        }
        assert!(
            !decoder.child_finished_successfully(),
            "a child that died must not be read as a clean end of stream"
        );
        assert_eq!(
            decoder.first_missing, None,
            "nothing so far has proved the source ends anywhere"
        );

        // Reading past the actual end is the case that *is* the end: FFmpeg runs
        // out of pictures and exits reporting success.
        assert!(decoder.frame_at_index(TEST_FRAMES + 500).is_err());
        assert_eq!(
            decoder.first_missing,
            Some(SeekTarget::Frame(TEST_FRAMES + 500)),
            "a clean end of stream is the one failure worth remembering"
        );

        // And the addresses that do exist still work afterwards.
        decoder
            .frame_at_index(11)
            .unwrap_or_else(|error| panic!("frame 11 must still decode: {error}"));
        assert_eq!(decoder.first_missing, None);
    }

    /// Feature: resident preview decoding
    /// Scenario: releasing the pool does not let an in-flight read respawn
    ///
    /// Recovering from a dead child by re-seeking is what makes a crashed
    /// decoder self-healing, and it is exactly the wrong response to a
    /// deliberate release: it would start an FFmpeg the pool no longer tracks.
    #[test]
    #[ignore = "requires FFmpeg"]
    fn a_released_decoder_refuses_to_respawn() {
        let Some(ffmpeg) = require_or_skip_ffmpeg() else {
            return;
        };
        let Some(ffprobe) = ffprobe_beside(&ffmpeg) else {
            return;
        };
        let Ok(directory) = TempDir::new("released") else {
            return;
        };
        let Some(source) = write_source(&ffmpeg, directory.path()) else {
            return;
        };

        let pool = PreviewDecoderPool::new(ffmpeg, ffprobe);
        pool.frame_at(&source, 0.0, TEST_WIDTH, TEST_HEIGHT)
            .unwrap_or_else(|error| panic!("the first frame must decode: {error}"));

        let slot = {
            let slots = lock_recovering(&pool.slots);
            let Some(slot) = slots.first() else {
                panic!("a decoded frame must have left a resident decoder");
            };
            Arc::clone(slot)
        };

        pool.release_all();

        let mut decoder = lock_recovering(&slot.decoder);
        let outcome = decoder.frame_at_index(90);
        let child_pid = decoder.child_pid;
        drop(decoder);

        assert!(
            outcome.is_err(),
            "a released decoder must refuse the frame rather than start a new FFmpeg"
        );
        assert!(
            child_pid.is_none(),
            "a released decoder must not be holding a child"
        );
    }
}
