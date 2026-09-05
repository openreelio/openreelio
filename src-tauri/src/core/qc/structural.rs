//! Structural QC rules
//!
//! Checks that read the project state alone — no render required. They catch
//! the failures that are objectively wrong in the edit itself (holes in the
//! picture, missing media, captions that cannot be read) plus a small number of
//! informational metrics that give an agent something to steer by.
//!
//! Rules that need a rendered file live in [`super::rules`]; this module also
//! hosts [`crossref_black_ranges_with_gaps`], which is where the two halves
//! meet.

use async_trait::async_trait;

use super::caption_group::{group_caption_findings, CaptionFinding, CaptionGroup};
use super::context::QCContext;
use super::engine::QCReport;
use super::rules::{QCRule, RuleConfig};
use super::violation::{merged_span_duration_sec, QCViolation, Severity, ViolationFix};
use crate::core::captions::{CaptionPosition, CaptionStyle, VerticalPosition};
use crate::core::commands::find_gaps;
use crate::core::project::ProjectState;
use crate::core::render::transition_stitch::plan_sequence_transitions;
use crate::core::timeline::{Clip, Sequence, Track};
use crate::core::CoreResult;

/// Asset ID used by caption clips, which have no media file behind them.
///
/// Mirrors `core::commands::caption::CAPTION_ASSET_ID`; duplicated here because
/// QC must not depend on command internals.
const CAPTION_VIRTUAL_ASSET_ID: &str = "caption";

/// Prefix shared by every virtual asset ID (text, compound, adjustment layer).
const VIRTUAL_ASSET_PREFIX: &str = "__";

/// Volume at or below which a clip is treated as inaudible, in dB.
const SILENT_VOLUME_DB: f64 = -60.0;

// =============================================================================
// Shared helpers
// =============================================================================

/// A hole in the picture: a gap on one track that no other track covers.
#[derive(Debug, Clone, PartialEq)]
pub struct UncoveredGap {
    /// Track the gap was found on.
    pub track_id: String,
    /// Track name, for human-readable messages.
    pub track_name: String,
    /// Start of the uncovered span, in timeline seconds.
    pub start_sec: f64,
    /// End of the uncovered span, in timeline seconds.
    pub end_sec: f64,
    /// Start of the enclosing track gap (what [`CloseGap`](crate::core::commands::CloseGapCommand) closes).
    pub gap_start_sec: f64,
    /// End of the enclosing track gap.
    pub gap_end_sec: f64,
    /// Whether rippling this one track's later clips left would remove the hole.
    ///
    /// True only for a hole between two clips on the same track, which is the
    /// edit [`CloseGap`](crate::core::commands::CloseGapCommand) performs. The
    /// head and tail of the program are both false: a tail hole has nothing to
    /// pull in, and a head hole would ripple a single track to zero while every
    /// other track stayed put. Neither carries a fix.
    pub closable: bool,
}

impl UncoveredGap {
    /// Duration of the uncovered span in seconds.
    pub fn duration_sec(&self) -> f64 {
        self.end_sec - self.start_sec
    }
}

/// Returns whether a clip stands in for something other than imported media.
fn is_virtual_clip(clip: &Clip) -> bool {
    clip.is_adjustment_layer
        || clip.compound_sequence_id.is_some()
        || clip.asset_id.is_empty()
        || clip.asset_id.starts_with(VIRTUAL_ASSET_PREFIX)
        || clip.asset_id == CAPTION_VIRTUAL_ASSET_ID
}

/// Collects the timeline spans covered by enabled clips on the given tracks.
///
/// `exclude_track_id` drops one track from the calculation, which is how a
/// track's own gaps are measured against everything else.
fn covered_spans<'a>(
    tracks: impl Iterator<Item = &'a Track>,
    exclude_track_id: Option<&str>,
) -> Vec<(f64, f64)> {
    let mut spans: Vec<(f64, f64)> = tracks
        .filter(|track| exclude_track_id != Some(track.id.as_str()) && track.visible)
        .flat_map(|track| track.clips.iter())
        .filter(|clip| clip.enabled && clip.duration() > 0.0)
        .map(|clip| (clip.place.timeline_in_sec, clip.timeline_end()))
        .collect();

    spans.sort_by(|a, b| a.0.total_cmp(&b.0));

    // Merge so the subtraction below only walks disjoint spans.
    let mut merged: Vec<(f64, f64)> = Vec::with_capacity(spans.len());
    for span in spans {
        match merged.last_mut() {
            Some(last) if span.0 <= last.1 => last.1 = last.1.max(span.1),
            _ => merged.push(span),
        }
    }

    merged
}

/// Subtracts covered spans from `[start, end)`, returning what remains.
fn subtract_coverage(start: f64, end: f64, covered: &[(f64, f64)]) -> Vec<(f64, f64)> {
    let mut remaining = vec![(start, end)];

    for &(cover_start, cover_end) in covered {
        let mut next = Vec::with_capacity(remaining.len() + 1);
        for (span_start, span_end) in remaining {
            if cover_end <= span_start || cover_start >= span_end {
                next.push((span_start, span_end));
                continue;
            }
            if cover_start > span_start {
                next.push((span_start, cover_start));
            }
            if cover_end < span_end {
                next.push((cover_end, span_end));
            }
        }
        remaining = next;
    }

    remaining
}

/// Finds gaps on visible video tracks that no other visible video track fills.
///
/// A gap on an overlay track above a continuous base track is not a hole in the
/// program, so only the uncovered remainder is reported. Hidden tracks are
/// ignored on both sides: they neither contribute gaps nor count as coverage.
///
/// Three kinds of hole are reported:
///
/// * gaps between clips on a track (from [`find_gaps`]),
/// * a head gap before the first video clip in the sequence,
/// * a tail gap between the last video clip and the end of the sequence.
///
/// The last two are invisible to [`find_gaps`], which only walks pairs of
/// clips, yet both render as black: a sequence whose picture starts at 2.0 s
/// opens on two seconds of nothing, and audio or captions running past the last
/// video clip extend the program over an empty canvas.
pub fn uncovered_video_gaps(sequence: &Sequence, min_gap_sec: f64) -> Vec<UncoveredGap> {
    let mut uncovered = Vec::new();

    // Hidden tracks show nothing, so their gaps are not holes in the program.
    // `covered_spans` already ignores them on the coverage side; collecting
    // their gaps here would report holes in a track the viewer never sees.
    for track in sequence
        .tracks
        .iter()
        .filter(|track| track.is_video() && track.visible)
    {
        let gaps = find_gaps(track);
        if gaps.is_empty() {
            continue;
        }

        let covered = covered_spans(
            sequence.tracks.iter().filter(|other| other.is_video()),
            Some(&track.id),
        );

        for gap in gaps {
            for (start_sec, end_sec) in subtract_coverage(gap.start, gap.end, &covered) {
                if end_sec - start_sec < min_gap_sec {
                    continue;
                }
                uncovered.push(UncoveredGap {
                    track_id: track.id.clone(),
                    track_name: track.name.clone(),
                    start_sec,
                    end_sec,
                    gap_start_sec: gap.start,
                    gap_end_sec: gap.end,
                    closable: true,
                });
            }
        }
    }

    uncovered.extend(program_edge_gaps(sequence, min_gap_sec));
    uncovered
}

/// One end of the program's video coverage, and the track that defines it.
struct CoverageEdge<'a> {
    time_sec: f64,
    track: &'a Track,
}

/// Returns the first and last moment any visible video track shows a picture.
///
/// Returns `None` when no video track carries a usable clip: an audio-only
/// sequence has no picture to be missing, so it is not graded here.
fn video_coverage_edges(sequence: &Sequence) -> Option<(CoverageEdge<'_>, CoverageEdge<'_>)> {
    let mut earliest: Option<CoverageEdge> = None;
    let mut latest: Option<CoverageEdge> = None;

    for track in sequence
        .tracks
        .iter()
        .filter(|track| track.is_video() && track.visible)
    {
        for clip in track
            .clips
            .iter()
            .filter(|clip| clip.enabled && clip.duration() > 0.0)
        {
            let start_sec = clip.place.timeline_in_sec;
            let end_sec = clip.timeline_end();

            if earliest
                .as_ref()
                .is_none_or(|edge| start_sec < edge.time_sec)
            {
                earliest = Some(CoverageEdge {
                    time_sec: start_sec,
                    track,
                });
            }
            if latest.as_ref().is_none_or(|edge| end_sec > edge.time_sec) {
                latest = Some(CoverageEdge {
                    time_sec: end_sec,
                    track,
                });
            }
        }
    }

    Some((earliest?, latest?))
}

/// Reports black before the first and after the last video clip.
///
/// Neither span carries a fix: both would need a decision about the other
/// tracks that no single command expresses (see the notes at each push).
///
/// Both spans are uncovered by construction — they sit outside the union of
/// every video track's coverage — so no subtraction is needed. The trailing
/// span is measured against [`Sequence::duration`], which follows the longest
/// track of any kind: audio or captions running past the picture keep the
/// program alive over an empty canvas.
fn program_edge_gaps(sequence: &Sequence, min_gap_sec: f64) -> Vec<UncoveredGap> {
    let Some((earliest, latest)) = video_coverage_edges(sequence) else {
        return Vec::new();
    };

    let mut gaps = Vec::new();

    if earliest.time_sec >= min_gap_sec {
        gaps.push(UncoveredGap {
            track_id: earliest.track.id.clone(),
            track_name: earliest.track.name.clone(),
            start_sec: 0.0,
            end_sec: earliest.time_sec,
            gap_start_sec: 0.0,
            gap_end_sec: earliest.time_sec,
            // `CloseGap` ripples one track. Applied to the head of the program
            // it would pull that single track's clips to zero and leave every
            // other track — audio, captions, overlays — where it was, trading
            // leading black for a program that is out of sync end to end.
            // Deciding between rippling everything, extending the first shot
            // and shortening the other tracks is a call this rule cannot make,
            // so it reports the black and offers no fix.
            closable: false,
        });
    }

    // The program ends where the export stops writing, so a trailing clip the
    // render drops leaves no uncovered picture behind it — there is simply no
    // program there to be uncovered.
    let program_end_sec = sequence.output_duration();
    if program_end_sec - latest.time_sec >= min_gap_sec {
        gaps.push(UncoveredGap {
            track_id: latest.track.id.clone(),
            track_name: latest.track.name.clone(),
            start_sec: latest.time_sec,
            end_sec: program_end_sec,
            gap_start_sec: latest.time_sec,
            gap_end_sec: program_end_sec,
            // Nothing follows the last clip, so there is nothing to ripple in;
            // the fix is to shorten the other tracks or extend the picture.
            closable: false,
        });
    }

    gaps
}

// =============================================================================
// EmptySequenceRule
// =============================================================================

/// Rule that reports a sequence with nothing on any track
///
/// Every other check reads the clips: with none to read they all pass, and the
/// report says the project is clean when in truth nothing was ever edited. An
/// agent acting on that report concludes its work is verified. This rule is the
/// floor under the whole run — the one finding that says there was nothing to
/// look at.
///
/// Graded as a warning, not an error: an empty sequence is a legitimate
/// starting point, and `error` stays reserved for output that is objectively
/// broken. What matters is that it can never be silent.
#[derive(Debug, Default)]
pub struct EmptySequenceRule;

impl EmptySequenceRule {
    /// Creates a new EmptySequenceRule
    pub fn new() -> Self {
        Self
    }
}

#[async_trait]
impl QCRule for EmptySequenceRule {
    fn name(&self) -> &str {
        "EmptySequenceRule"
    }

    fn check_id(&self) -> &str {
        "sequence.empty"
    }

    fn description(&self) -> &str {
        "Reports a sequence that holds no clips on any track"
    }

    fn default_severity(&self) -> Severity {
        Severity::Warning
    }

    async fn check(
        &self,
        sequence: &Sequence,
        _state: &ProjectState,
        config: &RuleConfig,
        _context: &QCContext,
    ) -> CoreResult<Vec<QCViolation>> {
        let clip_count: usize = sequence.tracks.iter().map(|track| track.clips.len()).sum();
        if clip_count > 0 {
            return Ok(Vec::new());
        }

        let severity = config.severity_override.unwrap_or(self.default_severity());

        Ok(vec![QCViolation::new(
            self.name(),
            severity,
            "Sequence contains no clips on any track",
        )
        .with_details(
            "Every other check reads the clips, so an empty sequence passes them all without \
             anything having been inspected. Import media and place it on the timeline before \
             treating this report as a verdict."
                .to_string(),
        )
        .with_metric("trackCount", sequence.tracks.len())
        .with_metric("clipCount", clip_count)])
    }
}

// =============================================================================
// TimelineGapRule
// =============================================================================

/// Rule that reports holes between clips on video tracks
///
/// A hole renders as black, so it is reported as an error rather than a matter
/// of taste. Gaps that another video track covers are ignored.
#[derive(Debug, Default)]
pub struct TimelineGapRule;

impl TimelineGapRule {
    /// Creates a new TimelineGapRule
    pub fn new() -> Self {
        Self
    }
}

#[async_trait]
impl QCRule for TimelineGapRule {
    fn name(&self) -> &str {
        "TimelineGapRule"
    }

    fn check_id(&self) -> &str {
        "timeline.gap"
    }

    fn description(&self) -> &str {
        "Reports ranges no video track covers, including before the first and after the last clip"
    }

    fn default_severity(&self) -> Severity {
        Severity::Error
    }

    async fn check(
        &self,
        sequence: &Sequence,
        _state: &ProjectState,
        config: &RuleConfig,
        context: &QCContext,
    ) -> CoreResult<Vec<QCViolation>> {
        // Sub-frame gaps are rounding artefacts, not holes in the picture.
        let min_gap_sec = config
            .get_param::<f64>("min_gap_sec")
            .unwrap_or_else(|| context.frame_duration_sec());
        let severity = config.severity_override.unwrap_or(self.default_severity());

        let violations = uncovered_video_gaps(sequence, min_gap_sec)
            .into_iter()
            .map(|gap| {
                let violation = QCViolation::new(
                    self.name(),
                    severity,
                    format!(
                        "Gap of {:.2}s at {:.2}s on track '{}'",
                        gap.duration_sec(),
                        gap.start_sec,
                        gap.track_name
                    ),
                )
                .with_location(gap.start_sec, gap.end_sec)
                .with_entities(vec![gap.track_id.clone()])
                .with_details(
                    "Nothing covers this range, so the program renders black here.".to_string(),
                )
                .with_metric("gapSec", gap.duration_sec())
                .with_metric("trackId", gap.track_id.clone());

                if !gap.closable {
                    // Trailing black has no following clip to ripple in, so
                    // offering CloseGap would suggest a no-op.
                    return violation;
                }

                violation.with_fix(
                    ViolationFix::new(
                        format!("Close the gap on track '{}'", gap.track_name),
                        vec![serde_json::json!({
                            "type": "CloseGap",
                            "sequenceId": sequence.id,
                            "trackId": gap.track_id,
                            "gapStart": gap.gap_start_sec,
                            "gapEnd": gap.gap_end_sec
                        })],
                    )
                    .with_confidence(0.85),
                )
            })
            .collect();

        Ok(violations)
    }

    fn supports_auto_fix(&self) -> bool {
        true
    }
}

// =============================================================================
// ClipOrphanRule
// =============================================================================

/// Rule that reports clips too short to register on screen
///
/// Anything under two frames is a leftover from a split or a drag, not an edit
/// a viewer can perceive.
#[derive(Debug, Default)]
pub struct ClipOrphanRule;

impl ClipOrphanRule {
    /// Creates a new ClipOrphanRule
    pub fn new() -> Self {
        Self
    }

    /// Frames below which a clip counts as an orphan
    const DEFAULT_MIN_FRAMES: f64 = 2.0;
}

#[async_trait]
impl QCRule for ClipOrphanRule {
    fn name(&self) -> &str {
        "ClipOrphanRule"
    }

    fn check_id(&self) -> &str {
        "clip.orphan"
    }

    fn description(&self) -> &str {
        "Reports clips shorter than two frames"
    }

    fn default_severity(&self) -> Severity {
        Severity::Warning
    }

    async fn check(
        &self,
        sequence: &Sequence,
        _state: &ProjectState,
        config: &RuleConfig,
        context: &QCContext,
    ) -> CoreResult<Vec<QCViolation>> {
        let min_frames = config
            .get_param::<f64>("min_frames")
            .unwrap_or(Self::DEFAULT_MIN_FRAMES);
        let min_duration = min_frames * context.frame_duration_sec();
        let severity = config.severity_override.unwrap_or(self.default_severity());

        let mut violations = Vec::new();

        for track in &sequence.tracks {
            for clip in &track.clips {
                let duration = clip.duration();
                if duration >= min_duration {
                    continue;
                }

                let message = if duration <= 0.0 {
                    format!("Zero-length clip on track '{}'", track.name)
                } else {
                    format!(
                        "Clip is {:.3}s long, under the {:.3}s ({:.0} frame) minimum",
                        duration, min_duration, min_frames
                    )
                };

                violations.push(
                    QCViolation::new(self.name(), severity, message)
                        .with_location(clip.place.timeline_in_sec, clip.timeline_end())
                        .with_entities(vec![clip.id.clone()])
                        .with_details(
                            "Clips this short are invisible in playback and usually left over \
                             from a split or drag."
                                .to_string(),
                        )
                        .with_metric("durationSec", duration)
                        .with_metric("minDurationSec", min_duration)
                        .with_metric("trackId", track.id.clone())
                        .with_fix(
                            ViolationFix::new(
                                "Remove the orphan clip",
                                vec![serde_json::json!({
                                    "type": "RemoveClip",
                                    "sequenceId": sequence.id,
                                    "trackId": track.id,
                                    "clipId": clip.id
                                })],
                            )
                            .with_confidence(0.6),
                        ),
                );
            }
        }

        Ok(violations)
    }

    fn supports_auto_fix(&self) -> bool {
        true
    }
}

// =============================================================================
// MissingAssetRule
// =============================================================================

/// Rule that reports clips whose source media cannot be resolved
///
/// A clip pointing at media that is gone cannot render at all, so this is the
/// one structural failure classed as critical.
#[derive(Debug, Default)]
pub struct MissingAssetRule;

impl MissingAssetRule {
    /// Creates a new MissingAssetRule
    pub fn new() -> Self {
        Self
    }
}

#[async_trait]
impl QCRule for MissingAssetRule {
    fn name(&self) -> &str {
        "MissingAssetRule"
    }

    fn check_id(&self) -> &str {
        "clip.missing_asset"
    }

    fn description(&self) -> &str {
        "Reports clips whose source asset is missing from the project or from disk"
    }

    fn default_severity(&self) -> Severity {
        Severity::Critical
    }

    async fn check(
        &self,
        sequence: &Sequence,
        state: &ProjectState,
        config: &RuleConfig,
        _context: &QCContext,
    ) -> CoreResult<Vec<QCViolation>> {
        let severity = config.severity_override.unwrap_or(self.default_severity());
        let mut violations = Vec::new();

        for track in &sequence.tracks {
            if track.is_caption() {
                continue;
            }

            for clip in &track.clips {
                if is_virtual_clip(clip) {
                    continue;
                }

                let (message, details) = match state.get_asset(&clip.asset_id) {
                    None => (
                        format!("Clip references unknown asset '{}'", clip.asset_id),
                        "The asset is not part of this project; re-import the media or remove \
                         the clip."
                            .to_string(),
                    ),
                    // Quarantine is checked before `missing`, which it also sets:
                    // "the file is gone" and "the project claimed a path we
                    // refuse to open" need different fixes, and the second one
                    // has no path left to print.
                    Some(asset) if asset.quarantined_uri.is_some() => {
                        let rejected = asset.quarantined_uri.as_deref().unwrap_or_default();
                        (
                            format!("Source path for '{}' was rejected as unsafe", asset.name),
                            format!(
                                "This project stored '{rejected}' for '{}', which is not a path \
                                 OpenReelio will open — it is a URL, escapes the project, or names \
                                 a network share. The path was cleared on load; relink the clip to \
                                 local media you trust.",
                                asset.name
                            ),
                        )
                    }
                    Some(asset) if asset.missing => (
                        format!("Source file for '{}' is missing from disk", asset.name),
                        format!("Expected at '{}'. Relink or restore the file.", asset.uri),
                    ),
                    Some(_) => continue,
                };

                violations.push(
                    QCViolation::new(self.name(), severity, message)
                        .with_location(clip.place.timeline_in_sec, clip.timeline_end())
                        .with_entities(vec![clip.id.clone(), clip.asset_id.clone()])
                        .with_details(details)
                        .with_metric("assetId", clip.asset_id.clone())
                        .with_metric("trackId", track.id.clone()),
                );
            }
        }

        Ok(violations)
    }
}

// =============================================================================
// SilentClipRule
// =============================================================================

/// Rule that reports clips carrying audio that will never be heard
///
/// Muting is a legitimate edit (B-roll under narration), so this stays a
/// warning: it flags the common mistake of leaving a dialogue clip muted.
#[derive(Debug, Default)]
pub struct SilentClipRule;

impl SilentClipRule {
    /// Creates a new SilentClipRule
    pub fn new() -> Self {
        Self
    }

    /// Returns why the clip is inaudible, or `None` when it is not.
    fn silence_reason(track: &Track, clip: &Clip, silent_volume_db: f64) -> Option<String> {
        if track.muted {
            return Some(format!("track '{}' is muted", track.name));
        }
        if f64::from(track.volume) <= 0.0 {
            return Some(format!("track '{}' volume is zero", track.name));
        }
        if clip.audio.muted {
            return Some("clip audio is muted".to_string());
        }
        // Automation can bring the level back up, so a flat level only counts
        // when there are no keyframes to contradict it.
        if clip.audio.volume_keyframes.is_empty()
            && f64::from(clip.audio.volume_db) <= silent_volume_db
        {
            return Some(format!("clip volume is {:.1} dB", clip.audio.volume_db));
        }
        None
    }
}

#[async_trait]
impl QCRule for SilentClipRule {
    fn name(&self) -> &str {
        "SilentClipRule"
    }

    fn check_id(&self) -> &str {
        "audio.silent_clip"
    }

    fn description(&self) -> &str {
        "Reports clips whose audio is muted or turned all the way down"
    }

    fn default_severity(&self) -> Severity {
        Severity::Warning
    }

    async fn check(
        &self,
        sequence: &Sequence,
        state: &ProjectState,
        config: &RuleConfig,
        _context: &QCContext,
    ) -> CoreResult<Vec<QCViolation>> {
        let silent_volume_db = config
            .get_param::<f64>("silent_volume_db")
            .unwrap_or(SILENT_VOLUME_DB);
        let severity = config.severity_override.unwrap_or(self.default_severity());

        let mut violations = Vec::new();

        for track in &sequence.tracks {
            if track.is_caption() {
                continue;
            }

            for clip in &track.clips {
                if is_virtual_clip(clip) {
                    continue;
                }

                // Only clips that actually carry audio can be silenced.
                let carries_audio = track.is_audio()
                    || state
                        .get_asset(&clip.asset_id)
                        .is_some_and(|asset| asset.audio.is_some());
                if !carries_audio {
                    continue;
                }

                let Some(reason) = Self::silence_reason(track, clip, silent_volume_db) else {
                    continue;
                };

                violations.push(
                    QCViolation::new(
                        self.name(),
                        severity,
                        format!("Clip audio will not be heard ({})", reason),
                    )
                    .with_location(clip.place.timeline_in_sec, clip.timeline_end())
                    .with_entities(vec![clip.id.clone()])
                    .with_details(
                        "Confirm this is intentional; otherwise unmute the clip or raise its \
                         level."
                            .to_string(),
                    )
                    .with_metric("volumeDb", f64::from(clip.audio.volume_db))
                    .with_metric("clipMuted", clip.audio.muted)
                    .with_metric("trackMuted", track.muted)
                    .with_metric("trackId", track.id.clone()),
                );
            }
        }

        Ok(violations)
    }
}

// =============================================================================
// CaptionOverlapRule
// =============================================================================

/// Rule that reports captions that collide on the same track
///
/// Two captions live at once render on top of each other, which is broken
/// output rather than a stylistic choice.
#[derive(Debug, Default)]
pub struct CaptionOverlapRule;

impl CaptionOverlapRule {
    /// Creates a new CaptionOverlapRule
    pub fn new() -> Self {
        Self
    }
}

#[async_trait]
impl QCRule for CaptionOverlapRule {
    fn name(&self) -> &str {
        "CaptionOverlapRule"
    }

    fn check_id(&self) -> &str {
        "caption.overlap"
    }

    fn description(&self) -> &str {
        "Reports captions that overlap in time on the same track"
    }

    fn default_severity(&self) -> Severity {
        Severity::Error
    }

    async fn check(
        &self,
        sequence: &Sequence,
        _state: &ProjectState,
        config: &RuleConfig,
        _context: &QCContext,
    ) -> CoreResult<Vec<QCViolation>> {
        let severity = config.severity_override.unwrap_or(self.default_severity());
        let mut violations = Vec::new();

        for track in sequence.tracks.iter().filter(|track| track.is_caption()) {
            let mut clips: Vec<&Clip> = track.clips.iter().collect();
            clips.sort_by(|a, b| {
                a.place
                    .timeline_in_sec
                    .total_cmp(&b.place.timeline_in_sec)
                    .then_with(|| a.id.cmp(&b.id))
            });

            for pair in clips.windows(2) {
                let (first, second) = (pair[0], pair[1]);
                if !first.place.overlaps(&second.place) {
                    continue;
                }

                let start_sec = second.place.timeline_in_sec;
                let end_sec = first.timeline_end().min(second.timeline_end());

                violations.push(
                    QCViolation::new(
                        self.name(),
                        severity,
                        format!(
                            "Captions overlap for {:.2}s at {:.2}s on track '{}'",
                            end_sec - start_sec,
                            start_sec,
                            track.name
                        ),
                    )
                    .with_location(start_sec, end_sec)
                    .with_entities(vec![first.id.clone(), second.id.clone()])
                    .with_details(
                        "Overlapping captions render on top of each other; trim the earlier \
                         caption or move the later one."
                            .to_string(),
                    )
                    .with_metric("overlapSec", end_sec - start_sec)
                    .with_metric("trackId", track.id.clone()),
                );
            }
        }

        Ok(violations)
    }
}

// =============================================================================
// CaptionReadingRateRule
// =============================================================================

/// Rule that reports captions shown too briefly to read
///
/// The comfortable rate depends on the script: a Hangul or Han glyph carries
/// far more meaning than a Latin letter, so a CJK caption is measured against a
/// much lower characters-per-second budget. Reading comfort is a judgement
/// call, so findings stay at warning level.
#[derive(Debug, Default)]
pub struct CaptionReadingRateRule;

/// Script family a caption is measured against.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CaptionScript {
    /// Latin and other alphabetic scripts.
    Latin,
    /// Chinese, Japanese, or Korean.
    Cjk,
}

impl CaptionScript {
    /// Identifier used in violation metrics.
    pub fn as_str(self) -> &'static str {
        match self {
            CaptionScript::Latin => "latin",
            CaptionScript::Cjk => "cjk",
        }
    }
}

impl CaptionReadingRateRule {
    /// Creates a new CaptionReadingRateRule
    pub fn new() -> Self {
        Self
    }

    /// Comfortable reading rate for Latin script, in characters per second
    const LATIN_WARN_CPS: f64 = 20.0;

    /// Rate at which Latin script becomes unreadable in practice
    const LATIN_SEVERE_CPS: f64 = 25.0;

    /// Comfortable reading rate for CJK script, in characters per second
    const CJK_WARN_CPS: f64 = 9.0;

    /// Rate at which CJK script becomes unreadable in practice
    const CJK_SEVERE_CPS: f64 = 12.0;

    /// Share of CJK characters above which CJK thresholds apply
    const CJK_SHARE_THRESHOLD: f64 = 0.3;

    /// Classifies caption text by script family.
    pub fn detect_script(text: &str) -> CaptionScript {
        let mut total = 0usize;
        let mut cjk = 0usize;

        for character in text.chars() {
            if character.is_whitespace() || !character.is_alphanumeric() {
                continue;
            }
            total += 1;
            if is_cjk_char(character) {
                cjk += 1;
            }
        }

        if total == 0 {
            return CaptionScript::Latin;
        }

        if cjk as f64 / total as f64 > Self::CJK_SHARE_THRESHOLD {
            CaptionScript::Cjk
        } else {
            CaptionScript::Latin
        }
    }

    /// Returns the (warn, severe) characters-per-second thresholds for a script.
    pub fn thresholds(script: CaptionScript) -> (f64, f64) {
        match script {
            CaptionScript::Latin => (Self::LATIN_WARN_CPS, Self::LATIN_SEVERE_CPS),
            CaptionScript::Cjk => (Self::CJK_WARN_CPS, Self::CJK_SEVERE_CPS),
        }
    }

    /// Returns the latest second this cue may be extended to.
    ///
    /// The next cue's start less one frame, so an extension can never create
    /// the overlap `caption.overlap` reports; for the last cue on a track, the
    /// end of the edit, because there is nothing after it to collide with.
    fn extension_ceiling(
        starts: &[f64],
        clip_start_sec: f64,
        clip_end_sec: f64,
        sequence_end_sec: f64,
        frame_sec: f64,
    ) -> f64 {
        let next_start = starts
            .iter()
            .copied()
            .filter(|start| *start > clip_start_sec)
            .fold(f64::INFINITY, f64::min);

        if next_start.is_finite() {
            next_start - frame_sec
        } else {
            sequence_end_sec.max(clip_end_sec)
        }
    }

    /// Splits caption text in two at the word boundary nearest the middle.
    ///
    /// Returns `None` when there is nothing to split — a single word, or text
    /// whose halves would be empty. CJK has no spaces to break on, so an
    /// unbroken run falls back to the character midpoint, which is where a
    /// subtitler would break it too.
    fn split_text(text: &str) -> Option<(String, String)> {
        let characters: Vec<char> = text.chars().collect();
        if characters.len() < 2 {
            return None;
        }
        let middle = characters.len() / 2;

        let boundary = characters
            .iter()
            .enumerate()
            .filter(|(index, character)| {
                character.is_whitespace() && *index > 0 && *index < characters.len() - 1
            })
            .min_by_key(|(index, _)| index.abs_diff(middle))
            .map(|(index, _)| index)
            .unwrap_or(middle);

        let first: String = characters[..boundary].iter().collect();
        let second: String = characters[boundary..].iter().collect();
        let (first, second) = (first.trim().to_string(), second.trim().to_string());

        if first.is_empty() || second.is_empty() {
            return None;
        }
        Some((first, second))
    }
}

/// Returns whether a character belongs to a CJK script block.
fn is_cjk_char(character: char) -> bool {
    matches!(character as u32,
        0x1100..=0x11FF        // Hangul Jamo
        | 0x3040..=0x309F      // Hiragana
        | 0x30A0..=0x30FF      // Katakana
        | 0x3130..=0x318F      // Hangul compatibility Jamo
        | 0x3400..=0x4DBF      // CJK unified ideographs extension A
        | 0x4E00..=0x9FFF      // CJK unified ideographs
        | 0xA960..=0xA97F      // Hangul Jamo extended A
        | 0xAC00..=0xD7A3      // Hangul syllables
        | 0xD7B0..=0xD7FF      // Hangul Jamo extended B
        | 0xF900..=0xFAFF      // CJK compatibility ideographs
        | 0xFF66..=0xFF9D      // Halfwidth katakana
    )
}

#[async_trait]
impl QCRule for CaptionReadingRateRule {
    fn name(&self) -> &str {
        "CaptionReadingRateRule"
    }

    fn check_id(&self) -> &str {
        "caption.reading_rate"
    }

    fn description(&self) -> &str {
        "Reports captions displayed too briefly for their length, per script"
    }

    fn default_severity(&self) -> Severity {
        Severity::Warning
    }

    async fn check(
        &self,
        sequence: &Sequence,
        _state: &ProjectState,
        config: &RuleConfig,
        context: &QCContext,
    ) -> CoreResult<Vec<QCViolation>> {
        let severity = config.severity_override.unwrap_or(self.default_severity());
        let frame_sec = context.frame_duration_sec();
        let sequence_end_sec = sequence.duration();
        let mut violations = Vec::new();

        for track in sequence.tracks.iter().filter(|track| track.is_caption()) {
            // Clip order on a track is not guaranteed, and "the following gap"
            // is meaningless without it.
            let mut starts: Vec<f64> = track
                .clips
                .iter()
                .map(|clip| clip.place.timeline_in_sec)
                .filter(|start| start.is_finite())
                .collect();
            starts.sort_by(|left, right| {
                left.partial_cmp(right).unwrap_or(std::cmp::Ordering::Equal)
            });

            let mut findings: Vec<CaptionFinding> = Vec::new();

            for clip in &track.clips {
                let Some(text) = clip.label.as_ref().map(|label| label.trim()) else {
                    continue;
                };
                if text.is_empty() {
                    continue;
                }

                let duration = clip.duration();
                if duration <= 0.0 {
                    // Zero-length captions are reported by `clip.orphan`.
                    continue;
                }

                let char_count = text.chars().count() as f64;
                let cps = char_count / duration;

                let script = Self::detect_script(text);
                let (warn_cps, severe_cps) = Self::thresholds(script);
                let warn_cps = config.get_param::<f64>("warn_cps").unwrap_or(warn_cps);
                let severe_cps = config.get_param::<f64>("severe_cps").unwrap_or(severe_cps);

                if cps <= warn_cps || warn_cps <= 0.0 {
                    continue;
                }

                let clip_start = clip.place.timeline_in_sec;
                let clip_end = clip.timeline_end();
                let repair = Self::repair_for(
                    RepairInputs {
                        sequence_id: &sequence.id,
                        track_id: &track.id,
                        clip_id: &clip.id,
                        text,
                        clip_start_sec: clip_start,
                        clip_end_sec: clip_end,
                        required_duration_sec: char_count / warn_cps,
                        frame_sec,
                        style: clip.caption_style.as_ref(),
                        position: clip.caption_position.as_ref(),
                    },
                    &starts,
                    sequence_end_sec,
                );

                findings.push(
                    CaptionFinding::new(clip.id.clone(), clip_start, clip_end)
                        .with_metric("cps", (cps * 100.0).round() / 100.0)
                        .with_metric("charCount", char_count)
                        .with_metric("durationSec", duration)
                        .with_metric("script", script.as_str())
                        .with_metric("warnCps", warn_cps)
                        .with_metric("severeCps", severe_cps)
                        .with_metric("severe", cps > severe_cps)
                        .with_metric("repair", repair.label)
                        .with_commands(repair.commands, repair.resolved),
                );
            }

            violations.extend(group_caption_findings(
                CaptionGroup {
                    rule_name: self.name(),
                    severity,
                    track_id: &track.id,
                    details:
                        "Each listed cue carries its own rate under `cues`. Where the following \
                         gap is long enough the fix simply extends the cue; where it is not, the \
                         cue is split at a word boundary and the pair uses every second \
                         available. A split does not by itself lower characters per second — it \
                         lowers how much text is on screen at once — so a group containing one is \
                         a proposal to read rather than an automatic repair."
                            .to_string(),
                    fix_description: "Give every listed caption more time to be read".to_string(),
                    confidence: 0.7,
                },
                findings,
                |count| format!("{count} caption(s) on this track read faster than is comfortable"),
            ));
        }

        Ok(violations)
    }

    fn supports_auto_fix(&self) -> bool {
        true
    }
}

/// Everything the repair for one over-fast cue is derived from.
struct RepairInputs<'a> {
    sequence_id: &'a str,
    track_id: &'a str,
    clip_id: &'a str,
    text: &'a str,
    clip_start_sec: f64,
    clip_end_sec: f64,
    /// How long the cue would have to be up to reach the comfortable rate
    required_duration_sec: f64,
    frame_sec: f64,
    /// The cue's stored style, so a split half keeps the look of the whole
    style: Option<&'a serde_json::Value>,
    /// The cue's stored position, so a split half stays where the cue was
    position: Option<&'a serde_json::Value>,
}

/// The repair proposed for one over-fast cue.
struct CaptionRepair {
    /// What was done, for the cue's `repair` metric
    label: &'static str,
    /// Commands that carry it out
    commands: Vec<serde_json::Value>,
    /// Whether the commands finish the job on their own
    resolved: bool,
}

impl CaptionReadingRateRule {
    /// Builds the repair for one cue: extend it, or split it and extend the pair.
    ///
    /// Extension is preferred because it is complete — a cue held long enough
    /// *is* readable, and nothing about the edit is left to judge, so the group
    /// it belongs to stays automatically fixable. A split rewrites the caption
    /// into two, which is a proposal: it is offered when the gap cannot hold
    /// the time the cue needs.
    fn repair_for(
        inputs: RepairInputs<'_>,
        starts: &[f64],
        sequence_end_sec: f64,
    ) -> CaptionRepair {
        let ceiling = Self::extension_ceiling(
            starts,
            inputs.clip_start_sec,
            inputs.clip_end_sec,
            sequence_end_sec,
            inputs.frame_sec,
        );
        let required_end = inputs.clip_start_sec + inputs.required_duration_sec;

        if required_end <= ceiling {
            return CaptionRepair {
                label: "extend",
                commands: vec![serde_json::json!({
                    "type": "UpdateCaption",
                    "sequenceId": inputs.sequence_id,
                    "trackId": inputs.track_id,
                    "clipId": inputs.clip_id,
                    "endSec": (required_end * 1000.0).round() / 1000.0,
                })],
                resolved: true,
            };
        }

        // Take every second the gap does offer, then break the line so each
        // half carries less text.
        let extended_end = ceiling.max(inputs.clip_end_sec);
        let Some((first, second)) = Self::split_text(inputs.text) else {
            return CaptionRepair {
                label: "none",
                commands: Vec::new(),
                resolved: false,
            };
        };

        let first_share = first.chars().count() as f64
            / (first.chars().count() + second.chars().count()).max(1) as f64;
        let split_sec =
            inputs.clip_start_sec + (extended_end - inputs.clip_start_sec) * first_share;
        // Both halves must be real cues, not sub-frame slivers `clip.orphan`
        // would then report.
        let earliest = inputs.clip_start_sec + inputs.frame_sec;
        let latest = extended_end - inputs.frame_sec;
        if latest <= earliest {
            return CaptionRepair {
                label: "none",
                commands: Vec::new(),
                resolved: false,
            };
        }
        let split_sec = (split_sec.clamp(earliest, latest) * 1000.0).round() / 1000.0;

        // The second half is a new caption, and a new caption carries the
        // caption defaults unless it is told otherwise. Splitting a styled,
        // repositioned cue without copying both would leave half the line in a
        // different font, in a different place — a repair that trades one
        // defect for a worse one. `CreateCaption` takes both verbatim.
        let mut create = serde_json::json!({
            "type": "CreateCaption",
            "sequenceId": inputs.sequence_id,
            "trackId": inputs.track_id,
            "text": second,
            "startSec": split_sec,
            "endSec": (extended_end * 1000.0).round() / 1000.0,
        });
        if let Some(payload) = create.as_object_mut() {
            if let Some(style) = inputs.style {
                payload.insert("style".to_string(), style.clone());
            }
            if let Some(position) = inputs.position {
                payload.insert("position".to_string(), position.clone());
            }
        }

        CaptionRepair {
            label: "split",
            commands: vec![
                // Shrink first, so the two cues never overlap at any point in
                // the plan.
                serde_json::json!({
                    "type": "UpdateCaption",
                    "sequenceId": inputs.sequence_id,
                    "trackId": inputs.track_id,
                    "clipId": inputs.clip_id,
                    "text": first,
                    "endSec": split_sec,
                }),
                create,
            ],
            resolved: false,
        }
    }
}

// =============================================================================
// CaptionOutOfBoundsRule
// =============================================================================

/// Rule that reports captions positioned outside the canvas
///
/// Distinct from the safe-area rule: this one fires only when the caption is
/// (partly) off-frame, which crops the text and is objectively broken output.
#[derive(Debug, Default)]
pub struct CaptionOutOfBoundsRule;

impl CaptionOutOfBoundsRule {
    /// Creates a new CaptionOutOfBoundsRule
    pub fn new() -> Self {
        Self
    }

    /// Characters that fit across the canvas width at the default font size
    ///
    /// Core has no text shaping, so the box is an approximation; the check only
    /// fires when the box leaves the canvas entirely, which keeps the estimate
    /// from producing false errors.
    const CHARS_PER_CANVAS_WIDTH: f64 = 42.0;

    /// Maximum estimated text-box width as a percentage of canvas width
    const MAX_TEXT_BOX_WIDTH_PERCENT: f64 = 90.0;

    /// Line height as a multiple of the font size
    const LINE_HEIGHT_FACTOR: f64 = 1.2;

    /// Tolerance in percent for float noise at the canvas edge
    const EDGE_TOLERANCE_PERCENT: f64 = 0.01;

    /// Estimates the caption box as (width_percent, height_percent).
    fn estimate_box_percent(clip: &Clip, canvas_height: u32) -> (f64, f64) {
        let char_count = clip
            .label
            .as_ref()
            .map(|label| label.chars().count())
            .unwrap_or(0) as f64;

        let width_percent = (char_count / Self::CHARS_PER_CANVAS_WIDTH * 100.0)
            .min(Self::MAX_TEXT_BOX_WIDTH_PERCENT);

        let canvas_height = if canvas_height > 0 { canvas_height } else { 1 };
        let font_size = clip
            .caption_style
            .as_ref()
            .and_then(|value| serde_json::from_value::<CaptionStyle>(value.clone()).ok())
            .map(|style| f64::from(style.font_size))
            .or_else(|| {
                clip.caption_style
                    .as_ref()
                    .and_then(|value| value.get("fontSize").or_else(|| value.get("font_size")))
                    .and_then(serde_json::Value::as_f64)
            })
            .filter(|size| size.is_finite() && *size > 0.0)
            .unwrap_or_else(|| f64::from(CaptionStyle::default().font_size));

        let height_percent =
            font_size * Self::LINE_HEIGHT_FACTOR / f64::from(canvas_height) * 100.0;

        (width_percent, height_percent)
    }

    /// Returns the caption box edges as (left, right, top, bottom) percentages.
    fn box_edges(
        position: &CaptionPosition,
        box_width: f64,
        box_height: f64,
    ) -> (f64, f64, f64, f64) {
        let (center_x, center_y) = match position {
            CaptionPosition::Preset {
                vertical,
                margin_percent,
            } => {
                let center_y = match vertical {
                    VerticalPosition::Bottom => 100.0 - margin_percent - box_height / 2.0,
                    VerticalPosition::Top => margin_percent + box_height / 2.0,
                    VerticalPosition::Center => 50.0,
                };
                (50.0, center_y)
            }
            CaptionPosition::Custom(custom) => (custom.x_percent, custom.y_percent),
        };

        (
            center_x - box_width / 2.0,
            center_x + box_width / 2.0,
            center_y - box_height / 2.0,
            center_y + box_height / 2.0,
        )
    }
}

#[async_trait]
impl QCRule for CaptionOutOfBoundsRule {
    fn name(&self) -> &str {
        "CaptionOutOfBoundsRule"
    }

    fn check_id(&self) -> &str {
        "caption.out_of_bounds"
    }

    fn description(&self) -> &str {
        "Reports captions whose estimated text box falls outside the canvas"
    }

    fn default_severity(&self) -> Severity {
        Severity::Error
    }

    async fn check(
        &self,
        sequence: &Sequence,
        _state: &ProjectState,
        config: &RuleConfig,
        context: &QCContext,
    ) -> CoreResult<Vec<QCViolation>> {
        let severity = config.severity_override.unwrap_or(self.default_severity());
        let tolerance = Self::EDGE_TOLERANCE_PERCENT;
        let mut violations = Vec::new();

        for track in sequence.tracks.iter().filter(|track| track.is_caption()) {
            let mut findings: Vec<CaptionFinding> = Vec::new();

            for clip in &track.clips {
                // A missing or unreadable position renders with the caption
                // default, so the check follows the same fallback.
                let position = clip
                    .caption_position
                    .as_ref()
                    .and_then(|value| serde_json::from_value::<CaptionPosition>(value.clone()).ok())
                    .unwrap_or_default();

                let (box_width, box_height) =
                    Self::estimate_box_percent(clip, context.canvas_height);
                let (left, right, top, bottom) = Self::box_edges(&position, box_width, box_height);

                if left >= -tolerance
                    && right <= 100.0 + tolerance
                    && top >= -tolerance
                    && bottom <= 100.0 + tolerance
                {
                    continue;
                }

                findings.push(
                    CaptionFinding::new(
                        clip.id.clone(),
                        clip.place.timeline_in_sec,
                        clip.timeline_end(),
                    )
                    .with_metric("leftPercent", left)
                    .with_metric("rightPercent", right)
                    .with_metric("topPercent", top)
                    .with_metric("bottomPercent", bottom),
                );
            }

            // One violation per track, not one per cue: a caption track pushed
            // off the frame is one wrong setting, and a fix that repairs one
            // cue at a time makes an agent run the loop once per caption.
            violations.extend(group_caption_findings(
                CaptionGroup {
                    rule_name: self.name(),
                    severity,
                    track_id: &track.id,
                    details: "Text outside the frame is cropped away. Each listed cue carries its \
                              own estimated box under `cues`. No fix is offered: where a caption \
                              pushed off the canvas belongs is a composition decision, and \
                              `caption.safe_area` proposes the move for the cues it can measure."
                        .to_string(),
                    fix_description: String::new(),
                    confidence: 0.0,
                },
                findings,
                |count| format!("{count} caption(s) on this track are positioned off the canvas"),
            ));
        }

        Ok(violations)
    }
}

// =============================================================================
// ShotLengthStatsRule
// =============================================================================

/// Rule that always reports shot-length statistics
///
/// Emits no judgement, only numbers: an agent comparing two edits needs the
/// pacing distribution, and a check that never appears in the report is a check
/// an agent cannot reason about.
#[derive(Debug, Default)]
pub struct ShotLengthStatsRule;

impl ShotLengthStatsRule {
    /// Creates a new ShotLengthStatsRule
    pub fn new() -> Self {
        Self
    }
}

/// Shot-length distribution over the video clips of a sequence.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ShotLengthStats {
    /// Number of video clips measured.
    pub count: usize,
    /// Shortest clip in seconds.
    pub min_sec: f64,
    /// Median clip length in seconds.
    pub median_sec: f64,
    /// 90th percentile clip length in seconds.
    pub p90_sec: f64,
    /// Longest clip in seconds.
    pub max_sec: f64,
    /// Mean clip length in seconds.
    pub mean_sec: f64,
    /// Total measured length in seconds.
    pub total_sec: f64,
}

/// Computes shot-length statistics from the video clips of a sequence.
pub fn shot_length_stats(sequence: &Sequence) -> ShotLengthStats {
    let mut durations: Vec<f64> = sequence
        .tracks
        .iter()
        .filter(|track| track.is_video())
        .flat_map(|track| track.clips.iter())
        .filter(|clip| !clip.is_adjustment_layer && clip.duration() > 0.0)
        .map(|clip| clip.duration())
        .collect();

    if durations.is_empty() {
        return ShotLengthStats::default();
    }

    durations.sort_by(|a, b| a.total_cmp(b));

    let count = durations.len();
    let total_sec: f64 = durations.iter().sum();

    ShotLengthStats {
        count,
        min_sec: durations[0],
        median_sec: percentile(&durations, 0.5),
        p90_sec: percentile(&durations, 0.9),
        max_sec: durations[count - 1],
        mean_sec: total_sec / count as f64,
        total_sec,
    }
}

/// Returns the nearest-rank percentile of a sorted, non-empty slice.
fn percentile(sorted: &[f64], fraction: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let rank = (fraction * sorted.len() as f64).ceil() as usize;
    let index = rank.clamp(1, sorted.len()) - 1;
    sorted[index]
}

#[async_trait]
impl QCRule for ShotLengthStatsRule {
    fn name(&self) -> &str {
        "ShotLengthStatsRule"
    }

    fn check_id(&self) -> &str {
        "shot.length_stats"
    }

    fn description(&self) -> &str {
        "Reports the shot-length distribution of the sequence"
    }

    fn default_severity(&self) -> Severity {
        Severity::Info
    }

    async fn check(
        &self,
        sequence: &Sequence,
        _state: &ProjectState,
        config: &RuleConfig,
        _context: &QCContext,
    ) -> CoreResult<Vec<QCViolation>> {
        let severity = config.severity_override.unwrap_or(self.default_severity());
        let stats = shot_length_stats(sequence);

        let message = if stats.count == 0 {
            "No video clips to measure".to_string()
        } else {
            format!(
                "{} shots, median {:.2}s, p90 {:.2}s, range {:.2}s-{:.2}s",
                stats.count, stats.median_sec, stats.p90_sec, stats.min_sec, stats.max_sec
            )
        };

        let violation = QCViolation::new(self.name(), severity, message)
            .with_location(0.0, sequence.duration())
            .with_details("Pacing metrics; no action implied.".to_string())
            .with_metric("count", stats.count)
            .with_metric("minSec", stats.min_sec)
            .with_metric("medianSec", stats.median_sec)
            .with_metric("p90Sec", stats.p90_sec)
            .with_metric("maxSec", stats.max_sec)
            .with_metric("meanSec", stats.mean_sec)
            .with_metric("totalSec", stats.total_sec);

        Ok(vec![violation])
    }
}

// =============================================================================
// TransitionNoHandlesRule
// =============================================================================

/// Rule that reports two-input transitions the render will not blend
///
/// A stored `CrossDissolve`, `Wipe` or `Slide` is only a request. The render
/// blends it as a real `xfade` when the edit gives it somewhere to blend from —
/// unused source media on both sides of the cut, a real adjacency, a picture on
/// each side, a duration shorter than both shots and no longer than the cap the
/// engine will place. When any of that is missing the boundary silently comes
/// out as a hard cut.
///
/// "Silently" is the problem this rule exists for. The export reports the
/// refusal as a warning, but only if someone runs an export and reads its
/// warnings: an agent that places transitions and then verifies the project has
/// no other way to learn that its edit did not survive contact with the media.
/// The check runs off the project alone — no render, no `--file` — because the
/// answer is knowable from the timeline and the source lengths.
///
/// Graded as a warning: the program still renders, still lasts exactly as long
/// as the timeline says, and a hard cut is a legitimate edit. What is not
/// legitimate is believing a dissolve is there when it is not.
#[derive(Debug, Default)]
pub struct TransitionNoHandlesRule;

impl TransitionNoHandlesRule {
    /// Creates a new TransitionNoHandlesRule
    pub fn new() -> Self {
        Self
    }
}

#[async_trait]
impl QCRule for TransitionNoHandlesRule {
    fn name(&self) -> &str {
        "TransitionNoHandlesRule"
    }

    fn check_id(&self) -> &str {
        "transition.no_handles"
    }

    fn description(&self) -> &str {
        "Reports two-input transitions the render will degrade to a hard cut, and why"
    }

    fn default_severity(&self) -> Severity {
        Severity::Warning
    }

    async fn check(
        &self,
        sequence: &Sequence,
        state: &ProjectState,
        config: &RuleConfig,
        context: &QCContext,
    ) -> CoreResult<Vec<QCViolation>> {
        let severity = config.severity_override.unwrap_or(self.default_severity());

        // Measured before the planner runs, because the planner wants a
        // synchronous answer and probing a file is not one. Only assets a clip
        // carrying a two-input transition actually touches are measured, so a
        // project without transitions costs nothing at all.
        let durations = measure_transition_source_durations(sequence, state).await;

        let plan = plan_sequence_transitions(
            sequence,
            &state.assets,
            &state.effects,
            context.fps,
            |asset| durations.get(&asset.id).copied(),
        );

        Ok(plan
            .refusals()
            .iter()
            .map(|refusal| {
                let location = sequence
                    .tracks
                    .iter()
                    .flat_map(|track| track.clips.iter())
                    .find(|clip| clip.id == refusal.clip_id)
                    .map(|clip| (clip.place.timeline_in_sec, clip.timeline_end()));

                let mut violation = QCViolation::new(
                    self.name(),
                    severity,
                    format!(
                        "Transition '{}' on clip '{}' renders as a hard cut",
                        refusal.effect_label, refusal.clip_id
                    ),
                )
                .with_entities(vec![refusal.clip_id.clone(), refusal.effect_id.clone()])
                .with_details(format!(
                    "The render will not blend this boundary: {}.",
                    refusal.reason
                ))
                .with_metric("clipId", refusal.clip_id.clone())
                .with_metric("effectId", refusal.effect_id.clone())
                .with_metric("trackId", refusal.track_id.clone())
                .with_metric("effect", refusal.effect_label.clone());

                if let Some((start, end)) = location {
                    violation = violation.with_location(start, end);
                }

                // Removing the effect is the one repair that is always correct
                // and always computable: it makes the project say what the file
                // will show. Everything else — trimming the clips back to free a
                // handle, shortening the transition — depends on material this
                // rule would have to guess at, and a fix that guesses wrong is
                // worse than no fix.
                violation.with_fix(
                    ViolationFix::new(
                        format!(
                            "Remove the '{}' transition that will not render",
                            refusal.effect_label
                        ),
                        vec![serde_json::json!({
                            "type": "RemoveEffect",
                            "sequenceId": sequence.id,
                            "trackId": refusal.track_id,
                            "clipId": refusal.clip_id,
                            "effectId": refusal.effect_id
                        })],
                    )
                    .with_confidence(0.6),
                )
            })
            .collect())
    }
}

/// Measures the media behind every clip that carries a two-input transition.
///
/// Only those clips and the ones they cut into: an asset nobody blends across
/// never needs measuring, and the probe is the expensive part of this rule.
/// `Asset::duration_sec` is used when the project already carries one, which is
/// the normal case for anything imported through the GUI.
async fn measure_transition_source_durations(
    sequence: &Sequence,
    state: &ProjectState,
) -> std::collections::HashMap<String, f64> {
    let mut wanted: Vec<String> = Vec::new();

    for track in &sequence.tracks {
        let mut clips: Vec<&Clip> = track.clips.iter().filter(|clip| clip.enabled).collect();
        clips.sort_by(|a, b| a.place.timeline_in_sec.total_cmp(&b.place.timeline_in_sec));

        for (index, clip) in clips.iter().enumerate() {
            let carries_transition = clip.effects.iter().any(|effect_id| {
                state.effects.get(effect_id).is_some_and(|effect| {
                    effect.enabled && effect.effect_type.is_two_input_transition()
                })
            });
            if !carries_transition {
                continue;
            }

            wanted.push(clip.asset_id.clone());
            if let Some(next) = clips.get(index + 1) {
                wanted.push(next.asset_id.clone());
            }
        }
    }

    wanted.sort();
    wanted.dedup();

    let mut measured = std::collections::HashMap::new();
    for asset_id in wanted {
        let Some(asset) = state.assets.get(&asset_id) else {
            continue;
        };

        if let Some(duration) = asset
            .duration_sec
            .filter(|duration| duration.is_finite() && *duration > 0.0)
        {
            measured.insert(asset_id, duration);
            continue;
        }

        // Off the async executor: FFprobe is a blocking child process, and QC
        // runs on the same runtime as everything else.
        let uri = asset.uri.clone();
        let probed = tokio::task::spawn_blocking(move || {
            crate::core::assets::MetadataExtractor::extract(&uri)
                .ok()
                .and_then(|metadata| metadata.video_duration_sec.or(Some(metadata.duration_sec)))
        })
        .await
        .ok()
        .flatten()
        .filter(|duration: &f64| duration.is_finite() && *duration > 0.0);

        if let Some(duration) = probed {
            measured.insert(asset_id, duration);
        }
    }

    measured
}

// =============================================================================
// Cross-reference: rendered black ranges vs. structural gaps
// =============================================================================

/// Fraction of the program black may cover before the "no gap overlaps this,
/// so it is probably deliberate" reading stops being credible.
///
/// A fade or title card is short by construction. Black over half the running
/// time is a dropped video chain, a wrong pixel format or an export that never
/// received a picture — a broken render, whatever the timeline says.
///
/// Measured against the **total** black in the program, not against one range
/// at a time: a render broken into a dozen dark stretches is exactly as unwatchable
/// as one long one, and grading each range on its own let the sum pass.
const BLACK_PROGRAM_FRACTION_ERROR: f64 = 0.5;

/// Re-grades detected black ranges against the structural gaps of a sequence.
///
/// Black pixels alone say nothing about intent: a fade-out or title card is
/// black on purpose, while black over a hole in the timeline is broken output.
/// Only the combination of both passes can tell them apart, so the regrade
/// happens here rather than inside either rule:
///
/// * black overlapping an uncovered gap becomes [`Severity::Error`]
/// * black covering at least [`BLACK_PROGRAM_FRACTION_ERROR`] of the program in
///   total stays [`Severity::Error`] whether or not a gap explains it, and
///   whether it arrives as one stretch or twenty — a render that is dark for
///   most of its length is broken output, and a timeline full of picture makes
///   that more damning, not less
/// * black anywhere else drops to [`Severity::Info`] and is reported without a
///   verdict — nothing here can distinguish a deliberate fade from footage that
///   simply went dark, so the details state the fact and leave the call open
///
/// Uncovered gaps include the head and tail of the program (see
/// [`uncovered_video_gaps`]), so black at either end still grades as an error.
///
/// Black ranges are timed against the measured file while gaps are timed
/// against the timeline, so this is only meaningful for a render that covers
/// the whole sequence from zero.
///
/// The report's derived counters are recomputed afterwards. Returns the number
/// of violations that were re-graded.
pub fn crossref_black_ranges_with_gaps(
    report: &mut QCReport,
    sequence: &Sequence,
    min_gap_sec: f64,
) -> usize {
    let black_rule = super::rules::BlackFrameRule::new();
    let black_rule_name = black_rule.name().to_string();

    if !report
        .violations
        .iter()
        .any(|violation| violation.rule_name == black_rule_name)
    {
        return 0;
    }

    let gaps = uncovered_video_gaps(sequence, min_gap_sec);
    // Black ranges are measured from the rendered file, so the fraction they
    // cover is a fraction of what the render writes.
    let program_duration_sec = sequence.output_duration();
    let has_program = program_duration_sec.is_finite() && program_duration_sec > 0.0;

    // How dark the program is overall, which is the question the error grade
    // asks. A single range is only ever part of the answer: three separate
    // stretches of a fifth of the running time each leave two thirds of the
    // deliverable black while no one of them looks alarming.
    let black_spans: Vec<(f64, f64)> = report
        .violations
        .iter()
        .filter(|violation| violation.rule_name == black_rule_name)
        .filter_map(|violation| violation.location.as_ref())
        .map(|location| (location.start_sec, location.end_sec))
        .collect();
    let total_black_sec = merged_span_duration_sec(&black_spans);
    let total_black_fraction = has_program.then(|| total_black_sec / program_duration_sec);
    let program_is_mostly_black =
        total_black_fraction.is_some_and(|fraction| fraction >= BLACK_PROGRAM_FRACTION_ERROR);

    let mut regraded = 0;

    for violation in report
        .violations
        .iter_mut()
        .filter(|violation| violation.rule_name == black_rule_name)
    {
        let Some(location) = violation.location.clone() else {
            continue;
        };

        // Recorded on every black finding so the fractions an agent would have
        // to derive by hand — this range's own share, and the program's total —
        // are already in the report.
        let program_fraction = has_program.then(|| location.duration() / program_duration_sec);
        if let Some(fraction) = program_fraction {
            violation.metrics.insert(
                "programFraction".to_string(),
                serde_json::json!((fraction * 1000.0).round() / 1000.0),
            );
        }
        if let Some(fraction) = total_black_fraction {
            violation.metrics.insert(
                "programFractionTotal".to_string(),
                serde_json::json!((fraction * 1000.0).round() / 1000.0),
            );
            violation.metrics.insert(
                "totalBlackSec".to_string(),
                serde_json::json!((total_black_sec * 1000.0).round() / 1000.0),
            );
        }

        let overlapping = gaps
            .iter()
            .find(|gap| location.start_sec < gap.end_sec && location.end_sec > gap.start_sec);

        if let Some(gap) = overlapping {
            violation.severity = Severity::Error;
            violation.details = Some(format!(
                "Black covers a {:.2}s gap at {:.2}s on track '{}', so the program is \
                 missing picture here.",
                gap.duration_sec(),
                gap.start_sec,
                gap.track_name
            ));
            violation
                .metrics
                .insert("overlapsGap".to_string(), serde_json::Value::Bool(true));
            violation.affected_entities.push(gap.track_id.clone());
        } else {
            violation
                .metrics
                .insert("overlapsGap".to_string(), serde_json::Value::Bool(false));

            // No gap explains this black. That is the benign reading only while
            // the program is mostly picture; black over most of the running
            // time means the render is broken, and a timeline that is full of
            // picture makes that worse rather than better. The total is what
            // counts: how the darkness is split across ranges says nothing
            // about how much of the deliverable is missing.
            if program_is_mostly_black {
                violation.severity = Severity::Error;
                violation.details = Some(format!(
                    "Black covers {:.0}% of the {:.2}s program in total ({} range(s), {:.2}s) \
                     while the timeline has picture here, so the render itself is broken rather \
                     than the edit.",
                    total_black_fraction.unwrap_or_default() * 100.0,
                    program_duration_sec,
                    black_spans.len(),
                    total_black_sec
                ));
            } else {
                violation.severity = Severity::Info;
                violation.details = Some(
                    "No timeline gap overlaps this range; if this black is not an intentional \
                     fade or title card, inspect the timeline."
                        .to_string(),
                );
            }
        }

        regraded += 1;
    }

    report.recompute();
    regraded
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::assets::{Asset, AudioInfo, VideoInfo};
    use crate::core::qc::context::RenderMeasurements;
    use crate::core::timeline::SequenceFormat;

    // ========================================================================
    // Fixtures
    // ========================================================================

    fn sequence_30fps() -> Sequence {
        Sequence::new("QC Structural", SequenceFormat::youtube_1080())
    }

    fn context_for(sequence: &Sequence) -> QCContext {
        QCContext::from_sequence(sequence)
    }

    /// Reads the first per-cue entry out of a grouped caption violation.
    ///
    /// The caption rules report one violation per track and put each cue's own
    /// numbers under `cues`, so a test about a single caption asks for that
    /// cue rather than for a metric on the group.
    fn first_cue(violation: &QCViolation) -> &serde_json::Value {
        violation.metrics["cues"]
            .as_array()
            .and_then(|cues| cues.first())
            .expect("a grouped caption violation lists its cues")
    }

    fn video_clip(asset_id: &str, timeline_in: f64, duration: f64) -> Clip {
        let mut clip = Clip::with_range(asset_id, 0.0, duration);
        clip.place.timeline_in_sec = timeline_in;
        clip.place.duration_sec = duration;
        clip
    }

    fn caption_clip(text: &str, timeline_in: f64, duration: f64) -> Clip {
        let mut clip = Clip::with_range(CAPTION_VIRTUAL_ASSET_ID, 0.0, duration);
        clip.place.timeline_in_sec = timeline_in;
        clip.place.duration_sec = duration;
        clip.label = Some(text.to_string());
        clip
    }

    fn video_asset(id: &str, with_audio: bool) -> Asset {
        let mut asset = Asset::new_video(
            "clip.mp4",
            "clip.mp4",
            VideoInfo {
                width: 1920,
                height: 1080,
                codec: "h264".to_string(),
                ..Default::default()
            },
        );
        asset.id = id.to_string();
        if with_audio {
            asset.audio = Some(AudioInfo {
                sample_rate: 48_000,
                channels: 2,
                codec: "aac".to_string(),
                bitrate: None,
            });
        }
        asset
    }

    fn state_with(assets: Vec<Asset>) -> ProjectState {
        let mut state = ProjectState::new("QC Structural");
        for asset in assets {
            state.assets.insert(asset.id.clone(), asset);
        }
        state
    }

    // ========================================================================
    // Coverage helpers
    // ========================================================================

    #[test]
    fn test_subtract_coverage_should_return_the_whole_span_when_uncovered() {
        assert_eq!(subtract_coverage(1.0, 3.0, &[]), vec![(1.0, 3.0)]);
    }

    #[test]
    fn test_subtract_coverage_should_remove_a_fully_covered_span() {
        assert!(subtract_coverage(1.0, 3.0, &[(0.0, 5.0)]).is_empty());
    }

    #[test]
    fn test_subtract_coverage_should_split_around_partial_coverage() {
        assert_eq!(
            subtract_coverage(0.0, 10.0, &[(3.0, 6.0)]),
            vec![(0.0, 3.0), (6.0, 10.0)]
        );
    }

    // ========================================================================
    // TimelineGapRule
    // ========================================================================

    #[tokio::test]
    async fn test_gap_rule_should_report_an_uncovered_gap_as_an_error() {
        let mut sequence = sequence_30fps();
        let mut track = Track::new_video("V1");
        track.add_clip(video_clip("asset_1", 0.0, 2.0));
        track.add_clip(video_clip("asset_1", 3.0, 2.0));
        sequence.add_track(track);

        let context = context_for(&sequence);
        let violations = TimelineGapRule::new()
            .check(
                &sequence,
                &ProjectState::new("p"),
                &RuleConfig::default(),
                &context,
            )
            .await
            .expect("rule runs");

        assert_eq!(violations.len(), 1);
        assert_eq!(violations[0].severity, Severity::Error);
        let location = violations[0].location.as_ref().expect("location");
        assert!((location.start_sec - 2.0).abs() < 1e-9);
        assert!((location.end_sec - 3.0).abs() < 1e-9);
        assert!(violations[0].auto_fixable);
        assert_eq!(
            violations[0].suggested_fix.as_ref().expect("fix").commands[0]["type"],
            "CloseGap"
        );
    }

    #[tokio::test]
    async fn test_gap_rule_should_ignore_a_gap_covered_by_another_video_track() {
        let mut sequence = sequence_30fps();
        let mut overlay = Track::new_video("V2");
        overlay.add_clip(video_clip("asset_1", 0.0, 2.0));
        overlay.add_clip(video_clip("asset_1", 3.0, 2.0));
        sequence.add_track(overlay);

        let mut base = Track::new_video("V1");
        base.add_clip(video_clip("asset_1", 0.0, 5.0));
        sequence.add_track(base);

        let context = context_for(&sequence);
        let violations = TimelineGapRule::new()
            .check(
                &sequence,
                &ProjectState::new("p"),
                &RuleConfig::default(),
                &context,
            )
            .await
            .expect("rule runs");

        assert!(
            violations.is_empty(),
            "a gap under an uninterrupted base track is not a hole"
        );
    }

    /// Feature: Uncovered video gaps
    /// Scenario: should ignore a hidden track on both sides of the calculation
    #[tokio::test]
    async fn test_gap_rule_should_ignore_gaps_on_a_hidden_track() {
        let mut sequence = sequence_30fps();
        let mut hidden = Track::new_video("V1");
        hidden.visible = false;
        hidden.add_clip(video_clip("asset_1", 0.0, 2.0));
        hidden.add_clip(video_clip("asset_1", 3.0, 2.0));
        sequence.add_track(hidden);

        let context = context_for(&sequence);
        let violations = TimelineGapRule::new()
            .check(
                &sequence,
                &ProjectState::new("p"),
                &RuleConfig::default(),
                &context,
            )
            .await
            .expect("rule runs");

        assert!(
            violations.is_empty(),
            "a hidden track shows nothing, so its gaps are not holes in the program"
        );
    }

    /// Feature: Uncovered video gaps
    /// Scenario: should report black before the first video clip
    #[tokio::test]
    async fn test_gap_rule_should_report_black_before_the_first_clip() {
        let mut sequence = sequence_30fps();
        let mut track = Track::new_video("V1");
        track.add_clip(video_clip("asset_1", 2.0, 5.0));
        sequence.add_track(track);

        let context = context_for(&sequence);
        let violations = TimelineGapRule::new()
            .check(
                &sequence,
                &ProjectState::new("p"),
                &RuleConfig::default(),
                &context,
            )
            .await
            .expect("rule runs");

        assert_eq!(violations.len(), 1);
        assert_eq!(violations[0].severity, Severity::Error);
        let location = violations[0].location.as_ref().expect("location");
        assert!((location.start_sec - 0.0).abs() < 1e-9);
        assert!((location.end_sec - 2.0).abs() < 1e-9);
        assert!(
            !violations[0].auto_fixable,
            "CloseGap ripples one track, so closing a head gap would desync every other track"
        );
        assert!(violations[0].suggested_fix.is_none());
    }

    /// Feature: Uncovered video gaps
    /// Scenario: should not offer a per-track ripple that desyncs the program
    #[tokio::test]
    async fn test_gap_rule_should_not_offer_a_close_gap_fix_for_a_head_gap() {
        let mut sequence = sequence_30fps();
        let mut video = Track::new_video("V1");
        video.add_clip(video_clip("asset_1", 2.0, 5.0));
        sequence.add_track(video);

        // Audio that starts at zero is exactly what a head-gap CloseGap would
        // desync: the picture would move to zero and the sound would not.
        let mut audio = Track::new_audio("A1");
        audio.add_clip(video_clip("asset_1", 0.0, 7.0));
        sequence.add_track(audio);

        let head_gap = uncovered_video_gaps(&sequence, 1.0 / 30.0)
            .into_iter()
            .find(|gap| gap.start_sec == 0.0)
            .expect("head gap reported");

        assert!(
            !head_gap.closable,
            "a head gap has no single-track ripple that keeps the program in sync"
        );

        let context = context_for(&sequence);
        let violations = TimelineGapRule::new()
            .check(
                &sequence,
                &ProjectState::new("p"),
                &RuleConfig::default(),
                &context,
            )
            .await
            .expect("rule runs");

        assert!(violations
            .iter()
            .all(|violation| violation.suggested_fix.is_none()));
    }

    // ========================================================================
    // EmptySequenceRule
    // ========================================================================

    /// Feature: Empty sequence detection
    /// Scenario: should warn when no track holds a clip
    #[tokio::test]
    async fn test_empty_sequence_rule_should_warn_when_nothing_was_edited() {
        let mut sequence = sequence_30fps();
        sequence.add_track(Track::new_video("V1"));
        sequence.add_track(Track::new_audio("A1"));

        let context = context_for(&sequence);
        let violations = EmptySequenceRule::new()
            .check(
                &sequence,
                &ProjectState::new("p"),
                &RuleConfig::default(),
                &context,
            )
            .await
            .expect("rule runs");

        assert_eq!(violations.len(), 1);
        assert_eq!(violations[0].severity, Severity::Warning);
        assert_eq!(violations[0].metrics["clipCount"], 0);
        assert!(
            violations[0].suggested_fix.is_none(),
            "what belongs on an empty timeline is not a QC decision"
        );
    }

    /// Feature: Empty sequence detection
    /// Scenario: should stay silent once any track holds a clip
    #[tokio::test]
    async fn test_empty_sequence_rule_should_stay_silent_when_a_clip_exists() {
        let mut sequence = sequence_30fps();
        let mut track = Track::new_video("V1");
        track.add_clip(video_clip("asset_1", 0.0, 2.0));
        sequence.add_track(track);

        let context = context_for(&sequence);
        let violations = EmptySequenceRule::new()
            .check(
                &sequence,
                &ProjectState::new("p"),
                &RuleConfig::default(),
                &context,
            )
            .await
            .expect("rule runs");

        assert!(violations.is_empty());
    }

    /// Feature: Uncovered video gaps
    /// Scenario: should report black after the last video clip when audio runs longer
    #[tokio::test]
    async fn test_gap_rule_should_report_black_after_the_last_video_clip() {
        let mut sequence = sequence_30fps();
        let mut video = Track::new_video("V1");
        video.add_clip(video_clip("asset_1", 0.0, 4.0));
        sequence.add_track(video);

        let mut audio = Track::new_audio("A1");
        audio.add_clip(video_clip("asset_1", 0.0, 9.0));
        sequence.add_track(audio);

        let context = context_for(&sequence);
        let violations = TimelineGapRule::new()
            .check(
                &sequence,
                &ProjectState::new("p"),
                &RuleConfig::default(),
                &context,
            )
            .await
            .expect("rule runs");

        assert_eq!(violations.len(), 1);
        assert_eq!(violations[0].severity, Severity::Error);
        let location = violations[0].location.as_ref().expect("location");
        assert!((location.start_sec - 4.0).abs() < 1e-9);
        assert!((location.end_sec - 9.0).abs() < 1e-9);
        assert!(
            !violations[0].auto_fixable,
            "nothing follows the last clip, so CloseGap would be a no-op"
        );
    }

    /// Feature: Uncovered video gaps
    /// Scenario: should stay quiet when the picture spans the whole program
    #[tokio::test]
    async fn test_gap_rule_should_ignore_edges_when_video_covers_the_program() {
        let mut sequence = sequence_30fps();
        let mut video = Track::new_video("V1");
        video.add_clip(video_clip("asset_1", 0.0, 6.0));
        sequence.add_track(video);

        let mut audio = Track::new_audio("A1");
        audio.add_clip(video_clip("asset_1", 0.0, 6.0));
        sequence.add_track(audio);

        let context = context_for(&sequence);
        let violations = TimelineGapRule::new()
            .check(
                &sequence,
                &ProjectState::new("p"),
                &RuleConfig::default(),
                &context,
            )
            .await
            .expect("rule runs");

        assert!(violations.is_empty(), "got: {violations:?}");
    }

    /// Feature: Uncovered video gaps
    /// Scenario: should not grade an audio-only sequence as missing picture
    #[tokio::test]
    async fn test_gap_rule_should_ignore_a_sequence_without_video_clips() {
        let mut sequence = sequence_30fps();
        let mut audio = Track::new_audio("A1");
        audio.add_clip(video_clip("asset_1", 0.0, 8.0));
        sequence.add_track(audio);

        let context = context_for(&sequence);
        let violations = TimelineGapRule::new()
            .check(
                &sequence,
                &ProjectState::new("p"),
                &RuleConfig::default(),
                &context,
            )
            .await
            .expect("rule runs");

        assert!(violations.is_empty(), "got: {violations:?}");
    }

    #[tokio::test]
    async fn test_gap_rule_should_ignore_sub_frame_gaps() {
        let mut sequence = sequence_30fps();
        let mut track = Track::new_video("V1");
        track.add_clip(video_clip("asset_1", 0.0, 2.0));
        track.add_clip(video_clip("asset_1", 2.001, 2.0));
        sequence.add_track(track);

        let context = context_for(&sequence);
        let violations = TimelineGapRule::new()
            .check(
                &sequence,
                &ProjectState::new("p"),
                &RuleConfig::default(),
                &context,
            )
            .await
            .expect("rule runs");

        assert!(violations.is_empty());
    }

    // ========================================================================
    // ClipOrphanRule
    // ========================================================================

    #[tokio::test]
    async fn test_orphan_rule_should_report_clips_under_two_frames() {
        let mut sequence = sequence_30fps();
        let mut track = Track::new_video("V1");
        track.add_clip(video_clip("asset_1", 0.0, 0.02));
        track.add_clip(video_clip("asset_1", 1.0, 2.0));
        sequence.add_track(track);

        let context = context_for(&sequence);
        let violations = ClipOrphanRule::new()
            .check(
                &sequence,
                &ProjectState::new("p"),
                &RuleConfig::default(),
                &context,
            )
            .await
            .expect("rule runs");

        assert_eq!(violations.len(), 1);
        assert_eq!(violations[0].severity, Severity::Warning);
        assert_eq!(
            violations[0].suggested_fix.as_ref().expect("fix").commands[0]["type"],
            "RemoveClip"
        );
    }

    // ========================================================================
    // MissingAssetRule
    // ========================================================================

    #[tokio::test]
    async fn test_missing_asset_rule_should_report_unknown_and_missing_assets() {
        let mut sequence = sequence_30fps();
        let mut track = Track::new_video("V1");
        track.add_clip(video_clip("asset_unknown", 0.0, 2.0));
        track.add_clip(video_clip("asset_gone", 2.0, 2.0));
        track.add_clip(video_clip("asset_ok", 4.0, 2.0));
        sequence.add_track(track);

        let mut gone = video_asset("asset_gone", false);
        gone.missing = true;
        let state = state_with(vec![gone, video_asset("asset_ok", false)]);

        let context = context_for(&sequence);
        let violations = MissingAssetRule::new()
            .check(&sequence, &state, &RuleConfig::default(), &context)
            .await
            .expect("rule runs");

        assert_eq!(violations.len(), 2);
        assert!(violations
            .iter()
            .all(|violation| violation.severity == Severity::Critical));
    }

    #[tokio::test]
    async fn should_tell_a_quarantined_asset_apart_from_one_whose_file_is_gone() {
        // A quarantined asset has no path left to print, and "restore the file"
        // is the wrong advice for it: the file may well be there, it is the
        // stored path that will not be opened.
        let mut sequence = sequence_30fps();
        let mut track = Track::new_video("V1");
        track.add_clip(video_clip("asset_quarantined", 0.0, 2.0));
        sequence.add_track(track);

        let mut quarantined = video_asset("asset_quarantined", false);
        quarantined.uri = String::new();
        quarantined.missing = true;
        quarantined.quarantined_uri = Some(r"\\attacker.example\share\payload.mp4".to_string());
        let state = state_with(vec![quarantined]);

        let context = context_for(&sequence);
        let violations = MissingAssetRule::new()
            .check(&sequence, &state, &RuleConfig::default(), &context)
            .await
            .expect("rule runs");

        assert_eq!(violations.len(), 1);
        let violation = &violations[0];
        assert!(
            violation.message.contains("rejected as unsafe"),
            "unexpected message: {}",
            violation.message
        );
        let details = violation.details.as_deref().unwrap_or_default();
        assert!(
            details.contains(r"\\attacker.example\share\payload.mp4"),
            "the rejected path must be shown so the user recognises it: {details}"
        );
        assert!(
            details.contains("relink"),
            "the fix must be actionable: {details}"
        );
    }

    #[tokio::test]
    async fn test_missing_asset_rule_should_ignore_virtual_clips() {
        let mut sequence = sequence_30fps();
        let mut captions = Track::new_caption("C1");
        captions.add_clip(caption_clip("Hello", 0.0, 2.0));
        sequence.add_track(captions);

        let mut video = Track::new_video("V1");
        video.add_clip(video_clip("__text__title", 0.0, 2.0));
        sequence.add_track(video);

        let context = context_for(&sequence);
        let violations = MissingAssetRule::new()
            .check(
                &sequence,
                &ProjectState::new("p"),
                &RuleConfig::default(),
                &context,
            )
            .await
            .expect("rule runs");

        assert!(violations.is_empty());
    }

    // ========================================================================
    // SilentClipRule
    // ========================================================================

    #[tokio::test]
    async fn test_silent_clip_rule_should_report_a_muted_audio_bearing_clip() {
        let mut sequence = sequence_30fps();
        let mut track = Track::new_video("V1");
        let mut clip = video_clip("asset_a", 0.0, 2.0);
        clip.audio.muted = true;
        track.add_clip(clip);
        sequence.add_track(track);

        let state = state_with(vec![video_asset("asset_a", true)]);
        let context = context_for(&sequence);

        let violations = SilentClipRule::new()
            .check(&sequence, &state, &RuleConfig::default(), &context)
            .await
            .expect("rule runs");

        assert_eq!(violations.len(), 1);
        assert_eq!(violations[0].severity, Severity::Warning);
    }

    #[tokio::test]
    async fn test_silent_clip_rule_should_ignore_clips_without_audio() {
        let mut sequence = sequence_30fps();
        let mut track = Track::new_video("V1");
        let mut clip = video_clip("asset_a", 0.0, 2.0);
        clip.audio.muted = true;
        track.add_clip(clip);
        sequence.add_track(track);

        let state = state_with(vec![video_asset("asset_a", false)]);
        let context = context_for(&sequence);

        let violations = SilentClipRule::new()
            .check(&sequence, &state, &RuleConfig::default(), &context)
            .await
            .expect("rule runs");

        assert!(violations.is_empty());
    }

    #[tokio::test]
    async fn test_silent_clip_rule_should_ignore_a_muted_clip_with_automation() {
        let mut sequence = sequence_30fps();
        let mut track = Track::new_audio("A1");
        let mut clip = video_clip("asset_a", 0.0, 2.0);
        clip.audio.volume_db = -60.0;
        clip.audio.volume_keyframes = vec![crate::core::timeline::AudioKeyframe::new(
            0.5,
            0.0,
            crate::core::timeline::KeyframeInterpolation::default(),
        )];
        track.add_clip(clip);
        sequence.add_track(track);

        let state = state_with(vec![video_asset("asset_a", true)]);
        let context = context_for(&sequence);

        let violations = SilentClipRule::new()
            .check(&sequence, &state, &RuleConfig::default(), &context)
            .await
            .expect("rule runs");

        assert!(violations.is_empty());
    }

    // ========================================================================
    // CaptionOverlapRule
    // ========================================================================

    #[tokio::test]
    async fn test_caption_overlap_rule_should_report_colliding_captions() {
        let mut sequence = sequence_30fps();
        let mut track = Track::new_caption("C1");
        track.add_clip(caption_clip("First", 0.0, 2.0));
        track.add_clip(caption_clip("Second", 1.5, 2.0));
        sequence.add_track(track);

        let context = context_for(&sequence);
        let violations = CaptionOverlapRule::new()
            .check(
                &sequence,
                &ProjectState::new("p"),
                &RuleConfig::default(),
                &context,
            )
            .await
            .expect("rule runs");

        assert_eq!(violations.len(), 1);
        assert_eq!(violations[0].severity, Severity::Error);
        let location = violations[0].location.as_ref().expect("location");
        assert!((location.start_sec - 1.5).abs() < 1e-9);
        assert!((location.end_sec - 2.0).abs() < 1e-9);
    }

    #[tokio::test]
    async fn test_caption_overlap_rule_should_accept_back_to_back_captions() {
        let mut sequence = sequence_30fps();
        let mut track = Track::new_caption("C1");
        track.add_clip(caption_clip("First", 0.0, 2.0));
        track.add_clip(caption_clip("Second", 2.0, 2.0));
        sequence.add_track(track);

        let context = context_for(&sequence);
        let violations = CaptionOverlapRule::new()
            .check(
                &sequence,
                &ProjectState::new("p"),
                &RuleConfig::default(),
                &context,
            )
            .await
            .expect("rule runs");

        assert!(violations.is_empty());
    }

    // ========================================================================
    // CaptionReadingRateRule
    // ========================================================================

    #[test]
    fn test_detect_script_should_classify_latin_and_cjk_text() {
        assert_eq!(
            CaptionReadingRateRule::detect_script("The quick brown fox"),
            CaptionScript::Latin
        );
        assert_eq!(
            CaptionReadingRateRule::detect_script("안녕하세요 여러분"),
            CaptionScript::Cjk
        );
        assert_eq!(
            CaptionReadingRateRule::detect_script("これはテストです"),
            CaptionScript::Cjk
        );
        // A stray loanword must not flip a Korean caption to Latin thresholds.
        assert_eq!(
            CaptionReadingRateRule::detect_script("오늘의 AI 뉴스입니다"),
            CaptionScript::Cjk
        );
    }

    #[tokio::test]
    async fn test_reading_rate_rule_should_use_latin_thresholds_for_latin_text() {
        let mut sequence = sequence_30fps();
        let mut track = Track::new_caption("C1");
        // 30 characters in 1s => 30 cps, above the 20 cps Latin limit.
        track.add_clip(caption_clip("abcdefghij abcdefghij abcdefg", 0.0, 1.0));
        // 15 characters in 1s => 15 cps, comfortable for Latin.
        track.add_clip(caption_clip("abcdefghij abcd", 2.0, 1.0));
        sequence.add_track(track);

        let context = context_for(&sequence);
        let violations = CaptionReadingRateRule::new()
            .check(
                &sequence,
                &ProjectState::new("p"),
                &RuleConfig::default(),
                &context,
            )
            .await
            .expect("rule runs");

        // One violation for the track, listing the single cue that breached.
        assert_eq!(violations.len(), 1);
        assert_eq!(violations[0].severity, Severity::Warning);
        assert_eq!(violations[0].metrics["cueCount"], 1);
        assert_eq!(first_cue(&violations[0])["script"], "latin");
    }

    #[tokio::test]
    async fn test_reading_rate_rule_should_use_cjk_thresholds_for_korean_text() {
        let mut sequence = sequence_30fps();
        let mut track = Track::new_caption("C1");
        // 15 Hangul characters in 1s: fine for Latin, far too fast for CJK.
        track.add_clip(caption_clip("가나다라마바사아자차카타파하가", 0.0, 1.0));
        sequence.add_track(track);

        let context = context_for(&sequence);
        let violations = CaptionReadingRateRule::new()
            .check(
                &sequence,
                &ProjectState::new("p"),
                &RuleConfig::default(),
                &context,
            )
            .await
            .expect("rule runs");

        assert_eq!(violations.len(), 1);
        assert_eq!(first_cue(&violations[0])["script"], "cjk");
        assert_eq!(first_cue(&violations[0])["warnCps"], 9.0);
    }

    /// Runs the reading-rate rule over a sequence.
    async fn reading_rate_violations(sequence: &Sequence) -> Vec<QCViolation> {
        CaptionReadingRateRule::new()
            .check(
                sequence,
                &ProjectState::new("p"),
                &RuleConfig::default(),
                &context_for(sequence),
            )
            .await
            .expect("rule runs")
    }

    /// A sequence with ten seconds of picture, so a caption has room after it.
    fn sequence_with_ten_seconds_of_picture() -> Sequence {
        let mut sequence = sequence_30fps();
        let mut video = Track::new_video("V1");
        video.add_clip(video_clip("asset_1", 0.0, 10.0));
        sequence.add_track(video);
        sequence
    }

    /// Feature: Repairing an over-fast caption
    /// Scenario: should extend the cue into the gap that follows it
    ///
    /// Holding the words longer is the complete repair — the cue then reads at
    /// a comfortable rate and nothing about the edit is left to judge — so the
    /// finding really is automatically fixable.
    #[tokio::test]
    async fn test_reading_rate_rule_should_extend_a_cue_into_the_following_gap() {
        let mut sequence = sequence_with_ten_seconds_of_picture();
        let mut track = Track::new_caption("C1");
        // 29 characters in 1s: 29 cps against the 20 cps Latin limit, so the
        // cue needs 1.45s to be comfortable and the track has room to give it.
        track.add_clip(caption_clip("abcdefghij abcdefghij abcdefg", 0.0, 1.0));
        sequence.add_track(track);

        let violations = reading_rate_violations(&sequence).await;

        assert_eq!(violations.len(), 1);
        let violation = &violations[0];
        assert!(violation.auto_fixable, "an extension finishes the job");
        assert_eq!(first_cue(violation)["repair"], "extend");

        let fix = violation.suggested_fix.as_ref().expect("a repair");
        assert_eq!(fix.commands.len(), 1);
        assert_eq!(fix.commands[0]["type"], "UpdateCaption");
        assert!(
            (fix.commands[0]["endSec"].as_f64().expect("an end time") - 1.45).abs() < 1e-6,
            "the cue must be held exactly long enough: {}",
            fix.commands[0]
        );
    }

    /// Feature: Repairing an over-fast caption
    /// Scenario: should propose a split when the gap cannot hold the time
    ///
    /// A split rewrites one caption into two, which is a judgement about the
    /// line rather than a setting, so the finding keeps the plan and drops the
    /// claim that it can be applied unread.
    #[tokio::test]
    async fn test_reading_rate_rule_should_propose_a_split_when_extension_is_not_enough() {
        let mut sequence = sequence_with_ten_seconds_of_picture();
        let mut track = Track::new_caption("C1");
        track.add_clip(caption_clip("abcdefghij abcdefghij abcdefg", 0.0, 1.0));
        // Starts almost immediately, so there is nowhere for the cue to grow.
        track.add_clip(caption_clip("Next", 1.2, 0.8));
        sequence.add_track(track);

        let violations = reading_rate_violations(&sequence).await;

        assert_eq!(violations.len(), 1, "one violation for the track");
        let violation = &violations[0];
        assert_eq!(violation.metrics["cueCount"], 1, "only the fast cue");
        assert!(
            !violation.auto_fixable,
            "a proposed split is not an automatic repair"
        );
        assert_eq!(first_cue(violation)["repair"], "split");

        let fix = violation.suggested_fix.as_ref().expect("a proposal");
        assert_eq!(fix.commands[0]["type"], "UpdateCaption");
        assert_eq!(fix.commands[1]["type"], "CreateCaption");

        let split_sec = fix.commands[0]["endSec"].as_f64().expect("a split point");
        assert_eq!(
            fix.commands[1]["startSec"].as_f64().expect("a start"),
            split_sec,
            "the second half must begin where the first one ends"
        );
        // The ceiling is a frame before the next cue; times are reported to the
        // millisecond, so what has to hold is that the pair never reaches it.
        assert!(
            fix.commands[1]["endSec"].as_f64().expect("an end") < 1.2,
            "the pair must not run into the cue that follows: {}",
            fix.commands[1]
        );
        assert_ne!(
            fix.commands[0]["text"], fix.commands[1]["text"],
            "the line has to actually be broken in two"
        );
    }

    /// Feature: Repairing an over-fast caption
    /// Scenario: should report one violation covering every fast cue on a track
    #[tokio::test]
    async fn test_reading_rate_rule_should_group_every_fast_cue_on_a_track() {
        let mut sequence = sequence_with_ten_seconds_of_picture();
        let mut track = Track::new_caption("C1");
        for index in 0..3 {
            track.add_clip(caption_clip(
                "abcdefghij abcdefghij abcdefg",
                f64::from(index) * 2.0,
                1.0,
            ));
        }
        sequence.add_track(track);

        let violations = reading_rate_violations(&sequence).await;

        assert_eq!(violations.len(), 1, "three cues, one thing to do about it");
        assert_eq!(violations[0].metrics["cueCount"], 3);
        assert_eq!(violations[0].affected_entities.len(), 3);
        assert_eq!(
            violations[0]
                .suggested_fix
                .as_ref()
                .expect("a grouped repair")
                .commands
                .len(),
            3,
            "one step per cue, applied as a single plan"
        );
    }

    /// Feature: Repairing an over-fast caption
    /// Scenario: should keep the cue's look and place when it splits the line
    ///
    /// `CreateCaption` falls back to the caption defaults, so a split that did
    /// not copy the style and the position moved half the line into a different
    /// font, in a different part of the frame — the split cost more than the
    /// reading rate it was fixing.
    #[tokio::test]
    async fn test_reading_rate_rule_should_carry_style_and_position_into_a_split() {
        let style = serde_json::json!({
            "fontFamily": "Inter",
            "fontSize": 64,
            "outlineColor": "#000000",
            "outlineWidth": 4,
        });
        let position = serde_json::json!({
            "type": "preset",
            "vertical": "top",
            "marginPercent": 12.0,
        });

        let mut sequence = sequence_with_ten_seconds_of_picture();
        let mut track = Track::new_caption("C1");
        let mut fast = caption_clip("abcdefghij abcdefghij abcdefg", 0.0, 1.0);
        fast.caption_style = Some(style.clone());
        fast.caption_position = Some(position.clone());
        track.add_clip(fast);
        // Leaves no room to extend, so the repair has to be a split.
        track.add_clip(caption_clip("Next", 1.2, 0.8));
        sequence.add_track(track);

        let violations = reading_rate_violations(&sequence).await;

        assert_eq!(violations.len(), 1);
        let fix = violations[0].suggested_fix.as_ref().expect("a proposal");
        assert_eq!(fix.commands[1]["type"], "CreateCaption");
        assert_eq!(
            fix.commands[1]["style"], style,
            "the new half must be drawn the way the cue was: {}",
            fix.commands[1]
        );
        assert_eq!(
            fix.commands[1]["position"], position,
            "the new half must sit where the cue sat: {}",
            fix.commands[1]
        );
    }

    /// Feature: Repairing an over-fast caption
    /// Scenario: should leave the payload alone for an unstyled cue
    #[tokio::test]
    async fn test_reading_rate_rule_should_omit_style_when_the_cue_carries_none() {
        let mut sequence = sequence_with_ten_seconds_of_picture();
        let mut track = Track::new_caption("C1");
        track.add_clip(caption_clip("abcdefghij abcdefghij abcdefg", 0.0, 1.0));
        track.add_clip(caption_clip("Next", 1.2, 0.8));
        sequence.add_track(track);

        let violations = reading_rate_violations(&sequence).await;
        let fix = violations[0].suggested_fix.as_ref().expect("a proposal");

        assert!(fix.commands[1].get("style").is_none());
        assert!(fix.commands[1].get("position").is_none());
    }

    // ========================================================================
    // CaptionOutOfBoundsRule
    // ========================================================================

    #[tokio::test]
    async fn test_out_of_bounds_rule_should_report_a_caption_off_canvas() {
        let mut sequence = sequence_30fps();
        let mut track = Track::new_caption("C1");
        let mut clip = caption_clip("Way off", 0.0, 2.0);
        clip.caption_position = Some(serde_json::json!({
            "type": "custom",
            "xPercent": 120.0,
            "yPercent": 50.0
        }));
        track.add_clip(clip);
        sequence.add_track(track);

        let context = context_for(&sequence);
        let violations = CaptionOutOfBoundsRule::new()
            .check(
                &sequence,
                &ProjectState::new("p"),
                &RuleConfig::default(),
                &context,
            )
            .await
            .expect("rule runs");

        assert_eq!(violations.len(), 1);
        assert_eq!(violations[0].severity, Severity::Error);
    }

    /// Feature: Captions pushed off the canvas
    /// Scenario: should report one violation for the whole track
    ///
    /// A caption track anchored off the frame is one wrong setting. Reported
    /// one cue at a time it looked like forty problems, and the report had no
    /// way to say that the answer to all of them is the same.
    #[tokio::test]
    async fn test_out_of_bounds_rule_should_group_every_off_canvas_cue() {
        let mut sequence = sequence_30fps();
        let mut track = Track::new_caption("C1");
        for index in 0..4 {
            let mut clip = caption_clip("Way off", f64::from(index) * 2.0, 2.0);
            clip.caption_position = Some(serde_json::json!({
                "type": "custom",
                "xPercent": 120.0,
                "yPercent": 50.0
            }));
            track.add_clip(clip);
        }
        sequence.add_track(track);

        let context = context_for(&sequence);
        let violations = CaptionOutOfBoundsRule::new()
            .check(
                &sequence,
                &ProjectState::new("p"),
                &RuleConfig::default(),
                &context,
            )
            .await
            .expect("rule runs");

        assert_eq!(violations.len(), 1);
        assert_eq!(violations[0].metrics["cueCount"], 4);
        assert_eq!(violations[0].affected_entities.len(), 4);
        assert_eq!(
            violations[0]
                .metrics
                .get("cues")
                .and_then(|cues| cues.as_array())
                .map(Vec::len),
            Some(4),
            "every cue has to be listed, not just counted"
        );
        assert!(
            violations[0].suggested_fix.is_none() && !violations[0].auto_fixable,
            "where a caption pushed off the frame belongs is a composition call"
        );
        let location = violations[0].location.as_ref().expect("a span");
        assert_eq!(location.start_sec, 0.0);
        assert_eq!(location.end_sec, 8.0);
    }

    #[tokio::test]
    async fn test_out_of_bounds_rule_should_accept_default_positions() {
        let mut sequence = sequence_30fps();
        let mut track = Track::new_caption("C1");
        track.add_clip(caption_clip("Perfectly normal caption", 0.0, 2.0));
        sequence.add_track(track);

        let context = context_for(&sequence);
        let violations = CaptionOutOfBoundsRule::new()
            .check(
                &sequence,
                &ProjectState::new("p"),
                &RuleConfig::default(),
                &context,
            )
            .await
            .expect("rule runs");

        assert!(violations.is_empty());
    }

    // ========================================================================
    // ShotLengthStatsRule
    // ========================================================================

    #[test]
    fn test_shot_length_stats_should_describe_the_distribution() {
        let mut sequence = sequence_30fps();
        let mut track = Track::new_video("V1");
        for (index, duration) in [1.0, 2.0, 3.0, 10.0].iter().enumerate() {
            track.add_clip(video_clip("asset_1", index as f64 * 20.0, *duration));
        }
        sequence.add_track(track);

        let stats = shot_length_stats(&sequence);

        assert_eq!(stats.count, 4);
        assert!((stats.min_sec - 1.0).abs() < 1e-9);
        assert!((stats.median_sec - 2.0).abs() < 1e-9);
        assert!((stats.p90_sec - 10.0).abs() < 1e-9);
        assert!((stats.max_sec - 10.0).abs() < 1e-9);
        assert!((stats.total_sec - 16.0).abs() < 1e-9);
    }

    #[tokio::test]
    async fn test_shot_length_stats_rule_should_always_emit_metrics() {
        let sequence = sequence_30fps();
        let context = context_for(&sequence);

        let violations = ShotLengthStatsRule::new()
            .check(
                &sequence,
                &ProjectState::new("p"),
                &RuleConfig::default(),
                &context,
            )
            .await
            .expect("rule runs");

        assert_eq!(violations.len(), 1);
        assert_eq!(violations[0].severity, Severity::Info);
        assert_eq!(violations[0].metrics["count"], 0);
    }

    // ========================================================================
    // Cross-reference
    // ========================================================================

    async fn report_with_black_range(sequence: &Sequence, range: (f64, f64)) -> QCReport {
        report_with_black_ranges(sequence, vec![range]).await
    }

    async fn report_with_black_ranges(sequence: &Sequence, ranges: Vec<(f64, f64)>) -> QCReport {
        let mut engine = super::super::engine::QCEngine::new();
        let mut config = super::super::engine::QCEngineConfig::default();
        for name in engine
            .rule_names()
            .into_iter()
            .map(|name| name.to_string())
            .collect::<Vec<_>>()
        {
            if name != "BlackFrameRule" {
                config.disable_rule(&name);
            }
        }
        engine.set_config(config).await;
        // Keep the engine binding mutable-free after configuration.
        let _ = &mut engine;

        engine
            .check_with_measurements(
                sequence,
                &ProjectState::new("p"),
                RenderMeasurements {
                    black_ranges: ranges,
                    ..Default::default()
                },
            )
            .await
            .expect("check runs")
    }

    #[tokio::test]
    async fn test_crossref_should_escalate_black_over_a_gap_to_error() {
        let mut sequence = sequence_30fps();
        let mut track = Track::new_video("V1");
        track.add_clip(video_clip("asset_1", 0.0, 2.0));
        track.add_clip(video_clip("asset_1", 3.0, 2.0));
        sequence.add_track(track);

        let mut report = report_with_black_range(&sequence, (2.0, 3.0)).await;
        let regraded = crossref_black_ranges_with_gaps(&mut report, &sequence, 1.0 / 30.0);

        assert_eq!(regraded, 1);
        assert_eq!(report.violations[0].severity, Severity::Error);
        assert_eq!(report.violations[0].metrics["overlapsGap"], true);
        assert!(!report.passed);
    }

    #[tokio::test]
    async fn test_crossref_should_demote_intentional_black_to_info() {
        let mut sequence = sequence_30fps();
        let mut track = Track::new_video("V1");
        track.add_clip(video_clip("asset_1", 0.0, 5.0));
        sequence.add_track(track);

        let mut report = report_with_black_range(&sequence, (0.0, 1.0)).await;
        let regraded = crossref_black_ranges_with_gaps(&mut report, &sequence, 1.0 / 30.0);

        assert_eq!(regraded, 1);
        assert_eq!(report.violations[0].severity, Severity::Info);
        assert_eq!(report.violations[0].metrics["overlapsGap"], false);
        assert!(report.passed);
    }

    /// Feature: Cross-referenced black detection
    /// Scenario: should keep black over a head gap graded as an error
    #[tokio::test]
    async fn test_crossref_should_escalate_black_over_a_head_gap_to_error() {
        let mut sequence = sequence_30fps();
        let mut track = Track::new_video("V1");
        track.add_clip(video_clip("asset_1", 2.0, 5.0));
        sequence.add_track(track);

        let mut report = report_with_black_range(&sequence, (0.0, 2.0)).await;
        let regraded = crossref_black_ranges_with_gaps(&mut report, &sequence, 1.0 / 30.0);

        assert_eq!(regraded, 1);
        assert_eq!(
            report.violations[0].severity,
            Severity::Error,
            "black over a two-second head gap is missing picture, not a title card"
        );
        assert_eq!(report.violations[0].metrics["overlapsGap"], true);
        assert!(!report.passed);
    }

    /// Feature: Cross-referenced black detection
    /// Scenario: should keep an end-to-end black render graded as an error
    #[tokio::test]
    async fn test_crossref_should_keep_black_over_the_whole_program_as_an_error() {
        let mut sequence = sequence_30fps();
        let mut track = Track::new_video("V1");
        // Continuous picture across the whole program: nothing in the timeline
        // explains the black, which is exactly what makes the render broken.
        track.add_clip(video_clip("asset_1", 0.0, 10.0));
        sequence.add_track(track);

        let mut report = report_with_black_range(&sequence, (0.0, 10.0)).await;
        let regraded = crossref_black_ranges_with_gaps(&mut report, &sequence, 1.0 / 30.0);

        assert_eq!(regraded, 1);
        assert_eq!(
            report.violations[0].severity,
            Severity::Error,
            "a render that is black end to end must never be downgraded to info"
        );
        assert_eq!(report.violations[0].metrics["overlapsGap"], false);
        assert_eq!(report.violations[0].metrics["programFraction"], 1.0);
        assert!(
            !report.passed,
            "verify must exit non-zero on a fully black render"
        );
    }

    /// Feature: Cross-referenced black detection
    /// Scenario: should keep grading black over most of the program as an error
    #[tokio::test]
    async fn test_crossref_should_keep_black_over_most_of_the_program_as_an_error() {
        let mut sequence = sequence_30fps();
        let mut track = Track::new_video("V1");
        track.add_clip(video_clip("asset_1", 0.0, 10.0));
        sequence.add_track(track);

        let mut report = report_with_black_range(&sequence, (1.0, 7.0)).await;
        crossref_black_ranges_with_gaps(&mut report, &sequence, 1.0 / 30.0);

        assert_eq!(report.violations[0].severity, Severity::Error);
        assert_eq!(report.violations[0].metrics["programFraction"], 0.6);
    }

    /// Feature: Cross-referenced black detection
    /// Scenario: should error when separate black ranges cover most of the program
    ///
    /// Regression: the "black covers half the program" rule was applied to one
    /// range at a time, so a render broken into three dark fifths — sixty per
    /// cent of the deliverable, none of it individually alarming — was
    /// downgraded to info and passed.
    #[tokio::test]
    async fn test_crossref_should_error_when_black_ranges_add_up_to_most_of_the_program() {
        let mut sequence = sequence_30fps();
        let mut track = Track::new_video("V1");
        // Continuous picture: the timeline explains none of the black below.
        track.add_clip(video_clip("asset_1", 0.0, 10.0));
        sequence.add_track(track);

        let mut report =
            report_with_black_ranges(&sequence, vec![(0.0, 2.0), (4.0, 6.0), (8.0, 10.0)]).await;
        let regraded = crossref_black_ranges_with_gaps(&mut report, &sequence, 1.0 / 30.0);

        assert_eq!(regraded, 3);
        for violation in &report.violations {
            assert_eq!(
                violation.severity,
                Severity::Error,
                "60% of the program is black, however it is split up: {violation:?}"
            );
            assert_eq!(
                violation.metrics["programFraction"], 0.2,
                "no single range crosses the threshold on its own"
            );
            assert_eq!(violation.metrics["programFractionTotal"], 0.6);
            assert_eq!(violation.metrics["totalBlackSec"], 6.0);
        }
        assert!(
            !report.passed,
            "verify must exit non-zero on a mostly black render"
        );
    }

    /// Feature: Cross-referenced black detection
    /// Scenario: should still treat several short fades as informational
    #[tokio::test]
    async fn test_crossref_should_leave_scattered_short_fades_informational() {
        let mut sequence = sequence_30fps();
        let mut track = Track::new_video("V1");
        track.add_clip(video_clip("asset_1", 0.0, 20.0));
        sequence.add_track(track);

        // Three half-second fades: 7.5% of the program in total.
        let mut report =
            report_with_black_ranges(&sequence, vec![(0.0, 0.5), (9.0, 9.5), (19.5, 20.0)]).await;
        crossref_black_ranges_with_gaps(&mut report, &sequence, 1.0 / 30.0);

        for violation in &report.violations {
            assert_eq!(violation.severity, Severity::Info, "{violation:?}");
        }
        assert!(report.passed);
    }

    /// Feature: Cross-referenced black detection
    /// Scenario: should still treat a short unexplained fade as informational
    #[tokio::test]
    async fn test_crossref_should_leave_a_short_fade_informational() {
        let mut sequence = sequence_30fps();
        let mut track = Track::new_video("V1");
        track.add_clip(video_clip("asset_1", 0.0, 10.0));
        sequence.add_track(track);

        let mut report = report_with_black_range(&sequence, (9.0, 10.0)).await;
        crossref_black_ranges_with_gaps(&mut report, &sequence, 1.0 / 30.0);

        assert_eq!(report.violations[0].severity, Severity::Info);
        assert!(report.passed);
    }

    // ========================================================================
    // TransitionNoHandlesRule
    // ========================================================================

    /// A two-clip sequence where the outgoing clip carries a dissolve.
    ///
    /// `outgoing_source_length` is how long the outgoing clip's media runs. The
    /// clip always uses 0..5s of it, so a length of 5.0 leaves no handle and a
    /// length of 9.0 leaves four seconds of one.
    fn sequence_with_dissolve(outgoing_source_length: f64) -> (Sequence, ProjectState) {
        use crate::core::effects::{Effect, EffectType, ParamValue};

        let mut state = ProjectState::new("QC Transitions");
        let mut sequence = sequence_30fps();
        let mut track = Track::new_video("V1");
        track.id = "track-1".to_string();

        let mut dissolve = Effect::new(EffectType::CrossDissolve);
        dissolve.id = "dissolve-1".to_string();
        dissolve.set_param("duration", ParamValue::Float(1.0));
        dissolve.enabled = true;
        state.effects.insert(dissolve.id.clone(), dissolve.clone());

        // The outgoing clip runs to the end of whatever media it has.
        let mut outgoing = Clip::with_range("asset_out", 0.0, 5.0);
        outgoing.id = "clip-out".to_string();
        outgoing.place.timeline_in_sec = 0.0;
        outgoing.place.duration_sec = 5.0;
        outgoing.effects.push(dissolve.id.clone());
        track.add_clip(outgoing);

        // The incoming clip starts two seconds into a nine-second source, so it
        // always has a handle of its own.
        let mut incoming = Clip::with_range("asset_in", 2.0, 7.0);
        incoming.id = "clip-in".to_string();
        incoming.place.timeline_in_sec = 5.0;
        incoming.place.duration_sec = 5.0;
        track.add_clip(incoming);

        sequence.add_track(track);

        let mut outgoing_asset = video_asset("asset_out", false);
        outgoing_asset.duration_sec = Some(outgoing_source_length);
        let mut incoming_asset = video_asset("asset_in", false);
        incoming_asset.duration_sec = Some(9.0);
        state.assets.insert("asset_out".to_string(), outgoing_asset);
        state.assets.insert("asset_in".to_string(), incoming_asset);

        (sequence, state)
    }

    #[tokio::test]
    async fn should_report_a_transition_the_render_will_not_blend() {
        // The outgoing clip uses its source to the last frame, so there is no
        // unused media to reach into and the boundary comes out as a hard cut.
        let (sequence, state) = sequence_with_dissolve(5.0);
        let context = context_for(&sequence);

        let violations = TransitionNoHandlesRule::new()
            .check(&sequence, &state, &RuleConfig::default(), &context)
            .await
            .expect("rule runs without a render");

        assert_eq!(violations.len(), 1, "{violations:?}");
        assert_eq!(violations[0].severity, Severity::Warning);
        assert!(
            violations[0].message.contains("hard cut"),
            "the finding must say what the file will show: {}",
            violations[0].message
        );
        assert!(
            violations[0]
                .details
                .as_deref()
                .is_some_and(|details| details.contains("handle")),
            "the finding must carry the reason from the planner: {:?}",
            violations[0].details
        );

        let fix = violations[0].suggested_fix.as_ref().expect("a fix");
        assert_eq!(fix.commands[0]["type"], "RemoveEffect");
        assert_eq!(fix.commands[0]["effectId"], "dissolve-1");
        assert_eq!(fix.commands[0]["clipId"], "clip-out");
        assert_eq!(fix.commands[0]["trackId"], "track-1");
    }

    #[tokio::test]
    async fn should_stay_silent_about_a_transition_the_render_will_blend() {
        // Four seconds of unused media past the out point is far more than the
        // half-second handle a one-second dissolve needs.
        let (sequence, state) = sequence_with_dissolve(9.0);
        let context = context_for(&sequence);

        let violations = TransitionNoHandlesRule::new()
            .check(&sequence, &state, &RuleConfig::default(), &context)
            .await
            .expect("rule runs without a render");

        assert!(
            violations.is_empty(),
            "a transition that renders is not a finding: {violations:?}"
        );
    }

    #[tokio::test]
    async fn should_stay_silent_when_the_sequence_holds_no_transitions() {
        let mut sequence = sequence_30fps();
        let mut track = Track::new_video("V1");
        track.add_clip(video_clip("asset_1", 0.0, 5.0));
        track.add_clip(video_clip("asset_1", 5.0, 5.0));
        sequence.add_track(track);
        let context = context_for(&sequence);

        let violations = TransitionNoHandlesRule::new()
            .check(
                &sequence,
                &state_with(vec![video_asset("asset_1", false)]),
                &RuleConfig::default(),
                &context,
            )
            .await
            .expect("rule runs without a render");

        assert!(violations.is_empty(), "{violations:?}");
    }
}
