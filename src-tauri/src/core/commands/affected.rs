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
    commands::{CommandResult, StateChange},
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
/// - the whole timeline for a change to a track *this* sequence holds, or to
///   this sequence itself, because muting, hiding, removing or reordering a
///   track can alter every frame. A change naming another sequence's track — or
///   another sequence, as `CreateCompoundClip` reports the nested sequence it
///   builds — contributes nothing, because none of this timeline moved.
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
    let fps = after.format.fps.as_f64();
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
                    fps,
                );
                push_effect_ranges(
                    &mut ranges,
                    effect_id,
                    Some(clip_id.as_str()),
                    &after_clips,
                    effects_after,
                    fps,
                );
            }
            StateChange::EffectApplied { effect_id }
            | StateChange::EffectUpdated { effect_id }
            | StateChange::EffectRemoved { effect_id } => {
                push_effect_ranges(
                    &mut ranges,
                    effect_id,
                    None,
                    &before_clips,
                    effects_before,
                    fps,
                );
                push_effect_ranges(
                    &mut ranges,
                    effect_id,
                    None,
                    &after_clips,
                    effects_after,
                    fps,
                );
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
            // A track edit reaches every frame *of the sequence that holds the
            // track*. A plan that edits two sequences reports one change list,
            // so a track id this sequence never had is somebody else's timeline.
            StateChange::TrackModified { track_id } | StateChange::TrackDeleted { track_id } => {
                if has_track(before, track_id) || has_track(after, track_id) {
                    if let Some(range) = whole_timeline() {
                        ranges.push(range);
                    }
                }
            }
            // `CreateCompoundClip` reports `SequenceCreated` for the *nested*
            // sequence it builds, not for the one it edits, and `CreateSequence`
            // reports one for a sequence that has nothing on it yet. Neither
            // moves a frame of the sequence being measured.
            StateChange::SequenceCreated { sequence_id }
            | StateChange::SequenceModified { sequence_id } => {
                if sequence_id == &after.id {
                    if let Some(range) = whole_timeline() {
                        ranges.push(range);
                    }
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
    fps: f64,
) {
    let Some(effect) = effects.get(effect_id) else {
        return;
    };
    let Some(entry) = owning_clip(effect_id, clip_hint, clips) else {
        return;
    };

    if let Some((start_sec, end_sec)) = transition_span_sec(effect, entry.end_sec, fps) {
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

/// Whether this sequence holds the named track in the given state.
fn has_track(sequence: &Sequence, track_id: &str) -> bool {
    sequence.tracks.iter().any(|track| track.id == track_id)
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

/// One mutating apply, from the before-image to the ranges it changed.
///
/// Every surface that applies an edit has to answer the same question — *where
/// on the timeline did this land* — and the answer is a diff across the whole
/// apply, not a summary of what each step reported. Holding the before-image and
/// folding results into it keeps that arithmetic in one place, so the GUI's
/// `execute_command`, its plan runner and the CLI's verbs cannot disagree about
/// what `--affected` will point at.
///
/// A verb that applies several commands under one save opens one recorder and
/// observes each result: the ranges are then the diff across the whole verb,
/// which is what the caller asked about anyway.
#[derive(Clone, Debug)]
pub struct EditRecording {
    sequence_id: String,
    source: RecordSource,
    before: SequenceSnapshot,
    op_ids: Vec<String>,
    changes: Vec<StateChange>,
}

impl EditRecording {
    /// Captures the before-image of the sequence an apply is about to change.
    ///
    /// Must be called before the first command runs: the ranges are a diff
    /// across the mutation, and a ripple move shifts clips no reported change
    /// names.
    ///
    /// `source` names the surface that is applying the edit, and travels into
    /// the hand-off record: a reader has to be able to tell an agent's own
    /// apply from an interactive edit that landed after it.
    pub fn begin(state: &ProjectState, sequence_id: &str, source: RecordSource) -> Self {
        Self {
            sequence_id: sequence_id.to_string(),
            source,
            before: SequenceSnapshot::capture(state, sequence_id),
            op_ids: Vec::new(),
            changes: Vec::new(),
        }
    }

    /// Folds one applied command's result into the recording.
    pub fn observe(&mut self, result: &CommandResult) {
        self.op_ids.push(result.op_id.clone());
        self.changes.extend(result.changes.iter().cloned());
    }

    /// The sequence these ranges are measured against.
    pub fn sequence_id(&self) -> &str {
        &self.sequence_id
    }

    /// The operation ids the apply appended, in order.
    pub fn op_ids(&self) -> &[String] {
        &self.op_ids
    }

    /// Diffs the before-image against the state as it now stands.
    pub fn ranges(&self, state: &ProjectState) -> Vec<TimeRange> {
        self.before
            .affected_ranges(state, &self.sequence_id, &self.changes)
    }

    /// Computes the ranges and writes the where-to-look hand-off for them.
    ///
    /// Recording is best-effort: by the time this runs the edit is already
    /// durable in the ops log, so a failed write costs the next inspection step
    /// its shortcut and nothing else. It is logged rather than returned, because
    /// a caller that turned it into a failure would tell the user an edit that
    /// did apply did not.
    pub fn finish(self, project_dir: &Path, state: &ProjectState) -> Vec<TimeRange> {
        let ranges = self.ranges(state);
        if let Err(error) = record_affected_ranges(
            project_dir,
            &self.sequence_id,
            self.op_ids,
            &ranges,
            self.source,
        ) {
            tracing::warn!(
                sequence_id = %self.sequence_id,
                "Could not record the affected ranges: {error}"
            );
        }
        ranges
    }
}

/// Finds the sequence a command payload acts on when it does not name one.
///
/// `UpdateEffect`, `UpdateMask` and `RemoveMask` address an effect and never a
/// sequence, so the sequence is whichever one holds a clip carrying that effect.
/// Falling back to the *active* sequence instead reported the whole timeline of
/// a sequence the command had not touched, which is worse than reporting
/// nothing: an agent cannot tell a confident wrong answer from a right one.
///
/// `None` when the payload names nothing that identifies a sequence — a
/// `CreateSequence`, an asset import — and the caller then reports no sequence
/// and no ranges rather than guessing.
pub fn infer_sequence_id(
    state: &ProjectState,
    effect_id: Option<&str>,
    clip_id: Option<&str>,
) -> Option<String> {
    if effect_id.is_none() && clip_id.is_none() {
        return None;
    }

    state
        .sequences
        .iter()
        .find(|(_, sequence)| {
            sequence
                .tracks
                .iter()
                .flat_map(|track| track.clips.iter())
                .any(|clip| {
                    clip_id.is_some_and(|clip_id| clip.id == clip_id)
                        || effect_id.is_some_and(|effect_id| {
                            clip.effects.iter().any(|held| held == effect_id)
                        })
                })
        })
        .map(|(sequence_id, _)| sequence_id.clone())
}

/// Reads a plain-string field from a command payload, if it carries one.
///
/// Lives beside [`infer_sequence_id`] because it exists for the same reason:
/// the ids that decide which timeline an edit is measured against have to be
/// read off the raw payload before the typed command consumes it, and every
/// surface that applies a command does that the same way.
pub fn payload_string(payload: &serde_json::Value, key: &str) -> Option<String> {
    payload
        .get(key)
        .and_then(|value| value.as_str())
        .map(str::to_string)
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
///
/// Private: the directory is an implementation detail of the hand-off record,
/// and every caller outside this module wants
/// [`last_affected_ranges_path`] rather than the directory it sits in.
fn agent_cache_dir(project_dir: &Path) -> PathBuf {
    project_dir.join(".openreelio").join("cache").join("agent")
}

/// Returns the path of the last-apply record for a project.
pub fn last_affected_ranges_path(project_dir: &Path) -> PathBuf {
    agent_cache_dir(project_dir).join(LAST_AFFECTED_RANGES_FILE)
}

/// The surface that wrote a hand-off record.
///
/// The record is a single slot every surface overwrites, so the surface that
/// wrote it is part of the answer: an agent that asks "where did the last edit
/// land" is asking about *its own* edit, and a record left by the person
/// dragging a clip in the app answers a different question. The tag cannot make
/// the slot exclusive — that is what `afterOp` and explicit ranges are for —
/// but it lets a reader say whose edit it is about to look at.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RecordSource {
    /// A headless verb: the CLI, or the MCP server that shares its code.
    Cli,
    /// The app's own edit path, which the timeline UI applies through.
    Gui,
    /// The in-app agent's plan runner.
    AgentPlan,
    /// A record written before records carried a source.
    #[default]
    Unknown,
}

/// The ranges the most recent successful apply changed.
///
/// Written after every successful mutating verb so a later inspection step can
/// ask "where did the last edit land" without the caller having to carry the
/// answer between processes. Overwritten each time — this is a hand-off, not a
/// history; the ops log is the history.
///
/// Being a single slot is also its limit: two surfaces write it, so a reader
/// that must be certain the ranges are its own edit's names the operation it
/// expects the record to end at (see `afterOp` on the frame probe) or passes
/// the ranges outright instead of asking for the last ones.
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
    /// The surface that applied the edit.
    ///
    /// Defaulted rather than required, so a record written by an older build —
    /// the file is a cache entry that survives an upgrade — still parses, as
    /// [`RecordSource::Unknown`].
    #[serde(default)]
    pub source: RecordSource,
}

impl LastAffectedRanges {
    /// Builds a record stamped with the current time.
    pub fn new(
        sequence_id: String,
        op_ids: Vec<String>,
        affected_ranges: Vec<TimeRange>,
        source: RecordSource,
    ) -> Self {
        Self {
            sequence_id,
            op_ids,
            affected_ranges,
            recorded_at: chrono::Utc::now().to_rfc3339(),
            source,
        }
    }
}

/// Writes the last-apply record for a project, creating the cache directory.
///
/// Written to a sibling temp file and renamed into place, so a reader never
/// sees a half-written record: the file is small enough that a torn write would
/// normally be invisible, but the failure mode it produces — a parse error that
/// [`load_last_affected_ranges`] reports as "nothing recorded" — is exactly the
/// one that sends an inspection step to the wrong seconds. A rename that fails
/// falls back to writing the destination directly, because a hand-off written
/// non-atomically still beats no hand-off at all.
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

    let temp_path = path.with_extension("json.tmp");
    let staged = std::fs::write(&temp_path, &serialized).is_ok()
        && std::fs::rename(&temp_path, &path).is_ok();
    if staged {
        return Ok(());
    }

    let _ = std::fs::remove_file(&temp_path);
    std::fs::write(&path, serialized)
        .map_err(|error| format!("Failed to write {}: {error}", path.display()))
}

/// Writes the where-to-look hand-off for the next inspection step, if there is
/// one to write.
///
/// A record with no sequence or no ranges is skipped rather than written empty
/// — the answer is `Ok(false)`. The file is a single hand-off slot, so writing
/// an empty one over a real one loses the answer to "where did the last edit
/// land" for a command that never had one: an asset import, a sequence created
/// empty.
///
/// Callers treat a failure as a warning in their own voice. The edit is already
/// durable in the ops log by the time this runs, so turning a failed hand-off
/// into a command failure would wrongly suggest the edit did not apply.
pub fn record_affected_ranges(
    project_dir: &Path,
    sequence_id: &str,
    op_ids: Vec<String>,
    affected_ranges: &[TimeRange],
    source: RecordSource,
) -> Result<bool, String> {
    if sequence_id.is_empty() || affected_ranges.is_empty() {
        return Ok(false);
    }

    let record = LastAffectedRanges::new(
        sequence_id.to_string(),
        op_ids,
        affected_ranges.to_vec(),
        source,
    );
    save_last_affected_ranges(project_dir, &record)?;
    Ok(true)
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
    fn should_report_one_merged_range_covering_both_halves_of_a_split() {
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
    fn should_ignore_a_track_change_naming_another_sequences_track() {
        // A plan that edits two sequences reports one change list. Measured
        // against sequence A, a track edit on sequence B moved nothing here.
        let before = sequence_with(vec![("clip-a", 0.0, 5.0)]);
        let after = before.clone();

        let result = ranges(
            &before,
            &after,
            &[StateChange::TrackModified {
                track_id: "track-on-another-sequence".to_string(),
            }],
        );

        assert!(
            result.is_empty(),
            "another sequence's track must not report this timeline: {result:?}"
        );
    }

    #[test]
    fn should_ignore_a_sequence_change_naming_another_sequence() {
        // `CreateCompoundClip` reports `SequenceCreated` for the nested
        // sequence it builds. Reporting the outer timeline for it sent an
        // inspector to every second of a sequence the command barely touched.
        let before = sequence_with(vec![("clip-a", 0.0, 5.0)]);
        let after = before.clone();

        let result = ranges(
            &before,
            &after,
            &[StateChange::SequenceCreated {
                sequence_id: "nested-sequence".to_string(),
            }],
        );

        assert!(result.is_empty(), "{result:?}");
    }

    #[test]
    fn should_report_the_whole_timeline_when_this_sequence_itself_changed() {
        let before = sequence_with(vec![("clip-a", 0.0, 5.0)]);
        let after = before.clone();
        let sequence_id = after.id.clone();

        let result = ranges(
            &before,
            &after,
            &[StateChange::SequenceModified { sequence_id }],
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

    /// A project holding two sequences, the effect living on the second one.
    ///
    /// Returns `(state, active_sequence_id, other_sequence_id)`.
    fn two_sequence_state(effect_id: &str) -> (ProjectState, String, String) {
        let mut state = ProjectState::new("Two sequences");
        let active_id = state
            .sequences
            .keys()
            .next()
            .cloned()
            .expect("the default sequence");
        state.active_sequence_id = Some(active_id.clone());

        let mut other = Sequence::new("Second", SequenceFormat::youtube_1080());
        let mut track = Track::new_video("V1");
        let mut clip = Clip::new("asset-a");
        clip.effects.push(effect_id.to_string());
        let clip_id = clip.id.clone();
        track.clips.push(clip);
        other.tracks.push(track);
        let other_id = other.id.clone();
        state.sequences.insert(other_id.clone(), other);

        assert_ne!(active_id, other_id);
        assert!(!clip_id.is_empty());
        (state, active_id, other_id)
    }

    #[test]
    fn should_measure_an_effect_edit_against_the_sequence_that_holds_the_effect() {
        // `UpdateEffect` names no sequence. Measuring it against the *active*
        // one reported that timeline's every second for an edit on another.
        let (state, active_id, other_id) = two_sequence_state("fx-1");

        let resolved = infer_sequence_id(&state, Some("fx-1"), None);

        assert_eq!(resolved.as_deref(), Some(other_id.as_str()));
        assert_ne!(resolved.as_deref(), Some(active_id.as_str()));
    }

    #[test]
    fn should_measure_a_clip_edit_against_the_sequence_that_holds_the_clip() {
        let (state, _active_id, other_id) = two_sequence_state("fx-1");
        let clip_id = state.sequences[&other_id].tracks[0].clips[0].id.clone();

        assert_eq!(
            infer_sequence_id(&state, None, Some(&clip_id)).as_deref(),
            Some(other_id.as_str())
        );
    }

    #[test]
    fn should_resolve_no_sequence_for_a_payload_that_names_nothing() {
        // A `CreateSequence` payload names no sequence, no effect and no clip.
        // Reporting the active sequence there claimed an edit landed somewhere
        // it did not.
        let (state, _active_id, _other_id) = two_sequence_state("fx-1");

        assert_eq!(infer_sequence_id(&state, None, None), None);
        assert_eq!(infer_sequence_id(&state, Some("fx-unknown"), None), None);
    }

    /// A project whose active sequence holds three back-to-back clips.
    fn rippleable_project() -> (ProjectState, String) {
        let mut state = ProjectState::new("Recording");
        let mut sequence = sequence_with(vec![
            ("clip-a", 0.0, 2.0),
            ("clip-b", 2.0, 2.0),
            ("clip-c", 4.0, 2.0),
        ]);
        sequence.id = "seq-record".to_string();
        let sequence_id = sequence.id.clone();
        state.sequences.insert(sequence_id.clone(), sequence);
        state.active_sequence_id = Some(sequence_id.clone());
        (state, sequence_id)
    }

    #[test]
    fn should_record_the_ranges_a_real_apply_changed() {
        // The GUI cannot construct a `State<AppState>` in a unit test, so the
        // path under test is the one its command delegates to: capture the
        // before-image, run a real command through a real `CommandExecutor`,
        // and fold the result back in.
        let dir = tempfile::tempdir().expect("temp dir");
        let (mut state, sequence_id) = rippleable_project();
        let mut executor = crate::core::commands::CommandExecutor::new();

        let mut recording = EditRecording::begin(&state, &sequence_id, RecordSource::Cli);
        let result = executor
            .execute(
                Box::new(crate::core::commands::RippleDeleteCommand::new(
                    &sequence_id,
                    "track-v1",
                    vec!["clip-a".to_string()],
                )),
                &mut state,
            )
            .expect("the clip is rippled out");
        recording.observe(&result);

        let ranges = recording.finish(dir.path(), &state);

        // A ripple delete moves clips no `StateChange` entry names, so the
        // answer has to be the diff, not the change list.
        assert_eq!(
            ranges
                .iter()
                .map(|range| (range.start_sec, range.end_sec))
                .collect::<Vec<_>>(),
            vec![(0.0, 6.0)]
        );

        let record = load_last_affected_ranges(dir.path()).expect("a hand-off was written");
        assert_eq!(record.sequence_id, sequence_id);
        assert_eq!(record.op_ids, vec![result.op_id]);
        assert_eq!(record.affected_ranges, ranges);
    }

    #[test]
    fn should_not_overwrite_the_hand_off_for_an_apply_that_moved_nothing() {
        let dir = tempfile::tempdir().expect("temp dir");
        let landed = LastAffectedRanges::new(
            "seq-record".to_string(),
            vec!["op-earlier".to_string()],
            vec![TimeRange::new(1.0, 2.0)],
            RecordSource::Cli,
        );
        save_last_affected_ranges(dir.path(), &landed).expect("save");

        let (state, sequence_id) = rippleable_project();
        // No command ran, so the diff is empty. The file is one hand-off slot:
        // blanking it here would lose the answer to "where did the last edit
        // land" for a command that never had one.
        let ranges = EditRecording::begin(&state, &sequence_id, RecordSource::Cli)
            .finish(dir.path(), &state);

        assert!(ranges.is_empty());
        assert_eq!(load_last_affected_ranges(dir.path()), Some(landed));
    }

    #[test]
    fn should_round_trip_the_last_apply_record() {
        let dir = tempfile::tempdir().expect("temp dir");
        assert!(load_last_affected_ranges(dir.path()).is_none());

        let record = LastAffectedRanges::new(
            "seq-1".to_string(),
            vec!["op-1".to_string()],
            vec![TimeRange::new(1.0, 2.0)],
            RecordSource::Gui,
        );
        save_last_affected_ranges(dir.path(), &record).expect("save");

        let loaded = load_last_affected_ranges(dir.path()).expect("record");
        assert_eq!(loaded, record);
        assert_eq!(loaded.source, RecordSource::Gui);
        assert!(last_affected_ranges_path(dir.path()).exists());
    }

    #[test]
    fn should_read_a_record_written_before_records_named_their_surface() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = last_affected_ranges_path(dir.path());
        std::fs::create_dir_all(path.parent().expect("cache dir")).expect("create");
        // The file is a cache entry that survives an upgrade, so a record with
        // no `source` has to keep working — as an unnamed surface, not as a
        // parse failure that silently reads as "nothing recorded".
        std::fs::write(
            &path,
            r#"{"sequenceId":"seq-1","opIds":["op-1"],"affectedRanges":[{"startSec":1.0,"endSec":2.0}],"recordedAt":"2026-01-01T00:00:00Z"}"#,
        )
        .expect("write legacy record");

        let loaded = load_last_affected_ranges(dir.path()).expect("a legacy record still parses");
        assert_eq!(loaded.op_ids, vec!["op-1".to_string()]);
        assert_eq!(loaded.source, RecordSource::Unknown);
    }
}
