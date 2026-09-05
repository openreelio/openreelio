//! Audio Extraction Module
//!
//! Provides audio extraction functionality for transcription using FFmpeg.
//! Extracts audio as 16kHz mono WAV format suitable for Whisper.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Command;
use thiserror::Error;

use crate::core::ffmpeg::resolved_ffmpeg_path;
use crate::core::process::configure_std_command;
use crate::core::project::ProjectState;
use crate::core::render::{build_render_graph_with_audio_info, probe_sequence_audio_info};
use crate::core::timeline::AudioSettings;

// =============================================================================
// Error Types
// =============================================================================

/// Errors that can occur during audio extraction
#[derive(Error, Debug)]
pub enum AudioExtractionError {
    /// FFmpeg command failed to execute
    #[error("FFmpeg execution failed: {0}")]
    FFmpegFailed(String),

    /// FFmpeg command returned non-zero exit code
    #[error("FFmpeg process exited with error: {0}")]
    ProcessError(String),

    /// Input file not found
    #[error("Input file not found: {0}")]
    InputNotFound(String),

    /// Output directory does not exist
    #[error("Output directory does not exist: {0}")]
    OutputDirNotFound(String),

    /// Requested time range does not describe anything decodable
    #[error("Invalid range: {0}")]
    InvalidRange(String),

    /// IO error during file operations
    #[error("IO error: {0}")]
    IoError(#[from] std::io::Error),
}

/// Result type for audio extraction operations
pub type AudioResult<T> = Result<T, AudioExtractionError>;

/// A window of media or timeline time, in seconds.
///
/// Transcribing a 90-second excerpt of a 14-minute talk used to decode the whole
/// talk: the window is cut *before* Whisper runs, so the decode, the mixdown and
/// the inference all cost only the stretch under review. Segment timestamps stay
/// absolute — callers add [`Self::start`] back onto what Whisper reports.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct AudioWindow {
    start_sec: Option<f64>,
    end_sec: Option<f64>,
}

impl AudioWindow {
    /// The whole file or timeline.
    pub const FULL: Self = Self {
        start_sec: None,
        end_sec: None,
    };

    /// Builds a window, rejecting bounds that describe nothing decodable.
    pub fn new(start_sec: Option<f64>, end_sec: Option<f64>) -> AudioResult<Self> {
        if let Some(start) = start_sec {
            if !start.is_finite() || start < 0.0 {
                return Err(AudioExtractionError::InvalidRange(format!(
                    "Range start {start} must be a finite, non-negative number of seconds"
                )));
            }
        }
        if let Some(end) = end_sec {
            if !end.is_finite() || end <= 0.0 {
                return Err(AudioExtractionError::InvalidRange(format!(
                    "Range end {end} must be a finite, positive number of seconds"
                )));
            }
        }
        if let (Some(start), Some(end)) = (start_sec, end_sec) {
            if end <= start {
                return Err(AudioExtractionError::InvalidRange(format!(
                    "Range end {end} must be greater than range start {start}"
                )));
            }
        }

        Ok(Self { start_sec, end_sec })
    }

    /// Whether this window covers everything, so nothing needs trimming.
    pub fn is_full(&self) -> bool {
        self.start_sec.is_none() && self.end_sec.is_none()
    }

    /// The first second the window keeps; zero when it is open at the front.
    pub fn start(&self) -> f64 {
        self.start_sec.unwrap_or(0.0)
    }

    /// The declared end, if any.
    pub fn end(&self) -> Option<f64> {
        self.end_sec
    }

    /// The end of the window once the total length it applies to is known.
    pub fn resolved_end(&self, total_sec: f64) -> f64 {
        match self.end_sec {
            Some(end) => end.min(total_sec),
            None => total_sec,
        }
    }
}

/// Result metadata for sequence audio mixdown.
#[derive(Clone, Debug, PartialEq)]
pub struct SequenceAudioMixdownResult {
    /// Length of the rendered mixdown in seconds — the window's length, which is
    /// the whole sequence when no window was given.
    pub duration_sec: f64,
    /// Timeline second the mixdown starts at; add it to Whisper's segment times
    /// to put them back on the sequence's clock.
    pub start_sec: f64,
    /// Number of audible timeline audio layers mixed into the output.
    pub layer_count: usize,
}

// =============================================================================
// Audio Extraction Functions
// =============================================================================

/// Extracts audio from a video/audio file as 16kHz mono WAV for transcription.
///
/// # Arguments
///
/// * `input_path` - Path to the input video/audio file
/// * `output_path` - Path where the WAV file should be saved
/// * `ffmpeg_path` - Optional path to FFmpeg binary (defaults to the globally resolved path)
///
/// # Returns
///
/// Returns `Ok(())` on success, or an error if extraction fails.
///
/// # Example
///
/// ```rust,ignore
/// use crate::core::captions::audio::extract_audio_for_transcription;
///
/// extract_audio_for_transcription(
///     Path::new("/path/to/video.mp4"),
///     Path::new("/tmp/audio.wav"),
///     None,
/// )?;
/// ```
pub fn extract_audio_for_transcription(
    input_path: &Path,
    output_path: &Path,
    ffmpeg_path: Option<&str>,
) -> AudioResult<()> {
    extract_audio_range_for_transcription(input_path, output_path, AudioWindow::FULL, ffmpeg_path)
}

/// Extracts one window of a media file's audio as 16kHz mono WAV.
///
/// The window is applied on the FFmpeg command line, so only the requested
/// stretch is ever decoded. `window` is in *source* seconds; the WAV it writes
/// starts at zero, and callers add [`AudioWindow::start`] back onto the
/// timestamps Whisper reports.
pub fn extract_audio_range_for_transcription(
    input_path: &Path,
    output_path: &Path,
    window: AudioWindow,
    ffmpeg_path: Option<&str>,
) -> AudioResult<()> {
    // Validate input file exists
    if !input_path.exists() {
        return Err(AudioExtractionError::InputNotFound(
            input_path.to_string_lossy().to_string(),
        ));
    }

    // Validate output directory exists
    if let Some(parent) = output_path.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            return Err(AudioExtractionError::OutputDirNotFound(
                parent.to_string_lossy().to_string(),
            ));
        }
    }

    // Build FFmpeg command
    let ffmpeg = ffmpeg_path
        .map(PathBuf::from)
        .unwrap_or_else(resolved_ffmpeg_path);
    let mut cmd = Command::new(ffmpeg);
    configure_std_command(&mut cmd);

    // `-ss` in front of `-i` seeks the demuxer instead of decoding and throwing
    // frames away, which is what keeps a 90-second excerpt of a 14-minute talk
    // from costing the whole talk.
    let start_sec = window.start();
    if start_sec > 0.0 {
        cmd.args(["-ss", &format_filter_seconds(start_sec)]);
    }
    cmd.arg("-i").arg(input_path);
    if let Some(end_sec) = window.end() {
        cmd.args(["-t", &format_filter_seconds((end_sec - start_sec).max(0.0))]);
    }

    let output = cmd
        .args([
            "-ar",
            "16000", // 16kHz sample rate (required by Whisper)
            "-ac",
            "1", // Mono audio
            "-c:a",
            "pcm_s16le", // 16-bit PCM
            "-y",        // Overwrite output
            output_path.to_str().unwrap_or_default(),
        ])
        .output()?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(AudioExtractionError::ProcessError(stderr.to_string()));
    }

    Ok(())
}

/// One clip's contribution to a transcription mixdown, already narrowed to the
/// requested window.
struct MixdownLayer {
    asset_path: PathBuf,
    /// Placement inside the mixdown, relative to the window's start.
    output_in_sec: f64,
    output_out_sec: f64,
    source_in_sec: f64,
    source_out_sec: f64,
    /// Seconds of the clip's own head and tail the window cut away, used to
    /// carry over what is left of its fade envelope.
    trimmed_head_sec: f64,
    trimmed_tail_sec: f64,
    speed: f64,
    reverse: bool,
    audio: AudioSettings,
}

impl MixdownLayer {
    /// How many source seconds this layer reads, after the window trimmed it.
    fn source_span_sec(&self) -> f64 {
        (self.source_out_sec - self.source_in_sec).max(0.0)
    }
}

/// Renders the audible audio layers of a sequence to a 16kHz mono WAV for transcription.
///
/// Every clip that reaches the render with sound is mixed, including the
/// embedded audio of a clip sitting on a *video* track — the shape a headless
/// `timeline insert` of an A/V file produces. Audio presence is measured with
/// FFprobe rather than read from the stored asset metadata, because an asset
/// imported from its file extension carries none.
///
/// `window` is in timeline seconds. Clips outside it are never opened, and the
/// ones inside are trimmed to their overlap, so the decode costs only the
/// stretch being transcribed.
pub fn mix_sequence_audio_for_transcription(
    state: &ProjectState,
    sequence_id: &str,
    output_path: &Path,
    window: AudioWindow,
    ffmpeg_path: Option<&str>,
) -> AudioResult<SequenceAudioMixdownResult> {
    if let Some(parent) = output_path.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            return Err(AudioExtractionError::OutputDirNotFound(
                parent.to_string_lossy().to_string(),
            ));
        }
    }

    let audio_info = probe_sequence_audio_info(state, sequence_id);
    let graph = build_render_graph_with_audio_info(state, sequence_id, &audio_info)
        .map_err(|error| AudioExtractionError::FFmpegFailed(error.to_string()))?;
    if graph.duration_sec <= 0.0 {
        return Err(AudioExtractionError::FFmpegFailed(
            "Sequence duration is empty; nothing to transcribe".to_string(),
        ));
    }

    let window_start = window.start();
    let window_end = window.resolved_end(graph.duration_sec);
    if window_end <= window_start {
        return Err(AudioExtractionError::InvalidRange(format!(
            "Range {window_start}s-{window_end}s lies outside the sequence, which is {:.3}s long",
            graph.duration_sec
        )));
    }

    let mut audible_layers = Vec::new();
    for layer in &graph.audio_layers {
        if layer.audio.muted {
            continue;
        }
        if layer.timeline_out_sec <= layer.timeline_in_sec
            || layer.source_out_sec <= layer.source_in_sec
        {
            continue;
        }
        let asset = state.assets.get(&layer.asset_id).ok_or_else(|| {
            AudioExtractionError::InputNotFound(format!("Missing asset {}", layer.asset_id))
        })?;
        let asset_path = Path::new(&asset.uri);
        if !asset_path.exists() {
            return Err(AudioExtractionError::InputNotFound(asset.uri.clone()));
        }
        if let Some(narrowed) = narrow_layer_to_window(layer, asset_path, window_start, window_end)
        {
            audible_layers.push(narrowed);
        }
    }

    if audible_layers.is_empty() {
        return Err(AudioExtractionError::FFmpegFailed(
            "Sequence has no audible audio clips to transcribe".to_string(),
        ));
    }

    let ffmpeg = ffmpeg_path
        .map(PathBuf::from)
        .unwrap_or_else(resolved_ffmpeg_path);
    let mut cmd = Command::new(ffmpeg);
    configure_std_command(&mut cmd);
    cmd.args(build_sequence_mixdown_args(
        &audible_layers,
        window_end - window_start,
        output_path,
    ));

    let output = cmd.output()?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(AudioExtractionError::ProcessError(stderr.to_string()));
    }

    Ok(SequenceAudioMixdownResult {
        duration_sec: window_end - window_start,
        start_sec: window_start,
        layer_count: audible_layers.len(),
    })
}

/// Cuts a layer down to its overlap with the window, or drops it entirely.
///
/// The source range is narrowed by the same fraction as the timeline range, so
/// FFmpeg decodes only the seconds the window keeps. A reversed clip plays its
/// source backwards, so its timeline head maps to the *end* of the source range
/// and the fractions are mirrored.
fn narrow_layer_to_window(
    layer: &crate::core::render::AudioRenderLayer,
    asset_path: &Path,
    window_start: f64,
    window_end: f64,
) -> Option<MixdownLayer> {
    let clip_start = layer.timeline_in_sec;
    let clip_end = layer.timeline_out_sec;
    let kept_start = clip_start.max(window_start);
    let kept_end = clip_end.min(window_end);
    if kept_end <= kept_start {
        return None;
    }

    let clip_duration = clip_end - clip_start;
    let head_fraction = ((kept_start - clip_start) / clip_duration).clamp(0.0, 1.0);
    let tail_fraction = ((kept_end - clip_start) / clip_duration).clamp(0.0, 1.0);
    let source_span = layer.source_out_sec - layer.source_in_sec;
    let (source_in_sec, source_out_sec) = if layer.reverse {
        (
            layer.source_out_sec - tail_fraction * source_span,
            layer.source_out_sec - head_fraction * source_span,
        )
    } else {
        (
            layer.source_in_sec + head_fraction * source_span,
            layer.source_in_sec + tail_fraction * source_span,
        )
    };
    if source_out_sec <= source_in_sec {
        return None;
    }

    let speed = if layer.speed.is_finite() && layer.speed > 0.0 {
        layer.speed as f64
    } else {
        1.0
    };

    Some(MixdownLayer {
        asset_path: asset_path.to_path_buf(),
        output_in_sec: kept_start - window_start,
        output_out_sec: kept_end - window_start,
        source_in_sec,
        source_out_sec,
        trimmed_head_sec: kept_start - clip_start,
        trimmed_tail_sec: clip_end - kept_end,
        speed,
        reverse: layer.reverse,
        audio: layer.audio.clone(),
    })
}

/// Builds the FFmpeg arguments for one transcription mixdown.
///
/// Every layer gets its own `-ss`/`-t` in front of its `-i`, so FFmpeg seeks the
/// demuxer and reads only the stretch the window kept — the same reason
/// [`extract_audio_range_for_transcription`] does it. Without them a ranged
/// `generate-sequence` still decoded every input end to end and let `atrim`
/// throw the rest away, so transcribing ninety seconds of a fourteen-minute talk
/// cost the whole talk.
///
/// An input `-ss` also rebases that input's timestamps to zero, which is why the
/// filtergraph's `atrim` measures from zero rather than from the layer's source
/// in point.
fn build_sequence_mixdown_args(
    audible_layers: &[MixdownLayer],
    output_duration_sec: f64,
    output_path: &Path,
) -> Vec<OsString> {
    let mut args: Vec<OsString> = vec!["-y".into(), "-hide_banner".into()];

    for layer in audible_layers {
        args.push("-ss".into());
        args.push(format_filter_seconds(layer.source_in_sec).into());
        args.push("-t".into());
        args.push(format_filter_seconds(layer.source_span_sec()).into());
        args.push("-i".into());
        args.push(layer.asset_path.clone().into_os_string());
    }

    args.push("-filter_complex".into());
    args.push(build_sequence_mixdown_filter(audible_layers).into());
    args.push("-map".into());
    args.push("[aout]".into());
    args.push("-t".into());
    args.push(format_filter_seconds(output_duration_sec).into());
    args.push("-ar".into());
    args.push("16000".into());
    args.push("-ac".into());
    args.push("1".into());
    args.push("-c:a".into());
    args.push("pcm_s16le".into());
    args.push(output_path.as_os_str().to_os_string());

    args
}

fn build_sequence_mixdown_filter(audible_layers: &[MixdownLayer]) -> String {
    let mut filters = Vec::new();

    for (index, layer) in audible_layers.iter().enumerate() {
        // The input's own `-ss` already put the layer's source in point at zero,
        // so the trim is expressed as a span rather than as absolute source
        // seconds. Keeping it belt-and-braces guards against a demuxer that
        // seeks to the keyframe before the requested point.
        let mut chain = vec![
            format!(
                "[{index}:a]atrim=start=0:end={}",
                format_filter_seconds(layer.source_span_sec())
            ),
            "asetpts=PTS-STARTPTS".to_string(),
            "aresample=16000".to_string(),
            "aformat=channel_layouts=mono".to_string(),
        ];

        if layer.reverse {
            chain.push("areverse".to_string());
        }

        for tempo in atempo_chain(layer.speed) {
            chain.push(format!("atempo={}", format_filter_seconds(tempo)));
        }

        // The fade envelope belongs to the whole clip. When the window cut the
        // clip's head or tail away, what survives is whatever is left of each
        // ramp: a clip whose fade-in finished before the window opened fades no
        // more.
        let clip_duration = (layer.output_out_sec - layer.output_in_sec).max(0.0);
        let fade_in = (layer.audio.fade_in_sec - layer.trimmed_head_sec).clamp(0.0, clip_duration);
        if fade_in > 0.0 {
            chain.push(format!(
                "afade=t=in:st=0:d={}",
                format_filter_seconds(fade_in)
            ));
        }
        let fade_out =
            (layer.audio.fade_out_sec - layer.trimmed_tail_sec).clamp(0.0, clip_duration);
        if fade_out > 0.0 {
            let fade_start = (clip_duration - fade_out).max(0.0);
            chain.push(format!(
                "afade=t=out:st={}:d={}",
                format_filter_seconds(fade_start),
                format_filter_seconds(fade_out)
            ));
        }

        let volume = db_to_linear(layer.audio.volume_db);
        chain.push(format!("volume={}", format_filter_seconds(volume)));

        let delay_ms = (layer.output_in_sec.max(0.0) * 1000.0).round() as u64;
        if delay_ms > 0 {
            chain.push(format!("adelay={delay_ms}:all=1"));
        }

        filters.push(format!("{}[a{index}]", chain.join(",")));
    }

    let output_filter = if audible_layers.len() == 1 {
        "[a0]anull[aout]".to_string()
    } else {
        let inputs = (0..audible_layers.len())
            .map(|index| format!("[a{index}]"))
            .collect::<Vec<_>>()
            .join("");
        format!(
            "{inputs}amix=inputs={}:duration=longest:dropout_transition=0:normalize=0,alimiter=limit=0.95[aout]",
            audible_layers.len()
        )
    };
    filters.push(output_filter);

    filters.join(";")
}

fn atempo_chain(speed: f64) -> Vec<f64> {
    if !speed.is_finite() || (speed - 1.0).abs() < f64::EPSILON {
        return Vec::new();
    }

    let mut remaining = speed.clamp(0.01, 100.0);
    let mut chain = Vec::new();
    while remaining > 2.0 {
        chain.push(2.0);
        remaining /= 2.0;
    }
    while remaining < 0.5 {
        chain.push(0.5);
        remaining /= 0.5;
    }
    if (remaining - 1.0).abs() > 0.001 {
        chain.push(remaining);
    }
    chain
}

fn db_to_linear(db: f32) -> f64 {
    if !db.is_finite() {
        return 1.0;
    }
    10_f64.powf(db.clamp(-60.0, 24.0) as f64 / 20.0)
}

fn format_filter_seconds(value: f64) -> String {
    if !value.is_finite() {
        return "0".to_string();
    }
    let rounded = (value * 1_000_000.0).round() / 1_000_000.0;
    format!("{rounded:.6}")
        .trim_end_matches('0')
        .trim_end_matches('.')
        .to_string()
}

/// Extracts audio asynchronously using Tokio's spawn_blocking.
///
/// This is useful when you need to extract audio without blocking the async runtime.
///
/// # Arguments
///
/// * `input_path` - Path to the input video/audio file
/// * `output_path` - Path where the WAV file should be saved
/// * `ffmpeg_path` - Optional path to FFmpeg binary
///
/// # Returns
///
/// Returns `Ok(())` on success, or an error if extraction fails.
pub async fn extract_audio_for_transcription_async(
    input_path: &Path,
    output_path: &Path,
    ffmpeg_path: Option<&str>,
) -> AudioResult<()> {
    let input = input_path.to_path_buf();
    let output = output_path.to_path_buf();
    let ffmpeg = ffmpeg_path.map(|s| s.to_string());

    tokio::task::spawn_blocking(move || {
        extract_audio_for_transcription(&input, &output, ffmpeg.as_deref())
    })
    .await
    .map_err(|e| AudioExtractionError::FFmpegFailed(e.to_string()))?
}

/// Loads audio samples from a WAV file as f32 samples normalized to [-1.0, 1.0].
///
/// # Arguments
///
/// * `wav_path` - Path to the WAV file
///
/// # Returns
///
/// Returns a vector of f32 samples on success.
///
/// # Example
///
/// ```rust,ignore
/// let samples = load_audio_samples(Path::new("/tmp/audio.wav"))?;
/// println!("Loaded {} samples", samples.len());
/// ```
pub fn load_audio_samples(wav_path: &Path) -> AudioResult<Vec<f32>> {
    let reader = hound::WavReader::open(wav_path).map_err(|e| {
        AudioExtractionError::FFmpegFailed(format!("Failed to open WAV file: {}", e))
    })?;

    let spec = reader.spec();

    // Verify format is what we expect
    if spec.sample_rate != 16000 {
        return Err(AudioExtractionError::FFmpegFailed(format!(
            "Expected 16kHz sample rate, got {} Hz",
            spec.sample_rate
        )));
    }

    if spec.channels != 1 {
        return Err(AudioExtractionError::FFmpegFailed(format!(
            "Expected mono audio, got {} channels",
            spec.channels
        )));
    }

    // Read samples based on bit depth (propagate errors instead of silently dropping)
    let samples: Vec<f32> = match spec.bits_per_sample {
        16 => {
            let raw_samples: Vec<i16> = reader
                .into_samples::<i16>()
                .collect::<Result<Vec<i16>, _>>()
                .map_err(|e| {
                    AudioExtractionError::FFmpegFailed(format!(
                        "Failed to read audio samples: {}",
                        e
                    ))
                })?;
            raw_samples
                .into_iter()
                .map(|s| s as f32 / 32768.0)
                .collect()
        }
        32 => {
            let raw_samples: Vec<i32> = reader
                .into_samples::<i32>()
                .collect::<Result<Vec<i32>, _>>()
                .map_err(|e| {
                    AudioExtractionError::FFmpegFailed(format!(
                        "Failed to read audio samples: {}",
                        e
                    ))
                })?;
            raw_samples
                .into_iter()
                .map(|s| s as f32 / 2147483648.0)
                .collect()
        }
        bits => {
            return Err(AudioExtractionError::FFmpegFailed(format!(
                "Unsupported bit depth: {}",
                bits
            )));
        }
    };

    Ok(samples)
}

/// Loads audio samples from a WAV file as raw signed 16-bit PCM.
pub fn load_audio_samples_i16(wav_path: &Path) -> AudioResult<Vec<i16>> {
    let reader = hound::WavReader::open(wav_path).map_err(|e| {
        AudioExtractionError::FFmpegFailed(format!("Failed to open WAV file: {}", e))
    })?;

    let spec = reader.spec();

    if spec.sample_rate != 16000 {
        return Err(AudioExtractionError::FFmpegFailed(format!(
            "Expected 16kHz sample rate, got {} Hz",
            spec.sample_rate
        )));
    }

    if spec.channels != 1 {
        return Err(AudioExtractionError::FFmpegFailed(format!(
            "Expected mono audio, got {} channels",
            spec.channels
        )));
    }

    if spec.bits_per_sample != 16 {
        return Err(AudioExtractionError::FFmpegFailed(format!(
            "Expected 16-bit PCM audio, got {} bits per sample",
            spec.bits_per_sample
        )));
    }

    reader
        .into_samples::<i16>()
        .collect::<Result<Vec<i16>, _>>()
        .map_err(|e| {
            AudioExtractionError::FFmpegFailed(format!("Failed to read audio samples: {}", e))
        })
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::render::AudioRenderLayer;
    use std::fs::File;
    use std::io::Write;
    use tempfile::TempDir;

    #[test]
    fn test_extract_audio_input_not_found() {
        let result = extract_audio_for_transcription(
            Path::new("/nonexistent/video.mp4"),
            Path::new("/tmp/output.wav"),
            None,
        );

        assert!(result.is_err());
        assert!(matches!(
            result.unwrap_err(),
            AudioExtractionError::InputNotFound(_)
        ));
    }

    #[test]
    fn test_extract_audio_output_dir_not_found() {
        // Create a temp file as input
        let temp_dir = TempDir::new().unwrap();
        let input_path = temp_dir.path().join("input.txt");
        File::create(&input_path)
            .unwrap()
            .write_all(b"test")
            .unwrap();

        let result = extract_audio_for_transcription(
            &input_path,
            Path::new("/nonexistent/dir/output.wav"),
            None,
        );

        assert!(result.is_err());
        assert!(matches!(
            result.unwrap_err(),
            AudioExtractionError::OutputDirNotFound(_)
        ));
    }

    #[test]
    fn test_load_audio_samples_file_not_found() {
        let result = load_audio_samples(Path::new("/nonexistent/audio.wav"));
        assert!(result.is_err());
    }

    #[test]
    fn test_load_audio_samples_valid_wav() {
        let temp_dir = TempDir::new().unwrap();
        let wav_path = temp_dir.path().join("test.wav");

        // Create a valid 16kHz mono WAV file with hound
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: 16000,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };

        let mut writer = hound::WavWriter::create(&wav_path, spec).unwrap();

        // Write some test samples
        for i in 0..1600 {
            // 0.1 seconds of audio
            let sample = ((i as f32 / 100.0).sin() * 16000.0) as i16;
            writer.write_sample(sample).unwrap();
        }
        writer.finalize().unwrap();

        // Load and verify
        let samples = load_audio_samples(&wav_path).unwrap();
        assert_eq!(samples.len(), 1600);
        assert!(samples.iter().all(|&s| (-1.0..=1.0).contains(&s)));
    }

    #[test]
    fn test_load_audio_samples_i16_valid_wav() {
        let temp_dir = TempDir::new().unwrap();
        let wav_path = temp_dir.path().join("test_i16.wav");

        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: 16000,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };

        let mut writer = hound::WavWriter::create(&wav_path, spec).unwrap();
        for i in 0..320 {
            writer.write_sample((i as i16) - 160).unwrap();
        }
        writer.finalize().unwrap();

        let samples = load_audio_samples_i16(&wav_path).unwrap();
        assert_eq!(samples.len(), 320);
        assert_eq!(samples[0], -160);
        assert_eq!(samples[319], 159);
    }

    #[test]
    fn test_load_audio_wrong_sample_rate() {
        let temp_dir = TempDir::new().unwrap();
        let wav_path = temp_dir.path().join("wrong_rate.wav");

        // Create a WAV with wrong sample rate
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: 44100, // Wrong rate
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };

        let mut writer = hound::WavWriter::create(&wav_path, spec).unwrap();
        writer.write_sample(0i16).unwrap();
        writer.finalize().unwrap();

        let result = load_audio_samples(&wav_path);
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("16kHz"));
    }

    #[test]
    fn test_load_audio_wrong_channels() {
        let temp_dir = TempDir::new().unwrap();
        let wav_path = temp_dir.path().join("stereo.wav");

        // Create a stereo WAV
        let spec = hound::WavSpec {
            channels: 2, // Stereo
            sample_rate: 16000,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };

        let mut writer = hound::WavWriter::create(&wav_path, spec).unwrap();
        writer.write_sample(0i16).unwrap();
        writer.write_sample(0i16).unwrap();
        writer.finalize().unwrap();

        let result = load_audio_samples(&wav_path);
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("mono"));
    }

    #[test]
    fn test_atempo_chain_splits_extreme_speeds() {
        assert_eq!(atempo_chain(1.0), Vec::<f64>::new());
        assert_eq!(atempo_chain(4.0), vec![2.0, 2.0]);
        assert_eq!(atempo_chain(0.25), vec![0.5, 0.5]);
    }

    #[test]
    fn test_format_filter_seconds_trims_noise() {
        assert_eq!(format_filter_seconds(1.5), "1.5");
        assert_eq!(format_filter_seconds(0.0), "0");
        assert_eq!(format_filter_seconds(f64::NAN), "0");
    }

    /// An audio layer covering `[timeline_in, timeline_out]` of a source range
    /// of the same length, playing forward at 1x.
    fn layer(timeline_in_sec: f64, timeline_out_sec: f64, source_in_sec: f64) -> AudioRenderLayer {
        AudioRenderLayer {
            track_id: "track".to_string(),
            track_index: 0,
            clip_id: "clip".to_string(),
            asset_id: "asset".to_string(),
            timeline_in_sec,
            timeline_out_sec,
            timeline_in_frame: 0,
            timeline_out_frame: 0,
            duration_frames: 0,
            source_in_sec,
            source_out_sec: source_in_sec + (timeline_out_sec - timeline_in_sec),
            source_in_frame: 0,
            source_out_frame: 0,
            speed: 1.0,
            reverse: false,
            audio: AudioSettings::default(),
            effects: Vec::new(),
        }
    }

    #[test]
    fn audio_window_rejects_bounds_that_describe_nothing() {
        assert!(AudioWindow::new(Some(-1.0), None).is_err());
        assert!(AudioWindow::new(None, Some(0.0)).is_err());
        assert!(AudioWindow::new(Some(5.0), Some(5.0)).is_err());
        assert!(AudioWindow::new(Some(6.0), Some(5.0)).is_err());
        assert!(AudioWindow::new(Some(f64::NAN), None).is_err());
    }

    #[test]
    fn audio_window_reports_its_bounds() {
        assert!(AudioWindow::FULL.is_full());
        assert_eq!(AudioWindow::FULL.start(), 0.0);
        assert_eq!(AudioWindow::FULL.resolved_end(9.0), 9.0);

        let window = AudioWindow::new(Some(2.0), Some(5.0)).expect("window");
        assert!(!window.is_full());
        assert_eq!(window.start(), 2.0);
        assert_eq!(window.end(), Some(5.0));
        // A window reaching past the material it applies to stops at the end.
        assert_eq!(window.resolved_end(4.0), 4.0);
        assert_eq!(window.resolved_end(9.0), 5.0);
    }

    #[test]
    fn narrow_layer_drops_a_clip_the_window_never_reaches() {
        let clip = layer(0.0, 2.0, 0.0);
        assert!(narrow_layer_to_window(&clip, Path::new("a.wav"), 5.0, 8.0).is_none());
        // Touching the window's edge is not overlap.
        assert!(narrow_layer_to_window(&clip, Path::new("a.wav"), 2.0, 8.0).is_none());
    }

    #[test]
    fn narrow_layer_trims_source_and_placement_to_the_window() {
        // Clip 10s-20s of the timeline, playing source 30s-40s. The window
        // 12s-18s keeps the middle six seconds of both.
        let clip = layer(10.0, 20.0, 30.0);
        let narrowed =
            narrow_layer_to_window(&clip, Path::new("a.wav"), 12.0, 18.0).expect("overlap");

        assert!((narrowed.source_in_sec - 32.0).abs() < 1e-9);
        assert!((narrowed.source_out_sec - 38.0).abs() < 1e-9);
        // Placement is relative to the window, which is where the mixdown's
        // own clock starts.
        assert!((narrowed.output_in_sec - 0.0).abs() < 1e-9);
        assert!((narrowed.output_out_sec - 6.0).abs() < 1e-9);
        assert!((narrowed.trimmed_head_sec - 2.0).abs() < 1e-9);
        assert!((narrowed.trimmed_tail_sec - 2.0).abs() < 1e-9);
    }

    #[test]
    fn narrow_layer_mirrors_the_source_range_of_a_reversed_clip() {
        // Played backwards, the clip's timeline head is the source's tail.
        let mut clip = layer(10.0, 20.0, 30.0);
        clip.reverse = true;
        let narrowed =
            narrow_layer_to_window(&clip, Path::new("a.wav"), 12.0, 18.0).expect("overlap");

        assert!((narrowed.source_in_sec - 32.0).abs() < 1e-9);
        assert!((narrowed.source_out_sec - 38.0).abs() < 1e-9);

        let narrowed =
            narrow_layer_to_window(&clip, Path::new("a.wav"), 0.0, 12.0).expect("overlap");
        assert!((narrowed.source_in_sec - 38.0).abs() < 1e-9);
        assert!((narrowed.source_out_sec - 40.0).abs() < 1e-9);
    }

    #[test]
    fn mixdown_filter_offsets_a_clip_by_its_position_inside_the_window() {
        let clip = layer(10.0, 20.0, 30.0);
        let narrowed =
            narrow_layer_to_window(&clip, Path::new("a.wav"), 8.0, 18.0).expect("overlap");
        let filter = build_sequence_mixdown_filter(std::slice::from_ref(&narrowed));

        // Two seconds into the window, not ten seconds into the sequence.
        assert!(filter.contains("adelay=2000:all=1"), "{filter}");
        // The input's own `-ss` put source second 30 at zero, so the trim is the
        // eight-second span the window kept rather than 30s-38s.
        assert!(filter.contains("atrim=start=0:end=8"), "{filter}");
    }

    #[test]
    fn mixdown_args_seek_each_input_to_the_stretch_the_window_kept() {
        // Two clips, each reading a different part of its source. Without a
        // per-input `-ss` FFmpeg would decode both files end to end and let
        // `atrim` discard the rest, which is what made a ranged
        // `generate-sequence` cost the whole talk.
        let first =
            narrow_layer_to_window(&layer(10.0, 20.0, 30.0), Path::new("a.mp4"), 12.0, 18.0)
                .expect("overlap");
        let second =
            narrow_layer_to_window(&layer(14.0, 24.0, 100.0), Path::new("b.mp4"), 12.0, 18.0)
                .expect("overlap");

        let args = build_sequence_mixdown_args(&[first, second], 6.0, Path::new("out.wav"))
            .into_iter()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>();

        let input_positions = args
            .iter()
            .enumerate()
            .filter(|(_, arg)| arg.as_str() == "-i")
            .map(|(index, _)| index)
            .collect::<Vec<_>>();
        assert_eq!(input_positions.len(), 2, "{args:?}");

        // `-ss <in> -t <span>` sits immediately in front of each `-i`.
        assert_eq!(args[input_positions[0] - 4], "-ss");
        assert_eq!(args[input_positions[0] - 3], "32");
        assert_eq!(args[input_positions[0] - 2], "-t");
        assert_eq!(args[input_positions[0] - 1], "6");
        assert_eq!(args[input_positions[0] + 1], "a.mp4");

        assert_eq!(args[input_positions[1] - 4], "-ss");
        assert_eq!(args[input_positions[1] - 3], "100");
        assert_eq!(args[input_positions[1] - 2], "-t");
        assert_eq!(args[input_positions[1] - 1], "4");
        assert_eq!(args[input_positions[1] + 1], "b.mp4");

        // The output still runs for the window's own length.
        assert_eq!(args.last().map(String::as_str), Some("out.wav"));
        assert!(args.windows(2).any(|pair| pair == ["-map", "[aout]"]));
    }

    #[test]
    fn mixdown_filter_keeps_only_the_part_of_a_fade_the_window_left() {
        // A one-second fade-in whose first 0.4s the window cut away still has
        // 0.6s to run; a fade the window cut away entirely runs no more.
        let mut clip = layer(10.0, 20.0, 30.0);
        clip.audio.fade_in_sec = 1.0;
        let narrowed =
            narrow_layer_to_window(&clip, Path::new("a.wav"), 10.4, 20.0).expect("overlap");
        let filter = build_sequence_mixdown_filter(std::slice::from_ref(&narrowed));
        assert!(filter.contains("afade=t=in:st=0:d=0.6"), "{filter}");

        let narrowed =
            narrow_layer_to_window(&clip, Path::new("a.wav"), 12.0, 20.0).expect("overlap");
        let filter = build_sequence_mixdown_filter(std::slice::from_ref(&narrowed));
        assert!(!filter.contains("afade=t=in"), "{filter}");
    }
}

#[cfg(test)]
mod ffmpeg_backed_tests {
    //! Tests that put a real FFmpeg behind the transcription mixdown.
    //!
    //! They are `#[ignore]`d because they need a binary the machine may not
    //! have; `require_or_skip_ffmpeg` turns the skip into a failure when
    //! `REQUIRE_FFMPEG_TESTS` is set, so a CI job that installs FFmpeg cannot
    //! report green without having run them.

    use super::*;
    use crate::core::assets::{Asset, VideoInfo};
    use crate::core::test_ffmpeg::{require_or_skip_ffmpeg, skip_without_ffmpeg};
    use crate::core::timeline::{Clip, ClipPlace, ClipRange, Sequence, SequenceFormat, Track};

    /// Writes a four-second A/V file: black picture with a 440 Hz tone.
    ///
    /// Returns `false` when FFmpeg could not produce it, which is the same
    /// "skip quietly" answer a missing binary gives.
    fn write_av_fixture(ffmpeg: &Path, path: &Path) -> bool {
        let mut cmd = Command::new(ffmpeg);
        configure_std_command(&mut cmd);
        let output = cmd
            .args([
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                "color=c=black:s=160x90:r=25:d=4",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:sample_rate=44100:duration=4",
                "-pix_fmt",
                "yuv420p",
                "-shortest",
            ])
            .arg(path)
            .output();

        matches!(output, Ok(output) if output.status.success()) && path.exists()
    }

    /// A project holding `asset_path` as one clip on the sequence's video track.
    ///
    /// The asset carries no audio metadata, which is exactly what the CLI's
    /// `asset import` records for a file it never opened. Whether the mixdown
    /// finds the sound therefore depends on it probing rather than trusting the
    /// stored guess.
    fn state_with_av_clip_on_a_video_track(asset_path: &Path) -> ProjectState {
        let mut state = ProjectState::new("Mixdown Test");
        state.sequences.clear();

        let mut asset = Asset::new_video(
            "fixture",
            &asset_path.to_string_lossy(),
            VideoInfo::default(),
        );
        asset.id = "asset-av".to_string();
        assert!(
            asset.audio.is_none(),
            "the fixture stands in for an unprobed import"
        );
        state.assets.insert(asset.id.clone(), asset);

        let mut clip = Clip::new("asset-av");
        clip.id = "clip-av".to_string();
        clip.place = ClipPlace::new(0.0, 4.0);
        clip.range = ClipRange::new(0.0, 4.0);

        let mut sequence = Sequence::new("Sequence", SequenceFormat::youtube_1080());
        sequence.id = "seq-1".to_string();
        let mut video_track = Track::new("Video 1", crate::core::timeline::TrackKind::Video);
        video_track.id = "video-track".to_string();
        video_track.clips.push(clip);
        sequence.tracks.push(video_track);

        state.active_sequence_id = Some(sequence.id.clone());
        state.sequences.insert(sequence.id.clone(), sequence);
        state
    }

    /// The loudest sample in a mixdown, as a fraction of full scale.
    fn peak_amplitude(samples: &[f32]) -> f32 {
        samples
            .iter()
            .fold(0.0_f32, |peak, sample| peak.max(sample.abs()))
    }

    #[test]
    #[ignore = "requires FFmpeg"]
    fn mixdown_captures_the_sound_of_an_av_clip_on_a_video_track() {
        let Some(ffmpeg) = require_or_skip_ffmpeg() else {
            return;
        };
        let Ok(dir) = tempfile::tempdir() else {
            skip_without_ffmpeg("a temporary directory could not be created");
            return;
        };

        let source_path = dir.path().join("av_source.mp4");
        if !write_av_fixture(&ffmpeg, &source_path) {
            skip_without_ffmpeg("FFmpeg could not build the A/V fixture");
            return;
        }

        let state = state_with_av_clip_on_a_video_track(&source_path);
        let output_path = dir.path().join("mixdown.wav");
        let result = mix_sequence_audio_for_transcription(
            &state,
            "seq-1",
            &output_path,
            AudioWindow::FULL,
            ffmpeg.to_str(),
        )
        .expect("the embedded audio of a video-track clip has to reach the mixdown");

        assert_eq!(result.layer_count, 1);
        assert!((result.duration_sec - 4.0).abs() < 0.5, "{result:?}");

        let samples = load_audio_samples(&output_path).expect("mixdown is a 16 kHz mono WAV");
        assert!(!samples.is_empty(), "the mixdown wrote no samples");
        let peak = peak_amplitude(&samples);
        assert!(
            peak > 0.1,
            "a 440 Hz tone must not transcribe as silence: peak {peak}"
        );
    }

    #[test]
    #[ignore = "requires FFmpeg"]
    fn mixdown_of_a_window_reads_only_that_window() {
        let Some(ffmpeg) = require_or_skip_ffmpeg() else {
            return;
        };
        let Ok(dir) = tempfile::tempdir() else {
            skip_without_ffmpeg("a temporary directory could not be created");
            return;
        };

        let source_path = dir.path().join("av_source.mp4");
        if !write_av_fixture(&ffmpeg, &source_path) {
            skip_without_ffmpeg("FFmpeg could not build the A/V fixture");
            return;
        }

        let state = state_with_av_clip_on_a_video_track(&source_path);
        let output_path = dir.path().join("window.wav");
        let window = AudioWindow::new(Some(1.0), Some(3.0)).expect("window");
        let result = mix_sequence_audio_for_transcription(
            &state,
            "seq-1",
            &output_path,
            window,
            ffmpeg.to_str(),
        )
        .expect("mixdown");

        assert!((result.duration_sec - 2.0).abs() < 0.2, "{result:?}");
        assert_eq!(result.start_sec, 1.0);

        let samples = load_audio_samples(&output_path).expect("mixdown is a 16 kHz mono WAV");
        // Two seconds at 16 kHz, give or take a resampler's tail.
        assert!(samples.len() > 16_000, "{} samples", samples.len());
        assert!(samples.len() < 48_000, "{} samples", samples.len());
        assert!(
            peak_amplitude(&samples) > 0.1,
            "the window must carry sound"
        );
    }
}
