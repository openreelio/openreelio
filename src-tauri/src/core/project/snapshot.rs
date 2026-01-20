//! Snapshot Module
//!
//! Implements project state snapshots for fast loading and recovery.
//! Snapshots store the full ProjectState along with the last applied operation ID.

use std::fs::File;
use std::io::{BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::core::{
    project::{OpsLog, ProjectMeta, ProjectState},
    CoreError, CoreResult, OpId,
};

// =============================================================================
// Snapshot Data
// =============================================================================

/// Snapshot data containing project state and metadata
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotData {
    /// Snapshot format version for migrations
    pub version: String,
    /// Last applied operation ID
    pub last_op_id: Option<OpId>,
    /// Number of operations in the ops log at snapshot time
    pub op_count: usize,
    /// Timestamp when snapshot was created (ISO 8601)
    pub created_at: String,
    /// Full project state
    pub state: SnapshotState,
}

/// Serializable project state for snapshots
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotState {
    /// Project metadata
    pub meta: ProjectMeta,
    /// All assets
    pub assets: Vec<serde_json::Value>,
    /// All sequences
    pub sequences: Vec<serde_json::Value>,
    /// Active sequence ID
    pub active_sequence_id: Option<String>,
}

// =============================================================================
// Snapshot Manager
// =============================================================================

/// Manages project state snapshots
pub struct Snapshot;

impl Snapshot {
    /// Saves a project state snapshot to a file
    pub fn save(path: &Path, state: &ProjectState, last_op_id: Option<&str>) -> CoreResult<()> {
        // Create parent directories if needed
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        let data = Self::create_snapshot_data(state, last_op_id);
        let file = File::create(path)?;
        let mut writer = BufWriter::new(file);

        serde_json::to_writer_pretty(&mut writer, &data)?;
        writer.flush()?;

        Ok(())
    }

    /// Loads a project state snapshot from a file
    pub fn load(path: &Path) -> CoreResult<(ProjectState, Option<OpId>)> {
        if !path.exists() {
            return Err(CoreError::ProjectNotFound(
                path.to_string_lossy().to_string(),
            ));
        }

        let file = File::open(path)?;
        let reader = BufReader::new(file);
        let data: SnapshotData = serde_json::from_reader(reader)?;

        let state = Self::restore_state_from_snapshot(data.state)?;

        Ok((state, data.last_op_id))
    }

    /// Checks if a snapshot file exists
    pub fn exists(path: &Path) -> bool {
        path.exists()
    }

    /// Creates snapshot data from project state
    fn create_snapshot_data(state: &ProjectState, last_op_id: Option<&str>) -> SnapshotData {
        // Serialize assets to JSON values
        let assets: Vec<serde_json::Value> = state
            .assets
            .values()
            .filter_map(|a| serde_json::to_value(a).ok())
            .collect();

        // Serialize sequences to JSON values
        let sequences: Vec<serde_json::Value> = state
            .sequences
            .values()
            .filter_map(|s| serde_json::to_value(s).ok())
            .collect();

        SnapshotData {
            version: "1.0.0".to_string(),
            last_op_id: last_op_id.map(|s| s.to_string()),
            op_count: state.op_count,
            created_at: chrono::Utc::now().to_rfc3339(),
            state: SnapshotState {
                meta: state.meta.clone(),
                assets,
                sequences,
                active_sequence_id: state.active_sequence_id.clone(),
            },
        }
    }

    /// Restores project state from snapshot data
    fn restore_state_from_snapshot(snapshot: SnapshotState) -> CoreResult<ProjectState> {
        use crate::core::{assets::Asset, timeline::Sequence};
        use std::collections::HashMap;

        let mut assets = HashMap::new();
        for asset_value in snapshot.assets {
            if let Ok(asset) = serde_json::from_value::<Asset>(asset_value) {
                assets.insert(asset.id.clone(), asset);
            }
        }

        let mut sequences = HashMap::new();
        for seq_value in snapshot.sequences {
            if let Ok(seq) = serde_json::from_value::<Sequence>(seq_value) {
                sequences.insert(seq.id.clone(), seq);
            }
        }

        Ok(ProjectState {
            meta: snapshot.meta,
            assets,
            sequences,
            effects: std::collections::HashMap::new(), // Effects loaded from ops replay
            active_sequence_id: snapshot.active_sequence_id,
            last_op_id: None, // Will be set from snapshot metadata
            op_count: 0,      // Will be updated when replaying ops
            is_dirty: false,
        })
    }

    /// Loads project from snapshot, then applies any new operations from ops log
    pub fn load_with_replay(snapshot_path: &Path, ops_log: &OpsLog) -> CoreResult<ProjectState> {
        let (mut state, snapshot_last_op_id) = Self::load(snapshot_path)?;

        // If the snapshot doesn't know which operation it includes (legacy),
        // fall back to reconstructing from the ops log for correctness.
        if snapshot_last_op_id.is_none() {
            let log_count = ops_log.count()?;
            if log_count > 0 {
                return ProjectState::from_ops_log(ops_log, state.meta.clone());
            }
            return Ok(state);
        }

        // Replay operations since the snapshot's last op id
        if let Some(op_id) = &snapshot_last_op_id {
            let result = ops_log.read_since(op_id)?;
            for op in result.operations {
                state.apply_operation(&op)?;
            }
        }

        // Sync metadata with the ops log end state.
        state.op_count = ops_log.count()?;
        state.last_op_id = match ops_log.last()? {
            Some(op) => Some(op.id),
            None => snapshot_last_op_id,
        };

        Ok(state)
    }

    /// Creates a new snapshot, optionally based on operation count threshold
    pub fn should_create_snapshot(ops_since_last: usize, threshold: usize) -> bool {
        ops_since_last >= threshold
    }

    /// Gets the default snapshot path for a project directory
    pub fn default_path(project_dir: &Path) -> PathBuf {
        project_dir.join("snapshot.json")
    }
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::{
        assets::{Asset, VideoInfo},
        project::OpKind,
        project::Operation,
        timeline::{Sequence, SequenceFormat, Track, TrackKind},
    };
    use tempfile::TempDir;

    fn create_test_state() -> ProjectState {
        // Use new_empty for isolated snapshot tests
        let mut state = ProjectState::new_empty("Test Project");

        // Add an asset
        let asset = Asset::new_video("video.mp4", "/path/video.mp4", VideoInfo::default());
        state.assets.insert(asset.id.clone(), asset);

        // Add a sequence
        let mut sequence = Sequence::new("Main Sequence", SequenceFormat::youtube_1080());
        let track = Track::new("Video 1", TrackKind::Video);
        sequence.tracks.push(track);
        state.active_sequence_id = Some(sequence.id.clone());
        state.sequences.insert(sequence.id.clone(), sequence);

        state
    }

    #[test]
    fn test_snapshot_save_and_load() {
        let temp_dir = TempDir::new().unwrap();
        let snapshot_path = temp_dir.path().join("snapshot.json");

        let state = create_test_state();
        let last_op_id = "01HZ123456789ABCDEF";

        // Save snapshot
        Snapshot::save(&snapshot_path, &state, Some(last_op_id)).unwrap();

        // Verify file exists
        assert!(snapshot_path.exists());

        // Load snapshot
        let (loaded_state, loaded_op_id) = Snapshot::load(&snapshot_path).unwrap();

        assert_eq!(loaded_state.assets.len(), 1);
        assert_eq!(loaded_state.sequences.len(), 1);
        assert_eq!(loaded_state.meta.name, "Test Project");
        assert_eq!(loaded_op_id, Some(last_op_id.to_string()));
    }

    #[test]
    fn test_snapshot_preserves_active_sequence() {
        let temp_dir = TempDir::new().unwrap();
        let snapshot_path = temp_dir.path().join("snapshot.json");

        let state = create_test_state();
        let active_seq_id = state.active_sequence_id.clone();

        Snapshot::save(&snapshot_path, &state, None).unwrap();
        let (loaded_state, _) = Snapshot::load(&snapshot_path).unwrap();

        assert_eq!(loaded_state.active_sequence_id, active_seq_id);
    }

    #[test]
    fn test_snapshot_with_no_op_id() {
        let temp_dir = TempDir::new().unwrap();
        let snapshot_path = temp_dir.path().join("snapshot.json");

        let state = create_test_state();

        Snapshot::save(&snapshot_path, &state, None).unwrap();
        let (_, loaded_op_id) = Snapshot::load(&snapshot_path).unwrap();

        assert!(loaded_op_id.is_none());
    }

    #[test]
    fn test_snapshot_load_nonexistent() {
        let temp_dir = TempDir::new().unwrap();
        let snapshot_path = temp_dir.path().join("nonexistent.json");

        let result = Snapshot::load(&snapshot_path);
        assert!(result.is_err());
    }

    #[test]
    fn test_snapshot_exists() {
        let temp_dir = TempDir::new().unwrap();
        let snapshot_path = temp_dir.path().join("snapshot.json");

        assert!(!Snapshot::exists(&snapshot_path));

        let state = create_test_state();
        Snapshot::save(&snapshot_path, &state, None).unwrap();

        assert!(Snapshot::exists(&snapshot_path));
    }

    #[test]
    fn test_should_create_snapshot() {
        assert!(!Snapshot::should_create_snapshot(0, 100));
        assert!(!Snapshot::should_create_snapshot(50, 100));
        assert!(Snapshot::should_create_snapshot(100, 100));
        assert!(Snapshot::should_create_snapshot(150, 100));
    }

    #[test]
    fn test_default_path() {
        let project_dir = Path::new("/projects/my_project");
        let path = Snapshot::default_path(project_dir);
        assert_eq!(path, project_dir.join("snapshot.json"));
    }

    #[test]
    fn test_snapshot_with_multiple_assets() {
        let temp_dir = TempDir::new().unwrap();
        let snapshot_path = temp_dir.path().join("snapshot.json");

        let mut state = ProjectState::new("Multi Asset Project");

        // Add multiple assets
        for i in 1..=5 {
            let asset = Asset::new_video(
                &format!("video_{}.mp4", i),
                &format!("/path/video_{}.mp4", i),
                VideoInfo::default(),
            );
            state.assets.insert(asset.id.clone(), asset);
        }

        Snapshot::save(&snapshot_path, &state, None).unwrap();
        let (loaded_state, _) = Snapshot::load(&snapshot_path).unwrap();

        assert_eq!(loaded_state.assets.len(), 5);
    }

    #[test]
    fn test_snapshot_with_tracks_and_clips() {
        use crate::core::timeline::Clip;

        let temp_dir = TempDir::new().unwrap();
        let snapshot_path = temp_dir.path().join("snapshot.json");

        // Use new_empty for isolated test
        let mut state = ProjectState::new_empty("Complex Project");

        // Create sequence with tracks and clips
        let mut sequence = Sequence::new("Main", SequenceFormat::youtube_1080());
        let mut video_track = Track::new("Video 1", TrackKind::Video);

        let clip = Clip::new("asset_001").place_at(0.0);
        video_track.clips.push(clip);

        sequence.tracks.push(video_track);
        state.sequences.insert(sequence.id.clone(), sequence);

        Snapshot::save(&snapshot_path, &state, Some("op_123")).unwrap();
        let (loaded_state, _) = Snapshot::load(&snapshot_path).unwrap();

        let seq = loaded_state.sequences.values().next().unwrap();
        assert_eq!(seq.tracks.len(), 1);
        assert_eq!(seq.tracks[0].clips.len(), 1);
    }

    #[test]
    fn test_load_with_replay() {
        use crate::core::project::OpsLog;

        let temp_dir = TempDir::new().unwrap();
        let snapshot_path = temp_dir.path().join("snapshot.json");
        let ops_path = temp_dir.path().join("ops.jsonl");

        // Create initial state and save snapshot
        let mut state = ProjectState::new("Replay Test");
        let asset1 = Asset::new_video("initial.mp4", "/initial.mp4", VideoInfo::default());
        state.assets.insert(asset1.id.clone(), asset1);

        Snapshot::save(&snapshot_path, &state, Some("op_001")).unwrap();

        // Create ops log with additional operations after snapshot
        let ops_log = OpsLog::new(&ops_path);

        // Add op_001 (already in snapshot)
        let op1 = Operation::with_id("op_001", OpKind::AssetImport, serde_json::json!({}));
        ops_log.append(&op1).unwrap();

        // Add new operations after snapshot
        let asset2 = Asset::new_video("new.mp4", "/new.mp4", VideoInfo::default());
        let op2 = Operation::with_id(
            "op_002",
            OpKind::AssetImport,
            serde_json::to_value(&asset2).unwrap(),
        );
        ops_log.append(&op2).unwrap();

        // Load with replay
        let restored_state = Snapshot::load_with_replay(&snapshot_path, &ops_log).unwrap();

        // Should have both assets: 1 from snapshot + 1 from replay
        assert_eq!(restored_state.assets.len(), 2);
        assert_eq!(restored_state.last_op_id, Some("op_002".to_string()));
        assert_eq!(restored_state.op_count, 2);
    }

    #[test]
    fn test_load_with_replay_falls_back_when_snapshot_has_no_last_op_id() {
        use crate::core::project::OpsLog;

        let temp_dir = TempDir::new().unwrap();
        let snapshot_path = temp_dir.path().join("snapshot.json");
        let ops_path = temp_dir.path().join("ops.jsonl");

        // Save a legacy snapshot without last_op_id.
        let state = ProjectState::new("Legacy Replay Test");
        Snapshot::save(&snapshot_path, &state, None).unwrap();

        // Create an ops log with operations (snapshot cannot know its position).
        let ops_log = OpsLog::new(&ops_path);
        let asset = Asset::new_video("a.mp4", "/a.mp4", VideoInfo::default());
        let op = Operation::with_id(
            "op_001",
            OpKind::AssetImport,
            serde_json::to_value(&asset).unwrap(),
        );
        ops_log.append(&op).unwrap();

        let restored_state = Snapshot::load_with_replay(&snapshot_path, &ops_log).unwrap();
        assert_eq!(restored_state.assets.len(), 1);
        assert_eq!(restored_state.last_op_id, Some("op_001".to_string()));
        assert_eq!(restored_state.op_count, 1);
    }

    #[test]
    fn test_snapshot_data_version() {
        let temp_dir = TempDir::new().unwrap();
        let snapshot_path = temp_dir.path().join("snapshot.json");

        let state = create_test_state();
        Snapshot::save(&snapshot_path, &state, None).unwrap();

        // Read raw JSON to verify version
        let file = File::open(&snapshot_path).unwrap();
        let data: SnapshotData = serde_json::from_reader(file).unwrap();

        assert_eq!(data.version, "1.0.0");
        assert!(!data.created_at.is_empty());
    }
}
