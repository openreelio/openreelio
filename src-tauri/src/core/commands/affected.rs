//! Affected time ranges — the stretch of timeline a command actually changed.
//!
//! A [`CommandResult`](crate::core::commands::CommandResult) names the ids it
//! touched, which tells a caller *what* changed but never *where*. An agent
//! that has just moved a clip, added a dissolve or dropped a marker still has
//! to know which seconds of the timeline are worth rendering and looking at.
//!
//! This module answers that by diffing the target sequence across the command,
//! rather than trusting the reported changes alone: a ripple edit shifts clips
//! the change list never mentions, and only a full clip-by-clip diff catches
//! them. The reported changes are then folded in on top, because some of them
//! move nothing — a caption retitled in place, an effect updated, a marker
//! dropped — and a diff alone would report those as no change at all.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::core::{
    commands::StateChange,
    effects::Effect,
    project::ProjectState,
    timeline::{transition_span_sec, Sequence},
    EffectId, TimeRange, TimeSec,
};

/// Tolerance for treating two times as the same instant (1 microsecond).
///
/// The same epsilon the timeline uses for edit-point deduplication, so ranges
/// merge exactly where boundaries are considered coincident elsewhere.
const TIME_EPSILON: f64 = 1e-6;

// =============================================================================
// Range computation
// =============================================================================

/// Computes the timeline ranges a command changed, as a sorted, merged union.
///
/// The union covers:
/// - every clip whose timeline span differs between `before` and `after`, or
///   which only exists in one of them — both its old and its new span. All
///   clips on all tracks are compared by id, so ripple shifts that `changes`
///   never lists are still reported;
/// - the before and after span of any clip named by a caption or clip change,
///   which catches an in-place edit (new words, same span) the diff cannot see;
/// - for an effect change, the owning clip's span in whichever state holds the
///   effect — or, for a two-input transition, the stretch it blends across,
///   centred on the cut rather than on any clip boundary;
/// - a zero-length range at the time of any created or deleted marker;
/// - the whole timeline for a track-level or sequence-level change, because
///   muting, hiding, removing or reordering a track can alter every frame.
///
/// Ranges are merged when they overlap or touch within a microsecond, so the
/// result is disjoint and in ascending order. An empty result means nothing on
/// this sequence's timeline moved.
pub fn affected_ranges(
    before: &Sequence,
    after: &Sequence,
    effects_before: &HashMap<EffectId, Effect>,
    effects_after: &HashMap<EffectId, Effect>,
    changes: &[StateChange],
) -> Vec<TimeRange> {
    let before_clips = index_clips(before);
    let after_clips = index_clips(after);
    let mut ranges: Vec<TimeRange> = Vec::new();

    // 1. Clip-by-clip diff. This is the part that catches ripple moves.
    let mut clip_ids: HashSet<&str> = HashSet::new();
    clip_ids.extend(before_clips.keys().copied());
    clip_ids.extend(after_clips.keys().copied());
    for clip_id in clip_ids {
        let old = before_clips.get(clip_id);
        let new = after_clips.get(clip_id);
        if let (Some(old), Some(new)) = (old, new) {
            if spans_match(old, new) {
                continue;
            }
        }
        push_entry(&mut ranges, old);
        push_entry(&mut ranges, new);
    }

    // 2. Reported changes, for everything a span diff cannot see.
    let whole_timeline = || {
        let end = before.duration().max(after.duration());
        (end.is_finite() && end > 0.0).then(|| TimeRange::new(0.0, end))
    };

    for change in changes {
        match change {
            StateChange::ClipCreated { clip_id }
            | StateChange::ClipModified { clip_id }
            | StateChange::ClipDeleted { clip_id } => {
                push_entry(&mut ranges, before_clips.get(clip_id.as_str()));
                push_entry(&mut ranges, after_clips.get(clip_id.as_str()));
            }
            StateChange::CaptionCreated { caption_id }
            | StateChange::CaptionModified { caption_id }
            | StateChange::CaptionDeleted { caption_id } => {
                push_entry(&mut ranges, before_clips.get(caption_id.as_str()));
                push_entry(&mut ranges, after_clips.get(caption_id.as_str()));
            }
            StateChange::EffectAdded { effect_id, clip_id } => {
                push_effect_ranges(
                    &mut ranges,
                    effect_id,
                    Some(clip_id.as_str()),
                    &before_clips,
                    effects_before,
                );
                push_effect_ranges(
                    &mut ranges,
                    effect_id,
                    Some(clip_id.as_str()),
                    &after_clips,
                    effects_after,
                );
            }
            StateChange::EffectApplied { effect_id }
            | StateChange::EffectUpdated { effect_id }
            | StateChange::EffectRemoved { effect_id } => {
                push_effect_ranges(&mut ranges, effect_id, None, &before_clips, effects_before);
                push_effect_ranges(&mut ranges, effect_id, None, &after_clips, effects_after);
            }
            StateChange::MarkerCreated { marker_id } | StateChange::MarkerDeleted { marker_id } => {
                if let Some(time) = marker_time(after, marker_id).or_else(|| {
                    // A deleted marker only exists in the before image.
                    marker_time(before, marker_id)
                }) {
                    push_range(&mut ranges, time, time);
                }
            }
            // A brand-new track is empty, so it shows nothing until a clip
            // lands on it — and that clip is caught by the diff above.
            StateChange::TrackCreated { .. } => {}
            StateChange::TrackModified { .. }
            | StateChange::TrackDeleted { .. }
            | StateChange::SequenceCreated { .. }
            | StateChange::SequenceModified { .. } => {
                if let Some(range) = whole_timeline() {
                    ranges.push(range);
                }
            }
            // Library-level changes place nothing on the timeline by
            // themselves; the edit that uses the asset does.
            StateChange::AssetAdded { .. }
            | StateChange::AssetModified { .. }
            | StateChange::AssetRemoved { .. } => {}
        }
    }

    merge_ranges(ranges)
}

/// One clip's timeline footprint, as one state of the project records it.
struct ClipEntry<'a> {
    start_sec: TimeSec,
    end_sec: TimeSec,
    effect_ids: &'a [EffectId],
}

fn index_clips(sequence: &Sequence) -> HashMap<&str, ClipEntry<'_>> {
    let mut index = HashMap::new();
    for track in &sequence.tracks {
        for clip in &track.clips {
            index.insert(
                clip.id.as_str(),
                ClipEntry {
                    start_sec: clip.place.timeline_in_sec,
                    end_sec: clip.place.timeline_out_sec(),
                    effect_ids: &clip.effects,
                },
            );
        }
    }
    index
}

fn spans_match(old: &ClipEntry<'_>, new: &ClipEntry<'_>) -> bool {
    (old.start_sec - new.start_sec).abs() < TIME_EPSILON
        && (old.end_sec - new.end_sec).abs() < TIME_EPSILON
}

fn push_entry(ranges: &mut Vec<TimeRange>, entry: Option<&ClipEntry<'_>>) {
    if let Some(entry) = entry {
        push_range(ranges, entry.start_sec, entry.end_sec);
    }
}

fn push_range(ranges: &mut Vec<TimeRange>, start_sec: TimeSec, end_sec: TimeSec) {
    if !start_sec.is_finite() || !end_sec.is_finite() {
        return;
    }
    ranges.push(TimeRange::new(start_sec.max(0.0), end_sec.max(0.0)));
}

/// Adds the range an effect covers in one state of the project.
///
/// A two-input transition is reported as the stretch it blends across, which
/// straddles the cut and belongs to neither adjacent clip; anything else is
/// reported as the span of the clip it hangs on. Contributes nothing when that
/// state does not hold the effect — which is what makes an added effect report
/// only its new span and a removed one only its old.
fn push_effect_ranges(
    ranges: &mut Vec<TimeRange>,
    effect_id: &str,
    clip_hint: Option<&str>,
    clips: &HashMap<&str, ClipEntry<'_>>,
    effects: &HashMap<EffectId, Effect>,
) {
    let Some(effect) = effects.get(effect_id) else {
        return;
    };
    let Some(entry) = owning_clip(effect_id, clip_hint, clips) else {
        return;
    };

    if let Some((start_sec, end_sec)) = transition_span_sec(effect, entry.end_sec) {
        push_range(ranges, start_sec, end_sec);
        return;
    }

    push_range(ranges, entry.start_sec, entry.end_sec);
}

fn owning_clip<'a, 'b>(
    effect_id: &str,
    clip_hint: Option<&str>,
    clips: &'a HashMap<&str, ClipEntry<'b>>,
) -> Option<&'a ClipEntry<'b>> {
    if let Some(clip_id) = clip_hint {
        if let Some(entry) = clips.get(clip_id) {
            if entry.effect_ids.iter().any(|id| id == effect_id) {
                return Some(entry);
            }
        }
    }

    clips
        .values()
        .find(|entry| entry.effect_ids.iter().any(|id| id == effect_id))
}

fn marker_time(sequence: &Sequence, marker_id: &str) -> Option<TimeSec> {
    sequence
        .markers
        .iter()
        .find(|marker| marker.id == marker_id)
        .map(|marker| marker.time_sec)
        .filter(|time| time.is_finite())
}

/// Sorts and merges ranges that overlap or touch within [`TIME_EPSILON`].
fn merge_ranges(mut ranges: Vec<TimeRange>) -> Vec<TimeRange> {
    if ranges.is_empty() {
        return ranges;
    }

    ranges.sort_by(|a, b| {
        a.start_sec
            .partial_cmp(&b.start_sec)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| {
                a.end_sec
                    .partial_cmp(&b.end_sec)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
    });

    let mut merged: Vec<TimeRange> = Vec::with_capacity(ranges.len());
    for range in ranges {
        match merged.last_mut() {
            Some(last) if range.start_sec <= last.end_sec + TIME_EPSILON => {
                if range.end_sec > last.end_sec {
                    last.end_sec = range.end_sec;
                }
            }
            _ => merged.push(range),
        }
    }

    merged
}

/// Merges several range lists — the per-step results of a plan, say — into one
/// sorted, disjoint union.
pub fn union_ranges(lists: impl IntoIterator<Item = Vec<TimeRange>>) -> Vec<TimeRange> {
    merge_ranges(lists.into_iter().flatten().collect())
}

// =============================================================================
// Before-image capture
// =============================================================================

/// A before-image of the one sequence a command is about to change.
///
/// Cloning the whole [`ProjectState`] to diff one timeline would copy every
/// asset and every other sequence for nothing. This keeps only the target
/// sequence and the effects its clips reference, which is all
/// [`affected_ranges`] reads.
#[derive(Clone, Debug)]
pub struct SequenceSnapshot {
    sequence: Option<Sequence>,
    effects: HashMap<EffectId, Effect>,
}

impl SequenceSnapshot {
    /// Captures the named sequence and the effects its clips reference.
    ///
    /// A sequence the state does not hold yet is captured as absent, so a
    /// command that creates one still produces a usable diff.
    pub fn capture(state: &ProjectState, sequence_id: &str) -> Self {
        let sequence = state.sequences.get(sequence_id).cloned();
        let effects = sequence
            .as_ref()
            .map(|sequence| collect_referenced_effects(sequence, &state.effects))
            .unwrap_or_default();

        Self { sequence, effects }
    }

    /// Diffs this before-image against the state as it now stands.
    ///
    /// A sequence that only exists on one side of the diff — created or
    /// removed by the command — reports its whole timeline, since every frame
    /// of it is new or gone.
    pub fn affected_ranges(
        &self,
        state: &ProjectState,
        sequence_id: &str,
        changes: &[StateChange],
    ) -> Vec<TimeRange> {
        let after = state.sequences.get(sequence_id);
        match (self.sequence.as_ref(), after) {
            (Some(before), Some(after)) => {
                affected_ranges(before, after, &self.effects, &state.effects, changes)
            }
            (None, Some(after)) => whole_sequence_range(after),
            (Some(before), None) => whole_sequence_range(before),
            (None, None) => Vec::new(),
        }
    }
}

fn whole_sequence_range(sequence: &Sequence) -> Vec<TimeRange> {
    let end = sequence.duration();
    if !end.is_finite() || end <= 0.0 {
        return Vec::new();
    }
    vec![TimeRange::new(0.0, end)]
}

fn collect_referenced_effects(
    sequence: &Sequence,
    effects: &HashMap<EffectId, Effect>,
) -> HashMap<EffectId, Effect> {
    let mut referenced = HashMap::new();
    for track in &sequence.tracks {
        for clip in &track.clips {
            for effect_id in &clip.effects {
                if let Some(effect) = effects.get(effect_id) {
                    referenced.insert(effect_id.clone(), effect.clone());
                }
            }
        }
    }
    referenced
}

// =============================================================================
// Persistence
// =============================================================================

/// File name of the last-apply record inside the agent cache directory.
const LAST_AFFECTED_RANGES_FILE: &str = "last_affected_ranges.json";

/// Returns the directory holding agent-facing scratch files for a project.
pub fn agent_cache_dir(project_dir: &Path) -> PathBuf {
    project_dir.join(".openreelio").join("cache").join("agent")
}

/// Returns the path of the last-apply record for a project.
pub fn last_affected_ranges_path(project_dir: &Path) -> PathBuf {
    agent_cache_dir(project_dir).join(LAST_AFFECTED_RANGES_FILE)
}

/// The ranges the most recent successful apply changed.
///
/// Written after every successful mutating verb so a later inspection step can
/// ask "where did the last edit land" without the caller having to carry the
/// answer between processes. Overwritten each time — this is a hand-off, not a
/// history; the ops log is the history.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LastAffectedRanges {
    /// Sequence the ranges are measured against.
    pub sequence_id: String,
    /// Operation ids the apply appended, in order.
    pub op_ids: Vec<String>,
    /// The sorted, disjoint union of changed ranges.
    pub affected_ranges: Vec<TimeRange>,
    /// RFC 3339 timestamp of the write.
    pub recorded_at: String,
}

impl LastAffectedRanges {
    /// Builds a record stamped with the current time.
    pub fn new(sequence_id: String, op_ids: Vec<String>, affected_ranges: Vec<TimeRange>) -> Self {
        Self {
            sequence_id,
            op_ids,
            affected_ranges,
            recorded_at: chrono::Utc::now().to_rfc3339(),
        }
    }
}

/// Writes the last-apply record for a project, creating the cache directory.
///
/// Callers treat a failure here as a warning: the edit itself is already
/// durable in the ops log, and a missing hand-off file only costs the next
/// inspection step its shortcut.
pub fn save_last_affected_ranges(
    project_dir: &Path,
    record: &LastAffectedRanges,
) -> Result<(), String> {
    let path = last_affected_ranges_path(project_dir);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create {}: {error}", parent.display()))?;
    }

    let serialized = serde_json::to_string_pretty(record)
        .map_err(|error| format!("Failed to serialize affected ranges: {error}"))?;
    std::fs::write(&path, serialized)
        .map_err(|error| format!("Failed to write {}: {error}", path.display()))
}

/// Reads the last-apply record for a project.
///
/// `None` when nothing has been recorded yet, or when the file cannot be read
/// or parsed — a stale or corrupt hand-off is treated as absent rather than as
/// an error, because the caller can always fall back to inspecting the whole
/// timeline.
pub fn load_last_affected_ranges(project_dir: &Path) -> Option<LastAffectedRanges> {
    let path = last_affected_ranges_path(project_dir);
    let contents = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&contents).ok()
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::effects::{EffectType, ParamValue};
    use crate::core::timeline::{Clip, ClipPlace, Marker, SequenceFormat, Track, TrackKind};

    fn sequence_with(clips: Vec<(&str, f64, f64)>) -> Sequence {
        let mut sequence = Sequence::new("Diff", SequenceFormat::youtube_1080());
        let mut track = Track::new_video("V1");
        track.id = "track-v1".to_string();
        for (id, start, duration) in clips {
            let mut clip = Clip::new("asset-a");
            clip.id = id.to_string();
            clip.place = ClipPlace::new(start, duration);
            track.clips.push(clip);
        }
        sequence.tracks.push(track);
        sequence
    }

    fn ranges(before: &Sequence, after: &Sequence, changes: &[StateChange]) -> Vec<(f64, f64)> {
        affected_ranges(before, after, &HashMap::new(), &HashMap::new(), changes)
            .into_iter()
            .map(|range| (range.start_sec, range.end_sec))
            .collect()
    }

    #[test]
    fn should_report_both_the_old_and_new_span_of_a_moved_clip() {
        let before = sequence_with(vec![("clip-a", 0.0, 2.0)]);
        let after = sequence_with(vec![("clip-a", 6.0, 2.0)]);

        let result = ranges(
            &before,
            &after,
            &[StateChange::ClipModified {
                clip_id: "clip-a".to_string(),
            }],
        );

        assert_eq!(result, vec![(0.0, 2.0), (6.0, 8.0)]);
    }

    #[test]
    fn should_merge_the_old_and_new_span_of_a_trim() {
        let before = sequence_with(vec![("clip-a", 0.0, 4.0)]);
        let after = sequence_with(vec![("clip-a", 0.0, 2.5)]);

        let result = ranges(
            &before,
            &after,
            &[StateChange::ClipModified {
                clip_id: "clip-a".to_string(),
            }],
        );

        assert_eq!(result, vec![(0.0, 4.0)]);
    }

    #[test]
    fn should_report_nothing_when_a_split_leaves_every_span_where_it_was() {
        // A split replaces one clip with two covering the same stretch; the
        // new halves have new ids, so both are reported.
        let before = sequence_with(vec![("clip-a", 0.0, 4.0)]);
        let after = sequence_with(vec![("clip-a", 0.0, 2.0), ("clip-b", 2.0, 2.0)]);

        let result = ranges(
            &before,
            &after,
            &[
                StateChange::ClipModified {
                    clip_id: "clip-a".to_string(),
                },
                StateChange::ClipCreated {
                    clip_id: "clip-b".to_string(),
                },
            ],
        );

        assert_eq!(result, vec![(0.0, 4.0)]);
    }

    #[test]
    fn should_report_the_ripple_shift_no_change_entry_mentions() {
        // Deleting the first clip ripples the rest left. `changes` names only
        // the deleted clip, so a change-list-only implementation would miss
        // everything that moved.
        let before = sequence_with(vec![
            ("clip-a", 0.0, 2.0),
            ("clip-b", 2.0, 2.0),
            ("clip-c", 4.0, 2.0),
        ]);
        let after = sequence_with(vec![("clip-b", 0.0, 2.0), ("clip-c", 2.0, 2.0)]);

        let result = ranges(
            &before,
            &after,
            &[StateChange::ClipDeleted {
                clip_id: "clip-a".to_string(),
            }],
        );

        assert_eq!(result, vec![(0.0, 6.0)]);
    }

    #[test]
    fn should_report_a_caption_retitled_in_place() {
        let mut before = Sequence::new("Captions", SequenceFormat::youtube_1080());
        let mut track = Track::new("C1", TrackKind::Caption);
        track.id = "track-c1".to_string();
        let mut caption = Clip::new("__caption__");
        caption.id = "cap-1".to_string();
        caption.place = ClipPlace::new(3.0, 1.5);
        caption.label = Some("before".to_string());
        track.clips.push(caption);
        before.tracks.push(track);

        let mut after = before.clone();
        after.tracks[0].clips[0].label = Some("after".to_string());

        let result = ranges(
            &before,
            &after,
            &[StateChange::CaptionModified {
                caption_id: "cap-1".to_string(),
            }],
        );

        assert_eq!(result, vec![(3.0, 4.5)]);
    }

    #[test]
    fn should_report_a_dissolve_as_the_stretch_it_blends_across() {
        let before = sequence_with(vec![("clip-a", 0.0, 3.0), ("clip-b", 3.0, 3.0)]);
        let mut after = before.clone();

        let mut effect = Effect::new(EffectType::CrossDissolve);
        effect.id = "fx-1".to_string();
        effect.set_param("duration", ParamValue::Float(1.0));
        after.tracks[0].clips[0].effects.push(effect.id.clone());

        let mut effects_after = HashMap::new();
        effects_after.insert(effect.id.clone(), effect);

        let result: Vec<(f64, f64)> = affected_ranges(
            &before,
            &after,
            &HashMap::new(),
            &effects_after,
            &[StateChange::EffectAdded {
                effect_id: "fx-1".to_string(),
                clip_id: "clip-a".to_string(),
            }],
        )
        .into_iter()
        .map(|range| (range.start_sec, range.end_sec))
        .collect();

        // Centred on the cut at 3.0 — neither clip's own span.
        assert_eq!(result, vec![(2.5, 3.5)]);
    }

    #[test]
    fn should_report_a_plain_effect_as_the_span_of_the_clip_it_hangs_on() {
        let before = sequence_with(vec![("clip-a", 0.0, 3.0)]);
        let mut after = before.clone();

        let mut effect = Effect::new(EffectType::GaussianBlur);
        effect.id = "fx-blur".to_string();
        after.tracks[0].clips[0].effects.push(effect.id.clone());

        let mut effects_after = HashMap::new();
        effects_after.insert(effect.id.clone(), effect);

        let result: Vec<(f64, f64)> = affected_ranges(
            &before,
            &after,
            &HashMap::new(),
            &effects_after,
            &[StateChange::EffectAdded {
                effect_id: "fx-blur".to_string(),
                clip_id: "clip-a".to_string(),
            }],
        )
        .into_iter()
        .map(|range| (range.start_sec, range.end_sec))
        .collect();

        assert_eq!(result, vec![(0.0, 3.0)]);
    }

    #[test]
    fn should_report_a_zero_length_range_at_a_new_marker() {
        let before = sequence_with(vec![("clip-a", 0.0, 5.0)]);
        let mut after = before.clone();
        let mut marker = Marker::new(1.5, "Hook");
        marker.id = "marker-1".to_string();
        after.markers.push(marker);

        let result = ranges(
            &before,
            &after,
            &[StateChange::MarkerCreated {
                marker_id: "marker-1".to_string(),
            }],
        );

        assert_eq!(result, vec![(1.5, 1.5)]);
    }

    #[test]
    fn should_report_the_whole_timeline_when_a_track_is_muted() {
        let before = sequence_with(vec![("clip-a", 0.0, 5.0)]);
        let mut after = before.clone();
        after.tracks[0].muted = true;

        let result = ranges(
            &before,
            &after,
            &[StateChange::TrackModified {
                track_id: "track-v1".to_string(),
            }],
        );

        assert_eq!(result, vec![(0.0, 5.0)]);
    }

    #[test]
    fn should_report_nothing_for_a_change_that_moves_no_picture() {
        let before = sequence_with(vec![("clip-a", 0.0, 5.0)]);
        let after = before.clone();

        let result = ranges(
            &before,
            &after,
            &[StateChange::AssetAdded {
                asset_id: "asset-z".to_string(),
            }],
        );

        assert!(result.is_empty());
    }

    #[test]
    fn should_round_trip_the_last_apply_record() {
        let dir = tempfile::tempdir().expect("temp dir");
        assert!(load_last_affected_ranges(dir.path()).is_none());

        let record = LastAffectedRanges::new(
            "seq-1".to_string(),
            vec!["op-1".to_string()],
            vec![TimeRange::new(1.0, 2.0)],
        );
        save_last_affected_ranges(dir.path(), &record).expect("save");

        let loaded = load_last_affected_ranges(dir.path()).expect("record");
        assert_eq!(loaded, record);
        assert!(last_affected_ranges_path(dir.path()).exists());
    }
}
