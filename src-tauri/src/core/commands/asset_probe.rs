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
    project::ProjectState,
    CoreError, CoreResult, Ratio,
};

/// Tolerance for recognising an NTSC frame rate in a probed float.
const NTSC_TOLERANCE: f64 = 0.01;

/// Tolerance for treating a probed frame rate as a whole number.
const INTEGER_FPS_TOLERANCE: f64 = 0.001;

/// Denominator used for frame rates that are neither NTSC nor integral.
const FRACTIONAL_FPS_DENOMINATOR: i32 = 1000;

/// Slack below which a source bound is rounding rather than a real overrun.
const SOURCE_BOUND_EPSILON_SEC: f64 = 1e-6;

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

/// The duration a probe is allowed to hand to an asset, or `None`.
///
/// FFprobe reports `0` or a non-finite duration for containers it cannot
/// measure — and for a PNG, which has no `format.duration` at all — and
/// recording that as the asset's length would make every later insert fail with
/// an empty source range instead of falling back to the default. Only a
/// positive, finite reading is a duration.
pub fn usable_duration_sec(media_info: &MediaInfo) -> Option<f64> {
    Some(media_info.duration_sec).filter(|value| value.is_finite() && *value > 0.0)
}

/// The duration to record for an asset of the given kind, or `None`.
///
/// Two readings of the same file are not interchangeable:
///
/// * A still has no length. FFprobe answers `0` for a PNG and one frame's worth
///   (`0.04`) for a JPEG, and recording either turns the next insert into a
///   refusal ("sourceOut must be greater than sourceIn") or a 40ms clip. An
///   image holds whatever slot the timeline gives it, so it records nothing.
/// * A video is bounded by its *video stream*, not by its container. The
///   renderer bounds every picture clip by
///   [`resolve_asset_source_duration`](crate::core::render::resolve_asset_source_duration),
///   which reads the video stream's own length; an mp4 whose AAC outlasts its
///   pictures by 0.2s would otherwise be recorded 0.2s too long and every clip
///   cut from it would carry a black tail and an overrun warning.
pub fn recorded_duration_sec(media_info: &MediaInfo, asset_kind: &AssetKind) -> Option<f64> {
    match asset_kind {
        AssetKind::Image => None,
        AssetKind::Video => media_info
            .video_duration_sec
            .filter(|value| value.is_finite() && *value > 0.0)
            .or_else(|| usable_duration_sec(media_info)),
        _ => usable_duration_sec(media_info),
    }
}

/// Refuses a source-out point that reaches past the end of a clip's media.
///
/// Nothing downstream can recover the frames such an edit asks for: the render
/// pads the missing seconds with black and the preview shows the same. Naming
/// the asset's recorded length here is what lets the caller retry with a number
/// that exists. Shared by every surface that trims — `timeline trim`, `command
/// execute --type TrimClip`, `plan execute` and the MCP plan tools — so the
/// refusal cannot be true of one of them and not the others.
///
/// Silent (`Ok`) whenever the bound is unknowable rather than satisfied: a
/// missing sequence, clip or asset is the executing command's error to report,
/// an unmeasured asset has no length to check against, and a still holds its
/// slot however long the timeline makes it.
pub fn ensure_source_out_within_media(
    state: &ProjectState,
    sequence_id: &str,
    clip_id: &str,
    source_out: Option<f64>,
) -> CoreResult<()> {
    let Some(source_out) = source_out else {
        return Ok(());
    };
    let Some(sequence) = state.sequences.get(sequence_id) else {
        return Ok(());
    };
    let Some(clip) = sequence
        .tracks
        .iter()
        .flat_map(|track| track.clips.iter())
        .find(|clip| clip.id == clip_id)
    else {
        return Ok(());
    };
    let Some(asset) = state.assets.get(&clip.asset_id) else {
        return Ok(());
    };
    if asset.kind == AssetKind::Image {
        return Ok(());
    }
    let Some(duration_sec) = asset
        .duration_sec
        .filter(|duration| duration.is_finite() && *duration > 0.0)
    else {
        return Ok(());
    };

    if source_out > duration_sec + SOURCE_BOUND_EPSILON_SEC {
        return Err(CoreError::ValidationError(format!(
            "sourceOut {source_out} is past the end of asset '{}', which holds only {duration_sec:.3}s of media. Use {duration_sec:.3} or less.",
            asset.id
        )));
    }

    Ok(())
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
/// rate and audio format are recorded — except a duration the file does not
/// have, which is left unknown rather than recorded as zero; see
/// [`recorded_duration_sec`].
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

    // Only a length the file actually has: a still records none, and a video
    // records its picture's length rather than its container's. See
    // [`recorded_duration_sec`].
    if let Some(duration_sec) = recorded_duration_sec(info, &command.asset.kind) {
        command = command.with_duration(duration_sec);
    }
    command = command.with_file_size(info.size_bytes);

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
///
/// `asset_kind` decides which reading is recorded — see
/// [`recorded_duration_sec`] — and a probe carrying no usable duration for that
/// kind leaves the asset's duration untouched rather than clearing it.
pub fn update_command_from_probe(
    asset_id: &str,
    asset_kind: &AssetKind,
    media_info: &MediaInfo,
) -> UpdateAssetCommand {
    let mut command = UpdateAssetCommand::new(asset_id);

    if let Some(duration_sec) = recorded_duration_sec(media_info, asset_kind) {
        command = command.with_duration_sec(Some(duration_sec));
    }
    // A probe that could not size the file must not erase a size the import
    // already recorded: `0` here means "unread", not "empty".
    if media_info.size_bytes > 0 {
        command = command.with_file_size(media_info.size_bytes);
    }

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
        let command = update_command_from_probe("asset-1", &AssetKind::Video, &media_info(5.76));

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
    fn should_leave_a_still_without_a_duration_whatever_ffprobe_reported() {
        // FFprobe answers a PNG with no `format.duration` at all, which reads
        // back as `0`, and a JPEG with a single frame's `0.04`.
        let mut png = media_info(0.0);
        png.video_duration_sec = None;
        png.audio = None;
        let mut jpeg = media_info(0.04);
        jpeg.audio = None;

        let png_command = import_command_from_probe("still.png", "/tmp/still.png", Some(&png));
        let jpeg_command = import_command_from_probe("cover.jpg", "/tmp/cover.jpg", Some(&jpeg));

        assert_eq!(png_command.asset.duration_sec, None);
        assert_eq!(jpeg_command.asset.duration_sec, None);
        assert_eq!(
            update_command_from_probe("asset-1", &AssetKind::Image, &jpeg).duration_sec,
            None
        );
    }

    #[test]
    fn should_leave_the_duration_unknown_when_the_probe_reported_nothing_measurable() {
        let mut unmeasurable = media_info(0.0);
        unmeasurable.video_duration_sec = None;
        let mut infinite = media_info(f64::INFINITY);
        infinite.video_duration_sec = None;

        assert_eq!(
            import_command_from_probe("clip.mp4", "/tmp/clip.mp4", Some(&unmeasurable))
                .asset
                .duration_sec,
            None
        );
        assert_eq!(
            import_command_from_probe("clip.mp4", "/tmp/clip.mp4", Some(&infinite))
                .asset
                .duration_sec,
            None
        );
    }

    #[test]
    fn should_record_the_video_streams_length_rather_than_the_containers() {
        // An mp4 whose AAC outlasts its pictures: the renderer bounds the clip
        // by the 4.0s of video, so recording the container's 4.2s would give
        // every clip a black tail and an overrun warning.
        let mut info = media_info(4.2);
        info.video_duration_sec = Some(4.0);

        let command = import_command_from_probe("clip.mp4", "/tmp/clip.mp4", Some(&info));

        assert_eq!(command.asset.duration_sec, Some(4.0));
        assert_eq!(
            update_command_from_probe("asset-1", &AssetKind::Video, &info).duration_sec,
            Some(Some(4.0))
        );
    }

    #[test]
    fn should_keep_the_container_length_for_sound_carried_beside_cover_art() {
        // A podcast .m4a carries a one-frame cover-art "video stream"; the
        // sound is what the asset is.
        let mut info = media_info(120.0);
        info.video_duration_sec = Some(0.04);

        let command = import_command_from_probe("podcast.m4a", "/tmp/podcast.m4a", Some(&info));

        assert_eq!(command.asset.kind, AssetKind::Audio);
        assert_eq!(command.asset.duration_sec, Some(120.0));
    }

    #[test]
    fn should_keep_a_recorded_file_size_when_the_probe_could_not_measure_one() {
        let mut info = media_info(4.0);
        info.size_bytes = 0;

        let command = update_command_from_probe("asset-1", &AssetKind::Video, &info);

        assert_eq!(command.file_size, None);
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
