//! Render Cache System
//!
//! Pre-renders timeline segments to cache files for smooth playback.
//! Supports cache invalidation when clips or effects change, and smart
//! rendering that copies cached segments instead of re-encoding.
//!
//! # Architecture
//!
//! The timeline is split into fixed-duration segments (default 5 seconds).
//! Each segment has a fingerprint computed from the clips, effects, and track
//! state within that time range. When a segment fingerprint changes, it is
//! marked as stale and must be re-rendered.

use std::collections::HashMap;
use std::fmt;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::core::effects::Effect;
use crate::core::timeline::{Clip, Sequence, Track};
use crate::core::types::SequenceId;

// =============================================================================
// Constants
// =============================================================================

/// Default segment duration in seconds for cache splitting
const DEFAULT_SEGMENT_DURATION_SEC: f64 = 5.0;

/// Minimum segment duration (avoids tiny fragments at timeline end)
const MIN_SEGMENT_DURATION_SEC: f64 = 0.5;

/// Cache manifest file name within the cache directory
const CACHE_MANIFEST_FILENAME: &str = "manifest.json";

// =============================================================================
// Cache Segment State
// =============================================================================

/// State of a single cache segment
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum CacheSegmentState {
    /// Not yet rendered
    #[default]
    Empty,
    /// Previously cached but invalidated by an edit
    Stale,
    /// Currently being rendered
    Rendering,
    /// Fully rendered and valid
    Cached,
    /// Rendering failed
    Error,
}

impl fmt::Display for CacheSegmentState {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Empty => write!(f, "empty"),
            Self::Stale => write!(f, "stale"),
            Self::Rendering => write!(f, "rendering"),
            Self::Cached => write!(f, "cached"),
            Self::Error => write!(f, "error"),
        }
    }
}

// =============================================================================
// Fingerprinting
// =============================================================================

/// A deterministic fingerprint of timeline content within a time range.
/// Changes when any render-affecting property of clips, effects, or tracks changes.
pub type SegmentFingerprint = u64;

/// Computes a deterministic fingerprint for a clip's render-affecting properties.
/// UI-only properties (label, color) are excluded.
fn fingerprint_clip(clip: &Clip, hasher: &mut impl Hasher) {
    clip.id.hash(hasher);
    clip.asset_id.hash(hasher);

    // Source range
    hash_f64(clip.range.source_in_sec, hasher);
    hash_f64(clip.range.source_out_sec, hasher);

    // Timeline placement
    hash_f64(clip.place.timeline_in_sec, hasher);
    hash_f64(clip.place.duration_sec, hasher);

    // Transform (all f64 fields)
    hash_f64(clip.transform.position.x, hasher);
    hash_f64(clip.transform.position.y, hasher);
    hash_f64(clip.transform.scale.x, hasher);
    hash_f64(clip.transform.scale.y, hasher);
    hash_f64(clip.transform.rotation_deg, hasher);
    hash_f64(clip.transform.anchor.x, hasher);
    hash_f64(clip.transform.anchor.y, hasher);

    // Visual properties
    hash_f64(f64::from(clip.opacity), hasher);
    format!("{:?}", clip.blend_mode).hash(hasher);
    hash_f64(f64::from(clip.speed), hasher);
    clip.reverse.hash(hasher);
    clip.freeze_frame.hash(hasher);
    clip.enabled.hash(hasher);

    // Time remap
    if let Some(ref remap) = clip.time_remap {
        match serde_json::to_string(remap) {
            Ok(json) => json.hash(hasher),
            Err(e) => {
                tracing::warn!("Failed to serialize time_remap for fingerprint: {e}");
                "time_remap_serialize_error".hash(hasher);
            }
        }
    }

    // Effects list (order matters)
    for effect_id in &clip.effects {
        effect_id.hash(hasher);
    }

    // Audio properties affecting render
    hash_f64(f64::from(clip.audio.volume_db), hasher);
    hash_f64(f64::from(clip.audio.pan), hasher);
    clip.audio.muted.hash(hasher);
    hash_f64(clip.audio.fade_in_sec, hasher);
    hash_f64(clip.audio.fade_out_sec, hasher);
    format!("{:?}", clip.audio.fade_in_type).hash(hasher);
    format!("{:?}", clip.audio.fade_out_type).hash(hasher);

    // Audio keyframes
    match serde_json::to_string(&clip.audio.volume_keyframes) {
        Ok(json) => json.hash(hasher),
        Err(e) => {
            tracing::warn!("Failed to serialize volume_keyframes for fingerprint: {e}");
            "volume_kf_serialize_error".hash(hasher);
        }
    }

    // Caption style & position affect rendered subtitle appearance
    if let Some(ref style) = clip.caption_style {
        format!("{}", style).hash(hasher);
    }
    if let Some(ref position) = clip.caption_position {
        format!("{}", position).hash(hasher);
    }

    // Adjustment layer / compound
    clip.is_adjustment_layer.hash(hasher);
    clip.compound_sequence_id.hash(hasher);
}

/// Computes a fingerprint for an effect's render-affecting properties.
fn fingerprint_effect(effect: &Effect, hasher: &mut impl Hasher) {
    effect.id.hash(hasher);
    format!("{:?}", effect.effect_type).hash(hasher);
    effect.enabled.hash(hasher);
    effect.order.hash(hasher);

    // Params (sorted keys for determinism)
    let mut param_keys: Vec<&String> = effect.params.keys().collect();
    param_keys.sort();
    for key in param_keys {
        key.hash(hasher);
        match serde_json::to_string(&effect.params[key]) {
            Ok(json) => json.hash(hasher),
            Err(e) => {
                tracing::warn!("Failed to serialize effect param '{key}' for fingerprint: {e}");
                "param_serialize_error".hash(hasher);
            }
        }
    }

    // Keyframes (sorted keys for determinism)
    let mut kf_keys: Vec<&String> = effect.keyframes.keys().collect();
    kf_keys.sort();
    for key in kf_keys {
        key.hash(hasher);
        match serde_json::to_string(&effect.keyframes[key]) {
            Ok(json) => json.hash(hasher),
            Err(e) => {
                tracing::warn!("Failed to serialize effect keyframe '{key}' for fingerprint: {e}");
                "keyframe_serialize_error".hash(hasher);
            }
        }
    }

    // Masks
    match serde_json::to_string(&effect.masks) {
        Ok(json) => json.hash(hasher),
        Err(e) => {
            tracing::warn!("Failed to serialize effect masks for fingerprint: {e}");
            "masks_serialize_error".hash(hasher);
        }
    }
}

/// Computes a fingerprint for a track's render-affecting properties.
fn fingerprint_track_meta(track: &Track, hasher: &mut impl Hasher) {
    track.id.hash(hasher);
    format!("{:?}", track.kind).hash(hasher);
    format!("{:?}", track.blend_mode).hash(hasher);
    track.muted.hash(hasher);
    track.visible.hash(hasher);
    hash_f64(f64::from(track.volume), hasher);
}

/// Helper: hash an f64 by converting to bits (avoids NaN issues).
fn hash_f64(value: f64, hasher: &mut impl Hasher) {
    let bits = if value.is_nan() {
        0u64
    } else {
        value.to_bits()
    };
    bits.hash(hasher);
}

/// Collects clips from a track that overlap a given time range [start, end).
fn clips_in_range(track: &Track, start_sec: f64, end_sec: f64) -> Vec<&Clip> {
    track
        .clips
        .iter()
        .filter(|c| {
            c.enabled && c.place.timeline_in_sec < end_sec && c.place.timeline_out_sec() > start_sec
        })
        .collect()
}

/// Computes the fingerprint for a timeline segment [start_sec, end_sec).
/// Includes all clips/tracks/effects that overlap the segment.
pub fn compute_segment_fingerprint(
    sequence: &Sequence,
    effects: &HashMap<String, Effect>,
    start_sec: f64,
    end_sec: f64,
) -> SegmentFingerprint {
    use std::collections::hash_map::DefaultHasher;

    let mut hasher = DefaultHasher::new();

    // Sequence-level properties
    sequence.id.hash(&mut hasher);
    hash_f64(sequence.format.fps.as_f64(), &mut hasher);
    sequence.format.canvas.width.hash(&mut hasher);
    sequence.format.canvas.height.hash(&mut hasher);
    sequence.format.audio_sample_rate.hash(&mut hasher);
    sequence.format.audio_channels.hash(&mut hasher);
    hash_f64(f64::from(sequence.master_volume_db), &mut hasher);

    // Segment time range
    hash_f64(start_sec, &mut hasher);
    hash_f64(end_sec, &mut hasher);

    // Process each track (order matters — compositing order)
    for track in &sequence.tracks {
        fingerprint_track_meta(track, &mut hasher);

        let overlapping = clips_in_range(track, start_sec, end_sec);
        overlapping.len().hash(&mut hasher);

        for clip in overlapping {
            fingerprint_clip(clip, &mut hasher);

            // Include actual effect data (not just IDs)
            for effect_id in &clip.effects {
                if let Some(effect) = effects.get(effect_id) {
                    fingerprint_effect(effect, &mut hasher);
                }
            }
        }
    }

    hasher.finish()
}

// =============================================================================
// Cache Segment
// =============================================================================

/// A single cached timeline segment
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RenderCacheSegment {
    /// Segment index (0-based)
    pub index: u32,
    /// Start time in seconds
    pub start_sec: f64,
    /// End time in seconds
    pub end_sec: f64,
    /// Current segment state
    pub state: CacheSegmentState,
    /// Fingerprint of timeline content when last cached
    pub fingerprint: u64,
    /// Relative path to cached file (within cache directory)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cached_file: Option<String>,
    /// File size in bytes (when cached)
    pub file_size_bytes: u64,
}

impl RenderCacheSegment {
    /// Creates a new empty segment
    pub fn new(index: u32, start_sec: f64, end_sec: f64, fingerprint: u64) -> Self {
        Self {
            index,
            start_sec,
            end_sec,
            state: CacheSegmentState::Empty,
            fingerprint,
            cached_file: None,
            file_size_bytes: 0,
        }
    }

    /// Duration of this segment in seconds
    pub fn duration_sec(&self) -> f64 {
        self.end_sec - self.start_sec
    }

    /// Whether this segment needs rendering (not cached or stale)
    pub fn needs_render(&self) -> bool {
        matches!(
            self.state,
            CacheSegmentState::Empty | CacheSegmentState::Stale | CacheSegmentState::Error
        )
    }

    /// Whether this segment is valid for smart rendering copy
    pub fn is_valid_cache(&self) -> bool {
        self.state == CacheSegmentState::Cached && self.cached_file.is_some()
    }
}

// =============================================================================
// Cache Manifest
// =============================================================================

/// Render cache manifest for an entire sequence
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RenderCacheManifest {
    /// Sequence this cache belongs to
    pub sequence_id: SequenceId,
    /// Segment duration used for splitting
    pub segment_duration_sec: f64,
    /// All cache segments
    pub segments: Vec<RenderCacheSegment>,
    /// Total cached size in bytes
    pub total_cached_bytes: u64,
    /// Timestamp of last update (ISO 8601)
    pub updated_at: String,
}

/// Outcome of reconciling a manifest with the current sequence state.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ManifestSyncResult {
    /// Whether the manifest contents changed and should be persisted.
    pub changed: bool,
    /// Cache files no longer referenced by the manifest.
    pub orphaned_files: Vec<String>,
}

impl RenderCacheManifest {
    /// Creates a new manifest with segments covering the given duration
    pub fn new(
        sequence_id: &str,
        duration_sec: f64,
        segment_duration_sec: f64,
        sequence: &Sequence,
        effects: &HashMap<String, Effect>,
    ) -> Self {
        let seg_dur = segment_duration_sec.max(MIN_SEGMENT_DURATION_SEC);
        let segments = generate_segments(sequence, effects, duration_sec, seg_dur);

        Self {
            sequence_id: sequence_id.to_string(),
            segment_duration_sec: seg_dur,
            segments,
            total_cached_bytes: 0,
            updated_at: chrono::Utc::now().to_rfc3339(),
        }
    }

    /// Number of segments that are fully cached
    pub fn cached_count(&self) -> usize {
        self.segments
            .iter()
            .filter(|s| s.state == CacheSegmentState::Cached)
            .count()
    }

    /// Number of segments that need rendering
    pub fn pending_count(&self) -> usize {
        self.segments.iter().filter(|s| s.needs_render()).count()
    }

    /// Cache completeness as a percentage (0.0 - 100.0)
    pub fn completion_percent(&self) -> f64 {
        if self.segments.is_empty() {
            return 0.0;
        }
        (self.cached_count() as f64 / self.segments.len() as f64) * 100.0
    }

    /// Updates fingerprints and marks stale segments.
    /// Returns the number of segments that became stale.
    pub fn refresh_fingerprints(
        &mut self,
        sequence: &Sequence,
        effects: &HashMap<String, Effect>,
    ) -> usize {
        let mut stale_count = 0;

        for segment in &mut self.segments {
            let new_fp =
                compute_segment_fingerprint(sequence, effects, segment.start_sec, segment.end_sec);

            if new_fp != segment.fingerprint {
                if segment.state == CacheSegmentState::Cached {
                    segment.state = CacheSegmentState::Stale;
                    stale_count += 1;
                }
                segment.fingerprint = new_fp;
            }
        }

        if stale_count > 0 {
            self.updated_at = chrono::Utc::now().to_rfc3339();
        }

        stale_count
    }

    /// Reconciles segment layout and transient state with the current sequence.
    ///
    /// This keeps cache manifests valid across timeline-duration changes,
    /// segment-duration changes, and interrupted background renders.
    pub fn reconcile_with_sequence(
        &mut self,
        duration_sec: f64,
        segment_duration_sec: f64,
        sequence: &Sequence,
        effects: &HashMap<String, Effect>,
    ) -> ManifestSyncResult {
        let normalized_seg_dur = segment_duration_sec.max(MIN_SEGMENT_DURATION_SEC);
        let previous_segments = self.segments.clone();
        let previous_segment_duration = self.segment_duration_sec;
        let previous_total_cached_bytes = self.total_cached_bytes;
        let desired_segments =
            generate_segments(sequence, effects, duration_sec.max(0.0), normalized_seg_dur);

        let mut previous_by_range: HashMap<(u64, u64), RenderCacheSegment> = previous_segments
            .iter()
            .cloned()
            .map(|segment| {
                (
                    segment_range_key(segment.start_sec, segment.end_sec),
                    segment,
                )
            })
            .collect();
        let mut next_segments = Vec::with_capacity(desired_segments.len());
        let mut orphaned_files: Vec<String> = Vec::new();

        for mut segment in desired_segments {
            if let Some(previous) =
                previous_by_range.remove(&segment_range_key(segment.start_sec, segment.end_sec))
            {
                match previous.state {
                    CacheSegmentState::Cached => {
                        if previous.fingerprint == segment.fingerprint {
                            if let Some(cached_file) = previous.cached_file {
                                segment.state = CacheSegmentState::Cached;
                                segment.cached_file = Some(cached_file);
                                segment.file_size_bytes = previous.file_size_bytes;
                            }
                        } else if previous.cached_file.is_some() {
                            segment.state = CacheSegmentState::Stale;
                            segment.cached_file = previous.cached_file;
                            segment.file_size_bytes = previous.file_size_bytes;
                        }
                    }
                    CacheSegmentState::Stale => {
                        segment.state = CacheSegmentState::Stale;
                        segment.cached_file = previous.cached_file;
                        segment.file_size_bytes = previous.file_size_bytes;
                    }
                    CacheSegmentState::Rendering => {
                        segment.state = CacheSegmentState::Error;
                        if let Some(cached_file) = previous.cached_file {
                            orphaned_files.push(cached_file);
                        }
                    }
                    CacheSegmentState::Error => {
                        segment.state = CacheSegmentState::Error;
                        if let Some(cached_file) = previous.cached_file {
                            orphaned_files.push(cached_file);
                        }
                    }
                    CacheSegmentState::Empty => {}
                }
            }

            next_segments.push(segment);
        }

        for remaining in previous_by_range.into_values() {
            if let Some(cached_file) = remaining.cached_file {
                orphaned_files.push(cached_file);
            }
        }

        orphaned_files.sort();
        orphaned_files.dedup();

        self.segment_duration_sec = normalized_seg_dur;
        self.segments = next_segments;
        self.recalculate_total_size();

        let changed = previous_segment_duration.to_bits() != normalized_seg_dur.to_bits()
            || previous_total_cached_bytes != self.total_cached_bytes
            || previous_segments != self.segments
            || !orphaned_files.is_empty();

        if changed {
            self.updated_at = chrono::Utc::now().to_rfc3339();
        }

        ManifestSyncResult {
            changed,
            orphaned_files,
        }
    }

    /// Marks a segment as cached after successful rendering
    pub fn mark_segment_cached(
        &mut self,
        index: u32,
        cached_file: String,
        file_size_bytes: u64,
    ) -> bool {
        if let Some(segment) = self.segments.iter_mut().find(|s| s.index == index) {
            segment.state = CacheSegmentState::Cached;
            segment.cached_file = Some(cached_file);
            segment.file_size_bytes = file_size_bytes;
            self.recalculate_total_size();
            self.updated_at = chrono::Utc::now().to_rfc3339();
            true
        } else {
            false
        }
    }

    /// Clears all cached data (marks all segments as empty)
    pub fn clear(&mut self) {
        for segment in &mut self.segments {
            segment.state = CacheSegmentState::Empty;
            segment.cached_file = None;
            segment.file_size_bytes = 0;
        }
        self.total_cached_bytes = 0;
        self.updated_at = chrono::Utc::now().to_rfc3339();
    }

    /// Recalculates total cached size from segments
    fn recalculate_total_size(&mut self) {
        self.total_cached_bytes = self
            .segments
            .iter()
            .filter(|s| s.state == CacheSegmentState::Cached)
            .map(|s| s.file_size_bytes)
            .sum();
    }
}

/// Generates cache segments for the given timeline duration
fn generate_segments(
    sequence: &Sequence,
    effects: &HashMap<String, Effect>,
    duration_sec: f64,
    segment_duration_sec: f64,
) -> Vec<RenderCacheSegment> {
    if duration_sec <= 0.0 {
        return Vec::new();
    }

    let count = (duration_sec / segment_duration_sec).ceil() as u32;
    let mut segments = Vec::with_capacity(count as usize);

    for i in 0..count {
        let start = i as f64 * segment_duration_sec;
        let end = (start + segment_duration_sec).min(duration_sec);

        // Skip tiny trailing segments
        if end - start < MIN_SEGMENT_DURATION_SEC && i > 0 {
            // Extend the previous segment instead
            if let Some(prev) = segments.last_mut() {
                let prev_seg: &mut RenderCacheSegment = prev;
                let new_fp =
                    compute_segment_fingerprint(sequence, effects, prev_seg.start_sec, end);
                prev_seg.end_sec = end;
                prev_seg.fingerprint = new_fp;
            }
            break;
        }

        let fp = compute_segment_fingerprint(sequence, effects, start, end);
        segments.push(RenderCacheSegment::new(i, start, end, fp));
    }

    segments
}

fn segment_range_key(start_sec: f64, end_sec: f64) -> (u64, u64) {
    (start_sec.to_bits(), end_sec.to_bits())
}

// =============================================================================
// Cache Configuration
// =============================================================================

/// Configuration for the render cache system
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderCacheConfig {
    /// Maximum cache size in bytes
    pub max_cache_bytes: u64,
    /// Segment duration in seconds
    pub segment_duration_sec: f64,
    /// Whether render cache is enabled
    pub enabled: bool,
    /// Whether smart rendering is enabled for export
    pub smart_render_enabled: bool,
}

impl Default for RenderCacheConfig {
    fn default() -> Self {
        Self {
            max_cache_bytes: 1024 * 1024 * 1024, // 1 GB
            segment_duration_sec: DEFAULT_SEGMENT_DURATION_SEC,
            enabled: true,
            smart_render_enabled: true,
        }
    }
}

impl RenderCacheConfig {
    /// Creates config from performance settings cache_size_mb
    pub fn from_cache_size_mb(cache_size_mb: u32) -> Self {
        Self {
            max_cache_bytes: cache_size_mb as u64 * 1024 * 1024,
            ..Default::default()
        }
    }
}

// =============================================================================
// Cache Status DTO (for IPC)
// =============================================================================

/// Cache status information returned to the frontend
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RenderCacheStatus {
    /// Whether render cache is enabled
    pub enabled: bool,
    /// Sequence ID this status is for
    pub sequence_id: SequenceId,
    /// Total number of segments
    pub total_segments: u32,
    /// Number of fully cached segments
    pub cached_segments: u32,
    /// Number of stale segments needing re-render
    pub stale_segments: u32,
    /// Number of segments currently rendering
    pub rendering_segments: u32,
    /// Completion percentage (0.0 - 100.0)
    pub completion_percent: f64,
    /// Total cached file size in bytes
    pub total_cached_bytes: u64,
    /// Maximum allowed cache size in bytes
    pub max_cache_bytes: u64,
    /// Per-segment status for timeline indicator
    pub segment_states: Vec<CacheSegmentStatusDto>,
}

/// Minimal per-segment info for the timeline cache indicator bar
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CacheSegmentStatusDto {
    /// Start time in seconds
    pub start_sec: f64,
    /// End time in seconds
    pub end_sec: f64,
    /// Segment state
    pub state: CacheSegmentState,
}

impl RenderCacheStatus {
    /// Builds a status DTO from a manifest and config
    pub fn from_manifest(manifest: &RenderCacheManifest, config: &RenderCacheConfig) -> Self {
        let total = manifest.segments.len() as u32;
        let cached = manifest
            .segments
            .iter()
            .filter(|s| s.state == CacheSegmentState::Cached)
            .count() as u32;
        let stale = manifest
            .segments
            .iter()
            .filter(|s| s.state == CacheSegmentState::Stale)
            .count() as u32;
        let rendering = manifest
            .segments
            .iter()
            .filter(|s| s.state == CacheSegmentState::Rendering)
            .count() as u32;

        let segment_states = manifest
            .segments
            .iter()
            .map(|s| CacheSegmentStatusDto {
                start_sec: s.start_sec,
                end_sec: s.end_sec,
                state: s.state.clone(),
            })
            .collect();

        Self {
            enabled: config.enabled,
            sequence_id: manifest.sequence_id.clone(),
            total_segments: total,
            cached_segments: cached,
            stale_segments: stale,
            rendering_segments: rendering,
            completion_percent: manifest.completion_percent(),
            total_cached_bytes: manifest.total_cached_bytes,
            max_cache_bytes: config.max_cache_bytes,
            segment_states,
        }
    }

    /// Creates an empty status when no manifest exists
    pub fn empty(sequence_id: &str, config: &RenderCacheConfig) -> Self {
        Self {
            enabled: config.enabled,
            sequence_id: sequence_id.to_string(),
            total_segments: 0,
            cached_segments: 0,
            stale_segments: 0,
            rendering_segments: 0,
            completion_percent: 0.0,
            total_cached_bytes: 0,
            max_cache_bytes: config.max_cache_bytes,
            segment_states: Vec::new(),
        }
    }
}

// =============================================================================
// Cache Directory Helpers
// =============================================================================

/// Returns the render cache directory for a project
pub fn render_cache_dir(project_dir: &Path) -> PathBuf {
    project_dir
        .join(".openreelio")
        .join("cache")
        .join("renders")
}

/// Returns the cache directory for a specific sequence
pub fn sequence_cache_dir(project_dir: &Path, sequence_id: &str) -> PathBuf {
    render_cache_dir(project_dir).join(sequence_id)
}

/// Returns the manifest file path for a sequence
pub fn manifest_path(project_dir: &Path, sequence_id: &str) -> PathBuf {
    sequence_cache_dir(project_dir, sequence_id).join(CACHE_MANIFEST_FILENAME)
}

/// Returns the cache file path for a segment
pub fn segment_cache_file(project_dir: &Path, sequence_id: &str, index: u32) -> PathBuf {
    sequence_cache_dir(project_dir, sequence_id).join(format!("segment_{index:04}.mp4"))
}

// =============================================================================
// Manifest Persistence
// =============================================================================

/// Saves a cache manifest to disk (JSON)
pub fn save_manifest(project_dir: &Path, manifest: &RenderCacheManifest) -> std::io::Result<()> {
    let dir = sequence_cache_dir(project_dir, &manifest.sequence_id);
    std::fs::create_dir_all(&dir)?;

    let path = dir.join(CACHE_MANIFEST_FILENAME);
    let json = serde_json::to_string_pretty(manifest)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;

    // Atomic write: write to temp then rename
    let tmp_path = path.with_extension("json.tmp");
    std::fs::write(&tmp_path, json)?;
    std::fs::rename(&tmp_path, &path)?;

    Ok(())
}

/// Loads a cache manifest from disk. Returns None if not found.
pub fn load_manifest(
    project_dir: &Path,
    sequence_id: &str,
) -> std::io::Result<Option<RenderCacheManifest>> {
    let path = manifest_path(project_dir, sequence_id);
    if !path.exists() {
        return Ok(None);
    }

    let json = std::fs::read_to_string(&path)?;
    let manifest: RenderCacheManifest = serde_json::from_str(&json)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;

    Ok(Some(manifest))
}

// =============================================================================
// Cache Cleanup
// =============================================================================

/// Removes all stale cache files for a manifest.
/// Returns the total bytes freed.
pub fn cleanup_stale_files(project_dir: &Path, manifest: &mut RenderCacheManifest) -> u64 {
    let mut freed = 0u64;
    let seq_dir = sequence_cache_dir(project_dir, &manifest.sequence_id);

    for segment in &mut manifest.segments {
        if segment.state == CacheSegmentState::Stale {
            if let Some(ref file) = segment.cached_file {
                let full_path = seq_dir.join(file);
                if full_path.exists() {
                    match std::fs::remove_file(&full_path) {
                        Ok(()) => {
                            freed += segment.file_size_bytes;
                            segment.cached_file = None;
                            segment.file_size_bytes = 0;
                            segment.state = CacheSegmentState::Empty;
                        }
                        Err(e) => {
                            tracing::warn!(
                                "Failed to remove stale cache file {}: {e}",
                                full_path.display()
                            );
                            // Leave segment untouched so size tracking stays accurate
                        }
                    }
                } else {
                    // File already gone — reset segment
                    segment.cached_file = None;
                    segment.file_size_bytes = 0;
                    segment.state = CacheSegmentState::Empty;
                }
            } else {
                segment.state = CacheSegmentState::Empty;
            }
        }
    }

    if freed > 0 {
        manifest.recalculate_total_size();
        manifest.updated_at = chrono::Utc::now().to_rfc3339();
    }

    freed
}

/// Removes the entire cache directory for a sequence.
pub fn clear_sequence_cache(project_dir: &Path, sequence_id: &str) -> std::io::Result<()> {
    let dir = sequence_cache_dir(project_dir, sequence_id);
    if dir.exists() {
        std::fs::remove_dir_all(&dir)?;
    }
    Ok(())
}

/// Enforces cache size limit by evicting the oldest cached segments (LRU by index).
/// Returns the number of segments evicted.
pub fn enforce_cache_limit(
    project_dir: &Path,
    manifest: &mut RenderCacheManifest,
    max_bytes: u64,
) -> usize {
    if manifest.total_cached_bytes <= max_bytes {
        return 0;
    }

    let seq_dir = sequence_cache_dir(project_dir, &manifest.sequence_id);
    let mut evicted = 0;

    // Evict from the end (highest index) first — user is more likely to play from the start
    let indices: Vec<u32> = manifest
        .segments
        .iter()
        .filter(|s| s.state == CacheSegmentState::Cached)
        .map(|s| s.index)
        .rev()
        .collect();

    for idx in indices {
        if manifest.total_cached_bytes <= max_bytes {
            break;
        }

        if let Some(segment) = manifest.segments.iter_mut().find(|s| s.index == idx) {
            let mut file_removed = false;
            if let Some(ref file) = segment.cached_file {
                let full_path = seq_dir.join(file);
                match std::fs::remove_file(&full_path) {
                    Ok(()) => file_removed = true,
                    Err(e) => {
                        tracing::warn!(
                            "Failed to evict cache file {}: {e}",
                            full_path.display()
                        );
                    }
                }
            } else {
                file_removed = true; // No file to remove
            }

            if file_removed {
                // Subtract this segment's size from the running total instead of
                // recalculating across all segments (avoids O(n*m) cost).
                manifest.total_cached_bytes =
                    manifest.total_cached_bytes.saturating_sub(segment.file_size_bytes);
                segment.state = CacheSegmentState::Empty;
                segment.cached_file = None;
                segment.file_size_bytes = 0;
                evicted += 1;
            }
        }
    }

    if evicted > 0 {
        manifest.updated_at = chrono::Utc::now().to_rfc3339();
    }

    evicted
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::effects::{EffectType, ParamValue};
    use crate::core::timeline::{
        AudioSettings, BlendMode, Canvas, ClipPlace, ClipRange, SequenceFormat, Track, TrackKind,
        Transform,
    };
    use crate::core::types::Ratio;

    // -----------------------------------------------------------------------
    // Test Helpers
    // -----------------------------------------------------------------------

    fn make_test_clip(id: &str, asset_id: &str, start: f64, duration: f64) -> Clip {
        Clip {
            id: id.to_string(),
            asset_id: asset_id.to_string(),
            range: ClipRange {
                source_in_sec: 0.0,
                source_out_sec: duration,
            },
            place: ClipPlace {
                timeline_in_sec: start,
                duration_sec: duration,
            },
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
            group_id: None,
            compound_sequence_id: None,
            is_adjustment_layer: false,
        }
    }

    fn make_test_track(id: &str, kind: TrackKind, clips: Vec<Clip>) -> Track {
        Track {
            id: id.to_string(),
            kind,
            name: format!("Track {id}"),
            clips,
            blend_mode: BlendMode::Normal,
            is_base_track: None,
            muted: false,
            locked: false,
            visible: true,
            sync_lock: false,
            volume: 1.0,
        }
    }

    fn make_test_sequence(id: &str, tracks: Vec<Track>) -> Sequence {
        Sequence {
            id: id.to_string(),
            name: format!("Seq {id}"),
            format: SequenceFormat {
                canvas: Canvas {
                    width: 1920,
                    height: 1080,
                },
                fps: Ratio::new(30, 1),
                audio_sample_rate: 48000,
                audio_channels: 2,
            },
            tracks,
            markers: vec![],
            master_volume_db: 0.0,
            created_at: "2026-01-01T00:00:00Z".to_string(),
            modified_at: "2026-01-01T00:00:00Z".to_string(),
        }
    }

    fn make_test_effect(id: &str, effect_type: EffectType) -> Effect {
        let mut effect = Effect::new(effect_type);
        effect.id = id.to_string();
        effect
    }

    // -----------------------------------------------------------------------
    // BDD Tests
    // -----------------------------------------------------------------------

    #[test]
    fn should_create_correct_number_of_segments_for_30_second_timeline() {
        // Given a sequence with a 30-second timeline
        let clip = make_test_clip("c1", "a1", 0.0, 30.0);
        let track = make_test_track("t1", TrackKind::Video, vec![clip]);
        let seq = make_test_sequence("seq1", vec![track]);
        let effects = HashMap::new();

        // When creating a manifest with 5-second segments
        let manifest = RenderCacheManifest::new("seq1", 30.0, 5.0, &seq, &effects);

        // Then there should be 6 segments, each 5 seconds
        assert_eq!(manifest.segments.len(), 6);
        assert_eq!(manifest.segments[0].start_sec, 0.0);
        assert_eq!(manifest.segments[0].end_sec, 5.0);
        assert_eq!(manifest.segments[5].start_sec, 25.0);
        assert_eq!(manifest.segments[5].end_sec, 30.0);
    }

    #[test]
    fn should_merge_tiny_trailing_segment_into_previous() {
        // Given a 12.3-second timeline with 5-second segments
        let clip = make_test_clip("c1", "a1", 0.0, 12.3);
        let track = make_test_track("t1", TrackKind::Video, vec![clip]);
        let seq = make_test_sequence("seq1", vec![track]);
        let effects = HashMap::new();

        // When generating segments (12.3 / 5.0 = 2 full + 2.3 remainder)
        let manifest = RenderCacheManifest::new("seq1", 12.3, 5.0, &seq, &effects);

        // Then the last segment should cover the remainder (not a tiny fragment)
        assert_eq!(manifest.segments.len(), 3);
        assert_eq!(manifest.segments[2].start_sec, 10.0);
        assert!((manifest.segments[2].end_sec - 12.3).abs() < 0.001);
    }

    #[test]
    fn should_produce_zero_segments_for_empty_timeline() {
        // Given a sequence with zero duration
        let seq = make_test_sequence("seq1", vec![]);
        let effects = HashMap::new();

        // When creating a manifest
        let manifest = RenderCacheManifest::new("seq1", 0.0, 5.0, &seq, &effects);

        // Then there should be no segments
        assert!(manifest.segments.is_empty());
        assert_eq!(manifest.completion_percent(), 0.0);
    }

    #[test]
    fn should_produce_deterministic_fingerprint_for_same_state() {
        // Given the same sequence state
        let clip = make_test_clip("c1", "a1", 0.0, 10.0);
        let track = make_test_track("t1", TrackKind::Video, vec![clip]);
        let seq = make_test_sequence("seq1", vec![track]);
        let effects = HashMap::new();

        // When computing fingerprint twice
        let fp1 = compute_segment_fingerprint(&seq, &effects, 0.0, 5.0);
        let fp2 = compute_segment_fingerprint(&seq, &effects, 0.0, 5.0);

        // Then fingerprints should be identical
        assert_eq!(fp1, fp2);
    }

    #[test]
    fn should_change_fingerprint_when_clip_opacity_changes() {
        // Given a clip with opacity 1.0
        let clip = make_test_clip("c1", "a1", 0.0, 10.0);
        let track = make_test_track("t1", TrackKind::Video, vec![clip]);
        let seq1 = make_test_sequence("seq1", vec![track]);
        let effects = HashMap::new();

        let fp1 = compute_segment_fingerprint(&seq1, &effects, 0.0, 5.0);

        // When opacity changes to 0.5
        let mut clip2 = make_test_clip("c1", "a1", 0.0, 10.0);
        clip2.opacity = 0.5;
        let track2 = make_test_track("t1", TrackKind::Video, vec![clip2]);
        let seq2 = make_test_sequence("seq1", vec![track2]);

        let fp2 = compute_segment_fingerprint(&seq2, &effects, 0.0, 5.0);

        // Then fingerprints should differ
        assert_ne!(fp1, fp2);
    }

    #[test]
    fn should_change_fingerprint_when_effect_params_change() {
        // Given a clip with a blur effect
        let mut clip = make_test_clip("c1", "a1", 0.0, 10.0);
        clip.effects = vec!["fx1".to_string()];
        let track = make_test_track("t1", TrackKind::Video, vec![clip]);
        let seq = make_test_sequence("seq1", vec![track]);

        let mut effect = make_test_effect("fx1", EffectType::GaussianBlur);
        effect
            .params
            .insert("radius".to_string(), ParamValue::Float(5.0));
        let mut effects1 = HashMap::new();
        effects1.insert("fx1".to_string(), effect.clone());

        let fp1 = compute_segment_fingerprint(&seq, &effects1, 0.0, 5.0);

        // When blur radius changes
        effect
            .params
            .insert("radius".to_string(), ParamValue::Float(10.0));
        let mut effects2 = HashMap::new();
        effects2.insert("fx1".to_string(), effect);

        let fp2 = compute_segment_fingerprint(&seq, &effects2, 0.0, 5.0);

        // Then fingerprints should differ
        assert_ne!(fp1, fp2);
    }

    #[test]
    fn should_not_change_fingerprint_when_ui_only_properties_change() {
        // Given a clip with a label
        let mut clip1 = make_test_clip("c1", "a1", 0.0, 10.0);
        clip1.label = Some("Take 1".to_string());
        let track1 = make_test_track("t1", TrackKind::Video, vec![clip1]);
        let seq1 = make_test_sequence("seq1", vec![track1]);
        let effects = HashMap::new();

        let fp1 = compute_segment_fingerprint(&seq1, &effects, 0.0, 5.0);

        // When label changes (UI-only property)
        let mut clip2 = make_test_clip("c1", "a1", 0.0, 10.0);
        clip2.label = Some("Take 2".to_string());
        let track2 = make_test_track("t1", TrackKind::Video, vec![clip2]);
        let seq2 = make_test_sequence("seq1", vec![track2]);

        let fp2 = compute_segment_fingerprint(&seq2, &effects, 0.0, 5.0);

        // Then fingerprints should be identical (label is UI-only)
        assert_eq!(fp1, fp2);
    }

    #[test]
    fn should_change_fingerprint_when_track_muted_state_changes() {
        // Given a non-muted track
        let clip = make_test_clip("c1", "a1", 0.0, 10.0);
        let track = make_test_track("t1", TrackKind::Video, vec![clip.clone()]);
        let seq1 = make_test_sequence("seq1", vec![track]);
        let effects = HashMap::new();

        let fp1 = compute_segment_fingerprint(&seq1, &effects, 0.0, 5.0);

        // When track is muted
        let mut track2 = make_test_track("t1", TrackKind::Video, vec![clip]);
        track2.muted = true;
        let seq2 = make_test_sequence("seq1", vec![track2]);

        let fp2 = compute_segment_fingerprint(&seq2, &effects, 0.0, 5.0);

        // Then fingerprints should differ
        assert_ne!(fp1, fp2);
    }

    #[test]
    fn should_mark_segments_stale_when_fingerprints_change() {
        // Given a manifest with one cached segment
        let clip = make_test_clip("c1", "a1", 0.0, 10.0);
        let track = make_test_track("t1", TrackKind::Video, vec![clip]);
        let seq = make_test_sequence("seq1", vec![track]);
        let effects = HashMap::new();

        let mut manifest = RenderCacheManifest::new("seq1", 10.0, 5.0, &seq, &effects);
        manifest.mark_segment_cached(0, "segment_0000.mp4".to_string(), 1024);
        assert_eq!(manifest.segments[0].state, CacheSegmentState::Cached);

        // When a clip in the first segment changes
        let mut clip2 = make_test_clip("c1", "a1", 0.0, 10.0);
        clip2.speed = 2.0; // Speed change
        let track2 = make_test_track("t1", TrackKind::Video, vec![clip2]);
        let seq2 = make_test_sequence("seq1", vec![track2]);

        let stale_count = manifest.refresh_fingerprints(&seq2, &effects);

        // Then segment 0 should be stale
        assert_eq!(stale_count, 1);
        assert_eq!(manifest.segments[0].state, CacheSegmentState::Stale);
    }

    #[test]
    fn should_reconcile_segments_when_timeline_duration_changes() {
        // Given a cached 10-second manifest
        let clip = make_test_clip("c1", "a1", 0.0, 10.0);
        let track = make_test_track("t1", TrackKind::Video, vec![clip]);
        let seq = make_test_sequence("seq1", vec![track]);
        let effects = HashMap::new();

        let mut manifest = RenderCacheManifest::new("seq1", 10.0, 5.0, &seq, &effects);
        manifest.mark_segment_cached(0, "segment_0000.mp4".to_string(), 1024);

        // When the timeline expands with a new trailing clip
        let clip2 = make_test_clip("c2", "a2", 10.0, 5.0);
        let track2 = make_test_track(
            "t1",
            TrackKind::Video,
            vec![make_test_clip("c1", "a1", 0.0, 10.0), clip2],
        );
        let seq2 = make_test_sequence("seq1", vec![track2]);

        let sync = manifest.reconcile_with_sequence(15.0, 5.0, &seq2, &effects);

        // Then existing cache is preserved and a new trailing segment is added
        assert!(sync.changed);
        assert!(sync.orphaned_files.is_empty());
        assert_eq!(manifest.segments.len(), 3);
        assert_eq!(manifest.segments[0].state, CacheSegmentState::Cached);
        assert_eq!(manifest.segments[2].state, CacheSegmentState::Empty);
    }

    #[test]
    fn should_reset_interrupted_rendering_segments_during_reconcile() {
        // Given a manifest persisted while a segment was rendering
        let clip = make_test_clip("c1", "a1", 0.0, 10.0);
        let track = make_test_track("t1", TrackKind::Video, vec![clip]);
        let seq = make_test_sequence("seq1", vec![track]);
        let effects = HashMap::new();

        let mut manifest = RenderCacheManifest::new("seq1", 10.0, 5.0, &seq, &effects);
        manifest.segments[0].state = CacheSegmentState::Rendering;
        manifest.segments[0].cached_file = Some("partial.mp4".to_string());
        manifest.segments[0].file_size_bytes = 128;

        // When reconciling the manifest with the current sequence
        let sync = manifest.reconcile_with_sequence(10.0, 5.0, &seq, &effects);

        // Then the interrupted segment becomes re-renderable and stale files are orphaned
        assert!(sync.changed);
        assert_eq!(sync.orphaned_files, vec!["partial.mp4".to_string()]);
        assert_eq!(manifest.segments[0].state, CacheSegmentState::Error);
        assert!(manifest.segments[0].needs_render());
        assert!(manifest.segments[0].cached_file.is_none());
    }

    #[test]
    fn should_report_correct_completion_percent() {
        // Given a manifest with 4 segments
        let clip = make_test_clip("c1", "a1", 0.0, 20.0);
        let track = make_test_track("t1", TrackKind::Video, vec![clip]);
        let seq = make_test_sequence("seq1", vec![track]);
        let effects = HashMap::new();

        let mut manifest = RenderCacheManifest::new("seq1", 20.0, 5.0, &seq, &effects);

        // When 2 out of 4 segments are cached
        manifest.mark_segment_cached(0, "s0.mp4".to_string(), 512);
        manifest.mark_segment_cached(1, "s1.mp4".to_string(), 512);

        // Then completion should be 50%
        assert!((manifest.completion_percent() - 50.0).abs() < 0.01);
        assert_eq!(manifest.cached_count(), 2);
        assert_eq!(manifest.pending_count(), 2);
    }

    #[test]
    fn should_clear_all_cached_segments() {
        // Given a manifest with cached segments
        let clip = make_test_clip("c1", "a1", 0.0, 10.0);
        let track = make_test_track("t1", TrackKind::Video, vec![clip]);
        let seq = make_test_sequence("seq1", vec![track]);
        let effects = HashMap::new();

        let mut manifest = RenderCacheManifest::new("seq1", 10.0, 5.0, &seq, &effects);
        manifest.mark_segment_cached(0, "s0.mp4".to_string(), 1024);
        manifest.mark_segment_cached(1, "s1.mp4".to_string(), 2048);
        assert_eq!(manifest.total_cached_bytes, 3072);

        // When clearing all cache
        manifest.clear();

        // Then all segments should be empty with zero size
        assert!(manifest
            .segments
            .iter()
            .all(|s| s.state == CacheSegmentState::Empty));
        assert!(manifest.segments.iter().all(|s| s.cached_file.is_none()));
        assert_eq!(manifest.total_cached_bytes, 0);
    }

    #[test]
    fn should_only_include_enabled_clips_in_fingerprint() {
        // Given a segment with one enabled and one disabled clip
        let clip1 = make_test_clip("c1", "a1", 0.0, 5.0);
        let mut clip2 = make_test_clip("c2", "a2", 2.0, 5.0);
        clip2.enabled = false;

        let track = make_test_track("t1", TrackKind::Video, vec![clip1.clone(), clip2]);
        let seq1 = make_test_sequence("seq1", vec![track]);
        let effects = HashMap::new();

        let fp1 = compute_segment_fingerprint(&seq1, &effects, 0.0, 5.0);

        // When the disabled clip is removed entirely
        let track2 = make_test_track("t1", TrackKind::Video, vec![clip1]);
        let seq2 = make_test_sequence("seq1", vec![track2]);

        let fp2 = compute_segment_fingerprint(&seq2, &effects, 0.0, 5.0);

        // Then fingerprints should be the same (disabled clips are excluded)
        assert_eq!(fp1, fp2);
    }

    #[test]
    fn should_build_correct_cache_directory_paths() {
        // Given a project directory
        let project_dir = Path::new("/projects/my_video");

        // When getting cache paths
        let cache_dir = render_cache_dir(project_dir);
        let seq_dir = sequence_cache_dir(project_dir, "seq-001");
        let manifest = manifest_path(project_dir, "seq-001");
        let seg_file = segment_cache_file(project_dir, "seq-001", 3);

        // Then paths should follow the convention
        assert_eq!(
            cache_dir,
            PathBuf::from("/projects/my_video/.openreelio/cache/renders")
        );
        assert_eq!(
            seq_dir,
            PathBuf::from("/projects/my_video/.openreelio/cache/renders/seq-001")
        );
        assert_eq!(
            manifest,
            PathBuf::from("/projects/my_video/.openreelio/cache/renders/seq-001/manifest.json")
        );
        assert_eq!(
            seg_file,
            PathBuf::from("/projects/my_video/.openreelio/cache/renders/seq-001/segment_0003.mp4")
        );
    }

    #[test]
    fn should_create_config_from_performance_settings() {
        // Given performance settings with 2GB cache
        let config = RenderCacheConfig::from_cache_size_mb(2048);

        // Then config should have correct max cache bytes
        assert_eq!(config.max_cache_bytes, 2048 * 1024 * 1024);
        assert!(config.enabled);
        assert!(config.smart_render_enabled);
        assert_eq!(config.segment_duration_sec, DEFAULT_SEGMENT_DURATION_SEC);
    }

    #[test]
    fn should_build_cache_status_dto_from_manifest() {
        // Given a manifest with mixed segment states
        let clip = make_test_clip("c1", "a1", 0.0, 15.0);
        let track = make_test_track("t1", TrackKind::Video, vec![clip]);
        let seq = make_test_sequence("seq1", vec![track]);
        let effects = HashMap::new();

        let mut manifest = RenderCacheManifest::new("seq1", 15.0, 5.0, &seq, &effects);
        manifest.mark_segment_cached(0, "s0.mp4".to_string(), 1000);
        manifest.segments[1].state = CacheSegmentState::Stale;

        let config = RenderCacheConfig::default();
        let status = RenderCacheStatus::from_manifest(&manifest, &config);

        // Then status should reflect the manifest
        assert_eq!(status.total_segments, 3);
        assert_eq!(status.cached_segments, 1);
        assert_eq!(status.stale_segments, 1);
        assert_eq!(status.sequence_id, "seq1");
        assert_eq!(status.segment_states.len(), 3);
        assert_eq!(status.segment_states[0].state, CacheSegmentState::Cached);
        assert_eq!(status.segment_states[1].state, CacheSegmentState::Stale);
        assert_eq!(status.segment_states[2].state, CacheSegmentState::Empty);
    }

    #[test]
    fn should_produce_different_fingerprints_for_different_time_ranges() {
        // Given a timeline with clips at different positions
        let clip1 = make_test_clip("c1", "a1", 0.0, 5.0);
        let clip2 = make_test_clip("c2", "a2", 5.0, 5.0);
        let track = make_test_track("t1", TrackKind::Video, vec![clip1, clip2]);
        let seq = make_test_sequence("seq1", vec![track]);
        let effects = HashMap::new();

        // When computing fingerprints for different ranges
        let fp_first = compute_segment_fingerprint(&seq, &effects, 0.0, 5.0);
        let fp_second = compute_segment_fingerprint(&seq, &effects, 5.0, 10.0);

        // Then fingerprints should differ (different clips in each range)
        assert_ne!(fp_first, fp_second);
    }

    // -----------------------------------------------------------------------
    // Cache Management Tests
    // -----------------------------------------------------------------------

    #[test]
    fn should_save_and_load_manifest_roundtrip() {
        // Given a manifest
        let clip = make_test_clip("c1", "a1", 0.0, 10.0);
        let track = make_test_track("t1", TrackKind::Video, vec![clip]);
        let seq = make_test_sequence("seq1", vec![track]);
        let effects = HashMap::new();

        let mut manifest = RenderCacheManifest::new("seq1", 10.0, 5.0, &seq, &effects);
        manifest.mark_segment_cached(0, "segment_0000.mp4".to_string(), 2048);

        // When saving and loading
        let tmp = tempfile::tempdir().unwrap();
        save_manifest(tmp.path(), &manifest).unwrap();
        let loaded = load_manifest(tmp.path(), "seq1").unwrap();

        // Then loaded manifest should match
        assert!(loaded.is_some());
        let loaded = loaded.unwrap();
        assert_eq!(loaded.sequence_id, "seq1");
        assert_eq!(loaded.segments.len(), 2);
        assert_eq!(loaded.segments[0].state, CacheSegmentState::Cached);
        assert_eq!(loaded.segments[0].file_size_bytes, 2048);
        assert_eq!(loaded.segments[1].state, CacheSegmentState::Empty);
    }

    #[test]
    fn should_return_none_when_manifest_not_found() {
        // Given a project dir with no cache
        let tmp = tempfile::tempdir().unwrap();

        // When loading
        let result = load_manifest(tmp.path(), "nonexistent").unwrap();

        // Then None should be returned
        assert!(result.is_none());
    }

    #[test]
    fn should_cleanup_stale_segment_files() {
        // Given a manifest with a stale segment that has a file
        let clip = make_test_clip("c1", "a1", 0.0, 10.0);
        let track = make_test_track("t1", TrackKind::Video, vec![clip]);
        let seq = make_test_sequence("seq1", vec![track]);
        let effects = HashMap::new();

        let tmp = tempfile::tempdir().unwrap();
        let mut manifest = RenderCacheManifest::new("seq1", 10.0, 5.0, &seq, &effects);
        manifest.mark_segment_cached(0, "segment_0000.mp4".to_string(), 1024);

        // Create the actual file on disk
        let seg_dir = sequence_cache_dir(tmp.path(), "seq1");
        std::fs::create_dir_all(&seg_dir).unwrap();
        std::fs::write(seg_dir.join("segment_0000.mp4"), vec![0u8; 1024]).unwrap();

        // Mark it stale
        manifest.segments[0].state = CacheSegmentState::Stale;

        // When cleaning up
        let freed = cleanup_stale_files(tmp.path(), &mut manifest);

        // Then the file should be deleted and bytes freed
        assert_eq!(freed, 1024);
        assert_eq!(manifest.segments[0].state, CacheSegmentState::Empty);
        assert!(manifest.segments[0].cached_file.is_none());
        assert!(!seg_dir.join("segment_0000.mp4").exists());
    }

    #[test]
    fn should_clear_entire_sequence_cache() {
        // Given a sequence cache directory with files
        let tmp = tempfile::tempdir().unwrap();
        let dir = sequence_cache_dir(tmp.path(), "seq1");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("segment_0000.mp4"), b"test").unwrap();
        std::fs::write(dir.join("manifest.json"), b"{}").unwrap();

        // When clearing
        clear_sequence_cache(tmp.path(), "seq1").unwrap();

        // Then the directory should be gone
        assert!(!dir.exists());
    }

    #[test]
    fn should_evict_segments_when_cache_exceeds_limit() {
        // Given a manifest where total size exceeds the limit
        let clip = make_test_clip("c1", "a1", 0.0, 20.0);
        let track = make_test_track("t1", TrackKind::Video, vec![clip]);
        let seq = make_test_sequence("seq1", vec![track]);
        let effects = HashMap::new();

        let tmp = tempfile::tempdir().unwrap();
        let seg_dir = sequence_cache_dir(tmp.path(), "seq1");
        std::fs::create_dir_all(&seg_dir).unwrap();

        let mut manifest = RenderCacheManifest::new("seq1", 20.0, 5.0, &seq, &effects);

        // Cache all 4 segments (500 bytes each = 2000 total)
        for i in 0..4 {
            let name = format!("segment_{i:04}.mp4");
            std::fs::write(seg_dir.join(&name), vec![0u8; 500]).unwrap();
            manifest.mark_segment_cached(i, name, 500);
        }
        assert_eq!(manifest.total_cached_bytes, 2000);

        // When enforcing a 1000-byte limit
        let evicted = enforce_cache_limit(tmp.path(), &mut manifest, 1000);

        // Then segments should be evicted from the end
        assert_eq!(evicted, 2);
        assert!(manifest.total_cached_bytes <= 1000);
        // First segments preserved (more likely to be played)
        assert_eq!(manifest.segments[0].state, CacheSegmentState::Cached);
        assert_eq!(manifest.segments[1].state, CacheSegmentState::Cached);
        assert_eq!(manifest.segments[2].state, CacheSegmentState::Empty);
        assert_eq!(manifest.segments[3].state, CacheSegmentState::Empty);
    }

    #[test]
    fn should_not_evict_when_under_limit() {
        // Given a manifest under the size limit
        let clip = make_test_clip("c1", "a1", 0.0, 10.0);
        let track = make_test_track("t1", TrackKind::Video, vec![clip]);
        let seq = make_test_sequence("seq1", vec![track]);
        let effects = HashMap::new();

        let tmp = tempfile::tempdir().unwrap();
        let mut manifest = RenderCacheManifest::new("seq1", 10.0, 5.0, &seq, &effects);
        manifest.mark_segment_cached(0, "s0.mp4".to_string(), 100);

        // When enforcing a large limit
        let evicted = enforce_cache_limit(tmp.path(), &mut manifest, 10_000);

        // Then nothing should be evicted
        assert_eq!(evicted, 0);
        assert_eq!(manifest.segments[0].state, CacheSegmentState::Cached);
    }
}
