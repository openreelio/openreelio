//! Project State Module
//!
//! Implements the ProjectState that is reconstructed from ops.jsonl by replaying operations.
//! Uses Event Sourcing pattern where the ops.jsonl is the single source of truth.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::core::{
    assets::Asset,
    effects::Effect,
    project::{OpKind, Operation, OpsLog},
    timeline::{Clip, Sequence, Track},
    AssetId, CoreError, CoreResult, EffectId, SequenceId,
};

// =============================================================================
// Project Metadata
// =============================================================================

/// Project metadata stored in project.json
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMeta {
    /// Unique project ID (persisted, generated once on creation)
    pub id: String,
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
    /// Creates new project metadata with a unique ID
    pub fn new(name: &str) -> Self {
        let now = chrono::Utc::now().to_rfc3339();
        Self {
            id: ulid::Ulid::new().to_string(),
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

    /// Updates the modified timestamp to a specific timestamp (RFC3339)
    pub fn touch_at(&mut self, timestamp_rfc3339: &str) {
        self.modified_at = timestamp_rfc3339.to_string();
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
    /// All effects indexed by ID
    pub effects: HashMap<EffectId, Effect>,
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
    /// Creates a new project state with a default sequence and tracks
    pub fn new(name: &str) -> Self {
        // Create default sequence with standard tracks
        let mut default_sequence = Sequence::new(
            "Sequence 1",
            crate::core::timeline::SequenceFormat::youtube_1080(),
        );

        // Add default video track
        let video_track = Track::new("Video 1", crate::core::timeline::TrackKind::Video);
        default_sequence.add_track(video_track);

        // Add default audio track
        let audio_track = Track::new("Audio 1", crate::core::timeline::TrackKind::Audio);
        default_sequence.add_track(audio_track);

        let seq_id = default_sequence.id.clone();
        let mut sequences = HashMap::new();
        sequences.insert(seq_id.clone(), default_sequence);

        Self {
            meta: ProjectMeta::new(name),
            assets: HashMap::new(),
            sequences,
            effects: HashMap::new(),
            active_sequence_id: Some(seq_id),
            last_op_id: None,
            op_count: 0,
            is_dirty: false,
        }
    }

    /// Creates a new empty project state (no default sequence)
    pub fn new_empty(name: &str) -> Self {
        Self {
            meta: ProjectMeta::new(name),
            assets: HashMap::new(),
            sequences: HashMap::new(),
            effects: HashMap::new(),
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
            effects: HashMap::new(),
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
        self.meta.touch_at(&op.timestamp);

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

            // Update license if provided
            if !op.payload["license"].is_null() {
                if let Ok(license) = serde_json::from_value(op.payload["license"].clone()) {
                    asset.license = license;
                }
            }

            // Thumbnail URL (optional key; null clears)
            if let Some(thumbnail_value) = op.payload.get("thumbnailUrl") {
                asset.thumbnail_url = thumbnail_value.as_str().map(|s| s.to_string());
            }

            // Proxy status (optional key)
            if let Some(proxy_status_value) = op.payload.get("proxyStatus") {
                if let Ok(status) = serde_json::from_value::<crate::core::assets::ProxyStatus>(
                    proxy_status_value.clone(),
                ) {
                    asset.proxy_status = status;
                }
            }

            // Proxy URL (optional key; null clears)
            if let Some(proxy_url_value) = op.payload.get("proxyUrl") {
                asset.proxy_url = proxy_url_value.as_str().map(|s| s.to_string());
            }
        }
        Ok(())
    }

    fn sort_track_clips(track: &mut Track) {
        track.clips.sort_by(|a, b| {
            a.place
                .timeline_in_sec
                .total_cmp(&b.place.timeline_in_sec)
                .then_with(|| a.id.cmp(&b.id))
        });
    }

    fn validate_track_no_overlap(track: &Track) -> CoreResult<()> {
        // Assumes clips are sorted by timeline_in_sec.
        for i in 1..track.clips.len() {
            let prev = &track.clips[i - 1];
            let curr = &track.clips[i];
            if prev.place.overlaps(&curr.place) {
                return Err(CoreError::ClipOverlap {
                    track_id: track.id.clone(),
                    existing_clip_id: prev.id.clone(),
                    new_start: curr.place.timeline_in_sec,
                    new_end: curr.place.timeline_in_sec + curr.place.duration_sec,
                });
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
            if let Some(pos) = op.payload["position"].as_u64() {
                let pos = pos as usize;
                if pos <= sequence.tracks.len() {
                    sequence.tracks.insert(pos, track);
                } else {
                    sequence.tracks.push(track);
                }
            } else {
                sequence.add_track(track);
            }
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
                Self::sort_track_clips(track);
                Self::validate_track_no_overlap(track)?;
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

        let dest_track_id = op.payload["trackId"].as_str();

        let sequence = self
            .sequences
            .get_mut(seq_id)
            .ok_or_else(|| CoreError::NotFound(format!("Sequence not found: {}", seq_id)))?;

        // Find the current track containing the clip.
        let mut src_track_idx = None;
        let mut src_clip_idx = None;
        for (t_idx, track) in sequence.tracks.iter().enumerate() {
            if let Some(c_idx) = track.clips.iter().position(|c| c.id == clip_id) {
                src_track_idx = Some(t_idx);
                src_clip_idx = Some(c_idx);
                break;
            }
        }

        let (src_track_idx, src_clip_idx) = match (src_track_idx, src_clip_idx) {
            (Some(t), Some(c)) => (t, c),
            _ => {
                return Err(CoreError::NotFound(format!(
                    "Clip not found in sequence: {}",
                    clip_id
                )));
            }
        };

        // Update placement.
        let new_timeline_in = op.payload["timelineIn"].as_f64();

        // Cross-track move if trackId is provided and differs from source.
        if let Some(dest_track_id) = dest_track_id {
            let current_track_id = sequence.tracks[src_track_idx].id.clone();
            if current_track_id != dest_track_id {
                // Validate destination track exists BEFORE removing clip from source.
                // This prevents data loss if destination track is not found.
                let dest_idx = sequence
                    .tracks
                    .iter()
                    .position(|t| t.id == dest_track_id)
                    .ok_or_else(|| {
                        CoreError::NotFound(format!(
                            "Destination track not found: {}",
                            dest_track_id
                        ))
                    })?;

                // Now safe to remove clip from source track.
                let mut clip = sequence.tracks[src_track_idx].clips.remove(src_clip_idx);
                if let Some(timeline_in) = new_timeline_in {
                    clip.place.timeline_in_sec = timeline_in;
                }

                // Add to destination track.
                sequence.tracks[dest_idx].clips.push(clip);

                // Validate overlap on destination track. If validation fails, we need
                // to restore the clip to source track to maintain consistency.
                if let Err(e) = Self::validate_track_no_overlap(&sequence.tracks[dest_idx]) {
                    // Restore clip to source track - remove from destination first.
                    if let Some(clip) = sequence.tracks[dest_idx].clips.pop() {
                        sequence.tracks[src_track_idx].clips.push(clip);
                        Self::sort_track_clips(&mut sequence.tracks[src_track_idx]);
                    }
                    return Err(e);
                }

                Self::sort_track_clips(&mut sequence.tracks[dest_idx]);
                Self::sort_track_clips(&mut sequence.tracks[src_track_idx]);
                return Ok(());
            }
        }

        // Same-track move.
        if let Some(clip) = sequence.tracks[src_track_idx].get_clip_mut(clip_id) {
            let old_timeline_in = clip.place.timeline_in_sec;
            if let Some(timeline_in) = new_timeline_in {
                clip.place.timeline_in_sec = timeline_in;
            }
            Self::sort_track_clips(&mut sequence.tracks[src_track_idx]);

            // Validate overlap. If fails, restore original position.
            if let Err(e) = Self::validate_track_no_overlap(&sequence.tracks[src_track_idx]) {
                if let Some(clip) = sequence.tracks[src_track_idx].get_clip_mut(clip_id) {
                    clip.place.timeline_in_sec = old_timeline_in;
                }
                Self::sort_track_clips(&mut sequence.tracks[src_track_idx]);
                return Err(e);
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

                    Self::sort_track_clips(track);
                    Self::validate_track_no_overlap(track)?;
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

                Self::sort_track_clips(track);
                Self::validate_track_no_overlap(track)?;
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

        let position = op
            .payload
            .get("position")
            .and_then(|v| v.as_u64())
            .map(|v| v as usize);

        // Parse the effect from payload
        let effect: Effect = serde_json::from_value(op.payload["effect"].clone())
            .map_err(|e| CoreError::InvalidCommand(format!("Invalid effect data: {}", e)))?;

        let effect_id = effect.id.clone();

        // Find the clip first to validate it exists
        let sequence = self
            .sequences
            .get_mut(seq_id)
            .ok_or_else(|| CoreError::NotFound(format!("Sequence not found: {}", seq_id)))?;

        let mut clip_found = false;
        for track in &mut sequence.tracks {
            if let Some(clip) = track.get_clip_mut(clip_id) {
                if clip.effects.iter().any(|e| e == &effect_id) {
                    return Err(CoreError::InvalidCommand(format!(
                        "Effect already present on clip: {}",
                        effect_id
                    )));
                }

                match position {
                    Some(pos) if pos < clip.effects.len() => {
                        clip.effects.insert(pos, effect_id.clone());
                    }
                    _ => {
                        clip.effects.push(effect_id.clone());
                    }
                }
                clip_found = true;
                break;
            }
        }

        if !clip_found {
            return Err(CoreError::NotFound(format!("Clip not found: {}", clip_id)));
        }

        // Store the effect in the effects map only after clip is validated
        self.effects.insert(effect_id, effect);

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

        // Find the clip first to validate it exists
        let sequence = self
            .sequences
            .get_mut(seq_id)
            .ok_or_else(|| CoreError::NotFound(format!("Sequence not found: {}", seq_id)))?;

        let mut clip_found = false;
        for track in &mut sequence.tracks {
            if let Some(clip) = track.get_clip_mut(clip_id) {
                clip.effects.retain(|e| e != effect_id);
                clip_found = true;
                break;
            }
        }

        if !clip_found {
            return Err(CoreError::NotFound(format!("Clip not found: {}", clip_id)));
        }

        // Remove effect from the effects map
        self.effects.remove(effect_id);

        Ok(())
    }

    fn apply_effect_update(&mut self, op: &Operation) -> CoreResult<()> {
        use crate::core::effects::ParamValue;

        let effect_id = op.payload["effectId"]
            .as_str()
            .ok_or_else(|| CoreError::InvalidCommand("Missing effectId".to_string()))?;

        let effect = self
            .effects
            .get_mut(effect_id)
            .ok_or_else(|| CoreError::NotFound(format!("Effect not found: {}", effect_id)))?;

        // Update enabled state if provided
        if let Some(enabled_value) = op.payload.get("enabled") {
            if enabled_value.is_null() {
                // no-op
            } else if let Some(enabled) = enabled_value.as_bool() {
                effect.enabled = enabled;
            } else {
                return Err(CoreError::InvalidCommand(
                    "Invalid enabled value (expected boolean)".to_string(),
                ));
            }
        }

        // Update order if provided
        if let Some(order_value) = op.payload.get("order") {
            if order_value.is_null() {
                // no-op
            } else if let Some(order_u64) = order_value.as_u64() {
                if order_u64 > u32::MAX as u64 {
                    return Err(CoreError::InvalidCommand(
                        "Invalid order value (out of range)".to_string(),
                    ));
                }
                effect.order = order_u64 as u32;
            } else {
                return Err(CoreError::InvalidCommand(
                    "Invalid order value (expected unsigned integer)".to_string(),
                ));
            }
        }

        // Update parameters if provided
        if let Some(params) = op.payload["params"].as_object() {
            for (key, value) in params {
                let param_value: ParamValue =
                    serde_json::from_value(value.clone()).map_err(|e| {
                        CoreError::InvalidCommand(format!(
                            "Invalid effect param value for '{key}': {e}"
                        ))
                    })?;
                effect.set_param(key, param_value);
            }
        }

        Ok(())
    }

    // =========================================================================
    // Caption Operation Handlers
    // =========================================================================

    fn apply_caption_add(&mut self, op: &Operation) -> CoreResult<()> {
        use crate::core::timeline::{Clip, ClipPlace, ClipRange};

        let seq_id = op.payload["sequenceId"]
            .as_str()
            .ok_or_else(|| CoreError::InvalidCommand("Missing sequenceId".to_string()))?;
        let track_id = op.payload["trackId"]
            .as_str()
            .ok_or_else(|| CoreError::InvalidCommand("Missing trackId".to_string()))?;

        let sequence = self
            .sequences
            .get_mut(seq_id)
            .ok_or_else(|| CoreError::NotFound(format!("Sequence not found: {}", seq_id)))?;
        let track = sequence
            .get_track_mut(track_id)
            .ok_or_else(|| CoreError::NotFound(format!("Track not found: {}", track_id)))?;
        if !track.is_caption() {
            return Err(CoreError::ValidationError(format!(
                "Track is not a caption track: {}",
                track_id
            )));
        }

        // Prefer full clip payload (forward-compatible), otherwise build from primitives.
        if !op.payload["clip"].is_null() {
            let clip: Clip = serde_json::from_value(op.payload["clip"].clone())
                .map_err(|e| CoreError::InvalidCommand(format!("Invalid clip data: {}", e)))?;
            track.add_clip(clip);
            return Ok(());
        }

        let start_sec = op.payload["startSec"]
            .as_f64()
            .ok_or_else(|| CoreError::InvalidCommand("Missing startSec".to_string()))?;
        let end_sec = op.payload["endSec"]
            .as_f64()
            .ok_or_else(|| CoreError::InvalidCommand("Missing endSec".to_string()))?;
        if !start_sec.is_finite()
            || !end_sec.is_finite()
            || start_sec < 0.0
            || end_sec < 0.0
            || start_sec >= end_sec
        {
            return Err(CoreError::InvalidTimeRange(start_sec, end_sec));
        }

        let duration = end_sec - start_sec;
        let text = op.payload["text"].as_str().unwrap_or("").to_string();

        let mut clip = Clip::new("caption");
        clip.speed = 1.0;
        clip.place = ClipPlace::new(start_sec, duration);
        clip.range = ClipRange::new(0.0, duration);
        clip.label = if text.trim().is_empty() {
            None
        } else {
            Some(text)
        };

        track.add_clip(clip);
        Ok(())
    }

    fn apply_caption_remove(&mut self, op: &Operation) -> CoreResult<()> {
        let seq_id = op.payload["sequenceId"]
            .as_str()
            .ok_or_else(|| CoreError::InvalidCommand("Missing sequenceId".to_string()))?;
        let track_id = op.payload["trackId"]
            .as_str()
            .ok_or_else(|| CoreError::InvalidCommand("Missing trackId".to_string()))?;
        let caption_id = op
            .payload
            .get("captionId")
            .and_then(|v| v.as_str())
            .or_else(|| op.payload.get("clipId").and_then(|v| v.as_str()))
            .ok_or_else(|| CoreError::InvalidCommand("Missing captionId".to_string()))?;

        let sequence = self
            .sequences
            .get_mut(seq_id)
            .ok_or_else(|| CoreError::NotFound(format!("Sequence not found: {}", seq_id)))?;
        let track = sequence
            .get_track_mut(track_id)
            .ok_or_else(|| CoreError::NotFound(format!("Track not found: {}", track_id)))?;
        if !track.is_caption() {
            return Err(CoreError::ValidationError(format!(
                "Track is not a caption track: {}",
                track_id
            )));
        }

        track.remove_clip(&caption_id.to_string());
        Ok(())
    }

    fn apply_caption_update(&mut self, op: &Operation) -> CoreResult<()> {
        use crate::core::timeline::{ClipPlace, ClipRange};

        let seq_id = op.payload["sequenceId"]
            .as_str()
            .ok_or_else(|| CoreError::InvalidCommand("Missing sequenceId".to_string()))?;
        let track_id = op.payload["trackId"]
            .as_str()
            .ok_or_else(|| CoreError::InvalidCommand("Missing trackId".to_string()))?;
        let caption_id = op
            .payload
            .get("captionId")
            .and_then(|v| v.as_str())
            .or_else(|| op.payload.get("clipId").and_then(|v| v.as_str()))
            .ok_or_else(|| CoreError::InvalidCommand("Missing captionId".to_string()))?;

        let sequence = self
            .sequences
            .get_mut(seq_id)
            .ok_or_else(|| CoreError::NotFound(format!("Sequence not found: {}", seq_id)))?;
        let track = sequence
            .get_track_mut(track_id)
            .ok_or_else(|| CoreError::NotFound(format!("Track not found: {}", track_id)))?;
        if !track.is_caption() {
            return Err(CoreError::ValidationError(format!(
                "Track is not a caption track: {}",
                track_id
            )));
        }

        let clip = track
            .get_clip_mut(caption_id)
            .ok_or_else(|| CoreError::NotFound(format!("Caption not found: {}", caption_id)))?;

        clip.speed = 1.0;

        if let Some(text) = op.payload.get("text").and_then(|v| v.as_str()) {
            let trimmed = text.trim();
            clip.label = if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            };
        }

        let start_sec = op.payload.get("startSec").and_then(|v| v.as_f64());
        let end_sec = op.payload.get("endSec").and_then(|v| v.as_f64());
        if start_sec.is_some() || end_sec.is_some() {
            let old_start = clip.place.timeline_in_sec;
            let old_end = clip.place.timeline_out_sec();

            let new_start = start_sec.unwrap_or(old_start);
            let new_end = end_sec.unwrap_or(old_end);

            if !new_start.is_finite() || !new_end.is_finite() || new_start < 0.0 || new_end < 0.0 {
                return Err(CoreError::ValidationError(
                    "Caption time range must be finite and non-negative".to_string(),
                ));
            }
            if new_start >= new_end {
                return Err(CoreError::InvalidTimeRange(new_start, new_end));
            }

            let duration = new_end - new_start;
            clip.place = ClipPlace::new(new_start, duration);
            clip.range = ClipRange::new(0.0, duration);
        }

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

    /// Gets an effect by ID
    pub fn get_effect(&self, effect_id: &str) -> Option<&Effect> {
        self.effects.get(effect_id)
    }

    /// Gets effects for a clip, sorted by order
    pub fn get_clip_effects(&self, clip: &Clip) -> Vec<&Effect> {
        let mut effects: Vec<&Effect> = clip
            .effects
            .iter()
            .filter_map(|id| self.effects.get(id))
            .collect();
        effects.sort_by_key(|e| e.order);
        effects
    }

    /// Returns all effects as a vector
    pub fn all_effects(&self) -> Vec<&Effect> {
        self.effects.values().collect()
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
        // New project now includes default sequence with video and audio tracks
        assert_eq!(state.sequences.len(), 1);
        assert!(state.active_sequence_id.is_some());
        let active_seq = state.get_active_sequence().unwrap();
        assert_eq!(active_seq.name, "Sequence 1");
        assert_eq!(active_seq.tracks.len(), 2);
        assert_eq!(active_seq.tracks[0].name, "Video 1");
        assert_eq!(active_seq.tracks[1].name, "Audio 1");
        assert!(state.last_op_id.is_none());
        assert_eq!(state.op_count, 0);
    }

    #[test]
    fn test_project_state_new_empty() {
        let state = ProjectState::new_empty("Test Project");

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
        // Use new_empty to test sequence creation in isolation
        let mut state = ProjectState::new_empty("Test Project");

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
        // Use new_empty to test query methods in isolation
        let mut state = ProjectState::new_empty("Test Project");

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

    // -------------------------------------------------------------------------
    // Effect Operation Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_apply_effect_add() {
        use crate::core::effects::{Effect, EffectType, ParamValue};

        let mut state = ProjectState::new("Test Project");

        // Setup sequence, track, and clip
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

        // Add effect
        let mut blur_effect = Effect::new(EffectType::GaussianBlur);
        blur_effect.set_param("radius", ParamValue::Float(5.0));
        let effect_id = blur_effect.id.clone();

        state
            .apply_operation(&Operation::new(
                OpKind::EffectAdd,
                serde_json::json!({
                    "sequenceId": seq_id,
                    "clipId": clip_id,
                    "effect": blur_effect
                }),
            ))
            .unwrap();

        // Verify effect was added to state
        assert!(state.effects.contains_key(&effect_id));
        assert_eq!(state.effects.len(), 1);

        // Verify effect reference was added to clip
        let (_, _, clip) = state.find_clip(&clip_id).unwrap();
        assert!(clip.effects.contains(&effect_id));
    }

    #[test]
    fn test_apply_effect_remove() {
        use crate::core::effects::{Effect, EffectType, ParamValue};

        let mut state = ProjectState::new("Test Project");

        // Setup sequence, track, clip
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

        // Add effect
        let mut blur_effect = Effect::new(EffectType::GaussianBlur);
        blur_effect.set_param("radius", ParamValue::Float(5.0));
        let effect_id = blur_effect.id.clone();

        state
            .apply_operation(&Operation::new(
                OpKind::EffectAdd,
                serde_json::json!({
                    "sequenceId": seq_id,
                    "clipId": clip_id,
                    "effect": blur_effect
                }),
            ))
            .unwrap();

        assert_eq!(state.effects.len(), 1);

        // Remove effect
        state
            .apply_operation(&Operation::new(
                OpKind::EffectRemove,
                serde_json::json!({
                    "sequenceId": seq_id,
                    "clipId": clip_id,
                    "effectId": effect_id
                }),
            ))
            .unwrap();

        // Verify effect was removed
        assert!(!state.effects.contains_key(&effect_id));
        assert_eq!(state.effects.len(), 0);

        // Verify effect reference was removed from clip
        let (_, _, clip) = state.find_clip(&clip_id).unwrap();
        assert!(!clip.effects.contains(&effect_id));
    }

    #[test]
    fn test_apply_effect_update() {
        use crate::core::effects::{Effect, EffectType, ParamValue};

        let mut state = ProjectState::new("Test Project");

        // Setup sequence, track, clip
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

        // Add effect
        let mut blur_effect = Effect::new(EffectType::GaussianBlur);
        blur_effect.set_param("radius", ParamValue::Float(5.0));
        let effect_id = blur_effect.id.clone();

        state
            .apply_operation(&Operation::new(
                OpKind::EffectAdd,
                serde_json::json!({
                    "sequenceId": seq_id,
                    "clipId": clip_id,
                    "effect": blur_effect
                }),
            ))
            .unwrap();

        // Update effect
        state
            .apply_operation(&Operation::new(
                OpKind::EffectUpdate,
                serde_json::json!({
                    "effectId": effect_id,
                    "enabled": false,
                    "order": 5,
                    "params": {
                        "radius": ParamValue::Float(10.0)
                    }
                }),
            ))
            .unwrap();

        // Verify effect was updated
        let effect = state.get_effect(&effect_id).unwrap();
        assert!(!effect.enabled);
        assert_eq!(effect.order, 5);
        assert_eq!(effect.get_float("radius"), Some(10.0));
    }

    #[test]
    fn test_apply_effect_update_rejects_invalid_param_values() {
        use crate::core::effects::{Effect, EffectType};

        let mut state = ProjectState::new("Test Project");

        // Setup sequence, track, clip
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

        // Add effect
        let blur_effect = Effect::new(EffectType::GaussianBlur);
        let effect_id = blur_effect.id.clone();
        state
            .apply_operation(&Operation::new(
                OpKind::EffectAdd,
                serde_json::json!({
                    "sequenceId": seq_id,
                    "clipId": clip_id,
                    "effect": blur_effect
                }),
            ))
            .unwrap();

        // Attempt to apply invalid param type (object is not a valid ParamValue).
        let result = state.apply_operation(&Operation::new(
            OpKind::EffectUpdate,
            serde_json::json!({
                "effectId": effect_id,
                "params": {
                    "radius": { "bad": true }
                }
            }),
        ));

        assert!(result.is_err());
    }

    #[test]
    fn test_get_clip_effects() {
        use crate::core::effects::{Effect, EffectType, ParamValue};

        let mut state = ProjectState::new("Test Project");

        // Setup sequence, track, clip
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

        // Add multiple effects with different orders
        let mut blur_effect = Effect::new(EffectType::GaussianBlur);
        blur_effect.set_param("radius", ParamValue::Float(5.0));
        blur_effect.order = 2;

        let mut brightness_effect = Effect::new(EffectType::Brightness);
        brightness_effect.set_param("value", ParamValue::Float(0.2));
        brightness_effect.order = 1;

        state
            .apply_operation(&Operation::new(
                OpKind::EffectAdd,
                serde_json::json!({
                    "sequenceId": seq_id,
                    "clipId": clip_id,
                    "effect": blur_effect
                }),
            ))
            .unwrap();

        state
            .apply_operation(&Operation::new(
                OpKind::EffectAdd,
                serde_json::json!({
                    "sequenceId": seq_id,
                    "clipId": clip_id,
                    "effect": brightness_effect
                }),
            ))
            .unwrap();

        // Get clip and verify effects
        let (_, _, clip) = state.find_clip(&clip_id).unwrap();
        let effects = state.get_clip_effects(clip);

        assert_eq!(effects.len(), 2);
        // Should be sorted by order (brightness first, then blur)
        assert_eq!(effects[0].order, 1);
        assert_eq!(effects[1].order, 2);
    }

    // -------------------------------------------------------------------------
    // Effect Operation Error Handling Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_apply_effect_add_sequence_not_found() {
        use crate::core::effects::{Effect, EffectType};

        let mut state = ProjectState::new("Test Project");

        let blur_effect = Effect::new(EffectType::GaussianBlur);

        let result = state.apply_operation(&Operation::new(
            OpKind::EffectAdd,
            serde_json::json!({
                "sequenceId": "non_existent_seq",
                "clipId": "some_clip",
                "effect": blur_effect
            }),
        ));

        assert!(result.is_err());
        assert!(matches!(result.unwrap_err(), CoreError::NotFound(_)));
    }

    #[test]
    fn test_apply_effect_add_clip_not_found() {
        use crate::core::effects::{Effect, EffectType};

        let mut state = ProjectState::new("Test Project");

        // Setup sequence with no clips
        let sequence = Sequence::new("Main", SequenceFormat::youtube_1080());
        let seq_id = sequence.id.clone();
        state
            .apply_operation(&Operation::new(
                OpKind::SequenceCreate,
                serde_json::to_value(&sequence).unwrap(),
            ))
            .unwrap();

        let blur_effect = Effect::new(EffectType::GaussianBlur);

        let result = state.apply_operation(&Operation::new(
            OpKind::EffectAdd,
            serde_json::json!({
                "sequenceId": seq_id,
                "clipId": "non_existent_clip",
                "effect": blur_effect
            }),
        ));

        assert!(result.is_err());
        assert!(matches!(result.unwrap_err(), CoreError::NotFound(_)));
    }

    #[test]
    fn test_apply_effect_remove_clip_not_found() {
        let mut state = ProjectState::new("Test Project");

        // Setup sequence with no clips
        let sequence = Sequence::new("Main", SequenceFormat::youtube_1080());
        let seq_id = sequence.id.clone();
        state
            .apply_operation(&Operation::new(
                OpKind::SequenceCreate,
                serde_json::to_value(&sequence).unwrap(),
            ))
            .unwrap();

        let result = state.apply_operation(&Operation::new(
            OpKind::EffectRemove,
            serde_json::json!({
                "sequenceId": seq_id,
                "clipId": "non_existent_clip",
                "effectId": "some_effect"
            }),
        ));

        assert!(result.is_err());
        assert!(matches!(result.unwrap_err(), CoreError::NotFound(_)));
    }

    #[test]
    fn test_apply_effect_update_not_found() {
        let mut state = ProjectState::new("Test Project");

        let result = state.apply_operation(&Operation::new(
            OpKind::EffectUpdate,
            serde_json::json!({
                "effectId": "non_existent_effect",
                "enabled": false
            }),
        ));

        assert!(result.is_err());
        assert!(matches!(result.unwrap_err(), CoreError::NotFound(_)));
    }

    // -------------------------------------------------------------------------
    // Caption Operation Replay Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_apply_caption_update_updates_caption_clip() {
        use crate::core::timeline::{ClipPlace, ClipRange};

        let mut state = ProjectState::new_empty("Test Project");

        let mut sequence = Sequence::new("Sequence 1", SequenceFormat::youtube_1080());
        let mut caption_track = Track::new_caption("Captions");

        let mut caption_clip = Clip::new("caption");
        caption_clip.label = Some("Old".to_string());
        caption_clip.place = ClipPlace {
            timeline_in_sec: 1.0,
            duration_sec: 2.0,
        };
        caption_clip.range = ClipRange {
            source_in_sec: 0.0,
            source_out_sec: 2.0,
        };

        let caption_id = caption_clip.id.clone();
        caption_track.add_clip(caption_clip);

        let track_id = caption_track.id.clone();
        sequence.add_track(caption_track);

        let seq_id = sequence.id.clone();
        state.active_sequence_id = Some(seq_id.clone());
        state.sequences.insert(seq_id.clone(), sequence);

        let op = Operation::with_id(
            "op_test",
            OpKind::CaptionUpdate,
            serde_json::json!({
                "sequenceId": seq_id,
                "trackId": track_id,
                "captionId": caption_id,
                "text": "New",
                "startSec": 3.0,
                "endSec": 5.5,
            }),
        );

        state.apply_operation(&op).unwrap();

        let sequence = state.get_active_sequence().unwrap();
        let track = sequence.tracks.iter().find(|t| t.id == track_id).unwrap();
        let clip = track.get_clip(&caption_id).unwrap();

        assert_eq!(clip.label.as_deref(), Some("New"));
        assert_eq!(clip.place.timeline_in_sec, 3.0);
        assert!((clip.place.duration_sec - 2.5).abs() < f64::EPSILON);
    }

    // -------------------------------------------------------------------------
    // Cross-Track Move Safety Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_cross_track_move_preserves_clip_on_invalid_destination() {
        let mut state = ProjectState::new("Test Project");

        // Create sequence with one track and one clip
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

        // Attempt to move clip to nonexistent track
        let result = state.apply_operation(&Operation::new(
            OpKind::ClipMove,
            serde_json::json!({
                "sequenceId": seq_id,
                "clipId": clip_id,
                "trackId": "nonexistent_track",
                "timelineIn": 5.0
            }),
        ));

        // Move should fail
        assert!(result.is_err());

        // Clip should still exist in original track at original position
        let (_, _, found_clip) = state.find_clip(&clip_id).unwrap();
        assert_eq!(found_clip.place.timeline_in_sec, 0.0);
    }

    #[test]
    fn test_cross_track_move_success() {
        let mut state = ProjectState::new("Test Project");

        // Create sequence with two tracks
        let sequence = Sequence::new("Main", SequenceFormat::youtube_1080());
        let seq_id = sequence.id.clone();
        state
            .apply_operation(&Operation::new(
                OpKind::SequenceCreate,
                serde_json::to_value(&sequence).unwrap(),
            ))
            .unwrap();

        let track1 = Track::new("Video 1", TrackKind::Video);
        let track1_id = track1.id.clone();
        state
            .apply_operation(&Operation::new(
                OpKind::TrackAdd,
                serde_json::json!({
                    "sequenceId": seq_id,
                    "track": track1
                }),
            ))
            .unwrap();

        let track2 = Track::new("Video 2", TrackKind::Video);
        let track2_id = track2.id.clone();
        state
            .apply_operation(&Operation::new(
                OpKind::TrackAdd,
                serde_json::json!({
                    "sequenceId": seq_id,
                    "track": track2
                }),
            ))
            .unwrap();

        // Add clip to track1
        let clip = Clip::new("asset_001")
            .with_source_range(0.0, 10.0)
            .place_at(0.0);
        let clip_id = clip.id.clone();
        state
            .apply_operation(&Operation::new(
                OpKind::ClipAdd,
                serde_json::json!({
                    "sequenceId": seq_id,
                    "trackId": track1_id,
                    "clip": clip
                }),
            ))
            .unwrap();

        // Move clip to track2
        state
            .apply_operation(&Operation::new(
                OpKind::ClipMove,
                serde_json::json!({
                    "sequenceId": seq_id,
                    "clipId": clip_id,
                    "trackId": track2_id,
                    "timelineIn": 5.0
                }),
            ))
            .unwrap();

        // Verify clip is now in track2 at new position
        let sequence = state.get_sequence(&seq_id).unwrap();
        let track1 = sequence.get_track(&track1_id).unwrap();
        let track2 = sequence.get_track(&track2_id).unwrap();

        assert!(track1.get_clip(&clip_id).is_none());
        let moved_clip = track2.get_clip(&clip_id).unwrap();
        assert_eq!(moved_clip.place.timeline_in_sec, 5.0);
    }

    #[test]
    fn test_clip_move_to_nonexistent_sequence_fails() {
        let mut state = ProjectState::new("Test Project");

        // Try to move clip in nonexistent sequence
        let result = state.apply_operation(&Operation::new(
            OpKind::ClipMove,
            serde_json::json!({
                "sequenceId": "nonexistent_seq",
                "clipId": "some_clip",
                "timelineIn": 5.0
            }),
        ));

        assert!(result.is_err());
    }

    #[test]
    fn test_clip_move_nonexistent_clip_fails() {
        let mut state = ProjectState::new("Test Project");

        let sequence = Sequence::new("Main", SequenceFormat::youtube_1080());
        let seq_id = sequence.id.clone();
        state
            .apply_operation(&Operation::new(
                OpKind::SequenceCreate,
                serde_json::to_value(&sequence).unwrap(),
            ))
            .unwrap();

        // Try to move nonexistent clip
        let result = state.apply_operation(&Operation::new(
            OpKind::ClipMove,
            serde_json::json!({
                "sequenceId": seq_id,
                "clipId": "nonexistent_clip",
                "timelineIn": 5.0
            }),
        ));

        assert!(result.is_err());
    }
}
