//! Caption Commands Module
//!
//! Implements caption editing commands.
//! Currently captions are represented as `Clip` entries inside `TrackKind::Caption` tracks,
//! with `Clip.label` used as the caption text.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use crate::core::{
    commands::{Command, CommandResult, StateChange},
    project::ProjectState,
    timeline::{Clip, ClipPlace, ClipRange, TimelineClock},
    ClipId, CoreError, CoreResult, Ratio, SequenceId, TimeSec, TrackId,
};

const CAPTION_ASSET_ID: &str = "caption";

/// Minimum on-screen duration (seconds) for an imported caption cue.
///
/// Generators occasionally emit extremely short cues that flicker on screen.
/// When there is room before the next cue, a short cue is extended up to this
/// floor without ever creating a new overlap.
const MIN_CAPTION_DURATION_SEC: TimeSec = 0.3;

fn is_valid_time_sec(value: TimeSec) -> bool {
    value.is_finite() && value >= 0.0
}

/// Moves cue boundaries onto the sequence's frame grid, in place.
///
/// A transcriber reports times to the millisecond, and nothing in the caption
/// path rounded them, so every imported cue landed between two frames. Each one
/// then drew a `Clip '…' is not aligned to sequence frame boundaries` warning
/// from every composite and render — forty-one of them on a single talk, enough
/// to bury the warnings that mattered.
///
/// Each cue is snapped on its own and nothing else about it changes:
///
/// * each boundary goes to the nearest frame;
/// * a cue that would collapse — both boundaries rounding to the same frame —
///   is given one frame of length, because a zero-length caption clip is not a
///   caption.
///
/// Cues are **not** compared with each other. A subtitle file is allowed to
/// overlap its cues, and many do: a held `♪` under a whole song, a rolling
/// VTT where every line is still on screen when the next arrives. Serializing
/// those would push every later cue past the held one and rewrite the file into
/// something it never was. Callers that need cues in order and clear of one
/// another call [`keep_cues_ordered_and_non_overlapping`] afterwards; the
/// generated-captions import does, because its cues were already de-overlapped
/// before rounding could nudge two of them back together.
///
/// `cues` need not arrive sorted, and their order is untouched.
///
/// Returns how many cues moved.
pub fn snap_cue_times_to_frame_grid(cues: &mut [(TimeSec, TimeSec)], fps: &Ratio) -> usize {
    let clock = TimelineClock::new(fps.clone());
    let mut moved = 0usize;

    for cue in cues.iter_mut() {
        let (start_sec, end_sec) = *cue;

        let start_frame = clock.seconds_to_nearest_frame(start_sec);
        let end_frame = clock.seconds_to_nearest_frame(end_sec).max(start_frame + 1);

        let snapped = (
            clock.frame_to_seconds(start_frame),
            clock.frame_to_seconds(end_frame),
        );
        if snapped.0 != start_sec || snapped.1 != end_sec {
            moved += 1;
        }
        *cue = snapped;
    }

    moved
}

/// How far the ordering pass may push a generated cue off its own time.
///
/// The pass separates two cues that rounding put on the same frame by moving
/// the later one forward, and every push raises the floor for the cue after it.
/// A run of cues packed tighter than the frame grid therefore fans out
/// linearly: the twentieth cue of such a run would be nineteen frames late even
/// though rounding moved it by half a frame. Past this many frames the cue is
/// dropped instead — a caption that is nearly a tenth of a second adrift from
/// the speech is worse than one that is missing, and the caller is told how many
/// went rather than left to discover a silent re-timing.
const MAX_SNAP_DISPLACEMENT_FRAMES: i64 = 2;

/// What [`keep_cues_ordered_and_non_overlapping`] did to a cue list.
///
/// Only the losses are reported. How many cues this pass nudged is not a
/// separate number to hand back: [`ImportGeneratedCaptionsCommand::plan`]
/// compares the final times against the ones it started rounding from, so a cue
/// this pass pushed off the grid to clear its neighbour is already counted in
/// that method's `snappedCues`, alongside the cues plain rounding moved.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CueOrderingOutcome {
    /// Indices, in the caller's own order, of the cues the pass gave up on
    /// rather than push more than [`MAX_SNAP_DISPLACEMENT_FRAMES`] off their own
    /// time. Their slots in `cues` are left untouched; the caller removes them.
    pub dropped: Vec<usize>,
}

/// Restores cue ordering and non-overlap on the frame grid, in place.
///
/// Opt-in, and only correct for a cue list that was already ordered and clear of
/// overlap before it was snapped — rounding two neighbours a fraction of a frame
/// apart can put them back on top of each other, and this is the pass that
/// separates them again. Run on cues that genuinely overlap it would serialize
/// them, which is why [`snap_cue_times_to_frame_grid`] no longer does it.
///
/// Walking the cues in time order restores three invariants in one pass:
///
/// * every cue lasts at least one frame;
/// * no cue ends after the next one starts (touching is allowed — it is exactly
///   what the overlap clamp in [`ImportGeneratedCaptionsCommand::enforce_readability`]
///   already produces);
/// * ordering survives. Two cues less than a frame apart both want the frame the
///   earlier one had to keep whole; the later one is pushed off it rather than
///   dropped, which moves a cue's start by under a frame but never loses a line.
///
/// The push is bounded. Each cue is placed relative to where rounding wanted it,
/// and one that would have to move more than [`MAX_SNAP_DISPLACEMENT_FRAMES`] to
/// stay clear of its neighbours is dropped instead of dragged along; without
/// that bound a run of cues packed tighter than the frame grid fans out, each
/// one later than the last. Dropped cues are named in the outcome.
///
/// Each surviving cue is written back to the slot it came in, so the caller's
/// order is untouched.
pub fn keep_cues_ordered_and_non_overlapping(
    cues: &mut [(TimeSec, TimeSec)],
    fps: &Ratio,
) -> CueOrderingOutcome {
    let clock = TimelineClock::new(fps.clone());
    let mut outcome = CueOrderingOutcome::default();

    let mut order = (0..cues.len()).collect::<Vec<_>>();
    order.sort_by(|left, right| {
        cues[*left]
            .0
            .total_cmp(&cues[*right].0)
            .then_with(|| cues[*left].1.total_cmp(&cues[*right].1))
    });

    // The first frame the next cue may start on. Advancing it as cues are placed
    // is what keeps the pass single and the result non-overlapping.
    let mut earliest_start_frame = 0i64;

    for index in order {
        let (start_sec, end_sec) = cues[index];

        let wanted_start_frame = clock.seconds_to_nearest_frame(start_sec);
        let start_frame = wanted_start_frame.max(earliest_start_frame);
        if start_frame - wanted_start_frame > MAX_SNAP_DISPLACEMENT_FRAMES {
            // Dropped rather than dragged: the floor stays where it is, so this
            // cue does not push the next one any further either.
            outcome.dropped.push(index);
            continue;
        }
        let end_frame = clock.seconds_to_nearest_frame(end_sec).max(start_frame + 1);

        let snapped = (
            clock.frame_to_seconds(start_frame),
            clock.frame_to_seconds(end_frame),
        );
        earliest_start_frame = end_frame;
        cues[index] = snapped;
    }

    outcome
}

fn normalize_caption_text(text: String) -> Option<String> {
    let trimmed = text.trim_matches(['\u{FEFF}', '\u{0000}']);
    if trimmed.is_empty() {
        None
    } else if trimmed.len() == text.len() {
        Some(text)
    } else {
        Some(trimmed.to_string())
    }
}

fn normalize_generated_caption_text(text: &str) -> Option<String> {
    let trimmed = text
        .trim_matches(['\u{FEFF}', '\u{0000}'])
        .trim()
        .to_string();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

// =============================================================================
// CreateCaptionCommand
// =============================================================================

/// Command to create a caption clip on a caption track.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateCaptionCommand {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    pub start_sec: TimeSec,
    pub end_sec: TimeSec,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub style: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub position: Option<serde_json::Value>,
    #[serde(skip)]
    created_caption_id: Option<ClipId>,
}

impl CreateCaptionCommand {
    pub fn new(sequence_id: &str, track_id: &str, start_sec: TimeSec, end_sec: TimeSec) -> Self {
        Self {
            sequence_id: sequence_id.to_string(),
            track_id: track_id.to_string(),
            start_sec,
            end_sec,
            text: String::new(),
            style: None,
            position: None,
            created_caption_id: None,
        }
    }

    pub fn with_text(mut self, text: impl Into<String>) -> Self {
        self.text = text.into();
        self
    }

    pub fn with_style(mut self, style: Option<serde_json::Value>) -> Self {
        self.style = style;
        self
    }

    pub fn with_position(mut self, position: Option<serde_json::Value>) -> Self {
        self.position = position;
        self
    }
}

impl Command for CreateCaptionCommand {
    fn execute(&mut self, state: &mut ProjectState) -> CoreResult<CommandResult> {
        if !is_valid_time_sec(self.start_sec) || !is_valid_time_sec(self.end_sec) {
            return Err(CoreError::ValidationError(
                "Caption time range must be finite and non-negative".to_string(),
            ));
        }
        if self.start_sec >= self.end_sec {
            return Err(CoreError::InvalidTimeRange(self.start_sec, self.end_sec));
        }

        let sequence = state
            .sequences
            .get_mut(&self.sequence_id)
            .ok_or_else(|| CoreError::SequenceNotFound(self.sequence_id.clone()))?;
        let track = sequence
            .get_track_mut(&self.track_id)
            .ok_or_else(|| CoreError::TrackNotFound(self.track_id.clone()))?;
        if !track.is_caption() {
            return Err(CoreError::ValidationError(format!(
                "Track is not a caption track: {}",
                self.track_id
            )));
        }

        let duration = self.end_sec - self.start_sec;
        let mut clip = Clip::new(CAPTION_ASSET_ID);
        clip.speed = 1.0;
        clip.place = ClipPlace::new(self.start_sec, duration);
        clip.range = ClipRange::new(0.0, duration);
        clip.label = normalize_caption_text(std::mem::take(&mut self.text));
        clip.caption_style = self.style.clone().filter(|style| !style.is_null());
        clip.caption_position = self.position.clone().filter(|position| !position.is_null());

        let caption_id = clip.id.clone();
        self.created_caption_id = Some(caption_id.clone());
        track.add_clip(clip);

        let op_id = ulid::Ulid::new().to_string();
        Ok(CommandResult::new(&op_id)
            .with_change(StateChange::CaptionCreated {
                caption_id: caption_id.clone(),
            })
            .with_created_id(&caption_id))
    }

    fn undo(&self, state: &mut ProjectState) -> CoreResult<()> {
        let Some(caption_id) = self.created_caption_id.as_deref() else {
            return Ok(());
        };

        if let Some(sequence) = state.sequences.get_mut(&self.sequence_id) {
            if let Some(track) = sequence.get_track_mut(&self.track_id) {
                track.remove_clip(&caption_id.to_string());
            }
        }
        Ok(())
    }

    fn type_name(&self) -> &'static str {
        "CreateCaption"
    }

    fn to_json(&self) -> serde_json::Value {
        serde_json::to_value(self).unwrap_or(serde_json::json!({}))
    }
}

// =============================================================================
// ImportGeneratedCaptionsCommand
// =============================================================================

/// A generated-caption import as planned, before anything is placed.
///
/// The counts are what the caller reports: a snap rewrites times the caller
/// supplied, and a drop loses a line outright, so neither may happen silently.
#[derive(Clone, Debug)]
pub struct GeneratedCaptionPlan {
    /// The cues that will be placed, in time order.
    pub segments: Vec<GeneratedCaptionSegment>,
    /// How many of them the frame grid moved.
    pub snapped_cues: usize,
    /// How many cues the grid dropped rather than push more than
    /// [`MAX_SNAP_DISPLACEMENT_FRAMES`] off their own time.
    pub dropped_cues: usize,
}

/// A single segment produced by speech-to-text or another caption generator.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedCaptionSegment {
    #[serde(alias = "startTime", alias = "start")]
    pub start_sec: TimeSec,
    #[serde(alias = "endTime", alias = "end")]
    pub end_sec: TimeSec,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f64>,
    #[serde(alias = "speakerId", skip_serializing_if = "Option::is_none")]
    pub speaker: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
}

impl GeneratedCaptionSegment {
    pub fn new(start_sec: TimeSec, end_sec: TimeSec, text: impl Into<String>) -> Self {
        Self {
            start_sec,
            end_sec,
            text: text.into(),
            confidence: None,
            speaker: None,
            language: None,
        }
    }
}

/// Command to import generated captions as one atomic edit operation.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportGeneratedCaptionsCommand {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    pub segments: Vec<GeneratedCaptionSegment>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub style: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub position: Option<serde_json::Value>,
    #[serde(default)]
    pub replace_existing: bool,
    /// Whether cue boundaries are moved onto the sequence's frame grid.
    ///
    /// On by default: a transcriber's millisecond times otherwise land between
    /// frames and make every composite and render warn about each cue. Turn it
    /// off to keep the raw times.
    #[serde(default = "default_snap_to_frames")]
    pub snap_to_frames: bool,
    #[serde(skip)]
    created_caption_ids: Vec<ClipId>,
    #[serde(skip)]
    removed_clips: Vec<(usize, Clip)>,
}

fn default_snap_to_frames() -> bool {
    true
}

impl ImportGeneratedCaptionsCommand {
    pub fn new(sequence_id: &str, track_id: &str, segments: Vec<GeneratedCaptionSegment>) -> Self {
        Self {
            sequence_id: sequence_id.to_string(),
            track_id: track_id.to_string(),
            segments,
            style: None,
            position: None,
            replace_existing: false,
            snap_to_frames: true,
            created_caption_ids: Vec::new(),
            removed_clips: Vec::new(),
        }
    }

    pub fn with_style(mut self, style: Option<serde_json::Value>) -> Self {
        self.style = style;
        self
    }

    pub fn with_position(mut self, position: Option<serde_json::Value>) -> Self {
        self.position = position;
        self
    }

    pub fn replace_existing(mut self, replace_existing: bool) -> Self {
        self.replace_existing = replace_existing;
        self
    }

    /// Keeps the cues' raw times instead of snapping them to the frame grid.
    pub fn snap_to_frames(mut self, snap_to_frames: bool) -> Self {
        self.snap_to_frames = snap_to_frames;
        self
    }

    /// Resolves the cues this import will place, without touching the project.
    ///
    /// Validation, ordering, the readability rules and — when `snap_to_frames`
    /// — frame-grid snapping, in that order. `execute` runs exactly this, so a
    /// caller can plan twice, with and without snapping, to report how many cues
    /// the snap moved.
    pub fn plan_segments(
        &self,
        fps: &Ratio,
        snap_to_frames: bool,
    ) -> CoreResult<Vec<GeneratedCaptionSegment>> {
        Ok(self.plan(fps, snap_to_frames)?.segments)
    }

    /// Plans the import and reports what the frame grid did to it.
    ///
    /// Same arithmetic as [`Self::plan_segments`], with the two numbers the
    /// caller has to be able to report: how many placed cues the grid moved, and
    /// how many it gave up on. Counting by planning twice is not possible once
    /// cues can be dropped — the two plans no longer line up cue for cue.
    ///
    /// Both counts are measured against the times [`Self::normalized_segments`]
    /// produced, *after* validation, sorting and the readability re-timing —
    /// not against the times the caller handed in. A cue that readability
    /// already moved and that then lands on a frame boundary counts as
    /// unsnapped, because neither the grid nor the ordering pass touched it. So
    /// `snappedCues` answers "how many cues did putting this list on the frame
    /// grid move" — counting both the cues rounding moved and the cues
    /// [`keep_cues_ordered_and_non_overlapping`] then pushed further to keep
    /// them clear of a neighbour — not "how many cues differ from where the
    /// file put them".
    pub fn plan(&self, fps: &Ratio, snap_to_frames: bool) -> CoreResult<GeneratedCaptionPlan> {
        let segments = self.normalized_segments()?;
        if !snap_to_frames {
            return Ok(GeneratedCaptionPlan {
                segments,
                snapped_cues: 0,
                dropped_cues: 0,
            });
        }

        let unsnapped = segments
            .iter()
            .map(|segment| (segment.start_sec, segment.end_sec))
            .collect::<Vec<_>>();
        let mut times = unsnapped.clone();
        snap_cue_times_to_frame_grid(&mut times, fps);
        // These cues left `enforce_readability` ordered and clear of one
        // another; rounding can put two neighbours back on the same frame,
        // so the invariant is restored rather than assumed.
        let outcome = keep_cues_ordered_and_non_overlapping(&mut times, fps);
        let dropped = outcome.dropped.iter().copied().collect::<HashSet<usize>>();

        let mut planned = Vec::with_capacity(segments.len() - dropped.len());
        let mut snapped_cues = 0usize;
        for (index, mut segment) in segments.into_iter().enumerate() {
            if dropped.contains(&index) {
                continue;
            }
            let (start_sec, end_sec) = times[index];
            if start_sec != unsnapped[index].0 || end_sec != unsnapped[index].1 {
                snapped_cues += 1;
            }
            segment.start_sec = start_sec;
            segment.end_sec = end_sec;
            planned.push(segment);
        }

        Ok(GeneratedCaptionPlan {
            segments: planned,
            snapped_cues,
            dropped_cues: dropped.len(),
        })
    }

    fn normalized_segments(&self) -> CoreResult<Vec<GeneratedCaptionSegment>> {
        if self.segments.is_empty() {
            return Err(CoreError::ValidationError(
                "Generated caption import requires at least one segment".to_string(),
            ));
        }

        let mut segments = Vec::with_capacity(self.segments.len());
        for (index, segment) in self.segments.iter().enumerate() {
            if !is_valid_time_sec(segment.start_sec) || !is_valid_time_sec(segment.end_sec) {
                return Err(CoreError::ValidationError(format!(
                    "Generated caption segment {} time range must be finite and non-negative",
                    index + 1
                )));
            }
            if segment.start_sec >= segment.end_sec {
                return Err(CoreError::InvalidTimeRange(
                    segment.start_sec,
                    segment.end_sec,
                ));
            }

            let text = normalize_generated_caption_text(&segment.text).ok_or_else(|| {
                CoreError::ValidationError(format!(
                    "Generated caption segment {} text cannot be empty",
                    index + 1
                ))
            })?;

            let mut normalized = segment.clone();
            normalized.text = text;
            segments.push(normalized);
        }

        segments.sort_by(|left, right| {
            left.start_sec
                .total_cmp(&right.start_sec)
                .then_with(|| left.end_sec.total_cmp(&right.end_sec))
                .then_with(|| left.text.cmp(&right.text))
        });

        Ok(Self::enforce_readability(segments))
    }

    /// Enforces caption readability rules on segments already sorted by start
    /// time. Returns the surviving cues, still sorted by start time.
    ///
    /// Rules (deterministic, conservative, text is never merged):
    /// 1. **No overlap.** Each cue's `end_sec` is clamped to the next cue's
    ///    `start_sec` whenever they overlap.
    /// 2. **Drop collapsed cues.** A cue whose duration becomes non-positive
    ///    after the overlap clamp is dropped.
    /// 3. **Minimum duration floor.** A cue shorter than
    ///    [`MIN_CAPTION_DURATION_SEC`] is extended toward its floor using only
    ///    the room available before the next cue's start; it never creates a new
    ///    overlap. The last cue has unbounded room and is always extended to the
    ///    floor.
    ///
    /// The time-ordering guarantee from the prior sort is preserved: clamping
    /// and extension only ever move an `end_sec` and never reorder cues.
    fn enforce_readability(
        sorted_segments: Vec<GeneratedCaptionSegment>,
    ) -> Vec<GeneratedCaptionSegment> {
        let mut result: Vec<GeneratedCaptionSegment> = Vec::with_capacity(sorted_segments.len());

        for segment in sorted_segments {
            // Step 1 + 2: prevent overlap with the previously kept cue by
            // shrinking the earlier cue's end down to this cue's start. Drop the
            // earlier cue if that collapses it to a non-positive duration.
            if let Some(previous) = result.last_mut() {
                if previous.end_sec > segment.start_sec {
                    previous.end_sec = segment.start_sec;
                    if previous.end_sec <= previous.start_sec {
                        result.pop();
                    }
                }
            }

            // Skip cues that are degenerate on their own before placement.
            if segment.end_sec <= segment.start_sec {
                continue;
            }

            result.push(segment);
        }

        // Step 3: apply the minimum-duration floor using the room before the
        // next cue. Iterate from the end so each cue sees its already-placed
        // successor.
        for index in (0..result.len()).rev() {
            let next_start = result.get(index + 1).map(|next| next.start_sec);
            let segment = &mut result[index];
            let current_duration = segment.end_sec - segment.start_sec;
            if current_duration >= MIN_CAPTION_DURATION_SEC {
                continue;
            }

            let desired_end = segment.start_sec + MIN_CAPTION_DURATION_SEC;
            segment.end_sec = match next_start {
                Some(next) => desired_end.min(next),
                None => desired_end,
            };
        }

        result
    }
}

impl Command for ImportGeneratedCaptionsCommand {
    fn execute(&mut self, state: &mut ProjectState) -> CoreResult<CommandResult> {
        // The cue grid belongs to the sequence, so its rate is read before the
        // mutable borrow the placement below needs.
        let fps = state
            .sequences
            .get(&self.sequence_id)
            .ok_or_else(|| CoreError::SequenceNotFound(self.sequence_id.clone()))?
            .format
            .fps
            .clone();
        // The plan reports what the grid did as it does it: how many cues it
        // moved, and how many it dropped rather than push off their own time.
        let plan = self.plan(&fps, self.snap_to_frames)?;
        let GeneratedCaptionPlan {
            segments,
            snapped_cues,
            dropped_cues,
        } = plan;
        self.created_caption_ids.clear();
        self.removed_clips.clear();

        let sequence = state
            .sequences
            .get_mut(&self.sequence_id)
            .ok_or_else(|| CoreError::SequenceNotFound(self.sequence_id.clone()))?;
        let track = sequence
            .get_track_mut(&self.track_id)
            .ok_or_else(|| CoreError::TrackNotFound(self.track_id.clone()))?;
        if !track.is_caption() {
            return Err(CoreError::ValidationError(format!(
                "Track is not a caption track: {}",
                self.track_id
            )));
        }

        let op_id = ulid::Ulid::new().to_string();
        let mut result = CommandResult::new(&op_id);
        if snapped_cues > 0 || dropped_cues > 0 {
            result = result.with_change(StateChange::CaptionsSnappedToFrameGrid {
                count: snapped_cues,
                dropped: dropped_cues,
            });
        }

        if self.replace_existing {
            self.removed_clips = track.clips.iter().cloned().enumerate().collect();
            for (_, clip) in &self.removed_clips {
                result = result
                    .with_change(StateChange::CaptionDeleted {
                        caption_id: clip.id.clone(),
                    })
                    .with_deleted_id(&clip.id);
            }
            track.clips.clear();
        }

        for segment in segments {
            let duration = segment.end_sec - segment.start_sec;
            let mut clip = Clip::new(CAPTION_ASSET_ID);
            clip.speed = 1.0;
            clip.place = ClipPlace::new(segment.start_sec, duration);
            clip.range = ClipRange::new(0.0, duration);
            clip.label = Some(segment.text);
            clip.caption_style = self.style.clone().filter(|style| !style.is_null());
            clip.caption_position = self.position.clone().filter(|position| !position.is_null());

            let caption_id = clip.id.clone();
            self.created_caption_ids.push(caption_id.clone());
            track.add_clip(clip);
            result = result
                .with_change(StateChange::CaptionCreated {
                    caption_id: caption_id.clone(),
                })
                .with_created_id(&caption_id);
        }

        track.clips.sort_by(|left, right| {
            left.place
                .timeline_in_sec
                .total_cmp(&right.place.timeline_in_sec)
                .then_with(|| {
                    left.place
                        .timeline_out_sec()
                        .total_cmp(&right.place.timeline_out_sec())
                })
                .then_with(|| left.id.cmp(&right.id))
        });

        Ok(result)
    }

    fn undo(&self, state: &mut ProjectState) -> CoreResult<()> {
        let Some(sequence) = state.sequences.get_mut(&self.sequence_id) else {
            return Ok(());
        };
        let Some(track) = sequence.get_track_mut(&self.track_id) else {
            return Ok(());
        };

        for caption_id in &self.created_caption_ids {
            track.remove_clip(caption_id);
        }

        if self.replace_existing {
            for (position, clip) in &self.removed_clips {
                if *position <= track.clips.len() {
                    track.clips.insert(*position, clip.clone());
                } else {
                    track.clips.push(clip.clone());
                }
            }
        }

        Ok(())
    }

    fn type_name(&self) -> &'static str {
        "ImportGeneratedCaptions"
    }

    fn to_json(&self) -> serde_json::Value {
        serde_json::to_value(self).unwrap_or(serde_json::json!({}))
    }
}

// =============================================================================
// DeleteCaptionCommand
// =============================================================================

/// Command to delete a caption clip from a caption track.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteCaptionCommand {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    #[serde(alias = "clipId")]
    pub caption_id: ClipId,
    #[serde(skip)]
    removed_clip: Option<Clip>,
    #[serde(skip)]
    original_position: Option<usize>,
}

impl DeleteCaptionCommand {
    pub fn new(sequence_id: &str, track_id: &str, caption_id: &str) -> Self {
        Self {
            sequence_id: sequence_id.to_string(),
            track_id: track_id.to_string(),
            caption_id: caption_id.to_string(),
            removed_clip: None,
            original_position: None,
        }
    }
}

impl Command for DeleteCaptionCommand {
    fn execute(&mut self, state: &mut ProjectState) -> CoreResult<CommandResult> {
        let sequence = state
            .sequences
            .get_mut(&self.sequence_id)
            .ok_or_else(|| CoreError::SequenceNotFound(self.sequence_id.clone()))?;
        let track = sequence
            .get_track_mut(&self.track_id)
            .ok_or_else(|| CoreError::TrackNotFound(self.track_id.clone()))?;
        if !track.is_caption() {
            return Err(CoreError::ValidationError(format!(
                "Track is not a caption track: {}",
                self.track_id
            )));
        }

        let pos = track
            .clips
            .iter()
            .position(|c| c.id == self.caption_id)
            .ok_or_else(|| CoreError::ClipNotFound(self.caption_id.clone()))?;

        self.removed_clip = Some(track.clips[pos].clone());
        self.original_position = Some(pos);
        track.clips.remove(pos);

        let op_id = ulid::Ulid::new().to_string();
        Ok(CommandResult::new(&op_id)
            .with_change(StateChange::CaptionDeleted {
                caption_id: self.caption_id.clone(),
            })
            .with_deleted_id(&self.caption_id))
    }

    fn undo(&self, state: &mut ProjectState) -> CoreResult<()> {
        let (Some(clip), Some(position)) = (&self.removed_clip, self.original_position) else {
            return Ok(());
        };

        if let Some(sequence) = state.sequences.get_mut(&self.sequence_id) {
            if let Some(track) = sequence.get_track_mut(&self.track_id) {
                if position <= track.clips.len() {
                    track.clips.insert(position, clip.clone());
                } else {
                    track.clips.push(clip.clone());
                }
            }
        }
        Ok(())
    }

    fn type_name(&self) -> &'static str {
        "DeleteCaption"
    }

    fn to_json(&self) -> serde_json::Value {
        serde_json::to_value(self).unwrap_or(serde_json::json!({}))
    }
}

// =============================================================================
// UpdateCaptionCommand
// =============================================================================

/// Command to update a caption clip's text and/or time range.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCaptionCommand {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    #[serde(alias = "clipId")]
    pub caption_id: ClipId,
    pub text: Option<String>,
    pub start_sec: Option<TimeSec>,
    pub end_sec: Option<TimeSec>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub style: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub position: Option<serde_json::Value>,
    #[serde(skip)]
    old_label: Option<Option<String>>,
    #[serde(skip)]
    old_place: Option<ClipPlace>,
    #[serde(skip)]
    old_range: Option<ClipRange>,
    #[serde(skip)]
    old_style: Option<Option<serde_json::Value>>,
    #[serde(skip)]
    old_position: Option<Option<serde_json::Value>>,
}

impl UpdateCaptionCommand {
    pub fn new(sequence_id: &str, track_id: &str, caption_id: &str) -> Self {
        Self {
            sequence_id: sequence_id.to_string(),
            track_id: track_id.to_string(),
            caption_id: caption_id.to_string(),
            text: None,
            start_sec: None,
            end_sec: None,
            style: None,
            position: None,
            old_label: None,
            old_place: None,
            old_range: None,
            old_style: None,
            old_position: None,
        }
    }

    pub fn with_text(mut self, text: Option<String>) -> Self {
        self.text = text;
        self
    }

    pub fn with_time_range(mut self, start_sec: Option<TimeSec>, end_sec: Option<TimeSec>) -> Self {
        self.start_sec = start_sec;
        self.end_sec = end_sec;
        self
    }

    pub fn with_style(mut self, style: Option<serde_json::Value>) -> Self {
        self.style = style;
        self
    }

    pub fn with_position(mut self, position: Option<serde_json::Value>) -> Self {
        self.position = position;
        self
    }
}

impl Command for UpdateCaptionCommand {
    fn execute(&mut self, state: &mut ProjectState) -> CoreResult<CommandResult> {
        tracing::debug!(
            sequence_id = %self.sequence_id,
            track_id = %self.track_id,
            caption_id = %self.caption_id,
            has_text = self.text.is_some(),
            has_time_range = self.start_sec.is_some() || self.end_sec.is_some(),
            has_style = self.style.is_some(),
            has_position = self.position.is_some(),
            "Updating caption"
        );

        let sequence = state
            .sequences
            .get_mut(&self.sequence_id)
            .ok_or_else(|| CoreError::SequenceNotFound(self.sequence_id.clone()))?;
        let track = sequence
            .get_track_mut(&self.track_id)
            .ok_or_else(|| CoreError::TrackNotFound(self.track_id.clone()))?;
        if !track.is_caption() {
            return Err(CoreError::ValidationError(format!(
                "Track is not a caption track: {}",
                self.track_id
            )));
        }

        let clip = track
            .get_clip_mut(&self.caption_id)
            .ok_or_else(|| CoreError::ClipNotFound(self.caption_id.clone()))?;

        self.old_label = Some(clip.label.clone());
        self.old_place = Some(clip.place.clone());
        self.old_range = Some(clip.range.clone());
        self.old_style = Some(clip.caption_style.clone());
        self.old_position = Some(clip.caption_position.clone());

        clip.speed = 1.0;

        if let Some(text) = self.text.clone() {
            clip.label = normalize_caption_text(text);
        }

        if self.start_sec.is_some() || self.end_sec.is_some() {
            let old_start = clip.place.timeline_in_sec;
            let old_end = clip.place.timeline_out_sec();

            let new_start = self.start_sec.unwrap_or(old_start);
            let new_end = self.end_sec.unwrap_or(old_end);

            if !is_valid_time_sec(new_start) || !is_valid_time_sec(new_end) {
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

        if let Some(style) = self.style.clone() {
            clip.caption_style = if style.is_null() { None } else { Some(style) };
        }

        if let Some(position) = self.position.clone() {
            clip.caption_position = if position.is_null() {
                None
            } else {
                Some(position)
            };
        }

        let op_id = ulid::Ulid::new().to_string();
        Ok(
            CommandResult::new(&op_id).with_change(StateChange::CaptionModified {
                caption_id: self.caption_id.clone(),
            }),
        )
    }

    fn undo(&self, state: &mut ProjectState) -> CoreResult<()> {
        let Some(sequence) = state.sequences.get_mut(&self.sequence_id) else {
            return Ok(());
        };
        let Some(track) = sequence.get_track_mut(&self.track_id) else {
            return Ok(());
        };
        let Some(clip) = track.get_clip_mut(&self.caption_id) else {
            return Ok(());
        };

        if let Some(old_label) = &self.old_label {
            clip.label = old_label.clone();
        }
        if let Some(old_place) = &self.old_place {
            clip.place = old_place.clone();
        }
        if let Some(old_range) = &self.old_range {
            clip.range = old_range.clone();
        }
        if let Some(old_style) = &self.old_style {
            clip.caption_style = old_style.clone();
        }
        if let Some(old_position) = &self.old_position {
            clip.caption_position = old_position.clone();
        }

        Ok(())
    }

    fn type_name(&self) -> &'static str {
        "UpdateCaption"
    }

    fn to_json(&self) -> serde_json::Value {
        serde_json::to_value(self).unwrap_or(serde_json::json!({}))
    }
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::timeline::{Sequence, SequenceFormat, Track};

    fn state_with_caption_track() -> (ProjectState, String, String) {
        state_with_caption_track_at(SequenceFormat::youtube_1080())
    }

    /// A project holding one empty caption track in a sequence of this format.
    fn state_with_caption_track_at(format: SequenceFormat) -> (ProjectState, String, String) {
        let mut state = ProjectState::new_empty("Test");
        let mut sequence = Sequence::new("Sequence 1", format);
        let track = Track::new_caption("Captions");
        let seq_id = sequence.id.clone();
        let track_id = track.id.clone();
        sequence.add_track(track);
        state.active_sequence_id = Some(seq_id.clone());
        state.sequences.insert(seq_id.clone(), sequence);
        (state, seq_id, track_id)
    }

    /// 1920x1080 at exactly 24 fps, where one frame is 1/24 s.
    fn format_24fps() -> SequenceFormat {
        SequenceFormat::new(1920, 1080, 24, 1, 48_000)
    }

    /// Whether a time sits on the frame grid, to within a frame's rounding.
    fn is_on_frame_grid(seconds: TimeSec, fps: &Ratio) -> bool {
        let clock = TimelineClock::new(fps.clone());
        let frame = clock.seconds_to_nearest_frame(seconds);
        (clock.frame_to_seconds(frame) - seconds).abs() < 1e-9
    }

    #[test]
    fn snap_cue_times_moves_every_boundary_onto_the_frame_grid() {
        let fps = Ratio::new(24, 1);
        let mut cues = vec![(0.123, 1.987), (2.004, 3.5), (4.0, 4.9)];

        let moved = snap_cue_times_to_frame_grid(&mut cues, &fps);

        assert_eq!(moved, 3);
        for (start_sec, end_sec) in &cues {
            assert!(is_on_frame_grid(*start_sec, &fps), "start {start_sec}");
            assert!(is_on_frame_grid(*end_sec, &fps), "end {end_sec}");
            assert!(end_sec > start_sec);
        }
    }

    #[test]
    fn snap_cue_times_reports_nothing_moved_when_cues_are_already_aligned() {
        let fps = Ratio::new(24, 1);
        let mut cues = vec![(0.0, 1.0), (1.0, 2.0)];

        assert_eq!(snap_cue_times_to_frame_grid(&mut cues, &fps), 0);
        assert_eq!(cues, vec![(0.0, 1.0), (1.0, 2.0)]);
    }

    #[test]
    fn snap_cue_times_keeps_a_cue_at_least_one_frame_long() {
        // Both boundaries round to frame 24; a cue that collapsed would take a
        // caption clip's duration to zero.
        let fps = Ratio::new(24, 1);
        let mut cues = vec![(1.0, 1.001)];

        snap_cue_times_to_frame_grid(&mut cues, &fps);

        assert_eq!(cues[0].0, 1.0);
        assert!((cues[0].1 - 25.0 / 24.0).abs() < 1e-9);
    }

    #[test]
    fn snap_cue_times_leaves_overlapping_cues_overlapping() {
        // A held cue under a whole song, with dialogue running underneath it.
        // Serializing these would push every line of dialogue past the held cue
        // and turn each into a one-frame flash.
        let fps = Ratio::new(24, 1);
        let mut cues = vec![(0.001, 600.002), (1.003, 3.004), (3.005, 5.006)];

        snap_cue_times_to_frame_grid(&mut cues, &fps);

        assert!((cues[0].0 - 0.0).abs() < 1e-9, "{cues:?}");
        assert!((cues[0].1 - 600.0).abs() < 1e-9, "{cues:?}");
        // The dialogue keeps its own place under the held cue.
        assert!(cues[1].0 < cues[0].1, "{cues:?}");
        assert!((cues[1].0 - 24.0 / 24.0).abs() < 1e-9, "{cues:?}");
        assert!((cues[2].0 - 72.0 / 24.0).abs() < 1e-9, "{cues:?}");
        for (start_sec, end_sec) in &cues {
            assert!(is_on_frame_grid(*start_sec, &fps));
            assert!(is_on_frame_grid(*end_sec, &fps));
            assert!(end_sec - start_sec >= 1.0 / 24.0 - 1e-9, "{cues:?}");
        }
    }

    #[test]
    fn snap_cue_times_handles_cues_that_arrive_out_of_order() {
        // A subtitle file can list cues in any order, and `caption import`
        // hands them over as parsed. Snapping must not read the file's order as
        // time order and push a later-listed early cue past a whole cue.
        let fps = Ratio::new(24, 1);
        let mut cues = vec![(4.01, 5.01), (0.01, 1.01)];

        snap_cue_times_to_frame_grid(&mut cues, &fps);

        // Each cue stays in the slot it came in, snapped to its own frames.
        assert!(is_on_frame_grid(cues[0].0, &fps));
        assert!((cues[0].0 - 96.0 / 24.0).abs() < 1e-9, "{cues:?}");
        assert!((cues[1].0 - 0.0).abs() < 1e-9, "{cues:?}");
        assert!(cues[1].1 < cues[0].0, "{cues:?}");
    }

    #[test]
    fn ordering_pass_keeps_neighbours_ordered_and_non_overlapping() {
        // Two cues barely apart round onto the same pair of frames. The second
        // is pushed off the frame the first had to keep, rather than dropped.
        let fps = Ratio::new(24, 1);
        let mut cues = vec![(1.0, 1.004), (1.008, 1.02)];

        snap_cue_times_to_frame_grid(&mut cues, &fps);
        keep_cues_ordered_and_non_overlapping(&mut cues, &fps);

        assert!(cues[0].1 > cues[0].0);
        assert!(cues[1].1 > cues[1].0);
        assert!(cues[1].0 >= cues[0].1, "{cues:?}");
        for (start_sec, end_sec) in &cues {
            assert!(is_on_frame_grid(*start_sec, &fps));
            assert!(is_on_frame_grid(*end_sec, &fps));
        }
    }

    #[test]
    fn ordering_pass_reads_time_order_rather_than_slot_order() {
        // The pass sorts by time before it walks, so a file that lists a late
        // cue first is not read as "this one comes first".
        let fps = Ratio::new(24, 1);
        let mut cues = vec![(4.0, 5.0), (0.0, 1.0)];

        assert_eq!(
            keep_cues_ordered_and_non_overlapping(&mut cues, &fps),
            CueOrderingOutcome::default()
        );
        assert_eq!(cues, vec![(4.0, 5.0), (0.0, 1.0)]);
    }

    #[test]
    fn import_generated_captions_places_clips_on_the_frame_grid() {
        let (mut state, seq_id, track_id) = state_with_caption_track_at(format_24fps());
        let fps = Ratio::new(24, 1);
        let segments = vec![
            GeneratedCaptionSegment::new(0.137, 2.418, "First"),
            GeneratedCaptionSegment::new(2.511, 5.049, "Second"),
        ];

        let mut cmd = ImportGeneratedCaptionsCommand::new(&seq_id, &track_id, segments);
        cmd.execute(&mut state).expect("import");

        let track = state
            .get_sequence(&seq_id)
            .unwrap()
            .get_track(&track_id)
            .unwrap();
        assert_eq!(track.clips.len(), 2);
        for clip in &track.clips {
            assert!(is_on_frame_grid(clip.place.timeline_in_sec, &fps));
            assert!(is_on_frame_grid(clip.place.timeline_out_sec(), &fps));
            assert!(clip.place.duration_sec >= 1.0 / 24.0 - 1e-9);
        }
        assert!(track.clips[1].place.timeline_in_sec >= track.clips[0].place.timeline_out_sec());
    }

    #[test]
    fn import_generated_captions_separates_cues_that_rounding_pushed_together() {
        // Both cues want frame 24 once the readability rules and rounding are
        // through. The generated path is the one that de-overlaps beforehand, so
        // it is the one that runs the ordering pass and pushes the second off.
        let (mut state, seq_id, track_id) = state_with_caption_track_at(format_24fps());
        let segments = vec![
            GeneratedCaptionSegment::new(1.0, 1.004, "First"),
            GeneratedCaptionSegment::new(1.008, 1.02, "Second"),
        ];

        let mut cmd = ImportGeneratedCaptionsCommand::new(&seq_id, &track_id, segments);
        cmd.execute(&mut state).expect("import");

        let track = state
            .get_sequence(&seq_id)
            .unwrap()
            .get_track(&track_id)
            .unwrap();
        assert_eq!(track.clips.len(), 2);
        assert!(
            track.clips[1].place.timeline_in_sec >= track.clips[0].place.timeline_out_sec(),
            "{:?}",
            track.clips
        );
        for clip in &track.clips {
            assert!(clip.place.duration_sec >= 1.0 / 24.0 - 1e-9);
        }
    }

    #[test]
    fn import_generated_captions_keeps_raw_times_when_snapping_is_off() {
        let (mut state, seq_id, track_id) = state_with_caption_track_at(format_24fps());
        let segments = vec![GeneratedCaptionSegment::new(0.137, 2.418, "First")];

        let mut cmd =
            ImportGeneratedCaptionsCommand::new(&seq_id, &track_id, segments).snap_to_frames(false);
        cmd.execute(&mut state).expect("import");

        let track = state
            .get_sequence(&seq_id)
            .unwrap()
            .get_track(&track_id)
            .unwrap();
        assert_eq!(track.clips[0].place.timeline_in_sec, 0.137);
        assert!((track.clips[0].place.timeline_out_sec() - 2.418).abs() < 1e-9);
    }

    #[test]
    fn plan_segments_reports_the_same_cues_the_import_places() {
        let (mut state, seq_id, track_id) = state_with_caption_track_at(format_24fps());
        let fps = Ratio::new(24, 1);
        let segments = vec![
            GeneratedCaptionSegment::new(0.137, 2.418, "First"),
            GeneratedCaptionSegment::new(2.511, 5.049, "Second"),
        ];

        let mut cmd = ImportGeneratedCaptionsCommand::new(&seq_id, &track_id, segments);
        let planned = cmd.plan_segments(&fps, true).expect("plan");
        cmd.execute(&mut state).expect("import");

        let track = state
            .get_sequence(&seq_id)
            .unwrap()
            .get_track(&track_id)
            .unwrap();
        assert_eq!(planned.len(), track.clips.len());
        for (segment, clip) in planned.iter().zip(&track.clips) {
            assert_eq!(segment.start_sec, clip.place.timeline_in_sec);
            assert!((segment.end_sec - clip.place.timeline_out_sec()).abs() < 1e-9);
        }
    }

    #[test]
    fn import_generated_captions_creates_sorted_caption_clips() {
        let (mut state, seq_id, track_id) = state_with_caption_track();
        let style = serde_json::json!({ "fontSize": 48 });
        let position = serde_json::json!({ "type": "preset", "vertical": "bottom" });
        let mut cmd = ImportGeneratedCaptionsCommand::new(
            &seq_id,
            &track_id,
            vec![
                GeneratedCaptionSegment::new(2.0, 3.0, "Second"),
                GeneratedCaptionSegment::new(0.0, 1.5, " First "),
            ],
        )
        .with_style(Some(style.clone()))
        .with_position(Some(position.clone()));

        let result = cmd.execute(&mut state).unwrap();

        assert_eq!(result.created_ids.len(), 2);
        let sequence = state.get_sequence(&seq_id).unwrap();
        let track = sequence.get_track(&track_id).unwrap();
        assert_eq!(track.clips.len(), 2);
        assert_eq!(track.clips[0].label.as_deref(), Some("First"));
        assert_eq!(track.clips[0].caption_style, Some(style));
        assert_eq!(track.clips[0].caption_position, Some(position));
        assert_eq!(track.clips[1].label.as_deref(), Some("Second"));
    }

    #[test]
    fn import_generated_captions_can_replace_existing_captions_and_undo() {
        let (mut state, seq_id, track_id) = state_with_caption_track();
        let existing_id = {
            let sequence = state.sequences.get_mut(&seq_id).unwrap();
            let track = sequence.get_track_mut(&track_id).unwrap();
            let mut clip = Clip::new(CAPTION_ASSET_ID);
            clip.label = Some("Old".to_string());
            clip.place = ClipPlace::new(0.0, 1.0);
            clip.range = ClipRange::new(0.0, 1.0);
            let id = clip.id.clone();
            track.add_clip(clip);
            id
        };

        let mut cmd = ImportGeneratedCaptionsCommand::new(
            &seq_id,
            &track_id,
            vec![GeneratedCaptionSegment::new(1.0, 2.0, "New")],
        )
        .replace_existing(true);

        let result = cmd.execute(&mut state).unwrap();
        assert_eq!(result.deleted_ids, vec![existing_id.clone()]);
        assert_eq!(result.created_ids.len(), 1);
        {
            let sequence = state.get_sequence(&seq_id).unwrap();
            let track = sequence.get_track(&track_id).unwrap();
            assert_eq!(track.clips.len(), 1);
            assert_eq!(track.clips[0].label.as_deref(), Some("New"));
        }

        cmd.undo(&mut state).unwrap();
        let sequence = state.get_sequence(&seq_id).unwrap();
        let track = sequence.get_track(&track_id).unwrap();
        assert_eq!(track.clips.len(), 1);
        assert_eq!(track.clips[0].id, existing_id);
        assert_eq!(track.clips[0].label.as_deref(), Some("Old"));
    }

    #[test]
    fn import_generated_captions_clamps_overlapping_cues() {
        let (mut state, seq_id, track_id) = state_with_caption_track();
        // Second cue starts before the first ends; the first must be clamped.
        let mut cmd = ImportGeneratedCaptionsCommand::new(
            &seq_id,
            &track_id,
            vec![
                GeneratedCaptionSegment::new(0.0, 2.0, "First"),
                GeneratedCaptionSegment::new(1.0, 3.0, "Second"),
            ],
        );

        cmd.execute(&mut state).unwrap();

        let sequence = state.get_sequence(&seq_id).unwrap();
        let track = sequence.get_track(&track_id).unwrap();
        assert_eq!(track.clips.len(), 2);
        // First clamped to start of second (1.0): place 0.0..1.0.
        assert!((track.clips[0].place.timeline_in_sec - 0.0).abs() < 1e-9);
        assert!((track.clips[0].place.timeline_out_sec() - 1.0).abs() < 1e-9);
        // Second unchanged: 1.0..3.0.
        assert!((track.clips[1].place.timeline_in_sec - 1.0).abs() < 1e-9);
        assert!((track.clips[1].place.timeline_out_sec() - 3.0).abs() < 1e-9);
    }

    #[test]
    fn import_generated_captions_drops_fully_covered_cue() {
        let (mut state, seq_id, track_id) = state_with_caption_track();
        // The second cue starts at the same instant as the first, so clamping
        // collapses the first to zero duration and it is dropped.
        let mut cmd = ImportGeneratedCaptionsCommand::new(
            &seq_id,
            &track_id,
            vec![
                GeneratedCaptionSegment::new(0.0, 2.0, "Covered"),
                GeneratedCaptionSegment::new(0.0, 3.0, "Keeper"),
            ],
        );

        cmd.execute(&mut state).unwrap();

        let sequence = state.get_sequence(&seq_id).unwrap();
        let track = sequence.get_track(&track_id).unwrap();
        assert_eq!(track.clips.len(), 1);
        assert_eq!(track.clips[0].label.as_deref(), Some("Keeper"));
    }

    #[test]
    fn import_generated_captions_extends_short_cue_to_min_duration() {
        let (mut state, seq_id, track_id) = state_with_caption_track();
        // A 0.1s cue with ample room before the next cue should be extended to
        // the 0.3s floor.
        let mut cmd = ImportGeneratedCaptionsCommand::new(
            &seq_id,
            &track_id,
            vec![
                GeneratedCaptionSegment::new(0.0, 0.1, "Short"),
                GeneratedCaptionSegment::new(5.0, 6.0, "Later"),
            ],
        );

        cmd.execute(&mut state).unwrap();

        let sequence = state.get_sequence(&seq_id).unwrap();
        let track = sequence.get_track(&track_id).unwrap();
        assert_eq!(track.clips.len(), 2);
        assert!((track.clips[0].place.timeline_out_sec() - 0.3).abs() < 1e-9);
    }

    #[test]
    fn import_generated_captions_limits_min_duration_to_available_room() {
        let (mut state, seq_id, track_id) = state_with_caption_track();
        // A 0.05s cue followed closely by another: extension stops at the next
        // cue's start (0.2s) rather than reaching the 0.3s floor.
        let mut cmd = ImportGeneratedCaptionsCommand::new(
            &seq_id,
            &track_id,
            vec![
                GeneratedCaptionSegment::new(0.0, 0.05, "Tight"),
                GeneratedCaptionSegment::new(0.2, 1.0, "Next"),
            ],
        );

        cmd.execute(&mut state).unwrap();

        let sequence = state.get_sequence(&seq_id).unwrap();
        let track = sequence.get_track(&track_id).unwrap();
        assert_eq!(track.clips.len(), 2);
        // Extended only up to the next cue's start (0.2), never overlapping.
        assert!((track.clips[0].place.timeline_out_sec() - 0.2).abs() < 1e-9);
        assert!((track.clips[1].place.timeline_in_sec - 0.2).abs() < 1e-9);
    }

    #[test]
    fn import_generated_captions_rejects_empty_segment_text() {
        let (mut state, seq_id, track_id) = state_with_caption_track();
        let mut cmd = ImportGeneratedCaptionsCommand::new(
            &seq_id,
            &track_id,
            vec![GeneratedCaptionSegment::new(0.0, 1.0, "   ")],
        );

        let err = cmd.execute(&mut state).unwrap_err();
        assert!(matches!(err, CoreError::ValidationError(_)));
    }

    #[test]
    fn update_caption_updates_label_and_time_range() {
        let mut state = ProjectState::new_empty("Test");
        let mut sequence = Sequence::new("Sequence 1", SequenceFormat::youtube_1080());
        let mut track = Track::new_caption("Captions");

        let mut clip = Clip::new(CAPTION_ASSET_ID);
        clip.label = Some("Old".to_string());
        clip.place = ClipPlace::new(1.0, 2.0);
        clip.range = ClipRange::new(0.0, 2.0);

        let caption_id = clip.id.clone();
        let track_id = track.id.clone();
        track.add_clip(clip);

        let seq_id = sequence.id.clone();
        sequence.add_track(track);
        state.active_sequence_id = Some(seq_id.clone());
        state.sequences.insert(seq_id.clone(), sequence);

        let mut cmd = UpdateCaptionCommand::new(&seq_id, &track_id, &caption_id)
            .with_text(Some("New".to_string()))
            .with_time_range(Some(3.0), Some(5.5));

        cmd.execute(&mut state).unwrap();

        let sequence = state.get_sequence(&seq_id).unwrap();
        let track = sequence.get_track(&track_id).unwrap();
        let clip = track.get_clip(&caption_id).unwrap();

        assert_eq!(clip.label.as_deref(), Some("New"));
        assert_eq!(clip.place.timeline_in_sec, 3.0);
        assert!((clip.place.duration_sec - 2.5).abs() < f64::EPSILON);
    }

    #[test]
    fn update_caption_rejects_end_before_start() {
        let mut state = ProjectState::new_empty("Test");
        let mut sequence = Sequence::new("Sequence 1", SequenceFormat::youtube_1080());
        let mut track = Track::new_caption("Captions");

        let clip = Clip::new(CAPTION_ASSET_ID);
        let caption_id = clip.id.clone();
        let track_id = track.id.clone();
        track.add_clip(clip);

        let seq_id = sequence.id.clone();
        sequence.add_track(track);
        state.active_sequence_id = Some(seq_id.clone());
        state.sequences.insert(seq_id.clone(), sequence);

        let mut cmd = UpdateCaptionCommand::new(&seq_id, &track_id, &caption_id)
            .with_time_range(Some(5.0), Some(3.0));

        let err = cmd.execute(&mut state).unwrap_err();
        assert!(matches!(err, CoreError::InvalidTimeRange(_, _)));
    }

    #[test]
    fn update_caption_rejects_negative_times() {
        let mut state = ProjectState::new_empty("Test");
        let mut sequence = Sequence::new("Sequence 1", SequenceFormat::youtube_1080());
        let mut track = Track::new_caption("Captions");

        let clip = Clip::new(CAPTION_ASSET_ID);
        let caption_id = clip.id.clone();
        let track_id = track.id.clone();
        track.add_clip(clip);

        let seq_id = sequence.id.clone();
        sequence.add_track(track);
        state.active_sequence_id = Some(seq_id.clone());
        state.sequences.insert(seq_id.clone(), sequence);

        let mut cmd = UpdateCaptionCommand::new(&seq_id, &track_id, &caption_id)
            .with_time_range(Some(-1.0), Some(1.0));

        let err = cmd.execute(&mut state).unwrap_err();
        assert!(matches!(err, CoreError::ValidationError(_)));
    }

    /// Feature: generated caption import on the frame grid
    /// Scenario: a run of cues packed tighter than the frame grid
    ///
    /// Given ten cues 10 ms apart on a 24 fps grid, where one frame is 41.7 ms
    /// When the ordering pass separates them
    /// Then no surviving cue sits more than `MAX_SNAP_DISPLACEMENT_FRAMES` from
    /// the frame rounding wanted for it: the pass drops the cues it would
    /// otherwise have dragged, and names them, instead of fanning the whole run
    /// out one frame further with every cue.
    #[test]
    fn ordering_pass_drops_a_cue_rather_than_fan_the_run_out() {
        let fps = Ratio::new(24, 1);
        let clock = TimelineClock::new(fps.clone());
        let mut cues: Vec<(TimeSec, TimeSec)> = (0..10)
            .map(|index| {
                let start_sec = 1.0 + f64::from(index) * 0.01;
                (start_sec, start_sec + 0.008)
            })
            .collect();
        let wanted_frames = cues
            .iter()
            .map(|(start_sec, _)| clock.seconds_to_nearest_frame(*start_sec))
            .collect::<Vec<_>>();

        snap_cue_times_to_frame_grid(&mut cues, &fps);
        let outcome = keep_cues_ordered_and_non_overlapping(&mut cues, &fps);

        assert!(
            !outcome.dropped.is_empty(),
            "ten cues 10 ms apart cannot all hold a whole 41.7 ms frame"
        );
        assert!(
            outcome.dropped.len() < cues.len(),
            "the cap must not empty the run: {outcome:?}"
        );

        let mut previous_end_frame = i64::MIN;
        for (index, (start_sec, end_sec)) in cues.iter().enumerate() {
            if outcome.dropped.contains(&index) {
                continue;
            }
            let start_frame = clock.seconds_to_nearest_frame(*start_sec);
            let end_frame = clock.seconds_to_nearest_frame(*end_sec);
            assert!(
                start_frame - wanted_frames[index] <= MAX_SNAP_DISPLACEMENT_FRAMES,
                "cue {index} was pushed {} frames off {}s: {cues:?}",
                start_frame - wanted_frames[index],
                1.0 + index as f64 * 0.01
            );
            assert!(end_frame > start_frame, "cue {index} collapsed: {cues:?}");
            assert!(
                start_frame >= previous_end_frame,
                "cue {index} overlaps the one before it: {cues:?}"
            );
            previous_end_frame = end_frame;
        }
    }

    /// Feature: generated caption import on the frame grid
    /// Scenario: the import reports what the grid did
    ///
    /// Given a run of cues too tightly packed for the frame grid to keep whole
    /// When they are imported with snapping on
    /// Then the cues the grid dropped are absent from the track and counted in
    /// the state change, so nothing is lost silently.
    #[test]
    fn import_generated_captions_reports_the_cues_the_grid_dropped() {
        let (mut state, seq_id, track_id) = state_with_caption_track_at(format_24fps());
        let segments = (0..10)
            .map(|index| {
                let start_sec = 1.0 + f64::from(index) * 0.01;
                GeneratedCaptionSegment::new(start_sec, start_sec + 0.008, format!("Line {index}"))
            })
            .collect::<Vec<_>>();

        let mut cmd = ImportGeneratedCaptionsCommand::new(&seq_id, &track_id, segments);
        let plan = cmd.plan(&Ratio::new(24, 1), true).expect("plan");
        assert!(plan.dropped_cues > 0, "the fixture has to exercise the cap");

        let result = cmd.execute(&mut state).expect("import");

        let dropped = result
            .changes
            .iter()
            .find_map(|change| match change {
                StateChange::CaptionsSnappedToFrameGrid { dropped, .. } => Some(*dropped),
                _ => None,
            })
            .expect("the import has to report what the grid did");
        assert_eq!(dropped, plan.dropped_cues);
        assert_eq!(result.created_ids.len(), plan.segments.len());

        let track = state
            .get_sequence(&seq_id)
            .expect("sequence")
            .get_track(&track_id)
            .expect("track");
        assert_eq!(track.clips.len(), plan.segments.len());
    }
}
