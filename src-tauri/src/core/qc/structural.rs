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

use super::context::QCContext;
use super::engine::QCReport;
use super::rules::{QCRule, RuleConfig};
use super::violation::{QCViolation, Severity, ViolationFix};
use crate::core::captions::{CaptionPosition, CaptionStyle, VerticalPosition};
use crate::core::commands::find_gaps;
use crate::core::project::ProjectState;
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

    let program_end_sec = sequence.duration();
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
        _context: &QCContext,
    ) -> CoreResult<Vec<QCViolation>> {
        let severity = config.severity_override.unwrap_or(self.default_severity());
        let mut violations = Vec::new();

        for track in sequence.tracks.iter().filter(|track| track.is_caption()) {
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

                if cps <= warn_cps {
                    continue;
                }

                let qualifier = if cps > severe_cps {
                    "far above"
                } else {
                    "above"
                };

                violations.push(
                    QCViolation::new(
                        self.name(),
                        severity,
                        format!(
                            "Caption reads at {:.1} characters/second, {} the {:.1} limit for {} text",
                            cps,
                            qualifier,
                            warn_cps,
                            script.as_str()
                        ),
                    )
                    .with_location(clip.place.timeline_in_sec, clip.timeline_end())
                    .with_entities(vec![clip.id.clone()])
                    .with_details(format!(
                        "{:.0} characters in {:.2}s. Script detected as {} (CJK glyphs carry more \
                         meaning per character, so they use a lower budget). Extend the caption or \
                         split the line.",
                        char_count,
                        duration,
                        script.as_str()
                    ))
                    .with_metric("cps", (cps * 100.0).round() / 100.0)
                    .with_metric("charCount", char_count)
                    .with_metric("durationSec", duration)
                    .with_metric("script", script.as_str())
                    .with_metric("warnCps", warn_cps)
                    .with_metric("severeCps", severe_cps),
                );
            }
        }

        Ok(violations)
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

                violations.push(
                    QCViolation::new(
                        self.name(),
                        severity,
                        "Caption is positioned outside the canvas".to_string(),
                    )
                    .with_location(clip.place.timeline_in_sec, clip.timeline_end())
                    .with_entities(vec![clip.id.clone()])
                    .with_details(format!(
                        "Estimated text box spans x {:.1}%-{:.1}%, y {:.1}%-{:.1}%, outside the \
                         0%-100% canvas. Text outside the frame is cropped away.",
                        left, right, top, bottom
                    ))
                    .with_metric("leftPercent", left)
                    .with_metric("rightPercent", right)
                    .with_metric("topPercent", top)
                    .with_metric("bottomPercent", bottom)
                    .with_metric("trackId", track.id.clone()),
                );
            }
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
// Cross-reference: rendered black ranges vs. structural gaps
// =============================================================================

/// Fraction of the program a single black range may cover before the "no gap
/// overlaps this, so it is probably deliberate" reading stops being credible.
///
/// A fade or title card is short by construction. Black over half the running
/// time is a dropped video chain, a wrong pixel format or an export that never
/// received a picture — a broken render, whatever the timeline says.
const BLACK_PROGRAM_FRACTION_ERROR: f64 = 0.5;

/// Re-grades detected black ranges against the structural gaps of a sequence.
///
/// Black pixels alone say nothing about intent: a fade-out or title card is
/// black on purpose, while black over a hole in the timeline is broken output.
/// Only the combination of both passes can tell them apart, so the regrade
/// happens here rather than inside either rule:
///
/// * black overlapping an uncovered gap becomes [`Severity::Error`]
/// * black covering at least [`BLACK_PROGRAM_FRACTION_ERROR`] of the program
///   stays [`Severity::Error`] whether or not a gap explains it — a render that
///   is dark end to end is broken output, and a timeline full of picture makes
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
    let program_duration_sec = sequence.duration();
    let mut regraded = 0;

    for violation in report
        .violations
        .iter_mut()
        .filter(|violation| violation.rule_name == black_rule_name)
    {
        let Some(location) = violation.location.clone() else {
            continue;
        };

        // Recorded on every black finding so the fraction an agent would have
        // to derive by hand is already in the report.
        let program_fraction = if program_duration_sec.is_finite() && program_duration_sec > 0.0 {
            Some(location.duration() / program_duration_sec)
        } else {
            None
        };
        if let Some(fraction) = program_fraction {
            violation.metrics.insert(
                "programFraction".to_string(),
                serde_json::json!((fraction * 1000.0).round() / 1000.0),
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
            // the range is short; black over most of the program means the
            // render is broken, and a timeline that is full of picture makes
            // that worse rather than better.
            let covers_program =
                program_fraction.is_some_and(|fraction| fraction >= BLACK_PROGRAM_FRACTION_ERROR);

            if covers_program {
                violation.severity = Severity::Error;
                violation.details = Some(format!(
                    "Black covers {:.0}% of the {:.2}s program while the timeline has picture \
                     here, so the render itself is broken rather than the edit.",
                    program_fraction.unwrap_or_default() * 100.0,
                    program_duration_sec
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

        assert_eq!(violations.len(), 1);
        assert_eq!(violations[0].severity, Severity::Warning);
        assert_eq!(violations[0].metrics["script"], "latin");
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
        assert_eq!(violations[0].metrics["script"], "cjk");
        assert_eq!(violations[0].metrics["warnCps"], 9.0);
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
                    black_ranges: vec![range],
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
}
