//! Integration Tests: 3-Point Editing Workflow
//!
//! BDD-style tests verifying that InsertEdit and OverwriteEdit commands
//! correctly handle source In/Out ranges for 3-point editing workflows.
//!
//! Feature: 3-Point Editing Workflow
//!   As a video editor
//!   I want to mark In/Out points on a source clip and insert at the timeline playhead
//!   So that I can precisely place portions of source footage onto the timeline

use openreelio_lib::core::assets::{Asset, VideoInfo};
use openreelio_lib::core::commands::{
    Command, CommandExecutor, InsertEditCommand, OverwriteEditCommand,
};
use openreelio_lib::core::project::ProjectState;
use openreelio_lib::core::timeline::{Clip, Sequence, SequenceFormat, Track, TrackKind};

// =============================================================================
// Helpers
// =============================================================================

/// Creates a test project state with a single 60-second video asset, a sequence,
/// and one unlocked video track.
fn create_test_state() -> ProjectState {
    let mut state = ProjectState::new("3-Point Editing Test");

    let asset =
        Asset::new_video("footage.mp4", "/footage.mp4", VideoInfo::default()).with_duration(60.0);
    state.assets.insert(asset.id.clone(), asset);

    let mut sequence = Sequence::new("Main Sequence", SequenceFormat::youtube_1080());
    let track = Track::new("Video 1", TrackKind::Video);
    sequence.tracks.push(track);
    state.active_sequence_id = Some(sequence.id.clone());
    state.sequences.insert(sequence.id.clone(), sequence);

    state
}

/// Creates a test state with one existing clip already on the timeline.
/// Returns (state, seq_id, track_id, asset_id, existing_clip_id).
fn create_state_with_existing_clip() -> (ProjectState, String, String, String, String) {
    let mut state = create_test_state();
    let seq_id = state.active_sequence_id.clone().unwrap();
    let track_id = state.sequences[&seq_id].tracks[0].id.clone();
    let asset_id = state.assets.keys().next().unwrap().clone();

    // Place an existing clip at timeline [0, 10) using source [0, 10)
    let clip = Clip::with_range(&asset_id, 0.0, 10.0).place_at(0.0);
    let existing_clip_id = clip.id.clone();
    state.sequences.get_mut(&seq_id).unwrap().tracks[0]
        .clips
        .push(clip);

    (state, seq_id, track_id, asset_id, existing_clip_id)
}

fn get_track_clips<'a>(state: &'a ProjectState, seq_id: &str) -> &'a [Clip] {
    &state.sequences[seq_id].tracks[0].clips
}

// =============================================================================
// Scenario: Insert edit with both In and Out points
// =============================================================================

#[test]
fn should_insert_clip_with_source_in_out_at_playhead_position() {
    // Given a 60-second source asset
    // And source In=2.0s, Out=8.0s (6.0s duration)
    // And timeline playhead at 10.0s
    let mut state = create_test_state();
    let seq_id = state.active_sequence_id.clone().unwrap();
    let track_id = state.sequences[&seq_id].tracks[0].id.clone();
    let asset_id = state.assets.keys().next().unwrap().clone();

    // When performing a 3-point insert edit
    let mut cmd = InsertEditCommand::new(&seq_id, &track_id, &asset_id, 10.0);
    cmd.source_start = Some(2.0);
    cmd.source_end = Some(8.0);
    let result = cmd.execute(&mut state).unwrap();

    // Then a clip is placed at timeline position 10.0
    assert_eq!(result.created_ids.len(), 1);
    let clips = get_track_clips(&state, &seq_id);
    assert_eq!(clips.len(), 1);

    let clip = &clips[0];
    // And the clip uses source range [2.0, 8.0]
    assert_eq!(clip.range.source_in_sec, 2.0);
    assert_eq!(clip.range.source_out_sec, 8.0);
    assert_eq!(clip.place.timeline_in_sec, 10.0);
    // And clip duration is 6.0s
    assert!((clip.place.duration_sec - 6.0).abs() < 0.001);
}

// =============================================================================
// Scenario: Insert edit pushes downstream clips
// =============================================================================

#[test]
fn should_push_downstream_clips_right_on_insert_edit() {
    // Given an existing clip at timeline [0, 10)
    let (mut state, seq_id, track_id, asset_id, _existing_clip_id) =
        create_state_with_existing_clip();

    // When inserting a 3-point edit (source 20-25s = 5s) at timeline position 5.0
    let mut cmd = InsertEditCommand::new(&seq_id, &track_id, &asset_id, 5.0);
    cmd.source_start = Some(20.0);
    cmd.source_end = Some(25.0);
    cmd.execute(&mut state).unwrap();

    // Then the existing clip is split at 5.0 and the right fragment is pushed right by 5.0s
    let clips = get_track_clips(&state, &seq_id);
    // Should have: left fragment [0, 5) + new clip [5, 10) + right fragment [10, 15)
    assert_eq!(clips.len(), 3);

    // Find the new clip (source range [20, 25])
    let new_clip = clips
        .iter()
        .find(|c| c.range.source_in_sec == 20.0)
        .expect("New clip from source [20, 25] should exist");
    assert_eq!(new_clip.place.timeline_in_sec, 5.0);
    assert!((new_clip.place.duration_sec - 5.0).abs() < 0.001);
}

// =============================================================================
// Scenario: Overwrite edit with both In and Out points
// =============================================================================

#[test]
fn should_overwrite_without_shifting_downstream_clips() {
    // Given an existing clip at timeline [0, 10)
    let (mut state, seq_id, track_id, asset_id, _existing_clip_id) =
        create_state_with_existing_clip();

    // When performing a 3-point overwrite edit (source 30-36s = 6s) at timeline 2.0
    let mut cmd = OverwriteEditCommand::new(&seq_id, &track_id, &asset_id, 2.0);
    cmd.source_start = Some(30.0);
    cmd.source_end = Some(36.0);
    cmd.execute(&mut state).unwrap();

    // Then the new clip is placed at 2.0 with duration 6.0
    let clips = get_track_clips(&state, &seq_id);

    let new_clip = clips
        .iter()
        .find(|c| c.range.source_in_sec == 30.0)
        .expect("New clip from source [30, 36] should exist");
    assert_eq!(new_clip.place.timeline_in_sec, 2.0);
    assert!((new_clip.place.duration_sec - 6.0).abs() < 0.001);

    // And the original clip is trimmed, NOT shifted
    // Original was [0, 10) timeline. Overwrite at [2, 8) should leave:
    // - Left fragment: [0, 2) and right fragment: [8, 10)
    let original_fragments: Vec<_> = clips
        .iter()
        .filter(|c| c.range.source_in_sec != 30.0)
        .collect();
    assert_eq!(original_fragments.len(), 2);
}

// =============================================================================
// Scenario: 3-point edit with only In point (no Out)
// =============================================================================

#[test]
fn should_use_asset_end_when_out_point_not_set() {
    // Given a 60-second source asset with only In point set to 50.0
    // (simulating Out=None → defaults to asset duration 60.0)
    let mut state = create_test_state();
    let seq_id = state.active_sequence_id.clone().unwrap();
    let track_id = state.sequences[&seq_id].tracks[0].id.clone();
    let asset_id = state.assets.keys().next().unwrap().clone();

    // When performing an insert with source_start=50.0, source_end=None (→ 60.0)
    let mut cmd = InsertEditCommand::new(&seq_id, &track_id, &asset_id, 0.0);
    cmd.source_start = Some(50.0);
    // source_end left as None → command uses asset duration (60.0)

    cmd.execute(&mut state).unwrap();

    // Then the clip uses source range [50.0, 60.0] with 10s duration
    let clips = get_track_clips(&state, &seq_id);
    assert_eq!(clips.len(), 1);
    let clip = &clips[0];
    assert_eq!(clip.range.source_in_sec, 50.0);
    assert_eq!(clip.range.source_out_sec, 60.0);
    assert!((clip.place.duration_sec - 10.0).abs() < 0.001);
}

// =============================================================================
// Scenario: 3-point edit with no In/Out points (full asset)
// =============================================================================

#[test]
fn should_use_full_asset_duration_when_no_in_out_set() {
    // Given a 60-second source asset with no In/Out points
    let mut state = create_test_state();
    let seq_id = state.active_sequence_id.clone().unwrap();
    let track_id = state.sequences[&seq_id].tracks[0].id.clone();
    let asset_id = state.assets.keys().next().unwrap().clone();

    // When performing an insert with no source range
    let mut cmd = InsertEditCommand::new(&seq_id, &track_id, &asset_id, 5.0);
    // Both source_start and source_end are None → full asset [0, 60]
    cmd.execute(&mut state).unwrap();

    // Then the clip uses full source duration
    let clips = get_track_clips(&state, &seq_id);
    assert_eq!(clips.len(), 1);
    let clip = &clips[0];
    assert_eq!(clip.range.source_in_sec, 0.0);
    assert_eq!(clip.range.source_out_sec, 60.0);
    assert_eq!(clip.place.timeline_in_sec, 5.0);
    assert!((clip.place.duration_sec - 60.0).abs() < 0.001);
}

// =============================================================================
// Scenario: Undo restores original state
// =============================================================================

#[test]
fn should_undo_insert_edit_atomically() {
    // Given an existing clip at timeline [0, 10)
    let (mut state, seq_id, track_id, asset_id, _) = create_state_with_existing_clip();
    let original_clip_count = get_track_clips(&state, &seq_id).len();

    // When inserting a 3-point edit then undoing it
    let mut executor = CommandExecutor::new();
    let mut cmd = InsertEditCommand::new(&seq_id, &track_id, &asset_id, 5.0);
    cmd.source_start = Some(20.0);
    cmd.source_end = Some(25.0);
    executor.execute(Box::new(cmd), &mut state).unwrap();

    // Clips changed after insert
    let clips_after_insert = get_track_clips(&state, &seq_id).len();
    assert!(clips_after_insert > original_clip_count);

    // Undo
    executor.undo(&mut state).unwrap();

    // Then the timeline is restored to its original state
    let clips_after_undo = get_track_clips(&state, &seq_id);
    assert_eq!(clips_after_undo.len(), original_clip_count);
    // Original clip should be back at its original position
    let clip = &clips_after_undo[0];
    assert_eq!(clip.place.timeline_in_sec, 0.0);
    assert!((clip.place.duration_sec - 10.0).abs() < 0.001);
}

// =============================================================================
// Scenario: Overwrite edit undo restores trimmed clips
// =============================================================================

#[test]
fn should_undo_overwrite_edit_restoring_original_clips() {
    // Given an existing clip at timeline [0, 10)
    let (mut state, seq_id, track_id, asset_id, _) = create_state_with_existing_clip();

    // When overwriting then undoing via command-level undo
    let mut cmd = OverwriteEditCommand::new(&seq_id, &track_id, &asset_id, 2.0);
    cmd.source_start = Some(30.0);
    cmd.source_end = Some(36.0);
    cmd.execute(&mut state).unwrap();

    // After overwrite: original split into fragments + new clip
    let clips_after = get_track_clips(&state, &seq_id).len();
    assert!(clips_after > 1);

    // Undo
    cmd.undo(&mut state).unwrap();

    // Then original clip is fully restored
    let clips = get_track_clips(&state, &seq_id);
    assert_eq!(clips.len(), 1);
    assert_eq!(clips[0].place.timeline_in_sec, 0.0);
    assert!((clips[0].place.duration_sec - 10.0).abs() < 0.001);
}
