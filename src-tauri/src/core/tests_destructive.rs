//! Destructive and Edge Case Tests for Core Models
//!
//! These tests verify the robustness of the system against invalid inputs,
//! edge cases, and potential security boundary violations in data structures.
//!
//! Categories:
//! - Data model validation (Color, Ratio, TimeRange, Clip, etc.)
//! - Command execution edge cases (overlap detection, undo/redo)
//! - Path validation security tests
//! - Settings persistence resilience
//! - Worker pool robustness

use crate::core::assets::{Asset, VideoInfo};
use crate::core::commands::{Command, InsertClipCommand};
use crate::core::project::ProjectState;
use crate::core::timeline::{Clip, ClipPlace, Sequence, SequenceFormat, Track, TrackKind};
use crate::core::{Color, CoreError, Ratio, TimeRange};

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

#[test]
fn test_insert_clip_rejects_invalid_timeline_start() {
    let mut state = create_test_state();
    let seq_id = state.active_sequence_id.clone().unwrap();
    let track_id = state.sequences[&seq_id].tracks[0].id.clone();
    let asset_id = state.assets.keys().next().unwrap().clone();

    // Negative start time should be rejected (no silent clamping).
    let mut negative = InsertClipCommand::new(&seq_id, &track_id, &asset_id, -1.0);
    let result = negative.execute(&mut state);
    assert!(
        matches!(result, Err(CoreError::ValidationError(_))),
        "expected validation error for negative timelineStart, got: {result:?}"
    );

    // Non-finite start time should also be rejected.
    let mut non_finite = InsertClipCommand::new(&seq_id, &track_id, &asset_id, f64::NAN);
    let result = non_finite.execute(&mut state);
    assert!(
        matches!(result, Err(CoreError::ValidationError(_))),
        "expected validation error for NaN timelineStart, got: {result:?}"
    );
}

// =============================================================================
// Path Validation Security Tests
// =============================================================================

mod path_validation_tests {
    use crate::core::fs::{validate_output_path, validate_path_id_component};

    #[test]
    fn test_path_traversal_attacks() {
        // Classic path traversal
        assert!(validate_path_id_component("../etc/passwd", "id").is_err());
        assert!(validate_path_id_component("..\\windows\\system32", "id").is_err());

        // Encoded traversal (should be caught by raw character check)
        assert!(validate_path_id_component("foo/../bar", "id").is_err());

        // Hidden traversal in middle of string
        assert!(validate_path_id_component("normal..path", "id").is_err());

        // Windows drive letter attack
        assert!(validate_path_id_component("C:", "id").is_err());
        assert!(validate_path_id_component("D:\\path", "id").is_err());
    }

    #[test]
    fn test_null_byte_injection() {
        // Null byte could truncate paths in some systems
        assert!(validate_path_id_component("normal\0.evil", "id").is_err());
        assert!(validate_path_id_component("\0hidden", "id").is_err());
    }

    #[test]
    fn test_control_character_injection() {
        // Control characters could affect terminal output or logging
        assert!(validate_path_id_component("foo\nbar", "id").is_err());
        assert!(validate_path_id_component("foo\rbar", "id").is_err());
        assert!(validate_path_id_component("foo\tbar", "id").is_err());
        assert!(validate_path_id_component("\x1b[31mred", "id").is_err()); // ANSI escape
    }

    #[test]
    fn test_empty_and_whitespace() {
        assert!(validate_path_id_component("", "id").is_err());

        // Whitespace-only identifiers are now rejected for security
        // They could bypass validation if trimmed later in the pipeline
        assert!(validate_path_id_component("   ", "id").is_err());
        assert!(validate_path_id_component("\t\t", "id").is_err());
        assert!(validate_path_id_component(" \n ", "id").is_err());
    }

    #[test]
    fn test_unicode_path_handling() {
        // Valid unicode should be accepted
        assert!(validate_path_id_component("日本語", "id").is_ok());
        assert!(validate_path_id_component("café", "id").is_ok());
        assert!(validate_path_id_component("emoji🎬", "id").is_ok());

        // Unicode normalization edge cases
        // U+002F (forward slash) should be rejected
        assert!(validate_path_id_component("foo\u{002F}bar", "id").is_err());
    }

    #[test]
    fn test_very_long_identifiers() {
        // Very long identifiers could cause buffer issues
        let long_id: String = "a".repeat(10_000);
        // Should still work (no arbitrary limits on length for now)
        assert!(validate_path_id_component(&long_id, "id").is_ok());
    }

    #[test]
    fn test_output_path_must_be_absolute() {
        assert!(validate_output_path("relative/path.mp4", "output").is_err());
        assert!(validate_output_path("./relative.mp4", "output").is_err());
        assert!(validate_output_path("../parent.mp4", "output").is_err());
    }

    #[test]
    fn test_output_path_rejects_empty() {
        assert!(validate_output_path("", "output").is_err());
        assert!(validate_output_path("   ", "output").is_err());
    }
}

// =============================================================================
// Command Executor Edge Cases
// =============================================================================

mod executor_tests {
    use crate::core::assets::{Asset, VideoInfo};
    use crate::core::commands::{CommandExecutor, InsertClipCommand, DEFAULT_MAX_HISTORY_SIZE};
    use crate::core::project::ProjectState;
    use crate::core::timeline::{Sequence, SequenceFormat, Track, TrackKind};

    fn create_test_state_for_executor() -> ProjectState {
        let mut state = ProjectState::new("Executor Test");
        let asset =
            Asset::new_video("test.mp4", "/test.mp4", VideoInfo::default()).with_duration(100.0);
        state.assets.insert(asset.id.clone(), asset.clone());

        let mut seq = Sequence::new("Main", SequenceFormat::youtube_1080());
        let track = Track::new("V1", TrackKind::Video);
        seq.tracks.push(track);
        state.active_sequence_id = Some(seq.id.clone());
        state.sequences.insert(seq.id.clone(), seq);
        state
    }

    #[test]
    fn test_history_limit_enforcement() {
        let mut executor = CommandExecutor::new();
        let mut state = create_test_state_for_executor();
        let seq_id = state.active_sequence_id.clone().unwrap();
        let track_id = state.sequences[&seq_id].tracks[0].id.clone();
        let asset_id = state.assets.keys().next().unwrap().clone();

        // Execute more commands than the history limit
        for i in 0..(DEFAULT_MAX_HISTORY_SIZE + 50) {
            let timeline_start = (i * 20) as f64;
            let cmd = InsertClipCommand::new(&seq_id, &track_id, &asset_id, timeline_start)
                .with_source_range(0.0, 10.0);
            let _ = executor.execute(Box::new(cmd), &mut state);
        }

        // Undo count should be capped at max_history_size
        let mut undo_count = 0;
        while executor.can_undo() {
            let _ = executor.undo(&mut state);
            undo_count += 1;
            if undo_count > DEFAULT_MAX_HISTORY_SIZE + 10 {
                panic!("Undo stack exceeded maximum history size");
            }
        }

        assert!(
            undo_count <= DEFAULT_MAX_HISTORY_SIZE,
            "Undo stack should be bounded by max_history_size"
        );
    }

    #[test]
    fn test_undo_redo_consistency() {
        let mut executor = CommandExecutor::new();
        let mut state = create_test_state_for_executor();
        let seq_id = state.active_sequence_id.clone().unwrap();
        let track_id = state.sequences[&seq_id].tracks[0].id.clone();
        let asset_id = state.assets.keys().next().unwrap().clone();

        // Initial state: no clips
        let initial_clip_count = state.sequences[&seq_id].tracks[0].clips.len();
        assert_eq!(initial_clip_count, 0);

        // Execute command
        let cmd =
            InsertClipCommand::new(&seq_id, &track_id, &asset_id, 0.0).with_source_range(0.0, 10.0);
        executor.execute(Box::new(cmd), &mut state).unwrap();

        // After execute: 1 clip
        assert_eq!(state.sequences[&seq_id].tracks[0].clips.len(), 1);

        // Undo: back to 0 clips
        executor.undo(&mut state).unwrap();
        assert_eq!(state.sequences[&seq_id].tracks[0].clips.len(), 0);

        // Redo: back to 1 clip
        executor.redo(&mut state).unwrap();
        assert_eq!(state.sequences[&seq_id].tracks[0].clips.len(), 1);

        // Multiple undo/redo cycles should be stable
        for _ in 0..10 {
            executor.undo(&mut state).unwrap();
            assert_eq!(state.sequences[&seq_id].tracks[0].clips.len(), 0);
            executor.redo(&mut state).unwrap();
            assert_eq!(state.sequences[&seq_id].tracks[0].clips.len(), 1);
        }
    }

    #[test]
    fn test_undo_empty_stack() {
        let mut executor = CommandExecutor::new();
        let mut state = create_test_state_for_executor();

        // Undo on empty stack should fail gracefully
        let result = executor.undo(&mut state);
        assert!(result.is_err());
    }

    #[test]
    fn test_redo_empty_stack() {
        let mut executor = CommandExecutor::new();
        let mut state = create_test_state_for_executor();

        // Redo on empty stack should fail gracefully
        let result = executor.redo(&mut state);
        assert!(result.is_err());
    }
}

// =============================================================================
// Shot Detection Edge Cases
// =============================================================================

mod shot_detection_tests {
    use crate::core::indexing::shots::{
        ShotDetectorConfig, DEFAULT_FFMPEG_TIMEOUT_SECS, DEFAULT_FFPROBE_TIMEOUT_SECS,
        DEFAULT_MAX_SCENE_CUTS, DEFAULT_MIN_SHOT_DURATION, DEFAULT_SCENE_THRESHOLD,
    };
    use std::time::Duration;

    #[test]
    fn test_config_uses_constants() {
        let config = ShotDetectorConfig::default();

        assert_eq!(config.threshold, DEFAULT_SCENE_THRESHOLD);
        assert_eq!(config.min_shot_duration, DEFAULT_MIN_SHOT_DURATION);
        assert_eq!(
            config.ffprobe_timeout,
            Duration::from_secs(DEFAULT_FFPROBE_TIMEOUT_SECS)
        );
        assert_eq!(
            config.ffmpeg_timeout,
            Duration::from_secs(DEFAULT_FFMPEG_TIMEOUT_SECS)
        );
        assert_eq!(config.max_scene_cuts, DEFAULT_MAX_SCENE_CUTS);
    }

    #[test]
    fn test_threshold_bounds() {
        // Valid thresholds - compile-time assertions
        const { assert!(DEFAULT_SCENE_THRESHOLD >= 0.0) }
        const { assert!(DEFAULT_SCENE_THRESHOLD <= 1.0) }

        // Verify reasonable default - compile-time assertions
        const {
            assert!(DEFAULT_SCENE_THRESHOLD > 0.1);
        }
        const {
            assert!(DEFAULT_SCENE_THRESHOLD < 0.9);
        }
    }

    #[test]
    fn test_max_scene_cuts_prevents_dos() {
        // Verify the limit is reasonable for memory safety
        // 20,000 cuts * ~100 bytes per shot = ~2MB max
        let max_memory_bytes = DEFAULT_MAX_SCENE_CUTS * 100;
        assert!(
            max_memory_bytes < 10_000_000,
            "Max scene cuts could use excessive memory"
        );
    }

    #[test]
    fn test_timeout_values_reasonable() {
        // ffprobe should complete within 10 seconds for most files - compile-time assertions
        const { assert!(DEFAULT_FFPROBE_TIMEOUT_SECS >= 5) }
        const { assert!(DEFAULT_FFPROBE_TIMEOUT_SECS <= 60) }

        // ffmpeg scene detection needs more time for long videos - compile-time assertions
        const { assert!(DEFAULT_FFMPEG_TIMEOUT_SECS >= 60) }
        const { assert!(DEFAULT_FFMPEG_TIMEOUT_SECS <= 3600) } // Max 1 hour
    }
}

// =============================================================================
// Settings Persistence Edge Cases
// =============================================================================

mod settings_tests {
    use crate::core::settings::{AppSettings, SettingsManager, SETTINGS_VERSION};
    use tempfile::TempDir;

    #[test]
    fn test_corrupted_settings_recovery() {
        let temp_dir = TempDir::new().unwrap();
        let settings_path = temp_dir.path().join("settings.json");

        // Write corrupted JSON
        std::fs::write(&settings_path, "{invalid json syntax!!!").unwrap();

        let manager = SettingsManager::new(temp_dir.path().to_path_buf());
        let settings = manager.load();

        // Should recover with defaults, not panic
        assert_eq!(settings.version, SETTINGS_VERSION);
        assert_eq!(settings.general.language, "en");
    }

    #[test]
    fn test_empty_file_recovery() {
        let temp_dir = TempDir::new().unwrap();
        let settings_path = temp_dir.path().join("settings.json");

        // Write empty file
        std::fs::write(&settings_path, "").unwrap();

        let manager = SettingsManager::new(temp_dir.path().to_path_buf());
        let settings = manager.load();

        // Should recover with defaults
        assert_eq!(settings.version, SETTINGS_VERSION);
    }

    #[test]
    fn test_malicious_values_normalized() {
        let temp_dir = TempDir::new().unwrap();
        let settings_path = temp_dir.path().join("settings.json");

        // Write settings with potentially malicious/extreme values
        std::fs::write(
            &settings_path,
            r#"{
            "version": 1,
            "playback": {
                "defaultVolume": 99999999.0
            },
            "performance": {
                "maxConcurrentJobs": 999999,
                "memorylimitMb": 999999999
            },
            "appearance": {
                "uiScale": 100.0,
                "accentColor": "not-a-color<script>alert(1)</script>"
            }
        }"#,
        )
        .unwrap();

        let manager = SettingsManager::new(temp_dir.path().to_path_buf());
        let settings = manager.load();

        // Values should be normalized to safe ranges
        assert!(settings.playback.default_volume <= 1.0);
        assert!(settings.performance.max_concurrent_jobs <= 32);
        assert!(settings.appearance.ui_scale <= 1.5);
        // Malicious accent color should be replaced with default
        assert!(settings.appearance.accent_color.starts_with('#'));
    }

    #[test]
    fn test_nan_infinity_handling() {
        let mut settings = AppSettings::default();
        settings.playback.default_volume = f64::NAN;
        settings.editor.default_timeline_zoom = f64::INFINITY;
        settings.appearance.ui_scale = f64::NEG_INFINITY;

        settings.normalize();

        // All should be replaced with valid values
        assert!(settings.playback.default_volume.is_finite());
        assert!(settings.editor.default_timeline_zoom.is_finite());
        assert!(settings.appearance.ui_scale.is_finite());
    }

    #[test]
    fn test_version_migration_forward_only() {
        let temp_dir = TempDir::new().unwrap();
        let settings_path = temp_dir.path().join("settings.json");

        // Write settings with old version
        std::fs::write(&settings_path, r#"{"version": 0}"#).unwrap();

        let manager = SettingsManager::new(temp_dir.path().to_path_buf());
        let settings = manager.load();

        // Version should be upgraded to current
        assert_eq!(settings.version, SETTINGS_VERSION);
    }

    #[test]
    fn test_concurrent_read_write_safety() {
        use std::sync::Arc;
        use std::thread;

        let temp_dir = TempDir::new().unwrap();
        let manager = Arc::new(SettingsManager::new(temp_dir.path().to_path_buf()));

        // Save initial settings
        manager.save(&AppSettings::default()).unwrap();

        let mut handles = vec![];

        // Spawn concurrent readers
        for _ in 0..5 {
            let m = Arc::clone(&manager);
            handles.push(thread::spawn(move || {
                for _ in 0..20 {
                    let _ = m.load();
                    thread::sleep(std::time::Duration::from_micros(100));
                }
            }));
        }

        // Spawn concurrent writers
        for i in 0..3 {
            let m = Arc::clone(&manager);
            handles.push(thread::spawn(move || {
                for j in 0..10 {
                    let mut settings = AppSettings::default();
                    settings.general.recent_projects_limit = ((i * 10 + j) % 50) as u32 + 1;
                    let _ = m.save(&settings);
                    thread::sleep(std::time::Duration::from_micros(200));
                }
            }));
        }

        // All threads should complete without panic
        for handle in handles {
            handle
                .join()
                .expect("Thread panicked during concurrent access");
        }

        // Final state should be valid
        let final_settings = manager.load();
        assert!(final_settings.general.recent_projects_limit >= 1);
        assert!(final_settings.general.recent_projects_limit <= 50);
    }
}

// =============================================================================
// Worker Pool Edge Cases
// =============================================================================

mod worker_pool_tests {
    use crate::core::jobs::{Job, JobType, Priority};

    #[test]
    fn test_job_priority_ordering() {
        // Verify priority ordering: UserRequest > Preview > Normal > Background
        assert!(Priority::UserRequest > Priority::Preview);
        assert!(Priority::Preview > Priority::Normal);
        assert!(Priority::Normal > Priority::Background);
    }

    #[test]
    fn test_job_creation_generates_unique_ids() {
        let job1 = Job::new(JobType::ProxyGeneration, serde_json::json!({}));
        let job2 = Job::new(JobType::ProxyGeneration, serde_json::json!({}));

        assert_ne!(job1.id, job2.id, "Job IDs should be unique");
    }

    #[test]
    fn test_job_timestamp_format() {
        let job = Job::new(JobType::ProxyGeneration, serde_json::json!({}));

        // Timestamp should be valid RFC3339
        let parsed = chrono::DateTime::parse_from_rfc3339(&job.created_at);
        assert!(parsed.is_ok(), "Job timestamp should be valid RFC3339");
    }

    #[test]
    fn test_job_payload_serialization() {
        // Test with complex payload
        let payload = serde_json::json!({
            "assetId": "test-123",
            "inputPath": "/path/to/file.mp4",
            "nested": {
                "array": [1, 2, 3],
                "object": {"key": "value"}
            }
        });

        let job = Job::new(JobType::Transcription, payload.clone());

        // Payload should be preserved exactly
        assert_eq!(job.payload, payload);
    }
}
