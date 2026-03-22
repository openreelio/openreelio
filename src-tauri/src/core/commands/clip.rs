//! Clip Commands Module
//!
//! Implements all clip-related editing commands.

use serde::{Deserialize, Serialize};
use std::collections::HashSet;

use crate::core::{
    commands::{Command, CommandResult, StateChange},
    project::ProjectState,
    timeline::{
        AudioKeyframe, AudioSettings, BlendMode, Clip, ClipPlace, ClipRange, FadeType,
        KeyframeInterpolation, TimeRemapCurve, TimeRemapKeyframe, Track, Transform,
    },
    AssetId, ClipId, CoreError, CoreResult, SequenceId, TimeSec, TrackId,
};

const TIME_REMAP_EPSILON: TimeSec = 1e-6;

fn is_valid_time_sec(value: TimeSec) -> bool {
    value.is_finite() && value >= 0.0
}

fn sort_track_clips(track: &mut Track) {
    track.clips.sort_by(|a, b| {
        a.place
            .timeline_in_sec
            .total_cmp(&b.place.timeline_in_sec)
            .then_with(|| {
                // Ensure deterministic ordering when two clips share the same start time.
                a.id.cmp(&b.id)
            })
    });
}

fn find_overlap<'a>(
    track: &'a Track,
    candidate: &ClipPlace,
    ignore_clip_id: Option<&str>,
) -> Option<&'a Clip> {
    track.clips.iter().find(|existing| {
        if ignore_clip_id.is_some_and(|id| id == existing.id) {
            return false;
        }
        existing.place.overlaps(candidate)
    })
}

fn validate_no_overlap(
    track: &Track,
    candidate: &ClipPlace,
    ignore_clip_id: Option<&str>,
) -> CoreResult<()> {
    if let Some(conflict) = find_overlap(track, candidate, ignore_clip_id) {
        return Err(CoreError::ClipOverlap {
            track_id: track.id.clone(),
            existing_clip_id: conflict.id.clone(),
            new_start: candidate.timeline_in_sec,
            new_end: candidate.timeline_out_sec(),
        });
    }
    Ok(())
}

fn insert_clip_sorted(track: &mut Track, clip: Clip) {
    // Keep clips ordered by timeline start.
    let idx = track
        .clips
        .binary_search_by(|existing| {
            existing
                .place
                .timeline_in_sec
                .total_cmp(&clip.place.timeline_in_sec)
        })
        .unwrap_or_else(|i| i);
    track.clips.insert(idx, clip);
    // Defensive: binary_search_by doesn't guarantee stable ordering when keys are equal.
    // We never allow overlaps, but keep ordering deterministic.
    sort_track_clips(track);
}

fn validate_track_unlocked(track: &Track) -> CoreResult<()> {
    if track.locked {
        return Err(CoreError::ValidationError(format!(
            "Track '{}' is locked",
            track.id
        )));
    }
    Ok(())
}

fn push_unique_clip_ref(
    seen: &mut HashSet<(TrackId, ClipId)>,
    refs: &mut Vec<(TrackId, ClipId)>,
    track_id: &TrackId,
    clip_id: &ClipId,
) {
    let clip_ref = (track_id.clone(), clip_id.clone());
    if seen.insert(clip_ref.clone()) {
        refs.push(clip_ref);
    }
}

fn find_clip_ref<'a>(
    sequence: &'a crate::core::timeline::Sequence,
    track_id: &str,
    clip_id: &str,
) -> CoreResult<(&'a Track, &'a Clip)> {
    let track = sequence
        .tracks
        .iter()
        .find(|track| track.id == track_id)
        .ok_or_else(|| CoreError::TrackNotFound(track_id.to_string()))?;
    let clip = track
        .clips
        .iter()
        .find(|clip| clip.id == clip_id)
        .ok_or_else(|| CoreError::ClipNotFound(clip_id.to_string()))?;

    Ok((track, clip))
}

fn collect_clip_refs_for_link_group(
    sequence: &crate::core::timeline::Sequence,
    link_group_id: &str,
) -> Vec<(TrackId, ClipId)> {
    if link_group_id.is_empty() {
        return Vec::new();
    }

    let mut clip_refs = Vec::new();
    for track in &sequence.tracks {
        for clip in &track.clips {
            if clip.link_group_id.as_deref() == Some(link_group_id) {
                clip_refs.push((track.id.clone(), clip.id.clone()));
            }
        }
    }

    clip_refs
}

fn collect_affected_link_refs(
    sequence: &crate::core::timeline::Sequence,
    clip_refs: &[(TrackId, ClipId)],
) -> CoreResult<Vec<(TrackId, ClipId)>> {
    let mut affected_refs = Vec::new();
    let mut seen = HashSet::new();

    for (track_id, clip_id) in clip_refs {
        let (_, clip) = find_clip_ref(sequence, track_id, clip_id)?;
        push_unique_clip_ref(&mut seen, &mut affected_refs, track_id, clip_id);

        let Some(link_group_id) = clip.link_group_id.as_deref() else {
            continue;
        };

        for (group_track_id, group_clip_id) in collect_clip_refs_for_link_group(sequence, link_group_id)
        {
            push_unique_clip_ref(
                &mut seen,
                &mut affected_refs,
                &group_track_id,
                &group_clip_id,
            );
        }
    }

    Ok(affected_refs)
}

fn capture_link_group_state(
    sequence: &crate::core::timeline::Sequence,
    clip_refs: &[(TrackId, ClipId)],
) -> CoreResult<Vec<(TrackId, ClipId, Option<String>)>> {
    let mut previous_link_group_ids = Vec::with_capacity(clip_refs.len());

    for (track_id, clip_id) in clip_refs {
        let (_, clip) = find_clip_ref(sequence, track_id, clip_id)?;
        previous_link_group_ids.push((
            track_id.clone(),
            clip_id.clone(),
            clip.link_group_id.clone(),
        ));
    }

    Ok(previous_link_group_ids)
}

fn validate_clip_refs_unlocked(
    sequence: &crate::core::timeline::Sequence,
    clip_refs: &[(TrackId, ClipId)],
) -> CoreResult<()> {
    for (track_id, clip_id) in clip_refs {
        let (track, _) = find_clip_ref(sequence, track_id, clip_id)?;
        validate_track_unlocked(track).map_err(|error| match error {
            CoreError::ValidationError(_) => CoreError::ValidationError(format!(
                "Cannot modify linked clip '{}' because track '{}' is locked",
                clip_id, track_id
            )),
            other => other,
        })?;
    }

    Ok(())
}

fn normalize_degenerate_link_groups(
    sequence: &mut crate::core::timeline::Sequence,
    clip_refs: &[(TrackId, ClipId)],
) -> CoreResult<Vec<(TrackId, ClipId)>> {
    let mut group_ids = HashSet::new();

    for (track_id, clip_id) in clip_refs {
        let (_, clip) = find_clip_ref(sequence, track_id, clip_id)?;
        if let Some(link_group_id) = clip.link_group_id.as_deref() {
            if !link_group_id.is_empty() {
                group_ids.insert(link_group_id.to_string());
            }
        }
    }

    let mut normalized_refs = Vec::new();
    let mut seen = HashSet::new();

    for link_group_id in group_ids {
        let members = collect_clip_refs_for_link_group(sequence, &link_group_id);
        if members.len() >= 2 {
            continue;
        }

        for (track_id, clip_id) in members {
            let track = sequence
                .tracks
                .iter_mut()
                .find(|track| track.id == track_id)
                .ok_or_else(|| CoreError::TrackNotFound(track_id.clone()))?;
            let clip = track
                .clips
                .iter_mut()
                .find(|clip| clip.id == clip_id)
                .ok_or_else(|| CoreError::ClipNotFound(clip_id.clone()))?;
            clip.link_group_id = Some(EXPLICIT_UNLINK_SENTINEL.to_string());
            push_unique_clip_ref(&mut seen, &mut normalized_refs, &track_id, &clip_id);
        }
    }

    Ok(normalized_refs)
}

fn append_clip_modified_changes(
    result: &mut CommandResult,
    clip_refs: &[(TrackId, ClipId)],
) {
    let mut seen_clip_ids = HashSet::new();
    for (_, clip_id) in clip_refs {
        if seen_clip_ids.insert(clip_id.clone()) {
            result.changes.push(StateChange::ClipModified {
                clip_id: clip_id.clone(),
            });
        }
    }
}

#[derive(Clone, Copy)]
struct BezierPoint {
    x: f64,
    y: f64,
}

fn lerp_bezier_point(a: BezierPoint, b: BezierPoint, t: f64) -> BezierPoint {
    BezierPoint {
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
    }
}

fn split_bezier_curve(curve: [BezierPoint; 4], t: f64) -> ([BezierPoint; 4], [BezierPoint; 4]) {
    let p01 = lerp_bezier_point(curve[0], curve[1], t);
    let p12 = lerp_bezier_point(curve[1], curve[2], t);
    let p23 = lerp_bezier_point(curve[2], curve[3], t);
    let p012 = lerp_bezier_point(p01, p12, t);
    let p123 = lerp_bezier_point(p12, p23, t);
    let p0123 = lerp_bezier_point(p012, p123, t);

    ([curve[0], p01, p012, p0123], [p0123, p123, p23, curve[3]])
}

fn build_fragment_bezier_interpolation(
    cp1x: f64,
    cp1y: f64,
    cp2x: f64,
    cp2y: f64,
    start_norm: f64,
    end_norm: f64,
) -> KeyframeInterpolation {
    let start_norm = start_norm.clamp(0.0, 1.0);
    let end_norm = end_norm.clamp(start_norm, 1.0);
    if end_norm - start_norm <= TIME_REMAP_EPSILON {
        return KeyframeInterpolation::Linear;
    }

    let curve = [
        BezierPoint { x: 0.0, y: 0.0 },
        BezierPoint { x: cp1x, y: cp1y },
        BezierPoint { x: cp2x, y: cp2y },
        BezierPoint { x: 1.0, y: 1.0 },
    ];

    let (_, curve_after_start) = if start_norm <= TIME_REMAP_EPSILON {
        (curve, curve)
    } else {
        split_bezier_curve(curve, start_norm)
    };

    let relative_end = if end_norm >= 1.0 - TIME_REMAP_EPSILON {
        1.0
    } else {
        (end_norm - start_norm) / (1.0 - start_norm)
    };

    let (segment, _) = if relative_end >= 1.0 - TIME_REMAP_EPSILON {
        (curve_after_start, curve_after_start)
    } else {
        split_bezier_curve(curve_after_start, relative_end)
    };

    let p0 = segment[0];
    let p1 = segment[1];
    let p2 = segment[2];
    let p3 = segment[3];

    let dx = p3.x - p0.x;
    let dy = p3.y - p0.y;
    if dx.abs() <= TIME_REMAP_EPSILON {
        return KeyframeInterpolation::Linear;
    }
    if dy.abs() <= TIME_REMAP_EPSILON {
        return KeyframeInterpolation::Hold;
    }

    KeyframeInterpolation::Bezier {
        cp1x: ((p1.x - p0.x) / dx).clamp(0.0, 1.0),
        cp1y: ((p1.y - p0.y) / dy).clamp(0.0, 1.0),
        cp2x: ((p2.x - p0.x) / dx).clamp(0.0, 1.0),
        cp2y: ((p2.y - p0.y) / dy).clamp(0.0, 1.0),
    }
}

fn build_time_remap_fragment_interpolation(
    interpolation: &KeyframeInterpolation,
    start_norm: f64,
    end_norm: f64,
) -> KeyframeInterpolation {
    match interpolation {
        KeyframeInterpolation::Linear => KeyframeInterpolation::Linear,
        KeyframeInterpolation::Hold => KeyframeInterpolation::Hold,
        KeyframeInterpolation::Bezier {
            cp1x,
            cp1y,
            cp2x,
            cp2y,
        } => build_fragment_bezier_interpolation(*cp1x, *cp1y, *cp2x, *cp2y, start_norm, end_norm),
    }
}

fn find_time_remap_segment_index(curve: &TimeRemapCurve, timeline_time: TimeSec) -> usize {
    for i in 0..curve.keyframes.len().saturating_sub(1) {
        if timeline_time < curve.keyframes[i + 1].timeline_time - TIME_REMAP_EPSILON {
            return i;
        }
    }
    curve.keyframes.len().saturating_sub(2)
}

fn rebase_time_remap_curve(
    curve: &TimeRemapCurve,
    fragment_start_sec: TimeSec,
    fragment_duration_sec: TimeSec,
) -> TimeRemapCurve {
    if !curve.is_valid()
        || (fragment_start_sec.abs() <= TIME_REMAP_EPSILON
            && (fragment_duration_sec - curve.timeline_duration()).abs() <= TIME_REMAP_EPSILON)
    {
        return curve.clone();
    }

    let fragment_end_sec = fragment_start_sec + fragment_duration_sec;
    let first_timeline_sec = curve.keyframes[0].timeline_time;
    let last_timeline_sec = curve.keyframes[curve.keyframes.len() - 1].timeline_time;

    let mut segment_points = vec![fragment_start_sec];
    for kf in &curve.keyframes {
        if kf.timeline_time > fragment_start_sec + TIME_REMAP_EPSILON
            && kf.timeline_time < fragment_end_sec - TIME_REMAP_EPSILON
        {
            segment_points.push(kf.timeline_time);
        }
    }
    segment_points.push(fragment_end_sec);

    let mut keyframes = Vec::with_capacity(segment_points.len());
    for (idx, point_sec) in segment_points.iter().enumerate() {
        let interpolation = if idx + 1 < segment_points.len() {
            let next_point_sec = segment_points[idx + 1];
            if *point_sec < first_timeline_sec - TIME_REMAP_EPSILON
                || next_point_sec <= first_timeline_sec + TIME_REMAP_EPSILON
                || *point_sec >= last_timeline_sec - TIME_REMAP_EPSILON
            {
                KeyframeInterpolation::Hold
            } else {
                let segment_idx = find_time_remap_segment_index(curve, *point_sec);
                let segment_start = &curve.keyframes[segment_idx];
                let segment_end = &curve.keyframes[segment_idx + 1];
                let segment_duration = segment_end.timeline_time - segment_start.timeline_time;

                if segment_duration <= TIME_REMAP_EPSILON {
                    KeyframeInterpolation::Hold
                } else {
                    let start_norm = ((*point_sec - segment_start.timeline_time)
                        / segment_duration)
                        .clamp(0.0, 1.0);
                    let end_norm = ((next_point_sec - segment_start.timeline_time)
                        / segment_duration)
                        .clamp(0.0, 1.0);
                    build_time_remap_fragment_interpolation(
                        &segment_start.interpolation,
                        start_norm,
                        end_norm,
                    )
                }
            }
        } else {
            KeyframeInterpolation::Linear
        };

        keyframes.push(TimeRemapKeyframe {
            timeline_time: if idx + 1 == segment_points.len() {
                fragment_duration_sec
            } else {
                (*point_sec - fragment_start_sec).max(0.0)
            },
            source_time: curve.evaluate(*point_sec),
            interpolation,
        });
    }

    TimeRemapCurve::new(keyframes)
}

fn rebase_clip_time_remap_for_fragment(
    clip: &mut Clip,
    fragment_start_sec: TimeSec,
    fragment_duration_sec: TimeSec,
) {
    clip.time_remap = clip.time_remap.clone().map(|curve| {
        if curve.is_valid() {
            rebase_time_remap_curve(&curve, fragment_start_sec, fragment_duration_sec)
        } else {
            curve
        }
    });
}

fn clone_clip_fragment_with_rebased_time_remap(
    template: &Clip,
    source_in_sec: TimeSec,
    source_out_sec: TimeSec,
    timeline_in_sec: TimeSec,
    duration_sec: TimeSec,
    fragment_start_sec: TimeSec,
) -> Clip {
    let mut clip = clone_clip_fragment(
        template,
        source_in_sec,
        source_out_sec,
        timeline_in_sec,
        duration_sec,
    );
    rebase_clip_time_remap_for_fragment(&mut clip, fragment_start_sec, duration_sec);
    clip
}

fn clone_clip_fragment(
    template: &Clip,
    source_in_sec: TimeSec,
    source_out_sec: TimeSec,
    timeline_in_sec: TimeSec,
    duration_sec: TimeSec,
) -> Clip {
    let mut clip = template.clone();
    clip.id = ulid::Ulid::new().to_string();
    clip.range = ClipRange {
        source_in_sec,
        source_out_sec,
    };
    clip.place = ClipPlace {
        timeline_in_sec,
        duration_sec,
    };
    clip
}

fn split_clip_ranges_at(
    clip: &Clip,
    split_at: TimeSec,
) -> ((TimeSec, TimeSec), (TimeSec, TimeSec)) {
    let source_split = clip
        .timeline_to_source(split_at)
        .clamp(clip.range.source_in_sec, clip.range.source_out_sec);

    if clip.reverse {
        (
            (source_split, clip.range.source_out_sec),
            (clip.range.source_in_sec, source_split),
        )
    } else {
        (
            (clip.range.source_in_sec, source_split),
            (source_split, clip.range.source_out_sec),
        )
    }
}

fn freeze_frame_sample_time(clip: &Clip, playhead_sec: TimeSec, frame_window: TimeSec) -> TimeSec {
    let clip_start = clip.place.timeline_in_sec;
    let clip_end = clip.place.timeline_out_sec();
    if playhead_sec < clip_end {
        return playhead_sec;
    }

    let timeline_frame = (frame_window * 0.5).min(clip.place.duration_sec * 0.5);
    (clip_end - timeline_frame).max(clip_start)
}

fn freeze_frame_source_range(
    clip: &Clip,
    playhead_sec: TimeSec,
    frame_window: TimeSec,
) -> ClipRange {
    let sample_time = freeze_frame_sample_time(clip, playhead_sec, frame_window);
    let source_time = clip
        .timeline_to_source(sample_time)
        .clamp(clip.range.source_in_sec, clip.range.source_out_sec);
    let available_duration =
        (clip.range.source_out_sec - clip.range.source_in_sec).max(TIME_REMAP_EPSILON);
    let sample_window = (frame_window * 0.5).min(available_duration);
    let frame_start_sec = if clip.reverse {
        (((source_time / frame_window).ceil() - 1.0) * frame_window).max(0.0)
    } else {
        ((source_time / frame_window).floor() * frame_window).max(0.0)
    };
    let max_source_in_sec =
        (clip.range.source_out_sec - sample_window).max(clip.range.source_in_sec);
    let source_in_sec = frame_start_sec
        .clamp(clip.range.source_in_sec, clip.range.source_out_sec)
        .min(max_source_in_sec);
    let source_out_sec = (source_in_sec + sample_window).min(clip.range.source_out_sec);

    ClipRange::new(source_in_sec, source_out_sec)
}

// =============================================================================
// InsertClipCommand
// =============================================================================

/// Command to insert a new clip into a track
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InsertClipCommand {
    /// Target sequence ID
    pub sequence_id: SequenceId,
    /// Target track ID
    pub track_id: TrackId,
    /// Source asset ID
    pub asset_id: AssetId,
    /// Timeline position to insert at
    pub timeline_start: TimeSec,
    /// Source start time (optional, defaults to 0)
    pub source_start: Option<TimeSec>,
    /// Source end time (optional, defaults to asset duration)
    pub source_end: Option<TimeSec>,
    /// Created clip ID (stored after execution for undo)
    #[serde(skip)]
    created_clip_id: Option<ClipId>,
}

impl InsertClipCommand {
    /// Creates a new insert clip command
    pub fn new(sequence_id: &str, track_id: &str, asset_id: &str, timeline_start: TimeSec) -> Self {
        Self {
            sequence_id: sequence_id.to_string(),
            track_id: track_id.to_string(),
            asset_id: asset_id.to_string(),
            timeline_start,
            source_start: None,
            source_end: None,
            created_clip_id: None,
        }
    }

    /// Sets the source range
    pub fn with_source_range(mut self, start: TimeSec, end: TimeSec) -> Self {
        self.source_start = Some(start);
        self.source_end = Some(end);
        self
    }
}

impl Command for InsertClipCommand {
    fn execute(&mut self, state: &mut ProjectState) -> CoreResult<CommandResult> {
        if !is_valid_time_sec(self.timeline_start) {
            return Err(CoreError::ValidationError(
                "timelineStart must be finite and non-negative".to_string(),
            ));
        }

        // Validate asset exists
        let asset = state
            .assets
            .get(&self.asset_id)
            .ok_or_else(|| CoreError::AssetNotFound(self.asset_id.clone()))?;

        // Get asset duration for default source range
        let asset_duration = asset.duration_sec.unwrap_or(10.0);
        let source_start = self.source_start.unwrap_or(0.0);
        let source_end = self.source_end.unwrap_or(asset_duration);

        // Validate source range
        if !source_start.is_finite()
            || !source_end.is_finite()
            || source_start < 0.0
            || source_end < 0.0
        {
            return Err(CoreError::ValidationError(
                "Source range must be finite and non-negative".to_string(),
            ));
        }
        if source_start >= source_end {
            return Err(CoreError::InvalidTimeRange(source_start, source_end));
        }

        // Validate sequence and track exist
        let sequence = state
            .sequences
            .get_mut(&self.sequence_id)
            .ok_or_else(|| CoreError::SequenceNotFound(self.sequence_id.clone()))?;

        let track = sequence
            .tracks
            .iter_mut()
            .find(|t| t.id == self.track_id)
            .ok_or_else(|| CoreError::TrackNotFound(self.track_id.clone()))?;

        // Create the clip
        let duration = source_end - source_start;
        if !duration.is_finite() || duration <= 0.0 {
            return Err(CoreError::ValidationError(
                "Clip duration must be finite and > 0".to_string(),
            ));
        }
        let mut clip = Clip::new(&self.asset_id);
        clip.range = ClipRange {
            source_in_sec: source_start,
            source_out_sec: source_end,
        };
        clip.place = ClipPlace {
            timeline_in_sec: self.timeline_start,
            duration_sec: duration,
        };

        let clip_id = clip.id.clone();

        // Store created clip ID for undo
        self.created_clip_id = Some(clip_id.clone());

        // Prevent overlap and keep clips sorted.
        validate_no_overlap(track, &clip.place, None)?;
        insert_clip_sorted(track, clip);

        // Generate operation ID
        let op_id = ulid::Ulid::new().to_string();

        Ok(CommandResult::new(&op_id)
            .with_change(StateChange::ClipCreated {
                clip_id: clip_id.clone(),
            })
            .with_created_id(&clip_id))
    }

    fn undo(&self, state: &mut ProjectState) -> CoreResult<()> {
        // Use the stored clip ID for precise undo
        if let Some(ref clip_id) = self.created_clip_id {
            if let Some(sequence) = state.sequences.get_mut(&self.sequence_id) {
                if let Some(track) = sequence.tracks.iter_mut().find(|t| t.id == self.track_id) {
                    track.clips.retain(|c| &c.id != clip_id);
                }
            }
        }
        Ok(())
    }

    fn type_name(&self) -> &'static str {
        "InsertClip"
    }

    fn to_json(&self) -> serde_json::Value {
        serde_json::to_value(self).unwrap_or(serde_json::json!({}))
    }
}

// =============================================================================
// InsertEditCommand
// =============================================================================

/// Undo record for a clip that was shifted during an insert edit.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShiftedClipRecord {
    track_id: TrackId,
    clip_id: ClipId,
    original_timeline_in: TimeSec,
}

/// Undo record for a clip that was split at the insert position.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SplitClipRecord {
    track_id: TrackId,
    original_clip: Box<Clip>,
    fragment_clip_id: ClipId,
}

/// Command to insert a clip at the playhead and push all downstream clips right.
///
/// This is the "Insert Edit" mode used in professional NLEs (Premiere, Avid).
/// Unlike `InsertClipCommand` which rejects overlaps, this command shifts
/// downstream clips to make room for the new clip.
///
/// Sync-locked tracks (tracks with `sync_lock = true`) shift their downstream
/// clips in tandem, keeping multi-track alignment.  Locked tracks are never
/// modified.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InsertEditCommand {
    /// Target sequence ID
    pub sequence_id: SequenceId,
    /// Target track where the new clip is placed
    pub track_id: TrackId,
    /// Source asset ID
    pub asset_id: AssetId,
    /// Timeline position (playhead) to insert at
    pub timeline_position: TimeSec,
    /// Optional source start time (defaults to 0)
    pub source_start: Option<TimeSec>,
    /// Optional source end time (defaults to asset duration)
    pub source_end: Option<TimeSec>,

    // --- Undo state (populated during execute) ---
    /// ID of the clip created by this command
    #[serde(skip)]
    created_clip_id: Option<ClipId>,
    /// All clips that were shifted, with their original positions
    #[serde(skip)]
    shifted_clips: Vec<ShiftedClipRecord>,
    /// Clips that were split at the insert point, with the created fragment IDs
    #[serde(skip)]
    split_clips: Vec<SplitClipRecord>,
}

impl InsertEditCommand {
    /// Creates a new insert edit command.
    pub fn new(
        sequence_id: &str,
        track_id: &str,
        asset_id: &str,
        timeline_position: TimeSec,
    ) -> Self {
        Self {
            sequence_id: sequence_id.to_string(),
            track_id: track_id.to_string(),
            asset_id: asset_id.to_string(),
            timeline_position,
            source_start: None,
            source_end: None,
            created_clip_id: None,
            shifted_clips: Vec::new(),
            split_clips: Vec::new(),
        }
    }

    /// Sets the source range for partial-range inserts.
    pub fn with_source_range(mut self, start: TimeSec, end: TimeSec) -> Self {
        self.source_start = Some(start);
        self.source_end = Some(end);
        self
    }
}

impl Command for InsertEditCommand {
    fn execute(&mut self, state: &mut ProjectState) -> CoreResult<CommandResult> {
        // --- Validation ---
        if !is_valid_time_sec(self.timeline_position) {
            return Err(CoreError::ValidationError(
                "timelinePosition must be finite and non-negative".to_string(),
            ));
        }

        let asset = state
            .assets
            .get(&self.asset_id)
            .ok_or_else(|| CoreError::AssetNotFound(self.asset_id.clone()))?;

        let asset_duration = asset.duration_sec.unwrap_or(10.0);
        let source_start = self.source_start.unwrap_or(0.0);
        let source_end = self.source_end.unwrap_or(asset_duration);

        if !source_start.is_finite()
            || !source_end.is_finite()
            || source_start < 0.0
            || source_end < 0.0
        {
            return Err(CoreError::ValidationError(
                "Source range must be finite and non-negative".to_string(),
            ));
        }
        if source_start >= source_end {
            return Err(CoreError::InvalidTimeRange(source_start, source_end));
        }

        let clip_duration = source_end - source_start;
        if !clip_duration.is_finite() || clip_duration <= 0.0 {
            return Err(CoreError::ValidationError(
                "Clip duration must be finite and > 0".to_string(),
            ));
        }

        // Validate sequence exists
        let sequence = state
            .sequences
            .get(&self.sequence_id)
            .ok_or_else(|| CoreError::SequenceNotFound(self.sequence_id.clone()))?;

        // Validate target track exists and is not locked
        let target_track = sequence
            .tracks
            .iter()
            .find(|t| t.id == self.track_id)
            .ok_or_else(|| CoreError::TrackNotFound(self.track_id.clone()))?;

        validate_track_unlocked(target_track)?;

        // --- Collect split + shift records before mutation ---
        let mut shift_records: Vec<ShiftedClipRecord> = Vec::new();
        let mut split_candidates: Vec<(TrackId, Clip)> = Vec::new();

        for clip in &target_track.clips {
            let clip_start = clip.place.timeline_in_sec;
            let clip_end = clip.place.timeline_out_sec();

            if clip_start < self.timeline_position && clip_end > self.timeline_position {
                split_candidates.push((self.track_id.clone(), clip.clone()));
            } else if clip_start >= self.timeline_position {
                shift_records.push(ShiftedClipRecord {
                    track_id: self.track_id.clone(),
                    clip_id: clip.id.clone(),
                    original_timeline_in: clip_start,
                });
            }
        }

        // Sync-locked tracks: shift their downstream clips too
        for track in &sequence.tracks {
            if track.id == self.track_id || track.locked || !track.sync_lock {
                continue;
            }
            for clip in &track.clips {
                let clip_start = clip.place.timeline_in_sec;
                let clip_end = clip.place.timeline_out_sec();

                if clip_start < self.timeline_position && clip_end > self.timeline_position {
                    split_candidates.push((track.id.clone(), clip.clone()));
                } else if clip_start >= self.timeline_position {
                    shift_records.push(ShiftedClipRecord {
                        track_id: track.id.clone(),
                        clip_id: clip.id.clone(),
                        original_timeline_in: clip_start,
                    });
                }
            }
        }

        // --- Mutate state ---
        let sequence = state
            .sequences
            .get_mut(&self.sequence_id)
            .ok_or_else(|| CoreError::SequenceNotFound(self.sequence_id.clone()))?;

        // 1) Split clips that straddle the insert position, then move the right fragments.
        let mut split_records: Vec<SplitClipRecord> = Vec::new();
        let mut result_changes: Vec<StateChange> = Vec::new();

        for (track_id, original_clip) in split_candidates {
            let relative_split = self.timeline_position - original_clip.place.timeline_in_sec;
            let ((first_source_in, first_source_out), (second_source_in, second_source_out)) =
                split_clip_ranges_at(&original_clip, self.timeline_position);
            let right_duration = original_clip.place.timeline_out_sec() - self.timeline_position;

            if !relative_split.is_finite()
                || !right_duration.is_finite()
                || relative_split <= 0.0
                || right_duration <= 0.0
            {
                return Err(CoreError::ValidationError(
                    "Insert edit split produced an invalid clip duration".to_string(),
                ));
            }

            let fragment = clone_clip_fragment_with_rebased_time_remap(
                &original_clip,
                second_source_in,
                second_source_out,
                self.timeline_position + clip_duration,
                right_duration,
                relative_split,
            );
            let fragment_id = fragment.id.clone();

            let track = sequence
                .tracks
                .iter_mut()
                .find(|t| t.id == track_id)
                .ok_or_else(|| CoreError::TrackNotFound(track_id.clone()))?;
            let clip = track
                .clips
                .iter_mut()
                .find(|c| c.id == original_clip.id)
                .ok_or_else(|| CoreError::ClipNotFound(original_clip.id.clone()))?;

            clip.range.source_in_sec = first_source_in;
            clip.range.source_out_sec = first_source_out;
            clip.place.duration_sec = relative_split;
            insert_clip_sorted(track, fragment);

            split_records.push(SplitClipRecord {
                track_id: track_id.clone(),
                original_clip: Box::new(original_clip.clone()),
                fragment_clip_id: fragment_id.clone(),
            });
            result_changes.push(StateChange::ClipModified {
                clip_id: original_clip.id.clone(),
            });
            result_changes.push(StateChange::ClipCreated {
                clip_id: fragment_id,
            });
        }

        // 2) Shift downstream clips on all affected tracks
        for record in &shift_records {
            if let Some(track) = sequence.tracks.iter_mut().find(|t| t.id == record.track_id) {
                if let Some(clip) = track.clips.iter_mut().find(|c| c.id == record.clip_id) {
                    clip.place.timeline_in_sec += clip_duration;
                }
                sort_track_clips(track);
            }
        }

        // 3) Create and insert the new clip
        let mut new_clip = Clip::new(&self.asset_id);
        new_clip.range = ClipRange {
            source_in_sec: source_start,
            source_out_sec: source_end,
        };
        new_clip.place = ClipPlace {
            timeline_in_sec: self.timeline_position,
            duration_sec: clip_duration,
        };

        let clip_id = new_clip.id.clone();

        let target_track = sequence
            .tracks
            .iter_mut()
            .find(|t| t.id == self.track_id)
            .ok_or_else(|| CoreError::TrackNotFound(self.track_id.clone()))?;

        insert_clip_sorted(target_track, new_clip);

        // --- Store undo state ---
        self.created_clip_id = Some(clip_id.clone());
        self.shifted_clips = shift_records;
        self.split_clips = split_records;

        // --- Build result ---
        let op_id = ulid::Ulid::new().to_string();
        let mut result = CommandResult::new(&op_id)
            .with_change(StateChange::ClipCreated {
                clip_id: clip_id.clone(),
            })
            .with_created_id(&clip_id);

        for record in &self.shifted_clips {
            result = result.with_change(StateChange::ClipModified {
                clip_id: record.clip_id.clone(),
            });
        }

        for change in result_changes {
            result = result.with_change(change);
        }

        Ok(result)
    }

    fn undo(&self, state: &mut ProjectState) -> CoreResult<()> {
        let sequence = state
            .sequences
            .get_mut(&self.sequence_id)
            .ok_or_else(|| CoreError::SequenceNotFound(self.sequence_id.clone()))?;

        // 1) Remove the inserted clip
        if let Some(ref clip_id) = self.created_clip_id {
            if let Some(track) = sequence.tracks.iter_mut().find(|t| t.id == self.track_id) {
                track.clips.retain(|c| &c.id != clip_id);
            }
        }

        // 2) Remove split fragments and restore the original clips
        for record in &self.split_clips {
            if let Some(track) = sequence.tracks.iter_mut().find(|t| t.id == record.track_id) {
                track.clips.retain(|c| c.id != record.fragment_clip_id);

                if let Some(clip) = track
                    .clips
                    .iter_mut()
                    .find(|c| c.id == record.original_clip.id)
                {
                    *clip = (*record.original_clip).clone();
                } else {
                    insert_clip_sorted(track, (*record.original_clip).clone());
                }
            }
        }

        // 3) Restore all shifted clips to their original positions
        for record in &self.shifted_clips {
            if let Some(track) = sequence.tracks.iter_mut().find(|t| t.id == record.track_id) {
                if let Some(clip) = track.clips.iter_mut().find(|c| c.id == record.clip_id) {
                    clip.place.timeline_in_sec = record.original_timeline_in;
                }
                sort_track_clips(track);
            }
        }

        for record in &self.split_clips {
            if let Some(track) = sequence.tracks.iter_mut().find(|t| t.id == record.track_id) {
                sort_track_clips(track);
            }
        }

        Ok(())
    }

    fn type_name(&self) -> &'static str {
        "InsertEdit"
    }

    fn to_json(&self) -> serde_json::Value {
        serde_json::to_value(self).unwrap_or(serde_json::json!({}))
    }
}

// =============================================================================
// OverwriteEditCommand
// =============================================================================

/// Describes how a clip was modified during overwrite, for undo.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum OverwriteUndoAction {
    /// Clip was fully removed — undo restores it.
    Removed { clip: Box<Clip> },
    /// Clip was trimmed — undo restores original range and place.
    Trimmed {
        original_range: ClipRange,
        original_place: ClipPlace,
    },
    /// A fragment clip was created from splitting a spanning clip — undo removes it.
    FragmentCreated,
}

/// Per-clip undo record for the overwrite edit.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OverwriteUndoRecord {
    track_id: TrackId,
    clip_id: ClipId,
    action: OverwriteUndoAction,
}

/// Command to place a clip at a position, overwriting (trimming/removing) existing content.
///
/// This is the "Overwrite Edit" mode used in professional NLEs.
/// Unlike Insert Edit, this does NOT shift downstream clips — it replaces content
/// in the time range by trimming or removing overlapping clips.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverwriteEditCommand {
    /// Target sequence ID
    pub sequence_id: SequenceId,
    /// Target track ID
    pub track_id: TrackId,
    /// Source asset ID
    pub asset_id: AssetId,
    /// Timeline position (playhead) to place the clip
    pub timeline_position: TimeSec,
    /// Optional source start time (defaults to 0)
    pub source_start: Option<TimeSec>,
    /// Optional source end time (defaults to asset duration)
    pub source_end: Option<TimeSec>,

    // --- Undo state ---
    #[serde(skip)]
    created_clip_id: Option<ClipId>,
    #[serde(skip)]
    undo_records: Vec<OverwriteUndoRecord>,
}

impl OverwriteEditCommand {
    /// Creates a new overwrite edit command.
    pub fn new(
        sequence_id: &str,
        track_id: &str,
        asset_id: &str,
        timeline_position: TimeSec,
    ) -> Self {
        Self {
            sequence_id: sequence_id.to_string(),
            track_id: track_id.to_string(),
            asset_id: asset_id.to_string(),
            timeline_position,
            source_start: None,
            source_end: None,
            created_clip_id: None,
            undo_records: Vec::new(),
        }
    }

    /// Sets the source range for partial-range inserts.
    pub fn with_source_range(mut self, start: TimeSec, end: TimeSec) -> Self {
        self.source_start = Some(start);
        self.source_end = Some(end);
        self
    }
}

impl Command for OverwriteEditCommand {
    fn execute(&mut self, state: &mut ProjectState) -> CoreResult<CommandResult> {
        // --- Validation ---
        if !is_valid_time_sec(self.timeline_position) {
            return Err(CoreError::ValidationError(
                "timelinePosition must be finite and non-negative".to_string(),
            ));
        }

        let asset = state
            .assets
            .get(&self.asset_id)
            .ok_or_else(|| CoreError::AssetNotFound(self.asset_id.clone()))?;

        let asset_duration = asset.duration_sec.unwrap_or(10.0);
        let source_start = self.source_start.unwrap_or(0.0);
        let source_end = self.source_end.unwrap_or(asset_duration);

        if !source_start.is_finite()
            || !source_end.is_finite()
            || source_start < 0.0
            || source_end < 0.0
        {
            return Err(CoreError::ValidationError(
                "Source range must be finite and non-negative".to_string(),
            ));
        }
        if source_start >= source_end {
            return Err(CoreError::InvalidTimeRange(source_start, source_end));
        }

        let clip_duration = source_end - source_start;
        if !clip_duration.is_finite() || clip_duration <= 0.0 {
            return Err(CoreError::ValidationError(
                "Clip duration must be finite and > 0".to_string(),
            ));
        }

        let overwrite_start = self.timeline_position;
        let overwrite_end = self.timeline_position + clip_duration;

        // Validate sequence + track
        let sequence = state
            .sequences
            .get(&self.sequence_id)
            .ok_or_else(|| CoreError::SequenceNotFound(self.sequence_id.clone()))?;

        let track = sequence
            .tracks
            .iter()
            .find(|t| t.id == self.track_id)
            .ok_or_else(|| CoreError::TrackNotFound(self.track_id.clone()))?;

        if track.locked {
            return Err(CoreError::ValidationError(format!(
                "Track '{}' is locked",
                self.track_id
            )));
        }

        // --- Plan: identify all overlapping clips and classify actions ---
        // We collect actions before mutating to keep validation clean.
        struct OverwritePlan {
            clip_id: ClipId,
            action: PlannedAction,
        }

        enum PlannedAction {
            /// Clip fully covered → remove
            Remove,
            /// Clip extends past overwrite end → trim front
            TrimFront {
                new_timeline_in: TimeSec,
                new_source_in: TimeSec,
                new_duration: TimeSec,
            },
            /// Clip extends before overwrite start → trim back
            TrimBack {
                new_source_out: TimeSec,
                new_duration: TimeSec,
            },
            /// Clip spans entire overwrite range → trim back + create right fragment
            Split {
                left_new_source_out: TimeSec,
                left_new_duration: TimeSec,
                right_source_in: TimeSec,
                right_source_out: TimeSec,
                right_timeline_in: TimeSec,
                right_duration: TimeSec,
                right_asset_id: AssetId,
                right_clip_template: Box<Clip>,
            },
        }

        let mut plans: Vec<OverwritePlan> = Vec::new();

        for existing in &track.clips {
            let ex_start = existing.place.timeline_in_sec;
            let ex_end = existing.place.timeline_out_sec();

            // No overlap
            if ex_end <= overwrite_start || ex_start >= overwrite_end {
                continue;
            }

            let safe_speed = existing.safe_speed();

            if ex_start >= overwrite_start && ex_end <= overwrite_end {
                // Fully covered → remove
                plans.push(OverwritePlan {
                    clip_id: existing.id.clone(),
                    action: PlannedAction::Remove,
                });
            } else if ex_start < overwrite_start && ex_end > overwrite_end {
                // Spanning → split: trim left, create right fragment
                let left_new_duration = overwrite_start - ex_start;
                let left_new_source_out =
                    existing.range.source_in_sec + left_new_duration * safe_speed;

                let right_timeline_in = overwrite_end;
                let right_duration = ex_end - overwrite_end;
                let right_source_in =
                    existing.range.source_in_sec + (overwrite_end - ex_start) * safe_speed;
                let right_source_out = existing.range.source_out_sec;

                plans.push(OverwritePlan {
                    clip_id: existing.id.clone(),
                    action: PlannedAction::Split {
                        left_new_source_out,
                        left_new_duration,
                        right_source_in,
                        right_source_out,
                        right_timeline_in,
                        right_duration,
                        right_asset_id: existing.asset_id.clone(),
                        right_clip_template: Box::new(existing.clone()),
                    },
                });
            } else if ex_start < overwrite_start {
                // Overlaps on the left → trim back (shorten end)
                let new_duration = overwrite_start - ex_start;
                let new_source_out = existing.range.source_in_sec + new_duration * safe_speed;
                plans.push(OverwritePlan {
                    clip_id: existing.id.clone(),
                    action: PlannedAction::TrimBack {
                        new_source_out,
                        new_duration,
                    },
                });
            } else {
                // ex_start < overwrite_end && ex_end > overwrite_end
                // Overlaps on the right → trim front (shorten start)
                let trim_amount = overwrite_end - ex_start;
                let new_source_in = existing.range.source_in_sec + trim_amount * safe_speed;
                let new_duration = ex_end - overwrite_end;
                plans.push(OverwritePlan {
                    clip_id: existing.id.clone(),
                    action: PlannedAction::TrimFront {
                        new_timeline_in: overwrite_end,
                        new_source_in,
                        new_duration,
                    },
                });
            }
        }

        // --- Mutate state ---
        let sequence = state
            .sequences
            .get_mut(&self.sequence_id)
            .ok_or_else(|| CoreError::SequenceNotFound(self.sequence_id.clone()))?;

        let track = sequence
            .tracks
            .iter_mut()
            .find(|t| t.id == self.track_id)
            .ok_or_else(|| CoreError::TrackNotFound(self.track_id.clone()))?;

        let mut undo_records: Vec<OverwriteUndoRecord> = Vec::new();
        let mut result_changes: Vec<StateChange> = Vec::new();

        for plan in plans {
            match plan.action {
                PlannedAction::Remove => {
                    if let Some(pos) = track.clips.iter().position(|c| c.id == plan.clip_id) {
                        let removed = track.clips.remove(pos);
                        undo_records.push(OverwriteUndoRecord {
                            track_id: self.track_id.clone(),
                            clip_id: plan.clip_id.clone(),
                            action: OverwriteUndoAction::Removed {
                                clip: Box::new(removed),
                            },
                        });
                        result_changes.push(StateChange::ClipDeleted {
                            clip_id: plan.clip_id,
                        });
                    }
                }
                PlannedAction::TrimFront {
                    new_timeline_in,
                    new_source_in,
                    new_duration,
                } => {
                    if let Some(clip) = track.clips.iter_mut().find(|c| c.id == plan.clip_id) {
                        undo_records.push(OverwriteUndoRecord {
                            track_id: self.track_id.clone(),
                            clip_id: plan.clip_id.clone(),
                            action: OverwriteUndoAction::Trimmed {
                                original_range: clip.range.clone(),
                                original_place: clip.place.clone(),
                            },
                        });
                        clip.range.source_in_sec = new_source_in;
                        clip.place.timeline_in_sec = new_timeline_in;
                        clip.place.duration_sec = new_duration;
                        result_changes.push(StateChange::ClipModified {
                            clip_id: plan.clip_id,
                        });
                    }
                }
                PlannedAction::TrimBack {
                    new_source_out,
                    new_duration,
                } => {
                    if let Some(clip) = track.clips.iter_mut().find(|c| c.id == plan.clip_id) {
                        undo_records.push(OverwriteUndoRecord {
                            track_id: self.track_id.clone(),
                            clip_id: plan.clip_id.clone(),
                            action: OverwriteUndoAction::Trimmed {
                                original_range: clip.range.clone(),
                                original_place: clip.place.clone(),
                            },
                        });
                        clip.range.source_out_sec = new_source_out;
                        clip.place.duration_sec = new_duration;
                        result_changes.push(StateChange::ClipModified {
                            clip_id: plan.clip_id,
                        });
                    }
                }
                PlannedAction::Split {
                    left_new_source_out,
                    left_new_duration,
                    right_source_in,
                    right_source_out,
                    right_timeline_in,
                    right_duration,
                    right_asset_id,
                    right_clip_template,
                } => {
                    // Trim the left portion
                    if let Some(clip) = track.clips.iter_mut().find(|c| c.id == plan.clip_id) {
                        undo_records.push(OverwriteUndoRecord {
                            track_id: self.track_id.clone(),
                            clip_id: plan.clip_id.clone(),
                            action: OverwriteUndoAction::Trimmed {
                                original_range: clip.range.clone(),
                                original_place: clip.place.clone(),
                            },
                        });
                        clip.range.source_out_sec = left_new_source_out;
                        clip.place.duration_sec = left_new_duration;
                        result_changes.push(StateChange::ClipModified {
                            clip_id: plan.clip_id,
                        });
                    }

                    // Create right fragment with all properties from original
                    let mut fragment = Clip::new(&right_asset_id);
                    fragment.range = ClipRange {
                        source_in_sec: right_source_in,
                        source_out_sec: right_source_out,
                    };
                    fragment.place = ClipPlace {
                        timeline_in_sec: right_timeline_in,
                        duration_sec: right_duration,
                    };
                    // Preserve properties from the original clip
                    fragment.transform = right_clip_template.transform.clone();
                    fragment.opacity = right_clip_template.opacity;
                    fragment.blend_mode = right_clip_template.blend_mode.clone();
                    fragment.speed = right_clip_template.speed;
                    fragment.reverse = right_clip_template.reverse;
                    fragment.effects = right_clip_template.effects.clone();
                    fragment.audio = right_clip_template.audio.clone();
                    fragment.label = right_clip_template.label.clone();
                    fragment.color = right_clip_template.color.clone();
                    fragment.caption_style = right_clip_template.caption_style.clone();
                    fragment.caption_position = right_clip_template.caption_position.clone();

                    let fragment_id = fragment.id.clone();
                    undo_records.push(OverwriteUndoRecord {
                        track_id: self.track_id.clone(),
                        clip_id: fragment_id.clone(),
                        action: OverwriteUndoAction::FragmentCreated,
                    });
                    result_changes.push(StateChange::ClipCreated {
                        clip_id: fragment_id.clone(),
                    });
                    insert_clip_sorted(track, fragment);
                }
            }
        }

        // Insert the new overwrite clip
        let mut new_clip = Clip::new(&self.asset_id);
        new_clip.range = ClipRange {
            source_in_sec: source_start,
            source_out_sec: source_end,
        };
        new_clip.place = ClipPlace {
            timeline_in_sec: self.timeline_position,
            duration_sec: clip_duration,
        };
        let clip_id = new_clip.id.clone();
        insert_clip_sorted(track, new_clip);
        sort_track_clips(track);

        // Store undo state
        self.created_clip_id = Some(clip_id.clone());
        self.undo_records = undo_records;

        // Build result
        let op_id = ulid::Ulid::new().to_string();
        let mut result = CommandResult::new(&op_id)
            .with_change(StateChange::ClipCreated {
                clip_id: clip_id.clone(),
            })
            .with_created_id(&clip_id);

        for change in result_changes {
            result = result.with_change(change);
        }

        Ok(result)
    }

    fn undo(&self, state: &mut ProjectState) -> CoreResult<()> {
        let sequence = state
            .sequences
            .get_mut(&self.sequence_id)
            .ok_or_else(|| CoreError::SequenceNotFound(self.sequence_id.clone()))?;

        let track = sequence
            .tracks
            .iter_mut()
            .find(|t| t.id == self.track_id)
            .ok_or_else(|| CoreError::TrackNotFound(self.track_id.clone()))?;

        // 1) Remove the overwrite clip
        if let Some(ref clip_id) = self.created_clip_id {
            track.clips.retain(|c| &c.id != clip_id);
        }

        // 2) Reverse all undo records (process in reverse order for correct restoration)
        for record in self.undo_records.iter().rev() {
            match &record.action {
                OverwriteUndoAction::Removed { clip } => {
                    // Restore removed clip
                    insert_clip_sorted(track, *clip.clone());
                }
                OverwriteUndoAction::Trimmed {
                    original_range,
                    original_place,
                } => {
                    // Restore original range and place
                    if let Some(clip) = track.clips.iter_mut().find(|c| c.id == record.clip_id) {
                        clip.range = original_range.clone();
                        clip.place = original_place.clone();
                    }
                }
                OverwriteUndoAction::FragmentCreated => {
                    // Remove the fragment that was created during split
                    track.clips.retain(|c| c.id != record.clip_id);
                }
            }
        }

        sort_track_clips(track);
        Ok(())
    }

    fn type_name(&self) -> &'static str {
        "OverwriteEdit"
    }

    fn to_json(&self) -> serde_json::Value {
        serde_json::to_value(self).unwrap_or(serde_json::json!({}))
    }
}

// =============================================================================
// RippleDeleteCommand
// =============================================================================

/// Command to remove clip(s) and close the resulting gaps by shifting downstream clips left.
///
/// Sync-locked tracks shift their clips in tandem. Locked tracks are never modified.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RippleDeleteCommand {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    /// One or more clip IDs to remove.
    pub clip_ids: Vec<ClipId>,

    // --- Undo state ---
    #[serde(skip)]
    removed_clips: Vec<Clip>,
    #[serde(skip)]
    shifted_clips: Vec<ShiftedClipRecord>,
}

impl RippleDeleteCommand {
    pub fn new(sequence_id: &str, track_id: &str, clip_ids: Vec<String>) -> Self {
        Self {
            sequence_id: sequence_id.to_string(),
            track_id: track_id.to_string(),
            clip_ids,
            removed_clips: Vec::new(),
            shifted_clips: Vec::new(),
        }
    }
}

impl Command for RippleDeleteCommand {
    fn execute(&mut self, state: &mut ProjectState) -> CoreResult<CommandResult> {
        if self.clip_ids.is_empty() {
            return Err(CoreError::ValidationError(
                "No clip IDs provided for ripple delete".to_string(),
            ));
        }

        let sequence = state
            .sequences
            .get(&self.sequence_id)
            .ok_or_else(|| CoreError::SequenceNotFound(self.sequence_id.clone()))?;

        let track = sequence
            .tracks
            .iter()
            .find(|t| t.id == self.track_id)
            .ok_or_else(|| CoreError::TrackNotFound(self.track_id.clone()))?;

        if track.locked {
            return Err(CoreError::ValidationError(format!(
                "Track '{}' is locked",
                self.track_id
            )));
        }

        // Validate all clip IDs exist and collect them
        let mut clips_to_remove: Vec<Clip> = Vec::new();
        for clip_id in &self.clip_ids {
            let clip = track
                .clips
                .iter()
                .find(|c| &c.id == clip_id)
                .ok_or_else(|| CoreError::ClipNotFound(clip_id.clone()))?;
            clips_to_remove.push(clip.clone());
        }

        // Sort by timeline position for deterministic shift calculation
        clips_to_remove.sort_by(|a, b| a.place.timeline_in_sec.total_cmp(&b.place.timeline_in_sec));

        let earliest_remove_pos = clips_to_remove[0].place.timeline_in_sec;

        // Compute shift amount for each remaining clip:
        // shift = sum of durations of removed clips that were before this clip's position
        let compute_shift = |clip_start: TimeSec| -> TimeSec {
            clips_to_remove
                .iter()
                .filter(|c| c.place.timeline_in_sec < clip_start)
                .map(|c| c.place.duration_sec)
                .sum()
        };

        // Collect shift records for target track
        let mut shift_records: Vec<ShiftedClipRecord> = Vec::new();

        for clip in &track.clips {
            if self.clip_ids.contains(&clip.id) {
                continue;
            }
            let shift = compute_shift(clip.place.timeline_in_sec);
            if shift > 0.0 {
                shift_records.push(ShiftedClipRecord {
                    track_id: self.track_id.clone(),
                    clip_id: clip.id.clone(),
                    original_timeline_in: clip.place.timeline_in_sec,
                });
            }
        }

        // Sync-locked tracks: shift downstream clips by total removed duration
        let total_removed_duration: TimeSec =
            clips_to_remove.iter().map(|c| c.place.duration_sec).sum();

        for other_track in &sequence.tracks {
            if other_track.id == self.track_id || other_track.locked || !other_track.sync_lock {
                continue;
            }
            for clip in &other_track.clips {
                if clip.place.timeline_in_sec >= earliest_remove_pos {
                    shift_records.push(ShiftedClipRecord {
                        track_id: other_track.id.clone(),
                        clip_id: clip.id.clone(),
                        original_timeline_in: clip.place.timeline_in_sec,
                    });
                }
            }
        }

        // --- Mutate state ---
        let sequence = state
            .sequences
            .get_mut(&self.sequence_id)
            .ok_or_else(|| CoreError::SequenceNotFound(self.sequence_id.clone()))?;

        // 1) Remove clips from target track
        let target_track = sequence
            .tracks
            .iter_mut()
            .find(|t| t.id == self.track_id)
            .ok_or_else(|| CoreError::TrackNotFound(self.track_id.clone()))?;

        target_track
            .clips
            .retain(|c| !self.clip_ids.contains(&c.id));

        // 2) Shift downstream clips on target track
        for record in &shift_records {
            if record.track_id != self.track_id {
                continue;
            }
            if let Some(clip) = target_track
                .clips
                .iter_mut()
                .find(|c| c.id == record.clip_id)
            {
                let shift = compute_shift(record.original_timeline_in);
                clip.place.timeline_in_sec -= shift;
            }
        }
        sort_track_clips(target_track);

        // 3) Shift sync-locked tracks
        for record in &shift_records {
            if record.track_id == self.track_id {
                continue;
            }
            if let Some(track) = sequence.tracks.iter_mut().find(|t| t.id == record.track_id) {
                if let Some(clip) = track.clips.iter_mut().find(|c| c.id == record.clip_id) {
                    clip.place.timeline_in_sec -= total_removed_duration;
                }
                sort_track_clips(track);
            }
        }

        // Store undo state
        self.removed_clips = clips_to_remove;
        self.shifted_clips = shift_records;

        // Build result
        let op_id = ulid::Ulid::new().to_string();
        let mut result = CommandResult::new(&op_id);
        for clip in &self.removed_clips {
            result = result
                .with_change(StateChange::ClipDeleted {
                    clip_id: clip.id.clone(),
                })
                .with_deleted_id(&clip.id);
        }
        for record in &self.shifted_clips {
            result = result.with_change(StateChange::ClipModified {
                clip_id: record.clip_id.clone(),
            });
        }

        Ok(result)
    }

    fn undo(&self, state: &mut ProjectState) -> CoreResult<()> {
        let sequence = state
            .sequences
            .get_mut(&self.sequence_id)
            .ok_or_else(|| CoreError::SequenceNotFound(self.sequence_id.clone()))?;

        // 1) Restore shifted clips to original positions
        for record in self.shifted_clips.iter().rev() {
            if let Some(track) = sequence.tracks.iter_mut().find(|t| t.id == record.track_id) {
                if let Some(clip) = track.clips.iter_mut().find(|c| c.id == record.clip_id) {
                    clip.place.timeline_in_sec = record.original_timeline_in;
                }
                sort_track_clips(track);
            }
        }

        // 2) Re-insert removed clips
        if let Some(track) = sequence.tracks.iter_mut().find(|t| t.id == self.track_id) {
            for clip in &self.removed_clips {
                insert_clip_sorted(track, clip.clone());
            }
        }

        Ok(())
    }

    fn type_name(&self) -> &'static str {
        "RippleDelete"
    }

    fn to_json(&self) -> serde_json::Value {
        serde_json::to_value(self).unwrap_or(serde_json::json!({}))
    }
}

// =============================================================================
// LiftCommand
// =============================================================================

/// Command to remove clip(s) leaving the gap intact (no ripple shift).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiftCommand {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    /// One or more clip IDs to remove.
    pub clip_ids: Vec<ClipId>,

    // --- Undo state ---
    #[serde(skip)]
    removed_clips: Vec<Clip>,
}

impl LiftCommand {
    pub fn new(sequence_id: &str, track_id: &str, clip_ids: Vec<String>) -> Self {
        Self {
            sequence_id: sequence_id.to_string(),
            track_id: track_id.to_string(),
            clip_ids,
            removed_clips: Vec::new(),
        }
    }
}

impl Command for LiftCommand {
    fn execute(&mut self, state: &mut ProjectState) -> CoreResult<CommandResult> {
        if self.clip_ids.is_empty() {
            return Err(CoreError::ValidationError(
                "No clip IDs provided for lift".to_string(),
            ));
        }

        let sequence = state
            .sequences
            .get_mut(&self.sequence_id)
            .ok_or_else(|| CoreError::SequenceNotFound(self.sequence_id.clone()))?;

        let track = sequence
            .tracks
            .iter_mut()
            .find(|t| t.id == self.track_id)
            .ok_or_else(|| CoreError::TrackNotFound(self.track_id.clone()))?;

        if track.locked {
            return Err(CoreError::ValidationError(format!(
                "Track '{}' is locked",
                self.track_id
            )));
        }

        // Validate and collect clips to remove
        let mut removed: Vec<Clip> = Vec::new();
        for clip_id in &self.clip_ids {
            let clip = track
                .clips
                .iter()
                .find(|c| &c.id == clip_id)
                .ok_or_else(|| CoreError::ClipNotFound(clip_id.clone()))?
                .clone();
            removed.push(clip);
        }

        // Remove clips
        track.clips.retain(|c| !self.clip_ids.contains(&c.id));

        self.removed_clips = removed;

        let op_id = ulid::Ulid::new().to_string();
        let mut result = CommandResult::new(&op_id);
        for clip in &self.removed_clips {
            result = result
                .with_change(StateChange::ClipDeleted {
                    clip_id: clip.id.clone(),
                })
                .with_deleted_id(&clip.id);
        }

        Ok(result)
    }

    fn undo(&self, state: &mut ProjectState) -> CoreResult<()> {
        let sequence = state
            .sequences
            .get_mut(&self.sequence_id)
            .ok_or_else(|| CoreError::SequenceNotFound(self.sequence_id.clone()))?;

        let track = sequence
            .tracks
            .iter_mut()
            .find(|t| t.id == self.track_id)
            .ok_or_else(|| CoreError::TrackNotFound(self.track_id.clone()))?;

        for clip in &self.removed_clips {
            insert_clip_sorted(track, clip.clone());
        }

        Ok(())
    }

    fn type_name(&self) -> &'static str {
        "Lift"
    }

    fn to_json(&self) -> serde_json::Value {
        serde_json::to_value(self).unwrap_or(serde_json::json!({}))
    }
}

// =============================================================================
// ExtractEditCommand
// =============================================================================

/// Command to remove content in an In/Out range and close the resulting gap.
///
/// Combines overwrite-style trimming (trim/split/remove clips in range) with
/// ripple-style gap closing (shift downstream clips left).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractEditCommand {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    /// Start of the extraction range (In point).
    pub in_point: TimeSec,
    /// End of the extraction range (Out point).
    pub out_point: TimeSec,

    // --- Undo state ---
    #[serde(skip)]
    undo_records: Vec<OverwriteUndoRecord>,
    #[serde(skip)]
    shifted_clips: Vec<ShiftedClipRecord>,
}

impl ExtractEditCommand {
    pub fn new(sequence_id: &str, track_id: &str, in_point: TimeSec, out_point: TimeSec) -> Self {
        Self {
            sequence_id: sequence_id.to_string(),
            track_id: track_id.to_string(),
            in_point,
            out_point,
            undo_records: Vec::new(),
            shifted_clips: Vec::new(),
        }
    }
}

impl Command for ExtractEditCommand {
    fn execute(&mut self, state: &mut ProjectState) -> CoreResult<CommandResult> {
        if !is_valid_time_sec(self.in_point) || !is_valid_time_sec(self.out_point) {
            return Err(CoreError::ValidationError(
                "In/Out points must be finite and non-negative".to_string(),
            ));
        }
        if self.in_point >= self.out_point {
            return Err(CoreError::InvalidTimeRange(self.in_point, self.out_point));
        }

        let extract_duration = self.out_point - self.in_point;

        let sequence = state
            .sequences
            .get(&self.sequence_id)
            .ok_or_else(|| CoreError::SequenceNotFound(self.sequence_id.clone()))?;

        let track = sequence
            .tracks
            .iter()
            .find(|t| t.id == self.track_id)
            .ok_or_else(|| CoreError::TrackNotFound(self.track_id.clone()))?;

        if track.locked {
            return Err(CoreError::ValidationError(format!(
                "Track '{}' is locked",
                self.track_id
            )));
        }

        // --- Phase 1: Plan trim/split/remove for content in range ---
        struct ExtractPlan {
            clip_id: ClipId,
            action: ExtractAction,
        }

        #[allow(clippy::large_enum_variant)]
        enum ExtractAction {
            Remove,
            TrimFront {
                new_timeline_in: TimeSec,
                new_source_in: TimeSec,
                new_duration: TimeSec,
            },
            TrimBack {
                new_source_out: TimeSec,
                new_duration: TimeSec,
            },
            Split {
                left_new_source_out: TimeSec,
                left_new_duration: TimeSec,
                right_source_in: TimeSec,
                right_source_out: TimeSec,
                right_timeline_in: TimeSec,
                right_duration: TimeSec,
                right_clip_template: Box<Clip>,
            },
        }

        let mut plans: Vec<ExtractPlan> = Vec::new();

        for existing in &track.clips {
            let ex_start = existing.place.timeline_in_sec;
            let ex_end = existing.place.timeline_out_sec();

            if ex_end <= self.in_point || ex_start >= self.out_point {
                continue;
            }

            let safe_speed = existing.safe_speed();

            if ex_start >= self.in_point && ex_end <= self.out_point {
                plans.push(ExtractPlan {
                    clip_id: existing.id.clone(),
                    action: ExtractAction::Remove,
                });
            } else if ex_start < self.in_point && ex_end > self.out_point {
                let left_new_duration = self.in_point - ex_start;
                let left_new_source_out =
                    existing.range.source_in_sec + left_new_duration * safe_speed;
                let right_timeline_in = self.out_point;
                let right_duration = ex_end - self.out_point;
                let right_source_in =
                    existing.range.source_in_sec + (self.out_point - ex_start) * safe_speed;

                plans.push(ExtractPlan {
                    clip_id: existing.id.clone(),
                    action: ExtractAction::Split {
                        left_new_source_out,
                        left_new_duration,
                        right_source_in,
                        right_source_out: existing.range.source_out_sec,
                        right_timeline_in,
                        right_duration,
                        right_clip_template: Box::new(existing.clone()),
                    },
                });
            } else if ex_start < self.in_point {
                let new_duration = self.in_point - ex_start;
                let new_source_out = existing.range.source_in_sec + new_duration * safe_speed;
                plans.push(ExtractPlan {
                    clip_id: existing.id.clone(),
                    action: ExtractAction::TrimBack {
                        new_source_out,
                        new_duration,
                    },
                });
            } else {
                let trim_amount = self.out_point - ex_start;
                let new_source_in = existing.range.source_in_sec + trim_amount * safe_speed;
                let new_duration = ex_end - self.out_point;
                plans.push(ExtractPlan {
                    clip_id: existing.id.clone(),
                    action: ExtractAction::TrimFront {
                        new_timeline_in: self.out_point,
                        new_source_in,
                        new_duration,
                    },
                });
            }
        }

        // --- Phase 2: Collect shift records ---
        let plan_clip_ids: Vec<ClipId> = plans.iter().map(|p| p.clip_id.clone()).collect();
        let mut shift_records: Vec<ShiftedClipRecord> = Vec::new();

        for clip in &track.clips {
            if clip.place.timeline_in_sec >= self.out_point && !plan_clip_ids.contains(&clip.id) {
                shift_records.push(ShiftedClipRecord {
                    track_id: self.track_id.clone(),
                    clip_id: clip.id.clone(),
                    original_timeline_in: clip.place.timeline_in_sec,
                });
            }
        }

        // Sync-locked tracks
        for other_track in &sequence.tracks {
            if other_track.id == self.track_id || other_track.locked || !other_track.sync_lock {
                continue;
            }
            for clip in &other_track.clips {
                if clip.place.timeline_in_sec >= self.in_point {
                    shift_records.push(ShiftedClipRecord {
                        track_id: other_track.id.clone(),
                        clip_id: clip.id.clone(),
                        original_timeline_in: clip.place.timeline_in_sec,
                    });
                }
            }
        }

        // --- Phase 3: Mutate state ---
        let sequence = state
            .sequences
            .get_mut(&self.sequence_id)
            .ok_or_else(|| CoreError::SequenceNotFound(self.sequence_id.clone()))?;

        let track = sequence
            .tracks
            .iter_mut()
            .find(|t| t.id == self.track_id)
            .ok_or_else(|| CoreError::TrackNotFound(self.track_id.clone()))?;

        let mut undo_records: Vec<OverwriteUndoRecord> = Vec::new();
        let mut result_changes: Vec<StateChange> = Vec::new();

        for plan in plans {
            match plan.action {
                ExtractAction::Remove => {
                    if let Some(pos) = track.clips.iter().position(|c| c.id == plan.clip_id) {
                        let removed = track.clips.remove(pos);
                        undo_records.push(OverwriteUndoRecord {
                            track_id: self.track_id.clone(),
                            clip_id: plan.clip_id.clone(),
                            action: OverwriteUndoAction::Removed {
                                clip: Box::new(removed),
                            },
                        });
                        result_changes.push(StateChange::ClipDeleted {
                            clip_id: plan.clip_id,
                        });
                    }
                }
                ExtractAction::TrimFront {
                    new_timeline_in,
                    new_source_in,
                    new_duration,
                } => {
                    if let Some(clip) = track.clips.iter_mut().find(|c| c.id == plan.clip_id) {
                        undo_records.push(OverwriteUndoRecord {
                            track_id: self.track_id.clone(),
                            clip_id: plan.clip_id.clone(),
                            action: OverwriteUndoAction::Trimmed {
                                original_range: clip.range.clone(),
                                original_place: clip.place.clone(),
                            },
                        });
                        clip.range.source_in_sec = new_source_in;
                        clip.place.timeline_in_sec = new_timeline_in;
                        clip.place.duration_sec = new_duration;
                        // This clip also shifts left
                        shift_records.push(ShiftedClipRecord {
                            track_id: self.track_id.clone(),
                            clip_id: plan.clip_id.clone(),
                            original_timeline_in: new_timeline_in,
                        });
                        result_changes.push(StateChange::ClipModified {
                            clip_id: plan.clip_id,
                        });
                    }
                }
                ExtractAction::TrimBack {
                    new_source_out,
                    new_duration,
                } => {
                    if let Some(clip) = track.clips.iter_mut().find(|c| c.id == plan.clip_id) {
                        undo_records.push(OverwriteUndoRecord {
                            track_id: self.track_id.clone(),
                            clip_id: plan.clip_id.clone(),
                            action: OverwriteUndoAction::Trimmed {
                                original_range: clip.range.clone(),
                                original_place: clip.place.clone(),
                            },
                        });
                        clip.range.source_out_sec = new_source_out;
                        clip.place.duration_sec = new_duration;
                        result_changes.push(StateChange::ClipModified {
                            clip_id: plan.clip_id,
                        });
                    }
                }
                ExtractAction::Split {
                    left_new_source_out,
                    left_new_duration,
                    right_source_in,
                    right_source_out,
                    right_timeline_in,
                    right_duration,
                    right_clip_template,
                } => {
                    if let Some(clip) = track.clips.iter_mut().find(|c| c.id == plan.clip_id) {
                        undo_records.push(OverwriteUndoRecord {
                            track_id: self.track_id.clone(),
                            clip_id: plan.clip_id.clone(),
                            action: OverwriteUndoAction::Trimmed {
                                original_range: clip.range.clone(),
                                original_place: clip.place.clone(),
                            },
                        });
                        clip.range.source_out_sec = left_new_source_out;
                        clip.place.duration_sec = left_new_duration;
                        result_changes.push(StateChange::ClipModified {
                            clip_id: plan.clip_id,
                        });
                    }

                    let fragment = clone_clip_fragment(
                        &right_clip_template,
                        right_source_in,
                        right_source_out,
                        right_timeline_in,
                        right_duration,
                    );

                    let fragment_id = fragment.id.clone();

                    shift_records.push(ShiftedClipRecord {
                        track_id: self.track_id.clone(),
                        clip_id: fragment_id.clone(),
                        original_timeline_in: right_timeline_in,
                    });
                    undo_records.push(OverwriteUndoRecord {
                        track_id: self.track_id.clone(),
                        clip_id: fragment_id.clone(),
                        action: OverwriteUndoAction::FragmentCreated,
                    });
                    result_changes.push(StateChange::ClipCreated {
                        clip_id: fragment_id,
                    });
                    insert_clip_sorted(track, fragment);
                }
            }
        }

        // Ripple: shift downstream clips left by extract_duration
        for record in &shift_records {
            if record.track_id == self.track_id {
                if let Some(clip) = track.clips.iter_mut().find(|c| c.id == record.clip_id) {
                    clip.place.timeline_in_sec -= extract_duration;
                }
            }
        }
        sort_track_clips(track);

        // Shift sync-locked tracks
        for record in &shift_records {
            if record.track_id == self.track_id {
                continue;
            }
            if let Some(other) = sequence.tracks.iter_mut().find(|t| t.id == record.track_id) {
                if let Some(clip) = other.clips.iter_mut().find(|c| c.id == record.clip_id) {
                    clip.place.timeline_in_sec -= extract_duration;
                }
                sort_track_clips(other);
            }
        }

        self.undo_records = undo_records;
        self.shifted_clips = shift_records;

        let op_id = ulid::Ulid::new().to_string();
        let mut result = CommandResult::new(&op_id);
        let mut emitted_modified_clip_ids = HashSet::new();
        for change in result_changes {
            if let StateChange::ClipModified { clip_id } = &change {
                emitted_modified_clip_ids.insert(clip_id.clone());
            }
            result = result.with_change(change);
        }
        for record in &self.shifted_clips {
            if emitted_modified_clip_ids.insert(record.clip_id.clone()) {
                result = result.with_change(StateChange::ClipModified {
                    clip_id: record.clip_id.clone(),
                });
            }
        }

        Ok(result)
    }

    fn undo(&self, state: &mut ProjectState) -> CoreResult<()> {
        let extract_duration = self.out_point - self.in_point;
        let sequence = state
            .sequences
            .get_mut(&self.sequence_id)
            .ok_or_else(|| CoreError::SequenceNotFound(self.sequence_id.clone()))?;

        // 1) Restore shifted clips to original positions (reverse order)
        for record in self.shifted_clips.iter().rev() {
            if let Some(track) = sequence.tracks.iter_mut().find(|t| t.id == record.track_id) {
                if let Some(clip) = track.clips.iter_mut().find(|c| c.id == record.clip_id) {
                    clip.place.timeline_in_sec += extract_duration;
                }
                sort_track_clips(track);
            }
        }

        // 2) Reverse extraction undo records
        let track = sequence
            .tracks
            .iter_mut()
            .find(|t| t.id == self.track_id)
            .ok_or_else(|| CoreError::TrackNotFound(self.track_id.clone()))?;

        for record in self.undo_records.iter().rev() {
            match &record.action {
                OverwriteUndoAction::Removed { clip } => {
                    insert_clip_sorted(track, *clip.clone());
                }
                OverwriteUndoAction::Trimmed {
                    original_range,
                    original_place,
                } => {
                    if let Some(clip) = track.clips.iter_mut().find(|c| c.id == record.clip_id) {
                        clip.range = original_range.clone();
                        clip.place = original_place.clone();
                    }
                }
                OverwriteUndoAction::FragmentCreated => {
                    track.clips.retain(|c| c.id != record.clip_id);
                }
            }
        }
        sort_track_clips(track);

        Ok(())
    }

    fn type_name(&self) -> &'static str {
        "ExtractEdit"
    }

    fn to_json(&self) -> serde_json::Value {
        serde_json::to_value(self).unwrap_or(serde_json::json!({}))
    }
}

// =============================================================================
// RemoveClipCommand
// =============================================================================

/// Command to remove a clip from a track
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveClipCommand {
    /// Target sequence ID
    pub sequence_id: SequenceId,
    /// Target track ID
    pub track_id: TrackId,
    /// Clip ID to remove
    pub clip_id: ClipId,
    /// Stored clip data for undo
    #[serde(skip)]
    removed_clip: Option<Clip>,
    /// Original position in track (for undo)
    #[serde(skip)]
    original_position: Option<usize>,
}

impl RemoveClipCommand {
    /// Creates a new remove clip command
    pub fn new(sequence_id: &str, track_id: &str, clip_id: &str) -> Self {
        Self {
            sequence_id: sequence_id.to_string(),
            track_id: track_id.to_string(),
            clip_id: clip_id.to_string(),
            removed_clip: None,
            original_position: None,
        }
    }
}

impl Command for RemoveClipCommand {
    fn execute(&mut self, state: &mut ProjectState) -> CoreResult<CommandResult> {
        let sequence = state
            .sequences
            .get_mut(&self.sequence_id)
            .ok_or_else(|| CoreError::SequenceNotFound(self.sequence_id.clone()))?;

        let track = sequence
            .tracks
            .iter_mut()
            .find(|t| t.id == self.track_id)
            .ok_or_else(|| CoreError::TrackNotFound(self.track_id.clone()))?;

        let clip_pos = track
            .clips
            .iter()
            .position(|c| c.id == self.clip_id)
            .ok_or_else(|| CoreError::ClipNotFound(self.clip_id.clone()))?;

        // Store the clip and position before removal for undo
        self.removed_clip = Some(track.clips[clip_pos].clone());
        self.original_position = Some(clip_pos);

        track.clips.remove(clip_pos);

        let op_id = ulid::Ulid::new().to_string();

        Ok(CommandResult::new(&op_id)
            .with_change(StateChange::ClipDeleted {
                clip_id: self.clip_id.clone(),
            })
            .with_deleted_id(&self.clip_id))
    }

    fn undo(&self, state: &mut ProjectState) -> CoreResult<()> {
        if let (Some(clip), Some(position)) = (&self.removed_clip, self.original_position) {
            if let Some(sequence) = state.sequences.get_mut(&self.sequence_id) {
                if let Some(track) = sequence.tracks.iter_mut().find(|t| t.id == self.track_id) {
                    // Insert at original position if possible
                    if position <= track.clips.len() {
                        track.clips.insert(position, clip.clone());
                    } else {
                        track.clips.push(clip.clone());
                    }

                    // Keep deterministic ordering.
                    sort_track_clips(track);
                }
            }
        }
        Ok(())
    }

    fn type_name(&self) -> &'static str {
        "RemoveClip"
    }

    fn to_json(&self) -> serde_json::Value {
        serde_json::to_value(self).unwrap_or(serde_json::json!({}))
    }
}

// =============================================================================
// MoveClipCommand
// =============================================================================

/// Command to move a clip to a new position
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveClipCommand {
    /// Target sequence ID
    pub sequence_id: SequenceId,
    /// Clip ID to move
    pub clip_id: ClipId,
    /// New timeline position
    pub new_timeline_in: TimeSec,
    /// New track ID (optional, for cross-track moves)
    pub new_track_id: Option<TrackId>,
    /// Previous timeline position (for undo)
    #[serde(skip)]
    old_timeline_in: Option<TimeSec>,
    /// Previous track ID (for undo)
    #[serde(skip)]
    old_track_id: Option<TrackId>,
}

impl MoveClipCommand {
    /// Creates a new move clip command (simple version without track)
    pub fn new_simple(sequence_id: &str, clip_id: &str, new_timeline_in: TimeSec) -> Self {
        Self {
            sequence_id: sequence_id.to_string(),
            clip_id: clip_id.to_string(),
            new_timeline_in,
            new_track_id: None,
            old_timeline_in: None,
            old_track_id: None,
        }
    }

    /// Creates a new move clip command with optional cross-track move
    pub fn new(
        sequence_id: &str,
        _track_id: &str, // Source track (used for validation, not stored)
        clip_id: &str,
        new_timeline_in: TimeSec,
        new_track_id: Option<String>,
    ) -> Self {
        Self {
            sequence_id: sequence_id.to_string(),
            clip_id: clip_id.to_string(),
            new_timeline_in,
            new_track_id,
            old_timeline_in: None,
            old_track_id: None,
        }
    }

    /// Sets the target track for cross-track moves
    pub fn to_track(mut self, track_id: &str) -> Self {
        self.new_track_id = Some(track_id.to_string());
        self
    }
}

impl Command for MoveClipCommand {
    fn execute(&mut self, state: &mut ProjectState) -> CoreResult<CommandResult> {
        if !is_valid_time_sec(self.new_timeline_in) {
            return Err(CoreError::ValidationError(
                "newTimelineIn must be finite and non-negative".to_string(),
            ));
        }

        let sequence = state
            .sequences
            .get_mut(&self.sequence_id)
            .ok_or_else(|| CoreError::SequenceNotFound(self.sequence_id.clone()))?;

        // Find the source track containing this clip
        let (src_track_idx, clip_idx) = sequence
            .tracks
            .iter()
            .enumerate()
            .find_map(|(t_idx, track)| {
                track
                    .clips
                    .iter()
                    .position(|c| c.id == self.clip_id)
                    .map(|c_idx| (t_idx, c_idx))
            })
            .ok_or_else(|| CoreError::ClipNotFound(self.clip_id.clone()))?;

        let old_track_id = sequence.tracks[src_track_idx].id.clone();
        let old_timeline_in = sequence.tracks[src_track_idx].clips[clip_idx]
            .place
            .timeline_in_sec;

        self.old_track_id = Some(old_track_id.clone());
        self.old_timeline_in = Some(old_timeline_in);

        // Resolve destination track
        let dest_track_idx = if let Some(new_track_id) = &self.new_track_id {
            sequence
                .tracks
                .iter()
                .position(|t| &t.id == new_track_id)
                .ok_or_else(|| CoreError::TrackNotFound(new_track_id.clone()))?
        } else {
            src_track_idx
        };

        // Validate overlap BEFORE mutating state.
        let mut candidate = sequence.tracks[src_track_idx].clips[clip_idx].clone();
        candidate.place.timeline_in_sec = self.new_timeline_in;

        if dest_track_idx == src_track_idx {
            let track = &sequence.tracks[src_track_idx];
            validate_no_overlap(track, &candidate.place, Some(&candidate.id))?;
        } else {
            let dest_track = &sequence.tracks[dest_track_idx];
            validate_no_overlap(dest_track, &candidate.place, None)?;
        }

        // Apply move.
        let mut clip = sequence.tracks[src_track_idx].clips.remove(clip_idx);
        clip.place.timeline_in_sec = self.new_timeline_in;

        if dest_track_idx == src_track_idx {
            insert_clip_sorted(&mut sequence.tracks[src_track_idx], clip);
        } else {
            // Borrow both tracks mutably using split_at_mut.
            if src_track_idx < dest_track_idx {
                let (left, right) = sequence.tracks.split_at_mut(dest_track_idx);
                let dest_track = &mut right[0];
                insert_clip_sorted(dest_track, clip);
                // left[src_track_idx] already had the clip removed.
                sort_track_clips(&mut left[src_track_idx]);
            } else {
                let (left, right) = sequence.tracks.split_at_mut(src_track_idx);
                let dest_track = &mut left[dest_track_idx];
                insert_clip_sorted(dest_track, clip);
                sort_track_clips(&mut right[0]);
            }
        }

        let op_id = ulid::Ulid::new().to_string();
        Ok(
            CommandResult::new(&op_id).with_change(StateChange::ClipModified {
                clip_id: self.clip_id.clone(),
            }),
        )
    }

    fn undo(&self, state: &mut ProjectState) -> CoreResult<()> {
        let (old_pos, old_track) = match (&self.old_timeline_in, &self.old_track_id) {
            (Some(pos), Some(track)) => (*pos, track.clone()),
            _ => return Ok(()),
        };

        let Some(sequence) = state.sequences.get_mut(&self.sequence_id) else {
            return Ok(());
        };

        // Find the current track containing the clip.
        let (current_track_idx, clip_idx) = sequence
            .tracks
            .iter()
            .enumerate()
            .find_map(|(t_idx, track)| {
                track
                    .clips
                    .iter()
                    .position(|c| c.id == self.clip_id)
                    .map(|c_idx| (t_idx, c_idx))
            })
            .unwrap_or((usize::MAX, usize::MAX));

        if current_track_idx == usize::MAX {
            return Ok(());
        }

        // If the original track differs (cross-track move), physically move the clip back.
        if old_track != sequence.tracks[current_track_idx].id {
            let Some(orig_idx) = sequence.tracks.iter().position(|t| t.id == old_track) else {
                return Ok(());
            };

            let mut clip = sequence.tracks[current_track_idx].clips.remove(clip_idx);
            clip.place.timeline_in_sec = old_pos;

            match current_track_idx.cmp(&orig_idx) {
                std::cmp::Ordering::Less => {
                    let (left, right) = sequence.tracks.split_at_mut(orig_idx);
                    insert_clip_sorted(&mut right[0], clip);
                    sort_track_clips(&mut left[current_track_idx]);
                }
                std::cmp::Ordering::Greater => {
                    let (left, right) = sequence.tracks.split_at_mut(current_track_idx);
                    insert_clip_sorted(&mut left[orig_idx], clip);
                    sort_track_clips(&mut right[0]);
                }
                std::cmp::Ordering::Equal => {
                    // Shouldn't happen, but keep it safe.
                    insert_clip_sorted(&mut sequence.tracks[orig_idx], clip);
                }
            }

            return Ok(());
        }

        // Same-track undo: restore timeline position and keep ordering deterministic.
        if let Some(clip) = sequence.tracks[current_track_idx]
            .clips
            .iter_mut()
            .find(|c| c.id == self.clip_id)
        {
            clip.place.timeline_in_sec = old_pos;
            sort_track_clips(&mut sequence.tracks[current_track_idx]);
        }

        Ok(())
    }

    fn type_name(&self) -> &'static str {
        "MoveClip"
    }

    fn to_json(&self) -> serde_json::Value {
        serde_json::to_value(self).unwrap_or(serde_json::json!({}))
    }

    fn can_merge(&self, other: &dyn Command) -> bool {
        if other.type_name() == "MoveClip" {
            // Could merge consecutive moves of the same clip
            // This would be useful for drag operations
            false // For now, don't merge
        } else {
            false
        }
    }
}

// =============================================================================
// TrimClipCommand
// =============================================================================

/// Command to trim a clip (change source in/out points)
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrimClipCommand {
    /// Target sequence ID
    pub sequence_id: SequenceId,
    /// Clip ID to trim
    pub clip_id: ClipId,
    /// New source in point (optional)
    pub new_source_in: Option<TimeSec>,
    /// New source out point (optional)
    pub new_source_out: Option<TimeSec>,
    /// New timeline in point (optional, for ripple trim)
    pub new_timeline_in: Option<TimeSec>,
    /// Previous values for undo
    #[serde(skip)]
    old_source_in: Option<TimeSec>,
    #[serde(skip)]
    old_source_out: Option<TimeSec>,
    #[serde(skip)]
    old_timeline_in: Option<TimeSec>,
    #[serde(skip)]
    old_duration_sec: Option<TimeSec>,
}

impl TrimClipCommand {
    /// Creates a new trim clip command (simple version)
    pub fn new_simple(sequence_id: &str, clip_id: &str) -> Self {
        Self {
            sequence_id: sequence_id.to_string(),
            clip_id: clip_id.to_string(),
            new_source_in: None,
            new_source_out: None,
            new_timeline_in: None,
            old_source_in: None,
            old_source_out: None,
            old_timeline_in: None,
            old_duration_sec: None,
        }
    }

    /// Creates a new trim clip command with all parameters
    pub fn new(
        sequence_id: &str,
        _track_id: &str, // For API consistency, not stored
        clip_id: &str,
        new_source_in: Option<TimeSec>,
        new_source_out: Option<TimeSec>,
        new_timeline_in: Option<TimeSec>,
    ) -> Self {
        Self {
            sequence_id: sequence_id.to_string(),
            clip_id: clip_id.to_string(),
            new_source_in,
            new_source_out,
            new_timeline_in,
            old_source_in: None,
            old_source_out: None,
            old_timeline_in: None,
            old_duration_sec: None,
        }
    }

    /// Sets the new source in point
    pub fn with_source_in(mut self, source_in: TimeSec) -> Self {
        self.new_source_in = Some(source_in);
        self
    }

    /// Sets the new source out point
    pub fn with_source_out(mut self, source_out: TimeSec) -> Self {
        self.new_source_out = Some(source_out);
        self
    }

    /// Sets the new timeline in point
    pub fn with_timeline_in(mut self, timeline_in: TimeSec) -> Self {
        self.new_timeline_in = Some(timeline_in);
        self
    }
}

impl Command for TrimClipCommand {
    fn execute(&mut self, state: &mut ProjectState) -> CoreResult<CommandResult> {
        let sequence = state
            .sequences
            .get_mut(&self.sequence_id)
            .ok_or_else(|| CoreError::SequenceNotFound(self.sequence_id.clone()))?;

        let (track_idx, clip_idx) = sequence
            .tracks
            .iter()
            .enumerate()
            .find_map(|(track_idx, track)| {
                track
                    .clips
                    .iter()
                    .position(|c| c.id == self.clip_id)
                    .map(|clip_idx| (track_idx, clip_idx))
            })
            .ok_or_else(|| CoreError::ClipNotFound(self.clip_id.clone()))?;

        let original = sequence.tracks[track_idx].clips[clip_idx].clone();

        // Store old values for undo BEFORE modification
        self.old_source_in = Some(original.range.source_in_sec);
        self.old_source_out = Some(original.range.source_out_sec);
        self.old_timeline_in = Some(original.place.timeline_in_sec);
        self.old_duration_sec = Some(original.place.duration_sec);

        // Prepare candidate without mutating the state.
        let mut candidate = original;

        if let Some(new_in) = self.new_source_in {
            if !is_valid_time_sec(new_in) {
                return Err(CoreError::ValidationError(
                    "newSourceIn must be finite and non-negative".to_string(),
                ));
            }
            candidate.range.source_in_sec = new_in;
        }
        if let Some(new_out) = self.new_source_out {
            if !is_valid_time_sec(new_out) {
                return Err(CoreError::ValidationError(
                    "newSourceOut must be finite and non-negative".to_string(),
                ));
            }
            candidate.range.source_out_sec = new_out;
        }
        if let Some(new_timeline_in) = self.new_timeline_in {
            if !is_valid_time_sec(new_timeline_in) {
                return Err(CoreError::ValidationError(
                    "newTimelineIn must be finite and non-negative".to_string(),
                ));
            }
            candidate.place.timeline_in_sec = new_timeline_in;
        }

        if candidate.range.source_in_sec >= candidate.range.source_out_sec {
            return Err(CoreError::InvalidTimeRange(
                candidate.range.source_in_sec,
                candidate.range.source_out_sec,
            ));
        }

        if !candidate.speed.is_finite() || candidate.speed <= 0.0 {
            return Err(CoreError::ValidationError(
                "Clip speed must be finite and > 0".to_string(),
            ));
        }

        candidate.place.duration_sec = candidate.range.duration() / candidate.speed as f64;
        if !candidate.place.duration_sec.is_finite() || candidate.place.duration_sec <= 0.0 {
            return Err(CoreError::ValidationError(
                "Clip duration must be finite and > 0 after trim".to_string(),
            ));
        }

        // Validate overlap BEFORE mutating state.
        {
            let track = &sequence.tracks[track_idx];
            validate_no_overlap(track, &candidate.place, Some(&candidate.id))?;
        }

        // Apply change and keep ordering deterministic.
        sequence.tracks[track_idx].clips[clip_idx] = candidate;
        sort_track_clips(&mut sequence.tracks[track_idx]);

        let op_id = ulid::Ulid::new().to_string();
        Ok(
            CommandResult::new(&op_id).with_change(StateChange::ClipModified {
                clip_id: self.clip_id.clone(),
            }),
        )
    }

    fn undo(&self, state: &mut ProjectState) -> CoreResult<()> {
        if let Some(sequence) = state.sequences.get_mut(&self.sequence_id) {
            for track in &mut sequence.tracks {
                if let Some(clip) = track.clips.iter_mut().find(|c| c.id == self.clip_id) {
                    // Restore all old values
                    if let Some(old_in) = self.old_source_in {
                        clip.range.source_in_sec = old_in;
                    }
                    if let Some(old_out) = self.old_source_out {
                        clip.range.source_out_sec = old_out;
                    }
                    if let Some(old_timeline_in) = self.old_timeline_in {
                        clip.place.timeline_in_sec = old_timeline_in;
                    }
                    // Restore exact duration (not recalculated, to preserve any rounding)
                    if let Some(old_duration) = self.old_duration_sec {
                        clip.place.duration_sec = old_duration;
                    }

                    sort_track_clips(track);
                    return Ok(());
                }
            }
        }
        Ok(())
    }

    fn type_name(&self) -> &'static str {
        "TrimClip"
    }

    fn to_json(&self) -> serde_json::Value {
        serde_json::to_value(self).unwrap_or(serde_json::json!({}))
    }
}

// =============================================================================
// SplitClipCommand
// =============================================================================

/// Command to split a clip at a given time
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SplitClipCommand {
    /// Target sequence ID
    pub sequence_id: SequenceId,
    /// Target track ID
    pub track_id: TrackId,
    /// Clip ID to split
    pub clip_id: ClipId,
    /// Time to split at (in timeline time)
    pub split_at: TimeSec,
    /// Created clip ID (second half)
    #[serde(skip)]
    created_clip_id: Option<ClipId>,
    /// Original clip data (for undo)
    #[serde(skip)]
    original_clip: Option<Clip>,
}

impl SplitClipCommand {
    /// Creates a new split clip command
    pub fn new(sequence_id: &str, track_id: &str, clip_id: &str, split_at: TimeSec) -> Self {
        Self {
            sequence_id: sequence_id.to_string(),
            track_id: track_id.to_string(),
            clip_id: clip_id.to_string(),
            split_at,
            created_clip_id: None,
            original_clip: None,
        }
    }
}

// =============================================================================
// SetClipMuteCommand
// =============================================================================

/// Command to set clip-level audio mute state.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetClipMuteCommand {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    pub clip_id: ClipId,
    pub muted: bool,
    #[serde(skip)]
    previous_muted: Option<bool>,
}

impl SetClipMuteCommand {
    pub fn new(sequence_id: &str, track_id: &str, clip_id: &str, muted: bool) -> Self {
        Self {
            sequence_id: sequence_id.to_string(),
            track_id: track_id.to_string(),
            clip_id: clip_id.to_string(),
            muted,
            previous_muted: None,
        }
    }
}

impl Command for SetClipMuteCommand {
    fn execute(&mut self, state: &mut ProjectState) -> CoreResult<CommandResult> {
        let sequence = state
            .sequences
            .get_mut(&self.sequence_id)
            .ok_or_else(|| CoreError::SequenceNotFound(self.sequence_id.clone()))?;

        let track = sequence
            .tracks
            .iter_mut()
            .find(|t| t.id == self.track_id)
            .ok_or_else(|| CoreError::TrackNotFound(self.track_id.clone()))?;

        let clip = track
            .clips
            .iter_mut()
            .find(|c| c.id == self.clip_id)
            .ok_or_else(|| CoreError::ClipNotFound(self.clip_id.clone()))?;

        self.previous_muted = Some(clip.audio.muted);
        clip.audio.muted = self.muted;

        let op_id = ulid::Ulid::new().to_string();
        Ok(
            CommandResult::new(&op_id).with_change(StateChange::ClipModified {
                clip_id: self.clip_id.clone(),
            }),
        )
    }

    fn undo(&self, state: &mut ProjectState) -> CoreResult<()> {
        let Some(previous_muted) = self.previous_muted else {
            return Ok(());
        };

        let Some(sequence) = state.sequences.get_mut(&self.sequence_id) else {
            return Ok(());
        };

        let Some(track) = sequence.tracks.iter_mut().find(|t| t.id == self.track_id) else {
            return Ok(());
        };

        if let Some(clip) = track.clips.iter_mut().find(|c| c.id == self.clip_id) {
            clip.audio.muted = previous_muted;
        }

        Ok(())
    }

    fn type_name(&self) -> &'static str {
        "SetClipMute"
    }

    fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "sequenceId": self.sequence_id,
            "trackId": self.track_id,
            "clipId": self.clip_id,
            "muted": self.muted,
        })
    }
}

// =============================================================================
// SetClipAudioCommand
// =============================================================================

const MIN_CLIP_VOLUME_DB: f32 = -60.0;
const MAX_CLIP_VOLUME_DB: f32 = 6.0;

/// Command to set clip-level audio settings.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetClipAudioCommand {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    pub clip_id: ClipId,
    pub volume_db: Option<f32>,
    pub pan: Option<f32>,
    pub muted: Option<bool>,
    pub fade_in_sec: Option<TimeSec>,
    pub fade_out_sec: Option<TimeSec>,
    #[serde(skip)]
    previous_audio: Option<AudioSettings>,
}

impl SetClipAudioCommand {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        sequence_id: &str,
        track_id: &str,
        clip_id: &str,
        volume_db: Option<f32>,
        pan: Option<f32>,
        muted: Option<bool>,
        fade_in_sec: Option<TimeSec>,
        fade_out_sec: Option<TimeSec>,
    ) -> Self {
        Self {
            sequence_id: sequence_id.to_string(),
            track_id: track_id.to_string(),
            clip_id: clip_id.to_string(),
            volume_db,
            pan,
            muted,
            fade_in_sec,
            fade_out_sec,
            previous_audio: None,
        }
    }

    fn clamp_volume_db(value: f32) -> f32 {
        value.clamp(MIN_CLIP_VOLUME_DB, MAX_CLIP_VOLUME_DB)
    }

    fn clamp_pan(value: f32) -> f32 {
        value.clamp(-1.0, 1.0)
    }

    fn clamp_fade_duration(value: TimeSec, clip_duration: TimeSec) -> TimeSec {
        value.clamp(0.0, clip_duration.max(0.0))
    }

    fn normalize_fade_pair(clip: &mut Clip, fade_in_updated: bool, fade_out_updated: bool) {
        let clip_duration = clip.duration().max(0.0);

        clip.audio.fade_in_sec = Self::clamp_fade_duration(clip.audio.fade_in_sec, clip_duration);
        clip.audio.fade_out_sec = Self::clamp_fade_duration(clip.audio.fade_out_sec, clip_duration);

        let total_fade = clip.audio.fade_in_sec + clip.audio.fade_out_sec;
        if total_fade <= clip_duration {
            return;
        }

        if fade_in_updated && !fade_out_updated {
            clip.audio.fade_in_sec = (clip_duration - clip.audio.fade_out_sec).max(0.0);
            return;
        }

        clip.audio.fade_out_sec = (clip_duration - clip.audio.fade_in_sec).max(0.0);
    }
}

impl Command for SetClipAudioCommand {
    fn execute(&mut self, state: &mut ProjectState) -> CoreResult<CommandResult> {
        if self.volume_db.is_none()
            && self.pan.is_none()
            && self.muted.is_none()
            && self.fade_in_sec.is_none()
            && self.fade_out_sec.is_none()
        {
            return Err(CoreError::InvalidCommand(
                "SetClipAudio requires at least one audio field".to_string(),
            ));
        }

        let sequence = state
            .sequences
            .get_mut(&self.sequence_id)
            .ok_or_else(|| CoreError::SequenceNotFound(self.sequence_id.clone()))?;

        let track = sequence
            .tracks
            .iter_mut()
            .find(|t| t.id == self.track_id)
            .ok_or_else(|| CoreError::TrackNotFound(self.track_id.clone()))?;

        let clip = track
            .clips
            .iter_mut()
            .find(|c| c.id == self.clip_id)
            .ok_or_else(|| CoreError::ClipNotFound(self.clip_id.clone()))?;

        self.previous_audio = Some(clip.audio.clone());

        if let Some(volume_db) = self.volume_db {
            if !volume_db.is_finite() {
                return Err(CoreError::InvalidCommand(
                    "volumeDb must be a finite number".to_string(),
                ));
            }
            clip.audio.volume_db = Self::clamp_volume_db(volume_db);
        }

        if let Some(pan) = self.pan {
            if !pan.is_finite() {
                return Err(CoreError::InvalidCommand(
                    "pan must be a finite number".to_string(),
                ));
            }
            clip.audio.pan = Self::clamp_pan(pan);
        }

        if let Some(muted) = self.muted {
            clip.audio.muted = muted;
        }

        if let Some(fade_in_sec) = self.fade_in_sec {
            if !is_valid_time_sec(fade_in_sec) {
                return Err(CoreError::InvalidCommand(
                    "fadeInSec must be a finite, non-negative number".to_string(),
                ));
            }
            clip.audio.fade_in_sec = fade_in_sec;
        }

        if let Some(fade_out_sec) = self.fade_out_sec {
            if !is_valid_time_sec(fade_out_sec) {
                return Err(CoreError::InvalidCommand(
                    "fadeOutSec must be a finite, non-negative number".to_string(),
                ));
            }
            clip.audio.fade_out_sec = fade_out_sec;
        }

        Self::normalize_fade_pair(
            clip,
            self.fade_in_sec.is_some(),
            self.fade_out_sec.is_some(),
        );

        let op_id = ulid::Ulid::new().to_string();
        Ok(
            CommandResult::new(&op_id).with_change(StateChange::ClipModified {
                clip_id: self.clip_id.clone(),
            }),
        )
    }

    fn undo(&self, state: &mut ProjectState) -> CoreResult<()> {
        let Some(previous_audio) = &self.previous_audio else {
            return Ok(());
        };

        let Some(sequence) = state.sequences.get_mut(&self.sequence_id) else {
            return Ok(());
        };

        let Some(track) = sequence.tracks.iter_mut().find(|t| t.id == self.track_id) else {
            return Ok(());
        };

        if let Some(clip) = track.clips.iter_mut().find(|c| c.id == self.clip_id) {
            clip.audio = previous_audio.clone();
        }

        Ok(())
    }

    fn type_name(&self) -> &'static str {
        "SetClipAudio"
    }

    fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "sequenceId": self.sequence_id,
            "trackId": self.track_id,
            "clipId": self.clip_id,
            "volumeDb": self.volume_db,
            "pan": self.pan,
            "muted": self.muted,
            "fadeInSec": self.fade_in_sec,
            "fadeOutSec": self.fade_out_sec,
        })
    }
}

// =============================================================================
// SetClipSpeedCommand
// =============================================================================

/// Command to update a clip's playback speed.
///
/// Timeline duration is automatically recalculated from source range and speed:
/// `duration = (sourceOut - sourceIn) / speed`.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetClipSpeedCommand {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    pub clip_id: ClipId,
    pub speed: f32,
    pub reverse: bool,
    #[serde(skip)]
    previous_speed: Option<f32>,
    #[serde(skip)]
    previous_reverse: Option<bool>,
    #[serde(skip)]
    previous_duration_sec: Option<TimeSec>,
}

impl SetClipSpeedCommand {
    pub fn new(
        sequence_id: &str,
        track_id: &str,
        clip_id: &str,
        speed: f32,
        reverse: bool,
    ) -> Self {
        Self {
            sequence_id: sequence_id.to_string(),
            track_id: track_id.to_string(),
            clip_id: clip_id.to_string(),
            speed,
            reverse,
            previous_speed: None,
            previous_reverse: None,
            previous_duration_sec: None,
        }
    }
}

impl Command for SetClipSpeedCommand {
    fn execute(&mut self, state: &mut ProjectState) -> CoreResult<CommandResult> {
        if !self.speed.is_finite() || self.speed <= 0.0 {
            return Err(CoreError::InvalidCommand(
                "speed must be a finite number > 0".to_string(),
            ));
        }

        let sequence = state
            .sequences
            .get_mut(&self.sequence_id)
            .ok_or_else(|| CoreError::SequenceNotFound(self.sequence_id.clone()))?;

        let track_idx = sequence
            .tracks
            .iter()
            .position(|track| track.id == self.track_id)
            .ok_or_else(|| CoreError::TrackNotFound(self.track_id.clone()))?;

        validate_track_unlocked(&sequence.tracks[track_idx])?;

        let clip_idx = sequence.tracks[track_idx]
            .clips
            .iter()
            .position(|c| c.id == self.clip_id)
            .ok_or_else(|| CoreError::ClipNotFound(self.clip_id.clone()))?;

        {
            let clip = &sequence.tracks[track_idx].clips[clip_idx];
            self.previous_speed = Some(clip.speed);
            self.previous_reverse = Some(clip.reverse);
            self.previous_duration_sec = Some(clip.place.duration_sec);
        }

        let clip = &mut sequence.tracks[track_idx].clips[clip_idx];
        clip.speed = self.speed;
        clip.reverse = self.reverse;
        clip.place.duration_sec = clip.range.duration() / self.speed as f64;

        if !clip.place.duration_sec.is_finite() || clip.place.duration_sec <= 0.0 {
            return Err(CoreError::ValidationError(
                "Clip duration must be finite and > 0 after speed change".to_string(),
            ));
        }

        {
            let clip_ref = &sequence.tracks[track_idx].clips[clip_idx];
            let track = &sequence.tracks[track_idx];
            validate_no_overlap(track, &clip_ref.place, Some(&clip_ref.id))?;
        }

        let op_id = ulid::Ulid::new().to_string();
        Ok(
            CommandResult::new(&op_id).with_change(StateChange::ClipModified {
                clip_id: self.clip_id.clone(),
            }),
        )
    }

    fn undo(&self, state: &mut ProjectState) -> CoreResult<()> {
        let (Some(previous_speed), Some(previous_reverse), Some(previous_duration_sec)) = (
            self.previous_speed,
            self.previous_reverse,
            self.previous_duration_sec,
        ) else {
            return Ok(());
        };

        let Some(sequence) = state.sequences.get_mut(&self.sequence_id) else {
            return Ok(());
        };

        let Some(track) = sequence.tracks.iter_mut().find(|t| t.id == self.track_id) else {
            return Ok(());
        };

        if let Some(clip) = track.clips.iter_mut().find(|c| c.id == self.clip_id) {
            clip.speed = previous_speed;
            clip.reverse = previous_reverse;
            clip.place.duration_sec = previous_duration_sec;
            sort_track_clips(track);
        }

        Ok(())
    }

    fn type_name(&self) -> &'static str {
        "SetClipSpeed"
    }

    fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "sequenceId": self.sequence_id,
            "trackId": self.track_id,
            "clipId": self.clip_id,
            "speed": self.speed,
            "reverse": self.reverse,
        })
    }
}

// =============================================================================
// ReverseClipCommand
// =============================================================================

/// Command to toggle a clip's reverse playback state.
///
/// When reversed, video and audio play backward. Reverse is applied in the
/// FFmpeg render pipeline via `reverse` and `areverse` filters.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReverseClipCommand {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    pub clip_id: ClipId,
    #[serde(skip)]
    previous_reverse: Option<bool>,
}

impl ReverseClipCommand {
    pub fn new(sequence_id: &str, track_id: &str, clip_id: &str) -> Self {
        Self {
            sequence_id: sequence_id.to_string(),
            track_id: track_id.to_string(),
            clip_id: clip_id.to_string(),
            previous_reverse: None,
        }
    }
}

impl Command for ReverseClipCommand {
    fn execute(&mut self, state: &mut ProjectState) -> CoreResult<CommandResult> {
        let sequence = state
            .sequences
            .get_mut(&self.sequence_id)
            .ok_or_else(|| CoreError::SequenceNotFound(self.sequence_id.clone()))?;

        let track = sequence
            .tracks
            .iter_mut()
            .find(|t| t.id == self.track_id)
            .ok_or_else(|| CoreError::TrackNotFound(self.track_id.clone()))?;

        validate_track_unlocked(track)?;

        let clip = track
            .clips
            .iter_mut()
            .find(|c| c.id == self.clip_id)
            .ok_or_else(|| CoreError::ClipNotFound(self.clip_id.clone()))?;

        self.previous_reverse = Some(clip.reverse);
        clip.reverse = !clip.reverse;

        let op_id = ulid::Ulid::new().to_string();
        Ok(
            CommandResult::new(&op_id).with_change(StateChange::ClipModified {
                clip_id: self.clip_id.clone(),
            }),
        )
    }

    fn undo(&self, state: &mut ProjectState) -> CoreResult<()> {
        let Some(previous_reverse) = self.previous_reverse else {
            return Ok(());
        };

        let Some(sequence) = state.sequences.get_mut(&self.sequence_id) else {
            return Ok(());
        };

        let Some(track) = sequence.tracks.iter_mut().find(|t| t.id == self.track_id) else {
            return Ok(());
        };

        if let Some(clip) = track.clips.iter_mut().find(|c| c.id == self.clip_id) {
            clip.reverse = previous_reverse;
        }

        Ok(())
    }

    fn type_name(&self) -> &'static str {
        "ReverseClip"
    }

    fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "sequenceId": self.sequence_id,
            "trackId": self.track_id,
            "clipId": self.clip_id,
        })
    }
}

// =============================================================================
// SetClipEnabledCommand
// =============================================================================

/// Command to enable or disable a clip.
///
/// Disabled clips are skipped during render/preview but remain on the timeline
/// for non-destructive toggling. This is the clip-level equivalent of muting —
/// the clip stays in place, preserving timing, but produces no output.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetClipEnabledCommand {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    pub clip_id: ClipId,
    pub enabled: bool,
    #[serde(skip)]
    previous_enabled: Option<bool>,
}

impl SetClipEnabledCommand {
    pub fn new(sequence_id: &str, track_id: &str, clip_id: &str, enabled: bool) -> Self {
        Self {
            sequence_id: sequence_id.to_string(),
            track_id: track_id.to_string(),
            clip_id: clip_id.to_string(),
            enabled,
            previous_enabled: None,
        }
    }
}

impl Command for SetClipEnabledCommand {
    fn execute(&mut self, state: &mut ProjectState) -> CoreResult<CommandResult> {
        let sequence = state
            .sequences
            .get_mut(&self.sequence_id)
            .ok_or_else(|| CoreError::SequenceNotFound(self.sequence_id.clone()))?;

        let track = sequence
            .tracks
            .iter_mut()
            .find(|t| t.id == self.track_id)
            .ok_or_else(|| CoreError::TrackNotFound(self.track_id.clone()))?;

        validate_track_unlocked(track)?;

        let clip = track
            .clips
            .iter_mut()
            .find(|c| c.id == self.clip_id)
            .ok_or_else(|| CoreError::ClipNotFound(self.clip_id.clone()))?;

        self.previous_enabled = Some(clip.enabled);
        clip.enabled = self.enabled;

        let op_id = ulid::Ulid::new().to_string();
        Ok(
            CommandResult::new(&op_id).with_change(StateChange::ClipModified {
                clip_id: self.clip_id.clone(),
            }),
        )
    }

    fn undo(&self, state: &mut ProjectState) -> CoreResult<()> {
        let Some(previous_enabled) = self.previous_enabled else {
            return Ok(());
        };

        let Some(sequence) = state.sequences.get_mut(&self.sequence_id) else {
            return Ok(());
        };

        let Some(track) = sequence.tracks.iter_mut().find(|t| t.id == self.track_id) else {
            return Ok(());
        };

        if let Some(clip) = track.clips.iter_mut().find(|c| c.id == self.clip_id) {
            clip.enabled = previous_enabled;
        }

        Ok(())
    }

    fn type_name(&self) -> &'static str {
        "SetClipEnabled"
    }

    fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "sequenceId": self.sequence_id,
            "trackId": self.track_id,
            "clipId": self.clip_id,
            "enabled": self.enabled,
        })
    }
}

// =============================================================================
// CreateFreezeFrameCommand
// =============================================================================

/// Command to create a freeze frame from a clip at the playhead position.
///
/// Extracts a single frame from the source clip at the given timeline position
/// and inserts a new still clip of the specified duration. The freeze frame clip
/// uses `freeze_frame = true` so the render pipeline loops the single frame.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateFreezeFrameCommand {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    pub clip_id: ClipId,
    pub playhead_sec: f64,
    #[serde(default = "default_freeze_frame_duration")]
    pub duration_sec: f64,
    #[serde(skip)]
    created_clip_id: Option<ClipId>,
    #[serde(skip)]
    shifted_clips: Vec<ShiftedClipRecord>,
    #[serde(skip)]
    split_clips: Vec<SplitClipRecord>,
}

pub const DEFAULT_FREEZE_FRAME_DURATION: f64 = 2.0;

fn default_freeze_frame_duration() -> f64 {
    DEFAULT_FREEZE_FRAME_DURATION
}

impl CreateFreezeFrameCommand {
    pub fn new(
        sequence_id: &str,
        track_id: &str,
        clip_id: &str,
        playhead_sec: f64,
        duration_sec: f64,
    ) -> Self {
        Self {
            sequence_id: sequence_id.to_string(),
            track_id: track_id.to_string(),
            clip_id: clip_id.to_string(),
            playhead_sec,
            duration_sec,
            created_clip_id: None,
            shifted_clips: Vec::new(),
            split_clips: Vec::new(),
        }
    }
}

impl Command for CreateFreezeFrameCommand {
    fn execute(&mut self, state: &mut ProjectState) -> CoreResult<CommandResult> {
        if !self.playhead_sec.is_finite() || self.playhead_sec < 0.0 {
            return Err(CoreError::InvalidCommand(
                "playhead_sec must be a finite non-negative number".to_string(),
            ));
        }
        if !self.duration_sec.is_finite() || self.duration_sec <= 0.0 {
            return Err(CoreError::InvalidCommand(
                "duration_sec must be a finite number > 0".to_string(),
            ));
        }

        let (source_clip_template, freeze_range, shift_records, split_candidates) = {
            let sequence = state
                .sequences
                .get(&self.sequence_id)
                .ok_or_else(|| CoreError::SequenceNotFound(self.sequence_id.clone()))?;

            let track = sequence
                .tracks
                .iter()
                .find(|t| t.id == self.track_id)
                .ok_or_else(|| CoreError::TrackNotFound(self.track_id.clone()))?;

            validate_track_unlocked(track)?;

            let source_clip = track
                .clips
                .iter()
                .find(|c| c.id == self.clip_id)
                .ok_or_else(|| CoreError::ClipNotFound(self.clip_id.clone()))?;

            let clip_start = source_clip.place.timeline_in_sec;
            let clip_end = source_clip.place.timeline_out_sec();
            if self.playhead_sec < clip_start || self.playhead_sec > clip_end {
                return Err(CoreError::ValidationError(format!(
                    "Playhead ({:.3}s) is outside clip range [{:.3}s, {:.3}s]",
                    self.playhead_sec, clip_start, clip_end
                )));
            }

            let fps = sequence.format.fps.as_f64();
            let frame_window = if fps > 0.0 { 1.0 / fps } else { 1.0 / 25.0 };
            let freeze_range =
                freeze_frame_source_range(source_clip, self.playhead_sec, frame_window);
            let mut shift_records = Vec::new();
            let mut split_candidates = Vec::new();

            for clip in &track.clips {
                let clip_start = clip.place.timeline_in_sec;
                let clip_end = clip.place.timeline_out_sec();

                if clip_start < self.playhead_sec && clip_end > self.playhead_sec {
                    split_candidates.push(clip.clone());
                } else if clip_start >= self.playhead_sec {
                    shift_records.push(ShiftedClipRecord {
                        track_id: self.track_id.clone(),
                        clip_id: clip.id.clone(),
                        original_timeline_in: clip_start,
                    });
                }
            }

            (
                source_clip.clone(),
                freeze_range,
                shift_records,
                split_candidates,
            )
        };

        let sequence = state
            .sequences
            .get_mut(&self.sequence_id)
            .ok_or_else(|| CoreError::SequenceNotFound(self.sequence_id.clone()))?;

        let track = sequence
            .tracks
            .iter_mut()
            .find(|t| t.id == self.track_id)
            .ok_or_else(|| CoreError::TrackNotFound(self.track_id.clone()))?;

        let mut split_records = Vec::new();

        for original_clip in split_candidates {
            let relative_split = self.playhead_sec - original_clip.place.timeline_in_sec;
            let right_duration = original_clip.place.timeline_out_sec() - self.playhead_sec;
            if !relative_split.is_finite()
                || !right_duration.is_finite()
                || relative_split <= 0.0
                || right_duration <= 0.0
            {
                return Err(CoreError::ValidationError(
                    "Freeze frame split produced an invalid clip duration".to_string(),
                ));
            }

            let ((first_source_in, first_source_out), (second_source_in, second_source_out)) =
                split_clip_ranges_at(&original_clip, self.playhead_sec);
            let fragment = clone_clip_fragment_with_rebased_time_remap(
                &original_clip,
                second_source_in,
                second_source_out,
                self.playhead_sec + self.duration_sec,
                right_duration,
                relative_split,
            );
            let fragment_id = fragment.id.clone();

            let clip = track
                .clips
                .iter_mut()
                .find(|c| c.id == original_clip.id)
                .ok_or_else(|| CoreError::ClipNotFound(original_clip.id.clone()))?;
            clip.range.source_in_sec = first_source_in;
            clip.range.source_out_sec = first_source_out;
            clip.place.duration_sec = relative_split;
            rebase_clip_time_remap_for_fragment(clip, 0.0, relative_split);
            insert_clip_sorted(track, fragment);

            split_records.push(SplitClipRecord {
                track_id: self.track_id.clone(),
                original_clip: Box::new(original_clip),
                fragment_clip_id: fragment_id,
            });
        }

        for record in &shift_records {
            if let Some(clip) = track.clips.iter_mut().find(|c| c.id == record.clip_id) {
                clip.place.timeline_in_sec += self.duration_sec;
            }
        }
        sort_track_clips(track);

        let mut freeze_clip = source_clip_template;
        freeze_clip.id = ulid::Ulid::new().to_string();
        freeze_clip.range = freeze_range;
        freeze_clip.place = ClipPlace {
            timeline_in_sec: self.playhead_sec,
            duration_sec: self.duration_sec,
        };
        freeze_clip.freeze_frame = true;
        freeze_clip.speed = 1.0;
        freeze_clip.reverse = false;
        freeze_clip.time_remap = None;
        freeze_clip.audio.muted = true;

        let clip_id = freeze_clip.id.clone();
        insert_clip_sorted(track, freeze_clip);

        self.created_clip_id = Some(clip_id.clone());
        self.shifted_clips = shift_records;
        self.split_clips = split_records;

        let op_id = ulid::Ulid::new().to_string();
        let mut result = CommandResult::new(&op_id)
            .with_change(StateChange::ClipCreated {
                clip_id: clip_id.clone(),
            })
            .with_created_id(&clip_id);

        for record in &self.shifted_clips {
            result = result.with_change(StateChange::ClipModified {
                clip_id: record.clip_id.clone(),
            });
        }

        for record in &self.split_clips {
            result = result.with_change(StateChange::ClipModified {
                clip_id: record.original_clip.id.clone(),
            });
            result = result.with_change(StateChange::ClipCreated {
                clip_id: record.fragment_clip_id.clone(),
            });
        }

        Ok(result)
    }

    fn undo(&self, state: &mut ProjectState) -> CoreResult<()> {
        let Some(sequence) = state.sequences.get_mut(&self.sequence_id) else {
            return Ok(());
        };

        let Some(track) = sequence.tracks.iter_mut().find(|t| t.id == self.track_id) else {
            return Ok(());
        };

        if let Some(ref created_id) = self.created_clip_id {
            track.clips.retain(|c| c.id != *created_id);
        }

        for record in &self.split_clips {
            track.clips.retain(|c| c.id != record.fragment_clip_id);

            if let Some(clip) = track
                .clips
                .iter_mut()
                .find(|c| c.id == record.original_clip.id)
            {
                *clip = (*record.original_clip).clone();
            } else {
                insert_clip_sorted(track, (*record.original_clip).clone());
            }
        }

        for record in &self.shifted_clips {
            if let Some(clip) = track.clips.iter_mut().find(|c| c.id == record.clip_id) {
                clip.place.timeline_in_sec = record.original_timeline_in;
            }
        }
        sort_track_clips(track);

        Ok(())
    }

    fn type_name(&self) -> &'static str {
        "CreateFreezeFrame"
    }

    fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "sequenceId": self.sequence_id,
            "trackId": self.track_id,
            "clipId": self.clip_id,
            "playheadSec": self.playhead_sec,
            "durationSec": self.duration_sec,
        })
    }
}

// =============================================================================
// SetTimeRemapCommand
// =============================================================================

/// Command to set a time remap curve on a clip for variable-speed playback.
///
/// When a valid time remap curve is active, it overrides the constant `speed`
/// field. The clip's timeline duration is recalculated from the curve.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetTimeRemapCommand {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    pub clip_id: ClipId,
    pub time_remap: TimeRemapCurve,
    #[serde(skip)]
    previous_time_remap: Option<Option<TimeRemapCurve>>,
    #[serde(skip)]
    previous_duration_sec: Option<TimeSec>,
}

impl SetTimeRemapCommand {
    pub fn new(
        sequence_id: &str,
        track_id: &str,
        clip_id: &str,
        time_remap: TimeRemapCurve,
    ) -> Self {
        Self {
            sequence_id: sequence_id.to_string(),
            track_id: track_id.to_string(),
            clip_id: clip_id.to_string(),
            time_remap,
            previous_time_remap: None,
            previous_duration_sec: None,
        }
    }
}

impl Command for SetTimeRemapCommand {
    fn execute(&mut self, state: &mut ProjectState) -> CoreResult<CommandResult> {
        if !self.time_remap.is_valid() {
            return Err(CoreError::InvalidCommand(
                "Time remap curve must have at least 2 keyframes".to_string(),
            ));
        }

        // Validate all keyframe values are finite and non-negative
        for (i, kf) in self.time_remap.keyframes.iter().enumerate() {
            if !kf.timeline_time.is_finite() || kf.timeline_time < 0.0 {
                return Err(CoreError::InvalidCommand(format!(
                    "Keyframe {} has invalid timeline_time: {}",
                    i, kf.timeline_time
                )));
            }
            if !kf.source_time.is_finite() || kf.source_time < 0.0 {
                return Err(CoreError::InvalidCommand(format!(
                    "Keyframe {} has invalid source_time: {}",
                    i, kf.source_time
                )));
            }
        }

        let new_duration = self.time_remap.timeline_duration();
        if !new_duration.is_finite() || new_duration <= 0.0 {
            return Err(CoreError::ValidationError(
                "Time remap curve must produce a positive timeline duration".to_string(),
            ));
        }

        let sequence = state
            .sequences
            .get_mut(&self.sequence_id)
            .ok_or_else(|| CoreError::SequenceNotFound(self.sequence_id.clone()))?;

        let track_idx = sequence
            .tracks
            .iter()
            .position(|track| track.id == self.track_id)
            .ok_or_else(|| CoreError::TrackNotFound(self.track_id.clone()))?;

        validate_track_unlocked(&sequence.tracks[track_idx])?;

        let clip_idx = sequence.tracks[track_idx]
            .clips
            .iter()
            .position(|c| c.id == self.clip_id)
            .ok_or_else(|| CoreError::ClipNotFound(self.clip_id.clone()))?;

        {
            let clip = &sequence.tracks[track_idx].clips[clip_idx];
            self.previous_time_remap = Some(clip.time_remap.clone());
            self.previous_duration_sec = Some(clip.place.duration_sec);
        }

        let clip = &mut sequence.tracks[track_idx].clips[clip_idx];
        clip.time_remap = Some(self.time_remap.clone());
        clip.place.duration_sec = new_duration;

        {
            let clip_ref = &sequence.tracks[track_idx].clips[clip_idx];
            let track = &sequence.tracks[track_idx];
            validate_no_overlap(track, &clip_ref.place, Some(&clip_ref.id))?;
        }

        let op_id = ulid::Ulid::new().to_string();
        Ok(
            CommandResult::new(&op_id).with_change(StateChange::ClipModified {
                clip_id: self.clip_id.clone(),
            }),
        )
    }

    fn undo(&self, state: &mut ProjectState) -> CoreResult<()> {
        let (Some(ref previous_time_remap), Some(previous_duration_sec)) =
            (&self.previous_time_remap, self.previous_duration_sec)
        else {
            return Ok(());
        };

        let Some(sequence) = state.sequences.get_mut(&self.sequence_id) else {
            return Ok(());
        };

        let Some(track) = sequence.tracks.iter_mut().find(|t| t.id == self.track_id) else {
            return Ok(());
        };

        if let Some(clip) = track.clips.iter_mut().find(|c| c.id == self.clip_id) {
            clip.time_remap = previous_time_remap.clone();
            clip.place.duration_sec = previous_duration_sec;
            sort_track_clips(track);
        }

        Ok(())
    }

    fn type_name(&self) -> &'static str {
        "SetTimeRemap"
    }

    fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "sequenceId": self.sequence_id,
            "trackId": self.track_id,
            "clipId": self.clip_id,
            "timeRemap": self.time_remap,
        })
    }
}

// =============================================================================
// ClearTimeRemapCommand
// =============================================================================

/// Command to remove a time remap curve from a clip.
///
/// Restores the clip to constant-speed mode using the `speed` field.
/// The clip's duration is recalculated from source range and constant speed.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearTimeRemapCommand {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    pub clip_id: ClipId,
    #[serde(skip)]
    previous_time_remap: Option<Option<TimeRemapCurve>>,
    #[serde(skip)]
    previous_duration_sec: Option<TimeSec>,
}

impl ClearTimeRemapCommand {
    pub fn new(sequence_id: &str, track_id: &str, clip_id: &str) -> Self {
        Self {
            sequence_id: sequence_id.to_string(),
            track_id: track_id.to_string(),
            clip_id: clip_id.to_string(),
            previous_time_remap: None,
            previous_duration_sec: None,
        }
    }
}

impl Command for ClearTimeRemapCommand {
    fn execute(&mut self, state: &mut ProjectState) -> CoreResult<CommandResult> {
        let sequence = state
            .sequences
            .get_mut(&self.sequence_id)
            .ok_or_else(|| CoreError::SequenceNotFound(self.sequence_id.clone()))?;

        let track_idx = sequence
            .tracks
            .iter()
            .position(|track| track.id == self.track_id)
            .ok_or_else(|| CoreError::TrackNotFound(self.track_id.clone()))?;

        validate_track_unlocked(&sequence.tracks[track_idx])?;

        let clip_idx = sequence.tracks[track_idx]
            .clips
            .iter()
            .position(|c| c.id == self.clip_id)
            .ok_or_else(|| CoreError::ClipNotFound(self.clip_id.clone()))?;

        let original = &sequence.tracks[track_idx].clips[clip_idx];
        self.previous_time_remap = Some(original.time_remap.clone());
        self.previous_duration_sec = Some(original.place.duration_sec);

        let clip = &mut sequence.tracks[track_idx].clips[clip_idx];
        clip.time_remap = None;
        // Restore duration from source range and constant speed
        clip.place.duration_sec = clip.range.duration() / clip.safe_speed();

        {
            let clip_ref = &sequence.tracks[track_idx].clips[clip_idx];
            let track = &sequence.tracks[track_idx];
            validate_no_overlap(track, &clip_ref.place, Some(&clip_ref.id))?;
        }

        sort_track_clips(&mut sequence.tracks[track_idx]);

        let op_id = ulid::Ulid::new().to_string();
        Ok(
            CommandResult::new(&op_id).with_change(StateChange::ClipModified {
                clip_id: self.clip_id.clone(),
            }),
        )
    }

    fn undo(&self, state: &mut ProjectState) -> CoreResult<()> {
        let (Some(ref previous_time_remap), Some(previous_duration_sec)) =
            (&self.previous_time_remap, self.previous_duration_sec)
        else {
            return Ok(());
        };

        let Some(sequence) = state.sequences.get_mut(&self.sequence_id) else {
            return Ok(());
        };

        let Some(track) = sequence.tracks.iter_mut().find(|t| t.id == self.track_id) else {
            return Ok(());
        };

        if let Some(clip) = track.clips.iter_mut().find(|c| c.id == self.clip_id) {
            clip.time_remap = previous_time_remap.clone();
            clip.place.duration_sec = previous_duration_sec;
            sort_track_clips(track);
        }

        Ok(())
    }

    fn type_name(&self) -> &'static str {
        "ClearTimeRemap"
    }

    fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "sequenceId": self.sequence_id,
            "trackId": self.track_id,
            "clipId": self.clip_id,
        })
    }
}

// =============================================================================
// SetAudioFadeInCommand
// =============================================================================

/// Command to set audio fade-in duration and curve type on a clip.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetAudioFadeInCommand {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    pub clip_id: ClipId,
    pub duration: f64,
    pub fade_type: FadeType,
    #[serde(skip)]
    previous_audio: Option<AudioSettings>,
}

impl SetAudioFadeInCommand {
    pub fn new(
        sequence_id: &str,
        track_id: &str,
        clip_id: &str,
        duration: f64,
        fade_type: FadeType,
    ) -> Self {
        Self {
            sequence_id: sequence_id.to_string(),
            track_id: track_id.to_string(),
            clip_id: clip_id.to_string(),
            duration,
            fade_type,
            previous_audio: None,
        }
    }
}

impl Command for SetAudioFadeInCommand {
    fn execute(&mut self, state: &mut ProjectState) -> CoreResult<CommandResult> {
        if !self.duration.is_finite() || self.duration < 0.0 {
            return Err(CoreError::InvalidCommand(
                "Fade-in duration must be a non-negative finite number".to_string(),
            ));
        }

        let sequence = state
            .sequences
            .get_mut(&self.sequence_id)
            .ok_or_else(|| CoreError::SequenceNotFound(self.sequence_id.clone()))?;
        let track = sequence
            .get_track_mut(&self.track_id)
            .ok_or_else(|| CoreError::TrackNotFound(self.track_id.clone()))?;
        let clip = track
            .get_clip_mut(&self.clip_id)
            .ok_or_else(|| CoreError::ClipNotFound(self.clip_id.clone()))?;

        self.previous_audio = Some(clip.audio.clone());

        let clip_duration = clip.duration().max(0.0);
        clip.audio.fade_in_sec = self.duration.min(clip_duration);
        clip.audio.fade_in_type = self.fade_type.clone();

        // Ensure fades don't exceed clip duration
        let total = clip.audio.fade_in_sec + clip.audio.fade_out_sec;
        if total > clip_duration {
            clip.audio.fade_out_sec = (clip_duration - clip.audio.fade_in_sec).max(0.0);
        }

        let op_id = ulid::Ulid::new().to_string();
        Ok(
            CommandResult::new(&op_id).with_change(StateChange::ClipModified {
                clip_id: self.clip_id.clone(),
            }),
        )
    }

    fn undo(&self, state: &mut ProjectState) -> CoreResult<()> {
        let Some(previous_audio) = &self.previous_audio else {
            return Ok(());
        };

        let Some(sequence) = state.sequences.get_mut(&self.sequence_id) else {
            return Ok(());
        };
        let Some(track) = sequence.get_track_mut(&self.track_id) else {
            return Ok(());
        };
        if let Some(clip) = track.get_clip_mut(&self.clip_id) {
            clip.audio = previous_audio.clone();
        }

        Ok(())
    }

    fn type_name(&self) -> &'static str {
        "SetAudioFadeIn"
    }

    fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "sequenceId": self.sequence_id,
            "trackId": self.track_id,
            "clipId": self.clip_id,
            "duration": self.duration,
            "fadeType": self.fade_type,
        })
    }
}

// =============================================================================
// SetAudioFadeOutCommand
// =============================================================================

/// Command to set audio fade-out duration and curve type on a clip.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetAudioFadeOutCommand {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    pub clip_id: ClipId,
    pub duration: f64,
    pub fade_type: FadeType,
    #[serde(skip)]
    previous_audio: Option<AudioSettings>,
}

impl SetAudioFadeOutCommand {
    pub fn new(
        sequence_id: &str,
        track_id: &str,
        clip_id: &str,
        duration: f64,
        fade_type: FadeType,
    ) -> Self {
        Self {
            sequence_id: sequence_id.to_string(),
            track_id: track_id.to_string(),
            clip_id: clip_id.to_string(),
            duration,
            fade_type,
            previous_audio: None,
        }
    }
}

impl Command for SetAudioFadeOutCommand {
    fn execute(&mut self, state: &mut ProjectState) -> CoreResult<CommandResult> {
        if !self.duration.is_finite() || self.duration < 0.0 {
            return Err(CoreError::InvalidCommand(
                "Fade-out duration must be a non-negative finite number".to_string(),
            ));
        }

        let sequence = state
            .sequences
            .get_mut(&self.sequence_id)
            .ok_or_else(|| CoreError::SequenceNotFound(self.sequence_id.clone()))?;
        let track = sequence
            .get_track_mut(&self.track_id)
            .ok_or_else(|| CoreError::TrackNotFound(self.track_id.clone()))?;
        let clip = track
            .get_clip_mut(&self.clip_id)
            .ok_or_else(|| CoreError::ClipNotFound(self.clip_id.clone()))?;

        self.previous_audio = Some(clip.audio.clone());

        let clip_duration = clip.duration().max(0.0);
        clip.audio.fade_out_sec = self.duration.min(clip_duration);
        clip.audio.fade_out_type = self.fade_type.clone();

        // Ensure fades don't exceed clip duration
        let total = clip.audio.fade_in_sec + clip.audio.fade_out_sec;
        if total > clip_duration {
            clip.audio.fade_in_sec = (clip_duration - clip.audio.fade_out_sec).max(0.0);
        }

        let op_id = ulid::Ulid::new().to_string();
        Ok(
            CommandResult::new(&op_id).with_change(StateChange::ClipModified {
                clip_id: self.clip_id.clone(),
            }),
        )
    }

    fn undo(&self, state: &mut ProjectState) -> CoreResult<()> {
        let Some(previous_audio) = &self.previous_audio else {
            return Ok(());
        };

        let Some(sequence) = state.sequences.get_mut(&self.sequence_id) else {
            return Ok(());
        };
        let Some(track) = sequence.get_track_mut(&self.track_id) else {
            return Ok(());
        };
        if let Some(clip) = track.get_clip_mut(&self.clip_id) {
            clip.audio = previous_audio.clone();
        }

        Ok(())
    }

    fn type_name(&self) -> &'static str {
        "SetAudioFadeOut"
    }

    fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "sequenceId": self.sequence_id,
            "trackId": self.track_id,
            "clipId": self.clip_id,
            "duration": self.duration,
            "fadeType": self.fade_type,
        })
    }
}

// =============================================================================
// AddAudioKeyframeCommand
// =============================================================================

/// Command to add a volume automation keyframe to a clip's audio settings.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddAudioKeyframeCommand {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    pub clip_id: ClipId,
    /// Time offset from clip start in seconds
    pub time_offset: f64,
    /// Volume value in dB
    pub value_db: f64,
    /// Interpolation method to the next keyframe
    #[serde(default)]
    pub interpolation: KeyframeInterpolation,
    /// Index at which the keyframe was inserted (for undo)
    #[serde(skip)]
    inserted_index: Option<usize>,
    /// Actual clamped value stored for precise undo identification
    #[serde(skip)]
    clamped_value_db: Option<f64>,
}

impl AddAudioKeyframeCommand {
    pub fn new(
        sequence_id: &str,
        track_id: &str,
        clip_id: &str,
        time_offset: f64,
        value_db: f64,
        interpolation: KeyframeInterpolation,
    ) -> Self {
        Self {
            sequence_id: sequence_id.to_string(),
            track_id: track_id.to_string(),
            clip_id: clip_id.to_string(),
            time_offset,
            value_db,
            interpolation,
            inserted_index: None,
            clamped_value_db: None,
        }
    }
}

impl Command for AddAudioKeyframeCommand {
    fn execute(&mut self, state: &mut ProjectState) -> CoreResult<CommandResult> {
        if !self.time_offset.is_finite() || self.time_offset < 0.0 {
            return Err(CoreError::InvalidCommand(
                "timeOffset must be a finite, non-negative number".to_string(),
            ));
        }
        if !self.value_db.is_finite() {
            return Err(CoreError::InvalidCommand(
                "valueDb must be a finite number".to_string(),
            ));
        }

        let sequence = state
            .sequences
            .get_mut(&self.sequence_id)
            .ok_or_else(|| CoreError::SequenceNotFound(self.sequence_id.clone()))?;
        let track = sequence
            .get_track_mut(&self.track_id)
            .ok_or_else(|| CoreError::TrackNotFound(self.track_id.clone()))?;
        validate_track_unlocked(track)?;
        let clip = track
            .get_clip_mut(&self.clip_id)
            .ok_or_else(|| CoreError::ClipNotFound(self.clip_id.clone()))?;

        // Validate time_offset is within clip duration
        let clip_duration = clip.duration();
        if self.time_offset > clip_duration {
            return Err(CoreError::InvalidCommand(format!(
                "timeOffset ({:.3}s) exceeds clip duration ({:.3}s)",
                self.time_offset, clip_duration
            )));
        }

        let clamped_db = self
            .value_db
            .clamp(MIN_CLIP_VOLUME_DB as f64, MAX_CLIP_VOLUME_DB as f64);
        let keyframe = AudioKeyframe::new(self.time_offset, clamped_db, self.interpolation.clone());
        self.clamped_value_db = Some(clamped_db);

        clip.audio.volume_keyframes.push(keyframe);
        AudioKeyframe::sort_by_time(&mut clip.audio.volume_keyframes);

        // Find the inserted index for undo — match on both time AND value
        // to avoid ambiguity when multiple keyframes share the same time.
        self.inserted_index = clip.audio.volume_keyframes.iter().position(|kf| {
            (kf.time_offset - self.time_offset).abs() < 1e-9
                && (kf.value_db - clamped_db).abs() < 1e-9
        });

        let op_id = ulid::Ulid::new().to_string();
        Ok(
            CommandResult::new(&op_id).with_change(StateChange::ClipModified {
                clip_id: self.clip_id.clone(),
            }),
        )
    }

    fn undo(&self, state: &mut ProjectState) -> CoreResult<()> {
        let Some(index) = self.inserted_index else {
            return Ok(());
        };

        let Some(sequence) = state.sequences.get_mut(&self.sequence_id) else {
            return Ok(());
        };
        let Some(track) = sequence.get_track_mut(&self.track_id) else {
            return Ok(());
        };
        if let Some(clip) = track.get_clip_mut(&self.clip_id) {
            if index < clip.audio.volume_keyframes.len() {
                clip.audio.volume_keyframes.remove(index);
            }
        }
        Ok(())
    }

    fn type_name(&self) -> &'static str {
        "AddAudioKeyframe"
    }

    fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "sequenceId": self.sequence_id,
            "trackId": self.track_id,
            "clipId": self.clip_id,
            "timeOffset": self.time_offset,
            "valueDb": self.value_db,
            "interpolation": self.interpolation,
        })
    }
}

// =============================================================================
// RemoveAudioKeyframeCommand
// =============================================================================

/// Command to remove a volume automation keyframe by index.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveAudioKeyframeCommand {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    pub clip_id: ClipId,
    /// Index of the keyframe to remove (sorted order)
    pub keyframe_index: usize,
    /// Removed keyframe stored for undo
    #[serde(skip)]
    removed_keyframe: Option<AudioKeyframe>,
}

impl RemoveAudioKeyframeCommand {
    pub fn new(sequence_id: &str, track_id: &str, clip_id: &str, keyframe_index: usize) -> Self {
        Self {
            sequence_id: sequence_id.to_string(),
            track_id: track_id.to_string(),
            clip_id: clip_id.to_string(),
            keyframe_index,
            removed_keyframe: None,
        }
    }
}

impl Command for RemoveAudioKeyframeCommand {
    fn execute(&mut self, state: &mut ProjectState) -> CoreResult<CommandResult> {
        let sequence = state
            .sequences
            .get_mut(&self.sequence_id)
            .ok_or_else(|| CoreError::SequenceNotFound(self.sequence_id.clone()))?;
        let track = sequence
            .get_track_mut(&self.track_id)
            .ok_or_else(|| CoreError::TrackNotFound(self.track_id.clone()))?;
        validate_track_unlocked(track)?;
        let clip = track
            .get_clip_mut(&self.clip_id)
            .ok_or_else(|| CoreError::ClipNotFound(self.clip_id.clone()))?;

        if self.keyframe_index >= clip.audio.volume_keyframes.len() {
            return Err(CoreError::InvalidCommand(format!(
                "keyframeIndex {} out of bounds (clip has {} keyframes)",
                self.keyframe_index,
                clip.audio.volume_keyframes.len()
            )));
        }

        self.removed_keyframe = Some(clip.audio.volume_keyframes.remove(self.keyframe_index));

        let op_id = ulid::Ulid::new().to_string();
        Ok(
            CommandResult::new(&op_id).with_change(StateChange::ClipModified {
                clip_id: self.clip_id.clone(),
            }),
        )
    }

    fn undo(&self, state: &mut ProjectState) -> CoreResult<()> {
        let Some(ref removed) = self.removed_keyframe else {
            return Ok(());
        };

        let Some(sequence) = state.sequences.get_mut(&self.sequence_id) else {
            return Ok(());
        };
        let Some(track) = sequence.get_track_mut(&self.track_id) else {
            return Ok(());
        };
        if let Some(clip) = track.get_clip_mut(&self.clip_id) {
            let index = self.keyframe_index.min(clip.audio.volume_keyframes.len());
            clip.audio.volume_keyframes.insert(index, removed.clone());
            // Re-sort to guarantee time ordering after restore
            AudioKeyframe::sort_by_time(&mut clip.audio.volume_keyframes);
        }
        Ok(())
    }

    fn type_name(&self) -> &'static str {
        "RemoveAudioKeyframe"
    }

    fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "sequenceId": self.sequence_id,
            "trackId": self.track_id,
            "clipId": self.clip_id,
            "keyframeIndex": self.keyframe_index,
        })
    }
}

// =============================================================================
// MoveAudioKeyframeCommand
// =============================================================================

/// Command to move a volume automation keyframe to a new time offset.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveAudioKeyframeCommand {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    pub clip_id: ClipId,
    /// Index of the keyframe to move (sorted order, pre-move)
    pub keyframe_index: usize,
    /// New time offset from clip start in seconds
    pub new_time_offset: f64,
    /// Previous time offset stored for undo
    #[serde(skip)]
    previous_time_offset: Option<f64>,
    /// Index of the keyframe after move + re-sort (for reliable undo)
    #[serde(skip)]
    moved_to_index: Option<usize>,
    /// Value stored for disambiguation when multiple keyframes share the same time
    #[serde(skip)]
    keyframe_value_db: Option<f64>,
}

impl MoveAudioKeyframeCommand {
    pub fn new(
        sequence_id: &str,
        track_id: &str,
        clip_id: &str,
        keyframe_index: usize,
        new_time_offset: f64,
    ) -> Self {
        Self {
            sequence_id: sequence_id.to_string(),
            track_id: track_id.to_string(),
            clip_id: clip_id.to_string(),
            keyframe_index,
            new_time_offset,
            previous_time_offset: None,
            moved_to_index: None,
            keyframe_value_db: None,
        }
    }
}

impl Command for MoveAudioKeyframeCommand {
    fn execute(&mut self, state: &mut ProjectState) -> CoreResult<CommandResult> {
        if !self.new_time_offset.is_finite() || self.new_time_offset < 0.0 {
            return Err(CoreError::InvalidCommand(
                "newTimeOffset must be a finite, non-negative number".to_string(),
            ));
        }

        let sequence = state
            .sequences
            .get_mut(&self.sequence_id)
            .ok_or_else(|| CoreError::SequenceNotFound(self.sequence_id.clone()))?;
        let track = sequence
            .get_track_mut(&self.track_id)
            .ok_or_else(|| CoreError::TrackNotFound(self.track_id.clone()))?;
        validate_track_unlocked(track)?;
        let clip = track
            .get_clip_mut(&self.clip_id)
            .ok_or_else(|| CoreError::ClipNotFound(self.clip_id.clone()))?;

        if self.keyframe_index >= clip.audio.volume_keyframes.len() {
            return Err(CoreError::InvalidCommand(format!(
                "keyframeIndex {} out of bounds (clip has {} keyframes)",
                self.keyframe_index,
                clip.audio.volume_keyframes.len()
            )));
        }

        let clip_duration = clip.duration();
        if self.new_time_offset > clip_duration {
            return Err(CoreError::InvalidCommand(format!(
                "newTimeOffset ({:.3}s) exceeds clip duration ({:.3}s)",
                self.new_time_offset, clip_duration
            )));
        }

        let kf = &clip.audio.volume_keyframes[self.keyframe_index];
        self.previous_time_offset = Some(kf.time_offset);
        self.keyframe_value_db = Some(kf.value_db);
        clip.audio.volume_keyframes[self.keyframe_index].time_offset = self.new_time_offset;

        // Re-sort after move
        AudioKeyframe::sort_by_time(&mut clip.audio.volume_keyframes);

        // Store post-move index for reliable undo (match on time + value)
        self.moved_to_index = clip.audio.volume_keyframes.iter().position(|kf| {
            (kf.time_offset - self.new_time_offset).abs() < 1e-9
                && self
                    .keyframe_value_db
                    .is_none_or(|v| (kf.value_db - v).abs() < 1e-9)
        });

        let op_id = ulid::Ulid::new().to_string();
        Ok(
            CommandResult::new(&op_id).with_change(StateChange::ClipModified {
                clip_id: self.clip_id.clone(),
            }),
        )
    }

    fn undo(&self, state: &mut ProjectState) -> CoreResult<()> {
        let Some(prev_offset) = self.previous_time_offset else {
            return Ok(());
        };

        let Some(sequence) = state.sequences.get_mut(&self.sequence_id) else {
            return Ok(());
        };
        let Some(track) = sequence.get_track_mut(&self.track_id) else {
            return Ok(());
        };
        if let Some(clip) = track.get_clip_mut(&self.clip_id) {
            // Use the stored post-move index for reliable undo
            let target_idx = self.moved_to_index.or_else(|| {
                // Fallback: search by time + value
                clip.audio.volume_keyframes.iter().position(|kf| {
                    (kf.time_offset - self.new_time_offset).abs() < 1e-9
                        && self
                            .keyframe_value_db
                            .is_none_or(|v| (kf.value_db - v).abs() < 1e-9)
                })
            });

            if let Some(idx) = target_idx {
                if idx < clip.audio.volume_keyframes.len() {
                    clip.audio.volume_keyframes[idx].time_offset = prev_offset;
                    AudioKeyframe::sort_by_time(&mut clip.audio.volume_keyframes);
                }
            }
        }
        Ok(())
    }

    fn type_name(&self) -> &'static str {
        "MoveAudioKeyframe"
    }

    fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "sequenceId": self.sequence_id,
            "trackId": self.track_id,
            "clipId": self.clip_id,
            "keyframeIndex": self.keyframe_index,
            "newTimeOffset": self.new_time_offset,
        })
    }
}

// =============================================================================
// SetAudioKeyframeValueCommand
// =============================================================================

/// Command to update the volume value of an existing audio keyframe.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetAudioKeyframeValueCommand {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    pub clip_id: ClipId,
    /// Index of the keyframe to update (sorted order)
    pub keyframe_index: usize,
    /// New volume value in dB
    pub value_db: f64,
    /// Optional new interpolation method
    pub interpolation: Option<KeyframeInterpolation>,
    /// Previous value stored for undo
    #[serde(skip)]
    previous_value_db: Option<f64>,
    #[serde(skip)]
    previous_interpolation: Option<KeyframeInterpolation>,
}

impl SetAudioKeyframeValueCommand {
    pub fn new(
        sequence_id: &str,
        track_id: &str,
        clip_id: &str,
        keyframe_index: usize,
        value_db: f64,
        interpolation: Option<KeyframeInterpolation>,
    ) -> Self {
        Self {
            sequence_id: sequence_id.to_string(),
            track_id: track_id.to_string(),
            clip_id: clip_id.to_string(),
            keyframe_index,
            value_db,
            interpolation,
            previous_value_db: None,
            previous_interpolation: None,
        }
    }
}

impl Command for SetAudioKeyframeValueCommand {
    fn execute(&mut self, state: &mut ProjectState) -> CoreResult<CommandResult> {
        if !self.value_db.is_finite() {
            return Err(CoreError::InvalidCommand(
                "valueDb must be a finite number".to_string(),
            ));
        }

        let sequence = state
            .sequences
            .get_mut(&self.sequence_id)
            .ok_or_else(|| CoreError::SequenceNotFound(self.sequence_id.clone()))?;
        let track = sequence
            .get_track_mut(&self.track_id)
            .ok_or_else(|| CoreError::TrackNotFound(self.track_id.clone()))?;
        validate_track_unlocked(track)?;
        let clip = track
            .get_clip_mut(&self.clip_id)
            .ok_or_else(|| CoreError::ClipNotFound(self.clip_id.clone()))?;

        if self.keyframe_index >= clip.audio.volume_keyframes.len() {
            return Err(CoreError::InvalidCommand(format!(
                "keyframeIndex {} out of bounds (clip has {} keyframes)",
                self.keyframe_index,
                clip.audio.volume_keyframes.len()
            )));
        }

        let kf = &mut clip.audio.volume_keyframes[self.keyframe_index];
        self.previous_value_db = Some(kf.value_db);
        self.previous_interpolation = Some(kf.interpolation.clone());

        kf.value_db = self
            .value_db
            .clamp(MIN_CLIP_VOLUME_DB as f64, MAX_CLIP_VOLUME_DB as f64);

        if let Some(ref interp) = self.interpolation {
            kf.interpolation = interp.clone();
        }

        let op_id = ulid::Ulid::new().to_string();
        Ok(
            CommandResult::new(&op_id).with_change(StateChange::ClipModified {
                clip_id: self.clip_id.clone(),
            }),
        )
    }

    fn undo(&self, state: &mut ProjectState) -> CoreResult<()> {
        let (Some(prev_value), Some(ref prev_interp)) =
            (self.previous_value_db, &self.previous_interpolation)
        else {
            return Ok(());
        };

        let Some(sequence) = state.sequences.get_mut(&self.sequence_id) else {
            return Ok(());
        };
        let Some(track) = sequence.get_track_mut(&self.track_id) else {
            return Ok(());
        };
        if let Some(clip) = track.get_clip_mut(&self.clip_id) {
            if let Some(kf) = clip.audio.volume_keyframes.get_mut(self.keyframe_index) {
                kf.value_db = prev_value;
                kf.interpolation = prev_interp.clone();
            }
        }
        Ok(())
    }

    fn type_name(&self) -> &'static str {
        "SetAudioKeyframeValue"
    }

    fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "sequenceId": self.sequence_id,
            "trackId": self.track_id,
            "clipId": self.clip_id,
            "keyframeIndex": self.keyframe_index,
            "valueDb": self.value_db,
            "interpolation": self.interpolation,
        })
    }
}

// =============================================================================
// SetClipTransformCommand
// =============================================================================

/// Command to update a clip's transform (position/scale/rotation/anchor).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetClipTransformCommand {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    pub clip_id: ClipId,
    pub transform: Transform,
    #[serde(skip)]
    previous_transform: Option<Transform>,
}

impl SetClipTransformCommand {
    pub fn new(sequence_id: &str, track_id: &str, clip_id: &str, transform: Transform) -> Self {
        Self {
            sequence_id: sequence_id.to_string(),
            track_id: track_id.to_string(),
            clip_id: clip_id.to_string(),
            transform,
            previous_transform: None,
        }
    }

    fn sanitize_transform(mut transform: Transform) -> Transform {
        // Position/anchor are normalized.
        transform.position.x = transform.position.x.clamp(0.0, 1.0);
        transform.position.y = transform.position.y.clamp(0.0, 1.0);
        transform.anchor.x = transform.anchor.x.clamp(0.0, 1.0);
        transform.anchor.y = transform.anchor.y.clamp(0.0, 1.0);

        // Scale must be finite and non-zero-ish. Clamp to a reasonable range.
        if !transform.scale.x.is_finite() {
            transform.scale.x = 1.0;
        }
        if !transform.scale.y.is_finite() {
            transform.scale.y = 1.0;
        }
        transform.scale.x = transform.scale.x.clamp(0.01, 100.0);
        transform.scale.y = transform.scale.y.clamp(0.01, 100.0);

        // Rotation must be finite.
        if !transform.rotation_deg.is_finite() {
            transform.rotation_deg = 0.0;
        }

        transform
    }
}

impl Command for SetClipTransformCommand {
    fn execute(&mut self, state: &mut ProjectState) -> CoreResult<CommandResult> {
        let sequence = state
            .sequences
            .get_mut(&self.sequence_id)
            .ok_or_else(|| CoreError::SequenceNotFound(self.sequence_id.clone()))?;

        let track = sequence
            .tracks
            .iter_mut()
            .find(|t| t.id == self.track_id)
            .ok_or_else(|| CoreError::TrackNotFound(self.track_id.clone()))?;

        let clip = track
            .clips
            .iter_mut()
            .find(|c| c.id == self.clip_id)
            .ok_or_else(|| CoreError::ClipNotFound(self.clip_id.clone()))?;

        self.previous_transform = Some(clip.transform.clone());
        clip.transform = Self::sanitize_transform(self.transform.clone());

        let op_id = ulid::Ulid::new().to_string();
        Ok(
            CommandResult::new(&op_id).with_change(StateChange::ClipModified {
                clip_id: self.clip_id.clone(),
            }),
        )
    }

    fn undo(&self, state: &mut ProjectState) -> CoreResult<()> {
        let Some(prev) = &self.previous_transform else {
            return Ok(());
        };

        let Some(sequence) = state.sequences.get_mut(&self.sequence_id) else {
            return Ok(());
        };

        let Some(track) = sequence.tracks.iter_mut().find(|t| t.id == self.track_id) else {
            return Ok(());
        };

        if let Some(clip) = track.clips.iter_mut().find(|c| c.id == self.clip_id) {
            clip.transform = prev.clone();
        }

        Ok(())
    }

    fn type_name(&self) -> &'static str {
        "SetClipTransform"
    }

    fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "sequenceId": self.sequence_id,
            "trackId": self.track_id,
            "clipId": self.clip_id,
            "transform": self.transform,
        })
    }
}

// =============================================================================
// SetClipBlendModeCommand
// =============================================================================

/// Command to set a clip's blend mode.
///
/// Blend modes control how a clip composites with clips below it.
/// Only supported on video/overlay tracks.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetClipBlendModeCommand {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    pub clip_id: ClipId,
    pub blend_mode: BlendMode,
    #[serde(skip)]
    previous_blend_mode: Option<BlendMode>,
}

impl SetClipBlendModeCommand {
    pub fn new(sequence_id: &str, track_id: &str, clip_id: &str, blend_mode: BlendMode) -> Self {
        Self {
            sequence_id: sequence_id.to_string(),
            track_id: track_id.to_string(),
            clip_id: clip_id.to_string(),
            blend_mode,
            previous_blend_mode: None,
        }
    }
}

impl Command for SetClipBlendModeCommand {
    fn execute(&mut self, state: &mut ProjectState) -> CoreResult<CommandResult> {
        let sequence = state
            .sequences
            .get_mut(&self.sequence_id)
            .ok_or_else(|| CoreError::SequenceNotFound(self.sequence_id.clone()))?;

        let track = sequence
            .tracks
            .iter_mut()
            .find(|t| t.id == self.track_id)
            .ok_or_else(|| CoreError::TrackNotFound(self.track_id.clone()))?;

        if !track.is_video() {
            return Err(CoreError::NotSupported(
                "Blend mode is only supported for video clips".to_string(),
            ));
        }

        let clip = track
            .clips
            .iter_mut()
            .find(|c| c.id == self.clip_id)
            .ok_or_else(|| CoreError::ClipNotFound(self.clip_id.clone()))?;

        self.previous_blend_mode = Some(clip.blend_mode.clone());
        clip.blend_mode = self.blend_mode.clone();

        let op_id = ulid::Ulid::new().to_string();
        Ok(
            CommandResult::new(&op_id).with_change(StateChange::ClipModified {
                clip_id: self.clip_id.clone(),
            }),
        )
    }

    fn undo(&self, state: &mut ProjectState) -> CoreResult<()> {
        let Some(prev) = &self.previous_blend_mode else {
            return Ok(());
        };

        let Some(sequence) = state.sequences.get_mut(&self.sequence_id) else {
            return Ok(());
        };

        let Some(track) = sequence.tracks.iter_mut().find(|t| t.id == self.track_id) else {
            return Ok(());
        };

        if let Some(clip) = track.clips.iter_mut().find(|c| c.id == self.clip_id) {
            clip.blend_mode = prev.clone();
        }

        Ok(())
    }

    fn type_name(&self) -> &'static str {
        "SetClipBlendMode"
    }

    fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "sequenceId": self.sequence_id,
            "trackId": self.track_id,
            "clipId": self.clip_id,
            "blendMode": self.blend_mode,
        })
    }
}

impl Command for SplitClipCommand {
    fn execute(&mut self, state: &mut ProjectState) -> CoreResult<CommandResult> {
        let sequence = state
            .sequences
            .get_mut(&self.sequence_id)
            .ok_or_else(|| CoreError::SequenceNotFound(self.sequence_id.clone()))?;

        let track = sequence
            .tracks
            .iter_mut()
            .find(|t| t.id == self.track_id)
            .ok_or_else(|| CoreError::TrackNotFound(self.track_id.clone()))?;

        let clip_idx = track
            .clips
            .iter()
            .position(|c| c.id == self.clip_id)
            .ok_or_else(|| CoreError::ClipNotFound(self.clip_id.clone()))?;

        // Store original clip for undo BEFORE any modification
        self.original_clip = Some(track.clips[clip_idx].clone());

        let original = track.clips[clip_idx].clone();

        // Validate split point is within clip bounds
        let clip_start = original.place.timeline_in_sec;
        let clip_end = clip_start + original.duration();

        if self.split_at <= clip_start || self.split_at >= clip_end {
            return Err(CoreError::InvalidSplitPoint(self.split_at));
        }

        let relative_split = self.split_at - clip_start;
        let ((first_source_in, first_source_out), (second_source_in, second_source_out)) =
            split_clip_ranges_at(&original, self.split_at);
        let second_timeline_duration = clip_end - self.split_at;

        let second_clip = clone_clip_fragment_with_rebased_time_remap(
            &original,
            second_source_in,
            second_source_out,
            self.split_at,
            second_timeline_duration,
            relative_split,
        );

        let second_clip_id = second_clip.id.clone();

        // Store created clip ID for undo
        self.created_clip_id = Some(second_clip_id.clone());

        // Prepare modified first clip without mutating track until validations pass.
        let mut first_clip = original.clone();
        first_clip.range.source_in_sec = first_source_in;
        first_clip.range.source_out_sec = first_source_out;
        first_clip.place.duration_sec = relative_split;
        rebase_clip_time_remap_for_fragment(&mut first_clip, 0.0, relative_split);

        if !first_clip.place.duration_sec.is_finite() || first_clip.place.duration_sec <= 0.0 {
            return Err(CoreError::ValidationError(
                "Split produced an invalid first clip duration".to_string(),
            ));
        }
        if !second_clip.place.duration_sec.is_finite() || second_clip.place.duration_sec <= 0.0 {
            return Err(CoreError::ValidationError(
                "Split produced an invalid second clip duration".to_string(),
            ));
        }

        // Validate overlap with the rest of the track BEFORE mutating.
        validate_no_overlap(track, &first_clip.place, Some(&first_clip.id))?;
        validate_no_overlap(track, &second_clip.place, Some(&first_clip.id))?;

        // Apply: replace original clip and insert the new clip in timeline order.
        track.clips[clip_idx] = first_clip;
        insert_clip_sorted(track, second_clip);

        let op_id = ulid::Ulid::new().to_string();

        Ok(CommandResult::new(&op_id)
            .with_change(StateChange::ClipModified {
                clip_id: self.clip_id.clone(),
            })
            .with_change(StateChange::ClipCreated {
                clip_id: second_clip_id.clone(),
            })
            .with_created_id(&second_clip_id))
    }

    fn undo(&self, state: &mut ProjectState) -> CoreResult<()> {
        if let (Some(original), Some(created_id)) = (&self.original_clip, &self.created_clip_id) {
            if let Some(sequence) = state.sequences.get_mut(&self.sequence_id) {
                if let Some(track) = sequence.tracks.iter_mut().find(|t| t.id == self.track_id) {
                    // Remove the created clip
                    track.clips.retain(|c| &c.id != created_id);

                    // Restore original clip
                    if let Some(clip) = track.clips.iter_mut().find(|c| c.id == self.clip_id) {
                        *clip = original.clone();
                    }

                    sort_track_clips(track);
                }
            }
        }
        Ok(())
    }

    fn type_name(&self) -> &'static str {
        "SplitClip"
    }

    fn to_json(&self) -> serde_json::Value {
        serde_json::to_value(self).unwrap_or(serde_json::json!({}))
    }
}

// =============================================================================
// GapInfo — data returned by find_gaps
// =============================================================================

/// Describes a gap (empty region) between clips on a track.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GapInfo {
    /// Start time of the gap (end of preceding clip).
    pub start: TimeSec,
    /// End time of the gap (start of next clip).
    pub end: TimeSec,
    /// Duration of the gap.
    pub duration: TimeSec,
}

/// Scans a track for gaps between clips.
///
/// Returns a sorted list of gaps. Adjacent/overlapping clips produce no gap.
/// Only gaps with positive duration (> 1 microsecond tolerance) are included.
pub fn find_gaps(track: &Track) -> Vec<GapInfo> {
    if track.clips.is_empty() {
        return Vec::new();
    }

    // Clips should already be sorted, but ensure deterministic ordering.
    let mut sorted_clips: Vec<&Clip> = track.clips.iter().collect();
    sorted_clips.sort_by(|a, b| {
        a.place
            .timeline_in_sec
            .total_cmp(&b.place.timeline_in_sec)
            .then_with(|| a.id.cmp(&b.id))
    });

    let mut gaps = Vec::new();
    const EPSILON: f64 = 1e-6;

    for window in sorted_clips.windows(2) {
        let prev_end = window[0].place.timeline_out_sec();
        let next_start = window[1].place.timeline_in_sec;
        let gap_duration = next_start - prev_end;

        if gap_duration > EPSILON {
            gaps.push(GapInfo {
                start: prev_end,
                end: next_start,
                duration: gap_duration,
            });
        }
    }

    gaps
}

// =============================================================================
// CloseGapCommand
// =============================================================================

/// Command to close a specific gap by shifting all downstream clips left.
///
/// All clips starting at or after `gap_end` on the target track are shifted
/// left by `gap_duration`. Sync-locked tracks shift their clips in tandem.
/// Locked tracks are never modified.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloseGapCommand {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    /// Start of the gap to close.
    pub gap_start: TimeSec,
    /// End of the gap to close.
    pub gap_end: TimeSec,

    // --- Undo state ---
    #[serde(skip)]
    shifted_clips: Vec<ShiftedClipRecord>,
    #[serde(skip)]
    gap_duration: TimeSec,
}

impl CloseGapCommand {
    pub fn new(sequence_id: &str, track_id: &str, gap_start: TimeSec, gap_end: TimeSec) -> Self {
        Self {
            sequence_id: sequence_id.to_string(),
            track_id: track_id.to_string(),
            gap_start,
            gap_end,
            shifted_clips: Vec::new(),
            gap_duration: 0.0,
        }
    }
}

impl Command for CloseGapCommand {
    fn execute(&mut self, state: &mut ProjectState) -> CoreResult<CommandResult> {
        if !is_valid_time_sec(self.gap_start) || !is_valid_time_sec(self.gap_end) {
            return Err(CoreError::ValidationError(
                "Invalid gap time range".to_string(),
            ));
        }
        if self.gap_end <= self.gap_start {
            return Err(CoreError::ValidationError(
                "gap_end must be greater than gap_start".to_string(),
            ));
        }

        let gap_duration = self.gap_end - self.gap_start;

        let sequence = state
            .sequences
            .get(&self.sequence_id)
            .ok_or_else(|| CoreError::SequenceNotFound(self.sequence_id.clone()))?;

        let track = sequence
            .tracks
            .iter()
            .find(|t| t.id == self.track_id)
            .ok_or_else(|| CoreError::TrackNotFound(self.track_id.clone()))?;

        if track.locked {
            return Err(CoreError::ValidationError(format!(
                "Track '{}' is locked",
                self.track_id
            )));
        }

        // Verify there is actually a gap at the specified location:
        // No clip should occupy the [gap_start, gap_end) region.
        let has_clip_in_gap = track.clips.iter().any(|c| {
            let clip_start = c.place.timeline_in_sec;
            let clip_end = c.place.timeline_out_sec();
            // Clip overlaps gap if clip_start < gap_end AND clip_end > gap_start
            clip_start < self.gap_end && clip_end > self.gap_start
        });
        if has_clip_in_gap {
            return Err(CoreError::ValidationError(
                "No gap exists at the specified location — a clip occupies that region".to_string(),
            ));
        }

        // Collect shift records for target track: all clips starting at or after gap_end
        let mut shift_records: Vec<ShiftedClipRecord> = Vec::new();

        for clip in &track.clips {
            if clip.place.timeline_in_sec >= self.gap_end - 1e-6 {
                shift_records.push(ShiftedClipRecord {
                    track_id: self.track_id.clone(),
                    clip_id: clip.id.clone(),
                    original_timeline_in: clip.place.timeline_in_sec,
                });
            }
        }

        // Sync-locked tracks: shift clips at or after gap_start
        for other_track in &sequence.tracks {
            if other_track.id == self.track_id || other_track.locked || !other_track.sync_lock {
                continue;
            }
            for clip in &other_track.clips {
                if clip.place.timeline_in_sec >= self.gap_end - 1e-6 {
                    shift_records.push(ShiftedClipRecord {
                        track_id: other_track.id.clone(),
                        clip_id: clip.id.clone(),
                        original_timeline_in: clip.place.timeline_in_sec,
                    });
                }
            }
        }

        // --- Mutate state ---
        let sequence = state
            .sequences
            .get_mut(&self.sequence_id)
            .ok_or_else(|| CoreError::SequenceNotFound(self.sequence_id.clone()))?;

        for record in &shift_records {
            if let Some(track) = sequence.tracks.iter_mut().find(|t| t.id == record.track_id) {
                if let Some(clip) = track.clips.iter_mut().find(|c| c.id == record.clip_id) {
                    clip.place.timeline_in_sec -= gap_duration;
                }
                sort_track_clips(track);
            }
        }

        // Store undo state
        self.shifted_clips = shift_records;
        self.gap_duration = gap_duration;

        // Build result
        let op_id = ulid::Ulid::new().to_string();
        let mut result = CommandResult::new(&op_id);
        for record in &self.shifted_clips {
            result = result.with_change(StateChange::ClipModified {
                clip_id: record.clip_id.clone(),
            });
        }

        Ok(result)
    }

    fn undo(&self, state: &mut ProjectState) -> CoreResult<()> {
        let sequence = state
            .sequences
            .get_mut(&self.sequence_id)
            .ok_or_else(|| CoreError::SequenceNotFound(self.sequence_id.clone()))?;

        for record in self.shifted_clips.iter().rev() {
            if let Some(track) = sequence.tracks.iter_mut().find(|t| t.id == record.track_id) {
                if let Some(clip) = track.clips.iter_mut().find(|c| c.id == record.clip_id) {
                    clip.place.timeline_in_sec = record.original_timeline_in;
                }
                sort_track_clips(track);
            }
        }

        Ok(())
    }

    fn type_name(&self) -> &'static str {
        "CloseGap"
    }

    fn to_json(&self) -> serde_json::Value {
        serde_json::to_value(self).unwrap_or(serde_json::json!({}))
    }
}

// =============================================================================
// CloseAllGapsCommand
// =============================================================================

/// Command to remove all gaps on a track by ripple-shifting every clip leftward.
///
/// Each clip is repositioned so that `clip[i].timeline_in = clip[i-1].timeline_out`.
/// The first clip shifts to time 0 if there is a leading gap.
/// Sync-locked tracks shift their clips in tandem.
/// Locked tracks are never modified.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloseAllGapsCommand {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,

    // --- Undo state ---
    #[serde(skip)]
    shifted_clips: Vec<ShiftedClipRecord>,
    /// Total shift applied to sync-locked tracks (cumulative gap duration).
    #[serde(skip)]
    sync_shift_amount: TimeSec,
}

impl CloseAllGapsCommand {
    pub fn new(sequence_id: &str, track_id: &str) -> Self {
        Self {
            sequence_id: sequence_id.to_string(),
            track_id: track_id.to_string(),
            shifted_clips: Vec::new(),
            sync_shift_amount: 0.0,
        }
    }
}

impl Command for CloseAllGapsCommand {
    fn execute(&mut self, state: &mut ProjectState) -> CoreResult<CommandResult> {
        let sequence = state
            .sequences
            .get(&self.sequence_id)
            .ok_or_else(|| CoreError::SequenceNotFound(self.sequence_id.clone()))?;

        let track = sequence
            .tracks
            .iter()
            .find(|t| t.id == self.track_id)
            .ok_or_else(|| CoreError::TrackNotFound(self.track_id.clone()))?;

        if track.locked {
            return Err(CoreError::ValidationError(format!(
                "Track '{}' is locked",
                self.track_id
            )));
        }

        if track.clips.is_empty() {
            let op_id = ulid::Ulid::new().to_string();
            return Ok(CommandResult::new(&op_id));
        }

        // Work on a sorted copy to compute new positions
        let mut sorted_clips: Vec<&Clip> = track.clips.iter().collect();
        sorted_clips.sort_by(|a, b| {
            a.place
                .timeline_in_sec
                .total_cmp(&b.place.timeline_in_sec)
                .then_with(|| a.id.cmp(&b.id))
        });

        // Calculate new positions: pack clips left-to-right with no gaps
        let mut shift_records: Vec<ShiftedClipRecord> = Vec::new();
        let mut next_start: TimeSec = 0.0;
        let mut new_positions: Vec<(ClipId, TimeSec)> = Vec::new();

        for clip in &sorted_clips {
            let original_start = clip.place.timeline_in_sec;
            if (original_start - next_start).abs() > 1e-6 {
                shift_records.push(ShiftedClipRecord {
                    track_id: self.track_id.clone(),
                    clip_id: clip.id.clone(),
                    original_timeline_in: original_start,
                });
                new_positions.push((clip.id.clone(), next_start));
            }
            next_start += clip.place.duration_sec;
        }

        // Compute total gap removed for sync-locked tracks:
        // = original last clip end - new last clip end
        let original_end = sorted_clips
            .last()
            .map(|c| c.place.timeline_out_sec())
            .unwrap_or(0.0);
        let new_end = next_start;
        let total_gap_removed = original_end - new_end;

        // Determine the earliest affected position for sync-lock filtering
        let earliest_shift_pos = shift_records
            .first()
            .map(|r| r.original_timeline_in)
            .unwrap_or(0.0);

        // Sync-locked tracks: shift downstream clips by total_gap_removed
        if total_gap_removed > 1e-6 {
            for other_track in &sequence.tracks {
                if other_track.id == self.track_id || other_track.locked || !other_track.sync_lock {
                    continue;
                }
                for clip in &other_track.clips {
                    if clip.place.timeline_in_sec >= earliest_shift_pos {
                        shift_records.push(ShiftedClipRecord {
                            track_id: other_track.id.clone(),
                            clip_id: clip.id.clone(),
                            original_timeline_in: clip.place.timeline_in_sec,
                        });
                    }
                }
            }
        }

        // --- Mutate state ---
        let sequence = state
            .sequences
            .get_mut(&self.sequence_id)
            .ok_or_else(|| CoreError::SequenceNotFound(self.sequence_id.clone()))?;

        // Apply new positions to target track
        let target_track = sequence
            .tracks
            .iter_mut()
            .find(|t| t.id == self.track_id)
            .ok_or_else(|| CoreError::TrackNotFound(self.track_id.clone()))?;

        for (clip_id, new_pos) in &new_positions {
            if let Some(clip) = target_track.clips.iter_mut().find(|c| &c.id == clip_id) {
                clip.place.timeline_in_sec = *new_pos;
            }
        }
        sort_track_clips(target_track);

        // Shift sync-locked tracks
        if total_gap_removed > 1e-6 {
            for record in &shift_records {
                if record.track_id == self.track_id {
                    continue;
                }
                if let Some(track) = sequence.tracks.iter_mut().find(|t| t.id == record.track_id) {
                    if let Some(clip) = track.clips.iter_mut().find(|c| c.id == record.clip_id) {
                        clip.place.timeline_in_sec -= total_gap_removed;
                    }
                    sort_track_clips(track);
                }
            }
        }

        // Store undo state
        self.shifted_clips = shift_records;
        self.sync_shift_amount = total_gap_removed;

        // Build result
        let op_id = ulid::Ulid::new().to_string();
        let mut result = CommandResult::new(&op_id);
        for record in &self.shifted_clips {
            result = result.with_change(StateChange::ClipModified {
                clip_id: record.clip_id.clone(),
            });
        }

        Ok(result)
    }

    fn undo(&self, state: &mut ProjectState) -> CoreResult<()> {
        let sequence = state
            .sequences
            .get_mut(&self.sequence_id)
            .ok_or_else(|| CoreError::SequenceNotFound(self.sequence_id.clone()))?;

        // Restore all shifted clips to original positions (reverse order)
        for record in self.shifted_clips.iter().rev() {
            if let Some(track) = sequence.tracks.iter_mut().find(|t| t.id == record.track_id) {
                if let Some(clip) = track.clips.iter_mut().find(|c| c.id == record.clip_id) {
                    clip.place.timeline_in_sec = record.original_timeline_in;
                }
                sort_track_clips(track);
            }
        }

        Ok(())
    }

    fn type_name(&self) -> &'static str {
        "CloseAllGaps"
    }

    fn to_json(&self) -> serde_json::Value {
        serde_json::to_value(self).unwrap_or(serde_json::json!({}))
    }
}

// =============================================================================
// LinkClipsCommand
// =============================================================================

// Empty string marks an explicit "not linked" state. This suppresses the
// frontend's legacy implicit A/V matching without surfacing a visible link badge.
const EXPLICIT_UNLINK_SENTINEL: &str = "";

/// Command to link multiple clips together for synchronized editing.
/// Linked clips share a `link_group_id` and are selected/moved together.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkClipsCommand {
    pub sequence_id: SequenceId,
    /// Pairs of (track_id, clip_id) to link together
    pub clip_refs: Vec<(TrackId, ClipId)>,
    pub(crate) link_group_id: String,

    #[serde(skip)]
    previous_link_group_ids: Vec<(TrackId, ClipId, Option<String>)>,
}

impl LinkClipsCommand {
    pub fn new(sequence_id: &str, clip_refs: Vec<(String, String)>) -> Self {
        Self {
            sequence_id: sequence_id.to_string(),
            clip_refs,
            link_group_id: ulid::Ulid::new().to_string(),
            previous_link_group_ids: Vec::new(),
        }
    }
}

impl Command for LinkClipsCommand {
    fn execute(&mut self, state: &mut ProjectState) -> CoreResult<CommandResult> {
        // Deduplicate clip refs to prevent single-clip link groups
        let mut unique_refs = self.clip_refs.clone();
        unique_refs.sort();
        unique_refs.dedup();
        if unique_refs.len() < 2 {
            return Err(CoreError::ValidationError(
                "LinkClips requires at least 2 distinct clips".to_string(),
            ));
        }
        self.clip_refs = unique_refs;

        let sequence = state
            .sequences
            .get_mut(&self.sequence_id)
            .ok_or_else(|| CoreError::SequenceNotFound(self.sequence_id.clone()))?;

        let affected_refs = collect_affected_link_refs(sequence, &self.clip_refs)?;
        validate_clip_refs_unlocked(sequence, &affected_refs)?;
        self.previous_link_group_ids = capture_link_group_state(sequence, &affected_refs)?;

        // Apply link group ID to all clips (validated above, but propagate errors defensively)
        for (track_id, clip_id) in &self.clip_refs {
            let track = sequence
                .tracks
                .iter_mut()
                .find(|t| &t.id == track_id)
                .ok_or_else(|| CoreError::TrackNotFound(track_id.clone()))?;
            let clip = track
                .clips
                .iter_mut()
                .find(|c| &c.id == clip_id)
                .ok_or_else(|| CoreError::ClipNotFound(clip_id.clone()))?;
            clip.link_group_id = Some(self.link_group_id.clone());
        }

        let normalized_refs = normalize_degenerate_link_groups(sequence, &affected_refs)?;

        let op_id = ulid::Ulid::new().to_string();
        let mut result = CommandResult::new(&op_id);
        append_clip_modified_changes(&mut result, &self.clip_refs);
        append_clip_modified_changes(&mut result, &normalized_refs);
        Ok(result)
    }

    fn undo(&self, state: &mut ProjectState) -> CoreResult<()> {
        let Some(sequence) = state.sequences.get_mut(&self.sequence_id) else {
            return Ok(());
        };

        for (track_id, clip_id, prev_link) in &self.previous_link_group_ids {
            if let Some(track) = sequence.tracks.iter_mut().find(|t| &t.id == track_id) {
                if let Some(clip) = track.clips.iter_mut().find(|c| &c.id == clip_id) {
                    clip.link_group_id = prev_link.clone();
                }
            }
        }

        Ok(())
    }

    fn type_name(&self) -> &'static str {
        "LinkClips"
    }

    fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "sequenceId": self.sequence_id,
            "clipRefs": self.clip_refs.iter().map(|(t, c)| serde_json::json!({"trackId": t, "clipId": c})).collect::<Vec<_>>(),
            "linkGroupId": self.link_group_id,
        })
    }
}

// =============================================================================
// UnlinkClipsCommand
// =============================================================================

/// Command to unlink clips by removing their link_group_id.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnlinkClipsCommand {
    pub sequence_id: SequenceId,
    /// Pairs of (track_id, clip_id) to unlink
    pub clip_refs: Vec<(TrackId, ClipId)>,

    #[serde(skip)]
    previous_link_group_ids: Vec<(TrackId, ClipId, Option<String>)>,
}

impl UnlinkClipsCommand {
    pub fn new(sequence_id: &str, clip_refs: Vec<(String, String)>) -> Self {
        Self {
            sequence_id: sequence_id.to_string(),
            clip_refs,
            previous_link_group_ids: Vec::new(),
        }
    }
}

impl Command for UnlinkClipsCommand {
    fn execute(&mut self, state: &mut ProjectState) -> CoreResult<CommandResult> {
        let sequence = state
            .sequences
            .get_mut(&self.sequence_id)
            .ok_or_else(|| CoreError::SequenceNotFound(self.sequence_id.clone()))?;

        let affected_refs = collect_affected_link_refs(sequence, &self.clip_refs)?;
        validate_clip_refs_unlocked(sequence, &affected_refs)?;
        self.previous_link_group_ids = capture_link_group_state(sequence, &affected_refs)?;

        // Mark clips as explicitly unlinked so legacy implicit pairing does not
        // immediately re-link them on the frontend.
        for (track_id, clip_id) in &self.clip_refs {
            let track = sequence
                .tracks
                .iter_mut()
                .find(|t| &t.id == track_id)
                .ok_or_else(|| CoreError::TrackNotFound(track_id.clone()))?;
            let clip = track
                .clips
                .iter_mut()
                .find(|c| &c.id == clip_id)
                .ok_or_else(|| CoreError::ClipNotFound(clip_id.clone()))?;
            clip.link_group_id = Some(EXPLICIT_UNLINK_SENTINEL.to_string());
        }

        let normalized_refs = normalize_degenerate_link_groups(sequence, &affected_refs)?;

        let op_id = ulid::Ulid::new().to_string();
        let mut result = CommandResult::new(&op_id);
        append_clip_modified_changes(&mut result, &self.clip_refs);
        append_clip_modified_changes(&mut result, &normalized_refs);
        Ok(result)
    }

    fn undo(&self, state: &mut ProjectState) -> CoreResult<()> {
        let Some(sequence) = state.sequences.get_mut(&self.sequence_id) else {
            return Ok(());
        };

        for (track_id, clip_id, prev_link) in &self.previous_link_group_ids {
            if let Some(track) = sequence.tracks.iter_mut().find(|t| &t.id == track_id) {
                if let Some(clip) = track.clips.iter_mut().find(|c| &c.id == clip_id) {
                    clip.link_group_id = prev_link.clone();
                }
            }
        }

        Ok(())
    }

    fn type_name(&self) -> &'static str {
        "UnlinkClips"
    }

    fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "sequenceId": self.sequence_id,
            "clipRefs": self.clip_refs.iter().map(|(t, c)| serde_json::json!({"trackId": t, "clipId": c})).collect::<Vec<_>>(),
        })
    }
}

// =============================================================================
// DetachAudioCommand
// =============================================================================

/// Command to detach audio from a video clip, creating a separate audio clip
/// on a designated audio track. Both clips remain independent (unlinked).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetachAudioCommand {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    pub clip_id: ClipId,
    /// Optional target audio track ID. If None, uses first available audio track or creates one.
    pub target_audio_track_id: Option<TrackId>,

    #[serde(skip)]
    created_audio_clip_id: Option<ClipId>,
    #[serde(skip)]
    created_audio_track_id: Option<TrackId>,
    #[serde(skip)]
    previous_link_group_ids: Vec<(TrackId, ClipId, Option<String>)>,
}

impl DetachAudioCommand {
    pub fn new(
        sequence_id: &str,
        track_id: &str,
        clip_id: &str,
        target_audio_track_id: Option<String>,
    ) -> Self {
        Self {
            sequence_id: sequence_id.to_string(),
            track_id: track_id.to_string(),
            clip_id: clip_id.to_string(),
            target_audio_track_id,
            created_audio_clip_id: None,
            created_audio_track_id: None,
            previous_link_group_ids: Vec::new(),
        }
    }
}

impl Command for DetachAudioCommand {
    fn execute(&mut self, state: &mut ProjectState) -> CoreResult<CommandResult> {
        use crate::core::timeline::TrackKind;

        let sequence = state
            .sequences
            .get_mut(&self.sequence_id)
            .ok_or_else(|| CoreError::SequenceNotFound(self.sequence_id.clone()))?;

        // Validate source track is video/overlay (has visual content)
        let source_track = sequence
            .tracks
            .iter()
            .find(|t| t.id == self.track_id)
            .ok_or_else(|| CoreError::TrackNotFound(self.track_id.clone()))?;
        validate_track_unlocked(source_track)?;

        if !source_track.is_video() {
            return Err(CoreError::ValidationError(
                "Detach Audio is only available for clips on video/overlay tracks".to_string(),
            ));
        }

        // Find the source clip and create the audio clip
        let source_clip = source_track
            .clips
            .iter()
            .find(|c| c.id == self.clip_id)
            .ok_or_else(|| CoreError::ClipNotFound(self.clip_id.clone()))?;

        let affected_refs =
            collect_affected_link_refs(sequence, &[(self.track_id.clone(), self.clip_id.clone())])?;
        validate_clip_refs_unlocked(sequence, &affected_refs)?;
        self.previous_link_group_ids = capture_link_group_state(sequence, &affected_refs)?;

        // Create audio clip with same timing, range, speed, time remap, and audio settings
        let mut audio_clip = Clip::new(&source_clip.asset_id);
        audio_clip.range = source_clip.range.clone();
        audio_clip.place = source_clip.place.clone();
        audio_clip.speed = source_clip.speed;
        audio_clip.reverse = source_clip.reverse;
        audio_clip.audio = source_clip.audio.clone();
        audio_clip.time_remap = source_clip.time_remap.clone();
        audio_clip.link_group_id = Some(EXPLICIT_UNLINK_SENTINEL.to_string());
        let audio_clip_id = audio_clip.id.clone();

        // Determine target audio track
        let target_track_id = if let Some(ref given_id) = self.target_audio_track_id {
            // Validate the given track is audio
            let target = sequence
                .tracks
                .iter()
                .find(|t| &t.id == given_id)
                .ok_or_else(|| CoreError::TrackNotFound(given_id.clone()))?;
            if !target.is_audio() {
                return Err(CoreError::ValidationError(
                    "Target track must be an audio track".to_string(),
                ));
            }
            validate_track_unlocked(target)?;
            given_id.clone()
        } else {
            // Find the first unlocked audio track that can accept the clip,
            // or create one if every existing lane would overlap.
            if let Some(audio_track) = sequence
                .tracks
                .iter()
                .find(|t| {
                    t.kind == TrackKind::Audio
                        && !t.locked
                        && validate_no_overlap(t, &audio_clip.place, None).is_ok()
                })
            {
                audio_track.id.clone()
            } else {
                // Create a new audio track
                let new_track = Track::new_audio("Audio (Detached)");
                let new_track_id = new_track.id.clone();
                sequence.tracks.push(new_track);
                self.created_audio_track_id = Some(new_track_id.clone());
                new_track_id
            }
        };

        // Mark the source clip as explicitly unlinked so it stays detached from
        // any legacy implicit A/V pairing.
        let source_track_mut = sequence
            .tracks
            .iter_mut()
            .find(|t| t.id == self.track_id)
            .ok_or_else(|| CoreError::TrackNotFound(self.track_id.clone()))?;
        let source_clip_mut = source_track_mut
            .clips
            .iter_mut()
            .find(|c| c.id == self.clip_id)
            .ok_or_else(|| CoreError::ClipNotFound(self.clip_id.clone()))?;
        source_clip_mut.link_group_id = Some(EXPLICIT_UNLINK_SENTINEL.to_string());

        // Validate no overlap on target track before inserting
        let target_track = sequence
            .tracks
            .iter_mut()
            .find(|t| t.id == target_track_id)
            .ok_or_else(|| CoreError::TrackNotFound(target_track_id.clone()))?;
        validate_no_overlap(target_track, &audio_clip.place, None)?;
        target_track.clips.push(audio_clip);
        sort_track_clips(target_track);

        self.created_audio_clip_id = Some(audio_clip_id.clone());
        let normalized_refs = normalize_degenerate_link_groups(sequence, &affected_refs)?;

        let op_id = ulid::Ulid::new().to_string();
        let mut result = CommandResult::new(&op_id)
            .with_change(StateChange::ClipCreated {
                clip_id: audio_clip_id.clone(),
            })
            .with_created_id(&audio_clip_id);
        append_clip_modified_changes(&mut result, &[(self.track_id.clone(), self.clip_id.clone())]);
        append_clip_modified_changes(&mut result, &normalized_refs);
        Ok(result)
    }

    fn undo(&self, state: &mut ProjectState) -> CoreResult<()> {
        let Some(sequence) = state.sequences.get_mut(&self.sequence_id) else {
            return Ok(());
        };

        // Remove the created audio clip
        if let Some(ref audio_clip_id) = self.created_audio_clip_id {
            for track in &mut sequence.tracks {
                track.clips.retain(|c| &c.id != audio_clip_id);
            }
        }

        // Remove created audio track if we created one
        if let Some(ref created_track_id) = self.created_audio_track_id {
            sequence.tracks.retain(|t| &t.id != created_track_id);
        }

        for (track_id, clip_id, prev_link) in &self.previous_link_group_ids {
            if let Some(track) = sequence.tracks.iter_mut().find(|t| &t.id == track_id) {
                if let Some(clip) = track.clips.iter_mut().find(|c| &c.id == clip_id) {
                    clip.link_group_id = prev_link.clone();
                }
            }
        }

        Ok(())
    }

    fn type_name(&self) -> &'static str {
        "DetachAudio"
    }

    fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "sequenceId": self.sequence_id,
            "trackId": self.track_id,
            "clipId": self.clip_id,
            "targetAudioTrackId": self.target_audio_track_id,
        })
    }
}

// =============================================================================
// ApplyAudioDuckingCommand
// =============================================================================

/// Atomically sets pre-computed duck keyframes on a music clip.
///
/// The IPC layer performs the speech analysis (FFmpeg silencedetect) and
/// keyframe generation (via `ducking::generate_duck_keyframes`).  This
/// command only handles the state mutation so that undo/redo works as a
/// single operation.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyAudioDuckingCommand {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    pub clip_id: ClipId,
    /// Pre-computed ducking keyframes to apply
    pub keyframes: Vec<AudioKeyframe>,
    /// Stored for undo — previous volume keyframes on the clip
    #[serde(skip)]
    previous_keyframes: Option<Vec<AudioKeyframe>>,
}

impl ApplyAudioDuckingCommand {
    pub fn new(
        sequence_id: &str,
        track_id: &str,
        clip_id: &str,
        keyframes: Vec<AudioKeyframe>,
    ) -> Self {
        Self {
            sequence_id: sequence_id.to_string(),
            track_id: track_id.to_string(),
            clip_id: clip_id.to_string(),
            keyframes,
            previous_keyframes: None,
        }
    }
}

impl Command for ApplyAudioDuckingCommand {
    fn execute(&mut self, state: &mut ProjectState) -> CoreResult<CommandResult> {
        let sequence = state
            .sequences
            .get_mut(&self.sequence_id)
            .ok_or_else(|| CoreError::SequenceNotFound(self.sequence_id.clone()))?;
        let track = sequence
            .get_track_mut(&self.track_id)
            .ok_or_else(|| CoreError::TrackNotFound(self.track_id.clone()))?;

        if track.locked {
            return Err(CoreError::InvalidCommand(
                "Cannot apply ducking to a locked track".to_string(),
            ));
        }

        let clip = track
            .get_clip_mut(&self.clip_id)
            .ok_or_else(|| CoreError::ClipNotFound(self.clip_id.clone()))?;

        // Store previous keyframes for undo
        self.previous_keyframes = Some(clip.audio.volume_keyframes.clone());

        // Apply the pre-computed duck keyframes
        clip.audio.volume_keyframes = self.keyframes.clone();

        let op_id = ulid::Ulid::new().to_string();
        Ok(
            CommandResult::new(&op_id).with_change(StateChange::ClipModified {
                clip_id: self.clip_id.clone(),
            }),
        )
    }

    fn undo(&self, state: &mut ProjectState) -> CoreResult<()> {
        let Some(previous) = &self.previous_keyframes else {
            return Ok(());
        };

        let Some(sequence) = state.sequences.get_mut(&self.sequence_id) else {
            return Ok(());
        };
        let Some(track) = sequence.get_track_mut(&self.track_id) else {
            return Ok(());
        };
        if let Some(clip) = track.get_clip_mut(&self.clip_id) {
            clip.audio.volume_keyframes = previous.clone();
        }

        Ok(())
    }

    fn type_name(&self) -> &'static str {
        "ApplyAudioDucking"
    }

    fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "sequenceId": self.sequence_id,
            "trackId": self.track_id,
            "clipId": self.clip_id,
            "keyframeCount": self.keyframes.len(),
        })
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
        timeline::{
            BlendMode, KeyframeInterpolation, Sequence, SequenceFormat, TimeRemapCurve,
            TimeRemapKeyframe, Track, TrackKind,
        },
        Color, Point2D,
    };

    fn create_test_state() -> ProjectState {
        let mut state = ProjectState::new("Test Project");

        // Add asset
        let asset =
            Asset::new_video("video.mp4", "/video.mp4", VideoInfo::default()).with_duration(60.0);
        state.assets.insert(asset.id.clone(), asset.clone());

        // Add sequence with track
        let mut sequence = Sequence::new("Main", SequenceFormat::youtube_1080());
        let track = Track::new("Video 1", TrackKind::Video);
        sequence.tracks.push(track);
        state.active_sequence_id = Some(sequence.id.clone());
        state.sequences.insert(sequence.id.clone(), sequence);

        state
    }

    fn linear_time_remap_curve(points: &[(f64, f64)]) -> TimeRemapCurve {
        TimeRemapCurve::new(
            points
                .iter()
                .map(|(timeline_time, source_time)| TimeRemapKeyframe {
                    timeline_time: *timeline_time,
                    source_time: *source_time,
                    interpolation: KeyframeInterpolation::Linear,
                })
                .collect(),
        )
    }

    #[test]
    fn test_insert_clip_command() {
        let mut state = create_test_state();
        let seq_id = state.active_sequence_id.clone().unwrap();
        let track_id = state.sequences[&seq_id].tracks[0].id.clone();
        let asset_id = state.assets.keys().next().unwrap().clone();

        let mut cmd = InsertClipCommand::new(&seq_id, &track_id, &asset_id, 0.0);
        let result = cmd.execute(&mut state).unwrap();

        assert_eq!(result.created_ids.len(), 1);

        let track = &state.sequences[&seq_id].tracks[0];
        assert_eq!(track.clips.len(), 1);
        assert_eq!(track.clips[0].asset_id, asset_id);
    }

    #[test]
    fn test_insert_clip_validates_asset() {
        let mut state = create_test_state();
        let seq_id = state.active_sequence_id.clone().unwrap();
        let track_id = state.sequences[&seq_id].tracks[0].id.clone();

        let mut cmd = InsertClipCommand::new(&seq_id, &track_id, "nonexistent_asset", 0.0);
        let result = cmd.execute(&mut state);

        assert!(matches!(result, Err(CoreError::AssetNotFound(_))));
    }

    #[test]
    fn test_insert_clip_with_source_range() {
        let mut state = create_test_state();
        let seq_id = state.active_sequence_id.clone().unwrap();
        let track_id = state.sequences[&seq_id].tracks[0].id.clone();
        let asset_id = state.assets.keys().next().unwrap().clone();

        let mut cmd = InsertClipCommand::new(&seq_id, &track_id, &asset_id, 5.0)
            .with_source_range(10.0, 20.0);

        cmd.execute(&mut state).unwrap();

        let clip = &state.sequences[&seq_id].tracks[0].clips[0];
        assert_eq!(clip.range.source_in_sec, 10.0);
        assert_eq!(clip.range.source_out_sec, 20.0);
        assert_eq!(clip.place.timeline_in_sec, 5.0);
    }

    #[test]
    fn test_move_clip_command() {
        let mut state = create_test_state();
        let seq_id = state.active_sequence_id.clone().unwrap();
        let track_id = state.sequences[&seq_id].tracks[0].id.clone();
        let asset_id = state.assets.keys().next().unwrap().clone();

        // First insert a clip
        let mut insert_cmd = InsertClipCommand::new(&seq_id, &track_id, &asset_id, 0.0);
        insert_cmd.execute(&mut state).unwrap();

        let clip_id = state.sequences[&seq_id].tracks[0].clips[0].id.clone();

        // Move the clip
        let mut move_cmd = MoveClipCommand::new_simple(&seq_id, &clip_id, 10.0);
        move_cmd.execute(&mut state).unwrap();

        let clip = &state.sequences[&seq_id].tracks[0].clips[0];
        assert_eq!(clip.place.timeline_in_sec, 10.0);
    }

    #[test]
    fn test_split_clip_command() {
        let mut state = create_test_state();
        let seq_id = state.active_sequence_id.clone().unwrap();
        let track_id = state.sequences[&seq_id].tracks[0].id.clone();
        let asset_id = state.assets.keys().next().unwrap().clone();

        // Insert a 10-second clip
        let mut insert_cmd =
            InsertClipCommand::new(&seq_id, &track_id, &asset_id, 0.0).with_source_range(0.0, 10.0);
        insert_cmd.execute(&mut state).unwrap();

        let clip_id = state.sequences[&seq_id].tracks[0].clips[0].id.clone();

        // Split at 5 seconds
        let mut split_cmd = SplitClipCommand::new(&seq_id, &track_id, &clip_id, 5.0);
        let result = split_cmd.execute(&mut state).unwrap();

        // Should have created a new clip
        assert_eq!(result.created_ids.len(), 1);

        let track = &state.sequences[&seq_id].tracks[0];
        assert_eq!(track.clips.len(), 2);

        // First clip: 0-5 sec
        let first = &track.clips[0];
        assert_eq!(first.range.source_in_sec, 0.0);
        assert_eq!(first.range.source_out_sec, 5.0);

        // Second clip: 5-10 sec
        let second = &track.clips[1];
        assert_eq!(second.range.source_in_sec, 5.0);
        assert_eq!(second.range.source_out_sec, 10.0);
        assert_eq!(second.place.timeline_in_sec, 5.0);
    }

    #[test]
    fn test_split_clip_command_preserves_reverse_ranges() {
        let mut state = create_test_state();
        let seq_id = state.active_sequence_id.clone().unwrap();
        let track_id = state.sequences[&seq_id].tracks[0].id.clone();
        let asset_id = state.assets.keys().next().unwrap().clone();

        let mut insert_cmd =
            InsertClipCommand::new(&seq_id, &track_id, &asset_id, 0.0).with_source_range(0.0, 10.0);
        insert_cmd.execute(&mut state).unwrap();

        let clip = &mut state.sequences.get_mut(&seq_id).unwrap().tracks[0].clips[0];
        clip.reverse = true;
        let clip_id = clip.id.clone();

        let mut split_cmd = SplitClipCommand::new(&seq_id, &track_id, &clip_id, 4.0);
        split_cmd.execute(&mut state).unwrap();

        let track = &state.sequences[&seq_id].tracks[0];
        let first = track.clips.iter().find(|clip| clip.id == clip_id).unwrap();
        let second = track.clips.iter().find(|clip| clip.id != clip_id).unwrap();

        assert!(first.reverse);
        assert!(second.reverse);
        assert_eq!(first.range.source_in_sec, 6.0);
        assert_eq!(first.range.source_out_sec, 10.0);
        assert_eq!(second.range.source_in_sec, 0.0);
        assert_eq!(second.range.source_out_sec, 6.0);
        assert_eq!(second.place.timeline_in_sec, 4.0);
        assert_eq!(second.place.duration_sec, 6.0);
    }

    #[test]
    fn test_split_clip_command_rebases_time_remap_fragments() {
        let mut state = create_test_state();
        let seq_id = state.active_sequence_id.clone().unwrap();
        let track_id = state.sequences[&seq_id].tracks[0].id.clone();
        let asset_id = state.assets.keys().next().unwrap().clone();

        let mut insert_cmd =
            InsertClipCommand::new(&seq_id, &track_id, &asset_id, 0.0).with_source_range(0.0, 4.0);
        insert_cmd.execute(&mut state).unwrap();

        {
            let clip = &mut state.sequences.get_mut(&seq_id).unwrap().tracks[0].clips[0];
            clip.time_remap = Some(linear_time_remap_curve(&[(0.0, 0.0), (2.0, 4.0)]));
            clip.place.duration_sec = 2.0;
        }

        let clip_id = state.sequences[&seq_id].tracks[0].clips[0].id.clone();
        let mut split_cmd = SplitClipCommand::new(&seq_id, &track_id, &clip_id, 1.0);
        split_cmd.execute(&mut state).unwrap();

        let track = &state.sequences[&seq_id].tracks[0];
        let left = track.clips.iter().find(|clip| clip.id == clip_id).unwrap();
        let right = track.clips.iter().find(|clip| clip.id != clip_id).unwrap();

        let left_remap = left.time_remap.as_ref().unwrap();
        let right_remap = right.time_remap.as_ref().unwrap();
        assert!((left.duration() - 1.0).abs() < 1e-6);
        assert!((right.duration() - 1.0).abs() < 1e-6);
        assert!((left_remap.evaluate(0.0) - 0.0).abs() < 1e-6);
        assert!((left_remap.evaluate(1.0) - 2.0).abs() < 1e-6);
        assert!((right_remap.evaluate(0.0) - 2.0).abs() < 1e-6);
        assert!((right_remap.evaluate(1.0) - 4.0).abs() < 1e-6);
    }

    #[test]
    fn test_split_clip_invalid_point() {
        let mut state = create_test_state();
        let seq_id = state.active_sequence_id.clone().unwrap();
        let track_id = state.sequences[&seq_id].tracks[0].id.clone();
        let asset_id = state.assets.keys().next().unwrap().clone();

        // Insert a clip at position 5-15 (10 sec duration)
        let mut insert_cmd =
            InsertClipCommand::new(&seq_id, &track_id, &asset_id, 5.0).with_source_range(0.0, 10.0);
        insert_cmd.execute(&mut state).unwrap();

        let clip_id = state.sequences[&seq_id].tracks[0].clips[0].id.clone();

        // Try to split before clip start
        let mut split_cmd = SplitClipCommand::new(&seq_id, &track_id, &clip_id, 3.0);
        assert!(matches!(
            split_cmd.execute(&mut state),
            Err(CoreError::InvalidSplitPoint(_))
        ));

        // Try to split after clip end
        let mut split_cmd = SplitClipCommand::new(&seq_id, &track_id, &clip_id, 20.0);
        assert!(matches!(
            split_cmd.execute(&mut state),
            Err(CoreError::InvalidSplitPoint(_))
        ));
    }

    #[test]
    fn test_trim_clip_command() {
        let mut state = create_test_state();
        let seq_id = state.active_sequence_id.clone().unwrap();
        let track_id = state.sequences[&seq_id].tracks[0].id.clone();
        let asset_id = state.assets.keys().next().unwrap().clone();

        // Insert clip
        let mut insert_cmd =
            InsertClipCommand::new(&seq_id, &track_id, &asset_id, 0.0).with_source_range(0.0, 10.0);
        insert_cmd.execute(&mut state).unwrap();

        let clip_id = state.sequences[&seq_id].tracks[0].clips[0].id.clone();

        // Trim clip
        let mut trim_cmd = TrimClipCommand::new_simple(&seq_id, &clip_id)
            .with_source_in(2.0)
            .with_source_out(8.0);
        trim_cmd.execute(&mut state).unwrap();

        let clip = &state.sequences[&seq_id].tracks[0].clips[0];
        assert_eq!(clip.range.source_in_sec, 2.0);
        assert_eq!(clip.range.source_out_sec, 8.0);
    }

    #[test]
    fn test_remove_clip_command() {
        let mut state = create_test_state();
        let seq_id = state.active_sequence_id.clone().unwrap();
        let track_id = state.sequences[&seq_id].tracks[0].id.clone();
        let asset_id = state.assets.keys().next().unwrap().clone();

        // Insert clip
        let mut insert_cmd = InsertClipCommand::new(&seq_id, &track_id, &asset_id, 0.0);
        insert_cmd.execute(&mut state).unwrap();

        let clip_id = state.sequences[&seq_id].tracks[0].clips[0].id.clone();
        assert_eq!(state.sequences[&seq_id].tracks[0].clips.len(), 1);

        // Remove clip
        let mut remove_cmd = RemoveClipCommand::new(&seq_id, &track_id, &clip_id);
        let result = remove_cmd.execute(&mut state).unwrap();

        assert_eq!(result.deleted_ids.len(), 1);
        assert_eq!(state.sequences[&seq_id].tracks[0].clips.len(), 0);
    }

    #[test]
    fn test_command_serialization() {
        let cmd = InsertClipCommand::new("seq_001", "track_001", "asset_001", 5.0)
            .with_source_range(10.0, 20.0);

        let json = cmd.to_json();
        assert_eq!(json["sequenceId"], "seq_001");
        assert_eq!(json["trackId"], "track_001");
        assert_eq!(json["assetId"], "asset_001");
        assert_eq!(json["timelineStart"], 5.0);
    }

    // =============================================================================
    // Undo Tests
    // =============================================================================

    #[test]
    fn test_insert_clip_undo() {
        let mut state = create_test_state();
        let seq_id = state.active_sequence_id.clone().unwrap();
        let track_id = state.sequences[&seq_id].tracks[0].id.clone();
        let asset_id = state.assets.keys().next().unwrap().clone();

        let mut cmd = InsertClipCommand::new(&seq_id, &track_id, &asset_id, 0.0);
        cmd.execute(&mut state).unwrap();

        assert_eq!(state.sequences[&seq_id].tracks[0].clips.len(), 1);

        // Undo should remove the clip
        cmd.undo(&mut state).unwrap();

        assert_eq!(state.sequences[&seq_id].tracks[0].clips.len(), 0);
    }

    #[test]
    fn test_remove_clip_undo() {
        let mut state = create_test_state();
        let seq_id = state.active_sequence_id.clone().unwrap();
        let track_id = state.sequences[&seq_id].tracks[0].id.clone();
        let asset_id = state.assets.keys().next().unwrap().clone();

        // Insert clip
        let mut insert_cmd = InsertClipCommand::new(&seq_id, &track_id, &asset_id, 5.0)
            .with_source_range(10.0, 20.0);
        insert_cmd.execute(&mut state).unwrap();

        let clip_id = state.sequences[&seq_id].tracks[0].clips[0].id.clone();

        // Remove clip
        let mut remove_cmd = RemoveClipCommand::new(&seq_id, &track_id, &clip_id);
        remove_cmd.execute(&mut state).unwrap();

        assert_eq!(state.sequences[&seq_id].tracks[0].clips.len(), 0);

        // Undo should restore the clip
        remove_cmd.undo(&mut state).unwrap();

        assert_eq!(state.sequences[&seq_id].tracks[0].clips.len(), 1);
        let restored_clip = &state.sequences[&seq_id].tracks[0].clips[0];
        assert_eq!(restored_clip.id, clip_id);
        assert_eq!(restored_clip.place.timeline_in_sec, 5.0);
        assert_eq!(restored_clip.range.source_in_sec, 10.0);
        assert_eq!(restored_clip.range.source_out_sec, 20.0);
    }

    #[test]
    fn test_move_clip_undo() {
        let mut state = create_test_state();
        let seq_id = state.active_sequence_id.clone().unwrap();
        let track_id = state.sequences[&seq_id].tracks[0].id.clone();
        let asset_id = state.assets.keys().next().unwrap().clone();

        // Insert clip at position 5.0
        let mut insert_cmd = InsertClipCommand::new(&seq_id, &track_id, &asset_id, 5.0);
        insert_cmd.execute(&mut state).unwrap();

        let clip_id = state.sequences[&seq_id].tracks[0].clips[0].id.clone();

        // Move clip to position 15.0
        let mut move_cmd = MoveClipCommand::new_simple(&seq_id, &clip_id, 15.0);
        move_cmd.execute(&mut state).unwrap();

        assert_eq!(
            state.sequences[&seq_id].tracks[0].clips[0]
                .place
                .timeline_in_sec,
            15.0
        );

        // Undo should restore position to 5.0
        move_cmd.undo(&mut state).unwrap();

        assert_eq!(
            state.sequences[&seq_id].tracks[0].clips[0]
                .place
                .timeline_in_sec,
            5.0
        );
    }

    #[test]
    fn test_trim_clip_undo() {
        let mut state = create_test_state();
        let seq_id = state.active_sequence_id.clone().unwrap();
        let track_id = state.sequences[&seq_id].tracks[0].id.clone();
        let asset_id = state.assets.keys().next().unwrap().clone();

        // Insert clip with source range 0-10
        let mut insert_cmd =
            InsertClipCommand::new(&seq_id, &track_id, &asset_id, 0.0).with_source_range(0.0, 10.0);
        insert_cmd.execute(&mut state).unwrap();

        let clip_id = state.sequences[&seq_id].tracks[0].clips[0].id.clone();

        // Trim clip to 2-8
        let mut trim_cmd = TrimClipCommand::new_simple(&seq_id, &clip_id)
            .with_source_in(2.0)
            .with_source_out(8.0);
        trim_cmd.execute(&mut state).unwrap();

        let clip = &state.sequences[&seq_id].tracks[0].clips[0];
        assert_eq!(clip.range.source_in_sec, 2.0);
        assert_eq!(clip.range.source_out_sec, 8.0);

        // Undo should restore to 0-10
        trim_cmd.undo(&mut state).unwrap();

        let clip = &state.sequences[&seq_id].tracks[0].clips[0];
        assert_eq!(clip.range.source_in_sec, 0.0);
        assert_eq!(clip.range.source_out_sec, 10.0);
    }

    #[test]
    fn test_split_clip_undo() {
        let mut state = create_test_state();
        let seq_id = state.active_sequence_id.clone().unwrap();
        let track_id = state.sequences[&seq_id].tracks[0].id.clone();
        let asset_id = state.assets.keys().next().unwrap().clone();

        // Insert a 10-second clip
        let mut insert_cmd =
            InsertClipCommand::new(&seq_id, &track_id, &asset_id, 0.0).with_source_range(0.0, 10.0);
        insert_cmd.execute(&mut state).unwrap();

        let clip_id = state.sequences[&seq_id].tracks[0].clips[0].id.clone();

        // Split at 5 seconds
        let mut split_cmd = SplitClipCommand::new(&seq_id, &track_id, &clip_id, 5.0);
        split_cmd.execute(&mut state).unwrap();

        assert_eq!(state.sequences[&seq_id].tracks[0].clips.len(), 2);

        // Undo should restore single clip with original range
        split_cmd.undo(&mut state).unwrap();

        assert_eq!(state.sequences[&seq_id].tracks[0].clips.len(), 1);
        let clip = &state.sequences[&seq_id].tracks[0].clips[0];
        assert_eq!(clip.range.source_in_sec, 0.0);
        assert_eq!(clip.range.source_out_sec, 10.0);
    }

    #[test]
    fn test_split_clip_with_speed_undo() {
        let mut state = create_test_state();
        let seq_id = state.active_sequence_id.clone().unwrap();
        let track_id = state.sequences[&seq_id].tracks[0].id.clone();
        let asset_id = state.assets.keys().next().unwrap().clone();

        // Insert a clip with speed 2.0x (plays twice as fast)
        let mut insert_cmd =
            InsertClipCommand::new(&seq_id, &track_id, &asset_id, 0.0).with_source_range(0.0, 20.0); // 20 sec of source
        insert_cmd.execute(&mut state).unwrap();

        let clip_id = state.sequences[&seq_id].tracks[0].clips[0].id.clone();

        // Set speed to 2.0
        state.sequences.get_mut(&seq_id).unwrap().tracks[0].clips[0].speed = 2.0;

        // Timeline duration should be 10 sec (20 source sec / 2.0 speed)
        let clip = &state.sequences[&seq_id].tracks[0].clips[0];
        assert_eq!(clip.duration(), 10.0);

        // Split at 5 sec (timeline time)
        let mut split_cmd = SplitClipCommand::new(&seq_id, &track_id, &clip_id, 5.0);
        split_cmd.execute(&mut state).unwrap();

        let track = &state.sequences[&seq_id].tracks[0];
        assert_eq!(track.clips.len(), 2);

        // First clip: source 0-10 (because 5 timeline sec * 2.0 speed = 10 source sec)
        assert_eq!(track.clips[0].range.source_in_sec, 0.0);
        assert_eq!(track.clips[0].range.source_out_sec, 10.0);

        // Second clip: source 10-20
        assert_eq!(track.clips[1].range.source_in_sec, 10.0);
        assert_eq!(track.clips[1].range.source_out_sec, 20.0);
        assert_eq!(track.clips[1].speed, 2.0); // Speed should be copied

        // Undo
        split_cmd.undo(&mut state).unwrap();

        assert_eq!(state.sequences[&seq_id].tracks[0].clips.len(), 1);
        let clip = &state.sequences[&seq_id].tracks[0].clips[0];
        assert_eq!(clip.range.source_in_sec, 0.0);
        assert_eq!(clip.range.source_out_sec, 20.0);
        assert_eq!(clip.speed, 2.0);
    }

    #[test]
    fn test_move_clip_cross_track() {
        let mut state = create_test_state();
        let seq_id = state.active_sequence_id.clone().unwrap();
        let track1_id = state.sequences[&seq_id].tracks[0].id.clone();
        let asset_id = state.assets.keys().next().unwrap().clone();

        // Add second track
        let track2 = Track::new("Video 2", TrackKind::Video);
        let track2_id = track2.id.clone();
        state
            .sequences
            .get_mut(&seq_id)
            .unwrap()
            .tracks
            .push(track2);

        // Insert clip in track 1
        let mut insert_cmd = InsertClipCommand::new(&seq_id, &track1_id, &asset_id, 0.0);
        insert_cmd.execute(&mut state).unwrap();

        let clip_id = state.sequences[&seq_id].tracks[0].clips[0].id.clone();

        // Move clip to track 2 at position 10.0
        let mut move_cmd =
            MoveClipCommand::new_simple(&seq_id, &clip_id, 10.0).to_track(&track2_id);
        move_cmd.execute(&mut state).unwrap();

        // Verify clip moved to track 2
        assert_eq!(state.sequences[&seq_id].tracks[0].clips.len(), 0);
        assert_eq!(state.sequences[&seq_id].tracks[1].clips.len(), 1);
        assert_eq!(
            state.sequences[&seq_id].tracks[1].clips[0]
                .place
                .timeline_in_sec,
            10.0
        );

        // Undo should move back to track 1
        move_cmd.undo(&mut state).unwrap();

        assert_eq!(state.sequences[&seq_id].tracks[0].clips.len(), 1);
        assert_eq!(state.sequences[&seq_id].tracks[1].clips.len(), 0);
        assert_eq!(
            state.sequences[&seq_id].tracks[0].clips[0]
                .place
                .timeline_in_sec,
            0.0
        );
    }

    #[test]
    fn test_remove_clip_preserves_position_on_undo() {
        let mut state = create_test_state();
        let seq_id = state.active_sequence_id.clone().unwrap();
        let track_id = state.sequences[&seq_id].tracks[0].id.clone();
        let asset_id = state.assets.keys().next().unwrap().clone();

        // Insert 3 clips
        for i in 0..3 {
            // Use short, non-overlapping durations to satisfy the timeline invariant
            // that clips on the same track cannot overlap.
            let mut cmd = InsertClipCommand::new(&seq_id, &track_id, &asset_id, (i * 10) as f64)
                .with_source_range(0.0, 5.0);
            cmd.execute(&mut state).unwrap();
        }

        let track = &state.sequences[&seq_id].tracks[0];
        assert_eq!(track.clips.len(), 3);

        // Get the middle clip ID
        let middle_clip_id = track.clips[1].id.clone();

        // Remove middle clip
        let mut remove_cmd = RemoveClipCommand::new(&seq_id, &track_id, &middle_clip_id);
        remove_cmd.execute(&mut state).unwrap();

        assert_eq!(state.sequences[&seq_id].tracks[0].clips.len(), 2);

        // Undo should restore clip at position 1 (middle)
        remove_cmd.undo(&mut state).unwrap();

        let track = &state.sequences[&seq_id].tracks[0];
        assert_eq!(track.clips.len(), 3);
        assert_eq!(track.clips[1].id, middle_clip_id);
    }

    #[test]
    fn test_set_clip_transform_command_updates_and_undoes() {
        let mut state = create_test_state();
        let seq_id = state.active_sequence_id.clone().unwrap();
        let track_id = state.sequences[&seq_id].tracks[0].id.clone();
        let asset_id = state.assets.keys().next().unwrap().clone();

        // Insert a clip.
        let mut insert_cmd = InsertClipCommand::new(&seq_id, &track_id, &asset_id, 0.0);
        insert_cmd.execute(&mut state).unwrap();

        let clip_id = state.sequences[&seq_id].tracks[0].clips[0].id.clone();
        let original = state.sequences[&seq_id].tracks[0].clips[0]
            .transform
            .clone();

        let mut cmd = SetClipTransformCommand::new(
            &seq_id,
            &track_id,
            &clip_id,
            Transform {
                position: Point2D::new(0.25, 0.75),
                scale: Point2D::new(1.5, 0.5),
                rotation_deg: 15.0,
                anchor: Point2D::center(),
            },
        );

        cmd.execute(&mut state).unwrap();

        let updated = &state.sequences[&seq_id].tracks[0].clips[0].transform;
        assert_eq!(updated.position.x, 0.25);
        assert_eq!(updated.position.y, 0.75);
        assert_eq!(updated.scale.x, 1.5);
        assert_eq!(updated.scale.y, 0.5);
        assert_eq!(updated.rotation_deg, 15.0);

        cmd.undo(&mut state).unwrap();
        let restored = &state.sequences[&seq_id].tracks[0].clips[0].transform;
        assert_eq!(restored, &original);
    }

    #[test]
    fn test_set_clip_speed_command_updates_duration_and_undoes() {
        let mut state = create_test_state();
        let seq_id = state.active_sequence_id.clone().unwrap();
        let track_id = state.sequences[&seq_id].tracks[0].id.clone();
        let asset_id = state.assets.keys().next().unwrap().clone();

        let mut insert_cmd =
            InsertClipCommand::new(&seq_id, &track_id, &asset_id, 0.0).with_source_range(0.0, 10.0);
        insert_cmd.execute(&mut state).unwrap();

        let clip_id = state.sequences[&seq_id].tracks[0].clips[0].id.clone();
        let original_speed = state.sequences[&seq_id].tracks[0].clips[0].speed;
        let original_reverse = state.sequences[&seq_id].tracks[0].clips[0].reverse;
        let original_duration = state.sequences[&seq_id].tracks[0].clips[0]
            .place
            .duration_sec;

        let mut speed_cmd = SetClipSpeedCommand::new(&seq_id, &track_id, &clip_id, 2.0, false);
        speed_cmd.execute(&mut state).unwrap();

        let updated = &state.sequences[&seq_id].tracks[0].clips[0];
        assert_eq!(updated.speed, 2.0);
        assert!(!updated.reverse);
        assert_eq!(updated.place.duration_sec, 5.0);

        speed_cmd.undo(&mut state).unwrap();

        let restored = &state.sequences[&seq_id].tracks[0].clips[0];
        assert_eq!(restored.speed, original_speed);
        assert_eq!(restored.reverse, original_reverse);
        assert_eq!(restored.place.duration_sec, original_duration);
    }

    #[test]
    fn test_set_clip_speed_with_reverse_sets_both() {
        let mut state = create_test_state();
        let seq_id = state.active_sequence_id.clone().unwrap();
        let track_id = state.sequences[&seq_id].tracks[0].id.clone();
        let asset_id = state.assets.keys().next().unwrap().clone();

        let mut insert_cmd =
            InsertClipCommand::new(&seq_id, &track_id, &asset_id, 0.0).with_source_range(0.0, 10.0);
        insert_cmd.execute(&mut state).unwrap();

        let clip_id = state.sequences[&seq_id].tracks[0].clips[0].id.clone();

        // Given a clip with normal speed and not reversed
        assert!(!state.sequences[&seq_id].tracks[0].clips[0].reverse);

        // When setting speed with reverse=true
        let mut speed_cmd = SetClipSpeedCommand::new(&seq_id, &track_id, &clip_id, 2.0, true);
        speed_cmd.execute(&mut state).unwrap();

        // Then both speed and reverse are set
        let updated = &state.sequences[&seq_id].tracks[0].clips[0];
        assert_eq!(updated.speed, 2.0);
        assert!(updated.reverse);
        assert_eq!(updated.place.duration_sec, 5.0);

        // And undo restores both
        speed_cmd.undo(&mut state).unwrap();
        let restored = &state.sequences[&seq_id].tracks[0].clips[0];
        assert!(!restored.reverse);
        assert_eq!(restored.speed, 1.0);
    }

    #[test]
    fn test_set_clip_speed_rejects_non_positive_speed() {
        let mut state = create_test_state();
        let seq_id = state.active_sequence_id.clone().unwrap();
        let track_id = state.sequences[&seq_id].tracks[0].id.clone();
        let asset_id = state.assets.keys().next().unwrap().clone();

        let mut insert_cmd = InsertClipCommand::new(&seq_id, &track_id, &asset_id, 0.0);
        insert_cmd.execute(&mut state).unwrap();

        let clip_id = state.sequences[&seq_id].tracks[0].clips[0].id.clone();
        let mut speed_cmd = SetClipSpeedCommand::new(&seq_id, &track_id, &clip_id, 0.0, false);

        let err = speed_cmd.execute(&mut state).unwrap_err();
        assert!(matches!(err, CoreError::InvalidCommand(_)));
    }

    #[test]
    fn test_set_clip_speed_validates_track_membership() {
        let mut state = create_test_state();
        let seq_id = state.active_sequence_id.clone().unwrap();
        let track_id = state.sequences[&seq_id].tracks[0].id.clone();
        let asset_id = state.assets.keys().next().unwrap().clone();

        let mut insert_cmd = InsertClipCommand::new(&seq_id, &track_id, &asset_id, 0.0);
        insert_cmd.execute(&mut state).unwrap();

        let clip_id = state.sequences[&seq_id].tracks[0].clips[0].id.clone();
        let mut speed_cmd = SetClipSpeedCommand::new(&seq_id, "wrong-track", &clip_id, 2.0, false);

        let err = speed_cmd.execute(&mut state).unwrap_err();
        assert!(matches!(err, CoreError::TrackNotFound(_)));
    }

    #[test]
    fn test_set_clip_speed_rejects_locked_track() {
        let mut state = create_test_state();
        let seq_id = state.active_sequence_id.clone().unwrap();
        let track_id = state.sequences[&seq_id].tracks[0].id.clone();
        let asset_id = state.assets.keys().next().unwrap().clone();

        let mut insert_cmd =
            InsertClipCommand::new(&seq_id, &track_id, &asset_id, 0.0).with_source_range(0.0, 10.0);
        insert_cmd.execute(&mut state).unwrap();

        let clip_id = state.sequences[&seq_id].tracks[0].clips[0].id.clone();
        state.sequences.get_mut(&seq_id).unwrap().tracks[0].locked = true;

        let mut speed_cmd = SetClipSpeedCommand::new(&seq_id, &track_id, &clip_id, 2.0, false);
        let err = speed_cmd.execute(&mut state).unwrap_err();
        assert!(matches!(err, CoreError::ValidationError(_)));
        assert!(err.to_string().contains("locked"));
    }

    #[test]
    fn test_set_clip_mute_command_updates_and_undoes() {
        let mut state = create_test_state();
        let seq_id = state.active_sequence_id.clone().unwrap();
        let track_id = state.sequences[&seq_id].tracks[0].id.clone();
        let asset_id = state.assets.keys().next().unwrap().clone();

        let mut insert_cmd = InsertClipCommand::new(&seq_id, &track_id, &asset_id, 0.0);
        insert_cmd.execute(&mut state).unwrap();

        let clip_id = state.sequences[&seq_id].tracks[0].clips[0].id.clone();
        assert!(!state.sequences[&seq_id].tracks[0].clips[0].audio.muted);

        let mut mute_cmd = SetClipMuteCommand::new(&seq_id, &track_id, &clip_id, true);
        mute_cmd.execute(&mut state).unwrap();

        assert!(state.sequences[&seq_id].tracks[0].clips[0].audio.muted);

        mute_cmd.undo(&mut state).unwrap();

        assert!(!state.sequences[&seq_id].tracks[0].clips[0].audio.muted);
    }

    #[test]
    fn test_set_clip_audio_command_updates_and_undoes() {
        let mut state = create_test_state();
        let seq_id = state.active_sequence_id.clone().unwrap();
        let track_id = state.sequences[&seq_id].tracks[0].id.clone();
        let asset_id = state.assets.keys().next().unwrap().clone();

        let mut insert_cmd =
            InsertClipCommand::new(&seq_id, &track_id, &asset_id, 0.0).with_source_range(0.0, 10.0);
        insert_cmd.execute(&mut state).unwrap();

        let clip_id = state.sequences[&seq_id].tracks[0].clips[0].id.clone();

        let mut audio_cmd = SetClipAudioCommand::new(
            &seq_id,
            &track_id,
            &clip_id,
            Some(24.0),
            Some(2.0),
            Some(true),
            Some(8.0),
            Some(8.0),
        );
        audio_cmd.execute(&mut state).unwrap();

        let audio = &state.sequences[&seq_id].tracks[0].clips[0].audio;
        assert_eq!(audio.volume_db, MAX_CLIP_VOLUME_DB);
        assert_eq!(audio.pan, 1.0);
        assert!(audio.muted);
        assert_eq!(audio.fade_in_sec, 8.0);
        assert_eq!(audio.fade_out_sec, 2.0);

        audio_cmd.undo(&mut state).unwrap();

        let restored = &state.sequences[&seq_id].tracks[0].clips[0].audio;
        assert_eq!(restored.volume_db, 0.0);
        assert_eq!(restored.pan, 0.0);
        assert!(!restored.muted);
        assert_eq!(restored.fade_in_sec, 0.0);
        assert_eq!(restored.fade_out_sec, 0.0);
    }

    // =============================================================================
    // Multi-Clip Compound Edit Scenario Tests
    // =============================================================================
    //
    // These tests verify that sequences of primitive commands (TrimClip, MoveClip)
    // produce correct results on multi-clip timelines, simulating the compound
    // editing operations: ripple, roll, slip, and slide edits.

    /// Insert N contiguous 10-second clips on the first track.
    /// Returns (sequence_id, track_id, clip_ids).
    fn setup_multi_clip_timeline(
        state: &mut ProjectState,
        clip_count: usize,
    ) -> (SequenceId, TrackId, Vec<ClipId>) {
        let seq_id = state.active_sequence_id.clone().unwrap();
        let track_id = state.sequences[&seq_id].tracks[0].id.clone();
        let asset_id = state.assets.keys().next().unwrap().clone();

        let mut clip_ids = Vec::new();
        for i in 0..clip_count {
            let mut cmd = InsertClipCommand::new(&seq_id, &track_id, &asset_id, (i * 10) as f64)
                .with_source_range(0.0, 10.0);
            let result = cmd.execute(state).unwrap();
            clip_ids.push(result.created_ids[0].clone());
        }

        (seq_id, track_id, clip_ids)
    }

    // -- Ripple Edit Scenarios --

    #[test]
    fn test_ripple_edit_shorten_shifts_subsequent_clips() {
        // Given: 3 contiguous clips [A(0-10), B(10-20), C(20-30)]
        let mut state = create_test_state();
        let (seq_id, _track_id, clips) = setup_multi_clip_timeline(&mut state, 3);

        // When: Ripple-shorten B's out-point from 10 to 5 (delta = -5s)
        // Negative delta → trim first, then move subsequent clips left.
        let mut trim_cmd = TrimClipCommand::new_simple(&seq_id, &clips[1]).with_source_out(5.0);
        trim_cmd.execute(&mut state).unwrap();

        let mut move_cmd = MoveClipCommand::new_simple(&seq_id, &clips[2], 15.0);
        move_cmd.execute(&mut state).unwrap();

        // Then: A unchanged, B shortened, C shifted left
        let track = &state.sequences[&seq_id].tracks[0];
        assert_eq!(track.clips.len(), 3);

        assert_eq!(track.clips[0].place.timeline_in_sec, 0.0);
        assert_eq!(track.clips[0].place.duration_sec, 10.0);

        assert_eq!(track.clips[1].place.timeline_in_sec, 10.0);
        assert_eq!(track.clips[1].place.duration_sec, 5.0);
        assert_eq!(track.clips[1].range.source_out_sec, 5.0);

        assert_eq!(track.clips[2].place.timeline_in_sec, 15.0);
        assert_eq!(track.clips[2].place.duration_sec, 10.0);
    }

    #[test]
    fn test_ripple_edit_extend_shifts_subsequent_clips() {
        // Given: 3 contiguous clips [A(0-10), B(10-20), C(20-30)]
        let mut state = create_test_state();
        let (seq_id, _track_id, clips) = setup_multi_clip_timeline(&mut state, 3);

        // When: Ripple-extend B's out-point from 10 to 15 (delta = +5s)
        // Positive delta → move subsequent clips right first, then trim.
        let mut move_cmd = MoveClipCommand::new_simple(&seq_id, &clips[2], 25.0);
        move_cmd.execute(&mut state).unwrap();

        let mut trim_cmd = TrimClipCommand::new_simple(&seq_id, &clips[1]).with_source_out(15.0);
        trim_cmd.execute(&mut state).unwrap();

        // Then: A unchanged, B extended, C shifted right
        let track = &state.sequences[&seq_id].tracks[0];

        assert_eq!(track.clips[0].place.timeline_in_sec, 0.0);
        assert_eq!(track.clips[0].place.duration_sec, 10.0);

        assert_eq!(track.clips[1].place.timeline_in_sec, 10.0);
        assert_eq!(track.clips[1].place.duration_sec, 15.0);
        assert_eq!(track.clips[1].range.source_out_sec, 15.0);

        assert_eq!(track.clips[2].place.timeline_in_sec, 25.0);
        assert_eq!(track.clips[2].place.duration_sec, 10.0);
    }

    #[test]
    fn test_ripple_edit_undo_restores_original_positions() {
        // Given: 3 clips with ripple-shorten applied
        let mut state = create_test_state();
        let (seq_id, _track_id, clips) = setup_multi_clip_timeline(&mut state, 3);

        let mut trim_cmd = TrimClipCommand::new_simple(&seq_id, &clips[1]).with_source_out(5.0);
        trim_cmd.execute(&mut state).unwrap();

        let mut move_cmd = MoveClipCommand::new_simple(&seq_id, &clips[2], 15.0);
        move_cmd.execute(&mut state).unwrap();

        // When: Undo in reverse order
        move_cmd.undo(&mut state).unwrap();
        trim_cmd.undo(&mut state).unwrap();

        // Then: All clips restored to original positions
        let track = &state.sequences[&seq_id].tracks[0];
        for (i, clip) in track.clips.iter().enumerate() {
            assert_eq!(clip.place.timeline_in_sec, (i * 10) as f64);
            assert_eq!(clip.place.duration_sec, 10.0);
            assert_eq!(clip.range.source_in_sec, 0.0);
            assert_eq!(clip.range.source_out_sec, 10.0);
        }
    }

    #[test]
    fn test_ripple_edit_with_speed_factor() {
        // Given: 3 clips, middle clip at 2x speed (source 0-20, plays in 10s)
        let mut state = create_test_state();
        let (seq_id, _track_id, clips) = setup_multi_clip_timeline(&mut state, 3);

        // Reconfigure B: source 0-20 at speed 2.0 → duration 10s (fits timeline slot)
        {
            let seq = state.sequences.get_mut(&seq_id).unwrap();
            let clip_b = &mut seq.tracks[0].clips[1];
            clip_b.range.source_out_sec = 20.0;
            clip_b.speed = 2.0;
            clip_b.place.duration_sec = 10.0;
        }

        // When: Ripple-trim B's sourceOut from 20 to 10 → sourceDelta = -10
        // timelineDelta = -10 / 2.0 = -5s (speed factor applies)
        let mut trim_cmd = TrimClipCommand::new_simple(&seq_id, &clips[1]).with_source_out(10.0);
        trim_cmd.execute(&mut state).unwrap();

        let mut move_cmd = MoveClipCommand::new_simple(&seq_id, &clips[2], 15.0);
        move_cmd.execute(&mut state).unwrap();

        // Then: B duration = (10 - 0) / 2.0 = 5s at speed 2.0
        let track = &state.sequences[&seq_id].tracks[0];
        assert_eq!(track.clips[1].place.timeline_in_sec, 10.0);
        assert_eq!(track.clips[1].place.duration_sec, 5.0);
        assert_eq!(track.clips[1].range.source_out_sec, 10.0);
        assert_eq!(track.clips[1].speed, 2.0);

        // C moved left by 5s (the timeline delta)
        assert_eq!(track.clips[2].place.timeline_in_sec, 15.0);
    }

    #[test]
    fn test_ripple_edit_shifts_all_subsequent_clips() {
        // Given: 5 contiguous clips [A(0-10), B(10-20), C(20-30), D(30-40), E(40-50)]
        let mut state = create_test_state();
        let (seq_id, _track_id, clips) = setup_multi_clip_timeline(&mut state, 5);

        // When: Ripple-shorten B (delta = -5s) → move C, D, E left by 5s
        let mut trim_cmd = TrimClipCommand::new_simple(&seq_id, &clips[1]).with_source_out(5.0);
        trim_cmd.execute(&mut state).unwrap();

        // Move all subsequent clips (C, D, E) in forward order (negative delta)
        for (i, clip_id) in clips[2..].iter().enumerate() {
            let original_pos = ((i + 2) * 10) as f64;
            let mut move_cmd = MoveClipCommand::new_simple(&seq_id, clip_id, original_pos - 5.0);
            move_cmd.execute(&mut state).unwrap();
        }

        // Then: All subsequent clips shifted left by 5s
        let track = &state.sequences[&seq_id].tracks[0];
        assert_eq!(track.clips[0].place.timeline_in_sec, 0.0); // A unchanged
        assert_eq!(track.clips[1].place.timeline_in_sec, 10.0); // B unchanged pos
        assert_eq!(track.clips[1].place.duration_sec, 5.0); // B shortened
        assert_eq!(track.clips[2].place.timeline_in_sec, 15.0); // C: 20 - 5
        assert_eq!(track.clips[3].place.timeline_in_sec, 25.0); // D: 30 - 5
        assert_eq!(track.clips[4].place.timeline_in_sec, 35.0); // E: 40 - 5
    }

    // -- Roll Edit Scenarios --

    #[test]
    fn test_roll_edit_positive_extends_left_shrinks_right() {
        // Given: 2 adjacent clips with source headroom for extension
        let mut state = create_test_state();
        let seq_id = state.active_sequence_id.clone().unwrap();
        let track_id = state.sequences[&seq_id].tracks[0].id.clone();
        let asset_id = state.assets.keys().next().unwrap().clone();

        // A: source 5-15, timeline 0-10
        let mut cmd_a =
            InsertClipCommand::new(&seq_id, &track_id, &asset_id, 0.0).with_source_range(5.0, 15.0);
        let result_a = cmd_a.execute(&mut state).unwrap();
        let clip_a = result_a.created_ids[0].clone();

        // B: source 5-15, timeline 10-20
        let mut cmd_b = InsertClipCommand::new(&seq_id, &track_id, &asset_id, 10.0)
            .with_source_range(5.0, 15.0);
        let result_b = cmd_b.execute(&mut state).unwrap();
        let clip_b = result_b.created_ids[0].clone();

        // When: Roll +3s (extend A, shrink B)
        // Positive roll → trim right clip first to avoid overlap
        let mut trim_b = TrimClipCommand::new_simple(&seq_id, &clip_b)
            .with_source_in(8.0)
            .with_timeline_in(13.0);
        trim_b.execute(&mut state).unwrap();

        let mut trim_a = TrimClipCommand::new_simple(&seq_id, &clip_a).with_source_out(18.0);
        trim_a.execute(&mut state).unwrap();

        // Then: Cut point moved from 10 to 13
        let track = &state.sequences[&seq_id].tracks[0];

        // A: source 5-18, duration=13, timeline 0-13
        assert_eq!(track.clips[0].range.source_in_sec, 5.0);
        assert_eq!(track.clips[0].range.source_out_sec, 18.0);
        assert_eq!(track.clips[0].place.timeline_in_sec, 0.0);
        assert_eq!(track.clips[0].place.duration_sec, 13.0);

        // B: source 8-15, duration=7, timeline 13-20
        assert_eq!(track.clips[1].range.source_in_sec, 8.0);
        assert_eq!(track.clips[1].range.source_out_sec, 15.0);
        assert_eq!(track.clips[1].place.timeline_in_sec, 13.0);
        assert_eq!(track.clips[1].place.duration_sec, 7.0);
    }

    #[test]
    fn test_roll_edit_negative_shrinks_left_extends_right() {
        // Given: 2 adjacent clips with source headroom
        let mut state = create_test_state();
        let seq_id = state.active_sequence_id.clone().unwrap();
        let track_id = state.sequences[&seq_id].tracks[0].id.clone();
        let asset_id = state.assets.keys().next().unwrap().clone();

        let mut cmd_a =
            InsertClipCommand::new(&seq_id, &track_id, &asset_id, 0.0).with_source_range(5.0, 15.0);
        let result_a = cmd_a.execute(&mut state).unwrap();
        let clip_a = result_a.created_ids[0].clone();

        let mut cmd_b = InsertClipCommand::new(&seq_id, &track_id, &asset_id, 10.0)
            .with_source_range(5.0, 15.0);
        let result_b = cmd_b.execute(&mut state).unwrap();
        let clip_b = result_b.created_ids[0].clone();

        // When: Roll -3s (shrink A, extend B)
        // Negative roll → trim left clip first to avoid overlap
        let mut trim_a = TrimClipCommand::new_simple(&seq_id, &clip_a).with_source_out(12.0);
        trim_a.execute(&mut state).unwrap();

        let mut trim_b = TrimClipCommand::new_simple(&seq_id, &clip_b)
            .with_source_in(2.0)
            .with_timeline_in(7.0);
        trim_b.execute(&mut state).unwrap();

        // Then: Cut point moved from 10 to 7
        let track = &state.sequences[&seq_id].tracks[0];

        // A: source 5-12, duration=7, timeline 0-7
        assert_eq!(track.clips[0].range.source_in_sec, 5.0);
        assert_eq!(track.clips[0].range.source_out_sec, 12.0);
        assert_eq!(track.clips[0].place.timeline_in_sec, 0.0);
        assert_eq!(track.clips[0].place.duration_sec, 7.0);

        // B: source 2-15, duration=13, timeline 7-20
        assert_eq!(track.clips[1].range.source_in_sec, 2.0);
        assert_eq!(track.clips[1].range.source_out_sec, 15.0);
        assert_eq!(track.clips[1].place.timeline_in_sec, 7.0);
        assert_eq!(track.clips[1].place.duration_sec, 13.0);
    }

    #[test]
    fn test_roll_edit_undo_restores_cut_point() {
        // Given: 2 adjacent clips with roll edit applied
        let mut state = create_test_state();
        let seq_id = state.active_sequence_id.clone().unwrap();
        let track_id = state.sequences[&seq_id].tracks[0].id.clone();
        let asset_id = state.assets.keys().next().unwrap().clone();

        let mut cmd_a =
            InsertClipCommand::new(&seq_id, &track_id, &asset_id, 0.0).with_source_range(5.0, 15.0);
        let result_a = cmd_a.execute(&mut state).unwrap();
        let clip_a = result_a.created_ids[0].clone();

        let mut cmd_b = InsertClipCommand::new(&seq_id, &track_id, &asset_id, 10.0)
            .with_source_range(5.0, 15.0);
        let result_b = cmd_b.execute(&mut state).unwrap();
        let clip_b = result_b.created_ids[0].clone();

        // Roll +3
        let mut trim_b = TrimClipCommand::new_simple(&seq_id, &clip_b)
            .with_source_in(8.0)
            .with_timeline_in(13.0);
        trim_b.execute(&mut state).unwrap();

        let mut trim_a = TrimClipCommand::new_simple(&seq_id, &clip_a).with_source_out(18.0);
        trim_a.execute(&mut state).unwrap();

        // When: Undo in reverse order
        trim_a.undo(&mut state).unwrap();
        trim_b.undo(&mut state).unwrap();

        // Then: Original cut point at 10 restored
        let track = &state.sequences[&seq_id].tracks[0];
        assert_eq!(track.clips[0].range.source_in_sec, 5.0);
        assert_eq!(track.clips[0].range.source_out_sec, 15.0);
        assert_eq!(track.clips[0].place.timeline_in_sec, 0.0);
        assert_eq!(track.clips[0].place.duration_sec, 10.0);

        assert_eq!(track.clips[1].range.source_in_sec, 5.0);
        assert_eq!(track.clips[1].range.source_out_sec, 15.0);
        assert_eq!(track.clips[1].place.timeline_in_sec, 10.0);
        assert_eq!(track.clips[1].place.duration_sec, 10.0);
    }

    // -- Slip Edit Scenarios --

    #[test]
    fn test_slip_edit_shifts_source_without_timeline_change() {
        // Given: 3 contiguous clips [A(0-10), B(10-20), C(20-30)]
        let mut state = create_test_state();
        let (seq_id, _track_id, clips) = setup_multi_clip_timeline(&mut state, 3);

        // When: Slip B's source forward by 3s (no timeline movement)
        let mut trim_cmd = TrimClipCommand::new_simple(&seq_id, &clips[1])
            .with_source_in(3.0)
            .with_source_out(13.0);
        trim_cmd.execute(&mut state).unwrap();

        // Then: B's timeline position unchanged, source shifted
        let track = &state.sequences[&seq_id].tracks[0];

        // B: timeline still 10-20, source now 3-13
        assert_eq!(track.clips[1].place.timeline_in_sec, 10.0);
        assert_eq!(track.clips[1].place.duration_sec, 10.0);
        assert_eq!(track.clips[1].range.source_in_sec, 3.0);
        assert_eq!(track.clips[1].range.source_out_sec, 13.0);

        // Neighbors unchanged
        assert_eq!(track.clips[0].place.timeline_in_sec, 0.0);
        assert_eq!(track.clips[0].range.source_in_sec, 0.0);
        assert_eq!(track.clips[2].place.timeline_in_sec, 20.0);
        assert_eq!(track.clips[2].range.source_in_sec, 0.0);
    }

    // -- Slide Edit Scenarios --

    #[test]
    fn test_slide_edit_moves_clip_adjusts_neighbors() {
        // Given: 3 contiguous clips [A(0-10), B(10-20), C(20-30)]
        let mut state = create_test_state();
        let (seq_id, _track_id, clips) = setup_multi_clip_timeline(&mut state, 3);

        // When: Slide B right by 3s
        // Positive slide → shrink next first, then move, then extend prev.

        // Step 1: Trim C (shrink from start): sourceIn=3, timelineIn=23
        let mut trim_c = TrimClipCommand::new_simple(&seq_id, &clips[2])
            .with_source_in(3.0)
            .with_timeline_in(23.0);
        trim_c.execute(&mut state).unwrap();

        // Step 2: Move B to timeline 13
        let mut move_b = MoveClipCommand::new_simple(&seq_id, &clips[1], 13.0);
        move_b.execute(&mut state).unwrap();

        // Step 3: Trim A (extend): sourceOut=13
        let mut trim_a = TrimClipCommand::new_simple(&seq_id, &clips[0]).with_source_out(13.0);
        trim_a.execute(&mut state).unwrap();

        // Then: Clips still contiguous, B shifted right
        let track = &state.sequences[&seq_id].tracks[0];

        // A: source 0-13, timeline 0-13
        assert_eq!(track.clips[0].range.source_out_sec, 13.0);
        assert_eq!(track.clips[0].place.timeline_in_sec, 0.0);
        assert_eq!(track.clips[0].place.duration_sec, 13.0);

        // B: source 0-10, timeline 13-23
        assert_eq!(track.clips[1].place.timeline_in_sec, 13.0);
        assert_eq!(track.clips[1].place.duration_sec, 10.0);

        // C: source 3-10, timeline 23-30
        assert_eq!(track.clips[2].range.source_in_sec, 3.0);
        assert_eq!(track.clips[2].place.timeline_in_sec, 23.0);
        assert_eq!(track.clips[2].place.duration_sec, 7.0);

        // Total timeline length preserved: 0-30
        let last = &track.clips[2];
        let total_end = last.place.timeline_in_sec + last.place.duration_sec;
        assert_eq!(total_end, 30.0);
    }

    #[test]
    fn test_slide_edit_undo_restores_all_positions() {
        // Given: 3 clips with slide edit applied
        let mut state = create_test_state();
        let (seq_id, _track_id, clips) = setup_multi_clip_timeline(&mut state, 3);

        let mut trim_c = TrimClipCommand::new_simple(&seq_id, &clips[2])
            .with_source_in(3.0)
            .with_timeline_in(23.0);
        trim_c.execute(&mut state).unwrap();

        let mut move_b = MoveClipCommand::new_simple(&seq_id, &clips[1], 13.0);
        move_b.execute(&mut state).unwrap();

        let mut trim_a = TrimClipCommand::new_simple(&seq_id, &clips[0]).with_source_out(13.0);
        trim_a.execute(&mut state).unwrap();

        // When: Undo in reverse order
        trim_a.undo(&mut state).unwrap();
        move_b.undo(&mut state).unwrap();
        trim_c.undo(&mut state).unwrap();

        // Then: All clips restored to original contiguous positions
        let track = &state.sequences[&seq_id].tracks[0];
        for (i, clip) in track.clips.iter().enumerate() {
            assert_eq!(clip.place.timeline_in_sec, (i * 10) as f64);
            assert_eq!(clip.place.duration_sec, 10.0);
            assert_eq!(clip.range.source_in_sec, 0.0);
            assert_eq!(clip.range.source_out_sec, 10.0);
        }
    }

    // =========================================================================
    // SetClipBlendModeCommand Tests
    // =========================================================================

    /// Creates a test state with a video track containing one clip.
    fn create_test_state_with_clip() -> (ProjectState, String, String, String) {
        let mut state = create_test_state();
        let seq_id = state.active_sequence_id.clone().unwrap();
        let track_id = state.sequences[&seq_id].tracks[0].id.clone();
        let asset_id = state.assets.keys().next().unwrap().clone();

        let mut insert_cmd = InsertClipCommand::new(&seq_id, &track_id, &asset_id, 0.0);
        insert_cmd.execute(&mut state).unwrap();

        let clip_id = state.sequences[&seq_id].tracks[0].clips[0].id.clone();
        (state, seq_id, track_id, clip_id)
    }

    #[test]
    fn test_set_clip_blend_mode_should_change_blend_mode_when_video_track() {
        let (mut state, seq_id, track_id, clip_id) = create_test_state_with_clip();

        let mut cmd =
            SetClipBlendModeCommand::new(&seq_id, &track_id, &clip_id, BlendMode::Multiply);
        let result = cmd.execute(&mut state);
        assert!(result.is_ok());

        let clip = &state.sequences[&seq_id].tracks[0].clips[0];
        assert_eq!(clip.blend_mode, BlendMode::Multiply);
    }

    #[test]
    fn test_set_clip_blend_mode_should_default_to_normal() {
        let (state, seq_id, _track_id, _clip_id) = create_test_state_with_clip();

        let clip = &state.sequences[&seq_id].tracks[0].clips[0];
        assert_eq!(clip.blend_mode, BlendMode::Normal);
    }

    #[test]
    fn test_set_clip_blend_mode_should_undo_to_previous_mode() {
        let (mut state, seq_id, track_id, clip_id) = create_test_state_with_clip();

        let mut cmd = SetClipBlendModeCommand::new(&seq_id, &track_id, &clip_id, BlendMode::Screen);
        cmd.execute(&mut state).unwrap();
        assert_eq!(
            state.sequences[&seq_id].tracks[0].clips[0].blend_mode,
            BlendMode::Screen
        );

        cmd.undo(&mut state).unwrap();
        assert_eq!(
            state.sequences[&seq_id].tracks[0].clips[0].blend_mode,
            BlendMode::Normal
        );
    }

    #[test]
    fn test_set_clip_blend_mode_should_reject_audio_track() {
        let (mut state, seq_id, _track_id, _clip_id) = create_test_state_with_clip();

        // Add an audio track with a clip
        let seq = state.sequences.get_mut(&seq_id).unwrap();
        let mut audio_track = Track::new_audio("Audio 1");
        let audio_clip = Clip::new("asset1");
        let audio_clip_id = audio_clip.id.clone();
        let audio_track_id = audio_track.id.clone();
        audio_track.add_clip(audio_clip);
        seq.tracks.push(audio_track);

        let mut cmd = SetClipBlendModeCommand::new(
            &seq_id,
            &audio_track_id,
            &audio_clip_id,
            BlendMode::Overlay,
        );
        let result = cmd.execute(&mut state);
        assert!(result.is_err());
    }

    #[test]
    fn test_set_clip_blend_mode_should_support_all_expanded_modes() {
        let (mut state, seq_id, track_id, clip_id) = create_test_state_with_clip();

        let modes = vec![
            BlendMode::Subtract,
            BlendMode::Darken,
            BlendMode::Lighten,
            BlendMode::ColorBurn,
            BlendMode::ColorDodge,
            BlendMode::LinearBurn,
            BlendMode::LinearDodge,
            BlendMode::SoftLight,
            BlendMode::HardLight,
            BlendMode::VividLight,
            BlendMode::LinearLight,
            BlendMode::PinLight,
            BlendMode::Difference,
            BlendMode::Exclusion,
        ];

        for mode in modes {
            let mut cmd = SetClipBlendModeCommand::new(&seq_id, &track_id, &clip_id, mode.clone());
            let result = cmd.execute(&mut state);
            assert!(result.is_ok(), "Failed to set blend mode {:?}", mode);
            assert_eq!(state.sequences[&seq_id].tracks[0].clips[0].blend_mode, mode);
        }
    }

    // =========================================================================
    // InsertEditCommand — BDD Tests
    // =========================================================================

    /// Helper: inserts a clip directly into a track at the given position.
    fn place_clip(state: &mut ProjectState, seq_id: &str, track_id: &str, start: f64, dur: f64) {
        let asset_id = state.assets.keys().next().unwrap().clone();
        let mut cmd =
            InsertClipCommand::new(seq_id, track_id, &asset_id, start).with_source_range(0.0, dur);
        cmd.execute(state).unwrap();
    }

    // Scenario: Basic insert on empty track
    //   Given an empty video track
    //   When an insert edit is executed at position 5.0 with duration 3.0
    //   Then a new clip is placed at [5.0, 8.0]
    //   And no other clips exist
    #[test]
    fn insert_edit_should_place_clip_on_empty_track() {
        let mut state = create_test_state();
        let seq_id = state.active_sequence_id.clone().unwrap();
        let track_id = state.sequences[&seq_id].tracks[0].id.clone();
        let asset_id = state.assets.keys().next().unwrap().clone();

        let mut cmd =
            InsertEditCommand::new(&seq_id, &track_id, &asset_id, 5.0).with_source_range(0.0, 3.0);
        let result = cmd.execute(&mut state).unwrap();

        assert_eq!(result.created_ids.len(), 1);
        let track = &state.sequences[&seq_id].tracks[0];
        assert_eq!(track.clips.len(), 1);
        assert_eq!(track.clips[0].place.timeline_in_sec, 5.0);
        assert_eq!(track.clips[0].place.duration_sec, 3.0);
    }

    // Scenario: Insert with downstream clips pushes them right
    //   Given a track with clips at [0-10, 15-25]
    //   When an insert edit of duration 5.0 is executed at position 10.0
    //   Then a new clip is placed at [10.0, 15.0]
    //   And the clip originally at 15-25 shifts to [20.0, 30.0]
    //   But the clip at 0-10 remains unchanged
    #[test]
    fn insert_edit_should_shift_downstream_clips_right() {
        let mut state = create_test_state();
        let seq_id = state.active_sequence_id.clone().unwrap();
        let track_id = state.sequences[&seq_id].tracks[0].id.clone();
        let asset_id = state.assets.keys().next().unwrap().clone();

        // Place two clips: [0-10] and [15-25]
        place_clip(&mut state, &seq_id, &track_id, 0.0, 10.0);
        place_clip(&mut state, &seq_id, &track_id, 15.0, 10.0);

        let downstream_clip_id = state.sequences[&seq_id].tracks[0].clips[1].id.clone();

        // Insert edit at position 10.0 with duration 5.0
        let mut cmd =
            InsertEditCommand::new(&seq_id, &track_id, &asset_id, 10.0).with_source_range(0.0, 5.0);
        let result = cmd.execute(&mut state).unwrap();

        let track = &state.sequences[&seq_id].tracks[0];
        assert_eq!(track.clips.len(), 3);

        // Clip at 0-10 unchanged
        assert_eq!(track.clips[0].place.timeline_in_sec, 0.0);
        assert_eq!(track.clips[0].place.duration_sec, 10.0);

        // New clip at 10-15
        let new_clip = track
            .clips
            .iter()
            .find(|c| result.created_ids.contains(&c.id))
            .unwrap();
        assert_eq!(new_clip.place.timeline_in_sec, 10.0);
        assert_eq!(new_clip.place.duration_sec, 5.0);

        // Downstream clip shifted from 15-25 to 20-30
        let shifted = track
            .clips
            .iter()
            .find(|c| c.id == downstream_clip_id)
            .unwrap();
        assert_eq!(shifted.place.timeline_in_sec, 20.0);
        assert_eq!(shifted.place.duration_sec, 10.0);
    }

    // Scenario: Insert between existing clips shifts only downstream
    //   Given a track with clips at [0-5, 10-15, 20-25]
    //   When an insert edit of duration 3.0 is executed at position 10.0
    //   Then clip at 0-5 remains unchanged
    //   And clip at 10-15 shifts to [13-18]
    //   And clip at 20-25 shifts to [23-28]
    #[test]
    fn insert_edit_should_shift_only_downstream_clips() {
        let mut state = create_test_state();
        let seq_id = state.active_sequence_id.clone().unwrap();
        let track_id = state.sequences[&seq_id].tracks[0].id.clone();
        let asset_id = state.assets.keys().next().unwrap().clone();

        place_clip(&mut state, &seq_id, &track_id, 0.0, 5.0);
        place_clip(&mut state, &seq_id, &track_id, 10.0, 5.0);
        place_clip(&mut state, &seq_id, &track_id, 20.0, 5.0);

        let clip_at_0_id = state.sequences[&seq_id].tracks[0].clips[0].id.clone();
        let clip_at_10_id = state.sequences[&seq_id].tracks[0].clips[1].id.clone();
        let clip_at_20_id = state.sequences[&seq_id].tracks[0].clips[2].id.clone();

        let mut cmd =
            InsertEditCommand::new(&seq_id, &track_id, &asset_id, 10.0).with_source_range(0.0, 3.0);
        cmd.execute(&mut state).unwrap();

        let track = &state.sequences[&seq_id].tracks[0];

        // clip at 0-5: unchanged
        let c0 = track.clips.iter().find(|c| c.id == clip_at_0_id).unwrap();
        assert_eq!(c0.place.timeline_in_sec, 0.0);

        // clip at 10-15: shifted to 13-18
        let c1 = track.clips.iter().find(|c| c.id == clip_at_10_id).unwrap();
        assert_eq!(c1.place.timeline_in_sec, 13.0);

        // clip at 20-25: shifted to 23-28
        let c2 = track.clips.iter().find(|c| c.id == clip_at_20_id).unwrap();
        assert_eq!(c2.place.timeline_in_sec, 23.0);
    }

    // Scenario: Insert inside an existing clip splits it at the playhead
    //   Given a track with clip A at [0-20]
    //   When an insert edit of duration 3.0 is executed at position 8.0
    //   Then clip A is trimmed to [0-8]
    //   And a right fragment exists at [11-23]
    //   And the inserted clip occupies [8-11]
    #[test]
    fn insert_edit_should_split_clip_spanning_insert_point() {
        let mut state = create_test_state();
        let seq_id = state.active_sequence_id.clone().unwrap();
        let track_id = state.sequences[&seq_id].tracks[0].id.clone();
        let asset_id = state.assets.keys().next().unwrap().clone();

        place_clip(&mut state, &seq_id, &track_id, 0.0, 20.0);
        let original_clip_id = state.sequences[&seq_id].tracks[0].clips[0].id.clone();

        let mut cmd =
            InsertEditCommand::new(&seq_id, &track_id, &asset_id, 8.0).with_source_range(0.0, 3.0);
        let result = cmd.execute(&mut state).unwrap();

        let track = &state.sequences[&seq_id].tracks[0];
        assert_eq!(track.clips.len(), 3);

        let left = track
            .clips
            .iter()
            .find(|c| c.id == original_clip_id)
            .unwrap();
        assert_eq!(left.place.timeline_in_sec, 0.0);
        assert_eq!(left.place.duration_sec, 8.0);
        assert_eq!(left.range.source_in_sec, 0.0);
        assert_eq!(left.range.source_out_sec, 8.0);

        let inserted = track
            .clips
            .iter()
            .find(|c| result.created_ids.contains(&c.id))
            .unwrap();
        assert_eq!(inserted.place.timeline_in_sec, 8.0);
        assert_eq!(inserted.place.duration_sec, 3.0);

        let right = track
            .clips
            .iter()
            .find(|c| c.id != original_clip_id && !result.created_ids.contains(&c.id))
            .unwrap();
        assert_eq!(right.place.timeline_in_sec, 11.0);
        assert_eq!(right.place.duration_sec, 12.0);
        assert_eq!(right.range.source_in_sec, 8.0);
        assert_eq!(right.range.source_out_sec, 20.0);
    }

    #[test]
    fn insert_edit_should_rebase_time_remap_on_split_fragments() {
        let mut state = create_test_state();
        let seq_id = state.active_sequence_id.clone().unwrap();
        let track_id = state.sequences[&seq_id].tracks[0].id.clone();
        let asset_id = state.assets.keys().next().unwrap().clone();

        let mut insert_cmd =
            InsertClipCommand::new(&seq_id, &track_id, &asset_id, 0.0).with_source_range(0.0, 4.0);
        insert_cmd.execute(&mut state).unwrap();
        let original_clip_id = state.sequences[&seq_id].tracks[0].clips[0].id.clone();

        {
            let clip = &mut state.sequences.get_mut(&seq_id).unwrap().tracks[0].clips[0];
            clip.time_remap = Some(linear_time_remap_curve(&[(0.0, 0.0), (2.0, 4.0)]));
            clip.place.duration_sec = 2.0;
        }

        let mut cmd =
            InsertEditCommand::new(&seq_id, &track_id, &asset_id, 1.0).with_source_range(0.0, 0.5);
        let result = cmd.execute(&mut state).unwrap();

        let track = &state.sequences[&seq_id].tracks[0];
        let left = track
            .clips
            .iter()
            .find(|c| c.id == original_clip_id)
            .unwrap();
        let right = track
            .clips
            .iter()
            .find(|c| c.id != original_clip_id && !result.created_ids.contains(&c.id))
            .unwrap();

        assert!((left.time_remap.as_ref().unwrap().evaluate(1.0) - 2.0).abs() < 1e-6);
        assert!((right.time_remap.as_ref().unwrap().evaluate(0.0) - 2.0).abs() < 1e-6);
        assert!((right.time_remap.as_ref().unwrap().evaluate(1.0) - 4.0).abs() < 1e-6);
    }

    // Scenario: Undo after splitting at the insert point restores the original clip
    //   Given a track with clip A at [0-20]
    //   When an insert edit at position 8.0 splits it
    //   And undo is called
    //   Then only the original clip remains at [0-20]
    #[test]
    fn insert_edit_undo_should_restore_split_clip() {
        let mut state = create_test_state();
        let seq_id = state.active_sequence_id.clone().unwrap();
        let track_id = state.sequences[&seq_id].tracks[0].id.clone();
        let asset_id = state.assets.keys().next().unwrap().clone();

        place_clip(&mut state, &seq_id, &track_id, 0.0, 20.0);
        let original_clip_id = state.sequences[&seq_id].tracks[0].clips[0].id.clone();

        let mut cmd =
            InsertEditCommand::new(&seq_id, &track_id, &asset_id, 8.0).with_source_range(0.0, 3.0);
        cmd.execute(&mut state).unwrap();

        cmd.undo(&mut state).unwrap();

        let track = &state.sequences[&seq_id].tracks[0];
        assert_eq!(track.clips.len(), 1);

        let restored = &track.clips[0];
        assert_eq!(restored.id, original_clip_id);
        assert_eq!(restored.place.timeline_in_sec, 0.0);
        assert_eq!(restored.place.duration_sec, 20.0);
        assert_eq!(restored.range.source_in_sec, 0.0);
        assert_eq!(restored.range.source_out_sec, 20.0);
    }

    // Scenario: Undo reverses insert and shift atomically
    //   Given a track with clips at [0-10, 15-25]
    //   When an insert edit is executed at position 10.0
    //   And undo is called
    //   Then the inserted clip is removed
    //   And the downstream clip returns to [15-25]
    #[test]
    fn insert_edit_undo_should_reverse_insert_and_shift_atomically() {
        let mut state = create_test_state();
        let seq_id = state.active_sequence_id.clone().unwrap();
        let track_id = state.sequences[&seq_id].tracks[0].id.clone();
        let asset_id = state.assets.keys().next().unwrap().clone();

        place_clip(&mut state, &seq_id, &track_id, 0.0, 10.0);
        place_clip(&mut state, &seq_id, &track_id, 15.0, 10.0);

        let downstream_id = state.sequences[&seq_id].tracks[0].clips[1].id.clone();

        let mut cmd =
            InsertEditCommand::new(&seq_id, &track_id, &asset_id, 10.0).with_source_range(0.0, 5.0);
        cmd.execute(&mut state).unwrap();

        // Verify insert happened
        assert_eq!(state.sequences[&seq_id].tracks[0].clips.len(), 3);

        // Undo
        cmd.undo(&mut state).unwrap();

        let track = &state.sequences[&seq_id].tracks[0];
        assert_eq!(track.clips.len(), 2);

        // Original clip at 0-10 unchanged
        assert_eq!(track.clips[0].place.timeline_in_sec, 0.0);

        // Downstream clip restored to 15-25
        let restored = track.clips.iter().find(|c| c.id == downstream_id).unwrap();
        assert_eq!(restored.place.timeline_in_sec, 15.0);
        assert_eq!(restored.place.duration_sec, 10.0);
    }

    // Scenario: Sync-locked tracks shift together
    //   Given Track1 (target) and Track2 (sync_lock=true)
    //   And Track1 has clips at [0-10, 20-30]
    //   And Track2 has clips at [5-15, 25-35]
    //   When an insert edit of duration 5.0 is executed on Track1 at position 10.0
    //   Then Track1's clip at 20-30 shifts to [25-35]
    //   And Track2's clip at 5-15 splits into [5-10] and [15-20]
    //   And Track2's clip at 25-35 shifts to [30-40]
    #[test]
    fn insert_edit_should_shift_sync_locked_tracks_together() {
        let mut state = create_test_state();
        let seq_id = state.active_sequence_id.clone().unwrap();
        let track1_id = state.sequences[&seq_id].tracks[0].id.clone();

        // Add second track with sync_lock enabled
        let mut track2 = Track::new("Video 2", TrackKind::Video);
        track2.sync_lock = true;
        let track2_id = track2.id.clone();
        state
            .sequences
            .get_mut(&seq_id)
            .unwrap()
            .tracks
            .push(track2);

        let asset_id = state.assets.keys().next().unwrap().clone();

        // Track1: clips at [0-10, 20-30]
        place_clip(&mut state, &seq_id, &track1_id, 0.0, 10.0);
        place_clip(&mut state, &seq_id, &track1_id, 20.0, 10.0);

        // Track2: clips at [5-15, 25-35]
        place_clip(&mut state, &seq_id, &track2_id, 5.0, 10.0);
        place_clip(&mut state, &seq_id, &track2_id, 25.0, 10.0);

        let t1_clip_20_id = state.sequences[&seq_id].tracks[0].clips[1].id.clone();
        let t2_clip_5_id = state.sequences[&seq_id].tracks[1].clips[0].id.clone();
        let t2_clip_25_id = state.sequences[&seq_id].tracks[1].clips[1].id.clone();

        // Insert edit on Track1 at position 10.0, duration 5.0
        let mut cmd = InsertEditCommand::new(&seq_id, &track1_id, &asset_id, 10.0)
            .with_source_range(0.0, 5.0);
        cmd.execute(&mut state).unwrap();

        let seq = &state.sequences[&seq_id];

        // Track1: clip at 20-30 → 25-35
        let t1 = seq.tracks.iter().find(|t| t.id == track1_id).unwrap();
        let c = t1.clips.iter().find(|c| c.id == t1_clip_20_id).unwrap();
        assert_eq!(c.place.timeline_in_sec, 25.0);

        // Track2: clip at 5-15 is split into [5-10] and [15-20]
        let t2 = seq.tracks.iter().find(|t| t.id == track2_id).unwrap();
        let c_before = t2.clips.iter().find(|c| c.id == t2_clip_5_id).unwrap();
        assert_eq!(c_before.place.timeline_in_sec, 5.0);
        assert_eq!(c_before.place.duration_sec, 5.0);
        assert_eq!(c_before.range.source_in_sec, 0.0);
        assert_eq!(c_before.range.source_out_sec, 5.0);

        let c_fragment = t2
            .clips
            .iter()
            .find(|c| c.id != t2_clip_5_id && c.place.timeline_in_sec == 15.0)
            .unwrap();
        assert_eq!(c_fragment.place.duration_sec, 5.0);
        assert_eq!(c_fragment.range.source_in_sec, 5.0);
        assert_eq!(c_fragment.range.source_out_sec, 10.0);

        // Track2: clip at 25-35 → 30-40
        let c_after = t2.clips.iter().find(|c| c.id == t2_clip_25_id).unwrap();
        assert_eq!(c_after.place.timeline_in_sec, 30.0);
    }

    // Scenario: Locked tracks are never modified during insert edit
    //   Given Track1 (target) and Track2 (locked=true, sync_lock=true)
    //   And Track2 has clips at [10-20]
    //   When an insert edit is executed on Track1 at position 5.0
    //   Then Track2's clip remains at [10-20]
    #[test]
    fn insert_edit_should_not_shift_locked_tracks() {
        let mut state = create_test_state();
        let seq_id = state.active_sequence_id.clone().unwrap();
        let track1_id = state.sequences[&seq_id].tracks[0].id.clone();

        // Add locked + sync-locked track
        let mut track2 = Track::new("Video 2", TrackKind::Video);
        track2.locked = true;
        track2.sync_lock = true;
        let track2_id = track2.id.clone();
        state
            .sequences
            .get_mut(&seq_id)
            .unwrap()
            .tracks
            .push(track2);

        let asset_id = state.assets.keys().next().unwrap().clone();

        // Track2: clip at [10-20]
        place_clip(&mut state, &seq_id, &track2_id, 10.0, 10.0);

        let t2_clip_id = state.sequences[&seq_id].tracks[1].clips[0].id.clone();

        // Insert edit on Track1 at position 5.0
        let mut cmd =
            InsertEditCommand::new(&seq_id, &track1_id, &asset_id, 5.0).with_source_range(0.0, 3.0);
        cmd.execute(&mut state).unwrap();

        // Track2's clip unchanged
        let t2 = state.sequences[&seq_id]
            .tracks
            .iter()
            .find(|t| t.id == track2_id)
            .unwrap();
        let c = t2.clips.iter().find(|c| c.id == t2_clip_id).unwrap();
        assert_eq!(c.place.timeline_in_sec, 10.0);
    }

    // Scenario: Insert edit on locked target track should fail
    //   Given a locked video track
    //   When an insert edit is attempted
    //   Then it should return an error
    #[test]
    fn insert_edit_should_reject_locked_target_track() {
        let mut state = create_test_state();
        let seq_id = state.active_sequence_id.clone().unwrap();
        let track_id = state.sequences[&seq_id].tracks[0].id.clone();
        let asset_id = state.assets.keys().next().unwrap().clone();

        // Lock the target track
        state.sequences.get_mut(&seq_id).unwrap().tracks[0].locked = true;

        let mut cmd =
            InsertEditCommand::new(&seq_id, &track_id, &asset_id, 5.0).with_source_range(0.0, 3.0);
        let result = cmd.execute(&mut state);

        assert!(result.is_err());
        assert!(
            result.unwrap_err().to_string().contains("locked"),
            "Error should mention 'locked'"
        );
    }

    // Scenario: Undo with sync-locked tracks restores all positions
    //   Given Track1 and Track2 (sync_lock=true)
    //   When an insert edit shifts clips on both tracks
    //   And undo is called
    //   Then all clips on all tracks return to original positions
    #[test]
    fn insert_edit_undo_should_restore_sync_locked_tracks() {
        let mut state = create_test_state();
        let seq_id = state.active_sequence_id.clone().unwrap();
        let track1_id = state.sequences[&seq_id].tracks[0].id.clone();

        let mut track2 = Track::new("Video 2", TrackKind::Video);
        track2.sync_lock = true;
        let track2_id = track2.id.clone();
        state
            .sequences
            .get_mut(&seq_id)
            .unwrap()
            .tracks
            .push(track2);

        let asset_id = state.assets.keys().next().unwrap().clone();

        // Track1: clip at [10-20]
        place_clip(&mut state, &seq_id, &track1_id, 10.0, 10.0);
        // Track2: clip at [15-25]
        place_clip(&mut state, &seq_id, &track2_id, 15.0, 10.0);

        let t1_clip_id = state.sequences[&seq_id].tracks[0].clips[0].id.clone();
        let t2_clip_id = state.sequences[&seq_id].tracks[1].clips[0].id.clone();

        let mut cmd =
            InsertEditCommand::new(&seq_id, &track1_id, &asset_id, 5.0).with_source_range(0.0, 5.0);
        cmd.execute(&mut state).unwrap();

        // Verify shifts happened
        let t1_clip = state.sequences[&seq_id]
            .tracks
            .iter()
            .find(|t| t.id == track1_id)
            .unwrap()
            .clips
            .iter()
            .find(|c| c.id == t1_clip_id)
            .unwrap();
        assert_eq!(t1_clip.place.timeline_in_sec, 15.0);

        let t2_clip = state.sequences[&seq_id]
            .tracks
            .iter()
            .find(|t| t.id == track2_id)
            .unwrap()
            .clips
            .iter()
            .find(|c| c.id == t2_clip_id)
            .unwrap();
        assert_eq!(t2_clip.place.timeline_in_sec, 20.0);

        // Undo
        cmd.undo(&mut state).unwrap();

        // Track1: clip restored to [10-20]
        let t1_clip = state.sequences[&seq_id]
            .tracks
            .iter()
            .find(|t| t.id == track1_id)
            .unwrap()
            .clips
            .iter()
            .find(|c| c.id == t1_clip_id)
            .unwrap();
        assert_eq!(t1_clip.place.timeline_in_sec, 10.0);

        // Track2: clip restored to [15-25]
        let t2_clip = state.sequences[&seq_id]
            .tracks
            .iter()
            .find(|t| t.id == track2_id)
            .unwrap()
            .clips
            .iter()
            .find(|c| c.id == t2_clip_id)
            .unwrap();
        assert_eq!(t2_clip.place.timeline_in_sec, 15.0);
    }

    // =========================================================================
    // OverwriteEditCommand — BDD Tests
    // =========================================================================

    // Scenario: Basic overwrite on empty track
    //   Given an empty track
    //   When overwrite edit places a clip at 5.0 with duration 3.0
    //   Then a new clip exists at [5.0, 8.0]
    #[test]
    fn overwrite_edit_should_place_clip_on_empty_track() {
        let mut state = create_test_state();
        let seq_id = state.active_sequence_id.clone().unwrap();
        let track_id = state.sequences[&seq_id].tracks[0].id.clone();
        let asset_id = state.assets.keys().next().unwrap().clone();

        let mut cmd = OverwriteEditCommand::new(&seq_id, &track_id, &asset_id, 5.0)
            .with_source_range(0.0, 3.0);
        let result = cmd.execute(&mut state).unwrap();

        assert_eq!(result.created_ids.len(), 1);
        let track = &state.sequences[&seq_id].tracks[0];
        assert_eq!(track.clips.len(), 1);
        assert_eq!(track.clips[0].place.timeline_in_sec, 5.0);
        assert_eq!(track.clips[0].place.duration_sec, 3.0);
    }

    // Scenario: Overwrite trims clip that overlaps on the left (existing starts before)
    //   Given a track with clip A at [10-20]
    //   When overwrite edit places a clip at [15-25]
    //   Then new clip at [15-25]
    //   And clip A is trimmed to [10-15]
    #[test]
    fn overwrite_edit_should_trim_back_of_left_overlapping_clip() {
        let mut state = create_test_state();
        let seq_id = state.active_sequence_id.clone().unwrap();
        let track_id = state.sequences[&seq_id].tracks[0].id.clone();
        let asset_id = state.assets.keys().next().unwrap().clone();

        // Place clip A at [10-20]
        place_clip(&mut state, &seq_id, &track_id, 10.0, 10.0);
        let clip_a_id = state.sequences[&seq_id].tracks[0].clips[0].id.clone();

        // Overwrite at [15-25]
        let mut cmd = OverwriteEditCommand::new(&seq_id, &track_id, &asset_id, 15.0)
            .with_source_range(0.0, 10.0);
        cmd.execute(&mut state).unwrap();

        let track = &state.sequences[&seq_id].tracks[0];
        assert_eq!(track.clips.len(), 2);

        // Clip A trimmed to [10-15]
        let clip_a = track.clips.iter().find(|c| c.id == clip_a_id).unwrap();
        assert_eq!(clip_a.place.timeline_in_sec, 10.0);
        assert_eq!(clip_a.place.duration_sec, 5.0);
        assert_eq!(clip_a.range.source_in_sec, 0.0);
        assert_eq!(clip_a.range.source_out_sec, 5.0);
    }

    // Scenario: Overwrite trims clip that overlaps on the right (existing extends past)
    //   Given a track with clip A at [10-20]
    //   When overwrite edit places a clip at [5-15]
    //   Then new clip at [5-15]
    //   And clip A is trimmed to [15-20] (front trimmed)
    #[test]
    fn overwrite_edit_should_trim_front_of_right_overlapping_clip() {
        let mut state = create_test_state();
        let seq_id = state.active_sequence_id.clone().unwrap();
        let track_id = state.sequences[&seq_id].tracks[0].id.clone();
        let asset_id = state.assets.keys().next().unwrap().clone();

        // Place clip A at [10-20], source [0-10]
        place_clip(&mut state, &seq_id, &track_id, 10.0, 10.0);
        let clip_a_id = state.sequences[&seq_id].tracks[0].clips[0].id.clone();

        // Overwrite at [5-15]
        let mut cmd = OverwriteEditCommand::new(&seq_id, &track_id, &asset_id, 5.0)
            .with_source_range(0.0, 10.0);
        cmd.execute(&mut state).unwrap();

        let track = &state.sequences[&seq_id].tracks[0];
        assert_eq!(track.clips.len(), 2);

        // Clip A trimmed to [15-20], source_in advanced by 5
        let clip_a = track.clips.iter().find(|c| c.id == clip_a_id).unwrap();
        assert_eq!(clip_a.place.timeline_in_sec, 15.0);
        assert_eq!(clip_a.place.duration_sec, 5.0);
        assert_eq!(clip_a.range.source_in_sec, 5.0);
        assert_eq!(clip_a.range.source_out_sec, 10.0);
    }

    // Scenario: Fully covered clip is removed
    //   Given a track with clip A at [10-15]
    //   When overwrite edit places a clip at [5-20]
    //   Then clip A is removed
    //   And new clip at [5-20]
    #[test]
    fn overwrite_edit_should_remove_fully_covered_clip() {
        let mut state = create_test_state();
        let seq_id = state.active_sequence_id.clone().unwrap();
        let track_id = state.sequences[&seq_id].tracks[0].id.clone();
        let asset_id = state.assets.keys().next().unwrap().clone();

        place_clip(&mut state, &seq_id, &track_id, 10.0, 5.0);
        let clip_a_id = state.sequences[&seq_id].tracks[0].clips[0].id.clone();

        let mut cmd = OverwriteEditCommand::new(&seq_id, &track_id, &asset_id, 5.0)
            .with_source_range(0.0, 15.0);
        cmd.execute(&mut state).unwrap();

        let track = &state.sequences[&seq_id].tracks[0];

        // Clip A removed
        assert!(track.clips.iter().all(|c| c.id != clip_a_id));
        // Only the new overwrite clip
        assert_eq!(track.clips.len(), 1);
        assert_eq!(track.clips[0].place.timeline_in_sec, 5.0);
        assert_eq!(track.clips[0].place.duration_sec, 15.0);
    }

    // Scenario: Spanning clip is split into two fragments
    //   Given a track with clip A at [0-30], source [0-30]
    //   When overwrite edit places a clip at [10-20]
    //   Then clip A is trimmed to [0-10]
    //   And a new right fragment at [20-30] with source [20-30]
    //   And new overwrite clip at [10-20]
    #[test]
    fn overwrite_edit_should_split_spanning_clip() {
        let mut state = create_test_state();
        let seq_id = state.active_sequence_id.clone().unwrap();
        let track_id = state.sequences[&seq_id].tracks[0].id.clone();
        let asset_id = state.assets.keys().next().unwrap().clone();

        // Place clip at [0-30], source [0-30]
        place_clip(&mut state, &seq_id, &track_id, 0.0, 30.0);
        let original_id = state.sequences[&seq_id].tracks[0].clips[0].id.clone();

        // Overwrite at [10-20]
        let mut cmd = OverwriteEditCommand::new(&seq_id, &track_id, &asset_id, 10.0)
            .with_source_range(0.0, 10.0);
        cmd.execute(&mut state).unwrap();

        let track = &state.sequences[&seq_id].tracks[0];
        assert_eq!(track.clips.len(), 3); // left fragment + overwrite + right fragment

        // Left fragment: [0-10], source [0-10]
        let left = track.clips.iter().find(|c| c.id == original_id).unwrap();
        assert_eq!(left.place.timeline_in_sec, 0.0);
        assert_eq!(left.place.duration_sec, 10.0);
        assert_eq!(left.range.source_in_sec, 0.0);
        assert_eq!(left.range.source_out_sec, 10.0);

        // Right fragment: [20-30], source [20-30]
        let right = track
            .clips
            .iter()
            .find(|c| c.place.timeline_in_sec == 20.0)
            .unwrap();
        assert_eq!(right.place.duration_sec, 10.0);
        assert_eq!(right.range.source_in_sec, 20.0);
        assert_eq!(right.range.source_out_sec, 30.0);

        // Overwrite clip: [10-20]
        let overwrite = track
            .clips
            .iter()
            .find(|c| c.place.timeline_in_sec == 10.0)
            .unwrap();
        assert_eq!(overwrite.place.duration_sec, 10.0);
    }

    // Scenario: Multi-clip overlap
    //   Given clips at [5-10, 12-18, 20-25]
    //   When overwrite edit at [8-22]
    //   Then clip at [5-10] trimmed to [5-8]
    //   And clip at [12-18] removed (fully covered)
    //   And clip at [20-25] trimmed to [22-25]
    #[test]
    fn overwrite_edit_should_handle_multi_clip_overlap() {
        let mut state = create_test_state();
        let seq_id = state.active_sequence_id.clone().unwrap();
        let track_id = state.sequences[&seq_id].tracks[0].id.clone();
        let asset_id = state.assets.keys().next().unwrap().clone();

        place_clip(&mut state, &seq_id, &track_id, 5.0, 5.0); // [5-10]
        place_clip(&mut state, &seq_id, &track_id, 12.0, 6.0); // [12-18]
        place_clip(&mut state, &seq_id, &track_id, 20.0, 5.0); // [20-25]

        let clip_5_id = state.sequences[&seq_id].tracks[0].clips[0].id.clone();
        let clip_12_id = state.sequences[&seq_id].tracks[0].clips[1].id.clone();
        let clip_20_id = state.sequences[&seq_id].tracks[0].clips[2].id.clone();

        // Overwrite at [8-22]
        let mut cmd = OverwriteEditCommand::new(&seq_id, &track_id, &asset_id, 8.0)
            .with_source_range(0.0, 14.0);
        cmd.execute(&mut state).unwrap();

        let track = &state.sequences[&seq_id].tracks[0];

        // Clip at [5-10] trimmed to [5-8]
        let c5 = track.clips.iter().find(|c| c.id == clip_5_id).unwrap();
        assert_eq!(c5.place.timeline_in_sec, 5.0);
        assert_eq!(c5.place.duration_sec, 3.0);

        // Clip at [12-18] removed
        assert!(track.clips.iter().all(|c| c.id != clip_12_id));

        // Clip at [20-25] trimmed to [22-25]
        let c20 = track.clips.iter().find(|c| c.id == clip_20_id).unwrap();
        assert_eq!(c20.place.timeline_in_sec, 22.0);
        assert_eq!(c20.place.duration_sec, 3.0);
    }

    // Scenario: Undo restores all original clips exactly
    //   Given clips at [5-10, 12-18, 20-25]
    //   When overwrite edit at [8-22]
    //   And undo is called
    //   Then all 3 clips are restored to original positions and ranges
    #[test]
    fn overwrite_edit_undo_should_restore_all_original_clips() {
        let mut state = create_test_state();
        let seq_id = state.active_sequence_id.clone().unwrap();
        let track_id = state.sequences[&seq_id].tracks[0].id.clone();
        let asset_id = state.assets.keys().next().unwrap().clone();

        place_clip(&mut state, &seq_id, &track_id, 5.0, 5.0);
        place_clip(&mut state, &seq_id, &track_id, 12.0, 6.0);
        place_clip(&mut state, &seq_id, &track_id, 20.0, 5.0);

        let clip_5_id = state.sequences[&seq_id].tracks[0].clips[0].id.clone();
        let clip_12_id = state.sequences[&seq_id].tracks[0].clips[1].id.clone();
        let clip_20_id = state.sequences[&seq_id].tracks[0].clips[2].id.clone();

        let mut cmd = OverwriteEditCommand::new(&seq_id, &track_id, &asset_id, 8.0)
            .with_source_range(0.0, 14.0);
        cmd.execute(&mut state).unwrap();

        // Verify overwrite happened
        assert_eq!(state.sequences[&seq_id].tracks[0].clips.len(), 3);

        // Undo
        cmd.undo(&mut state).unwrap();

        let track = &state.sequences[&seq_id].tracks[0];
        assert_eq!(track.clips.len(), 3); // Original 3 clips restored

        let c5 = track.clips.iter().find(|c| c.id == clip_5_id).unwrap();
        assert_eq!(c5.place.timeline_in_sec, 5.0);
        assert_eq!(c5.place.duration_sec, 5.0);

        let c12 = track.clips.iter().find(|c| c.id == clip_12_id).unwrap();
        assert_eq!(c12.place.timeline_in_sec, 12.0);
        assert_eq!(c12.place.duration_sec, 6.0);

        let c20 = track.clips.iter().find(|c| c.id == clip_20_id).unwrap();
        assert_eq!(c20.place.timeline_in_sec, 20.0);
        assert_eq!(c20.place.duration_sec, 5.0);
    }

    // Scenario: Undo after split restores the original spanning clip
    //   Given a clip at [0-30]
    //   When overwrite at [10-20] splits it
    //   And undo is called
    //   Then the original clip is restored to [0-30]
    //   And the right fragment is removed
    #[test]
    fn overwrite_edit_undo_should_restore_split_clip() {
        let mut state = create_test_state();
        let seq_id = state.active_sequence_id.clone().unwrap();
        let track_id = state.sequences[&seq_id].tracks[0].id.clone();
        let asset_id = state.assets.keys().next().unwrap().clone();

        place_clip(&mut state, &seq_id, &track_id, 0.0, 30.0);
        let original_id = state.sequences[&seq_id].tracks[0].clips[0].id.clone();

        let mut cmd = OverwriteEditCommand::new(&seq_id, &track_id, &asset_id, 10.0)
            .with_source_range(0.0, 10.0);
        cmd.execute(&mut state).unwrap();

        assert_eq!(state.sequences[&seq_id].tracks[0].clips.len(), 3);

        cmd.undo(&mut state).unwrap();

        let track = &state.sequences[&seq_id].tracks[0];
        assert_eq!(track.clips.len(), 1);

        let restored = &track.clips[0];
        assert_eq!(restored.id, original_id);
        assert_eq!(restored.place.timeline_in_sec, 0.0);
        assert_eq!(restored.place.duration_sec, 30.0);
        assert_eq!(restored.range.source_in_sec, 0.0);
        assert_eq!(restored.range.source_out_sec, 30.0);
    }

    // =========================================================================
    // RippleDeleteCommand — BDD Tests
    // =========================================================================

    // Scenario: Ripple delete removes clip and closes gap
    //   Given clips at [0-10, 15-25, 30-40]
    //   When ripple delete is called on clip at [15-25]
    //   Then clip at [15-25] is removed
    //   And clip at [30-40] shifts to [20-30] (closed gap of 10)
    //   And clip at [0-10] is unchanged
    #[test]
    fn ripple_delete_should_remove_clip_and_close_gap() {
        let mut state = create_test_state();
        let seq_id = state.active_sequence_id.clone().unwrap();
        let track_id = state.sequences[&seq_id].tracks[0].id.clone();

        place_clip(&mut state, &seq_id, &track_id, 0.0, 10.0);
        place_clip(&mut state, &seq_id, &track_id, 15.0, 10.0);
        place_clip(&mut state, &seq_id, &track_id, 30.0, 10.0);

        let clip_0_id = state.sequences[&seq_id].tracks[0].clips[0].id.clone();
        let clip_15_id = state.sequences[&seq_id].tracks[0].clips[1].id.clone();
        let clip_30_id = state.sequences[&seq_id].tracks[0].clips[2].id.clone();

        let mut cmd = RippleDeleteCommand::new(&seq_id, &track_id, vec![clip_15_id.clone()]);
        cmd.execute(&mut state).unwrap();

        let track = &state.sequences[&seq_id].tracks[0];
        assert_eq!(track.clips.len(), 2);

        // Clip at 0-10 unchanged
        let c0 = track.clips.iter().find(|c| c.id == clip_0_id).unwrap();
        assert_eq!(c0.place.timeline_in_sec, 0.0);

        // Clip at 30-40 shifted left by 10 (removed clip's duration)
        let c30 = track.clips.iter().find(|c| c.id == clip_30_id).unwrap();
        assert_eq!(c30.place.timeline_in_sec, 20.0);
    }

    // Scenario: Ripple delete undo restores clip and positions
    #[test]
    fn ripple_delete_undo_should_restore_clip_and_positions() {
        let mut state = create_test_state();
        let seq_id = state.active_sequence_id.clone().unwrap();
        let track_id = state.sequences[&seq_id].tracks[0].id.clone();

        place_clip(&mut state, &seq_id, &track_id, 0.0, 10.0);
        place_clip(&mut state, &seq_id, &track_id, 15.0, 10.0);
        place_clip(&mut state, &seq_id, &track_id, 30.0, 10.0);

        let clip_15_id = state.sequences[&seq_id].tracks[0].clips[1].id.clone();
        let clip_30_id = state.sequences[&seq_id].tracks[0].clips[2].id.clone();

        let mut cmd = RippleDeleteCommand::new(&seq_id, &track_id, vec![clip_15_id.clone()]);
        cmd.execute(&mut state).unwrap();

        cmd.undo(&mut state).unwrap();

        let track = &state.sequences[&seq_id].tracks[0];
        assert_eq!(track.clips.len(), 3);

        let c15 = track.clips.iter().find(|c| c.id == clip_15_id).unwrap();
        assert_eq!(c15.place.timeline_in_sec, 15.0);

        let c30 = track.clips.iter().find(|c| c.id == clip_30_id).unwrap();
        assert_eq!(c30.place.timeline_in_sec, 30.0);
    }

    // Scenario: Multi-clip ripple delete
    //   Given clips at [0-10, 15-25, 30-40]
    //   When ripple delete both [15-25] and [30-40]
    //   Then only clip [0-10] remains, unchanged
    #[test]
    fn ripple_delete_should_handle_multi_clip_selection() {
        let mut state = create_test_state();
        let seq_id = state.active_sequence_id.clone().unwrap();
        let track_id = state.sequences[&seq_id].tracks[0].id.clone();

        place_clip(&mut state, &seq_id, &track_id, 0.0, 10.0);
        place_clip(&mut state, &seq_id, &track_id, 15.0, 10.0);
        place_clip(&mut state, &seq_id, &track_id, 30.0, 10.0);

        let clip_15_id = state.sequences[&seq_id].tracks[0].clips[1].id.clone();
        let clip_30_id = state.sequences[&seq_id].tracks[0].clips[2].id.clone();

        let mut cmd = RippleDeleteCommand::new(&seq_id, &track_id, vec![clip_15_id, clip_30_id]);
        cmd.execute(&mut state).unwrap();

        let track = &state.sequences[&seq_id].tracks[0];
        assert_eq!(track.clips.len(), 1);
        assert_eq!(track.clips[0].place.timeline_in_sec, 0.0);
    }

    // =========================================================================
    // LiftCommand — BDD Tests
    // =========================================================================

    // Scenario: Lift removes clip but leaves gap
    //   Given clips at [0-10, 15-25, 30-40]
    //   When lift is called on clip at [15-25]
    //   Then clip at [15-25] is removed
    //   And clip at [30-40] stays at [30-40] (gap remains)
    #[test]
    fn lift_should_remove_clip_and_leave_gap() {
        let mut state = create_test_state();
        let seq_id = state.active_sequence_id.clone().unwrap();
        let track_id = state.sequences[&seq_id].tracks[0].id.clone();

        place_clip(&mut state, &seq_id, &track_id, 0.0, 10.0);
        place_clip(&mut state, &seq_id, &track_id, 15.0, 10.0);
        place_clip(&mut state, &seq_id, &track_id, 30.0, 10.0);

        let clip_15_id = state.sequences[&seq_id].tracks[0].clips[1].id.clone();
        let clip_30_id = state.sequences[&seq_id].tracks[0].clips[2].id.clone();

        let mut cmd = LiftCommand::new(&seq_id, &track_id, vec![clip_15_id.clone()]);
        cmd.execute(&mut state).unwrap();

        let track = &state.sequences[&seq_id].tracks[0];
        assert_eq!(track.clips.len(), 2);

        // Clip at 30-40 unchanged (gap remains at 15-25)
        let c30 = track.clips.iter().find(|c| c.id == clip_30_id).unwrap();
        assert_eq!(c30.place.timeline_in_sec, 30.0);
    }

    // Scenario: Lift undo restores removed clip
    #[test]
    fn lift_undo_should_restore_removed_clip() {
        let mut state = create_test_state();
        let seq_id = state.active_sequence_id.clone().unwrap();
        let track_id = state.sequences[&seq_id].tracks[0].id.clone();

        place_clip(&mut state, &seq_id, &track_id, 10.0, 10.0);
        let clip_id = state.sequences[&seq_id].tracks[0].clips[0].id.clone();

        let mut cmd = LiftCommand::new(&seq_id, &track_id, vec![clip_id.clone()]);
        cmd.execute(&mut state).unwrap();

        assert_eq!(state.sequences[&seq_id].tracks[0].clips.len(), 0);

        cmd.undo(&mut state).unwrap();

        let track = &state.sequences[&seq_id].tracks[0];
        assert_eq!(track.clips.len(), 1);
        assert_eq!(track.clips[0].id, clip_id);
        assert_eq!(track.clips[0].place.timeline_in_sec, 10.0);
    }

    // =========================================================================
    // ExtractEditCommand — BDD Tests
    // =========================================================================

    // Scenario: Extract removes content in range and closes gap
    //   Given clips at [0-10, 15-25, 30-40]
    //   When extract is called on range [12-28]
    //   Then clip at [0-10] unchanged
    //   And clip at [15-25] removed (fully covered)
    //   And clip at [30-40] shifts left by 16 to [14-24]
    #[test]
    fn extract_edit_should_remove_range_and_close_gap() {
        let mut state = create_test_state();
        let seq_id = state.active_sequence_id.clone().unwrap();
        let track_id = state.sequences[&seq_id].tracks[0].id.clone();

        place_clip(&mut state, &seq_id, &track_id, 0.0, 10.0);
        place_clip(&mut state, &seq_id, &track_id, 15.0, 10.0);
        place_clip(&mut state, &seq_id, &track_id, 30.0, 10.0);

        let clip_0_id = state.sequences[&seq_id].tracks[0].clips[0].id.clone();
        let clip_30_id = state.sequences[&seq_id].tracks[0].clips[2].id.clone();

        let mut cmd = ExtractEditCommand::new(&seq_id, &track_id, 12.0, 28.0);
        cmd.execute(&mut state).unwrap();

        let track = &state.sequences[&seq_id].tracks[0];

        // Clip at 0-10 unchanged
        let c0 = track.clips.iter().find(|c| c.id == clip_0_id).unwrap();
        assert_eq!(c0.place.timeline_in_sec, 0.0);
        assert_eq!(c0.place.duration_sec, 10.0);

        // Clip at 30-40 shifted left by 16 (extract_duration)
        let c30 = track.clips.iter().find(|c| c.id == clip_30_id).unwrap();
        assert_eq!(c30.place.timeline_in_sec, 14.0);
    }

    // Scenario: Extract undo restores all clips
    #[test]
    fn extract_edit_undo_should_restore_all_clips() {
        let mut state = create_test_state();
        let seq_id = state.active_sequence_id.clone().unwrap();
        let track_id = state.sequences[&seq_id].tracks[0].id.clone();

        place_clip(&mut state, &seq_id, &track_id, 0.0, 10.0);
        place_clip(&mut state, &seq_id, &track_id, 15.0, 10.0);
        place_clip(&mut state, &seq_id, &track_id, 30.0, 10.0);

        let clip_15_id = state.sequences[&seq_id].tracks[0].clips[1].id.clone();
        let clip_30_id = state.sequences[&seq_id].tracks[0].clips[2].id.clone();

        let mut cmd = ExtractEditCommand::new(&seq_id, &track_id, 12.0, 28.0);
        cmd.execute(&mut state).unwrap();

        cmd.undo(&mut state).unwrap();

        let track = &state.sequences[&seq_id].tracks[0];
        assert_eq!(track.clips.len(), 3);

        let c15 = track.clips.iter().find(|c| c.id == clip_15_id).unwrap();
        assert_eq!(c15.place.timeline_in_sec, 15.0);
        assert_eq!(c15.place.duration_sec, 10.0);

        let c30 = track.clips.iter().find(|c| c.id == clip_30_id).unwrap();
        assert_eq!(c30.place.timeline_in_sec, 30.0);
    }

    // Scenario: Extract with partial overlap trims clips and closes gap
    //   Given a clip at [0-30]
    //   When extract at range [10-20]
    //   Then left fragment [0-10] remains
    //   And right fragment shifts to [10-20] (was [20-30], shifted left by 10)
    #[test]
    fn extract_edit_should_handle_spanning_clip_with_ripple() {
        let mut state = create_test_state();
        let seq_id = state.active_sequence_id.clone().unwrap();
        let track_id = state.sequences[&seq_id].tracks[0].id.clone();

        place_clip(&mut state, &seq_id, &track_id, 0.0, 30.0);
        let original_id = state.sequences[&seq_id].tracks[0].clips[0].id.clone();

        let mut cmd = ExtractEditCommand::new(&seq_id, &track_id, 10.0, 20.0);
        cmd.execute(&mut state).unwrap();

        let track = &state.sequences[&seq_id].tracks[0];
        assert_eq!(track.clips.len(), 2);

        // Left fragment: [0-10]
        let left = track.clips.iter().find(|c| c.id == original_id).unwrap();
        assert_eq!(left.place.timeline_in_sec, 0.0);
        assert_eq!(left.place.duration_sec, 10.0);

        // Right fragment: shifted from [20-30] to [10-20]
        let right = track.clips.iter().find(|c| c.id != original_id).unwrap();
        assert_eq!(right.place.timeline_in_sec, 10.0);
        assert_eq!(right.place.duration_sec, 10.0);
        assert_eq!(right.range.source_in_sec, 20.0);
        assert_eq!(right.range.source_out_sec, 30.0);
    }

    #[test]
    fn extract_edit_should_preserve_caption_overrides_on_split_fragment() {
        let mut state = create_test_state();
        let seq_id = state.active_sequence_id.clone().unwrap();
        let track_id = state.sequences[&seq_id].tracks[0].id.clone();

        place_clip(&mut state, &seq_id, &track_id, 0.0, 30.0);
        let original_id = state.sequences[&seq_id].tracks[0].clips[0].id.clone();

        {
            let clip = state.sequences.get_mut(&seq_id).unwrap().tracks[0]
                .clips
                .iter_mut()
                .find(|clip| clip.id == original_id)
                .unwrap();
            clip.caption_style = Some(serde_json::json!({
                "fontFamily": "Open Sans",
                "fontSize": 42,
                "fontWeight": 700,
            }));
            clip.caption_position = Some(serde_json::json!({
                "x": 0.35,
                "y": 0.8,
            }));
        }

        let mut cmd = ExtractEditCommand::new(&seq_id, &track_id, 10.0, 20.0);
        cmd.execute(&mut state).unwrap();

        let track = &state.sequences[&seq_id].tracks[0];
        let fragment = track
            .clips
            .iter()
            .find(|clip| clip.id != original_id)
            .unwrap();

        assert_eq!(
            fragment.caption_style,
            Some(serde_json::json!({
                "fontFamily": "Open Sans",
                "fontSize": 42,
                "fontWeight": 700,
            }))
        );
        assert_eq!(
            fragment.caption_position,
            Some(serde_json::json!({
                "x": 0.35,
                "y": 0.8,
            }))
        );
    }

    // =========================================================================
    // Gap Management (S24-004)
    // =========================================================================

    /// Helper: creates a test state with 3 clips on a track with gaps between them.
    ///
    /// Layout: [0-5] ... [8-10] ... [15-20]
    /// Gaps:   [5-8] and [10-15]
    fn create_gapped_state() -> (ProjectState, String, String, Vec<String>) {
        let mut state = create_test_state();
        let seq_id = state.active_sequence_id.clone().unwrap();
        let track_id = state.sequences[&seq_id].tracks[0].id.clone();
        let asset_id = state.assets.keys().next().unwrap().clone();

        // Insert clips at non-overlapping positions to pass validation
        let positions = [0.0, 60.0, 120.0];
        let mut clip_ids = Vec::new();
        for &pos in &positions {
            let mut cmd = InsertClipCommand::new(&seq_id, &track_id, &asset_id, pos)
                .with_source_range(0.0, 5.0);
            let result = cmd.execute(&mut state).unwrap();
            clip_ids.push(result.created_ids[0].clone());
        }

        // Now reposition clips directly to create the desired gap layout
        let seq = state.sequences.get_mut(&seq_id).unwrap();
        let track = &mut seq.tracks[0];

        // Clip 0: [0-5]
        let c0 = track
            .clips
            .iter_mut()
            .find(|c| c.id == clip_ids[0])
            .unwrap();
        c0.place.timeline_in_sec = 0.0;
        c0.place.duration_sec = 5.0;
        c0.range.source_in_sec = 0.0;
        c0.range.source_out_sec = 5.0;

        // Clip 1: [8-10]
        let c1 = track
            .clips
            .iter_mut()
            .find(|c| c.id == clip_ids[1])
            .unwrap();
        c1.place.timeline_in_sec = 8.0;
        c1.place.duration_sec = 2.0;
        c1.range.source_in_sec = 0.0;
        c1.range.source_out_sec = 2.0;

        // Clip 2: [15-20]
        let c2 = track
            .clips
            .iter_mut()
            .find(|c| c.id == clip_ids[2])
            .unwrap();
        c2.place.timeline_in_sec = 15.0;
        c2.place.duration_sec = 5.0;
        c2.range.source_in_sec = 0.0;
        c2.range.source_out_sec = 5.0;

        sort_track_clips(track);

        (state, seq_id, track_id, clip_ids)
    }

    // -- find_gaps --

    #[test]
    fn find_gaps_should_return_all_gaps_when_clips_have_spaces_between_them() {
        // Given a track with clips [0-5], [8-10], [15-20]
        let (state, seq_id, track_id, _) = create_gapped_state();
        let track = &state.sequences[&seq_id]
            .tracks
            .iter()
            .find(|t| t.id == track_id)
            .unwrap();

        // When find_gaps is called
        let gaps = find_gaps(track);

        // Then it returns 2 gaps
        assert_eq!(gaps.len(), 2);
        assert!((gaps[0].start - 5.0).abs() < 1e-6);
        assert!((gaps[0].end - 8.0).abs() < 1e-6);
        assert!((gaps[0].duration - 3.0).abs() < 1e-6);
        assert!((gaps[1].start - 10.0).abs() < 1e-6);
        assert!((gaps[1].end - 15.0).abs() < 1e-6);
        assert!((gaps[1].duration - 5.0).abs() < 1e-6);
    }

    #[test]
    fn find_gaps_should_return_empty_when_clips_are_contiguous() {
        // Given a track with contiguous clips [0-5], [5-10]
        let mut state = create_test_state();
        let seq_id = state.active_sequence_id.clone().unwrap();
        let track_id = state.sequences[&seq_id].tracks[0].id.clone();
        let asset_id = state.assets.keys().next().unwrap().clone();

        let mut cmd1 =
            InsertClipCommand::new(&seq_id, &track_id, &asset_id, 0.0).with_source_range(0.0, 5.0);
        cmd1.execute(&mut state).unwrap();
        let mut cmd2 =
            InsertClipCommand::new(&seq_id, &track_id, &asset_id, 60.0).with_source_range(0.0, 5.0);
        cmd2.execute(&mut state).unwrap();

        let seq = state.sequences.get_mut(&seq_id).unwrap();
        let track = &mut seq.tracks[0];
        track.clips[0].place.timeline_in_sec = 0.0;
        track.clips[0].place.duration_sec = 5.0;
        track.clips[1].place.timeline_in_sec = 5.0;
        track.clips[1].place.duration_sec = 5.0;
        sort_track_clips(track);

        // When find_gaps is called
        let gaps = find_gaps(track);

        // Then no gaps are returned
        assert!(gaps.is_empty());
    }

    #[test]
    fn find_gaps_should_return_empty_when_track_has_no_clips() {
        let state = create_test_state();
        let seq_id = state.active_sequence_id.clone().unwrap();
        let track = &state.sequences[&seq_id].tracks[0];

        let gaps = find_gaps(track);
        assert!(gaps.is_empty());
    }

    // -- CloseGapCommand --

    #[test]
    fn close_gap_should_shift_downstream_clips_left_by_gap_duration() {
        // Given a track with clips [0-5], [8-10], [15-20] (gaps at [5-8] and [10-15])
        let (mut state, seq_id, track_id, clip_ids) = create_gapped_state();

        // When closing the first gap [5-8] (duration 3)
        let mut cmd = CloseGapCommand::new(&seq_id, &track_id, 5.0, 8.0);
        cmd.execute(&mut state).unwrap();

        // Then clip at [8-10] shifts to [5-7], clip at [15-20] shifts to [12-17]
        let track = &state.sequences[&seq_id]
            .tracks
            .iter()
            .find(|t| t.id == track_id)
            .unwrap();
        let c0 = track.clips.iter().find(|c| c.id == clip_ids[0]).unwrap();
        let c1 = track.clips.iter().find(|c| c.id == clip_ids[1]).unwrap();
        let c2 = track.clips.iter().find(|c| c.id == clip_ids[2]).unwrap();

        assert!((c0.place.timeline_in_sec - 0.0).abs() < 1e-6); // Unchanged
        assert!((c1.place.timeline_in_sec - 5.0).abs() < 1e-6); // Was 8, shifted by 3
        assert!((c2.place.timeline_in_sec - 12.0).abs() < 1e-6); // Was 15, shifted by 3
    }

    #[test]
    fn close_gap_undo_should_restore_original_positions() {
        // Given close_gap was executed
        let (mut state, seq_id, track_id, clip_ids) = create_gapped_state();
        let mut cmd = CloseGapCommand::new(&seq_id, &track_id, 5.0, 8.0);
        cmd.execute(&mut state).unwrap();

        // When undo is called
        cmd.undo(&mut state).unwrap();

        // Then all clips return to original positions
        let track = &state.sequences[&seq_id]
            .tracks
            .iter()
            .find(|t| t.id == track_id)
            .unwrap();
        let c0 = track.clips.iter().find(|c| c.id == clip_ids[0]).unwrap();
        let c1 = track.clips.iter().find(|c| c.id == clip_ids[1]).unwrap();
        let c2 = track.clips.iter().find(|c| c.id == clip_ids[2]).unwrap();

        assert!((c0.place.timeline_in_sec - 0.0).abs() < 1e-6);
        assert!((c1.place.timeline_in_sec - 8.0).abs() < 1e-6);
        assert!((c2.place.timeline_in_sec - 15.0).abs() < 1e-6);
    }

    #[test]
    fn close_gap_should_reject_when_no_gap_exists() {
        // Given clips at [0-5], [5-10] (contiguous, no gap)
        let mut state = create_test_state();
        let seq_id = state.active_sequence_id.clone().unwrap();
        let track_id = state.sequences[&seq_id].tracks[0].id.clone();
        let asset_id = state.assets.keys().next().unwrap().clone();

        let mut cmd1 =
            InsertClipCommand::new(&seq_id, &track_id, &asset_id, 0.0).with_source_range(0.0, 5.0);
        cmd1.execute(&mut state).unwrap();
        let mut cmd2 =
            InsertClipCommand::new(&seq_id, &track_id, &asset_id, 60.0).with_source_range(0.0, 5.0);
        cmd2.execute(&mut state).unwrap();

        let seq = state.sequences.get_mut(&seq_id).unwrap();
        let track = &mut seq.tracks[0];
        track.clips[0].place.timeline_in_sec = 0.0;
        track.clips[0].place.duration_sec = 5.0;
        track.clips[1].place.timeline_in_sec = 5.0;
        track.clips[1].place.duration_sec = 5.0;
        sort_track_clips(track);

        // When trying to close a gap at [3-7] (occupied by clips)
        let mut cmd = CloseGapCommand::new(&seq_id, &track_id, 3.0, 7.0);
        let result = cmd.execute(&mut state);

        // Then error is returned
        assert!(result.is_err());
    }

    // -- CloseAllGapsCommand --

    #[test]
    fn close_all_gaps_should_pack_clips_left_maintaining_order() {
        // Given a track with clips [0-5], [8-10], [15-20]
        let (mut state, seq_id, track_id, clip_ids) = create_gapped_state();

        // When close_all_gaps is executed
        let mut cmd = CloseAllGapsCommand::new(&seq_id, &track_id);
        cmd.execute(&mut state).unwrap();

        // Then clips become [0-5], [5-7], [7-12]
        let track = &state.sequences[&seq_id]
            .tracks
            .iter()
            .find(|t| t.id == track_id)
            .unwrap();
        let c0 = track.clips.iter().find(|c| c.id == clip_ids[0]).unwrap();
        let c1 = track.clips.iter().find(|c| c.id == clip_ids[1]).unwrap();
        let c2 = track.clips.iter().find(|c| c.id == clip_ids[2]).unwrap();

        assert!((c0.place.timeline_in_sec - 0.0).abs() < 1e-6);
        assert!((c0.place.duration_sec - 5.0).abs() < 1e-6);
        assert!((c1.place.timeline_in_sec - 5.0).abs() < 1e-6);
        assert!((c1.place.duration_sec - 2.0).abs() < 1e-6);
        assert!((c2.place.timeline_in_sec - 7.0).abs() < 1e-6);
        assert!((c2.place.duration_sec - 5.0).abs() < 1e-6);

        // Verify no gaps remain
        let gaps = find_gaps(track);
        assert!(gaps.is_empty());
    }

    #[test]
    fn close_all_gaps_undo_should_restore_all_original_positions() {
        // Given close_all_gaps was executed
        let (mut state, seq_id, track_id, clip_ids) = create_gapped_state();
        let mut cmd = CloseAllGapsCommand::new(&seq_id, &track_id);
        cmd.execute(&mut state).unwrap();

        // When undo is called
        cmd.undo(&mut state).unwrap();

        // Then all clips return to original positions
        let track = &state.sequences[&seq_id]
            .tracks
            .iter()
            .find(|t| t.id == track_id)
            .unwrap();
        let c0 = track.clips.iter().find(|c| c.id == clip_ids[0]).unwrap();
        let c1 = track.clips.iter().find(|c| c.id == clip_ids[1]).unwrap();
        let c2 = track.clips.iter().find(|c| c.id == clip_ids[2]).unwrap();

        assert!((c0.place.timeline_in_sec - 0.0).abs() < 1e-6);
        assert!((c1.place.timeline_in_sec - 8.0).abs() < 1e-6);
        assert!((c2.place.timeline_in_sec - 15.0).abs() < 1e-6);
    }

    #[test]
    fn close_all_gaps_should_be_noop_when_no_gaps_exist() {
        // Given a track with contiguous clips [0-5], [5-10]
        let mut state = create_test_state();
        let seq_id = state.active_sequence_id.clone().unwrap();
        let track_id = state.sequences[&seq_id].tracks[0].id.clone();
        let asset_id = state.assets.keys().next().unwrap().clone();

        let mut cmd1 =
            InsertClipCommand::new(&seq_id, &track_id, &asset_id, 0.0).with_source_range(0.0, 5.0);
        cmd1.execute(&mut state).unwrap();
        let mut cmd2 =
            InsertClipCommand::new(&seq_id, &track_id, &asset_id, 60.0).with_source_range(0.0, 5.0);
        cmd2.execute(&mut state).unwrap();

        let seq = state.sequences.get_mut(&seq_id).unwrap();
        let track = &mut seq.tracks[0];
        track.clips[0].place.timeline_in_sec = 0.0;
        track.clips[0].place.duration_sec = 5.0;
        track.clips[1].place.timeline_in_sec = 5.0;
        track.clips[1].place.duration_sec = 5.0;
        sort_track_clips(track);

        // When close_all_gaps is called
        let mut cmd = CloseAllGapsCommand::new(&seq_id, &track_id);
        let result = cmd.execute(&mut state).unwrap();

        // Then no clips are shifted (no changes)
        assert!(result.changes.is_empty());
    }

    #[test]
    fn close_gap_should_reject_locked_track() {
        let (mut state, seq_id, track_id, _) = create_gapped_state();

        // Lock the track
        let seq = state.sequences.get_mut(&seq_id).unwrap();
        let track = seq.tracks.iter_mut().find(|t| t.id == track_id).unwrap();
        track.locked = true;

        let mut cmd = CloseGapCommand::new(&seq_id, &track_id, 5.0, 8.0);
        let result = cmd.execute(&mut state);
        assert!(result.is_err());
    }

    // =========================================================================
    // ReverseClipCommand Tests (BDD-style)
    // =========================================================================

    #[test]
    fn should_toggle_reverse_flag_on_clip() {
        // Given a clip that is not reversed
        let mut state = create_test_state();
        let seq_id = state.active_sequence_id.clone().unwrap();
        let track_id = state.sequences[&seq_id].tracks[0].id.clone();
        let asset_id = state.assets.keys().next().unwrap().clone();

        let mut insert_cmd =
            InsertClipCommand::new(&seq_id, &track_id, &asset_id, 0.0).with_source_range(0.0, 10.0);
        insert_cmd.execute(&mut state).unwrap();
        let clip_id = state.sequences[&seq_id].tracks[0].clips[0].id.clone();
        assert!(!state.sequences[&seq_id].tracks[0].clips[0].reverse);

        // When toggling reverse
        let mut cmd = ReverseClipCommand::new(&seq_id, &track_id, &clip_id);
        cmd.execute(&mut state).unwrap();

        // Then the clip is reversed
        assert!(state.sequences[&seq_id].tracks[0].clips[0].reverse);
    }

    #[test]
    fn should_toggle_reverse_back_on_second_execute() {
        // Given a reversed clip
        let mut state = create_test_state();
        let seq_id = state.active_sequence_id.clone().unwrap();
        let track_id = state.sequences[&seq_id].tracks[0].id.clone();
        let asset_id = state.assets.keys().next().unwrap().clone();

        let mut insert_cmd =
            InsertClipCommand::new(&seq_id, &track_id, &asset_id, 0.0).with_source_range(0.0, 10.0);
        insert_cmd.execute(&mut state).unwrap();
        let clip_id = state.sequences[&seq_id].tracks[0].clips[0].id.clone();

        let mut cmd1 = ReverseClipCommand::new(&seq_id, &track_id, &clip_id);
        cmd1.execute(&mut state).unwrap();
        assert!(state.sequences[&seq_id].tracks[0].clips[0].reverse);

        // When toggling again
        let mut cmd2 = ReverseClipCommand::new(&seq_id, &track_id, &clip_id);
        cmd2.execute(&mut state).unwrap();

        // Then the clip is back to normal
        assert!(!state.sequences[&seq_id].tracks[0].clips[0].reverse);
    }

    #[test]
    fn should_undo_reverse_clip() {
        // Given a clip that was reversed
        let mut state = create_test_state();
        let seq_id = state.active_sequence_id.clone().unwrap();
        let track_id = state.sequences[&seq_id].tracks[0].id.clone();
        let asset_id = state.assets.keys().next().unwrap().clone();

        let mut insert_cmd =
            InsertClipCommand::new(&seq_id, &track_id, &asset_id, 0.0).with_source_range(0.0, 10.0);
        insert_cmd.execute(&mut state).unwrap();
        let clip_id = state.sequences[&seq_id].tracks[0].clips[0].id.clone();

        let mut cmd = ReverseClipCommand::new(&seq_id, &track_id, &clip_id);
        cmd.execute(&mut state).unwrap();
        assert!(state.sequences[&seq_id].tracks[0].clips[0].reverse);

        // When undoing
        cmd.undo(&mut state).unwrap();

        // Then reverse is restored to original
        assert!(!state.sequences[&seq_id].tracks[0].clips[0].reverse);
    }

    #[test]
    fn should_reject_reverse_clip_on_locked_track() {
        let mut state = create_test_state();
        let seq_id = state.active_sequence_id.clone().unwrap();
        let track_id = state.sequences[&seq_id].tracks[0].id.clone();
        let asset_id = state.assets.keys().next().unwrap().clone();

        let mut insert_cmd =
            InsertClipCommand::new(&seq_id, &track_id, &asset_id, 0.0).with_source_range(0.0, 10.0);
        insert_cmd.execute(&mut state).unwrap();
        let clip_id = state.sequences[&seq_id].tracks[0].clips[0].id.clone();
        state.sequences.get_mut(&seq_id).unwrap().tracks[0].locked = true;

        let mut cmd = ReverseClipCommand::new(&seq_id, &track_id, &clip_id);
        let err = cmd.execute(&mut state).unwrap_err();
        assert!(matches!(err, CoreError::ValidationError(_)));
        assert!(err.to_string().contains("locked"));
    }

    // =========================================================================
    // CreateFreezeFrameCommand Tests (BDD-style)
    // =========================================================================

    #[test]
    fn should_create_freeze_frame_at_playhead() {
        // Given a clip at 0-10s on the timeline
        let mut state = create_test_state();
        let seq_id = state.active_sequence_id.clone().unwrap();
        let track_id = state.sequences[&seq_id].tracks[0].id.clone();
        let asset_id = state.assets.keys().next().unwrap().clone();

        let mut insert_cmd =
            InsertClipCommand::new(&seq_id, &track_id, &asset_id, 0.0).with_source_range(0.0, 10.0);
        insert_cmd.execute(&mut state).unwrap();
        let clip_id = state.sequences[&seq_id].tracks[0].clips[0].id.clone();

        // When creating a freeze frame inside the clip
        let mut cmd = CreateFreezeFrameCommand::new(&seq_id, &track_id, &clip_id, 5.0, 2.0);
        let result = cmd.execute(&mut state).unwrap();

        // Then the source clip is split and the freeze frame is inserted at the playhead
        assert_eq!(result.created_ids.len(), 1);
        let freeze_id = &result.created_ids[0];
        let clips = &state.sequences[&seq_id].tracks[0].clips;
        assert_eq!(clips.len(), 3);

        let left_clip = clips.iter().find(|c| c.id == clip_id).unwrap();
        let freeze_clip = clips.iter().find(|c| c.id == *freeze_id).unwrap();
        let right_clip = clips
            .iter()
            .find(|c| c.id != clip_id && c.id != *freeze_id)
            .unwrap();

        assert_eq!(left_clip.range.source_in_sec, 0.0);
        assert_eq!(left_clip.range.source_out_sec, 5.0);
        assert_eq!(left_clip.place.timeline_in_sec, 0.0);
        assert_eq!(left_clip.place.duration_sec, 5.0);
        assert!(freeze_clip.freeze_frame);
        assert_eq!(freeze_clip.place.duration_sec, 2.0);
        assert_eq!(freeze_clip.place.timeline_in_sec, 5.0);
        assert!(freeze_clip.audio.muted);
        assert!((freeze_clip.range.source_in_sec - 5.0).abs() < 1e-6);
        assert!((freeze_clip.range.source_out_sec - 5.016_667).abs() < 1e-5);

        assert_eq!(right_clip.range.source_in_sec, 5.0);
        assert_eq!(right_clip.range.source_out_sec, 10.0);
        assert_eq!(right_clip.place.timeline_in_sec, 7.0);
        assert_eq!(right_clip.place.duration_sec, 5.0);
    }

    #[test]
    fn should_undo_freeze_frame_creation() {
        // Given a clip at 0-10s with freeze frame inserted at 5-7s
        let mut state = create_test_state();
        let seq_id = state.active_sequence_id.clone().unwrap();
        let track_id = state.sequences[&seq_id].tracks[0].id.clone();
        let asset_id = state.assets.keys().next().unwrap().clone();

        let mut insert_cmd =
            InsertClipCommand::new(&seq_id, &track_id, &asset_id, 0.0).with_source_range(0.0, 10.0);
        insert_cmd.execute(&mut state).unwrap();
        let clip_id = state.sequences[&seq_id].tracks[0].clips[0].id.clone();

        let mut cmd = CreateFreezeFrameCommand::new(&seq_id, &track_id, &clip_id, 5.0, 2.0);
        cmd.execute(&mut state).unwrap();
        assert_eq!(state.sequences[&seq_id].tracks[0].clips.len(), 3);

        // When undoing
        cmd.undo(&mut state).unwrap();

        // Then the freeze frame clip is removed and the source clip is restored
        assert_eq!(state.sequences[&seq_id].tracks[0].clips.len(), 1);
        let restored = &state.sequences[&seq_id].tracks[0].clips[0];
        assert_eq!(restored.id, clip_id);
        assert_eq!(restored.range.source_in_sec, 0.0);
        assert_eq!(restored.range.source_out_sec, 10.0);
        assert_eq!(restored.place.timeline_in_sec, 0.0);
        assert_eq!(restored.place.duration_sec, 10.0);
    }

    #[test]
    fn should_clamp_freeze_frame_to_last_visible_frame_at_clip_end() {
        let mut state = create_test_state();
        let seq_id = state.active_sequence_id.clone().unwrap();
        let track_id = state.sequences[&seq_id].tracks[0].id.clone();
        let asset_id = state.assets.keys().next().unwrap().clone();

        let mut insert_cmd =
            InsertClipCommand::new(&seq_id, &track_id, &asset_id, 0.0).with_source_range(0.0, 10.0);
        insert_cmd.execute(&mut state).unwrap();
        let clip_id = state.sequences[&seq_id].tracks[0].clips[0].id.clone();

        let mut cmd = CreateFreezeFrameCommand::new(&seq_id, &track_id, &clip_id, 10.0, 2.0);
        let result = cmd.execute(&mut state).unwrap();

        let freeze_id = &result.created_ids[0];
        let freeze_clip = state.sequences[&seq_id].tracks[0]
            .clips
            .iter()
            .find(|c| c.id == *freeze_id)
            .unwrap();

        assert!((freeze_clip.range.source_in_sec - 9.966_667).abs() < 1e-5);
        assert!((freeze_clip.range.source_out_sec - 9.983_333).abs() < 1e-5);
    }

    #[test]
    fn should_clone_source_styling_when_creating_freeze_frame() {
        let mut state = create_test_state();
        let seq_id = state.active_sequence_id.clone().unwrap();
        let track_id = state.sequences[&seq_id].tracks[0].id.clone();
        let asset_id = state.assets.keys().next().unwrap().clone();

        let mut insert_cmd =
            InsertClipCommand::new(&seq_id, &track_id, &asset_id, 0.0).with_source_range(0.0, 10.0);
        insert_cmd.execute(&mut state).unwrap();
        let clip_id = state.sequences[&seq_id].tracks[0].clips[0].id.clone();

        {
            let clip = &mut state.sequences.get_mut(&seq_id).unwrap().tracks[0].clips[0];
            clip.transform.position = Point2D::new(0.25, 0.75);
            clip.transform.scale = Point2D::new(1.5, 0.8);
            clip.opacity = 0.6;
            clip.blend_mode = BlendMode::Screen;
            clip.effects = vec!["effect_1".to_string(), "effect_2".to_string()];
            clip.color = Some(Color::rgb(0.1, 0.2, 0.3));
            clip.time_remap = Some(linear_time_remap_curve(&[(0.0, 0.0), (10.0, 10.0)]));
        }

        let mut cmd = CreateFreezeFrameCommand::new(&seq_id, &track_id, &clip_id, 5.0, 2.0);
        let result = cmd.execute(&mut state).unwrap();
        let freeze_id = &result.created_ids[0];
        let freeze_clip = state.sequences[&seq_id].tracks[0]
            .clips
            .iter()
            .find(|clip| clip.id == *freeze_id)
            .unwrap();

        assert_eq!(freeze_clip.transform.position, Point2D::new(0.25, 0.75));
        assert_eq!(freeze_clip.transform.scale, Point2D::new(1.5, 0.8));
        assert_eq!(freeze_clip.opacity, 0.6);
        assert_eq!(freeze_clip.blend_mode, BlendMode::Screen);
        assert_eq!(
            freeze_clip.effects,
            vec!["effect_1".to_string(), "effect_2".to_string()]
        );
        assert_eq!(freeze_clip.color, Some(Color::rgb(0.1, 0.2, 0.3)));
        assert!(freeze_clip.time_remap.is_none());
    }

    #[test]
    fn should_reject_freeze_frame_on_locked_track() {
        let mut state = create_test_state();
        let seq_id = state.active_sequence_id.clone().unwrap();
        let track_id = state.sequences[&seq_id].tracks[0].id.clone();
        let asset_id = state.assets.keys().next().unwrap().clone();

        let mut insert_cmd =
            InsertClipCommand::new(&seq_id, &track_id, &asset_id, 0.0).with_source_range(0.0, 10.0);
        insert_cmd.execute(&mut state).unwrap();
        let clip_id = state.sequences[&seq_id].tracks[0].clips[0].id.clone();
        state.sequences.get_mut(&seq_id).unwrap().tracks[0].locked = true;

        let mut cmd = CreateFreezeFrameCommand::new(&seq_id, &track_id, &clip_id, 5.0, 2.0);
        let err = cmd.execute(&mut state).unwrap_err();
        assert!(matches!(err, CoreError::ValidationError(_)));
        assert!(err.to_string().contains("locked"));
    }

    #[test]
    fn should_reject_freeze_frame_outside_clip_range() {
        // Given a clip from 0-10s
        let mut state = create_test_state();
        let seq_id = state.active_sequence_id.clone().unwrap();
        let track_id = state.sequences[&seq_id].tracks[0].id.clone();
        let asset_id = state.assets.keys().next().unwrap().clone();

        let mut insert_cmd =
            InsertClipCommand::new(&seq_id, &track_id, &asset_id, 0.0).with_source_range(0.0, 10.0);
        insert_cmd.execute(&mut state).unwrap();
        let clip_id = state.sequences[&seq_id].tracks[0].clips[0].id.clone();

        // When creating freeze frame at 15.0 (outside clip range 0-10)
        let mut cmd = CreateFreezeFrameCommand::new(&seq_id, &track_id, &clip_id, 15.0, 2.0);
        let result = cmd.execute(&mut state);

        // Then it should fail
        assert!(result.is_err());
    }

    #[test]
    fn should_reject_freeze_frame_with_invalid_duration() {
        let mut state = create_test_state();
        let seq_id = state.active_sequence_id.clone().unwrap();
        let track_id = state.sequences[&seq_id].tracks[0].id.clone();
        let asset_id = state.assets.keys().next().unwrap().clone();

        let mut insert_cmd =
            InsertClipCommand::new(&seq_id, &track_id, &asset_id, 0.0).with_source_range(0.0, 10.0);
        insert_cmd.execute(&mut state).unwrap();
        let clip_id = state.sequences[&seq_id].tracks[0].clips[0].id.clone();

        // When creating freeze frame with zero duration
        let mut cmd = CreateFreezeFrameCommand::new(&seq_id, &track_id, &clip_id, 5.0, 0.0);
        let result = cmd.execute(&mut state);

        // Then it should fail
        assert!(result.is_err());
    }

    #[test]
    fn should_reject_set_time_remap_on_locked_track() {
        let mut state = create_test_state();
        let seq_id = state.active_sequence_id.clone().unwrap();
        let track_id = state.sequences[&seq_id].tracks[0].id.clone();
        let asset_id = state.assets.keys().next().unwrap().clone();

        let mut insert_cmd =
            InsertClipCommand::new(&seq_id, &track_id, &asset_id, 0.0).with_source_range(0.0, 4.0);
        insert_cmd.execute(&mut state).unwrap();
        let clip_id = state.sequences[&seq_id].tracks[0].clips[0].id.clone();
        state.sequences.get_mut(&seq_id).unwrap().tracks[0].locked = true;

        let mut cmd = SetTimeRemapCommand::new(
            &seq_id,
            &track_id,
            &clip_id,
            linear_time_remap_curve(&[(0.0, 0.0), (2.0, 4.0)]),
        );
        let err = cmd.execute(&mut state).unwrap_err();
        assert!(matches!(err, CoreError::ValidationError(_)));
        assert!(err.to_string().contains("locked"));
    }

    #[test]
    fn should_reject_clear_time_remap_on_locked_track() {
        let mut state = create_test_state();
        let seq_id = state.active_sequence_id.clone().unwrap();
        let track_id = state.sequences[&seq_id].tracks[0].id.clone();
        let asset_id = state.assets.keys().next().unwrap().clone();

        let mut insert_cmd =
            InsertClipCommand::new(&seq_id, &track_id, &asset_id, 0.0).with_source_range(0.0, 4.0);
        insert_cmd.execute(&mut state).unwrap();
        let clip_id = state.sequences[&seq_id].tracks[0].clips[0].id.clone();
        {
            let clip = &mut state.sequences.get_mut(&seq_id).unwrap().tracks[0].clips[0];
            clip.time_remap = Some(linear_time_remap_curve(&[(0.0, 0.0), (2.0, 4.0)]));
            clip.place.duration_sec = 2.0;
        }
        state.sequences.get_mut(&seq_id).unwrap().tracks[0].locked = true;

        let mut cmd = ClearTimeRemapCommand::new(&seq_id, &track_id, &clip_id);
        let err = cmd.execute(&mut state).unwrap_err();
        assert!(matches!(err, CoreError::ValidationError(_)));
        assert!(err.to_string().contains("locked"));
    }

    // =========================================================================
    // AddAudioKeyframeCommand Tests
    // =========================================================================

    /// Creates a test state with a single 10-second clip on a video track.
    fn create_audio_keyframe_test_state() -> (ProjectState, String, String, String) {
        let mut state = create_test_state();
        let seq_id = state.active_sequence_id.clone().unwrap();
        let track_id = state.sequences[&seq_id].tracks[0].id.clone();
        let asset_id = state.assets.keys().next().unwrap().clone();

        let mut cmd =
            InsertClipCommand::new(&seq_id, &track_id, &asset_id, 0.0).with_source_range(0.0, 10.0);
        cmd.execute(&mut state).unwrap();
        let clip_id = state.sequences[&seq_id].tracks[0].clips[0].id.clone();

        (state, seq_id, track_id, clip_id)
    }

    #[test]
    fn add_audio_keyframe_should_create_automation_point_at_given_time() {
        // Given a clip with no volume keyframes
        let (mut state, seq_id, track_id, clip_id) = create_audio_keyframe_test_state();

        // When adding a keyframe at 2.0s with -6dB
        let mut cmd = AddAudioKeyframeCommand::new(
            &seq_id,
            &track_id,
            &clip_id,
            2.0,
            -6.0,
            KeyframeInterpolation::Linear,
        );
        cmd.execute(&mut state).unwrap();

        // Then the clip should have 1 keyframe at the correct position
        let clip = &state.sequences[&seq_id].tracks[0].clips[0];
        assert_eq!(clip.audio.volume_keyframes.len(), 1);
        assert!((clip.audio.volume_keyframes[0].time_offset - 2.0).abs() < 1e-9);
        assert!((clip.audio.volume_keyframes[0].value_db - (-6.0)).abs() < 1e-9);
    }

    #[test]
    fn add_audio_keyframe_should_maintain_sorted_order() {
        // Given a clip
        let (mut state, seq_id, track_id, clip_id) = create_audio_keyframe_test_state();

        // When adding keyframes out of order: 5.0s, 1.0s, 3.0s
        for (time, db) in [(5.0, 0.0), (1.0, -12.0), (3.0, -6.0)] {
            let mut cmd = AddAudioKeyframeCommand::new(
                &seq_id,
                &track_id,
                &clip_id,
                time,
                db,
                KeyframeInterpolation::Linear,
            );
            cmd.execute(&mut state).unwrap();
        }

        // Then keyframes should be sorted by time_offset
        let kfs = &state.sequences[&seq_id].tracks[0].clips[0]
            .audio
            .volume_keyframes;
        assert_eq!(kfs.len(), 3);
        assert!((kfs[0].time_offset - 1.0).abs() < 1e-9);
        assert!((kfs[1].time_offset - 3.0).abs() < 1e-9);
        assert!((kfs[2].time_offset - 5.0).abs() < 1e-9);
    }

    #[test]
    fn add_audio_keyframe_should_reject_time_beyond_clip_duration() {
        // Given a 10-second clip
        let (mut state, seq_id, track_id, clip_id) = create_audio_keyframe_test_state();

        // When adding a keyframe at 15.0s (beyond clip duration)
        let mut cmd = AddAudioKeyframeCommand::new(
            &seq_id,
            &track_id,
            &clip_id,
            15.0,
            0.0,
            KeyframeInterpolation::Linear,
        );
        let result = cmd.execute(&mut state);

        // Then it should fail
        assert!(result.is_err());
    }

    #[test]
    fn add_audio_keyframe_should_clamp_value_to_valid_range() {
        // Given a clip
        let (mut state, seq_id, track_id, clip_id) = create_audio_keyframe_test_state();

        // When adding a keyframe with value_db = +20.0 (beyond max of +6.0)
        let mut cmd = AddAudioKeyframeCommand::new(
            &seq_id,
            &track_id,
            &clip_id,
            1.0,
            20.0,
            KeyframeInterpolation::Linear,
        );
        cmd.execute(&mut state).unwrap();

        // Then value should be clamped to MAX_CLIP_VOLUME_DB
        let kf = &state.sequences[&seq_id].tracks[0].clips[0]
            .audio
            .volume_keyframes[0];
        assert!((kf.value_db - 6.0).abs() < 1e-9);
    }

    #[test]
    fn add_audio_keyframe_undo_should_remove_the_added_keyframe() {
        // Given a clip with an added keyframe
        let (mut state, seq_id, track_id, clip_id) = create_audio_keyframe_test_state();
        let mut cmd = AddAudioKeyframeCommand::new(
            &seq_id,
            &track_id,
            &clip_id,
            2.0,
            -6.0,
            KeyframeInterpolation::Linear,
        );
        cmd.execute(&mut state).unwrap();
        assert_eq!(
            state.sequences[&seq_id].tracks[0].clips[0]
                .audio
                .volume_keyframes
                .len(),
            1
        );

        // When undoing
        cmd.undo(&mut state).unwrap();

        // Then the keyframe should be removed
        assert_eq!(
            state.sequences[&seq_id].tracks[0].clips[0]
                .audio
                .volume_keyframes
                .len(),
            0
        );
    }

    // =========================================================================
    // RemoveAudioKeyframeCommand Tests
    // =========================================================================

    #[test]
    fn remove_audio_keyframe_should_delete_keyframe_at_index() {
        // Given a clip with 3 keyframes
        let (mut state, seq_id, track_id, clip_id) = create_audio_keyframe_test_state();
        for (time, db) in [(0.0, -12.0), (5.0, -6.0), (9.0, 0.0)] {
            let mut cmd = AddAudioKeyframeCommand::new(
                &seq_id,
                &track_id,
                &clip_id,
                time,
                db,
                KeyframeInterpolation::Linear,
            );
            cmd.execute(&mut state).unwrap();
        }

        // When removing keyframe at index 1 (the -6dB one at 5.0s)
        let mut cmd = RemoveAudioKeyframeCommand::new(&seq_id, &track_id, &clip_id, 1);
        cmd.execute(&mut state).unwrap();

        // Then only 2 keyframes should remain
        let kfs = &state.sequences[&seq_id].tracks[0].clips[0]
            .audio
            .volume_keyframes;
        assert_eq!(kfs.len(), 2);
        assert!((kfs[0].time_offset - 0.0).abs() < 1e-9);
        assert!((kfs[1].time_offset - 9.0).abs() < 1e-9);
    }

    #[test]
    fn remove_audio_keyframe_undo_should_restore_deleted_keyframe() {
        // Given a clip with 2 keyframes, one removed
        let (mut state, seq_id, track_id, clip_id) = create_audio_keyframe_test_state();
        for (time, db) in [(0.0, -12.0), (5.0, 0.0)] {
            let mut cmd = AddAudioKeyframeCommand::new(
                &seq_id,
                &track_id,
                &clip_id,
                time,
                db,
                KeyframeInterpolation::Linear,
            );
            cmd.execute(&mut state).unwrap();
        }
        let mut cmd = RemoveAudioKeyframeCommand::new(&seq_id, &track_id, &clip_id, 0);
        cmd.execute(&mut state).unwrap();
        assert_eq!(
            state.sequences[&seq_id].tracks[0].clips[0]
                .audio
                .volume_keyframes
                .len(),
            1
        );

        // When undoing
        cmd.undo(&mut state).unwrap();

        // Then the removed keyframe should be restored
        let kfs = &state.sequences[&seq_id].tracks[0].clips[0]
            .audio
            .volume_keyframes;
        assert_eq!(kfs.len(), 2);
        assert!((kfs[0].value_db - (-12.0)).abs() < 1e-9);
    }

    #[test]
    fn remove_audio_keyframe_should_reject_out_of_bounds_index() {
        // Given a clip with 1 keyframe
        let (mut state, seq_id, track_id, clip_id) = create_audio_keyframe_test_state();
        let mut add_cmd = AddAudioKeyframeCommand::new(
            &seq_id,
            &track_id,
            &clip_id,
            0.0,
            0.0,
            KeyframeInterpolation::Linear,
        );
        add_cmd.execute(&mut state).unwrap();

        // When removing at index 5 (out of bounds)
        let mut cmd = RemoveAudioKeyframeCommand::new(&seq_id, &track_id, &clip_id, 5);
        let result = cmd.execute(&mut state);

        // Then it should fail
        assert!(result.is_err());
    }

    // =========================================================================
    // MoveAudioKeyframeCommand Tests
    // =========================================================================

    #[test]
    fn move_audio_keyframe_should_update_time_offset() {
        // Given a clip with a keyframe at 2.0s
        let (mut state, seq_id, track_id, clip_id) = create_audio_keyframe_test_state();
        let mut add_cmd = AddAudioKeyframeCommand::new(
            &seq_id,
            &track_id,
            &clip_id,
            2.0,
            -6.0,
            KeyframeInterpolation::Linear,
        );
        add_cmd.execute(&mut state).unwrap();

        // When moving keyframe to 7.0s
        let mut cmd = MoveAudioKeyframeCommand::new(&seq_id, &track_id, &clip_id, 0, 7.0);
        cmd.execute(&mut state).unwrap();

        // Then keyframe should be at new time
        let kf = &state.sequences[&seq_id].tracks[0].clips[0]
            .audio
            .volume_keyframes[0];
        assert!((kf.time_offset - 7.0).abs() < 1e-9);
        assert!((kf.value_db - (-6.0)).abs() < 1e-9); // Value unchanged
    }

    #[test]
    fn move_audio_keyframe_undo_should_restore_original_time() {
        // Given a moved keyframe
        let (mut state, seq_id, track_id, clip_id) = create_audio_keyframe_test_state();
        let mut add_cmd = AddAudioKeyframeCommand::new(
            &seq_id,
            &track_id,
            &clip_id,
            2.0,
            -6.0,
            KeyframeInterpolation::Linear,
        );
        add_cmd.execute(&mut state).unwrap();
        let mut cmd = MoveAudioKeyframeCommand::new(&seq_id, &track_id, &clip_id, 0, 7.0);
        cmd.execute(&mut state).unwrap();

        // When undoing
        cmd.undo(&mut state).unwrap();

        // Then keyframe should be back at 2.0s
        let kf = &state.sequences[&seq_id].tracks[0].clips[0]
            .audio
            .volume_keyframes[0];
        assert!((kf.time_offset - 2.0).abs() < 1e-9);
    }

    // =========================================================================
    // SetAudioKeyframeValueCommand Tests
    // =========================================================================

    #[test]
    fn set_audio_keyframe_value_should_update_volume_db() {
        // Given a clip with a keyframe at -6dB
        let (mut state, seq_id, track_id, clip_id) = create_audio_keyframe_test_state();
        let mut add_cmd = AddAudioKeyframeCommand::new(
            &seq_id,
            &track_id,
            &clip_id,
            2.0,
            -6.0,
            KeyframeInterpolation::Linear,
        );
        add_cmd.execute(&mut state).unwrap();

        // When setting value to -12dB
        let mut cmd =
            SetAudioKeyframeValueCommand::new(&seq_id, &track_id, &clip_id, 0, -12.0, None);
        cmd.execute(&mut state).unwrap();

        // Then keyframe value should be updated
        let kf = &state.sequences[&seq_id].tracks[0].clips[0]
            .audio
            .volume_keyframes[0];
        assert!((kf.value_db - (-12.0)).abs() < 1e-9);
        assert_eq!(kf.interpolation, KeyframeInterpolation::Linear); // Unchanged
    }

    #[test]
    fn set_audio_keyframe_value_should_update_interpolation_when_provided() {
        // Given a clip with a linear keyframe
        let (mut state, seq_id, track_id, clip_id) = create_audio_keyframe_test_state();
        let mut add_cmd = AddAudioKeyframeCommand::new(
            &seq_id,
            &track_id,
            &clip_id,
            2.0,
            -6.0,
            KeyframeInterpolation::Linear,
        );
        add_cmd.execute(&mut state).unwrap();

        // When setting value with Hold interpolation
        let mut cmd = SetAudioKeyframeValueCommand::new(
            &seq_id,
            &track_id,
            &clip_id,
            0,
            -6.0,
            Some(KeyframeInterpolation::Hold),
        );
        cmd.execute(&mut state).unwrap();

        // Then interpolation should be updated
        let kf = &state.sequences[&seq_id].tracks[0].clips[0]
            .audio
            .volume_keyframes[0];
        assert_eq!(kf.interpolation, KeyframeInterpolation::Hold);
    }

    #[test]
    fn set_audio_keyframe_value_undo_should_restore_previous_value() {
        // Given a keyframe whose value was changed
        let (mut state, seq_id, track_id, clip_id) = create_audio_keyframe_test_state();
        let mut add_cmd = AddAudioKeyframeCommand::new(
            &seq_id,
            &track_id,
            &clip_id,
            2.0,
            -6.0,
            KeyframeInterpolation::Linear,
        );
        add_cmd.execute(&mut state).unwrap();
        let mut cmd = SetAudioKeyframeValueCommand::new(
            &seq_id,
            &track_id,
            &clip_id,
            0,
            -18.0,
            Some(KeyframeInterpolation::Hold),
        );
        cmd.execute(&mut state).unwrap();

        // When undoing
        cmd.undo(&mut state).unwrap();

        // Then both value and interpolation should be restored
        let kf = &state.sequences[&seq_id].tracks[0].clips[0]
            .audio
            .volume_keyframes[0];
        assert!((kf.value_db - (-6.0)).abs() < 1e-9);
        assert_eq!(kf.interpolation, KeyframeInterpolation::Linear);
    }

    // =========================================================================
    // SetAudioFadeInCommand Tests
    // =========================================================================

    #[test]
    fn test_set_audio_fade_in_applies_duration_and_type() {
        let (mut state, seq_id, track_id, clip_id) = create_test_state_with_clip();
        let mut cmd =
            SetAudioFadeInCommand::new(&seq_id, &track_id, &clip_id, 1.5, FadeType::ConstantPower);

        cmd.execute(&mut state).unwrap();

        let clip = &state.sequences[&seq_id].tracks[0].clips[0];
        assert!((clip.audio.fade_in_sec - 1.5).abs() < 1e-9);
        assert_eq!(clip.audio.fade_in_type, FadeType::ConstantPower);
    }

    #[test]
    fn test_set_audio_fade_in_clamps_to_clip_duration() {
        let (mut state, seq_id, track_id, clip_id) = create_test_state_with_clip();
        // Clip duration is ~10s (source 0-10, speed 1)
        let mut cmd =
            SetAudioFadeInCommand::new(&seq_id, &track_id, &clip_id, 20.0, FadeType::Linear);

        cmd.execute(&mut state).unwrap();

        let clip = &state.sequences[&seq_id].tracks[0].clips[0];
        assert!(clip.audio.fade_in_sec <= clip.duration() + 0.001);
    }

    #[test]
    fn test_set_audio_fade_in_reduces_fade_out_on_overflow() {
        let (mut state, seq_id, track_id, clip_id) = create_test_state_with_clip();
        // Set fade_out first
        state.sequences.get_mut(&seq_id).unwrap().tracks[0].clips[0]
            .audio
            .fade_out_sec = 8.0;

        let mut cmd =
            SetAudioFadeInCommand::new(&seq_id, &track_id, &clip_id, 5.0, FadeType::Linear);
        cmd.execute(&mut state).unwrap();

        let clip = &state.sequences[&seq_id].tracks[0].clips[0];
        let clip_dur = clip.duration();
        assert!(clip.audio.fade_in_sec + clip.audio.fade_out_sec <= clip_dur + 0.001);
    }

    #[test]
    fn test_set_audio_fade_in_undo_restores_previous() {
        let (mut state, seq_id, track_id, clip_id) = create_test_state_with_clip();
        let mut cmd =
            SetAudioFadeInCommand::new(&seq_id, &track_id, &clip_id, 2.0, FadeType::Exponential);

        cmd.execute(&mut state).unwrap();
        assert!(
            (state.sequences[&seq_id].tracks[0].clips[0]
                .audio
                .fade_in_sec
                - 2.0)
                .abs()
                < 1e-9
        );

        cmd.undo(&mut state).unwrap();
        assert!(
            (state.sequences[&seq_id].tracks[0].clips[0]
                .audio
                .fade_in_sec
                - 0.0)
                .abs()
                < 1e-9
        );
        assert_eq!(
            state.sequences[&seq_id].tracks[0].clips[0]
                .audio
                .fade_in_type,
            FadeType::Linear
        );
    }

    #[test]
    fn test_set_audio_fade_in_rejects_negative_duration() {
        let (mut state, seq_id, track_id, clip_id) = create_test_state_with_clip();
        let mut cmd =
            SetAudioFadeInCommand::new(&seq_id, &track_id, &clip_id, -1.0, FadeType::Linear);

        let result = cmd.execute(&mut state);
        assert!(result.is_err());
    }

    // =========================================================================
    // SetAudioFadeOutCommand Tests
    // =========================================================================

    #[test]
    fn test_set_audio_fade_out_applies_duration_and_type() {
        let (mut state, seq_id, track_id, clip_id) = create_test_state_with_clip();
        let mut cmd =
            SetAudioFadeOutCommand::new(&seq_id, &track_id, &clip_id, 2.5, FadeType::SCurve);

        cmd.execute(&mut state).unwrap();

        let clip = &state.sequences[&seq_id].tracks[0].clips[0];
        assert!((clip.audio.fade_out_sec - 2.5).abs() < 1e-9);
        assert_eq!(clip.audio.fade_out_type, FadeType::SCurve);
    }

    #[test]
    fn test_set_audio_fade_out_undo_restores_previous() {
        let (mut state, seq_id, track_id, clip_id) = create_test_state_with_clip();
        let mut cmd =
            SetAudioFadeOutCommand::new(&seq_id, &track_id, &clip_id, 3.0, FadeType::ConstantGain);

        cmd.execute(&mut state).unwrap();
        cmd.undo(&mut state).unwrap();

        let clip = &state.sequences[&seq_id].tracks[0].clips[0];
        assert!((clip.audio.fade_out_sec - 0.0).abs() < 1e-9);
        assert_eq!(clip.audio.fade_out_type, FadeType::Linear);
    }

    // =========================================================================
    // FadeType FFmpeg Mapping Tests
    // =========================================================================

    #[test]
    fn test_fade_type_to_ffmpeg_type() {
        assert_eq!(FadeType::Linear.to_ffmpeg_type(), "tri");
        assert_eq!(FadeType::ConstantGain.to_ffmpeg_type(), "tri");
        assert_eq!(FadeType::ConstantPower.to_ffmpeg_type(), "qsin");
        assert_eq!(FadeType::Exponential.to_ffmpeg_type(), "exp");
        assert_eq!(FadeType::SCurve.to_ffmpeg_type(), "cub");
    }

    // =========================================================================
    // SetClipEnabledCommand Tests
    // =========================================================================

    #[test]
    fn test_set_clip_enabled_should_disable_clip_when_enabled_is_false() {
        // Given a clip that is enabled (default)
        let (mut state, seq_id, track_id, clip_id) = create_test_state_with_clip();
        assert!(state.sequences[&seq_id].tracks[0].clips[0].enabled);

        // When SetClipEnabledCommand is executed with enabled=false
        let mut cmd = SetClipEnabledCommand::new(&seq_id, &track_id, &clip_id, false);
        let result = cmd.execute(&mut state);

        // Then the command succeeds and the clip's enabled field should be false
        assert!(result.is_ok());
        assert!(!state.sequences[&seq_id].tracks[0].clips[0].enabled);
    }

    #[test]
    fn test_set_clip_enabled_should_enable_clip_when_previously_disabled() {
        // Given a clip that is disabled (enabled=false)
        let (mut state, seq_id, track_id, clip_id) = create_test_state_with_clip();
        state.sequences.get_mut(&seq_id).unwrap().tracks[0].clips[0].enabled = false;
        assert!(!state.sequences[&seq_id].tracks[0].clips[0].enabled);

        // When SetClipEnabledCommand is executed with enabled=true
        let mut cmd = SetClipEnabledCommand::new(&seq_id, &track_id, &clip_id, true);
        let result = cmd.execute(&mut state);

        // Then the clip's enabled field should be true
        assert!(result.is_ok());
        assert!(state.sequences[&seq_id].tracks[0].clips[0].enabled);
    }

    #[test]
    fn test_set_clip_enabled_undo_should_restore_previous_state() {
        // Given a clip that was disabled via command
        let (mut state, seq_id, track_id, clip_id) = create_test_state_with_clip();
        assert!(state.sequences[&seq_id].tracks[0].clips[0].enabled);

        let mut cmd = SetClipEnabledCommand::new(&seq_id, &track_id, &clip_id, false);
        cmd.execute(&mut state).unwrap();
        assert!(!state.sequences[&seq_id].tracks[0].clips[0].enabled);

        // When undo is called
        cmd.undo(&mut state).unwrap();

        // Then the clip's enabled field should be restored to true
        assert!(state.sequences[&seq_id].tracks[0].clips[0].enabled);
    }

    #[test]
    fn test_set_clip_enabled_should_reject_locked_track() {
        // Given a track that is locked
        let (mut state, seq_id, track_id, clip_id) = create_test_state_with_clip();
        state.sequences.get_mut(&seq_id).unwrap().tracks[0].locked = true;

        // When SetClipEnabledCommand is executed
        let mut cmd = SetClipEnabledCommand::new(&seq_id, &track_id, &clip_id, false);
        let err = cmd.execute(&mut state).unwrap_err();

        // Then it should return an error
        assert!(matches!(err, CoreError::ValidationError(_)));
        assert!(err.to_string().contains("locked"));
    }

    #[test]
    fn test_set_clip_enabled_should_persist_through_json_serialization() {
        // Given a clip with enabled=false
        let (mut state, seq_id, track_id, clip_id) = create_test_state_with_clip();
        let mut cmd = SetClipEnabledCommand::new(&seq_id, &track_id, &clip_id, false);
        cmd.execute(&mut state).unwrap();

        let clip = &state.sequences[&seq_id].tracks[0].clips[0];
        assert!(!clip.enabled);

        // When serialized to JSON and deserialized
        let json = serde_json::to_string(clip).unwrap();
        let deserialized: crate::core::timeline::Clip = serde_json::from_str(&json).unwrap();

        // Then the enabled field should remain false
        assert!(!deserialized.enabled);
    }

    // =========================================================================
    // LinkClipsCommand tests
    // =========================================================================

    fn create_test_state_with_video_and_audio_tracks() -> (ProjectState, String, String, String) {
        let mut state = ProjectState::new("Test Project");

        let asset =
            Asset::new_video("video.mp4", "/video.mp4", VideoInfo::default()).with_duration(60.0);
        state.assets.insert(asset.id.clone(), asset.clone());

        let mut sequence = Sequence::new("Main", SequenceFormat::youtube_1080());
        let video_track = Track::new("Video 1", TrackKind::Video);
        let audio_track = Track::new_audio("Audio 1");
        let video_track_id = video_track.id.clone();
        let audio_track_id = audio_track.id.clone();
        sequence.tracks.push(video_track);
        sequence.tracks.push(audio_track);
        state.active_sequence_id = Some(sequence.id.clone());
        let seq_id = sequence.id.clone();
        state.sequences.insert(sequence.id.clone(), sequence);

        // Insert clip on video track
        let asset_id = asset.id.clone();
        let mut insert_v = InsertClipCommand::new(&seq_id, &video_track_id, &asset_id, 0.0);
        insert_v.execute(&mut state).unwrap();

        // Insert clip on audio track
        let mut insert_a = InsertClipCommand::new(&seq_id, &audio_track_id, &asset_id, 0.0);
        insert_a.execute(&mut state).unwrap();

        let v_clip_id = state.sequences[&seq_id].tracks[0].clips[0].id.clone();
        let a_clip_id = state.sequences[&seq_id].tracks[1].clips[0].id.clone();

        // Return IDs: (state, seq_id, video_track_id, audio_track_id)
        // We store clip IDs via state lookup
        let _ = (v_clip_id, a_clip_id);
        (state, seq_id, video_track_id, audio_track_id)
    }

    fn create_test_state_with_video_and_empty_audio_track() -> (ProjectState, String, String, String) {
        let mut state = ProjectState::new("Test Project");

        let asset =
            Asset::new_video("video.mp4", "/video.mp4", VideoInfo::default()).with_duration(60.0);
        state.assets.insert(asset.id.clone(), asset.clone());

        let mut sequence = Sequence::new("Main", SequenceFormat::youtube_1080());
        let video_track = Track::new("Video 1", TrackKind::Video);
        let audio_track = Track::new_audio("Audio 1");
        let video_track_id = video_track.id.clone();
        let audio_track_id = audio_track.id.clone();
        sequence.tracks.push(video_track);
        sequence.tracks.push(audio_track);
        state.active_sequence_id = Some(sequence.id.clone());
        let seq_id = sequence.id.clone();
        state.sequences.insert(sequence.id.clone(), sequence);

        let asset_id = asset.id.clone();
        let mut insert_v = InsertClipCommand::new(&seq_id, &video_track_id, &asset_id, 0.0);
        insert_v.execute(&mut state).unwrap();

        (state, seq_id, video_track_id, audio_track_id)
    }

    #[test]
    fn test_link_clips_should_set_shared_link_group_id() {
        // Given two clips on different tracks
        let (mut state, seq_id, v_track_id, a_track_id) =
            create_test_state_with_video_and_audio_tracks();
        let v_clip_id = state.sequences[&seq_id].tracks[0].clips[0].id.clone();
        let a_clip_id = state.sequences[&seq_id].tracks[1].clips[0].id.clone();

        // When LinkClips command is executed
        let mut cmd = LinkClipsCommand::new(
            &seq_id,
            vec![
                (v_track_id.clone(), v_clip_id.clone()),
                (a_track_id.clone(), a_clip_id.clone()),
            ],
        );
        let result = cmd.execute(&mut state);

        // Then both clips should share the same link_group_id
        assert!(result.is_ok());
        let v_clip = &state.sequences[&seq_id].tracks[0].clips[0];
        let a_clip = &state.sequences[&seq_id].tracks[1].clips[0];
        assert!(v_clip.link_group_id.is_some());
        assert_eq!(v_clip.link_group_id, a_clip.link_group_id);
    }

    #[test]
    fn test_link_clips_should_reject_fewer_than_two_clips() {
        // Given a single clip reference
        let (mut state, seq_id, v_track_id, _) =
            create_test_state_with_video_and_audio_tracks();
        let v_clip_id = state.sequences[&seq_id].tracks[0].clips[0].id.clone();

        // When LinkClips is executed with only 1 clip
        let mut cmd = LinkClipsCommand::new(
            &seq_id,
            vec![(v_track_id.clone(), v_clip_id.clone())],
        );
        let result = cmd.execute(&mut state);

        // Then it should return a validation error
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("at least 2"));
    }

    #[test]
    fn test_link_clips_should_reject_locked_track() {
        // Given a locked track
        let (mut state, seq_id, v_track_id, a_track_id) =
            create_test_state_with_video_and_audio_tracks();
        let v_clip_id = state.sequences[&seq_id].tracks[0].clips[0].id.clone();
        let a_clip_id = state.sequences[&seq_id].tracks[1].clips[0].id.clone();
        state.sequences.get_mut(&seq_id).unwrap().tracks[0].locked = true;

        // When LinkClips is executed
        let mut cmd = LinkClipsCommand::new(
            &seq_id,
            vec![
                (v_track_id.clone(), v_clip_id.clone()),
                (a_track_id.clone(), a_clip_id.clone()),
            ],
        );
        let result = cmd.execute(&mut state);

        // Then it should return an error about locked track
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("locked"));
    }

    #[test]
    fn test_link_clips_undo_should_restore_previous_link_state() {
        // Given two clips that were linked
        let (mut state, seq_id, v_track_id, a_track_id) =
            create_test_state_with_video_and_audio_tracks();
        let v_clip_id = state.sequences[&seq_id].tracks[0].clips[0].id.clone();
        let a_clip_id = state.sequences[&seq_id].tracks[1].clips[0].id.clone();

        let mut cmd = LinkClipsCommand::new(
            &seq_id,
            vec![
                (v_track_id.clone(), v_clip_id.clone()),
                (a_track_id.clone(), a_clip_id.clone()),
            ],
        );
        cmd.execute(&mut state).unwrap();
        assert!(state.sequences[&seq_id].tracks[0].clips[0].link_group_id.is_some());

        // When undo is called
        cmd.undo(&mut state).unwrap();

        // Then both clips should have their original link_group_id (None)
        assert!(state.sequences[&seq_id].tracks[0].clips[0].link_group_id.is_none());
        assert!(state.sequences[&seq_id].tracks[1].clips[0].link_group_id.is_none());
    }

    // =========================================================================
    // UnlinkClipsCommand tests
    // =========================================================================

    #[test]
    fn test_unlink_clips_should_mark_clips_as_explicitly_unlinked() {
        // Given two linked clips
        let (mut state, seq_id, v_track_id, a_track_id) =
            create_test_state_with_video_and_audio_tracks();
        let v_clip_id = state.sequences[&seq_id].tracks[0].clips[0].id.clone();
        let a_clip_id = state.sequences[&seq_id].tracks[1].clips[0].id.clone();

        let mut link_cmd = LinkClipsCommand::new(
            &seq_id,
            vec![
                (v_track_id.clone(), v_clip_id.clone()),
                (a_track_id.clone(), a_clip_id.clone()),
            ],
        );
        link_cmd.execute(&mut state).unwrap();

        // When UnlinkClips is executed
        let mut unlink_cmd = UnlinkClipsCommand::new(
            &seq_id,
            vec![
                (v_track_id.clone(), v_clip_id.clone()),
                (a_track_id.clone(), a_clip_id.clone()),
            ],
        );
        let result = unlink_cmd.execute(&mut state);

        // Then both clips should carry the explicit unlink sentinel
        assert!(result.is_ok());
        assert_eq!(
            state.sequences[&seq_id].tracks[0].clips[0]
                .link_group_id
                .as_deref(),
            Some(EXPLICIT_UNLINK_SENTINEL)
        );
        assert_eq!(
            state.sequences[&seq_id].tracks[1].clips[0]
                .link_group_id
                .as_deref(),
            Some(EXPLICIT_UNLINK_SENTINEL)
        );
    }

    #[test]
    fn test_unlink_clips_undo_should_restore_link_group_id() {
        // Given two clips that were linked, then unlinked
        let (mut state, seq_id, v_track_id, a_track_id) =
            create_test_state_with_video_and_audio_tracks();
        let v_clip_id = state.sequences[&seq_id].tracks[0].clips[0].id.clone();
        let a_clip_id = state.sequences[&seq_id].tracks[1].clips[0].id.clone();

        let mut link_cmd = LinkClipsCommand::new(
            &seq_id,
            vec![
                (v_track_id.clone(), v_clip_id.clone()),
                (a_track_id.clone(), a_clip_id.clone()),
            ],
        );
        link_cmd.execute(&mut state).unwrap();
        let link_group = state.sequences[&seq_id].tracks[0].clips[0].link_group_id.clone();

        let mut unlink_cmd = UnlinkClipsCommand::new(
            &seq_id,
            vec![
                (v_track_id.clone(), v_clip_id.clone()),
                (a_track_id.clone(), a_clip_id.clone()),
            ],
        );
        unlink_cmd.execute(&mut state).unwrap();

        // When undo is called
        unlink_cmd.undo(&mut state).unwrap();

        // Then the link_group_id should be restored
        assert_eq!(state.sequences[&seq_id].tracks[0].clips[0].link_group_id, link_group);
        assert_eq!(state.sequences[&seq_id].tracks[1].clips[0].link_group_id, link_group);
    }

    #[test]
    fn test_link_clips_should_explicitly_unlink_orphaned_previous_group_members() {
        let (mut state, seq_id, v_track_id, a_track_id) =
            create_test_state_with_video_and_audio_tracks();
        let asset_id = state.assets.keys().next().unwrap().clone();

        let second_audio_track = Track::new_audio("Audio 2");
        let second_audio_track_id = second_audio_track.id.clone();
        state
            .sequences
            .get_mut(&seq_id)
            .unwrap()
            .tracks
            .push(second_audio_track);

        let mut insert_second_audio =
            InsertClipCommand::new(&seq_id, &second_audio_track_id, &asset_id, 12.0);
        insert_second_audio.execute(&mut state).unwrap();

        let v_clip_id = state.sequences[&seq_id].tracks[0].clips[0].id.clone();
        let first_audio_clip_id = state.sequences[&seq_id].tracks[1].clips[0].id.clone();
        let second_audio_clip_id = state.sequences[&seq_id].tracks[2].clips[0].id.clone();

        let mut initial_link = LinkClipsCommand::new(
            &seq_id,
            vec![
                (v_track_id.clone(), v_clip_id.clone()),
                (a_track_id.clone(), first_audio_clip_id.clone()),
            ],
        );
        initial_link.execute(&mut state).unwrap();

        let mut relink = LinkClipsCommand::new(
            &seq_id,
            vec![
                (v_track_id.clone(), v_clip_id.clone()),
                (second_audio_track_id.clone(), second_audio_clip_id.clone()),
            ],
        );
        relink.execute(&mut state).unwrap();

        assert_eq!(
            state.sequences[&seq_id].tracks[1].clips[0]
                .link_group_id
                .as_deref(),
            Some(EXPLICIT_UNLINK_SENTINEL)
        );
        assert_eq!(
            state.sequences[&seq_id].tracks[0].clips[0].link_group_id,
            state.sequences[&seq_id].tracks[2].clips[0].link_group_id
        );
    }

    // =========================================================================
    // DetachAudioCommand tests
    // =========================================================================

    #[test]
    fn test_detach_audio_should_create_audio_clip_on_audio_track() {
        // Given a clip on a video track
        let (mut state, seq_id, v_track_id, a_track_id) =
            create_test_state_with_video_and_empty_audio_track();
        let v_clip_id = state.sequences[&seq_id].tracks[0].clips[0].id.clone();

        // When DetachAudio is executed
        let mut cmd = DetachAudioCommand::new(
            &seq_id,
            &v_track_id,
            &v_clip_id,
            Some(a_track_id.clone()),
        );
        let result = cmd.execute(&mut state);

        // Then a new audio clip should exist on the audio track
        assert!(result.is_ok());
        let result = result.unwrap();
        assert_eq!(result.created_ids.len(), 1);

        let audio_track = &state.sequences[&seq_id].tracks[1];
        assert_eq!(audio_track.clips.len(), 1);

        let new_clip = audio_track.clips.iter().find(|c| c.id == result.created_ids[0]).unwrap();
        let source_clip = &state.sequences[&seq_id].tracks[0].clips[0];
        assert_eq!(new_clip.asset_id, source_clip.asset_id);
        assert_eq!(new_clip.place.timeline_in_sec, source_clip.place.timeline_in_sec);
    }

    #[test]
    fn test_detach_audio_should_reject_audio_track_source() {
        // Given a clip on an audio track
        let (mut state, seq_id, _, a_track_id) =
            create_test_state_with_video_and_audio_tracks();
        let a_clip_id = state.sequences[&seq_id].tracks[1].clips[0].id.clone();

        // When DetachAudio is executed on an audio track clip
        let mut cmd = DetachAudioCommand::new(&seq_id, &a_track_id, &a_clip_id, None);
        let result = cmd.execute(&mut state);

        // Then it should return a validation error
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("video/overlay"));
    }

    #[test]
    fn test_detach_audio_should_create_audio_track_when_none_exists() {
        // Given a state with only a video track
        let (mut state, seq_id, track_id, _clip_id) = create_test_state_with_clip();
        let clip_id = state.sequences[&seq_id].tracks[0].clips[0].id.clone();

        // When DetachAudio is executed with no target audio track
        let mut cmd = DetachAudioCommand::new(&seq_id, &track_id, &clip_id, None);
        let result = cmd.execute(&mut state);

        // Then a new audio track should be created with the detached clip
        assert!(result.is_ok());
        let seq = &state.sequences[&seq_id];
        assert!(seq.tracks.len() >= 2);
        let audio_track = seq.tracks.iter().find(|t| t.kind == TrackKind::Audio).unwrap();
        assert_eq!(audio_track.clips.len(), 1);
        assert_eq!(audio_track.name, "Audio (Detached)");
    }

    #[test]
    fn test_detach_audio_should_mark_source_clip_as_explicitly_unlinked() {
        // Given a linked video clip
        let (mut state, seq_id, v_track_id, a_track_id) =
            create_test_state_with_video_and_audio_tracks();
        let v_clip_id = state.sequences[&seq_id].tracks[0].clips[0].id.clone();
        let a_clip_id = state.sequences[&seq_id].tracks[1].clips[0].id.clone();

        // First link the clips
        let mut link_cmd = LinkClipsCommand::new(
            &seq_id,
            vec![
                (v_track_id.clone(), v_clip_id.clone()),
                (a_track_id.clone(), a_clip_id.clone()),
            ],
        );
        link_cmd.execute(&mut state).unwrap();
        assert!(state.sequences[&seq_id].tracks[0].clips[0].link_group_id.is_some());

        // When DetachAudio is executed
        let mut cmd = DetachAudioCommand::new(
            &seq_id,
            &v_track_id,
            &v_clip_id,
            None,
        );
        cmd.execute(&mut state).unwrap();

        // Then the source clip's link_group_id should carry the explicit unlink sentinel
        assert_eq!(
            state.sequences[&seq_id].tracks[0].clips[0]
                .link_group_id
                .as_deref(),
            Some(EXPLICIT_UNLINK_SENTINEL)
        );
    }

    #[test]
    fn test_detach_audio_should_mark_created_audio_clip_as_explicitly_unlinked() {
        // Given a clip on a video track
        let (mut state, seq_id, v_track_id, a_track_id) =
            create_test_state_with_video_and_empty_audio_track();
        let v_clip_id = state.sequences[&seq_id].tracks[0].clips[0].id.clone();

        // When DetachAudio is executed
        let mut cmd = DetachAudioCommand::new(
            &seq_id,
            &v_track_id,
            &v_clip_id,
            Some(a_track_id.clone()),
        );
        let result = cmd.execute(&mut state).unwrap();
        let created_clip_id = result.created_ids[0].clone();

        // Then the detached clip should not participate in implicit linking
        let created_clip = state.sequences[&seq_id].tracks[1]
            .clips
            .iter()
            .find(|clip| clip.id == created_clip_id)
            .unwrap();
        assert_eq!(
            created_clip.link_group_id.as_deref(),
            Some(EXPLICIT_UNLINK_SENTINEL)
        );
    }

    #[test]
    fn test_detach_audio_undo_should_remove_audio_clip_and_restore_link() {
        // Given a detached audio clip
        let (mut state, seq_id, v_track_id, a_track_id) =
            create_test_state_with_video_and_audio_tracks();
        let v_clip_id = state.sequences[&seq_id].tracks[0].clips[0].id.clone();

        // Link first, then detach
        let a_clip_id = state.sequences[&seq_id].tracks[1].clips[0].id.clone();
        let mut link_cmd = LinkClipsCommand::new(
            &seq_id,
            vec![
                (v_track_id.clone(), v_clip_id.clone()),
                (a_track_id.clone(), a_clip_id.clone()),
            ],
        );
        link_cmd.execute(&mut state).unwrap();
        let original_link = state.sequences[&seq_id].tracks[0].clips[0].link_group_id.clone();

        let mut cmd = DetachAudioCommand::new(
            &seq_id,
            &v_track_id,
            &v_clip_id,
            None,
        );
        cmd.execute(&mut state).unwrap();
        let created_track_id = cmd.created_audio_track_id.clone().unwrap();

        // When undo is called
        cmd.undo(&mut state).unwrap();

        // Then the created audio track and clip should be removed
        assert!(state.sequences[&seq_id]
            .tracks
            .iter()
            .find(|track| track.id == created_track_id)
            .is_none());

        // And the source clip's link_group_id should be restored
        assert_eq!(
            state.sequences[&seq_id].tracks[0].clips[0].link_group_id,
            original_link
        );
    }

    #[test]
    fn test_detach_audio_should_explicitly_unlink_existing_companion_clip() {
        let (mut state, seq_id, v_track_id, a_track_id) =
            create_test_state_with_video_and_audio_tracks();
        let v_clip_id = state.sequences[&seq_id].tracks[0].clips[0].id.clone();
        let a_clip_id = state.sequences[&seq_id].tracks[1].clips[0].id.clone();

        let mut link_cmd = LinkClipsCommand::new(
            &seq_id,
            vec![
                (v_track_id.clone(), v_clip_id.clone()),
                (a_track_id.clone(), a_clip_id.clone()),
            ],
        );
        link_cmd.execute(&mut state).unwrap();

        let mut detach_cmd = DetachAudioCommand::new(&seq_id, &v_track_id, &v_clip_id, None);
        detach_cmd.execute(&mut state).unwrap();

        assert_eq!(
            state.sequences[&seq_id].tracks[1].clips[0]
                .link_group_id
                .as_deref(),
            Some(EXPLICIT_UNLINK_SENTINEL)
        );
    }

    #[test]
    fn test_link_group_id_should_persist_through_json_serialization() {
        // Given a clip with a link_group_id
        let (mut state, seq_id, v_track_id, a_track_id) =
            create_test_state_with_video_and_audio_tracks();
        let v_clip_id = state.sequences[&seq_id].tracks[0].clips[0].id.clone();
        let a_clip_id = state.sequences[&seq_id].tracks[1].clips[0].id.clone();

        let mut cmd = LinkClipsCommand::new(
            &seq_id,
            vec![
                (v_track_id.clone(), v_clip_id.clone()),
                (a_track_id.clone(), a_clip_id.clone()),
            ],
        );
        cmd.execute(&mut state).unwrap();

        let clip = &state.sequences[&seq_id].tracks[0].clips[0];
        let original_link = clip.link_group_id.clone();

        // When serialized to JSON and deserialized
        let json = serde_json::to_string(clip).unwrap();
        let deserialized: crate::core::timeline::Clip = serde_json::from_str(&json).unwrap();

        // Then the link_group_id should be preserved
        assert_eq!(deserialized.link_group_id, original_link);
    }

    #[test]
    fn test_detach_audio_should_copy_audio_settings() {
        // Given a video clip with custom audio settings
        let (mut state, seq_id, v_track_id, a_track_id) =
            create_test_state_with_video_and_empty_audio_track();
        let v_clip_id = state.sequences[&seq_id].tracks[0].clips[0].id.clone();

        // Set custom audio settings on the source clip
        state.sequences.get_mut(&seq_id).unwrap().tracks[0].clips[0].audio.volume_db = -6.0;
        state.sequences.get_mut(&seq_id).unwrap().tracks[0].clips[0].audio.pan = 0.5;

        // When DetachAudio is executed
        let mut cmd = DetachAudioCommand::new(
            &seq_id,
            &v_track_id,
            &v_clip_id,
            Some(a_track_id.clone()),
        );
        let result = cmd.execute(&mut state).unwrap();

        // Then the new audio clip should have the same audio settings
        let new_clip_id = &result.created_ids[0];
        let audio_track = &state.sequences[&seq_id].tracks[1];
        let new_clip = audio_track.clips.iter().find(|c| &c.id == new_clip_id).unwrap();
        assert_eq!(new_clip.audio.volume_db, -6.0);
        assert_eq!(new_clip.audio.pan, 0.5);
    }

    #[test]
    fn test_link_clips_should_reject_duplicate_clip_refs() {
        // Given the same clip ref provided twice
        let (mut state, seq_id, v_track_id, _) =
            create_test_state_with_video_and_audio_tracks();
        let v_clip_id = state.sequences[&seq_id].tracks[0].clips[0].id.clone();

        // When LinkClips is executed with duplicate refs
        let mut cmd = LinkClipsCommand::new(
            &seq_id,
            vec![
                (v_track_id.clone(), v_clip_id.clone()),
                (v_track_id.clone(), v_clip_id.clone()),
            ],
        );
        let result = cmd.execute(&mut state);

        // Then it should return a validation error (deduped to 1 distinct ref)
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("2 distinct"));
    }

    #[test]
    fn test_detach_audio_should_reject_overlap_on_target_track() {
        // Given an audio track that already has a clip at the same time position
        let (mut state, seq_id, v_track_id, a_track_id) =
            create_test_state_with_video_and_audio_tracks();
        let v_clip_id = state.sequences[&seq_id].tracks[0].clips[0].id.clone();

        // Audio track already has a clip at position 0.0 (from setup)
        // When DetachAudio tries to create another clip at the same position
        let mut cmd = DetachAudioCommand::new(
            &seq_id,
            &v_track_id,
            &v_clip_id,
            Some(a_track_id.clone()),
        );
        let result = cmd.execute(&mut state);

        // Then it should return an overlap error
        assert!(result.is_err());
        let err_msg = result.unwrap_err().to_string();
        assert!(
            err_msg.contains("overlap") || err_msg.contains("Overlap"),
            "Expected overlap error, got: {}",
            err_msg
        );
    }

    #[test]
    fn test_detach_audio_should_copy_time_remap() {
        // Given a video clip with time remap
        let (mut state, seq_id, v_track_id, _) =
            create_test_state_with_video_and_audio_tracks();
        let v_clip_id = state.sequences[&seq_id].tracks[0].clips[0].id.clone();

        // Set time remap on source clip
        let time_remap = linear_time_remap_curve(&[(0.0, 0.0), (2.0, 4.0)]);
        state.sequences.get_mut(&seq_id).unwrap().tracks[0].clips[0].time_remap =
            Some(time_remap.clone());

        // When DetachAudio is executed (use auto-create track to avoid overlap)
        let mut cmd = DetachAudioCommand::new(&seq_id, &v_track_id, &v_clip_id, None);
        let result = cmd.execute(&mut state).unwrap();

        // Then the new audio clip should have the same time remap
        let new_clip_id = &result.created_ids[0];
        let seq = &state.sequences[&seq_id];
        let audio_track = seq.tracks.iter().find(|t| t.kind == TrackKind::Audio && !t.clips.is_empty() && t.clips.iter().any(|c| &c.id == new_clip_id)).unwrap();
        let new_clip = audio_track.clips.iter().find(|c| &c.id == new_clip_id).unwrap();
        assert!(new_clip.time_remap.is_some());
        assert_eq!(new_clip.time_remap.as_ref().unwrap().keyframes.len(), 2);
    }

    // ── BDD: ApplyAudioDuckingCommand ──────────────────────────────

    #[test]
    fn should_apply_duck_keyframes_to_music_clip() {
        // Given a state with a video and audio track
        let (mut state, seq_id, _, audio_track_id) =
            create_test_state_with_video_and_audio_tracks();
        let clip_id = state.sequences[&seq_id].tracks[1].clips[0].id.clone();

        // And pre-computed duck keyframes
        let keyframes = vec![
            AudioKeyframe::new(0.0, 0.0, KeyframeInterpolation::Linear),
            AudioKeyframe::new(4.8, 0.0, KeyframeInterpolation::Linear),
            AudioKeyframe::new(5.0, -15.0, KeyframeInterpolation::Linear),
            AudioKeyframe::new(10.0, -15.0, KeyframeInterpolation::Linear),
            AudioKeyframe::new(10.5, 0.0, KeyframeInterpolation::Linear),
        ];

        // When ApplyAudioDucking is executed
        let mut cmd =
            ApplyAudioDuckingCommand::new(&seq_id, &audio_track_id, &clip_id, keyframes.clone());
        let result = cmd.execute(&mut state);

        // Then the command succeeds
        assert!(result.is_ok());

        // And the clip now has the duck keyframes
        let clip = &state.sequences[&seq_id].tracks[1].clips[0];
        assert_eq!(clip.audio.volume_keyframes.len(), 5);
        assert!((clip.audio.volume_keyframes[2].value_db - (-15.0)).abs() < 0.01);
    }

    #[test]
    fn should_undo_ducking_and_restore_previous_keyframes() {
        // Given a clip with existing keyframes
        let (mut state, seq_id, _, audio_track_id) =
            create_test_state_with_video_and_audio_tracks();
        let clip_id = state.sequences[&seq_id].tracks[1].clips[0].id.clone();

        // Set some existing keyframes first
        let original_kfs = vec![
            AudioKeyframe::new(0.0, -6.0, KeyframeInterpolation::Linear),
            AudioKeyframe::new(30.0, -6.0, KeyframeInterpolation::Linear),
        ];
        state.sequences.get_mut(&seq_id).unwrap().tracks[1].clips[0]
            .audio
            .volume_keyframes = original_kfs.clone();

        // When ducking is applied
        let duck_kfs = vec![
            AudioKeyframe::new(0.0, -6.0, KeyframeInterpolation::Linear),
            AudioKeyframe::new(5.0, -21.0, KeyframeInterpolation::Linear),
            AudioKeyframe::new(10.0, -6.0, KeyframeInterpolation::Linear),
        ];
        let mut cmd =
            ApplyAudioDuckingCommand::new(&seq_id, &audio_track_id, &clip_id, duck_kfs);
        cmd.execute(&mut state).unwrap();

        // And then undone
        cmd.undo(&mut state).unwrap();

        // Then the original keyframes are restored
        let clip = &state.sequences[&seq_id].tracks[1].clips[0];
        assert_eq!(clip.audio.volume_keyframes.len(), 2);
        assert!((clip.audio.volume_keyframes[0].value_db - (-6.0)).abs() < 0.01);
    }

    #[test]
    fn should_reject_ducking_on_locked_track() {
        // Given a locked audio track
        let (mut state, seq_id, _, audio_track_id) =
            create_test_state_with_video_and_audio_tracks();
        let clip_id = state.sequences[&seq_id].tracks[1].clips[0].id.clone();
        state.sequences.get_mut(&seq_id).unwrap().tracks[1].locked = true;

        // When ApplyAudioDucking is attempted
        let keyframes = vec![
            AudioKeyframe::new(0.0, 0.0, KeyframeInterpolation::Linear),
            AudioKeyframe::new(5.0, -15.0, KeyframeInterpolation::Linear),
        ];
        let mut cmd =
            ApplyAudioDuckingCommand::new(&seq_id, &audio_track_id, &clip_id, keyframes);
        let result = cmd.execute(&mut state);

        // Then it fails
        assert!(result.is_err());
    }

    #[test]
    fn should_fail_when_clip_not_found() {
        let (mut state, seq_id, _, audio_track_id) =
            create_test_state_with_video_and_audio_tracks();

        let mut cmd = ApplyAudioDuckingCommand::new(
            &seq_id,
            &audio_track_id,
            "nonexistent-clip",
            vec![],
        );
        let result = cmd.execute(&mut state);
        assert!(result.is_err());
    }

    #[test]
    fn should_apply_empty_keyframes_to_clear_automation() {
        // Given a clip with existing keyframes
        let (mut state, seq_id, _, audio_track_id) =
            create_test_state_with_video_and_audio_tracks();
        let clip_id = state.sequences[&seq_id].tracks[1].clips[0].id.clone();
        state.sequences.get_mut(&seq_id).unwrap().tracks[1].clips[0]
            .audio
            .volume_keyframes = vec![
            AudioKeyframe::new(0.0, 0.0, KeyframeInterpolation::Linear),
            AudioKeyframe::new(10.0, -15.0, KeyframeInterpolation::Linear),
        ];

        // When ducking is applied with empty keyframes
        let mut cmd =
            ApplyAudioDuckingCommand::new(&seq_id, &audio_track_id, &clip_id, vec![]);
        cmd.execute(&mut state).unwrap();

        // Then keyframes are cleared
        let clip = &state.sequences[&seq_id].tracks[1].clips[0];
        assert!(clip.audio.volume_keyframes.is_empty());
    }
}
