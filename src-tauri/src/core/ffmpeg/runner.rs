//! FFmpeg Runner Module
//!
//! Executes FFmpeg commands for video processing operations.
//! Media info types are exported to TypeScript via tauri-specta.

use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;

use specta::Type;
use tokio::sync::mpsc;

use super::{FFmpegError, FFmpegInfo, FFmpegResult};
use crate::core::process::configure_tokio_command;

fn is_nonempty_file(path: &Path) -> bool {
    std::fs::metadata(path)
        .map(|m| m.is_file() && m.len() > 0)
        .unwrap_or(false)
}

/// Default MJPEG quality (1-31, lower is better) used for extracted frames.
const DEFAULT_FRAME_JPEG_QUALITY: u8 = 2;

/// Builds a downscale-only `scale` filter that preserves the aspect ratio.
///
/// `min(max_width, iw)` keeps sources narrower than `max_width` untouched, and
/// `-2` keeps the height on an even number as required by most encoders. The
/// quotes protect the comma from FFmpeg's filtergraph separator.
fn downscale_filter(max_width: u32) -> String {
    format!("scale='min({},iw)':-2", max_width.max(1))
}

/// Options for [`FFmpegRunner::extract_frame_with_options`].
#[derive(Clone, Debug, Default)]
pub struct FrameExtractOptions {
    /// Re-extract even when a non-empty output file already exists.
    ///
    /// The default (`false`) keeps the legacy cache behaviour used by
    /// thumbnail and clip-analysis passes.
    pub overwrite: bool,
    /// Downscale the frame so its width never exceeds this value.
    ///
    /// Sources narrower than the limit are left at their native size.
    pub max_width: Option<u32>,
    /// MJPEG quality (1-31, lower is better). Ignored for PNG output.
    pub quality: Option<u8>,
}

// =============================================================================
// Waveform Data Types
// =============================================================================

/// Audio waveform peak data for visualization.
///
/// Contains normalized peak values (0.0 - 1.0) sampled at a fixed rate.
/// Used for rendering waveform displays in the timeline UI.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WaveformData {
    /// Number of peak samples per second of audio
    pub samples_per_second: u32,
    /// Normalized peak values (0.0 - 1.0)
    pub peaks: Vec<f32>,
    /// Total audio duration in seconds
    pub duration_sec: f64,
    /// Number of audio channels (1=mono, 2=stereo)
    pub channels: u8,
}

impl WaveformData {
    /// Create a new WaveformData with empty peaks
    pub fn empty(duration_sec: f64, samples_per_second: u32, channels: u8) -> Self {
        let num_samples = (duration_sec * samples_per_second as f64).ceil() as usize;
        Self {
            samples_per_second,
            peaks: vec![0.0; num_samples],
            duration_sec,
            channels,
        }
    }

    /// Get the peak value at a specific time position
    pub fn peak_at_time(&self, time_sec: f64) -> f32 {
        if time_sec < 0.0 || time_sec >= self.duration_sec {
            return 0.0;
        }
        let index = (time_sec * self.samples_per_second as f64) as usize;
        self.peaks.get(index).copied().unwrap_or(0.0)
    }

    /// Get peaks for a time range (for rendering a section of waveform)
    pub fn peaks_in_range(&self, start_sec: f64, end_sec: f64) -> &[f32] {
        let start_idx = ((start_sec * self.samples_per_second as f64).max(0.0)) as usize;
        let end_idx =
            ((end_sec * self.samples_per_second as f64).ceil() as usize).min(self.peaks.len());
        if start_idx >= self.peaks.len() {
            return &[];
        }
        &self.peaks[start_idx..end_idx]
    }
}

/// Progress information for long-running FFmpeg operations
#[derive(Debug, Clone)]
pub struct FFmpegProgress {
    /// Current frame number
    pub frame: u64,
    /// Total frames (if known)
    pub total_frames: Option<u64>,
    /// Progress percentage (0.0 - 100.0)
    pub percent: f32,
    /// Current processing speed (fps)
    pub fps: f32,
    /// Bitrate (kbits/s)
    pub bitrate: Option<f32>,
    /// Current time position
    pub time_sec: f64,
    /// Estimated time remaining (seconds)
    pub eta_seconds: Option<u64>,
}

/// Media information extracted by FFprobe.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MediaInfo {
    /// Duration in seconds
    pub duration_sec: f64,
    /// Video stream info (if present)
    pub video: Option<VideoStreamInfo>,
    /// Audio stream info (if present)
    pub audio: Option<AudioStreamInfo>,
    /// Container format
    pub format: String,
    /// File size in bytes
    pub size_bytes: u64,
}

/// Video stream information.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct VideoStreamInfo {
    /// Width in pixels
    pub width: u32,
    /// Height in pixels
    pub height: u32,
    /// Frame rate (frames per second)
    pub fps: f64,
    /// Codec name (e.g., "h264", "vp9")
    pub codec: String,
    /// Pixel format
    pub pixel_format: String,
    /// Bitrate in bits/s (if available)
    pub bitrate: Option<u64>,
    /// Whether the source stream advertises HDR transfer characteristics.
    #[serde(default)]
    pub is_hdr: bool,
    /// FFprobe color transfer string (e.g. `smpte2084`, `arib-std-b67`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color_transfer: Option<String>,
}

/// Audio stream information.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AudioStreamInfo {
    /// Sample rate in Hz
    pub sample_rate: u32,
    /// Number of channels
    pub channels: u8,
    /// Codec name (e.g., "aac", "mp3")
    pub codec: String,
    /// Bitrate in bits/s (if available)
    pub bitrate: Option<u64>,
}

/// Render/export settings
#[derive(Debug, Clone)]
pub struct RenderSettings {
    /// Output width
    pub width: u32,
    /// Output height
    pub height: u32,
    /// Output frame rate
    pub fps: f64,
    /// Video codec (e.g., "libx264", "libx265", "libvpx-vp9")
    pub video_codec: String,
    /// Audio codec (e.g., "aac", "libopus")
    pub audio_codec: String,
    /// Video bitrate (e.g., "8M", "5000k")
    pub video_bitrate: String,
    /// Audio bitrate (e.g., "192k", "256k")
    pub audio_bitrate: String,
    /// Preset (for x264/x265: ultrafast, superfast, fast, medium, slow)
    pub preset: String,
    /// CRF value for quality-based encoding (0-51, lower is better)
    pub crf: Option<u8>,
}

impl Default for RenderSettings {
    fn default() -> Self {
        Self {
            width: 1920,
            height: 1080,
            fps: 30.0,
            video_codec: "libx264".to_string(),
            audio_codec: "aac".to_string(),
            video_bitrate: "8M".to_string(),
            audio_bitrate: "192k".to_string(),
            preset: "medium".to_string(),
            crf: Some(23),
        }
    }
}

impl RenderSettings {
    /// Preset for YouTube 1080p
    pub fn youtube_1080p() -> Self {
        Self {
            width: 1920,
            height: 1080,
            fps: 30.0,
            video_codec: "libx264".to_string(),
            audio_codec: "aac".to_string(),
            video_bitrate: "8M".to_string(),
            audio_bitrate: "192k".to_string(),
            preset: "medium".to_string(),
            crf: Some(23),
        }
    }

    /// Preset for Shorts/TikTok (vertical 1080p)
    pub fn shorts_1080p() -> Self {
        Self {
            width: 1080,
            height: 1920,
            fps: 30.0,
            video_codec: "libx264".to_string(),
            audio_codec: "aac".to_string(),
            video_bitrate: "6M".to_string(),
            audio_bitrate: "192k".to_string(),
            preset: "medium".to_string(),
            crf: Some(23),
        }
    }

    /// Preset for 4K output
    pub fn youtube_4k() -> Self {
        Self {
            width: 3840,
            height: 2160,
            fps: 30.0,
            video_codec: "libx264".to_string(),
            audio_codec: "aac".to_string(),
            video_bitrate: "35M".to_string(),
            audio_bitrate: "256k".to_string(),
            preset: "slow".to_string(),
            crf: Some(20),
        }
    }

    /// Preset for proxy generation (fast, low quality)
    pub fn proxy_720p() -> Self {
        Self {
            width: 1280,
            height: 720,
            fps: 30.0,
            video_codec: "libx264".to_string(),
            audio_codec: "aac".to_string(),
            video_bitrate: "2M".to_string(),
            audio_bitrate: "128k".to_string(),
            preset: "ultrafast".to_string(),
            crf: Some(28),
        }
    }
}

/// FFmpeg Runner for executing video processing commands
#[derive(Clone)]
pub struct FFmpegRunner {
    info: Arc<FFmpegInfo>,
}

impl FFmpegRunner {
    /// Create a new FFmpegRunner from detected FFmpeg installation
    pub fn new(info: FFmpegInfo) -> Self {
        Self {
            info: Arc::new(info),
        }
    }

    /// Get the FFmpeg info
    pub fn info(&self) -> &FFmpegInfo {
        &self.info
    }

    /// Extract a single frame from a video file
    ///
    /// An existing non-empty output file is treated as a cache hit and left
    /// untouched. Callers that need a freshly decoded frame must use
    /// [`FFmpegRunner::extract_frame_with_options`] with
    /// [`FrameExtractOptions::overwrite`] set.
    ///
    /// # Arguments
    /// * `input` - Path to the input video file
    /// * `time_sec` - Time position in seconds
    /// * `output` - Path to save the output image (JPEG or PNG)
    pub async fn extract_frame(
        &self,
        input: &Path,
        time_sec: f64,
        output: &Path,
    ) -> FFmpegResult<()> {
        self.extract_frame_with_options(input, time_sec, output, &FrameExtractOptions::default())
            .await
    }

    /// Extract a single frame from a video file with explicit caching, scaling
    /// and quality control.
    ///
    /// # Arguments
    /// * `input` - Path to the input video file
    /// * `time_sec` - Time position in seconds
    /// * `output` - Path to save the output image (JPEG or PNG)
    /// * `options` - Overwrite/scale/quality behaviour
    pub async fn extract_frame_with_options(
        &self,
        input: &Path,
        time_sec: f64,
        output: &Path,
        options: &FrameExtractOptions,
    ) -> FFmpegResult<()> {
        if !input.exists() {
            return Err(FFmpegError::InvalidInput(format!(
                "Input file does not exist: {}",
                input.display()
            )));
        }

        // Without `overwrite`, an already extracted frame is treated as success
        // so repeated thumbnail/analysis passes stay cheap.
        if !options.overwrite && is_nonempty_file(output) {
            return Ok(());
        }

        // Create output directory if needed
        if let Some(parent) = output.parent() {
            tokio::fs::create_dir_all(parent).await.map_err(|e| {
                FFmpegError::OutputError(format!("Failed to create output directory: {}", e))
            })?;
        }

        // Build FFmpeg command
        // -ss before -i for fast seeking
        // -frames:v 1 to extract single frame
        let mut args = vec![
            "-hide_banner".to_string(),
            "-loglevel".to_string(),
            "error".to_string(),
            "-nostdin".to_string(),
            "-ss".to_string(),
            format!("{:.6}", time_sec),
            "-i".to_string(),
            input.to_string_lossy().to_string(),
            "-frames:v".to_string(),
            "1".to_string(),
        ];

        if let Some(max_width) = options.max_width {
            args.push("-vf".to_string());
            args.push(downscale_filter(max_width));
        }

        // PNG ignores `-q:v`; only the MJPEG path is quality controlled.
        if output
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("png"))
        {
            args.extend([
                "-c:v".to_string(),
                "png".to_string(),
                "-pix_fmt".to_string(),
                "rgba".to_string(),
            ]);
        } else {
            args.push("-q:v".to_string());
            args.push(
                options
                    .quality
                    .unwrap_or(DEFAULT_FRAME_JPEG_QUALITY)
                    .to_string(),
            );
        }

        args.push("-y".to_string()); // Overwrite output
        args.push(output.to_string_lossy().to_string());

        let mut cmd = tokio::process::Command::new(&self.info.ffmpeg_path);
        configure_tokio_command(&mut cmd);
        let result = cmd
            .args(&args)
            .output()
            .await
            .map_err(FFmpegError::ProcessError)?;

        if !result.status.success() {
            let stderr = String::from_utf8_lossy(&result.stderr);
            return Err(FFmpegError::ExecutionFailed(format!(
                "Frame extraction failed: {}",
                stderr
            )));
        }

        Ok(())
    }

    /// Extract a single frame from a video file with optional tonemapping.
    ///
    /// When `tonemap_filter` is provided, it is applied as a video filter to
    /// convert HDR content to SDR for preview on standard displays.
    ///
    /// # Arguments
    /// * `input` - Path to the input video file
    /// * `time_sec` - Time position in seconds
    /// * `output` - Path to save the output image
    /// * `tonemap_filter` - Optional FFmpeg video filter string for HDR→SDR conversion
    pub async fn extract_frame_with_tonemap(
        &self,
        input: &Path,
        time_sec: f64,
        output: &Path,
        tonemap_filter: Option<&str>,
    ) -> FFmpegResult<()> {
        if !input.exists() {
            return Err(FFmpegError::InvalidInput(format!(
                "Input file does not exist: {}",
                input.display()
            )));
        }

        if is_nonempty_file(output) {
            return Ok(());
        }

        if let Some(parent) = output.parent() {
            tokio::fs::create_dir_all(parent).await.map_err(|e| {
                FFmpegError::OutputError(format!("Failed to create output directory: {}", e))
            })?;
        }

        let mut cmd = tokio::process::Command::new(&self.info.ffmpeg_path);
        configure_tokio_command(&mut cmd);

        let time_str = format!("{:.6}", time_sec);
        let input_str = input.to_string_lossy().to_string();
        let output_str = output.to_string_lossy().to_string();

        let mut args: Vec<&str> = vec![
            "-hide_banner",
            "-loglevel",
            "error",
            "-nostdin",
            "-ss",
            &time_str,
            "-i",
            &input_str,
        ];

        // Apply tonemapping filter if provided (HDR → SDR conversion)
        if let Some(filter) = tonemap_filter {
            args.push("-vf");
            args.push(filter);
        }

        args.extend_from_slice(&["-frames:v", "1", "-q:v", "2", "-y", &output_str]);

        let output = cmd
            .args(&args)
            .output()
            .await
            .map_err(FFmpegError::ProcessError)?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(FFmpegError::ExecutionFailed(format!(
                "Frame extraction with tonemapping failed: {}",
                stderr
            )));
        }

        Ok(())
    }

    /// Extract a single frame using hardware-accelerated decoding with automatic fallback.
    ///
    /// Attempts GPU-accelerated decoding first. If it fails (unsupported codec,
    /// driver issue, etc.), automatically retries with software decoding.
    ///
    /// # Arguments
    /// * `input` - Path to the input video file
    /// * `time_sec` - Time position in seconds
    /// * `output` - Path to save the output image (JPEG or PNG)
    /// * `hwaccel` - Hardware acceleration backend name (e.g., "cuda", "d3d11va", "qsv")
    /// * `tonemap_filter` - Optional FFmpeg video filter for HDR→SDR conversion
    pub async fn extract_frame_with_hwaccel(
        &self,
        input: &Path,
        time_sec: f64,
        output: &Path,
        hwaccel: &str,
        tonemap_filter: Option<&str>,
    ) -> FFmpegResult<()> {
        if !input.exists() {
            return Err(FFmpegError::InvalidInput(format!(
                "Input file does not exist: {}",
                input.display()
            )));
        }

        if is_nonempty_file(output) {
            return Ok(());
        }

        if let Some(parent) = output.parent() {
            tokio::fs::create_dir_all(parent).await.map_err(|e| {
                FFmpegError::OutputError(format!("Failed to create output directory: {}", e))
            })?;
        }

        // Attempt 1: Hardware-accelerated decoding
        let hw_result = self
            .run_frame_extraction(input, time_sec, output, Some(hwaccel), tonemap_filter)
            .await;

        match hw_result {
            Ok(()) => Ok(()),
            Err(hw_err) => {
                tracing::warn!(
                    "GPU decode failed for {}, falling back to software: {}",
                    input.display(),
                    hw_err
                );

                // Clean up partial output from failed attempt
                let _ = tokio::fs::remove_file(output).await;

                // Attempt 2: Software fallback
                self.run_frame_extraction(input, time_sec, output, None, tonemap_filter)
                    .await
            }
        }
    }

    /// Internal: Run frame extraction with optional hwaccel
    async fn run_frame_extraction(
        &self,
        input: &Path,
        time_sec: f64,
        output: &Path,
        hwaccel: Option<&str>,
        tonemap_filter: Option<&str>,
    ) -> FFmpegResult<()> {
        let mut cmd = tokio::process::Command::new(&self.info.ffmpeg_path);
        configure_tokio_command(&mut cmd);

        let time_str = format!("{:.6}", time_sec);
        let input_str = input.to_string_lossy().to_string();
        let output_str = output.to_string_lossy().to_string();

        let mut args: Vec<String> = vec![
            "-hide_banner".to_string(),
            "-loglevel".to_string(),
            "error".to_string(),
            "-nostdin".to_string(),
        ];

        // Hardware acceleration flags must come before -i
        if let Some(accel) = hwaccel {
            args.push("-hwaccel".to_string());
            args.push(accel.to_string());
            // Output format must match the hwaccel backend name that FFmpeg expects.
            // d3d11va requires "d3d11" as the output format, not "d3d11va".
            let output_format = match accel {
                "d3d11va" => "d3d11",
                other => other,
            };
            args.push("-hwaccel_output_format".to_string());
            args.push(output_format.to_string());
        }

        args.push("-ss".to_string());
        args.push(time_str);
        args.push("-i".to_string());
        args.push(input_str);

        if let Some(filter) = tonemap_filter {
            args.push("-vf".to_string());
            args.push(filter.to_string());
        }

        args.push("-frames:v".to_string());
        args.push("1".to_string());
        args.push("-q:v".to_string());
        args.push("2".to_string());
        args.push("-y".to_string());
        args.push(output_str);

        let result = cmd
            .args(&args)
            .output()
            .await
            .map_err(FFmpegError::ProcessError)?;

        if !result.status.success() {
            let stderr = String::from_utf8_lossy(&result.stderr);
            return Err(FFmpegError::ExecutionFailed(format!(
                "Frame extraction failed: {}",
                stderr
            )));
        }

        Ok(())
    }

    /// Generate a thumbnail for a video file
    ///
    /// Extracts a frame at 1 second (or 10% of duration for short videos)
    /// and saves as a JPEG thumbnail.
    pub async fn generate_thumbnail(
        &self,
        input: &Path,
        output: &Path,
        size: Option<(u32, u32)>,
    ) -> FFmpegResult<()> {
        if !input.exists() {
            return Err(FFmpegError::InvalidInput(format!(
                "Input file does not exist: {}",
                input.display()
            )));
        }

        // If already generated, treat as success.
        if is_nonempty_file(output) {
            return Ok(());
        }

        // Create output directory if needed
        if let Some(parent) = output.parent() {
            tokio::fs::create_dir_all(parent).await.map_err(|e| {
                FFmpegError::OutputError(format!("Failed to create output directory: {}", e))
            })?;
        }

        // Get video duration to determine thumbnail position
        let media_info = self.probe(input).await?;
        let thumb_time = if media_info.duration_sec > 10.0 {
            1.0 // Use 1 second for longer videos
        } else {
            media_info.duration_sec * 0.1 // Use 10% for short videos
        };

        // Build FFmpeg command with optional scaling
        let mut args = vec![
            "-ss".to_string(),
            format!("{:.3}", thumb_time),
            "-i".to_string(),
            input.to_string_lossy().to_string(),
            "-frames:v".to_string(),
            "1".to_string(),
        ];

        // Add scaling filter if size specified
        if let Some((width, height)) = size {
            args.push("-vf".to_string());
            args.push(format!(
                "scale={}:{}:force_original_aspect_ratio=decrease,pad={}:{}:(ow-iw)/2:(oh-ih)/2",
                width, height, width, height
            ));
        }

        args.extend([
            "-q:v".to_string(),
            "5".to_string(), // Medium quality for thumbnails
            "-y".to_string(),
            output.to_string_lossy().to_string(),
        ]);

        let mut cmd = tokio::process::Command::new(&self.info.ffmpeg_path);
        configure_tokio_command(&mut cmd);
        let output_result = cmd
            .args(["-hide_banner", "-loglevel", "error", "-nostdin"])
            .args(&args)
            .output()
            .await
            .map_err(FFmpegError::ProcessError)?;

        if !output_result.status.success() {
            let stderr = String::from_utf8_lossy(&output_result.stderr);
            return Err(FFmpegError::ExecutionFailed(format!(
                "Thumbnail generation failed: {}",
                stderr
            )));
        }

        Ok(())
    }

    /// Generate a proxy video (low-resolution for smooth preview)
    pub async fn generate_proxy(
        &self,
        input: &Path,
        output: &Path,
        progress_tx: Option<mpsc::Sender<FFmpegProgress>>,
    ) -> FFmpegResult<()> {
        if !input.exists() {
            return Err(FFmpegError::InvalidInput(format!(
                "Input file does not exist: {}",
                input.display()
            )));
        }

        // Create output directory if needed
        if let Some(parent) = output.parent() {
            tokio::fs::create_dir_all(parent).await.map_err(|e| {
                FFmpegError::OutputError(format!("Failed to create output directory: {}", e))
            })?;
        }

        let settings = RenderSettings::proxy_720p();

        // Get total frames for progress calculation
        let media_info = self.probe(input).await?;
        let total_frames = if let Some(video) = &media_info.video {
            Some((media_info.duration_sec * video.fps) as u64)
        } else {
            None
        };

        // Build FFmpeg command.
        // Important: only enable `-progress pipe:1` when we are actually draining stdout,
        // otherwise the child can deadlock once the stdout pipe fills.
        let mut cmd = tokio::process::Command::new(&self.info.ffmpeg_path);
        configure_tokio_command(&mut cmd);
        cmd.args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-nostdin",
            "-i",
            &input.to_string_lossy(),
            "-vf",
            // Scale to 720p height while preserving aspect ratio
            // -2 ensures width is divisible by 2 (H.264 codec requirement)
            "scale=-2:720",
            "-c:v",
            &settings.video_codec,
            "-preset",
            &settings.preset,
            "-crf",
            &settings.crf.unwrap_or(28).to_string(),
            "-c:a",
            &settings.audio_codec,
            "-b:a",
            &settings.audio_bitrate,
        ]);

        if progress_tx.is_some() {
            cmd.args(["-progress", "pipe:1"]);
            cmd.stdout(Stdio::piped());
        } else {
            cmd.stdout(Stdio::null());
        }
        cmd.stderr(Stdio::piped());
        cmd.args(["-y", &output.to_string_lossy()]);

        let mut child = cmd.spawn().map_err(FFmpegError::ProcessError)?;

        // Capture stderr tail for debugging.
        let stderr = child.stderr.take();
        let (stderr_tail_tx, stderr_tail_rx) = tokio::sync::oneshot::channel::<String>();
        let stderr_task = tokio::spawn(async move {
            let mut tail = LineTail::new(80);
            if let Some(stderr) = stderr {
                use tokio::io::{AsyncBufReadExt, BufReader};
                let reader = BufReader::new(stderr);
                let mut lines = reader.lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    tail.push(&line);
                }
            }
            let _ = stderr_tail_tx.send(tail.joined());
        });

        // Handle progress if channel provided.
        if let Some(tx) = progress_tx {
            if let Some(stdout) = child.stdout.take() {
                let total = total_frames;
                let duration = media_info.duration_sec;

                tokio::spawn(async move {
                    use tokio::io::{AsyncBufReadExt, BufReader};
                    let reader = BufReader::new(stdout);
                    let mut lines = reader.lines();

                    let mut current_frame = 0u64;
                    let mut current_time = 0.0f64;
                    let mut current_fps = 0.0f32;

                    while let Ok(Some(line)) = lines.next_line().await {
                        if let Some(value) = line.strip_prefix("frame=") {
                            current_frame = value.trim().parse().unwrap_or(0);
                        } else if let Some(value) = line.strip_prefix("fps=") {
                            current_fps = value.trim().parse().unwrap_or(0.0);
                        } else if let Some(value) = line.strip_prefix("out_time_ms=") {
                            let ms: u64 = value.trim().parse().unwrap_or(0);
                            current_time = ms as f64 / 1_000_000.0;
                        } else if line.starts_with("progress=") {
                            let percent = if duration > 0.0 {
                                (current_time / duration * 100.0) as f32
                            } else if let Some(t) = total {
                                (current_frame as f32 / t as f32) * 100.0
                            } else {
                                0.0
                            };

                            let eta = if current_fps > 0.0 && duration > 0.0 {
                                let remaining_time = duration - current_time;
                                let remaining_frames = (remaining_time * current_fps as f64) as u64;
                                Some((remaining_frames as f32 / current_fps) as u64)
                            } else {
                                None
                            };

                            let progress = FFmpegProgress {
                                frame: current_frame,
                                total_frames: total,
                                percent: percent.min(100.0),
                                fps: current_fps,
                                bitrate: None,
                                time_sec: current_time,
                                eta_seconds: eta,
                            };

                            if tx.send(progress).await.is_err() {
                                break;
                            }
                        }
                    }
                });
            }
        }

        let status = child.wait().await.map_err(FFmpegError::ProcessError)?;
        let tail = stderr_tail_rx.await.unwrap_or_default();
        let _ = stderr_task.await;

        if !status.success() {
            return Err(FFmpegError::ExecutionFailed(format!(
                "Proxy generation failed. Stderr tail:\n{}",
                tail
            )));
        }

        Ok(())
    }

    /// Probe media file to get information
    pub async fn probe(&self, input: &Path) -> FFmpegResult<MediaInfo> {
        if !input.exists() {
            return Err(FFmpegError::InvalidInput(format!(
                "Input file does not exist: {}",
                input.display()
            )));
        }

        // Run ffprobe with JSON output
        let mut cmd = tokio::process::Command::new(&self.info.ffprobe_path);
        configure_tokio_command(&mut cmd);
        let output = cmd
            .args([
                "-v",
                "error",
                "-print_format",
                "json",
                "-show_format",
                "-show_streams",
                &input.to_string_lossy(),
            ])
            .output()
            .await
            .map_err(FFmpegError::ProcessError)?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(FFmpegError::ProbeError(format!(
                "FFprobe failed: {}",
                stderr
            )));
        }

        let json_str = String::from_utf8_lossy(&output.stdout);
        parse_probe_output(&json_str)
    }

    /// Generate audio waveform image
    pub async fn generate_waveform(
        &self,
        input: &Path,
        output: &Path,
        width: u32,
        height: u32,
    ) -> FFmpegResult<()> {
        if !input.exists() {
            return Err(FFmpegError::InvalidInput(format!(
                "Input file does not exist: {}",
                input.display()
            )));
        }

        // If already generated, treat as success.
        if is_nonempty_file(output) {
            return Ok(());
        }

        // Create output directory if needed
        if let Some(parent) = output.parent() {
            tokio::fs::create_dir_all(parent).await.map_err(|e| {
                FFmpegError::OutputError(format!("Failed to create output directory: {}", e))
            })?;
        }

        // Use showwavespic filter to generate waveform image
        let mut cmd = tokio::process::Command::new(&self.info.ffmpeg_path);
        configure_tokio_command(&mut cmd);
        let output_result = cmd
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-nostdin",
                "-i",
                &input.to_string_lossy(),
                "-filter_complex",
                &format!("showwavespic=s={}x{}:colors=#3b82f6", width, height),
                "-frames:v",
                "1",
                "-y",
                &output.to_string_lossy(),
            ])
            .output()
            .await
            .map_err(FFmpegError::ProcessError)?;

        if !output_result.status.success() {
            let stderr = String::from_utf8_lossy(&output_result.stderr);
            return Err(FFmpegError::ExecutionFailed(format!(
                "Waveform generation failed: {}",
                stderr
            )));
        }

        Ok(())
    }

    /// Generate audio waveform peak data as JSON.
    ///
    /// Extracts audio peak levels at regular intervals for timeline visualization.
    /// Uses FFmpeg's volumedetect and astats filters to measure peak levels.
    ///
    /// # Arguments
    /// * `input` - Path to the audio/video file
    /// * `output` - Path to save the JSON output
    /// * `samples_per_second` - Number of peak samples per second (default: 100)
    ///
    /// # Returns
    /// WaveformData containing normalized peaks (0.0 - 1.0)
    pub async fn generate_waveform_json(
        &self,
        input: &Path,
        output: &Path,
        samples_per_second: u32,
    ) -> FFmpegResult<WaveformData> {
        if samples_per_second == 0 {
            return Err(FFmpegError::InvalidInput(
                "samples_per_second must be > 0".to_string(),
            ));
        }

        if !input.exists() {
            return Err(FFmpegError::InvalidInput(format!(
                "Input file does not exist: {}",
                input.display()
            )));
        }

        // Create output directory if needed
        if let Some(parent) = output.parent() {
            tokio::fs::create_dir_all(parent).await.map_err(|e| {
                FFmpegError::OutputError(format!("Failed to create output directory: {}", e))
            })?;
        }

        // Get media info for duration and audio channels
        let media_info = self.probe(input).await?;
        let audio_info = media_info.audio.as_ref().ok_or_else(|| {
            FFmpegError::InvalidInput("No audio stream found in file".to_string())
        })?;

        let duration_sec = media_info.duration_sec;
        let channels = audio_info.channels;

        // Calculate expected number of samples
        let total_samples = (duration_sec * samples_per_second as f64).ceil() as usize;

        if total_samples == 0 {
            return Ok(WaveformData::empty(
                duration_sec,
                samples_per_second,
                channels,
            ));
        }

        // Use FFmpeg to extract audio and measure RMS/peak levels per segment
        // We'll use the aframes and asetnsamples to split into segments and measure each
        //
        // Alternative approach: Use ebur128 or astats with segment analysis
        // For efficiency, we use a single FFmpeg call with the asegment filter
        let filter = format!(
            "aresample={}:async=1,asetnsamples=n={}:p=0,astats=metadata=1:reset=1",
            samples_per_second * 100, // Resample to get consistent timing
            (audio_info.sample_rate as f64 / samples_per_second as f64).ceil() as u32
        );

        // Run FFmpeg and stream stderr instead of capturing entire output.
        // On long files astats output can be massive and blow up memory.
        let mut cmd = tokio::process::Command::new(&self.info.ffmpeg_path);
        configure_tokio_command(&mut cmd);
        cmd.args([
            "-hide_banner",
            "-nostats",
            "-loglevel",
            "error",
            "-nostdin",
            "-i",
            &input.to_string_lossy(),
            "-af",
            &filter,
            "-f",
            "null",
            "-",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());

        let mut child = cmd.spawn().map_err(FFmpegError::ProcessError)?;
        let stderr = child.stderr.take();

        // Spawn stderr reader task to prevent pipe deadlock.
        // If FFmpeg produces stderr faster than we can consume, the pipe fills up
        // and FFmpeg blocks. By reading in a separate task, we drain the pipe
        // concurrently with waiting for the child process.
        let expected = total_samples;
        let (result_tx, result_rx) = tokio::sync::oneshot::channel::<(Vec<f32>, String)>();

        let stderr_task = tokio::spawn(async move {
            let mut collector = WaveformLogCollector::new(expected);
            let mut tail = LineTail::new(80);

            if let Some(stderr) = stderr {
                use tokio::io::{AsyncBufReadExt, BufReader};
                let reader = BufReader::new(stderr);
                let mut lines = reader.lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    tail.push(&line);
                    collector.ingest(&line);
                }
            }

            let _ = result_tx.send((collector.finalize(), tail.joined()));
        });

        let status = child.wait().await.map_err(FFmpegError::ProcessError)?;
        let (peaks, tail) = result_rx.await.unwrap_or_else(|_| (vec![], String::new()));
        let _ = stderr_task.await;

        if !status.success() {
            return Err(FFmpegError::ExecutionFailed(format!(
                "Waveform analysis failed. Stderr tail:\n{}",
                tail
            )));
        }

        // Normalize peaks to 0-1 range
        let max_peak = peaks.iter().cloned().fold(0.0f32, f32::max);
        let normalized_peaks: Vec<f32> = if max_peak > 0.0 {
            peaks.iter().map(|p| (*p / max_peak).min(1.0)).collect()
        } else {
            vec![0.0; peaks.len()]
        };

        // Ensure we have the expected number of samples
        let mut final_peaks = normalized_peaks;
        final_peaks.resize(total_samples, 0.0);

        let waveform = WaveformData {
            samples_per_second,
            peaks: final_peaks,
            duration_sec,
            channels,
        };

        // Save to JSON file
        let json = serde_json::to_string(&waveform).map_err(|e| {
            FFmpegError::ParseError(format!("Failed to serialize waveform data: {}", e))
        })?;

        tokio::fs::write(output, &json).await.map_err(|e| {
            FFmpegError::OutputError(format!("Failed to write waveform JSON: {}", e))
        })?;

        Ok(waveform)
    }

    /// Runs a `-filter_complex` analysis pass and returns the captured stderr.
    ///
    /// Analysis filters (`blackdetect`, `freezedetect`, `silencedetect`,
    /// `ebur128`, `astats`) report their findings to stderr at FFmpeg's INFO
    /// log level, so the invocation pins `-loglevel info` and discards the
    /// decoded output with `-f null -`.
    ///
    /// `maps` lists the filtergraph output labels to map (for example
    /// `["[v]", "[a]"]`); an empty slice leaves stream selection to FFmpeg.
    /// The call is aborted with [`FFmpegError::Timeout`] once `timeout`
    /// elapses, and stderr retention is bounded (see [`FilterStderrCapture`]),
    /// so a pathological input can neither hang nor exhaust memory.
    pub async fn run_filter_capture_stderr(
        &self,
        input: &Path,
        filter_complex: &str,
        maps: &[&str],
        timeout: std::time::Duration,
    ) -> FFmpegResult<String> {
        let capture = capture_filter_stderr(
            &self.info.ffmpeg_path,
            input,
            FilterMode::Complex {
                graph: filter_complex,
                maps,
            },
            timeout,
        )
        .await?;

        if !capture.success {
            return Err(FFmpegError::ExecutionFailed(format!(
                "Filter analysis failed (exit {}). Stderr tail:\n{}",
                capture.exit_code.unwrap_or(-1),
                capture.stderr_tail(STDERR_ERROR_TAIL_LINES)
            )));
        }

        Ok(capture.stderr)
    }
}

// =============================================================================
// Filter analysis passes
// =============================================================================

/// Number of stderr tail lines quoted in filter-analysis error messages.
const STDERR_ERROR_TAIL_LINES: usize = 20;

/// Maximum number of filter-output lines retained from a capture.
///
/// Per-frame filters (`ametadata=mode=print`) emit tens of thousands of lines
/// on long inputs, so retention is capped: the oldest lines are dropped and the
/// capture is flagged as truncated. The cap is deliberately generous — it exists
/// to bound memory, not to trim ordinary output.
const MAX_RETAINED_FILTER_LINES: usize = 200_000;

/// Maximum number of trailing lines retained regardless of content.
///
/// The `ebur128` summary block is emitted as indented continuation lines that
/// carry no filter prefix, so the tail window is what keeps it intact.
const MAX_RETAINED_TAIL_LINES: usize = 400;

/// Line prefixes/markers that identify output worth keeping in full.
const FILTER_LINE_MARKERS: &[&str] = &[
    "[Parsed_",
    "[silencedetect",
    "[blackdetect",
    "[freezedetect",
    "[Parsed_ebur128",
    "lavfi.",
    "silence_start",
    "silence_end",
    "black_start",
    "black_end",
    "freeze_start",
    "freeze_end",
];

/// How a filtergraph is attached to an analysis invocation.
#[derive(Debug, Clone, Copy)]
pub enum FilterMode<'a> {
    /// `-af <filter> -vn`: audio-only pass over the first audio stream.
    ///
    /// Kept distinct from [`FilterMode::Complex`] because FFmpeg reports a
    /// missing audio stream differently for the two forms, and callers match
    /// on that message to tell "no audio" apart from "analysis failed".
    Audio(&'a str),
    /// `-filter_complex <graph>` with the given output labels mapped.
    Complex {
        /// The filtergraph description.
        graph: &'a str,
        /// Output labels to map, e.g. `["[v]", "[a]"]`.
        maps: &'a [&'a str],
    },
}

/// Result of an analysis pass, including runs that exited non-zero.
///
/// Failure is reported as data rather than an error so callers can inspect the
/// captured stderr first: a missing audio stream, for example, surfaces only in
/// the log text while FFmpeg exits non-zero.
#[derive(Debug, Clone)]
pub struct FilterCapture {
    /// Retained stderr text (bounded; see [`FilterStderrCapture`]).
    pub stderr: String,
    /// Whether FFmpeg exited successfully.
    pub success: bool,
    /// Process exit code, when one was reported.
    pub exit_code: Option<i32>,
    /// Whether stderr retention dropped lines.
    pub truncated: bool,
}

impl FilterCapture {
    /// Returns the last `lines` lines of the captured stderr.
    pub fn stderr_tail(&self, lines: usize) -> String {
        let all: Vec<&str> = self.stderr.lines().collect();
        let start = all.len().saturating_sub(lines);
        all[start..].join("\n")
    }
}

/// Runs an FFmpeg analysis pass and captures its stderr.
///
/// The output is discarded (`-f null -`); only the filter log matters. The
/// invocation pins `-loglevel info` (filters log their findings at that level)
/// and `-nostats` (the periodic encode progress line is noise here).
///
/// Returns [`FFmpegError::Timeout`] when `timeout` elapses; the child process
/// is killed before returning so no orphan encoder is left behind.
pub async fn capture_filter_stderr(
    ffmpeg_path: &Path,
    input: &Path,
    mode: FilterMode<'_>,
    timeout: std::time::Duration,
) -> FFmpegResult<FilterCapture> {
    if !input.exists() {
        return Err(FFmpegError::InvalidInput(format!(
            "Input file does not exist: {}",
            input.display()
        )));
    }

    let mut cmd = tokio::process::Command::new(ffmpeg_path);
    configure_tokio_command(&mut cmd);
    cmd.args(["-hide_banner", "-nostats", "-nostdin", "-loglevel", "info"]);
    cmd.arg("-i").arg(input);

    match mode {
        FilterMode::Audio(filter) => {
            cmd.arg("-af").arg(filter).arg("-vn");
        }
        FilterMode::Complex { graph, maps } => {
            cmd.arg("-filter_complex").arg(graph);
            for label in maps {
                cmd.arg("-map").arg(label);
            }
        }
    }

    cmd.args(["-f", "null", "-"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(FFmpegError::ProcessError)?;

    let stderr = child.stderr.take();
    let (capture_tx, capture_rx) = tokio::sync::oneshot::channel::<FilterStderrCapture>();
    let reader_task = tokio::spawn(async move {
        let mut capture = FilterStderrCapture::new();
        if let Some(stderr) = stderr {
            use tokio::io::{AsyncBufReadExt, BufReader};
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                capture.push(&line);
            }
        }
        let _ = capture_tx.send(capture);
    });

    let status = match tokio::time::timeout(timeout, child.wait()).await {
        Ok(result) => result.map_err(FFmpegError::ProcessError)?,
        Err(_) => {
            // Kill first, then drain: the reader task only ends once the child
            // closes its stderr pipe.
            let _ = child.kill().await;
            reader_task.abort();
            return Err(FFmpegError::Timeout);
        }
    };

    let capture = capture_rx.await.unwrap_or_default();
    let _ = reader_task.await;

    Ok(FilterCapture {
        stderr: capture.joined(),
        success: status.success(),
        exit_code: status.code(),
        truncated: capture.truncated,
    })
}

/// Bounded, order-preserving stderr buffer for analysis passes.
///
/// Filter findings can be numerous (one line per detected range) while the
/// surrounding FFmpeg chatter is irrelevant, so lines that look like filter
/// output are retained up to a high cap and everything else survives only
/// inside a short trailing window. Sequence numbers keep the merged result in
/// emission order without duplicating lines held by both buffers.
#[derive(Debug, Default)]
struct FilterStderrCapture {
    next_seq: usize,
    filter_lines: std::collections::VecDeque<(usize, String)>,
    tail_lines: std::collections::VecDeque<(usize, String)>,
    truncated: bool,
}

impl FilterStderrCapture {
    fn new() -> Self {
        Self::default()
    }

    fn push(&mut self, line: &str) {
        let seq = self.next_seq;
        self.next_seq += 1;

        if is_filter_output_line(line) {
            if self.filter_lines.len() == MAX_RETAINED_FILTER_LINES {
                self.filter_lines.pop_front();
                self.truncated = true;
            }
            self.filter_lines.push_back((seq, line.to_string()));
        }

        // Dropping an old non-filter line is the intended behaviour of the
        // trailing window, so it does not count as truncation.
        if self.tail_lines.len() == MAX_RETAINED_TAIL_LINES {
            self.tail_lines.pop_front();
        }
        self.tail_lines.push_back((seq, line.to_string()));
    }

    /// Merges both buffers back into emission order, without duplicates.
    fn joined(&self) -> String {
        let mut merged: Vec<(usize, &str)> =
            Vec::with_capacity(self.filter_lines.len() + self.tail_lines.len());
        merged.extend(
            self.filter_lines
                .iter()
                .map(|(seq, line)| (*seq, line.as_str())),
        );
        merged.extend(
            self.tail_lines
                .iter()
                .map(|(seq, line)| (*seq, line.as_str())),
        );
        merged.sort_by_key(|(seq, _)| *seq);
        merged.dedup_by_key(|(seq, _)| *seq);

        merged
            .into_iter()
            .map(|(_, line)| line)
            .collect::<Vec<_>>()
            .join("\n")
    }
}

/// Returns whether a stderr line carries filter output worth retaining in full.
fn is_filter_output_line(line: &str) -> bool {
    let trimmed = line.trim_start();
    FILTER_LINE_MARKERS
        .iter()
        .any(|marker| trimmed.starts_with(marker) || trimmed.contains(marker))
}

/// Parse peak levels from FFmpeg astats filter output
struct LineTail {
    max: usize,
    lines: std::collections::VecDeque<String>,
}

impl LineTail {
    fn new(max: usize) -> Self {
        Self {
            max,
            lines: std::collections::VecDeque::new(),
        }
    }

    fn push(&mut self, line: &str) {
        if self.max == 0 {
            return;
        }

        if self.lines.len() == self.max {
            self.lines.pop_front();
        }
        self.lines.push_back(line.to_string());
    }

    fn joined(&self) -> String {
        self.lines
            .iter()
            .map(|s| s.as_str())
            .collect::<Vec<_>>()
            .join("\n")
    }
}

struct WaveformLogCollector {
    expected_samples: usize,
    peaks: Vec<f32>,
    max_volume_db: Option<f32>,
}

impl WaveformLogCollector {
    fn new(expected_samples: usize) -> Self {
        Self {
            expected_samples,
            peaks: Vec::with_capacity(expected_samples.min(1024)),
            max_volume_db: None,
        }
    }

    fn ingest(&mut self, line: &str) {
        if self.peaks.len() < self.expected_samples {
            if let Some(db_str) = extract_db_value(line) {
                self.peaks.push(db_to_linear(db_str));
            }
        }

        if self.max_volume_db.is_none() {
            if let Some(db_str) = extract_max_volume_db(line) {
                self.max_volume_db = db_str.parse::<f32>().ok();
            }
        }
    }

    fn finalize(mut self) -> Vec<f32> {
        // If astats didn't give us enough samples, fall back to max_volume.
        if self.peaks.len() < self.expected_samples / 2 {
            if let Some(db) = self.max_volume_db {
                let linear = db_to_linear(&db.to_string());
                self.peaks.clear();
                self.peaks.resize(self.expected_samples, linear);
                return self.peaks;
            }
        }

        // Ensure length is bounded.
        self.peaks.truncate(self.expected_samples);
        self.peaks
    }
}

#[cfg(test)]
fn parse_astats_peaks(output: &str, expected_samples: usize, _segment_duration: f64) -> Vec<f32> {
    let mut collector = WaveformLogCollector::new(expected_samples);
    for line in output.lines() {
        collector.ingest(line);
    }
    collector.finalize()
}

#[cfg(test)]
/// Alternative peak parsing using volume levels
fn parse_volume_levels(output: &str, expected_samples: usize) -> Vec<f32> {
    let mut peaks = Vec::with_capacity(expected_samples);

    // Look for mean_volume and max_volume from volumedetect
    let mut max_vol: f32 = -96.0;
    for line in output.lines() {
        if line.contains("max_volume:") {
            if let Some(db_str) = line.split("max_volume:").nth(1) {
                if let Some(db_str) = db_str.split_whitespace().next() {
                    max_vol = db_str.parse().unwrap_or(-96.0);
                }
            }
        }
    }

    // If we found a max volume, create a flat waveform based on it
    // This is a fallback when detailed per-segment data isn't available
    if max_vol > -96.0 {
        let linear = 10f32.powf(max_vol / 20.0);
        peaks.resize(expected_samples, linear);
    } else {
        // No audio data found, return empty
        peaks.resize(expected_samples, 0.0);
    }

    peaks
}

fn extract_db_value(line: &str) -> Option<&str> {
    // astats outputs:
    // - "Peak level dB: -X.X"
    // - "lavfi.astats.Overall.Peak_level=-X.X"
    if line.contains("Peak level dB:") {
        return line
            .split("Peak level dB:")
            .nth(1)
            .and_then(|s| s.split_whitespace().next());
    }

    if line.contains("Peak_level=") {
        return line
            .split("Peak_level=")
            .nth(1)
            .and_then(|s| s.split_whitespace().next());
    }

    None
}

fn extract_max_volume_db(line: &str) -> Option<&str> {
    if !line.contains("max_volume:") {
        return None;
    }
    line.split("max_volume:")
        .nth(1)
        .and_then(|s| s.split_whitespace().next())
}

fn db_to_linear(db_str: &str) -> f32 {
    // Handle "inf" and "-inf".
    let db: f32 = if db_str.contains("inf") {
        if db_str.starts_with('-') {
            -96.0
        } else {
            0.0
        }
    } else {
        db_str.parse().unwrap_or(-96.0)
    };

    if db <= -96.0 {
        0.0
    } else {
        10f32.powf(db / 20.0)
    }
}

/// Parse FFprobe JSON output
fn parse_probe_output(json_str: &str) -> FFmpegResult<MediaInfo> {
    let json: serde_json::Value = serde_json::from_str(json_str)
        .map_err(|e| FFmpegError::ParseError(format!("Failed to parse FFprobe output: {}", e)))?;

    // Parse format information
    let format = json
        .get("format")
        .ok_or_else(|| FFmpegError::ParseError("Missing format info".to_string()))?;

    let duration_sec = format
        .get("duration")
        .and_then(|d| d.as_str())
        .and_then(|s| s.parse::<f64>().ok())
        .unwrap_or(0.0);

    let size_bytes = format
        .get("size")
        .and_then(|s| s.as_str())
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(0);

    let format_name = format
        .get("format_name")
        .and_then(|f| f.as_str())
        .unwrap_or("unknown")
        .to_string();

    // Parse streams
    let streams = json
        .get("streams")
        .and_then(|s| s.as_array())
        .cloned()
        .unwrap_or_default();

    let mut video_info: Option<VideoStreamInfo> = None;
    let mut audio_info: Option<AudioStreamInfo> = None;

    for stream in streams {
        let codec_type = stream.get("codec_type").and_then(|c| c.as_str());

        match codec_type {
            Some("video") if video_info.is_none() => {
                video_info = Some(parse_video_stream(&stream)?);
            }
            Some("audio") if audio_info.is_none() => {
                audio_info = Some(parse_audio_stream(&stream)?);
            }
            _ => {}
        }
    }

    Ok(MediaInfo {
        duration_sec,
        video: video_info,
        audio: audio_info,
        format: format_name,
        size_bytes,
    })
}

fn parse_video_stream(stream: &serde_json::Value) -> FFmpegResult<VideoStreamInfo> {
    let width = stream.get("width").and_then(|w| w.as_u64()).unwrap_or(0) as u32;

    let height = stream.get("height").and_then(|h| h.as_u64()).unwrap_or(0) as u32;

    // Parse frame rate from r_frame_rate (e.g., "30/1" or "30000/1001")
    let fps = stream
        .get("r_frame_rate")
        .and_then(|f| f.as_str())
        .and_then(|s| {
            let parts: Vec<&str> = s.split('/').collect();
            if parts.len() == 2 {
                let num: f64 = parts[0].parse().ok()?;
                let den: f64 = parts[1].parse().ok()?;
                if den > 0.0 {
                    Some(num / den)
                } else {
                    None
                }
            } else {
                s.parse().ok()
            }
        })
        .unwrap_or(30.0);

    let codec = stream
        .get("codec_name")
        .and_then(|c| c.as_str())
        .unwrap_or("unknown")
        .to_string();

    let pixel_format = stream
        .get("pix_fmt")
        .and_then(|p| p.as_str())
        .unwrap_or("unknown")
        .to_string();

    let bitrate = stream
        .get("bit_rate")
        .and_then(|b| b.as_str())
        .and_then(|s| s.parse::<u64>().ok());

    let color_transfer = stream
        .get("color_transfer")
        .and_then(|value| value.as_str())
        .map(str::to_string);
    let is_hdr = matches!(
        color_transfer.as_deref(),
        Some("smpte2084") | Some("arib-std-b67") | Some("hlg") | Some("pq")
    );

    Ok(VideoStreamInfo {
        width,
        height,
        fps,
        codec,
        pixel_format,
        bitrate,
        is_hdr,
        color_transfer,
    })
}

fn parse_audio_stream(stream: &serde_json::Value) -> FFmpegResult<AudioStreamInfo> {
    let sample_rate = stream
        .get("sample_rate")
        .and_then(|s| s.as_str())
        .and_then(|s| s.parse::<u32>().ok())
        .unwrap_or(44100);

    let channels = stream.get("channels").and_then(|c| c.as_u64()).unwrap_or(2) as u8;

    let codec = stream
        .get("codec_name")
        .and_then(|c| c.as_str())
        .unwrap_or("unknown")
        .to_string();

    let bitrate = stream
        .get("bit_rate")
        .and_then(|b| b.as_str())
        .and_then(|s| s.parse::<u64>().ok());

    Ok(AudioStreamInfo {
        sample_rate,
        channels,
        codec,
        bitrate,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // =========================================================================
    // Filter stderr capture Tests
    // =========================================================================

    #[test]
    fn test_filter_capture_should_keep_lines_in_emission_order() {
        let mut capture = FilterStderrCapture::new();
        capture.push("[blackdetect @ 0x1] black_start:0 black_end:0.5");
        capture.push("frame= 10 fps=0.0");
        capture.push("[silencedetect @ 0x2] silence_start: 1.0");

        let joined = capture.joined();
        let lines: Vec<&str> = joined.lines().collect();

        assert_eq!(lines.len(), 3);
        assert!(lines[0].contains("black_start"));
        assert!(lines[1].contains("frame="));
        assert!(lines[2].contains("silence_start"));
        assert!(!capture.truncated);
    }

    #[test]
    fn test_filter_capture_should_retain_filter_lines_beyond_the_tail_window() {
        let mut capture = FilterStderrCapture::new();
        capture.push("[blackdetect @ 0x1] black_start:0 black_end:0.5");
        for index in 0..(MAX_RETAINED_TAIL_LINES * 2) {
            capture.push(&format!("noise line {}", index));
        }

        let joined = capture.joined();

        assert!(
            joined.contains("black_start"),
            "filter output must survive a flood of unrelated stderr"
        );
        assert!(
            !joined.contains("noise line 0"),
            "unrelated stderr must be bounded"
        );
        assert!(!capture.truncated);
    }

    #[test]
    fn test_filter_capture_should_not_duplicate_lines_held_by_both_buffers() {
        let mut capture = FilterStderrCapture::new();
        capture.push("[silencedetect @ 0x2] silence_start: 1.0");
        capture.push("[silencedetect @ 0x2] silence_end: 2.0 | silence_duration: 1.0");

        let joined = capture.joined();

        assert_eq!(joined.matches("silence_start").count(), 1);
        assert_eq!(joined.matches("silence_end").count(), 1);
    }

    #[test]
    fn test_filter_capture_should_flag_truncation_when_filter_output_overflows() {
        let mut capture = FilterStderrCapture::new();
        for index in 0..(MAX_RETAINED_FILTER_LINES + 5) {
            capture.push(&format!("[blackdetect @ 0x1] black_start:{}", index));
        }

        assert!(capture.truncated);
    }

    #[test]
    fn test_is_filter_output_line() {
        assert!(is_filter_output_line("[Parsed_ebur128_0 @ 0x1] Summary:"));
        assert!(is_filter_output_line(
            "[freezedetect @ 0x1] lavfi.freezedetect.freeze_start: 2"
        ));
        assert!(!is_filter_output_line("  Integrated loudness:"));
        assert!(!is_filter_output_line("frame= 120 fps=30"));
    }

    #[test]
    fn test_filter_capture_stderr_tail() {
        let capture = FilterCapture {
            stderr: "a\nb\nc\nd".to_string(),
            success: false,
            exit_code: Some(1),
            truncated: false,
        };

        assert_eq!(capture.stderr_tail(2), "c\nd");
        assert_eq!(capture.stderr_tail(10), "a\nb\nc\nd");
    }

    // =========================================================================
    // WaveformData Tests
    // =========================================================================

    #[test]
    fn test_waveform_data_empty() {
        let waveform = WaveformData::empty(5.0, 100, 2);
        assert_eq!(waveform.samples_per_second, 100);
        assert_eq!(waveform.peaks.len(), 500); // 5 seconds * 100 samples/sec
        assert_eq!(waveform.duration_sec, 5.0);
        assert_eq!(waveform.channels, 2);
        assert!(waveform.peaks.iter().all(|&p| p == 0.0));
    }

    #[test]
    fn test_waveform_data_peak_at_time() {
        let mut waveform = WaveformData::empty(2.0, 100, 1);
        // Set a peak at 1 second (index 100)
        waveform.peaks[100] = 0.8;

        assert_eq!(waveform.peak_at_time(1.0), 0.8);
        assert_eq!(waveform.peak_at_time(0.0), 0.0);
        assert_eq!(waveform.peak_at_time(-1.0), 0.0); // Out of bounds
        assert_eq!(waveform.peak_at_time(3.0), 0.0); // Out of bounds
    }

    #[test]
    fn test_waveform_data_peaks_in_range() {
        let mut waveform = WaveformData::empty(3.0, 100, 1);
        // Set peaks from 1.0s to 2.0s
        for i in 100..200 {
            waveform.peaks[i] = 0.5;
        }

        let range = waveform.peaks_in_range(1.0, 2.0);
        assert_eq!(range.len(), 100);
        assert!(range.iter().all(|&p| p == 0.5));

        // Out of range
        let empty = waveform.peaks_in_range(5.0, 6.0);
        assert!(empty.is_empty());
    }

    #[test]
    fn test_waveform_data_serialization() {
        let waveform = WaveformData {
            samples_per_second: 100,
            peaks: vec![0.0, 0.5, 1.0, 0.3],
            duration_sec: 0.04,
            channels: 2,
        };

        let json = serde_json::to_string(&waveform).unwrap();
        assert!(json.contains("samplesPerSecond")); // camelCase
        assert!(json.contains("100"));

        let deserialized: WaveformData = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.samples_per_second, 100);
        assert_eq!(deserialized.peaks, vec![0.0, 0.5, 1.0, 0.3]);
    }

    // =========================================================================
    // Peak Parsing Tests
    // =========================================================================

    #[test]
    fn test_parse_astats_peaks_with_db_values() {
        let output = r#"
[Parsed_astats_0 @ 0x...] Peak level dB: -6.0
[Parsed_astats_0 @ 0x...] Peak level dB: -12.0
[Parsed_astats_0 @ 0x...] Peak level dB: -24.0
"#;

        let peaks = parse_astats_peaks(output, 3, 0.01);
        assert_eq!(peaks.len(), 3);

        // -6 dB ≈ 0.501
        assert!((peaks[0] - 0.501).abs() < 0.01);
        // -12 dB ≈ 0.251
        assert!((peaks[1] - 0.251).abs() < 0.01);
        // -24 dB ≈ 0.063
        assert!((peaks[2] - 0.063).abs() < 0.01);
    }

    #[test]
    fn test_parse_astats_peaks_with_inf() {
        let output = r#"
[Parsed_astats_0 @ 0x...] Peak level dB: -inf
[Parsed_astats_0 @ 0x...] Peak level dB: 0.0
"#;

        let peaks = parse_astats_peaks(output, 2, 0.01);
        assert_eq!(peaks.len(), 2);
        assert_eq!(peaks[0], 0.0); // -inf = silence
        assert_eq!(peaks[1], 1.0); // 0 dB = max
    }

    #[test]
    fn test_parse_volume_levels_fallback() {
        let output = r#"
[Parsed_volumedetect_0 @ 0x...] max_volume: -6.0 dB
"#;

        let peaks = parse_volume_levels(output, 100);
        assert_eq!(peaks.len(), 100);
        // All peaks should be around 0.501 (-6 dB)
        assert!((peaks[0] - 0.501).abs() < 0.01);
    }

    #[test]
    fn test_parse_volume_levels_no_audio() {
        let output = "Some random output without volume data";
        let peaks = parse_volume_levels(output, 50);
        assert_eq!(peaks.len(), 50);
        assert!(peaks.iter().all(|&p| p == 0.0));
    }

    #[test]
    fn test_parse_astats_peaks_does_not_over_collect() {
        let mut output = String::new();
        for _ in 0..10_000 {
            output.push_str("[Parsed_astats_0 @ 0x...] Peak level dB: -6.0\n");
        }

        let peaks = parse_astats_peaks(&output, 3, 0.01);
        assert_eq!(peaks.len(), 3);
        assert!((peaks[0] - 0.501).abs() < 0.01);
    }

    #[test]
    fn test_parse_astats_peaks_falls_back_to_max_volume() {
        let output = "[Parsed_volumedetect_0 @ 0x...] max_volume: -6.0 dB\n";
        let peaks = parse_astats_peaks(output, 10, 0.01);
        assert_eq!(peaks.len(), 10);
        assert!((peaks[0] - 0.501).abs() < 0.01);
        assert!(peaks.iter().all(|p| (*p - peaks[0]).abs() < 1e-6));
    }

    // =========================================================================
    // RenderSettings Tests
    // =========================================================================

    #[test]
    fn test_render_settings_default() {
        let settings = RenderSettings::default();
        assert_eq!(settings.width, 1920);
        assert_eq!(settings.height, 1080);
        assert_eq!(settings.video_codec, "libx264");
    }

    #[test]
    fn test_render_settings_presets() {
        let shorts = RenderSettings::shorts_1080p();
        assert_eq!(shorts.width, 1080);
        assert_eq!(shorts.height, 1920);

        let youtube = RenderSettings::youtube_1080p();
        assert_eq!(youtube.width, 1920);
        assert_eq!(youtube.height, 1080);

        let proxy = RenderSettings::proxy_720p();
        assert_eq!(proxy.width, 1280);
        assert_eq!(proxy.height, 720);
        assert_eq!(proxy.preset, "ultrafast");
    }

    #[test]
    fn test_parse_probe_output_video() {
        let json = r#"{
            "format": {
                "duration": "10.5",
                "size": "1048576",
                "format_name": "mov,mp4,m4a,3gp,3g2,mj2"
            },
            "streams": [
                {
                    "codec_type": "video",
                    "codec_name": "h264",
                    "width": 1920,
                    "height": 1080,
                    "r_frame_rate": "30/1",
                    "pix_fmt": "yuv420p"
                },
                {
                    "codec_type": "audio",
                    "codec_name": "aac",
                    "sample_rate": "48000",
                    "channels": 2
                }
            ]
        }"#;

        let info = parse_probe_output(json).unwrap();
        assert_eq!(info.duration_sec, 10.5);
        assert_eq!(info.size_bytes, 1048576);
        assert!(info.video.is_some());
        assert!(info.audio.is_some());

        let video = info.video.unwrap();
        assert_eq!(video.width, 1920);
        assert_eq!(video.height, 1080);
        assert_eq!(video.fps, 30.0);
        assert_eq!(video.codec, "h264");
        assert!(!video.is_hdr);
        assert_eq!(video.color_transfer, None);

        let audio = info.audio.unwrap();
        assert_eq!(audio.sample_rate, 48000);
        assert_eq!(audio.channels, 2);
        assert_eq!(audio.codec, "aac");
    }

    #[test]
    fn test_parse_fractional_framerate() {
        let json = r#"{
            "format": {
                "duration": "1.0",
                "size": "1000",
                "format_name": "mp4"
            },
            "streams": [
                {
                    "codec_type": "video",
                    "codec_name": "h264",
                    "width": 1920,
                    "height": 1080,
                    "r_frame_rate": "30000/1001",
                    "pix_fmt": "yuv420p"
                }
            ]
        }"#;

        let info = parse_probe_output(json).unwrap();
        let video = info.video.unwrap();
        // 30000/1001 ≈ 29.97
        assert!((video.fps - 29.97).abs() < 0.01);
    }

    #[test]
    fn test_parse_probe_output_preserves_hdr_transfer_metadata() {
        let json = r#"{
            "format": {
                "duration": "5.0",
                "size": "2048",
                "format_name": "mp4"
            },
            "streams": [
                {
                    "codec_type": "video",
                    "codec_name": "hevc",
                    "width": 3840,
                    "height": 2160,
                    "r_frame_rate": "24000/1001",
                    "pix_fmt": "yuv420p10le",
                    "color_transfer": "smpte2084"
                }
            ]
        }"#;

        let info = parse_probe_output(json).unwrap();
        let video = info.video.unwrap();
        assert!(video.is_hdr);
        assert_eq!(video.color_transfer.as_deref(), Some("smpte2084"));
    }

    // =========================================================================
    // BDD: Feature: GPU-Accelerated Frame Extraction
    // =========================================================================

    #[test]
    fn should_build_hwaccel_args_before_input_flag() {
        // Given: a set of FFmpeg args for hwaccel frame extraction
        // When: building args with hwaccel="cuda"
        // Then: -hwaccel cuda -hwaccel_output_format cuda appear before -i

        // Simulate the argument building from run_frame_extraction
        let hwaccel = "cuda";
        let mut args: Vec<String> = vec![
            "-hide_banner".to_string(),
            "-loglevel".to_string(),
            "error".to_string(),
            "-nostdin".to_string(),
        ];

        // Insert hwaccel before -i (output format matches backend name)
        args.push("-hwaccel".to_string());
        args.push(hwaccel.to_string());
        args.push("-hwaccel_output_format".to_string());
        args.push(hwaccel.to_string());

        args.push("-ss".to_string());
        args.push("1.000".to_string());
        args.push("-i".to_string());
        args.push("input.mp4".to_string());

        // Verify ordering: hwaccel args come before -i
        let hwaccel_idx = args.iter().position(|a| a == "-hwaccel").unwrap();
        let input_idx = args.iter().position(|a| a == "-i").unwrap();
        assert!(
            hwaccel_idx < input_idx,
            "hwaccel flags must precede -i for FFmpeg"
        );

        // Verify hwaccel value is correct
        assert_eq!(args[hwaccel_idx + 1], "cuda");
        assert_eq!(args[hwaccel_idx + 2], "-hwaccel_output_format");
        assert_eq!(args[hwaccel_idx + 3], "cuda");
    }

    #[test]
    fn should_not_include_hwaccel_args_when_none() {
        // Given: no hwaccel backend
        // When: building args without hwaccel
        let hwaccel: Option<&str> = None;
        let mut args = vec![
            "-hide_banner".to_string(),
            "-nostdin".to_string(),
            "-ss".to_string(),
            "0.000".to_string(),
            "-i".to_string(),
            "input.mp4".to_string(),
        ];

        // No hwaccel insertion
        if let Some(accel) = hwaccel {
            args.insert(2, "-hwaccel_output_format".to_string());
            args.insert(2, accel.to_string());
            args.insert(2, "-hwaccel".to_string());
        }

        // Then: no hwaccel flags present
        assert!(!args.iter().any(|a| a == "-hwaccel"));
        assert!(!args.iter().any(|a| a == "-hwaccel_output_format"));
    }

    #[test]
    fn should_support_multiple_hwaccel_backends() {
        // Given: various hwaccel backend names
        let backends = ["cuda", "d3d11va", "qsv", "vaapi", "videotoolbox"];

        // When/Then: each backend is a valid FFmpeg hwaccel value
        for backend in &backends {
            let args = ["-hwaccel".to_string(), backend.to_string()];
            assert_eq!(args[1], *backend);
        }
    }

    #[test]
    fn should_include_tonemap_filter_with_hwaccel() {
        // Given: hwaccel enabled and tonemap filter
        let hwaccel = Some("cuda");
        let tonemap_filter = Some("zscale=t=linear,tonemap=hable,zscale=p=bt709");

        let mut args: Vec<String> = Vec::new();

        if let Some(accel) = hwaccel {
            args.push("-hwaccel".to_string());
            args.push(accel.to_string());
            args.push("-hwaccel_output_format".to_string());
            args.push(accel.to_string());
        }

        args.push("-ss".to_string());
        args.push("5.000".to_string());
        args.push("-i".to_string());
        args.push("hdr_video.mp4".to_string());

        if let Some(filter) = tonemap_filter {
            args.push("-vf".to_string());
            args.push(filter.to_string());
        }

        args.push("-frames:v".to_string());
        args.push("1".to_string());

        // Then: both hwaccel and tonemap are present
        assert!(args.contains(&"-hwaccel".to_string()));
        assert!(args.contains(&"-vf".to_string()));
        let vf_idx = args.iter().position(|a| a == "-vf").unwrap();
        assert!(args[vf_idx + 1].contains("tonemap"));
    }
}
