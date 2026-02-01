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
        if !input.exists() {
            return Err(FFmpegError::InvalidInput(format!(
                "Input file does not exist: {}",
                input.display()
            )));
        }

        // If already extracted, treat as success.
        if is_nonempty_file(output) {
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
        // -q:v 2 for good JPEG quality
        let mut cmd = tokio::process::Command::new(&self.info.ffmpeg_path);
        configure_tokio_command(&mut cmd);
        let output = cmd
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-nostdin",
                "-ss",
                &format!("{:.3}", time_sec),
                "-i",
                &input.to_string_lossy(),
                "-frames:v",
                "1",
                "-q:v",
                "2",
                "-y", // Overwrite output
                &output.to_string_lossy(),
            ])
            .output()
            .await
            .map_err(FFmpegError::ProcessError)?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
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

    Ok(VideoStreamInfo {
        width,
        height,
        fps,
        codec,
        pixel_format,
        bitrate,
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
}
