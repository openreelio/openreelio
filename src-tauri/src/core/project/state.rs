//! Project State Module
//!
//! Implements the ProjectState that is reconstructed from ops.jsonl by replaying operations.
//! Uses Event Sourcing pattern where the ops.jsonl is the single source of truth.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::core::{
    assets::Asset,
    project::{OpKind, Operation, OpsLog},
    timeline::{Clip, Sequence, Track},
    AssetId, CoreError, CoreResult, SequenceId,
};

// =============================================================================
// Project Metadata
// =============================================================================

/// Project metadata stored in project.json
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMeta {
    /// Project name
    pub name: String,
    /// Project version (for format migrations)
    pub version: String,
    /// Creation timestamp (ISO 8601)
    pub created_at: String,
    /// Last modified timestamp (ISO 8601)
    pub modified_at: String,
    /// Project description
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Author name
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
}

impl ProjectMeta {
    /// Creates new project metadata
    pub fn new(name: &str) -> Self {
        let now = chrono::Utc::now().to_rfc3339();
        Self {
            name: name.to_string(),
            version: "1.0.0".to_string(),
            created_at: now.clone(),
            modified_at: now,
            description: None,
            author: None,
        }
    }

    /// Updates the modified timestamp
    pub fn touch(&mut self) {
        self.modified_at = chrono::Utc::now().to_rfc3339();
    }
}

// =============================================================================
// Project State
// =============================================================================

/// In-memory project state reconstructed from operation log
#[derive(Clone, Debug)]
pub struct ProjectState {
    /// Project metadata
    pub meta: ProjectMeta,
    /// All assets indexed by ID
    pub assets: HashMap<AssetId, Asset>,
    /// All sequences indexed by ID
    pub sequences: HashMap<SequenceId, Sequence>,
    /// Currently active sequence ID
    pub active_sequence_id: Option<SequenceId>,
    /// Last applied operation ID
    pub last_op_id: Option<String>,
    /// Number of operations applied
    pub op_count: usize,
    /// Whether state has unsaved changes
    pub is_dirty: bool,
}

impl ProjectState {
    /// Creates a new empty project state
    pub fn new(name: &str) -> Self {
        Self {
            meta: ProjectMeta::new(name),
            assets: HashMap::new(),
            sequences: HashMap::new(),
            active_sequence_id: None,
            last_op_id: None,
            op_count: 0,
            is_dirty: false,
        }
    }

    /// Creates a project state from an ops log by replaying all operations
    pub fn from_ops_log(ops_log: &OpsLog, meta: ProjectMeta) -> CoreResult<Self> {
        let mut state = Self {
            meta,
            assets: HashMap::new(),
            sequences: HashMap::new(),
            active_sequence_id: None,
            last_op_id: None,
            op_count: 0,
            is_dirty: false,
        };

        let result = ops_log.read_all()?;
        for op in result.operations {
            state.apply_operation(&op)?;
        }

        Ok(state)
    }

    /// Applies a single operation to the state
    pub fn apply_operation(&mut self, op: &Operation) -> CoreResult<()> {
        match op.kind {
            // Asset operations
            OpKind::AssetImport => self.apply_asset_import(op)?,
            OpKind::AssetRemove => self.apply_asset_remove(op)?,
            OpKind::AssetUpdate => self.apply_asset_update(op)?,

            // Sequence operations
            OpKind::SequenceCreate => self.apply_sequence_create(op)?,
            OpKind::SequenceUpdate => self.apply_sequence_update(op)?,
            OpKind::SequenceRemove => self.apply_sequence_remove(op)?,

            // Track operations
            OpKind::TrackAdd => self.apply_track_add(op)?,
            OpKind::TrackRemove => self.apply_track_remove(op)?,
            OpKind::TrackReorder => self.apply_track_reorder(op)?,

            // Clip operations
            OpKind::ClipAdd => self.apply_clip_add(op)?,
            OpKind::ClipRemove => self.apply_clip_remove(op)?,
            OpKind::ClipMove => self.apply_clip_move(op)?,
            OpKind::ClipTrim => self.apply_clip_trim(op)?,
            OpKind::ClipSplit => self.apply_clip_split(op)?,

            // Effect operations
            OpKind::EffectAdd => self.apply_effect_add(op)?,
            OpKind::EffectRemove => self.apply_effect_remove(op)?,
            OpKind::EffectUpdate => self.apply_effect_update(op)?,

            // Caption operations
            OpKind::CaptionAdd => self.apply_caption_add(op)?,
            OpKind::CaptionRemove => self.apply_caption_remove(op)?,
            OpKind::CaptionUpdate => self.apply_caption_update(op)?,

            // Project operations
            OpKind::ProjectCreate => self.apply_project_create(op)?,
            OpKind::ProjectSettings => self.apply_project_settings(op)?,

            // Batch operations
            OpKind::Batch => self.apply_batch(op)?,
        }

        self.last_op_id = Some(op.id.clone());
        self.op_count += 1;
        self.meta.touch();

        Ok(())
    }

    // =========================================================================
    // Asset Operation Handlers
    // =========================================================================

    fn apply_asset_import(&mut self, op: &Operation) -> CoreResult<()> {
        let asset: Asset = serde_json::from_value(op.payload.clone())
            .map_err(|e| CoreError::InvalidCommand(format!("Invalid asset data: {}", e)))?;
        self.assets.insert(asset.id.clone(), asset);
        Ok(())
    }

    fn apply_asset_remove(&mut self, op: &Operation) -> CoreResult<()> {
        let asset_id = op.payload["assetId"]
            .as_str()
            .ok_or_else(|| CoreError::InvalidCommand("Missing assetId".to_string()))?;
        self.assets.remove(asset_id);
        Ok(())
    }

    fn apply_asset_update(&mut self, op: &Operation) -> CoreResult<()> {
        let asset_id = op.payload["assetId"]
            .as_str()
            .ok_or_else(|| CoreError::InvalidCommand("Missing assetId".to_string()))?;

        if let Some(asset) = self.assets.get_mut(asset_id) {
            // Update name if provided
            if let Some(name) = op.payload["name"].as_str() {
                asset.name = name.to_string();
            }
            // Update tags if provided
            if let Some(tags) = op.payload["tags"].as_array() {
                asset.tags = tags
                    .iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect();
            }
        }
        Ok(())
    }

    // =========================================================================
    // Sequence Operation Handlers
    // =========================================================================

    fn apply_sequence_create(&mut self, op: &Operation) -> CoreResult<()> {
        let sequence: Sequence = serde_json::from_value(op.payload.clone())
            .map_err(|e| CoreError::InvalidCommand(format!("Invalid sequence data: {}", e)))?;
        let id = sequence.id.clone();
        self.sequences.insert(id.clone(), sequence);

        // Set as active if it's the first sequence
        if self.active_sequence_id.is_none() {
            self.active_sequence_id = Some(id);
        }
        Ok(())
    }

    fn apply_sequence_update(&mut self, op: &Operation) -> CoreResult<()> {
        let seq_id = op.payload["sequenceId"]
            .as_str()
            .ok_or_else(|| CoreError::InvalidCommand("Missing sequenceId".to_string()))?;

        if let Some(sequence) = self.sequences.get_mut(seq_id) {
            if let Some(name) = op.payload["name"].as_str() {
                sequence.name = name.to_string();
            }
        }
        Ok(())
    }

    fn apply_sequence_remove(&mut self, op: &Operation) -> CoreResult<()> {
        let seq_id = op.payload["sequenceId"]
            .as_str()
            .ok_or_else(|| CoreError::InvalidCommand("Missing sequenceId".to_string()))?;
        self.sequences.remove(seq_id);

        // Clear active if removed
        if self.active_sequence_id.as_deref() == Some(seq_id) {
            self.active_sequence_id = self.sequences.keys().next().cloned();
        }
        Ok(())
    }

    // =========================================================================
    // Track Operation Handlers
    // =========================================================================

    fn apply_track_add(&mut self, op: &Operation) -> CoreResult<()> {
        let seq_id = op.payload["sequenceId"]
            .as_str()
            .ok_or_else(|| CoreError::InvalidCommand("Missing sequenceId".to_string()))?;

        let track: Track = serde_json::from_value(op.payload["track"].clone())
            .map_err(|e| CoreError::InvalidCommand(format!("Invalid track data: {}", e)))?;

        if let Some(sequence) = self.sequences.get_mut(seq_id) {
            sequence.add_track(track);
        }
        Ok(())
    }

    fn apply_track_remove(&mut self, op: &Operation) -> CoreResult<()> {
        let seq_id = op.payload["sequenceId"]
            .as_str()
            .ok_or_else(|| CoreError::InvalidCommand("Missing sequenceId".to_string()))?;
        let track_id = op.payload["trackId"]
            .as_str()
            .ok_or_else(|| CoreError::InvalidCommand("Missing trackId".to_string()))?;

        if let Some(sequence) = self.sequences.get_mut(seq_id) {
            sequence.remove_track(&track_id.to_string());
        }
        Ok(())
    }

    fn apply_track_reorder(&mut self, op: &Operation) -> CoreResult<()> {
        let seq_id = op.payload["sequenceId"]
            .as_str()
            .ok_or_else(|| CoreError::InvalidCommand("Missing sequenceId".to_string()))?;
        let order: Vec<String> = serde_json::from_value(op.payload["order"].clone())
            .map_err(|e| CoreError::InvalidCommand(format!("Invalid order: {}", e)))?;

        if let Some(sequence) = self.sequences.get_mut(seq_id) {
            // Reorder tracks based on the provided order
            sequence.tracks.sort_by(|a, b| {
                let a_idx = order
                    .iter()
                    .position(|id| id == &a.id)
                    .unwrap_or(usize::MAX);
                let b_idx = order
                    .iter()
                    .position(|id| id == &b.id)
                    .unwrap_or(usize::MAX);
                a_idx.cmp(&b_idx)
            });
        }
        Ok(())
    }

    // =========================================================================
    // Clip Operation Handlers
    // =========================================================================

    fn apply_clip_add(&mut self, op: &Operation) -> CoreResult<()> {
        let seq_id = op.payload["sequenceId"]
            .as_str()
            .ok_or_else(|| CoreError::InvalidCommand("Missing sequenceId".to_string()))?;
        let track_id = op.payload["trackId"]
            .as_str()
            .ok_or_else(|| CoreError::InvalidCommand("Missing trackId".to_string()))?;

        let clip: Clip = serde_json::from_value(op.payload["clip"].clone())
            .map_err(|e| CoreError::InvalidCommand(format!("Invalid clip data: {}", e)))?;

        if let Some(sequence) = self.sequences.get_mut(seq_id) {
            if let Some(track) = sequence.get_track_mut(track_id) {
                track.add_clip(clip);
            }
        }
        Ok(())
    }

    fn apply_clip_remove(&mut self, op: &Operation) -> CoreResult<()> {
        let seq_id = op.payload["sequenceId"]
            .as_str()
            .ok_or_else(|| CoreError::InvalidCommand("Missing sequenceId".to_string()))?;
        let track_id = op.payload["trackId"]
            .as_str()
            .ok_or_else(|| CoreError::InvalidCommand("Missing trackId".to_string()))?;
        let clip_id = op.payload["clipId"]
            .as_str()
            .ok_or_else(|| CoreError::InvalidCommand("Missing clipId".to_string()))?;

        if let Some(sequence) = self.sequences.get_mut(seq_id) {
            if let Some(track) = sequence.get_track_mut(track_id) {
                track.remove_clip(&clip_id.to_string());
            }
        }
        Ok(())
    }

    fn apply_clip_move(&mut self, op: &Operation) -> CoreResult<()> {
        let seq_id = op.payload["sequenceId"]
            .as_str()
            .ok_or_else(|| CoreError::InvalidCommand("Missing sequenceId".to_string()))?;
        let clip_id = op.payload["clipId"]
            .as_str()
            .ok_or_else(|| CoreError::InvalidCommand("Missing clipId".to_string()))?;

        if let Some(sequence) = self.sequences.get_mut(seq_id) {
            // Find and update clip position
            for track in &mut sequence.tracks {
                if let Some(clip) = track.get_clip_mut(clip_id) {
                    if let Some(timeline_in) = op.payload["timelineIn"].as_f64() {
                        clip.place.timeline_in_sec = timeline_in;
                    }
                    break;
                }
            }
        }
        Ok(())
    }

    fn apply_clip_trim(&mut self, op: &Operation) -> CoreResult<()> {
        let seq_id = op.payload["sequenceId"]
            .as_str()
            .ok_or_else(|| CoreError::InvalidCommand("Missing sequenceId".to_string()))?;
        let clip_id = op.payload["clipId"]
            .as_str()
            .ok_or_else(|| CoreError::InvalidCommand("Missing clipId".to_string()))?;

        if let Some(sequence) = self.sequences.get_mut(seq_id) {
            for track in &mut sequence.tracks {
                if let Some(clip) = track.get_clip_mut(clip_id) {
                    if let Some(source_in) = op.payload["sourceIn"].as_f64() {
                        clip.range.source_in_sec = source_in;
                    }
                    if let Some(source_out) = op.payload["sourceOut"].as_f64() {
                        clip.range.source_out_sec = source_out;
                    }
                    if let Some(timeline_in) = op.payload["timelineIn"].as_f64() {
                        clip.place.timeline_in_sec = timeline_in;
                    }
                    if let Some(duration) = op.payload["duration"].as_f64() {
                        clip.place.duration_sec = duration;
                    }
                    break;
                }
            }
        }
        Ok(())
    }

    fn apply_clip_split(&mut self, op: &Operation) -> CoreResult<()> {
        // Split creates a new clip and modifies the original
        // The payload should contain both the modified original and the new clip
        let seq_id = op.payload["sequenceId"]
            .as_str()
            .ok_or_else(|| CoreError::InvalidCommand("Missing sequenceId".to_string()))?;
        let track_id = op.payload["trackId"]
            .as_str()
            .ok_or_else(|| CoreError::InvalidCommand("Missing trackId".to_string()))?;

        if let Some(sequence) = self.sequences.get_mut(seq_id) {
            if let Some(track) = sequence.get_track_mut(track_id) {
                // Update original clip
                if let Ok(original) =
                    serde_json::from_value::<Clip>(op.payload["originalClip"].clone())
                {
                    if let Some(clip) = track.get_clip_mut(&original.id) {
                        *clip = original;
                    }
                }
                // Add new clip
                if let Ok(new_clip) = serde_json::from_value::<Clip>(op.payload["newClip"].clone())
                {
                    track.add_clip(new_clip);
                }
            }
        }
        Ok(())
    }

    // =========================================================================
    // Effect Operation Handlers
    // =========================================================================

    fn apply_effect_add(&mut self, op: &Operation) -> CoreResult<()> {
        let seq_id = op.payload["sequenceId"]
            .as_str()
            .ok_or_else(|| CoreError::InvalidCommand("Missing sequenceId".to_string()))?;
        let clip_id = op.payload["clipId"]
            .as_str()
            .ok_or_else(|| CoreError::InvalidCommand("Missing clipId".to_string()))?;
        let effect_id = op.payload["effectId"]
            .as_str()
            .ok_or_else(|| CoreError::InvalidCommand("Missing effectId".to_string()))?;

        if let Some(sequence) = self.sequences.get_mut(seq_id) {
            for track in &mut sequence.tracks {
                if let Some(clip) = track.get_clip_mut(clip_id) {
                    clip.effects.push(effect_id.to_string());
                    break;
                }
            }
        }
        Ok(())
    }

    fn apply_effect_remove(&mut self, op: &Operation) -> CoreResult<()> {
        let seq_id = op.payload["sequenceId"]
            .as_str()
            .ok_or_else(|| CoreError::InvalidCommand("Missing sequenceId".to_string()))?;
        let clip_id = op.payload["clipId"]
            .as_str()
            .ok_or_else(|| CoreError::InvalidCommand("Missing clipId".to_string()))?;
        let effect_id = op.payload["effectId"]
            .as_str()
            .ok_or_else(|| CoreError::InvalidCommand("Missing effectId".to_string()))?;

        if let Some(sequence) = self.sequences.get_mut(seq_id) {
            for track in &mut sequence.tracks {
                if let Some(clip) = track.get_clip_mut(clip_id) {
                    clip.effects.retain(|e| e != effect_id);
                    break;
                }
            }
        }
        Ok(())
    }

    fn apply_effect_update(&mut self, _op: &Operation) -> CoreResult<()> {
        // Effect parameters are stored in the Effect model, not in Clip
        // This would need an effects HashMap in ProjectState
        Ok(())
    }

    // =========================================================================
    // Caption Operation Handlers (placeholder implementations)
    // =========================================================================

    fn apply_caption_add(&mut self, _op: &Operation) -> CoreResult<()> {
        // TODO: Implement when Caption model is ready
        Ok(())
    }

    fn apply_caption_remove(&mut self, _op: &Operation) -> CoreResult<()> {
        Ok(())
    }

    fn apply_caption_update(&mut self, _op: &Operation) -> CoreResult<()> {
        Ok(())
    }

    // =========================================================================
    // Project Operation Handlers
    // =========================================================================

    fn apply_project_create(&mut self, op: &Operation) -> CoreResult<()> {
        if let Some(name) = op.payload["name"].as_str() {
            self.meta.name = name.to_string();
        }
        if let Some(description) = op.payload["description"].as_str() {
            self.meta.description = Some(description.to_string());
        }
        Ok(())
    }

    fn apply_project_settings(&mut self, op: &Operation) -> CoreResult<()> {
        if let Some(name) = op.payload["name"].as_str() {
            self.meta.name = name.to_string();
        }
        if let Some(description) = op.payload["description"].as_str() {
            self.meta.description = Some(description.to_string());
        }
        if let Some(author) = op.payload["author"].as_str() {
            self.meta.author = Some(author.to_string());
        }
        Ok(())
    }

    // =========================================================================
    // Batch Operation Handler
    // =========================================================================

    fn apply_batch(&mut self, op: &Operation) -> CoreResult<()> {
        if let Some(operations) = op.payload["operations"].as_array() {
            for op_value in operations {
                if let Ok(sub_op) = serde_json::from_value::<Operation>(op_value.clone()) {
                    self.apply_operation(&sub_op)?;
                }
            }
        }
        Ok(())
    }

    // =========================================================================
    // Query Methods
    // =========================================================================

    /// Gets an asset by ID
    pub fn get_asset(&self, asset_id: &str) -> Option<&Asset> {
        self.assets.get(asset_id)
    }

    /// Gets a sequence by ID
    pub fn get_sequence(&self, sequence_id: &str) -> Option<&Sequence> {
        self.sequences.get(sequence_id)
    }

    /// Gets a mutable sequence by ID
    pub fn get_sequence_mut(&mut self, sequence_id: &str) -> Option<&mut Sequence> {
        self.sequences.get_mut(sequence_id)
    }

    /// Gets the active sequence
    pub fn get_active_sequence(&self) -> Option<&Sequence> {
        self.active_sequence_id
            .as_ref()
            .and_then(|id| self.sequences.get(id))
    }

    /// Gets a mutable reference to the active sequence
    pub fn get_active_sequence_mut(&mut self) -> Option<&mut Sequence> {
        if let Some(id) = &self.active_sequence_id {
            self.sequences.get_mut(id)
        } else {
            None
        }
    }

    /// Finds a track by ID across all sequences
    pub fn find_track(&self, track_id: &str) -> Option<(&Sequence, &Track)> {
        for sequence in self.sequences.values() {
            if let Some(track) = sequence.get_track(track_id) {
                return Some((sequence, track));
            }
        }
        None
    }

    /// Finds a clip by ID across all sequences
    pub fn find_clip(&self, clip_id: &str) -> Option<(&Sequence, &Track, &Clip)> {
        for sequence in self.sequences.values() {
            for track in &sequence.tracks {
                if let Some(clip) = track.get_clip(clip_id) {
                    return Some((sequence, track, clip));
                }
            }
        }
        None
    }

    /// Returns all assets as a vector
    pub fn all_assets(&self) -> Vec<&Asset> {
        self.assets.values().collect()
    }

    /// Returns all sequences as a vector
    pub fn all_sequences(&self) -> Vec<&Sequence> {
        self.sequences.values().collect()
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
        timeline::{Clip, Sequence, SequenceFormat, Track, TrackKind},
    };
    use tempfile::TempDir;

    fn create_test_ops_log() -> (OpsLog, TempDir) {
        let temp_dir = TempDir::new().unwrap();
        let ops_path = temp_dir.path().join("ops.jsonl");
        let ops_log = OpsLog::new(&ops_path);
        (ops_log, temp_dir)
    }

    #[test]
    fn test_project_state_new() {
        let state = ProjectState::new("Test Project");

        assert_eq!(state.meta.name, "Test Project");
        assert!(state.assets.is_empty());
        assert!(state.sequences.is_empty());
        assert!(state.active_sequence_id.is_none());
        assert!(state.last_op_id.is_none());
        assert_eq!(state.op_count, 0);
    }

    #[test]
    fn test_apply_asset_import() {
        let mut state = ProjectState::new("Test Project");

        let asset = Asset::new_video("video.mp4", "/path/video.mp4", VideoInfo::default());
        let op = Operation::new(OpKind::AssetImport, serde_json::to_value(&asset).unwrap());

        state.apply_operation(&op).unwrap();

        assert_eq!(state.assets.len(), 1);
        assert!(state.assets.contains_key(&asset.id));
    }

    #[test]
    fn test_apply_asset_remove() {
        let mut state = ProjectState::new("Test Project");

        // First import an asset
        let asset = Asset::new_video("video.mp4", "/path/video.mp4", VideoInfo::default());
        let import_op = Operation::new(OpKind::AssetImport, serde_json::to_value(&asset).unwrap());
        state.apply_operation(&import_op).unwrap();

        // Then remove it
        let remove_op = Operation::new(
            OpKind::AssetRemove,
            serde_json::json!({ "assetId": asset.id }),
        );
        state.apply_operation(&remove_op).unwrap();

        assert!(state.assets.is_empty());
    }

    #[test]
    fn test_apply_sequence_create() {
        let mut state = ProjectState::new("Test Project");

        let sequence = Sequence::new("Main Sequence", SequenceFormat::youtube_1080());
        let op = Operation::new(
            OpKind::SequenceCreate,
            serde_json::to_value(&sequence).unwrap(),
        );

        state.apply_operation(&op).unwrap();

        assert_eq!(state.sequences.len(), 1);
        assert!(state.active_sequence_id.is_some());
        assert_eq!(state.active_sequence_id.as_ref().unwrap(), &sequence.id);
    }

    #[test]
    fn test_apply_track_add() {
        let mut state = ProjectState::new("Test Project");

        // Create sequence first
        let sequence = Sequence::new("Main Sequence", SequenceFormat::youtube_1080());
        let seq_id = sequence.id.clone();
        let seq_op = Operation::new(
            OpKind::SequenceCreate,
            serde_json::to_value(&sequence).unwrap(),
        );
        state.apply_operation(&seq_op).unwrap();

        // Add track
        let track = Track::new("Video 1", TrackKind::Video);
        let track_op = Operation::new(
            OpKind::TrackAdd,
            serde_json::json!({
                "sequenceId": seq_id,
                "track": track
            }),
        );
        state.apply_operation(&track_op).unwrap();

        let seq = state.get_sequence(&seq_id).unwrap();
        assert_eq!(seq.tracks.len(), 1);
        assert_eq!(seq.tracks[0].name, "Video 1");
    }

    #[test]
    fn test_apply_clip_add() {
        let mut state = ProjectState::new("Test Project");

        // Setup: sequence and track
        let sequence = Sequence::new("Main Sequence", SequenceFormat::youtube_1080());
        let seq_id = sequence.id.clone();
        state
            .apply_operation(&Operation::new(
                OpKind::SequenceCreate,
                serde_json::to_value(&sequence).unwrap(),
            ))
            .unwrap();

        let track = Track::new("Video 1", TrackKind::Video);
        let track_id = track.id.clone();
        state
            .apply_operation(&Operation::new(
                OpKind::TrackAdd,
                serde_json::json!({
                    "sequenceId": seq_id,
                    "track": track
                }),
            ))
            .unwrap();

        // Add clip
        let clip = Clip::new("asset_001").with_source_range(0.0, 10.0);
        let clip_id = clip.id.clone();
        state
            .apply_operation(&Operation::new(
                OpKind::ClipAdd,
                serde_json::json!({
                    "sequenceId": seq_id,
                    "trackId": track_id,
                    "clip": clip
                }),
            ))
            .unwrap();

        let seq = state.get_sequence(&seq_id).unwrap();
        assert_eq!(seq.tracks[0].clips.len(), 1);
        assert_eq!(seq.tracks[0].clips[0].id, clip_id);
    }

    #[test]
    fn test_from_ops_log() {
        let (ops_log, _temp_dir) = create_test_ops_log();

        // Create operations
        let asset = Asset::new_video("video.mp4", "/path/video.mp4", VideoInfo::default());
        let sequence = Sequence::new("Main Sequence", SequenceFormat::youtube_1080());

        let ops = vec![
            Operation::new(OpKind::AssetImport, serde_json::to_value(&asset).unwrap()),
            Operation::new(
                OpKind::SequenceCreate,
                serde_json::to_value(&sequence).unwrap(),
            ),
        ];

        ops_log.append_batch(&ops).unwrap();

        // Reconstruct state from ops log
        let meta = ProjectMeta::new("Test Project");
        let state = ProjectState::from_ops_log(&ops_log, meta).unwrap();

        assert_eq!(state.assets.len(), 1);
        assert_eq!(state.sequences.len(), 1);
        assert_eq!(state.op_count, 2);
    }

    #[test]
    fn test_project_state_query_methods() {
        let mut state = ProjectState::new("Test Project");

        // Setup
        let asset = Asset::new_video("video.mp4", "/path/video.mp4", VideoInfo::default());
        let asset_id = asset.id.clone();
        state
            .apply_operation(&Operation::new(
                OpKind::AssetImport,
                serde_json::to_value(&asset).unwrap(),
            ))
            .unwrap();

        let sequence = Sequence::new("Main Sequence", SequenceFormat::youtube_1080());
        let seq_id = sequence.id.clone();
        state
            .apply_operation(&Operation::new(
                OpKind::SequenceCreate,
                serde_json::to_value(&sequence).unwrap(),
            ))
            .unwrap();

        // Test query methods
        assert!(state.get_asset(&asset_id).is_some());
        assert!(state.get_asset("nonexistent").is_none());
        assert!(state.get_sequence(&seq_id).is_some());
        assert!(state.get_active_sequence().is_some());
        assert_eq!(state.all_assets().len(), 1);
        assert_eq!(state.all_sequences().len(), 1);
    }

    #[test]
    fn test_clip_move() {
        let mut state = ProjectState::new("Test Project");

        // Setup sequence, track, and clip
        let sequence = Sequence::new("Main Sequence", SequenceFormat::youtube_1080());
        let seq_id = sequence.id.clone();
        state
            .apply_operation(&Operation::new(
                OpKind::SequenceCreate,
                serde_json::to_value(&sequence).unwrap(),
            ))
            .unwrap();

        let track = Track::new("Video 1", TrackKind::Video);
        let track_id = track.id.clone();
        state
            .apply_operation(&Operation::new(
                OpKind::TrackAdd,
                serde_json::json!({
                    "sequenceId": seq_id,
                    "track": track
                }),
            ))
            .unwrap();

        let clip = Clip::new("asset_001")
            .with_source_range(0.0, 10.0)
            .place_at(0.0);
        let clip_id = clip.id.clone();
        state
            .apply_operation(&Operation::new(
                OpKind::ClipAdd,
                serde_json::json!({
                    "sequenceId": seq_id,
                    "trackId": track_id,
                    "clip": clip
                }),
            ))
            .unwrap();

        // Move clip
        state
            .apply_operation(&Operation::new(
                OpKind::ClipMove,
                serde_json::json!({
                    "sequenceId": seq_id,
                    "clipId": clip_id,
                    "timelineIn": 5.0
                }),
            ))
            .unwrap();

        let (_, _, moved_clip) = state.find_clip(&clip_id).unwrap();
        assert_eq!(moved_clip.place.timeline_in_sec, 5.0);
    }

    #[test]
    fn test_op_count_and_last_op() {
        let mut state = ProjectState::new("Test Project");

        let asset1 = Asset::new_video("a.mp4", "/a.mp4", VideoInfo::default());
        let asset2 = Asset::new_video("b.mp4", "/b.mp4", VideoInfo::default());

        let op1 = Operation::with_id(
            "op_001",
            OpKind::AssetImport,
            serde_json::to_value(&asset1).unwrap(),
        );
        let op2 = Operation::with_id(
            "op_002",
            OpKind::AssetImport,
            serde_json::to_value(&asset2).unwrap(),
        );

        state.apply_operation(&op1).unwrap();
        assert_eq!(state.op_count, 1);
        assert_eq!(state.last_op_id, Some("op_001".to_string()));

        state.apply_operation(&op2).unwrap();
        assert_eq!(state.op_count, 2);
        assert_eq!(state.last_op_id, Some("op_002".to_string()));
    }

    #[test]
    fn test_batch_operation() {
        let mut state = ProjectState::new("Test Project");

        let asset1 = Asset::new_video("a.mp4", "/a.mp4", VideoInfo::default());
        let asset2 = Asset::new_video("b.mp4", "/b.mp4", VideoInfo::default());

        let batch_op = Operation::new(
            OpKind::Batch,
            serde_json::json!({
                "operations": [
                    Operation::new(OpKind::AssetImport, serde_json::to_value(&asset1).unwrap()),
                    Operation::new(OpKind::AssetImport, serde_json::to_value(&asset2).unwrap())
                ]
            }),
        );

        state.apply_operation(&batch_op).unwrap();

        assert_eq!(state.assets.len(), 2);
    }

    #[test]
    fn test_project_meta() {
        let mut meta = ProjectMeta::new("My Project");

        assert_eq!(meta.name, "My Project");
        assert_eq!(meta.version, "1.0.0");
        assert!(meta.description.is_none());

        let old_modified = meta.modified_at.clone();
        std::thread::sleep(std::time::Duration::from_millis(10));
        meta.touch();
        assert_ne!(meta.modified_at, old_modified);
    }

    #[test]
    fn test_find_track_and_clip() {
        let mut state = ProjectState::new("Test Project");

        // Setup
        let sequence = Sequence::new("Main", SequenceFormat::youtube_1080());
        let seq_id = sequence.id.clone();
        state
            .apply_operation(&Operation::new(
                OpKind::SequenceCreate,
                serde_json::to_value(&sequence).unwrap(),
            ))
            .unwrap();

        let track = Track::new("Video 1", TrackKind::Video);
        let track_id = track.id.clone();
        state
            .apply_operation(&Operation::new(
                OpKind::TrackAdd,
                serde_json::json!({
                    "sequenceId": seq_id,
                    "track": track
                }),
            ))
            .unwrap();

        let clip = Clip::new("asset_001").with_source_range(0.0, 5.0);
        let clip_id = clip.id.clone();
        state
            .apply_operation(&Operation::new(
                OpKind::ClipAdd,
                serde_json::json!({
                    "sequenceId": seq_id,
                    "trackId": track_id,
                    "clip": clip
                }),
            ))
            .unwrap();

        // Test find_track
        let (found_seq, found_track) = state.find_track(&track_id).unwrap();
        assert_eq!(found_seq.id, seq_id);
        assert_eq!(found_track.id, track_id);

        // Test find_clip
        let (found_seq, found_track, found_clip) = state.find_clip(&clip_id).unwrap();
        assert_eq!(found_seq.id, seq_id);
        assert_eq!(found_track.id, track_id);
        assert_eq!(found_clip.id, clip_id);
    }
}
