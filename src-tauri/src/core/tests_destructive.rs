//! Destructive and Edge Case Tests for Core Models
//!
//! These tests verify the robustness of the system against invalid inputs,
//! edge cases, and potential security boundary violations in data structures.

use crate::core::assets::{Asset, VideoInfo};
use crate::core::commands::{Command, InsertClipCommand};
use crate::core::project::ProjectState;
use crate::core::timeline::{Clip, ClipPlace, Sequence, SequenceFormat, Track, TrackKind};
use crate::core::{Color, Ratio, TimeRange};

#[test]
fn test_destructive_color_parsing() {
    // Test invalid hex strings
    assert_eq!(Color::from_hex("invalid"), Color::black());
    assert_eq!(Color::from_hex("12345"), Color::black()); // 5 chars
    assert_eq!(Color::from_hex(""), Color::black());

    // Test boundary values
    // #FFF -> White
    let c = Color::try_from_hex("#FFF").unwrap();
    assert_eq!(c, Color::white());

    // #0000 -> Black transparent
    let c = Color::try_from_hex("#0000").unwrap();
    assert_eq!(c.r, 0.0);
    assert_eq!(c.a, Some(0.0));
}

#[test]
fn test_destructive_ratio_division_by_zero() {
    // Explicit 0 denominator
    let r = Ratio::new(10, 0);
    assert_eq!(r.den, 1); // Should fallback to 1
    assert_eq!(r.as_f64(), 10.0);
}

#[test]
fn test_destructive_time_range_inversion() {
    // Start > End
    let range = TimeRange::new(10.0, 5.0);
    assert_eq!(range.start_sec, 5.0);
    assert_eq!(range.end_sec, 10.0);
}

#[test]
fn test_destructive_video_info_dimensions() {
    // Zero dimensions
    let asset = Asset::new_video(
        "bad_dims.mp4",
        "/tmp/bad.mp4",
        VideoInfo {
            width: 0,
            height: 0,
            ..VideoInfo::default()
        },
    );

    let info = asset.video.unwrap();
    assert_eq!(info.width, 1920); // Default fallback
    assert_eq!(info.height, 1080);
}

#[test]
fn test_destructive_clip_creation() {
    // Inverted range
    let clip = Clip::with_range("a1", 10.0, 5.0);
    assert_eq!(clip.range.source_in_sec, 5.0);
    assert_eq!(clip.range.source_out_sec, 10.0);
    assert_eq!(clip.duration(), 5.0);

    // Negative start time
    let clip_neg = Clip::with_range("a2", -5.0, 5.0);
    assert_eq!(clip_neg.range.source_in_sec, 0.0);

    // Negative duration in placement (via direct manipulation or calculation)
    let place = ClipPlace::new(0.0, -10.0);
    assert_eq!(place.duration_sec, 0.0);
}

#[test]
fn test_destructive_sequence_format() {
    // Zero dimensions
    let fmt = SequenceFormat::new(0, 0, 30, 1, 48000);
    assert_eq!(fmt.canvas.width, 1920);
    assert_eq!(fmt.canvas.height, 1080);

    // Zero FPS den
    let fmt_fps = SequenceFormat::new(1920, 1080, 30, 0, 48000);
    assert_eq!(fmt_fps.fps.den, 1);
}

#[test]
fn test_clamped_color_values() {
    let c = Color::rgba(2.0, -1.0, 0.5, 10.0);
    assert_eq!(c.r, 1.0);
    assert_eq!(c.g, 0.0);
    assert_eq!(c.b, 0.5);
    assert_eq!(c.a, Some(1.0));
}

// Helper for command tests
fn create_test_state() -> ProjectState {
    let mut state = ProjectState::new("Destructive Test Project");

    // Add asset
    let asset =
        Asset::new_video("video.mp4", "/video.mp4", VideoInfo::default()).with_duration(100.0);
    state.assets.insert(asset.id.clone(), asset.clone());

    // Add sequence with track
    let mut sequence = Sequence::new("Main", SequenceFormat::youtube_1080());
    let track = Track::new("Video 1", TrackKind::Video);
    sequence.tracks.push(track);
    state.active_sequence_id = Some(sequence.id.clone());
    state.sequences.insert(sequence.id.clone(), sequence);

    state
}

#[test]
fn test_prevent_clip_overlap() {
    let mut state = create_test_state();
    let seq_id = state.active_sequence_id.clone().unwrap();
    let track_id = state.sequences[&seq_id].tracks[0].id.clone();
    let asset_id = state.assets.keys().next().unwrap().clone();

    // 1. Insert Clip A at 0.0s (Duration 10s)
    let mut cmd1 =
        InsertClipCommand::new(&seq_id, &track_id, &asset_id, 0.0).with_source_range(0.0, 10.0);
    cmd1.execute(&mut state).expect("Cmd1 failed");

    // 2. Insert Clip B at 5.0s (Overlapping Clip A)
    // EXPECTED BEHAVIOR: Should fail in a robust system
    let mut cmd2 =
        InsertClipCommand::new(&seq_id, &track_id, &asset_id, 5.0).with_source_range(0.0, 10.0);

    let result = cmd2.execute(&mut state);

    assert!(result.is_err(), "Should detect collision during insert");
}

#[test]
fn test_ensure_sorted_clips() {
    let mut state = create_test_state();
    let seq_id = state.active_sequence_id.clone().unwrap();
    let track_id = state.sequences[&seq_id].tracks[0].id.clone();
    let asset_id = state.assets.keys().next().unwrap().clone();

    // Clip A at 20.0 (Duration 10)
    InsertClipCommand::new(&seq_id, &track_id, &asset_id, 20.0)
        .with_source_range(0.0, 10.0)
        .execute(&mut state)
        .unwrap();

    // Clip B at 0.0 (Duration 10)
    InsertClipCommand::new(&seq_id, &track_id, &asset_id, 0.0)
        .with_source_range(0.0, 10.0)
        .execute(&mut state)
        .unwrap();

    let track = &state.sequences[&seq_id].tracks[0];

    assert_eq!(
        track.clips[0].place.timeline_in_sec, 0.0,
        "First clip in vector should be the earliest one"
    );
    assert_eq!(
        track.clips[1].place.timeline_in_sec, 20.0,
        "Second clip in vector should be the later one"
    );
}
