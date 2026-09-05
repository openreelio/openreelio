//! Turning an FFprobe reading into asset commands.
//!
//! Import used to exist twice: the GUI probed a file and translated the
//! reading into an [`ImportAssetCommand`], while the CLI skipped the probe
//! entirely and imported a bare asset with no duration. An asset with no
//! duration makes every later insert fall back to a ten-second default, so a
//! four-second file became a clip that overran its own media, collided with
//! the next insert and produced a video-less render. The translation lives
//! here so both surfaces record the same asset for the same file.

use crate::core::{
    assets::{AssetKind, AudioInfo, VideoInfo},
    commands::{ImportAssetCommand, UpdateAssetCommand},
    ffmpeg::{AudioStreamInfo, MediaInfo, VideoStreamInfo},
    Ratio,
};

/// Tolerance for recognising an NTSC frame rate in a probed float.
const NTSC_TOLERANCE: f64 = 0.01;

/// Tolerance for treating a probed frame rate as a whole number.
const INTEGER_FPS_TOLERANCE: f64 = 0.001;

/// Denominator used for frame rates that are neither NTSC nor integral.
const FRACTIONAL_FPS_DENOMINATOR: i32 = 1000;

/// Converts a floating-point FPS value to a Ratio (numerator, denominator).
///
/// Handles common video frame rates including NTSC (23.976, 29.97, 59.94).
/// Returns `(0, 1)` for invalid input (NaN, Infinity, zero, negative).
pub fn fps_to_ratio(fps: f64) -> (i32, i32) {
    // Guard against invalid FPS values from malformed media or FFprobe errors
    if !fps.is_finite() || fps <= 0.0 {
        return (0, 1);
    }

    if (fps - 23.976).abs() < NTSC_TOLERANCE {
        return (24000, 1001);
    }
    if (fps - 29.97).abs() < NTSC_TOLERANCE {
        return (30000, 1001);
    }
    if (fps - 59.94).abs() < NTSC_TOLERANCE {
        return (60000, 1001);
    }

    // For standard frame rates (24, 25, 30, 50, 60, etc.)
    let rounded = fps.round();
    if (fps - rounded).abs() < INTEGER_FPS_TOLERANCE {
        return (rounded as i32, 1);
    }

    // For other fractional frame rates, use a reasonable approximation
    let num = (fps * FRACTIONAL_FPS_DENOMINATOR as f64).round() as i32;
    (num, FRACTIONAL_FPS_DENOMINATOR)
}

/// Builds the stored video metadata for a probed video stream.
pub fn video_info_from_probe(video_stream: &VideoStreamInfo) -> VideoInfo {
    let (fps_num, fps_den) = fps_to_ratio(video_stream.fps);
    VideoInfo {
        width: video_stream.width,
        height: video_stream.height,
        fps: Ratio::new(fps_num, fps_den),
        codec: video_stream.codec.clone(),
        bitrate: video_stream.bitrate,
        has_alpha: false,
        is_hdr: video_stream.is_hdr,
        color_transfer: video_stream.color_transfer.clone(),
    }
}

/// Builds the stored audio metadata for a probed audio stream.
pub fn audio_info_from_probe(audio_stream: &AudioStreamInfo) -> AudioInfo {
    AudioInfo {
        sample_rate: audio_stream.sample_rate,
        channels: audio_stream.channels,
        codec: audio_stream.codec.clone(),
        bitrate: audio_stream.bitrate,
    }
}

/// Builds the import command for a file, enriched by a probe when there is one.
///
/// Without `media_info` this is exactly [`ImportAssetCommand::new`]: extension
/// inference and no duration. With one, the asset kind is corrected against
/// what the file actually contains — an `.ogg` holding pictures is a video, an
/// `.mp4` holding only sound is audio — and duration, size, dimensions, frame
/// rate and audio format are recorded.
pub fn import_command_from_probe(
    name: &str,
    resolved_uri: &str,
    media_info: Option<&MediaInfo>,
) -> ImportAssetCommand {
    let mut command = ImportAssetCommand::new(name, resolved_uri);
    let extension = std::path::Path::new(resolved_uri)
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
        .unwrap_or_default();
    let is_ambiguous_ogg = extension == "ogg";

    let Some(info) = media_info else {
        return command;
    };

    let has_video = info.video.is_some();
    let has_audio = info.audio.is_some();

    command = match command.asset.kind {
        AssetKind::Image => ImportAssetCommand::image(name, resolved_uri, 1920, 1080),
        AssetKind::Audio => {
            if is_ambiguous_ogg && has_video {
                match info.video.as_ref() {
                    Some(video_stream) => ImportAssetCommand::video(
                        name,
                        resolved_uri,
                        video_info_from_probe(video_stream),
                    ),
                    None => ImportAssetCommand::new(name, resolved_uri),
                }
            } else if let Some(audio_stream) = info.audio.as_ref() {
                ImportAssetCommand::audio(name, resolved_uri, audio_info_from_probe(audio_stream))
            } else {
                ImportAssetCommand::audio(name, resolved_uri, AudioInfo::default())
            }
        }
        AssetKind::Video => {
            if !has_video && has_audio {
                match info.audio.as_ref() {
                    Some(audio_stream) => ImportAssetCommand::audio(
                        name,
                        resolved_uri,
                        audio_info_from_probe(audio_stream),
                    ),
                    None => ImportAssetCommand::new(name, resolved_uri),
                }
            } else if let Some(video_stream) = info.video.as_ref() {
                ImportAssetCommand::video(name, resolved_uri, video_info_from_probe(video_stream))
            } else {
                ImportAssetCommand::new(name, resolved_uri)
            }
        }
        _ => ImportAssetCommand::new(name, resolved_uri),
    };

    command = command
        .with_duration(info.duration_sec)
        .with_file_size(info.size_bytes);

    if matches!(command.asset.kind, AssetKind::Video) {
        if let Some(video_stream) = info.video.as_ref() {
            command = command.with_video_info(video_info_from_probe(video_stream));
        }
    }

    if matches!(command.asset.kind, AssetKind::Audio | AssetKind::Video) {
        if let Some(audio_stream) = info.audio.as_ref() {
            command = command.with_audio_info(audio_info_from_probe(audio_stream));
        }
    }

    command
}

/// Builds the update command that back-fills a probe onto an existing asset.
///
/// Used when an asset was imported without a probe — `asset import
/// --no-probe`, or an import that ran while FFmpeg was unresolvable — and a
/// later verb needs the duration. Going through a command rather than mutating
/// the asset keeps the correction in the ops log, so replaying the project
/// reproduces it.
pub fn update_command_from_probe(asset_id: &str, media_info: &MediaInfo) -> UpdateAssetCommand {
    let mut command = UpdateAssetCommand::new(asset_id)
        .with_duration_sec(Some(media_info.duration_sec))
        .with_file_size(media_info.size_bytes);

    if let Some(video_stream) = media_info.video.as_ref() {
        command = command.with_video(Some(video_info_from_probe(video_stream)));
    }
    if let Some(audio_stream) = media_info.audio.as_ref() {
        command = command.with_audio(Some(audio_info_from_probe(audio_stream)));
    }

    command
}

#[cfg(test)]
mod tests {
    use super::*;

    fn video_stream() -> VideoStreamInfo {
        VideoStreamInfo {
            width: 1920,
            height: 1080,
            fps: 30.0,
            codec: "h264".to_string(),
            pixel_format: "yuv420p".to_string(),
            bitrate: Some(8_000_000),
            is_hdr: false,
            color_transfer: None,
            rotation_deg: 0.0,
        }
    }

    fn audio_stream() -> AudioStreamInfo {
        AudioStreamInfo {
            sample_rate: 48_000,
            channels: 2,
            codec: "aac".to_string(),
            bitrate: Some(192_000),
        }
    }

    fn media_info(duration_sec: f64) -> MediaInfo {
        MediaInfo {
            duration_sec,
            video_duration_sec: Some(duration_sec),
            video: Some(video_stream()),
            audio: Some(audio_stream()),
            format: "mov,mp4,m4a".to_string(),
            size_bytes: 4096,
        }
    }

    #[test]
    fn should_record_the_probed_duration_and_dimensions_when_a_probe_is_given() {
        let command =
            import_command_from_probe("clip.mp4", "/media/clip.mp4", Some(&media_info(4.0)));

        assert_eq!(command.asset.duration_sec, Some(4.0));
        let video = command.asset.video.expect("probed video metadata");
        assert_eq!(video.width, 1920);
        assert_eq!(video.height, 1080);
        assert_eq!(video.fps.num, 30);
        assert!(command.asset.audio.is_some());
    }

    #[test]
    fn should_leave_the_duration_unknown_when_no_probe_is_given() {
        let command = import_command_from_probe("clip.mp4", "/media/clip.mp4", None);

        assert_eq!(command.asset.duration_sec, None);
    }

    #[test]
    fn should_classify_a_video_container_holding_only_sound_as_audio() {
        let mut info = media_info(4.0);
        info.video = None;

        let command = import_command_from_probe("voice.mp4", "/media/voice.mp4", Some(&info));

        assert_eq!(command.asset.kind, AssetKind::Audio);
        assert_eq!(command.asset.duration_sec, Some(4.0));
    }

    #[test]
    fn should_back_fill_duration_and_streams_through_an_update_command() {
        let command = update_command_from_probe("asset-1", &media_info(5.76));

        assert_eq!(command.duration_sec, Some(Some(5.76)));
        assert!(command.video.is_some());
        assert!(command.audio.is_some());
    }

    #[test]
    fn should_keep_the_image_kind_when_a_still_reports_a_video_stream() {
        let mut info = media_info(0.04);
        info.audio = None;

        let command = import_command_from_probe("cover.jpg", "/tmp/cover.jpg", Some(&info));

        assert_eq!(command.asset.kind, AssetKind::Image);
    }

    #[test]
    fn should_keep_the_audio_kind_when_cover_art_reports_a_video_stream() {
        let command =
            import_command_from_probe("podcast.m4a", "/tmp/podcast.m4a", Some(&media_info(120.0)));

        assert_eq!(command.asset.kind, AssetKind::Audio);
    }

    #[test]
    fn should_promote_an_ambiguous_ogg_carrying_pictures_to_video() {
        let command =
            import_command_from_probe("clip.ogg", "/tmp/clip.ogg", Some(&media_info(6.0)));

        assert_eq!(command.asset.kind, AssetKind::Video);
    }

    #[test]
    fn should_promote_an_unknown_extension_without_pictures_to_audio() {
        let mut info = media_info(6.0);
        info.video = None;

        let command = import_command_from_probe("voice.track", "/tmp/voice.track", Some(&info));

        assert_eq!(command.asset.kind, AssetKind::Audio);
    }

    #[test]
    fn should_preserve_hdr_metadata_from_the_probed_video_stream() {
        let stream = VideoStreamInfo {
            width: 3840,
            height: 2160,
            fps: 23.976,
            codec: "hevc".to_string(),
            pixel_format: "yuv420p10le".to_string(),
            bitrate: Some(25_000_000),
            is_hdr: true,
            color_transfer: Some("smpte2084".to_string()),
            rotation_deg: 0.0,
        };

        let video_info = video_info_from_probe(&stream);

        assert!(video_info.is_hdr);
        assert_eq!(video_info.color_transfer.as_deref(), Some("smpte2084"));
        assert_eq!(video_info.fps.num, 24000);
        assert_eq!(video_info.fps.den, 1001);
    }

    #[test]
    fn should_map_ntsc_and_invalid_frame_rates_to_stable_ratios() {
        assert_eq!(fps_to_ratio(29.97), (30000, 1001));
        assert_eq!(fps_to_ratio(25.0), (25, 1));
        assert_eq!(fps_to_ratio(f64::NAN), (0, 1));
        assert_eq!(fps_to_ratio(0.0), (0, 1));
    }
}
