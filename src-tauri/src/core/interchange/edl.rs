//! CMX 3600 EDL Export
//!
//! Generates Edit Decision Lists in the CMX 3600 format, the industry standard
//! for exchanging timeline data between NLEs.
//!
//! ## Format Reference
//!
//! ```text
//! TITLE: Sequence Name
//! FCM: NON-DROP FRAME
//!
//! 001  REEL001  V  C        00:00:05:00 00:00:10:00 00:00:00:00 00:00:05:00
//! * FROM CLIP NAME: my_clip.mp4
//! * SOURCE FILE: /path/to/my_clip.mp4
//! ```
//!
//! Each event line: event#, reel, channel, edit_type, src_in, src_out, rec_in, rec_out
//!
//! ## Limitations
//!
//! - EDL is a flat format — only one video track is exported per EDL.
//!   Multiple video tracks require multiple EDL files.
//! - Effects and keyframes are not representable in EDL.
//! - Reel names are truncated to 8 characters (CMX 3600 limitation).
//! - Audio-only clips are exported as separate audio events.

use std::collections::HashMap;
use std::fmt::Write;

use crate::core::assets::Asset;
use crate::core::timeline::{Clip, Sequence, Track, TrackKind};
use crate::core::Ratio;

use super::models::{
    is_drop_frame_rate, truncate_reel_name, EditType, EdlChannel, EdlEvent,
    InterchangeExportResult, InterchangeFormat, Timecode,
};

// =============================================================================
// Public API
// =============================================================================

/// Exports a sequence to CMX 3600 EDL format string.
///
/// Processes video and audio tracks separately, generating events for each
/// enabled clip. Disabled clips are skipped. The returned string is a complete
/// EDL file ready to be written to disk.
///
/// # Arguments
/// * `sequence` - The sequence to export
/// * `assets` - Asset map for resolving clip source names and paths
///
/// # Returns
/// A tuple of (edl_content, event_count, track_count)
pub fn export_edl(
    sequence: &Sequence,
    assets: &HashMap<String, Asset>,
) -> Result<(String, u32, u32), String> {
    validate_edl_compatibility(sequence)?;

    let fps = &sequence.format.fps;
    let drop_frame = is_drop_frame_rate(fps);

    let mut output = String::with_capacity(4096);

    // Header
    write_header(&mut output, &sequence.name, drop_frame);

    // Collect events from all tracks
    let mut events: Vec<EdlEvent> = Vec::new();
    let mut track_count: u32 = 0;

    // Process video tracks first (EDL convention: video before audio)
    for track in &sequence.tracks {
        if !track.is_video() {
            continue;
        }
        let track_events = build_track_events(track, assets, fps, &mut events);
        if track_events > 0 {
            track_count += 1;
        }
    }

    // Process audio tracks
    for track in &sequence.tracks {
        if !track.is_audio() {
            continue;
        }
        let track_events = build_track_events(track, assets, fps, &mut events);
        if track_events > 0 {
            track_count += 1;
        }
    }

    // Renumber events sequentially (1-based)
    for (i, event) in events.iter_mut().enumerate() {
        event.event_number = (i + 1) as u32;
    }

    let event_count = events.len() as u32;

    // Write events
    for event in &events {
        write_event(&mut output, event);
    }

    Ok((output, event_count, track_count))
}

fn validate_edl_compatibility(sequence: &Sequence) -> Result<(), String> {
    let video_tracks_with_clips = sequence
        .tracks
        .iter()
        .filter(|track| track.is_video() && track.clips.iter().any(|clip| clip.enabled))
        .count();

    if video_tracks_with_clips > 1 {
        return Err(format!(
            "EDL export supports only one video track per file; found {} enabled video tracks",
            video_tracks_with_clips
        ));
    }

    Ok(())
}

/// Builds an `InterchangeExportResult` from the export output.
pub fn build_export_result(
    output_path: &str,
    event_count: u32,
    track_count: u32,
    duration_sec: f64,
) -> InterchangeExportResult {
    InterchangeExportResult {
        output_path: output_path.to_string(),
        format: InterchangeFormat::Edl,
        event_count,
        track_count,
        duration_sec,
    }
}

// =============================================================================
// Internal: Header
// =============================================================================

fn write_header(output: &mut String, title: &str, drop_frame: bool) {
    let _ = writeln!(output, "TITLE: {}", title);
    let fcm = if drop_frame {
        "DROP FRAME"
    } else {
        "NON-DROP FRAME"
    };
    let _ = writeln!(output, "FCM: {}", fcm);
    let _ = writeln!(output);
}

// =============================================================================
// Internal: Event Building
// =============================================================================

/// Builds EDL events for all enabled clips in a track.
/// Returns the number of events added.
fn build_track_events(
    track: &Track,
    assets: &HashMap<String, Asset>,
    fps: &Ratio,
    events: &mut Vec<EdlEvent>,
) -> u32 {
    let channel = match track.kind {
        TrackKind::Video | TrackKind::Overlay => EdlChannel::Video,
        TrackKind::Audio => EdlChannel::Audio(vec![1, 2]),
        TrackKind::Caption => return 0, // Captions not exported in EDL
    };

    // Sort clips by timeline position
    let mut clips: Vec<&Clip> = track.clips.iter().filter(|c| c.enabled).collect();
    clips.sort_by(|a, b| {
        a.place
            .timeline_in_sec
            .partial_cmp(&b.place.timeline_in_sec)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let mut count = 0u32;

    for clip in clips {
        let asset = assets.get(&clip.asset_id);

        // Derive reel name from asset (or use placeholder)
        let reel_name = asset
            .map(|a| truncate_reel_name(&a.name, 8))
            .unwrap_or_else(|| "AX".to_string());

        // Source timecodes (position within the original media)
        let source_in = Timecode::from_seconds(clip.range.source_in_sec, fps);
        let source_out = Timecode::from_seconds(clip.range.source_out_sec, fps);

        // Record timecodes (position on the timeline)
        let record_in = Timecode::from_seconds(clip.place.timeline_in_sec, fps);
        let record_out = Timecode::from_seconds(clip.place.timeline_out_sec(), fps);

        // Clip name and source file from asset
        let clip_name = asset.map(|a| a.name.clone());
        let source_file = asset.map(|a| a.uri.clone());

        // Speed (only include if not 1.0)
        let speed = if (clip.speed - 1.0).abs() > 0.001 {
            Some(clip.speed)
        } else {
            None
        };

        let event = EdlEvent {
            event_number: 0, // Will be renumbered later
            reel_name,
            channel: channel.clone(),
            edit_type: EditType::Cut, // Default to cut; transitions handled below
            source_in,
            source_out,
            record_in,
            record_out,
            clip_name,
            source_file,
            speed,
        };

        events.push(event);
        count += 1;
    }

    count
}

// =============================================================================
// Internal: Event Writing
// =============================================================================

/// Writes a single EDL event to the output string.
fn write_event(output: &mut String, event: &EdlEvent) {
    // Main event line: ###  REELNAME CHANNEL EDIT_TYPE SRC_IN SRC_OUT REC_IN REC_OUT
    let _ = writeln!(
        output,
        "{:03}  {:<8} {:<6} {:<9} {} {} {} {}",
        event.event_number,
        event.reel_name,
        event.channel,
        event.edit_type,
        event.source_in,
        event.source_out,
        event.record_in,
        event.record_out,
    );

    // Speed change comment
    if let Some(speed) = event.speed {
        let speed_percent = speed * 100.0;
        let _ = writeln!(output, "M2   {} {:.1}", event.reel_name, speed_percent);
    }

    // Clip name comment
    if let Some(ref name) = event.clip_name {
        let _ = writeln!(output, "* FROM CLIP NAME: {}", name);
    }

    // Source file comment
    if let Some(ref path) = event.source_file {
        let _ = writeln!(output, "* SOURCE FILE: {}", path);
    }

    // Blank line between events
    let _ = writeln!(output);
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::assets::{Asset, AssetKind, LicenseInfo, ProxyStatus};
    use crate::core::timeline::{
        AudioSettings, BlendMode, Clip, ClipPlace, ClipRange, Sequence, SequenceFormat, Track,
        Transform,
    };

    /// Creates a test asset with the given name
    fn make_asset(id: &str, name: &str, uri: &str) -> Asset {
        Asset {
            id: id.to_string(),
            kind: AssetKind::Video,
            name: name.to_string(),
            uri: uri.to_string(),
            hash: "abc123".to_string(),
            duration_sec: Some(60.0),
            file_size: 1024,
            imported_at: "2026-01-01T00:00:00Z".to_string(),
            video: None,
            audio: None,
            license: LicenseInfo::default(),
            tags: vec![],
            thumbnail_url: None,
            proxy_status: ProxyStatus::NotNeeded,
            proxy_url: None,
            bin_id: None,
            relative_path: None,
            workspace_managed: false,
            missing: false,
        }
    }

    /// Creates a test clip placed on the timeline
    fn make_clip(
        id: &str,
        asset_id: &str,
        src_in: f64,
        src_out: f64,
        tl_in: f64,
        duration: f64,
    ) -> Clip {
        Clip {
            id: id.to_string(),
            asset_id: asset_id.to_string(),
            range: ClipRange::new(src_in, src_out),
            place: ClipPlace::new(tl_in, duration),
            transform: Transform::default(),
            opacity: 1.0,
            blend_mode: BlendMode::Normal,
            speed: 1.0,
            reverse: false,
            freeze_frame: false,
            time_remap: None,
            effects: vec![],
            audio: AudioSettings::default(),
            label: None,
            color: None,
            caption_style: None,
            caption_position: None,
            enabled: true,
            link_group_id: None,
            compound_sequence_id: None,
            is_adjustment_layer: false,
            group_id: None,
        }
    }

    /// Creates a test sequence with given fps
    fn make_sequence(name: &str, fps_num: i32, fps_den: i32) -> Sequence {
        Sequence::new(
            name,
            SequenceFormat::new(1920, 1080, fps_num, fps_den, 48000),
        )
    }

    // =========================================================================
    // BDD Tests
    // =========================================================================

    #[test]
    fn should_export_empty_sequence_with_header_only() {
        // Given: an empty sequence with no tracks
        let seq = make_sequence("Empty Project", 24, 1);
        let assets = HashMap::new();

        // When: exporting to EDL
        let (edl, event_count, track_count) =
            export_edl(&seq, &assets).expect("EDL export should succeed");

        // Then: output should contain header but no events
        assert!(edl.contains("TITLE: Empty Project"));
        assert!(edl.contains("FCM: NON-DROP FRAME"));
        assert_eq!(event_count, 0);
        assert_eq!(track_count, 0);
    }

    #[test]
    fn should_export_single_video_clip_with_correct_timecodes() {
        // Given: a sequence with one video clip (source 5-10s, placed at timeline 0-5s)
        let mut seq = make_sequence("Single Clip", 24, 1);
        let mut track = Track::new_video("V1");
        track.add_clip(make_clip("c1", "a1", 5.0, 10.0, 0.0, 5.0));
        seq.add_track(track);

        let mut assets = HashMap::new();
        assets.insert(
            "a1".to_string(),
            make_asset("a1", "interview.mp4", "/media/interview.mp4"),
        );

        // When: exporting to EDL
        let (edl, event_count, track_count) =
            export_edl(&seq, &assets).expect("EDL export should succeed");

        // Then: one event with correct timecodes
        assert_eq!(event_count, 1);
        assert_eq!(track_count, 1);
        assert!(edl.contains("001"));
        assert!(edl.contains("INTERVIE")); // reel name truncated to 8 chars
        assert!(edl.contains("V")); // video channel
        assert!(edl.contains("C")); // cut edit type
                                    // Source in: 00:00:05:00, Source out: 00:00:10:00
        assert!(edl.contains("00:00:05:00"));
        assert!(edl.contains("00:00:10:00"));
        // Record in: 00:00:00:00, Record out: 00:00:05:00
        assert!(edl.contains("00:00:00:00"));
        // Clip name comment
        assert!(edl.contains("* FROM CLIP NAME: interview.mp4"));
        assert!(edl.contains("* SOURCE FILE: /media/interview.mp4"));
    }

    #[test]
    fn should_export_multiple_clips_in_timeline_order() {
        // Given: a sequence with three clips out of order in the track
        let mut seq = make_sequence("Multi Clip", 30, 1);
        let mut track = Track::new_video("V1");
        // Add clips out of timeline order
        track.add_clip(make_clip("c3", "a1", 20.0, 25.0, 10.0, 5.0));
        track.add_clip(make_clip("c1", "a1", 0.0, 5.0, 0.0, 5.0));
        track.add_clip(make_clip("c2", "a1", 10.0, 15.0, 5.0, 5.0));
        seq.add_track(track);

        let mut assets = HashMap::new();
        assets.insert(
            "a1".to_string(),
            make_asset("a1", "footage.mp4", "/footage.mp4"),
        );

        // When: exporting to EDL
        let (edl, event_count, _) = export_edl(&seq, &assets).expect("EDL export should succeed");

        // Then: events should be numbered 001-003 in timeline order
        assert_eq!(event_count, 3);
        let lines: Vec<&str> = edl.lines().collect();
        let event_lines: Vec<&&str> = lines.iter().filter(|l| l.starts_with("00")).collect();
        assert_eq!(event_lines.len(), 3);
        // First event starts at record 00:00:00:00
        assert!(event_lines[0].contains("00:00:00:00"));
        // Second event starts at record 00:00:05:00
        assert!(event_lines[1].contains("00:00:05:00"));
        // Third event starts at record 00:00:10:00
        assert!(event_lines[2].contains("00:00:10:00"));
    }

    #[test]
    fn should_skip_disabled_clips() {
        // Given: a sequence with one enabled and one disabled clip
        let mut seq = make_sequence("Disabled Test", 24, 1);
        let mut track = Track::new_video("V1");

        let mut enabled_clip = make_clip("c1", "a1", 0.0, 5.0, 0.0, 5.0);
        enabled_clip.enabled = true;

        let mut disabled_clip = make_clip("c2", "a1", 5.0, 10.0, 5.0, 5.0);
        disabled_clip.enabled = false;

        track.add_clip(enabled_clip);
        track.add_clip(disabled_clip);
        seq.add_track(track);

        let mut assets = HashMap::new();
        assets.insert("a1".to_string(), make_asset("a1", "clip.mp4", "/clip.mp4"));

        // When: exporting to EDL
        let (_, event_count, _) = export_edl(&seq, &assets).expect("EDL export should succeed");

        // Then: only the enabled clip should be exported
        assert_eq!(event_count, 1);
    }

    #[test]
    fn should_export_audio_tracks_with_audio_channel_designation() {
        // Given: a sequence with a video track and an audio track
        let mut seq = make_sequence("AV Sequence", 24, 1);

        let mut v_track = Track::new_video("V1");
        v_track.add_clip(make_clip("vc1", "a1", 0.0, 5.0, 0.0, 5.0));
        seq.add_track(v_track);

        let mut a_track = Track::new_audio("A1");
        a_track.add_clip(make_clip("ac1", "a2", 0.0, 5.0, 0.0, 5.0));
        seq.add_track(a_track);

        let mut assets = HashMap::new();
        assets.insert(
            "a1".to_string(),
            make_asset("a1", "video.mp4", "/video.mp4"),
        );
        assets.insert(
            "a2".to_string(),
            make_asset("a2", "music.wav", "/music.wav"),
        );

        // When: exporting to EDL
        let (edl, event_count, track_count) =
            export_edl(&seq, &assets).expect("EDL export should succeed");

        // Then: two events — video first, then audio
        assert_eq!(event_count, 2);
        assert_eq!(track_count, 2);
        // Audio event should have audio channel designation
        assert!(edl.contains("A12")); // Audio channels 1,2
    }

    #[test]
    fn should_include_speed_change_comment_for_non_unity_speed() {
        // Given: a clip with 2x speed
        let mut seq = make_sequence("Speed Test", 24, 1);
        let mut track = Track::new_video("V1");
        let mut clip = make_clip("c1", "a1", 0.0, 10.0, 0.0, 5.0);
        clip.speed = 2.0;
        track.add_clip(clip);
        seq.add_track(track);

        let mut assets = HashMap::new();
        assets.insert("a1".to_string(), make_asset("a1", "fast.mp4", "/fast.mp4"));

        // When: exporting to EDL
        let (edl, _, _) = export_edl(&seq, &assets).expect("EDL export should succeed");

        // Then: should include M2 speed comment
        assert!(edl.contains("M2"));
        assert!(edl.contains("200.0")); // 2x speed = 200%
    }

    #[test]
    fn should_use_drop_frame_fcm_for_29_97fps() {
        // Given: a sequence at 29.97fps
        let seq = make_sequence("DF Test", 30000, 1001);
        let assets = HashMap::new();

        // When: exporting to EDL
        let (edl, _, _) = export_edl(&seq, &assets).expect("EDL export should succeed");

        // Then: FCM should indicate DROP FRAME
        assert!(edl.contains("FCM: DROP FRAME"));
    }

    #[test]
    fn should_use_non_drop_frame_fcm_for_24fps() {
        // Given: a sequence at 24fps
        let seq = make_sequence("NDF Test", 24, 1);
        let assets = HashMap::new();

        // When: exporting to EDL
        let (edl, _, _) = export_edl(&seq, &assets).expect("EDL export should succeed");

        // Then: FCM should indicate NON-DROP FRAME
        assert!(edl.contains("FCM: NON-DROP FRAME"));
    }

    #[test]
    fn should_skip_caption_tracks() {
        // Given: a sequence with only a caption track
        let mut seq = make_sequence("Caption Only", 24, 1);
        let mut track = Track::new_caption("Subtitles");
        track.add_clip(make_clip("cc1", "a1", 0.0, 5.0, 0.0, 5.0));
        seq.add_track(track);

        let assets = HashMap::new();

        // When: exporting to EDL
        let (_, event_count, track_count) =
            export_edl(&seq, &assets).expect("EDL export should succeed");

        // Then: no events should be generated (captions not supported in EDL)
        assert_eq!(event_count, 0);
        assert_eq!(track_count, 0);
    }

    #[test]
    fn should_handle_missing_asset_gracefully() {
        // Given: a clip referencing a non-existent asset
        let mut seq = make_sequence("Missing Asset", 24, 1);
        let mut track = Track::new_video("V1");
        track.add_clip(make_clip("c1", "nonexistent", 0.0, 5.0, 0.0, 5.0));
        seq.add_track(track);

        let assets = HashMap::new(); // empty — asset not found

        // When: exporting to EDL
        let (edl, event_count, _) = export_edl(&seq, &assets).expect("EDL export should succeed");

        // Then: should still export with placeholder reel name
        assert_eq!(event_count, 1);
        assert!(edl.contains("AX")); // default reel name for missing asset
    }

    #[test]
    fn should_reject_multiple_enabled_video_tracks() {
        let mut seq = make_sequence("Two Video Tracks", 24, 1);
        let mut v1 = Track::new_video("V1");
        let mut v2 = Track::new_video("V2");
        v1.add_clip(make_clip("c1", "a1", 0.0, 5.0, 0.0, 5.0));
        v2.add_clip(make_clip("c2", "a2", 0.0, 5.0, 0.0, 5.0));
        seq.add_track(v1);
        seq.add_track(v2);

        let assets = HashMap::new();

        let error =
            export_edl(&seq, &assets).expect_err("EDL export should reject multiple video tracks");
        assert!(error.contains("only one video track"));
    }
}
