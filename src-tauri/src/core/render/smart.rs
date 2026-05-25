//! Smart Rendering Engine
//!
//! Analyzes cache manifests to determine which segments can be copied
//! directly (stream-copy) versus which need re-encoding during export.
//! Reduces export time by avoiding redundant encoding of unchanged segments.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use super::cache::{CacheSegmentState, RenderCacheConfig, RenderCacheManifest, RenderCacheSegment};
use crate::core::effects::Effect;
use crate::core::timeline::Sequence;

// =============================================================================
// Types
// =============================================================================

/// Decision for a single segment during smart render
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SegmentAction {
    /// Segment is cached and unchanged — copy directly from cache file
    CopyFromCache { cache_file: PathBuf },
    /// Segment needs (re-)encoding
    ReEncode,
}

/// A planned segment with its render action
#[derive(Clone, Debug)]
pub struct SmartRenderSegment {
    /// Segment index
    pub index: u32,
    /// Start time in seconds
    pub start_sec: f64,
    /// End time in seconds
    pub end_sec: f64,
    /// Action to take
    pub action: SegmentAction,
}

impl SmartRenderSegment {
    /// Duration of this segment in seconds
    pub fn duration_sec(&self) -> f64 {
        self.end_sec - self.start_sec
    }

    /// Whether this segment will be copied from cache
    pub fn is_copy(&self) -> bool {
        matches!(self.action, SegmentAction::CopyFromCache { .. })
    }
}

/// The result of smart render planning
#[derive(Clone, Debug)]
pub struct SmartRenderPlan {
    /// All planned segments
    pub segments: Vec<SmartRenderSegment>,
    /// Total timeline duration
    pub total_duration_sec: f64,
}

impl SmartRenderPlan {
    /// Number of segments that can be copied from cache
    pub fn copy_count(&self) -> usize {
        self.segments.iter().filter(|s| s.is_copy()).count()
    }

    /// Number of segments that need re-encoding
    pub fn reencode_count(&self) -> usize {
        self.segments.iter().filter(|s| !s.is_copy()).count()
    }

    /// Total duration of cached segments (seconds saved from re-encoding)
    pub fn cached_duration_sec(&self) -> f64 {
        self.segments
            .iter()
            .filter(|s| s.is_copy())
            .map(|s| s.duration_sec())
            .sum()
    }

    /// Estimated time savings ratio (0.0 = no savings, 1.0 = all from cache)
    pub fn savings_ratio(&self) -> f64 {
        if self.total_duration_sec <= 0.0 {
            return 0.0;
        }
        self.cached_duration_sec() / self.total_duration_sec
    }

    /// Whether smart rendering provides any benefit (has cached segments)
    pub fn has_savings(&self) -> bool {
        self.copy_count() > 0
    }

    /// Returns file paths of all cache files needed for copy
    pub fn cache_files(&self) -> Vec<&Path> {
        self.segments
            .iter()
            .filter_map(|s| match &s.action {
                SegmentAction::CopyFromCache { cache_file } => Some(cache_file.as_path()),
                SegmentAction::ReEncode => None,
            })
            .collect()
    }
}

// =============================================================================
// Planning
// =============================================================================

/// Creates a smart render plan by analyzing the cache manifest.
/// Refreshes fingerprints first to detect any changes since the last cache.
///
/// NOTE: Currently, CopyFromCache decisions are based solely on content
/// fingerprint equality and do not verify export profile compatibility
/// (codec, container, quality). Callers should ensure cached segments
/// were produced with compatible export settings, or partition cache
/// directories per export profile. This is tracked as a future enhancement.
pub fn plan_smart_render(
    manifest: &mut RenderCacheManifest,
    sequence: &Sequence,
    effects: &HashMap<String, Effect>,
    config: &RenderCacheConfig,
    project_dir: &Path,
) -> SmartRenderPlan {
    // Refresh fingerprints to ensure we detect any changes
    manifest.refresh_fingerprints(sequence, effects);

    let total_duration = manifest.segments.last().map(|s| s.end_sec).unwrap_or(0.0);

    if !config.smart_render_enabled || manifest.segments.is_empty() {
        // Smart render disabled — re-encode everything
        return SmartRenderPlan {
            segments: manifest
                .segments
                .iter()
                .map(|s| SmartRenderSegment {
                    index: s.index,
                    start_sec: s.start_sec,
                    end_sec: s.end_sec,
                    action: SegmentAction::ReEncode,
                })
                .collect(),
            total_duration_sec: total_duration,
        };
    }

    let seq_dir = super::cache::sequence_cache_dir(project_dir, &manifest.sequence_id);

    let segments = manifest
        .segments
        .iter()
        .map(|s| {
            let action = decide_segment_action(s, &seq_dir);
            SmartRenderSegment {
                index: s.index,
                start_sec: s.start_sec,
                end_sec: s.end_sec,
                action,
            }
        })
        .collect();

    SmartRenderPlan {
        segments,
        total_duration_sec: total_duration,
    }
}

/// Decides the action for a single segment based on its cache state.
fn decide_segment_action(segment: &RenderCacheSegment, seq_cache_dir: &Path) -> SegmentAction {
    if segment.state != CacheSegmentState::Cached {
        return SegmentAction::ReEncode;
    }

    let Some(ref file_name) = segment.cached_file else {
        return SegmentAction::ReEncode;
    };

    let cache_path = seq_cache_dir.join(file_name);

    // Verify the file actually exists on disk
    if !cache_path.exists() {
        return SegmentAction::ReEncode;
    }

    SegmentAction::CopyFromCache {
        cache_file: cache_path,
    }
}

/// Merges consecutive re-encode segments into contiguous ranges for more
/// efficient FFmpeg invocation (fewer process spawns).
pub fn merge_reencode_ranges(plan: &SmartRenderPlan) -> Vec<(f64, f64)> {
    let mut ranges: Vec<(f64, f64)> = Vec::new();

    for segment in &plan.segments {
        if segment.is_copy() {
            continue;
        }

        if let Some(last) = ranges.last_mut() {
            // Extend if contiguous (within small epsilon)
            if (segment.start_sec - last.1).abs() < 0.001 {
                last.1 = segment.end_sec;
                continue;
            }
        }

        ranges.push((segment.start_sec, segment.end_sec));
    }

    ranges
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::render::cache::{CacheSegmentState, RenderCacheConfig, RenderCacheManifest};
    use crate::core::timeline::{
        AudioSettings, BlendMode, Canvas, Clip, ClipPlace, ClipRange, Sequence, SequenceFormat,
        Track, TrackKind, Transform,
    };
    use crate::core::types::Ratio;

    fn make_clip(id: &str, start: f64, duration: f64) -> Clip {
        Clip {
            id: id.to_string(),
            asset_id: "asset1".to_string(),
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

    fn make_sequence(duration: f64) -> Sequence {
        let clip = make_clip("c1", 0.0, duration);
        Sequence {
            id: "seq1".to_string(),
            name: "Test".to_string(),
            format: SequenceFormat {
                canvas: Canvas {
                    width: 1920,
                    height: 1080,
                },
                fps: Ratio::new(30, 1),
                audio_sample_rate: 48000,
                audio_channels: 2,
            },
            tracks: vec![Track {
                id: "t1".to_string(),
                kind: TrackKind::Video,
                name: "V1".to_string(),
                clips: vec![clip],
                blend_mode: BlendMode::Normal,
                is_base_track: None,
                muted: false,
                locked: false,
                visible: true,
                sync_lock: false,
                volume: 1.0,
            }],
            markers: vec![],
            master_volume_db: 0.0,
            hdr_settings: Default::default(),
            created_at: "2026-01-01T00:00:00Z".to_string(),
            modified_at: "2026-01-01T00:00:00Z".to_string(),
        }
    }

    #[test]
    fn should_mark_cached_segments_as_copy() {
        // Given a manifest with 2 cached segments and 1 empty
        let seq = make_sequence(15.0);
        let effects = HashMap::new();
        let config = RenderCacheConfig::default();
        let tmp = tempfile::tempdir().unwrap();

        let mut manifest = RenderCacheManifest::new("seq1", 15.0, 5.0, &seq, &effects);

        // Create actual cache files on disk
        let seg_dir = super::super::cache::sequence_cache_dir(tmp.path(), "seq1");
        std::fs::create_dir_all(&seg_dir).unwrap();
        std::fs::write(seg_dir.join("s0.mp4"), b"cached0").unwrap();
        std::fs::write(seg_dir.join("s1.mp4"), b"cached1").unwrap();

        manifest.mark_segment_cached(0, "s0.mp4".to_string(), 100);
        manifest.mark_segment_cached(1, "s1.mp4".to_string(), 100);

        // When planning smart render
        let plan = plan_smart_render(&mut manifest, &seq, &effects, &config, tmp.path());

        // Then cached segments should be copy, rest re-encode
        assert_eq!(plan.segments.len(), 3);
        assert!(plan.segments[0].is_copy());
        assert!(plan.segments[1].is_copy());
        assert!(!plan.segments[2].is_copy());
        assert_eq!(plan.copy_count(), 2);
        assert_eq!(plan.reencode_count(), 1);
    }

    #[test]
    fn should_reencode_all_when_smart_render_disabled() {
        // Given smart render disabled
        let seq = make_sequence(10.0);
        let effects = HashMap::new();
        let config = RenderCacheConfig {
            smart_render_enabled: false,
            ..Default::default()
        };
        let tmp = tempfile::tempdir().unwrap();

        let mut manifest = RenderCacheManifest::new("seq1", 10.0, 5.0, &seq, &effects);
        manifest.mark_segment_cached(0, "s0.mp4".to_string(), 100);

        // When planning
        let plan = plan_smart_render(&mut manifest, &seq, &effects, &config, tmp.path());

        // Then all segments should be re-encoded
        assert_eq!(plan.copy_count(), 0);
        assert_eq!(plan.reencode_count(), 2);
    }

    #[test]
    fn should_reencode_when_cache_file_missing_on_disk() {
        // Given a manifest says cached, but file is missing
        let seq = make_sequence(5.0);
        let effects = HashMap::new();
        let config = RenderCacheConfig::default();
        let tmp = tempfile::tempdir().unwrap();

        let mut manifest = RenderCacheManifest::new("seq1", 5.0, 5.0, &seq, &effects);
        manifest.mark_segment_cached(0, "missing.mp4".to_string(), 100);
        // File NOT created on disk

        // When planning
        let plan = plan_smart_render(&mut manifest, &seq, &effects, &config, tmp.path());

        // Then it should fall back to re-encode
        assert_eq!(plan.copy_count(), 0);
        assert_eq!(plan.reencode_count(), 1);
    }

    #[test]
    fn should_detect_stale_segments_after_edit() {
        // Given a cached manifest
        let seq = make_sequence(10.0);
        let effects = HashMap::new();
        let config = RenderCacheConfig::default();
        let tmp = tempfile::tempdir().unwrap();

        let seg_dir = super::super::cache::sequence_cache_dir(tmp.path(), "seq1");
        std::fs::create_dir_all(&seg_dir).unwrap();
        std::fs::write(seg_dir.join("s0.mp4"), b"data").unwrap();

        let mut manifest = RenderCacheManifest::new("seq1", 10.0, 5.0, &seq, &effects);
        manifest.mark_segment_cached(0, "s0.mp4".to_string(), 100);

        // When the sequence changes (different clip)
        let mut modified_seq = make_sequence(10.0);
        modified_seq.tracks[0].clips[0].opacity = 0.5; // changed!

        let plan = plan_smart_render(&mut manifest, &modified_seq, &effects, &config, tmp.path());

        // Then the changed segment should need re-encode
        assert!(!plan.segments[0].is_copy());
        assert_eq!(manifest.segments[0].state, CacheSegmentState::Stale);
    }

    #[test]
    fn should_calculate_correct_savings_ratio() {
        // Given a plan with 3 copy and 1 re-encode segments (20 sec total)
        let seq = make_sequence(20.0);
        let effects = HashMap::new();
        let config = RenderCacheConfig::default();
        let tmp = tempfile::tempdir().unwrap();

        let seg_dir = super::super::cache::sequence_cache_dir(tmp.path(), "seq1");
        std::fs::create_dir_all(&seg_dir).unwrap();
        for i in 0..3 {
            let name = format!("s{i}.mp4");
            std::fs::write(seg_dir.join(&name), b"data").unwrap();
        }

        let mut manifest = RenderCacheManifest::new("seq1", 20.0, 5.0, &seq, &effects);
        for i in 0..3 {
            manifest.mark_segment_cached(i, format!("s{i}.mp4"), 100);
        }

        let plan = plan_smart_render(&mut manifest, &seq, &effects, &config, tmp.path());

        // Then savings should be 75% (15/20 seconds from cache)
        assert_eq!(plan.copy_count(), 3);
        assert!((plan.savings_ratio() - 0.75).abs() < 0.01);
        assert!(plan.has_savings());
    }

    #[test]
    fn should_merge_consecutive_reencode_ranges() {
        // Given a plan with alternating actions: re-encode, re-encode, copy, re-encode
        let plan = SmartRenderPlan {
            segments: vec![
                SmartRenderSegment {
                    index: 0,
                    start_sec: 0.0,
                    end_sec: 5.0,
                    action: SegmentAction::ReEncode,
                },
                SmartRenderSegment {
                    index: 1,
                    start_sec: 5.0,
                    end_sec: 10.0,
                    action: SegmentAction::ReEncode,
                },
                SmartRenderSegment {
                    index: 2,
                    start_sec: 10.0,
                    end_sec: 15.0,
                    action: SegmentAction::CopyFromCache {
                        cache_file: PathBuf::from("cached.mp4"),
                    },
                },
                SmartRenderSegment {
                    index: 3,
                    start_sec: 15.0,
                    end_sec: 20.0,
                    action: SegmentAction::ReEncode,
                },
            ],
            total_duration_sec: 20.0,
        };

        // When merging
        let ranges = merge_reencode_ranges(&plan);

        // Then consecutive re-encode ranges should be merged
        assert_eq!(ranges.len(), 2);
        assert!((ranges[0].0 - 0.0).abs() < 0.001);
        assert!((ranges[0].1 - 10.0).abs() < 0.001);
        assert!((ranges[1].0 - 15.0).abs() < 0.001);
        assert!((ranges[1].1 - 20.0).abs() < 0.001);
    }

    #[test]
    fn should_return_empty_plan_for_empty_manifest() {
        // Given an empty sequence
        let seq = Sequence {
            id: "seq1".to_string(),
            name: "Empty".to_string(),
            format: SequenceFormat {
                canvas: Canvas {
                    width: 1920,
                    height: 1080,
                },
                fps: Ratio::new(30, 1),
                audio_sample_rate: 48000,
                audio_channels: 2,
            },
            tracks: vec![],
            markers: vec![],
            master_volume_db: 0.0,
            hdr_settings: Default::default(),
            created_at: "2026-01-01T00:00:00Z".to_string(),
            modified_at: "2026-01-01T00:00:00Z".to_string(),
        };
        let effects = HashMap::new();
        let config = RenderCacheConfig::default();
        let tmp = tempfile::tempdir().unwrap();

        let mut manifest = RenderCacheManifest::new("seq1", 0.0, 5.0, &seq, &effects);

        // When planning
        let plan = plan_smart_render(&mut manifest, &seq, &effects, &config, tmp.path());

        // Then plan should be empty
        assert!(plan.segments.is_empty());
        assert_eq!(plan.savings_ratio(), 0.0);
        assert!(!plan.has_savings());
    }
}
