//! FFprobe Metadata Extraction Module
//!
//! Extracts video, audio, and image metadata using FFprobe.

use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::Command;

use crate::core::assets::{AudioInfo, VideoInfo};
use crate::core::ffmpeg::resolved_ffprobe_path;
use crate::core::process::configure_std_command;
use crate::core::{CoreError, CoreResult, Ratio};

// =============================================================================
// Probe Failure Classification
// =============================================================================

/// Marks the [`CoreError::FFprobeError`] a probe that reached no verdict carries.
///
/// FFprobe can exit successfully and still leave nothing to read - a truncated
/// or empty stdout, output no version of the JSON schema this understands. That
/// is not the same failure as FFprobe looking at a file and rejecting it: the
/// second says something permanent about the bytes, the first says only that
/// this run produced no measurement. Callers that would otherwise register an
/// asset from defaults need to tell the two apart, so the message *starts* with
/// this prefix.
///
/// Two things read it. [`probe_measured_nothing`] is one. The other is the
/// frontend: `src/utils/errorMessages.ts` matches this same wording to ask for
/// a retry instead of blaming the file, so the prefix is user-visible text and
/// changing it means changing that pattern and its test too. That pattern is
/// anchored and case-sensitive, for the reason this side matches on
/// `starts_with`: it accepts the prefix at the start of the message, or
/// directly after the `FFprobe error: ` that [`CoreError`]'s `Display` puts in
/// front of it, and nowhere else.
pub const PROBE_MEASURED_NOTHING_PREFIX: &str = "FFprobe reported nothing";

/// Whether `error` means the probe finished without measuring anything.
///
/// True for a probe whose output could not be read (see
/// [`PROBE_MEASURED_NOTHING_PREFIX`]) and for one that could not be launched at
/// all: neither looked at the file, so neither licenses a caller to invent the
/// frame size, duration or codec it failed to report. A failure FFprobe *did*
/// reach about the content is not covered - something looked, and one
/// unreadable file must not stop a workspace scan.
///
/// The prefix is matched at the start of the message, not anywhere in it: every
/// producer writes it there, and a substring match would also fire on a verdict
/// that merely quotes an inner error carrying the same words.
pub fn probe_measured_nothing(error: &CoreError) -> bool {
    match error {
        CoreError::FFprobeUnavailable(_) => true,
        CoreError::FFprobeError(message) => message.starts_with(PROBE_MEASURED_NOTHING_PREFIX),
        _ => false,
    }
}

// =============================================================================
// Types
// =============================================================================

/// Extracted media metadata
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaMetadata {
    /// Duration in seconds
    pub duration_sec: f64,
    /// How far the *pictures* go, when the file reports a video stream.
    ///
    /// [`Self::duration_sec`] is the container duration, which is the maximum
    /// across every stream. A file whose audio outlasts its video therefore
    /// looks seconds longer than the last frame it can decode, and anything
    /// asking "is there unused picture past this point" — the transition
    /// handle check above all — has to ask the video stream itself.
    ///
    /// `None` when the file carries no video stream, or when the stream
    /// advertises neither a duration nor a frame count one can be derived
    /// from; callers fall back to [`Self::duration_sec`].
    #[serde(default)]
    pub video_duration_sec: Option<f64>,
    /// File size in bytes
    pub file_size: u64,
    /// Video stream info (if present)
    pub video: Option<VideoInfo>,
    /// Audio stream info (if present)
    pub audio: Option<AudioInfo>,
    /// Format name (e.g., "mov,mp4,m4a,3gp,3g2,mj2")
    pub format: String,
    /// Display-matrix rotation of the primary video stream, in degrees.
    ///
    /// `video.width`/`video.height` stay the *coded* size; FFmpeg auto-rotates on
    /// decode, so a quarter turn here means the frames it produces are
    /// `height x width`. See [`crate::core::ffmpeg::display_dimensions`].
    #[serde(default)]
    pub rotation_deg: f64,
}

impl Default for MediaMetadata {
    fn default() -> Self {
        Self {
            duration_sec: 0.0,
            video_duration_sec: None,
            file_size: 0,
            video: None,
            audio: None,
            format: String::new(),
            rotation_deg: 0.0,
        }
    }
}

// =============================================================================
// FFprobe JSON Response Types
// =============================================================================

#[derive(Debug, Deserialize)]
struct FFprobeOutput {
    streams: Option<Vec<FFprobeStream>>,
    format: Option<FFprobeFormat>,
}

#[derive(Debug, Deserialize)]
struct FFprobeStream {
    codec_type: String,
    codec_name: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
    r_frame_rate: Option<String>,
    /// Per-stream duration. Absent in containers like Matroska.
    duration: Option<String>,
    /// Frame count, which with `r_frame_rate` gives a duration when the stream
    /// does not advertise one.
    nb_frames: Option<String>,
    sample_rate: Option<String>,
    channels: Option<u8>,
    bit_rate: Option<String>,
    color_transfer: Option<String>,
    #[allow(dead_code)]
    color_space: Option<String>,
    #[allow(dead_code)]
    color_primaries: Option<String>,
    #[allow(dead_code)]
    pix_fmt: Option<String>,
    /// Per-stream side data; carries the display matrix on rotated recordings.
    side_data_list: Option<Vec<serde_json::Value>>,
    /// Stream tags; older remuxes only leave `rotate` behind.
    tags: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
struct FFprobeFormat {
    duration: Option<String>,
    size: Option<String>,
    format_name: Option<String>,
    #[allow(dead_code)]
    bit_rate: Option<String>,
}

// =============================================================================
// Metadata Extractor
// =============================================================================

/// Metadata extractor using FFprobe
pub struct MetadataExtractor;

impl MetadataExtractor {
    /// Extract metadata from a media file using FFprobe
    pub fn extract<P: AsRef<Path>>(path: P) -> CoreResult<MediaMetadata> {
        let path = path.as_ref();

        // Check if file exists
        if !path.exists() {
            return Err(CoreError::FileNotFound(path.to_string_lossy().to_string()));
        }

        // Run FFprobe.
        //
        // `-v error` rather than `-v quiet`: the JSON still comes back on
        // stdout, but a refusal now says *why* on stderr. Callers that decide
        // whether a failure is worth remembering — see
        // `crate::core::render::probe_asset_audio_info` — have nothing to
        // classify when the message is empty.
        let mut command = Command::new(resolved_ffprobe_path());
        configure_std_command(&mut command);
        let output = command
            .args([
                "-v",
                "error",
                "-print_format",
                "json",
                "-show_streams",
                "-show_format",
            ])
            .arg(path)
            .output()
            .map_err(|e| CoreError::FFprobeUnavailable(format!("Failed to run ffprobe: {}", e)))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(CoreError::FFprobeError(format!(
                "FFprobe failed: {}",
                stderr
            )));
        }

        let json_str = String::from_utf8_lossy(&output.stdout);
        Self::parse_ffprobe_output(&json_str)
    }

    /// Parse FFprobe JSON output into MediaMetadata
    fn parse_ffprobe_output(json: &str) -> CoreResult<MediaMetadata> {
        // Unreadable output is not a verdict about the file: FFprobe exited
        // successfully and still said nothing this can be built from. It is
        // marked with `PROBE_MEASURED_NOTHING_PREFIX` so callers that would
        // otherwise fall back to invented defaults can tell it apart from a
        // refusal FFprobe actually reached about the bytes.
        let output: FFprobeOutput = serde_json::from_str(json).map_err(|e| {
            CoreError::FFprobeError(format!(
                "{PROBE_MEASURED_NOTHING_PREFIX}: failed to parse ffprobe output: {e}"
            ))
        })?;

        let mut metadata = MediaMetadata::default();

        // Parse format info
        if let Some(format) = output.format {
            if let Some(duration_str) = format.duration {
                metadata.duration_sec = duration_str.parse().unwrap_or(0.0);
            }
            if let Some(size_str) = format.size {
                metadata.file_size = size_str.parse().unwrap_or(0);
            }
            metadata.format = format.format_name.unwrap_or_default();
        }

        // Parse streams (only take first video and audio stream)
        if let Some(streams) = output.streams {
            for stream in streams {
                match stream.codec_type.as_str() {
                    "video" if metadata.video.is_none() => {
                        metadata.rotation_deg = Self::parse_display_rotation(&stream);
                        metadata.video_duration_sec = Self::parse_video_stream_duration(&stream);
                        metadata.video = Some(Self::parse_video_stream(&stream));
                    }
                    "audio" if metadata.audio.is_none() => {
                        metadata.audio = Some(Self::parse_audio_stream(&stream));
                    }
                    _ => {}
                }
            }
        }

        Ok(metadata)
    }

    /// Parse video stream info
    fn parse_video_stream(stream: &FFprobeStream) -> VideoInfo {
        let fps = stream
            .r_frame_rate
            .as_ref()
            .map(|s| Self::parse_frame_rate(s))
            .unwrap_or_else(|| Ratio::new(30, 1));

        let bitrate = stream.bit_rate.as_ref().and_then(|s| s.parse().ok());

        // Detect HDR from color transfer function
        let is_hdr = stream
            .color_transfer
            .as_deref()
            .map(|ct| matches!(ct, "smpte2084" | "arib-std-b67"))
            .unwrap_or(false);

        VideoInfo {
            width: stream.width.unwrap_or(1920),
            height: stream.height.unwrap_or(1080),
            fps,
            codec: stream
                .codec_name
                .clone()
                .unwrap_or_else(|| "unknown".to_string()),
            bitrate,
            has_alpha: false, // FFprobe doesn't easily expose this
            is_hdr,
            color_transfer: stream.color_transfer.clone(),
        }
    }

    /// How far a video stream's pictures run, in seconds.
    ///
    /// Prefers the stream's own `duration`. When the container carries no
    /// per-stream duration, derives one from the frame count and the frame rate,
    /// which is the next best answer to "where does the last picture land".
    /// Returns `None` when neither is available so the caller can fall back to
    /// the container duration rather than reading a missing value as zero.
    fn parse_video_stream_duration(stream: &FFprobeStream) -> Option<f64> {
        let declared = stream
            .duration
            .as_ref()
            .and_then(|raw| raw.parse::<f64>().ok())
            .filter(|value| value.is_finite() && *value > 0.0);
        if declared.is_some() {
            return declared;
        }

        let frames = stream
            .nb_frames
            .as_ref()
            .and_then(|raw| raw.parse::<f64>().ok())
            .filter(|value| value.is_finite() && *value > 0.0)?;
        // Parsed strictly rather than through `parse_frame_rate`, which falls
        // back to 30fps: a fabricated frame rate here would fabricate a picture
        // length, which is exactly the guess this function exists to avoid.
        let fps = stream
            .r_frame_rate
            .as_deref()
            .and_then(Self::parse_exact_rational)
            .filter(|value| value.is_finite() && *value > 0.0)?;

        Some(frames / fps)
    }

    /// Parses an FFmpeg rational such as `30/1` or `30000/1001`, or nothing.
    fn parse_exact_rational(raw: &str) -> Option<f64> {
        match raw.split_once('/') {
            Some((numerator, denominator)) => {
                let numerator: f64 = numerator.trim().parse().ok()?;
                let denominator: f64 = denominator.trim().parse().ok()?;
                if denominator == 0.0 {
                    return None;
                }
                Some(numerator / denominator)
            }
            None => raw.trim().parse().ok(),
        }
    }

    /// Read the display-matrix rotation a video stream advertises.
    ///
    /// The two shapes FFprobe emits are reassembled into the JSON object the
    /// shared parser reads, so the sync and async probe paths cannot disagree
    /// about what a rotated recording means.
    fn parse_display_rotation(stream: &FFprobeStream) -> f64 {
        let mut probe_shape = serde_json::Map::new();
        if let Some(side_data_list) = stream.side_data_list.clone() {
            probe_shape.insert(
                "side_data_list".to_string(),
                serde_json::Value::Array(side_data_list),
            );
        }
        if let Some(tags) = stream.tags.clone() {
            probe_shape.insert("tags".to_string(), tags);
        }

        crate::core::ffmpeg::rotation::rotation_from_probe_stream(&serde_json::Value::Object(
            probe_shape,
        ))
    }

    /// Parse audio stream info
    fn parse_audio_stream(stream: &FFprobeStream) -> AudioInfo {
        let sample_rate = stream
            .sample_rate
            .as_ref()
            .and_then(|s| s.parse().ok())
            .unwrap_or(48000);

        let bitrate = stream.bit_rate.as_ref().and_then(|s| s.parse().ok());

        AudioInfo {
            sample_rate,
            channels: stream.channels.unwrap_or(2),
            codec: stream
                .codec_name
                .clone()
                .unwrap_or_else(|| "unknown".to_string()),
            bitrate,
        }
    }

    /// Parse frame rate string (e.g., "30/1" or "24000/1001")
    fn parse_frame_rate(fps_str: &str) -> Ratio {
        let parts: Vec<&str> = fps_str.split('/').collect();
        if parts.len() == 2 {
            let num: i32 = parts[0].parse().unwrap_or(30);
            let den: i32 = parts[1].parse().unwrap_or(1);
            if den > 0 {
                return Ratio::new(num, den);
            }
        }
        Ratio::new(30, 1)
    }

    /// Counts the pictures the primary video stream holds.
    ///
    /// Neither the stream's `duration` nor its `nb_frames` answers this for the
    /// image formats that can be either a photo or an animation. Measured
    /// against ffprobe 9.0.1: a still JPEG advertises `duration=0.040000` and no
    /// frame count, a single-frame GIF advertises `duration=0.030000` and
    /// `nb_frames=1`, and an animated APNG or WebP advertises *neither* — so a
    /// classification built on the declared metadata calls a photo an animation
    /// and an animation a photo, in both directions.
    ///
    /// `-count_packets` is what actually separates them. It demuxes the file
    /// without decoding it, which is cheap even for a long animation, and gives
    /// `1` for every still and the true frame count for every animation.
    ///
    /// Returns `None` when the file carries no video stream or the count cannot
    /// be read, so a caller can tell "one picture" from "could not tell".
    pub fn count_video_frames<P: AsRef<Path>>(path: P) -> CoreResult<Option<u64>> {
        let path = path.as_ref();

        if !path.exists() {
            return Err(CoreError::FileNotFound(path.to_string_lossy().to_string()));
        }

        let mut command = Command::new(resolved_ffprobe_path());
        configure_std_command(&mut command);
        let output = command
            .args([
                "-v",
                "error",
                "-select_streams",
                "v:0",
                "-count_packets",
                "-show_entries",
                "stream=nb_read_packets",
                "-print_format",
                "json",
            ])
            .arg(path)
            .output()
            .map_err(|e| CoreError::FFprobeUnavailable(format!("Failed to run ffprobe: {}", e)))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(CoreError::FFprobeError(format!(
                "FFprobe failed: {}",
                stderr
            )));
        }

        Ok(Self::parse_packet_count(&String::from_utf8_lossy(
            &output.stdout,
        )))
    }

    /// Reads `nb_read_packets` out of a `-count_packets` probe.
    fn parse_packet_count(json: &str) -> Option<u64> {
        let parsed: serde_json::Value = serde_json::from_str(json).ok()?;
        parsed
            .get("streams")?
            .as_array()?
            .first()?
            .get("nb_read_packets")?
            .as_str()?
            .parse()
            .ok()
    }

    /// Check if FFprobe is available on the system
    pub fn is_available() -> bool {
        let mut command = Command::new(resolved_ffprobe_path());
        configure_std_command(&mut command);
        command
            .arg("-version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    // -------------------------------------------------------------------------
    // FFprobe Availability Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_ffprobe_availability_check() {
        // This just tests that the function runs without panicking
        let _is_available = MetadataExtractor::is_available();
    }

    // -------------------------------------------------------------------------
    // Display Rotation Tests
    // -------------------------------------------------------------------------

    /// Feature: Portrait phone footage
    /// Scenario: a display matrix is read alongside the coded dimensions
    ///
    /// A phone records portrait as a landscape-coded stream plus a quarter-turn
    /// display matrix. FFmpeg auto-rotates on decode, so anything sizing a
    /// picture off the coded width and height alone stretches the clip.
    #[test]
    fn should_parse_the_display_matrix_rotation_of_a_portrait_recording() {
        let json = r#"{
            "streams": [
                {
                    "codec_type": "video",
                    "codec_name": "h264",
                    "width": 1920,
                    "height": 1080,
                    "r_frame_rate": "30/1",
                    "side_data_list": [
                        {
                            "side_data_type": "Display Matrix",
                            "displaymatrix": "00000000: 0 65536 0",
                            "rotation": -90
                        }
                    ]
                }
            ],
            "format": { "duration": "4.0", "size": "1000", "format_name": "mov,mp4" }
        }"#;

        let metadata = MetadataExtractor::parse_ffprobe_output(json).expect("parse");

        let video = metadata.video.expect("video stream");
        assert_eq!((video.width, video.height), (1920, 1080));
        assert_eq!(metadata.rotation_deg, -90.0);
        assert_eq!(
            crate::core::ffmpeg::display_dimensions(
                video.width,
                video.height,
                metadata.rotation_deg
            ),
            (1080, 1920)
        );
    }

    /// Feature: Portrait phone footage
    /// Scenario: an unrotated recording reports no turn
    #[test]
    fn should_report_no_rotation_for_an_ordinary_recording() {
        let json = r#"{
            "streams": [
                {
                    "codec_type": "video",
                    "codec_name": "h264",
                    "width": 1280,
                    "height": 720,
                    "r_frame_rate": "30/1"
                }
            ],
            "format": { "duration": "4.0", "size": "1000", "format_name": "mov,mp4" }
        }"#;

        let metadata = MetadataExtractor::parse_ffprobe_output(json).expect("parse");

        assert_eq!(metadata.rotation_deg, 0.0);
    }

    // -------------------------------------------------------------------------
    // Frame Rate Parsing Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_parse_frame_rate_30fps() {
        let fps = MetadataExtractor::parse_frame_rate("30/1");
        assert_eq!(fps.num, 30);
        assert_eq!(fps.den, 1);
    }

    #[test]
    fn test_parse_frame_rate_24fps() {
        let fps = MetadataExtractor::parse_frame_rate("24/1");
        assert_eq!(fps.num, 24);
        assert_eq!(fps.den, 1);
    }

    #[test]
    fn test_parse_frame_rate_ntsc() {
        // 29.97 fps (NTSC)
        let fps = MetadataExtractor::parse_frame_rate("30000/1001");
        assert_eq!(fps.num, 30000);
        assert_eq!(fps.den, 1001);
    }

    #[test]
    fn test_parse_frame_rate_film_ntsc() {
        // 23.976 fps
        let fps = MetadataExtractor::parse_frame_rate("24000/1001");
        assert_eq!(fps.num, 24000);
        assert_eq!(fps.den, 1001);
    }

    #[test]
    fn test_parse_frame_rate_invalid_returns_default() {
        let fps = MetadataExtractor::parse_frame_rate("invalid");
        assert_eq!(fps.num, 30);
        assert_eq!(fps.den, 1);
    }

    #[test]
    fn test_parse_frame_rate_zero_denominator() {
        let fps = MetadataExtractor::parse_frame_rate("30/0");
        assert_eq!(fps.num, 30);
        assert_eq!(fps.den, 1);
    }

    // -------------------------------------------------------------------------
    // FFprobe JSON Parsing Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_parse_video_metadata() {
        let json = r#"{
            "streams": [
                {
                    "codec_type": "video",
                    "codec_name": "h264",
                    "width": 1920,
                    "height": 1080,
                    "r_frame_rate": "30/1",
                    "bit_rate": "5000000"
                }
            ],
            "format": {
                "duration": "120.5",
                "size": "75000000",
                "format_name": "mov,mp4,m4a,3gp,3g2,mj2"
            }
        }"#;

        let metadata = MetadataExtractor::parse_ffprobe_output(json).unwrap();

        assert_eq!(metadata.duration_sec, 120.5);
        assert_eq!(metadata.file_size, 75000000);
        assert!(metadata.video.is_some());

        let video = metadata.video.unwrap();
        assert_eq!(video.width, 1920);
        assert_eq!(video.height, 1080);
        assert_eq!(video.fps.num, 30);
        assert_eq!(video.fps.den, 1);
        assert_eq!(video.codec, "h264");
        assert_eq!(video.bitrate, Some(5000000));
    }

    #[test]
    fn test_parse_audio_only_metadata() {
        let json = r#"{
            "streams": [
                {
                    "codec_type": "audio",
                    "codec_name": "mp3",
                    "sample_rate": "44100",
                    "channels": 2,
                    "bit_rate": "320000"
                }
            ],
            "format": {
                "duration": "180.0",
                "size": "7200000",
                "format_name": "mp3"
            }
        }"#;

        let metadata = MetadataExtractor::parse_ffprobe_output(json).unwrap();

        assert_eq!(metadata.duration_sec, 180.0);
        assert!(metadata.video.is_none());
        assert!(metadata.audio.is_some());

        let audio = metadata.audio.unwrap();
        assert_eq!(audio.sample_rate, 44100);
        assert_eq!(audio.channels, 2);
        assert_eq!(audio.codec, "mp3");
        assert_eq!(audio.bitrate, Some(320000));
    }

    #[test]
    fn test_parse_video_with_audio_metadata() {
        let json = r#"{
            "streams": [
                {
                    "codec_type": "video",
                    "codec_name": "hevc",
                    "width": 3840,
                    "height": 2160,
                    "r_frame_rate": "60/1"
                },
                {
                    "codec_type": "audio",
                    "codec_name": "aac",
                    "sample_rate": "48000",
                    "channels": 6
                }
            ],
            "format": {
                "duration": "600.0",
                "size": "1200000000",
                "format_name": "matroska,webm"
            }
        }"#;

        let metadata = MetadataExtractor::parse_ffprobe_output(json).unwrap();

        assert!(metadata.video.is_some());
        assert!(metadata.audio.is_some());

        let video = metadata.video.unwrap();
        assert_eq!(video.width, 3840);
        assert_eq!(video.height, 2160);
        assert_eq!(video.codec, "hevc");

        let audio = metadata.audio.unwrap();
        assert_eq!(audio.sample_rate, 48000);
        assert_eq!(audio.channels, 6);
        assert_eq!(audio.codec, "aac");
    }

    #[test]
    fn test_parse_empty_streams() {
        let json = r#"{
            "streams": [],
            "format": {
                "duration": "10.0",
                "size": "1000",
                "format_name": "unknown"
            }
        }"#;

        let metadata = MetadataExtractor::parse_ffprobe_output(json).unwrap();

        assert!(metadata.video.is_none());
        assert!(metadata.audio.is_none());
        assert_eq!(metadata.duration_sec, 10.0);
    }

    #[test]
    fn test_parse_missing_optional_fields() {
        let json = r#"{
            "streams": [
                {
                    "codec_type": "video"
                }
            ],
            "format": {}
        }"#;

        let metadata = MetadataExtractor::parse_ffprobe_output(json).unwrap();

        assert!(metadata.video.is_some());

        let video = metadata.video.unwrap();
        // Default values should be used
        assert_eq!(video.width, 1920);
        assert_eq!(video.height, 1080);
        assert_eq!(video.fps.num, 30);
        assert_eq!(video.codec, "unknown");
    }

    #[test]
    fn test_parse_invalid_json() {
        let json = "invalid json";
        let result = MetadataExtractor::parse_ffprobe_output(json);
        assert!(result.is_err());
    }

    /// Feature: probe failure classification
    /// Scenario: FFprobe exits successfully with output nothing can be read from
    ///
    /// Given output that does not parse
    /// When a caller asks whether the probe measured anything
    /// Then it is told no, so it does not register an asset from defaults the
    /// probe never reported; a verdict FFprobe did reach about the file is
    /// still reported as a measurement that happened.
    #[test]
    fn a_probe_whose_output_cannot_be_read_measured_nothing() {
        let unreadable = MetadataExtractor::parse_ffprobe_output("invalid json")
            .expect_err("unreadable output is a failure");
        assert!(probe_measured_nothing(&unreadable));

        assert!(probe_measured_nothing(&CoreError::FFprobeUnavailable(
            "Failed to run ffprobe: program not found".to_string()
        )));
        assert!(!probe_measured_nothing(&CoreError::FFprobeError(
            "FFprobe failed: Invalid data found when processing input".to_string()
        )));

        // A verdict that merely quotes the marker further along is still a
        // verdict: FFprobe looked at the file and had something to say about
        // it, so the caller may keep the defaults.
        assert!(
            !probe_measured_nothing(&CoreError::FFprobeError(
                "FFprobe failed: FFprobe reported nothing decodable".to_string()
            )),
            "the marker only marks when the message starts with it"
        );
    }

    // -------------------------------------------------------------------------
    // File Not Found Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_extract_file_not_found() {
        let result = MetadataExtractor::extract("/nonexistent/path/to/file.mp4");
        assert!(matches!(result, Err(CoreError::FileNotFound(_))));
    }

    // -------------------------------------------------------------------------
    // Integration Tests (require FFprobe)
    // -------------------------------------------------------------------------

    #[test]
    #[ignore] // Run with: cargo test -- --ignored
    fn test_extract_real_video_file() {
        // This test requires a real video file and FFprobe installed
        // Place a test video at this path to run:
        // let path = "test_assets/sample_1080p.mp4";
        // let metadata = MetadataExtractor::extract(path).unwrap();
        // assert!(metadata.video.is_some());
        // assert!(metadata.duration_sec > 0.0);
    }

    // -------------------------------------------------------------------------
    // HDR Detection Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_parse_hdr10_video_metadata() {
        let json = r#"{
            "streams": [
                {
                    "codec_type": "video",
                    "codec_name": "hevc",
                    "width": 3840,
                    "height": 2160,
                    "r_frame_rate": "24/1",
                    "color_transfer": "smpte2084",
                    "color_space": "bt2020nc",
                    "color_primaries": "bt2020",
                    "pix_fmt": "yuv420p10le"
                }
            ],
            "format": {
                "duration": "120.0",
                "size": "500000000"
            }
        }"#;

        let metadata = MetadataExtractor::parse_ffprobe_output(json).unwrap();
        let video = metadata.video.unwrap();

        assert!(video.is_hdr, "HDR10 content should be detected as HDR");
        assert_eq!(video.color_transfer.as_deref(), Some("smpte2084"));
        assert_eq!(video.codec, "hevc");
    }

    #[test]
    fn test_parse_hlg_video_metadata() {
        let json = r#"{
            "streams": [
                {
                    "codec_type": "video",
                    "codec_name": "hevc",
                    "width": 1920,
                    "height": 1080,
                    "r_frame_rate": "50/1",
                    "color_transfer": "arib-std-b67"
                }
            ],
            "format": {
                "duration": "60.0"
            }
        }"#;

        let metadata = MetadataExtractor::parse_ffprobe_output(json).unwrap();
        let video = metadata.video.unwrap();

        assert!(video.is_hdr, "HLG content should be detected as HDR");
        assert_eq!(video.color_transfer.as_deref(), Some("arib-std-b67"));
    }

    #[test]
    fn test_parse_sdr_video_not_detected_as_hdr() {
        let json = r#"{
            "streams": [
                {
                    "codec_type": "video",
                    "codec_name": "h264",
                    "width": 1920,
                    "height": 1080,
                    "r_frame_rate": "30/1",
                    "color_transfer": "bt709"
                }
            ],
            "format": {
                "duration": "30.0"
            }
        }"#;

        let metadata = MetadataExtractor::parse_ffprobe_output(json).unwrap();
        let video = metadata.video.unwrap();

        assert!(!video.is_hdr, "SDR content should not be detected as HDR");
        assert_eq!(video.color_transfer.as_deref(), Some("bt709"));
    }

    #[test]
    fn test_parse_video_without_color_transfer_defaults_to_sdr() {
        let json = r#"{
            "streams": [
                {
                    "codec_type": "video",
                    "codec_name": "h264",
                    "width": 1280,
                    "height": 720,
                    "r_frame_rate": "30/1"
                }
            ],
            "format": {
                "duration": "10.0"
            }
        }"#;

        let metadata = MetadataExtractor::parse_ffprobe_output(json).unwrap();
        let video = metadata.video.unwrap();

        assert!(
            !video.is_hdr,
            "Missing color_transfer should default to SDR"
        );
        assert!(video.color_transfer.is_none());
    }
}
