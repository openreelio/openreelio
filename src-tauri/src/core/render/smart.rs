//! Smart Rendering Engine
//!
//! Analyzes cache manifests to determine which segments can be copied
//! directly (stream-copy) versus which need re-encoding during export.
//! Reduces export time by avoiding redundant encoding of unchanged segments.

use std::path::{Path, PathBuf};

use super::cache::{CacheSegmentState, RenderCacheConfig, RenderCacheManifest, RenderCacheSegment};

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

/// Creates a smart render plan by reading segment state from the cache manifest.
///
/// Staleness is decided before this runs, by
/// [`refresh_manifest_plan_fingerprints`](super::cache::refresh_manifest_plan_fingerprints):
/// segment identity is the render plan hash, and this module has neither the
/// graph nor the assets needed to compute one. A caller that has edited the
/// timeline since the manifest was last refreshed must refresh it again first,
/// or it will copy a segment the edit invalidated.
///
/// Encode-profile compatibility needs no check here: cached segments live in a
/// directory named after the profile hash that produced them
/// (`manifest.profile_hash`), so a segment from another profile is not on the
/// path this looks at.
pub fn plan_smart_render(
    manifest: &RenderCacheManifest,
    config: &RenderCacheConfig,
    project_dir: &Path,
) -> SmartRenderPlan {
    let total_duration = manifest.segments.last().map(|s| s.end_sec).unwrap_or(0.0);

    if !config.smart_render_enabled || manifest.segments.is_empty() {
        // Smart render disabled — re-encode everything
        return reencode_every_segment(manifest, total_duration);
    }

    // Fail closed: without a usable cache directory there is nothing to copy from, so
    // re-encode rather than resolving segment paths against an unvalidated id.
    let seq_dir = match super::cache::profile_cache_dir(
        project_dir,
        &manifest.sequence_id,
        &manifest.profile_hash,
    ) {
        Ok(dir) => dir,
        Err(error) => {
            tracing::warn!("Smart render falling back to a full re-encode: {error}");
            return reencode_every_segment(manifest, total_duration);
        }
    };

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

/// Builds a plan that re-encodes every segment, ignoring the cache entirely.
fn reencode_every_segment(
    manifest: &RenderCacheManifest,
    total_duration_sec: f64,
) -> SmartRenderPlan {
    SmartRenderPlan {
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
        total_duration_sec,
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

    // `cached_file` comes out of the on-disk manifest, and the resulting path becomes a
    // `fs::copy` source. Only names this crate writes are honoured; anything else is
    // treated as a cache miss.
    let Some(cache_path) = super::cache::resolve_cached_segment_path(seq_cache_dir, file_name)
    else {
        return SegmentAction::ReEncode;
    };

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
    use crate::core::render::cache::{
        preview_profile_hash, profile_cache_dir, CacheSegmentState, RenderCacheConfig,
        RenderCacheManifest,
    };

    fn manifest(duration_sec: f64) -> RenderCacheManifest {
        RenderCacheManifest::new("seq1", &preview_profile_hash(), duration_sec, 5.0)
    }

    fn segment_dir(project_dir: &Path) -> PathBuf {
        let dir = profile_cache_dir(project_dir, "seq1", &preview_profile_hash()).unwrap();
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn should_mark_cached_segments_as_copy() {
        // Given a manifest with 2 cached segments and 1 empty
        let config = RenderCacheConfig::default();
        let tmp = tempfile::tempdir().unwrap();
        let mut manifest = manifest(15.0);

        // Create actual cache files on disk
        let seg_dir = segment_dir(tmp.path());
        std::fs::write(seg_dir.join("segment_0000.mp4"), b"cached0").unwrap();
        std::fs::write(seg_dir.join("segment_0001.mp4"), b"cached1").unwrap();

        manifest.mark_segment_cached(0, "segment_0000.mp4".to_string(), 100);
        manifest.mark_segment_cached(1, "segment_0001.mp4".to_string(), 100);

        // When planning smart render
        let plan = plan_smart_render(&manifest, &config, tmp.path());

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
        let config = RenderCacheConfig {
            smart_render_enabled: false,
            ..Default::default()
        };
        let tmp = tempfile::tempdir().unwrap();

        let mut manifest = manifest(10.0);
        manifest.mark_segment_cached(0, "segment_0000.mp4".to_string(), 100);

        // When planning
        let plan = plan_smart_render(&manifest, &config, tmp.path());

        // Then all segments should be re-encoded
        assert_eq!(plan.copy_count(), 0);
        assert_eq!(plan.reencode_count(), 2);
    }

    #[test]
    fn should_reencode_when_cache_file_missing_on_disk() {
        // Given a manifest says cached, but file is missing
        let config = RenderCacheConfig::default();
        let tmp = tempfile::tempdir().unwrap();

        let mut manifest = manifest(5.0);
        manifest.mark_segment_cached(0, "segment_0000.mp4".to_string(), 100);
        // File NOT created on disk

        // When planning
        let plan = plan_smart_render(&manifest, &config, tmp.path());

        // Then it should fall back to re-encode
        assert_eq!(plan.copy_count(), 0);
        assert_eq!(plan.reencode_count(), 1);
    }

    #[test]
    fn should_reencode_segments_the_manifest_marks_stale() {
        // Staleness is decided by the plan-fingerprint refresh before this runs;
        // smart render only reads the state it left behind.

        // Given a cached manifest whose first segment has been invalidated
        let config = RenderCacheConfig::default();
        let tmp = tempfile::tempdir().unwrap();
        let seg_dir = segment_dir(tmp.path());
        std::fs::write(seg_dir.join("segment_0000.mp4"), b"data").unwrap();

        let mut manifest = manifest(10.0);
        manifest.mark_segment_cached(0, "segment_0000.mp4".to_string(), 100);
        manifest.segments[0].state = CacheSegmentState::Stale;

        // When planning
        let plan = plan_smart_render(&manifest, &config, tmp.path());

        // Then the stale segment is re-encoded even though its file is on disk
        assert!(!plan.segments[0].is_copy());
        assert_eq!(plan.copy_count(), 0);
    }

    #[test]
    fn should_not_copy_a_segment_cached_under_another_profile() {
        // Given a segment file that exists only under a different profile
        let config = RenderCacheConfig::default();
        let tmp = tempfile::tempdir().unwrap();
        let other_profile = crate::core::render::compute_profile_hash(
            &crate::core::render::ExportSettings::default(),
        );
        let other_dir = profile_cache_dir(tmp.path(), "seq1", &other_profile).unwrap();
        std::fs::create_dir_all(&other_dir).unwrap();
        std::fs::write(other_dir.join("segment_0000.mp4"), b"other").unwrap();

        let mut manifest = manifest(5.0);
        assert_ne!(manifest.profile_hash, other_profile);
        manifest.mark_segment_cached(0, "segment_0000.mp4".to_string(), 100);

        // When planning under this manifest's own profile
        let plan = plan_smart_render(&manifest, &config, tmp.path());

        // Then the other profile's file is not reachable and the segment re-encodes
        assert_eq!(plan.copy_count(), 0);
        assert_eq!(plan.reencode_count(), 1);
    }

    #[test]
    fn should_calculate_correct_savings_ratio() {
        // Given a plan with 3 copy and 1 re-encode segments (20 sec total)
        let config = RenderCacheConfig::default();
        let tmp = tempfile::tempdir().unwrap();

        let seg_dir = segment_dir(tmp.path());
        for i in 0..3 {
            let name = format!("segment_{i:04}.mp4");
            std::fs::write(seg_dir.join(&name), b"data").unwrap();
        }

        let mut manifest = manifest(20.0);
        for i in 0..3 {
            manifest.mark_segment_cached(i, format!("segment_{i:04}.mp4"), 100);
        }

        let plan = plan_smart_render(&manifest, &config, tmp.path());

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
        // Given an empty timeline
        let config = RenderCacheConfig::default();
        let tmp = tempfile::tempdir().unwrap();
        let manifest = manifest(0.0);

        // When planning
        let plan = plan_smart_render(&manifest, &config, tmp.path());

        // Then plan should be empty
        assert!(plan.segments.is_empty());
        assert_eq!(plan.savings_ratio(), 0.0);
        assert!(!plan.has_savings());
    }
}
