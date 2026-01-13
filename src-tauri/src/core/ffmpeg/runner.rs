//! FFmpeg Runner Module
//!
//! Executes FFmpeg commands for video processing operations.

use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;

use tokio::sync::mpsc;

use super::{FFmpegError, FFmpegInfo, FFmpegResult};

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

/// Media information extracted by FFprobe
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
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

/// Video stream information
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
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

/// Audio stream information
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
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

        // Create output directory if needed
        if let Some(parent) = output.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                FFmpegError::OutputError(format!("Failed to create output directory: {}", e))
            })?;
        }

        // Build FFmpeg command
        // -ss before -i for fast seeking
        // -frames:v 1 to extract single frame
        // -q:v 2 for good JPEG quality
        let output = tokio::process::Command::new(&self.info.ffmpeg_path)
            .args([
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

        // Create output directory if needed
        if let Some(parent) = output.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
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

        let output_result = tokio::process::Command::new(&self.info.ffmpeg_path)
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
            std::fs::create_dir_all(parent).map_err(|e| {
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

        // Build FFmpeg command
        let mut cmd = tokio::process::Command::new(&self.info.ffmpeg_path);
        cmd.args([
            "-i",
            &input.to_string_lossy(),
            "-vf",
            &format!("scale={}:{}", settings.width, settings.height),
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
            "-progress",
            "pipe:1", // Output progress to stdout
            "-y",
            &output.to_string_lossy(),
        ]);

        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());

        let mut child = cmd.spawn().map_err(FFmpegError::ProcessError)?;

        // Handle progress if channel provided
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
                        // Parse FFmpeg progress output
                        if let Some(value) = line.strip_prefix("frame=") {
                            current_frame = value.trim().parse().unwrap_or(0);
                        } else if let Some(value) = line.strip_prefix("fps=") {
                            current_fps = value.trim().parse().unwrap_or(0.0);
                        } else if let Some(value) = line.strip_prefix("out_time_ms=") {
                            let ms: u64 = value.trim().parse().unwrap_or(0);
                            current_time = ms as f64 / 1_000_000.0;
                        } else if line.starts_with("progress=") {
                            // Send progress update
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

        if !status.success() {
            return Err(FFmpegError::ExecutionFailed(
                "Proxy generation failed".to_string(),
            ));
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
        let output = tokio::process::Command::new(&self.info.ffprobe_path)
            .args([
                "-v",
                "quiet",
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
            return Err(FFmpegError::ProbeError(format!("FFprobe failed: {}", stderr)));
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

        // Create output directory if needed
        if let Some(parent) = output.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                FFmpegError::OutputError(format!("Failed to create output directory: {}", e))
            })?;
        }

        // Use showwavespic filter to generate waveform image
        let output_result = tokio::process::Command::new(&self.info.ffmpeg_path)
            .args([
                "-i",
                &input.to_string_lossy(),
                "-filter_complex",
                &format!(
                    "showwavespic=s={}x{}:colors=#3b82f6",
                    width, height
                ),
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
    let width = stream
        .get("width")
        .and_then(|w| w.as_u64())
        .unwrap_or(0) as u32;

    let height = stream
        .get("height")
        .and_then(|h| h.as_u64())
        .unwrap_or(0) as u32;

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

    let channels = stream
        .get("channels")
        .and_then(|c| c.as_u64())
        .unwrap_or(2) as u8;

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
