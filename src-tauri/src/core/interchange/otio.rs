//! OpenTimelineIO Export
//!
//! Writes a [`Sequence`] as an [OpenTimelineIO](https://opentimeline.io/) JSON
//! document. OTIO is the Academy Software Foundation's editorial interchange
//! format and DaVinci Resolve imports it natively, including on the free tier —
//! which is the whole point of this exporter: **assemble headless, finish in
//! Resolve**.
//!
//! ## Scope: cut interchange only
//!
//! What survives the round trip:
//!
//! - video and audio tracks,
//! - clips, with their media reference and source in-point,
//! - gaps (synthesised, because an OTIO track is a contiguous child list),
//! - two-input transitions (cross dissolve, wipe, slide),
//! - sequence markers.
//!
//! What does **not** survive, and is reported in
//! [`OtioExport::unsupported`] rather than dropped silently:
//!
//! - effects and colour grading,
//! - transforms, motion keyframes, opacity and blend modes,
//! - caption and overlay tracks, and text clips,
//! - clip audio settings (levels, pan, fades),
//! - speed, reverse, freeze frames and time remapping,
//! - compound clips and adjustment layers.
//!
//! ## Frame math
//!
//! Every boundary is computed in **frames** through [`TimelineClock`] and only
//! converted at the edges. An OTIO track positions its children by accumulating
//! their durations, so a track built from per-clip second values accumulates
//! rounding drift across a long timeline; a track built from frame counts
//! cannot.
//!
//! ## Manual validation
//!
//! CI cannot run DaVinci Resolve. Validating a real round trip is a manual
//! step: export with `openreelio-cli otio export`, then in Resolve use
//! *File → Import → Timeline → Import AAF, EDL, XML…* and pick the `.otio`
//! file. Check that the cut points, track count and media links match, and that
//! any dissolve landed on the boundary the export named.

use std::collections::HashMap;

use serde_json::json;

use crate::core::assets::Asset;
use crate::core::commands::is_text_clip;
use crate::core::effects::Effect;
use crate::core::timeline::{Clip, Marker, Sequence, TimelineClock, Track, TrackKind, Transform};
use crate::core::{Color, Frame};

use super::models::{asset_src_url, InterchangeExportResult, InterchangeFormat};
use super::otio_schema::{
    schema_clip, schema_track, schema_transition, ExternalReference, MissingReference, OtioClip,
    OtioComposable, OtioGap, OtioMarker, OtioMediaRef, OtioStack, OtioTimeline, OtioTrack,
    OtioTrackOrItem, OtioTransition, RationalTime, TimeRange, OPENREELIO_METADATA_KEY,
};

/// Default transition length, in seconds, when an effect carries no `duration`.
const DEFAULT_TRANSITION_SEC: f64 = 1.0;

/// How many item ids an aggregated `unsupported` entry names before it counts
/// the rest. Keeps the report readable on a thousand-clip timeline.
const MAX_NAMED_ITEMS: usize = 5;

// =============================================================================
// Public API
// =============================================================================

/// Result of an OTIO export.
#[derive(Clone, Debug)]
pub struct OtioExport {
    /// The complete OTIO JSON document.
    pub json: String,
    /// Tracks written to the document.
    pub track_count: u32,
    /// Clips written to the document (gaps and transitions excluded).
    pub clip_count: u32,
    /// Structural notes: skipped tracks, missing assets, overlaps, transitions
    /// that could not be placed.
    pub warnings: Vec<String>,
    /// Editorial detail OTIO cannot carry, so the caller can decide whether the
    /// export is good enough to hand to another tool.
    pub unsupported: Vec<String>,
}

/// Exports a sequence to an OpenTimelineIO JSON document.
///
/// # Arguments
/// * `sequence` - The sequence to export
/// * `assets` - Asset map for resolving media references
/// * `effects` - Effect map for resolving the clips' effect ids
///
/// # Errors
/// Returns `Err` only when the document cannot be serialised; a sequence with
/// nothing exportable produces an empty timeline plus warnings, not an error.
pub fn export_otio(
    sequence: &Sequence,
    assets: &HashMap<String, Asset>,
    effects: &HashMap<String, Effect>,
) -> Result<OtioExport, String> {
    let clock = TimelineClock::new(sequence.format.fps.clone());
    let rate = clock.frames_per_second();
    let mut report = LossReport::default();

    let mut children: Vec<OtioTrackOrItem> = Vec::new();
    let mut clip_count: u32 = 0;

    for track in &sequence.tracks {
        match track.kind {
            TrackKind::Video | TrackKind::Audio => {}
            TrackKind::Caption | TrackKind::Overlay => {
                report.unsupported.push(format!(
                    "{} track '{}' was not exported: OTIO has no {} track kind, so its clips \
                     would arrive as untyped video",
                    track_kind_label(&track.kind),
                    track.name,
                    track_kind_label(&track.kind)
                ));
                continue;
            }
        }

        let built = build_track(track, assets, effects, &clock, rate, &mut report);
        clip_count += built.clip_count;
        children.push(OtioTrackOrItem::Track(built.track));
    }

    let track_count = children.len() as u32;
    let markers = build_markers(&sequence.markers, &clock, rate);

    let mut stack = OtioStack::new(sequence.name.clone(), children, markers);
    stack.metadata = json!({
        OPENREELIO_METADATA_KEY: { "sequenceId": sequence.id, "sequenceName": sequence.name }
    });

    let mut timeline = OtioTimeline::new(sequence.name.clone(), rate, stack);
    timeline.metadata = json!({
        OPENREELIO_METADATA_KEY: {
            "sequenceId": sequence.id,
            "sequenceName": sequence.name,
            "fps": { "num": sequence.format.fps.num, "den": sequence.format.fps.den },
        }
    });

    let json = serde_json::to_string_pretty(&timeline)
        .map_err(|error| format!("Failed to serialize OTIO document: {error}"))?;

    let LossReport {
        warnings,
        unsupported,
        aggregates,
    } = report;
    let mut unsupported = unsupported;
    unsupported.extend(aggregates.into_entries());

    Ok(OtioExport {
        json,
        track_count,
        clip_count,
        warnings,
        unsupported,
    })
}

/// Parses an OTIO JSON document.
///
/// Rejects any node whose `OTIO_SCHEMA` this build does not understand, naming
/// the offending schema string: a file from a newer OTIO is a file we cannot
/// read correctly, and reading it approximately would produce a timeline that
/// looks right and is not.
pub fn parse_otio(json: &str) -> Result<OtioTimeline, String> {
    serde_json::from_str(json).map_err(|error| format!("Invalid OTIO document: {error}"))
}

/// Builds an `InterchangeExportResult` from the export output.
///
/// The warnings and unsupported lists travel with the result: interchange is
/// lossy, and a caller that hands the file to Resolve has to be told what will
/// not arrive with it.
pub fn build_export_result(
    output_path: &str,
    export: &OtioExport,
    duration_sec: f64,
) -> InterchangeExportResult {
    InterchangeExportResult {
        output_path: output_path.to_string(),
        format: InterchangeFormat::Otio,
        event_count: export.clip_count,
        track_count: export.track_count,
        duration_sec,
        warnings: export.warnings.clone(),
        unsupported: export.unsupported.clone(),
    }
}

// =============================================================================
// Internal: loss reporting
// =============================================================================

/// Collects everything the export could not represent.
///
/// Losses that change *when* something is seen are reported per clip, because
/// each one needs its own decision. Losses that only change how a clip *looks*
/// are aggregated by category, because a timeline where every clip is graded
/// would otherwise bury the structural warnings under a thousand lines.
#[derive(Default)]
struct LossReport {
    warnings: Vec<String>,
    unsupported: Vec<String>,
    aggregates: Aggregates,
}

#[derive(Default)]
struct Aggregates {
    entries: Vec<(&'static str, &'static str, Vec<String>)>,
}

impl Aggregates {
    fn record(&mut self, category: &'static str, description: &'static str, item: &str) {
        if let Some(existing) = self
            .entries
            .iter_mut()
            .find(|(name, _, _)| *name == category)
        {
            existing.2.push(item.to_string());
            return;
        }
        self.entries
            .push((category, description, vec![item.to_string()]));
    }

    fn into_entries(self) -> Vec<String> {
        self.entries
            .into_iter()
            .map(|(_, description, items)| {
                let named: Vec<&str> = items
                    .iter()
                    .take(MAX_NAMED_ITEMS)
                    .map(String::as_str)
                    .collect();
                let overflow = items.len().saturating_sub(named.len());
                let suffix = if overflow > 0 {
                    format!(" and {overflow} more")
                } else {
                    String::new()
                };
                format!(
                    "{} clip(s) {}: {}{}",
                    items.len(),
                    description,
                    named.join(", "),
                    suffix
                )
            })
            .collect()
    }
}

// =============================================================================
// Internal: track building
// =============================================================================

struct BuiltTrack {
    track: OtioTrack,
    clip_count: u32,
}

/// A transition owed to the clip that sits at `child_index`.
struct PendingTransition {
    child_index: usize,
    outgoing_clip_id: String,
    transition: OtioTransition,
}

fn build_track(
    track: &Track,
    assets: &HashMap<String, Asset>,
    effects: &HashMap<String, Effect>,
    clock: &TimelineClock,
    rate: f64,
    report: &mut LossReport,
) -> BuiltTrack {
    let mut children: Vec<OtioComposable> = Vec::new();
    let mut pending: Vec<PendingTransition> = Vec::new();
    let mut clip_count: u32 = 0;
    let mut cursor: Frame = 0;
    // The frame a skipped clip would have run to. A gap is otherwise only
    // synthesised to reach the *next* exported clip, so a track that ends in one
    // OpenReelio cannot express would silently come out short.
    let mut skipped_end: Frame = 0;

    for clip in sorted_clips(track) {
        if !clip.enabled {
            report.warnings.push(format!(
                "clip '{}' on track '{}' is disabled and was exported as a gap",
                clip.id, track.name
            ));
            skipped_end =
                skipped_end.max(clock.seconds_to_nearest_frame(clip.place.timeline_out_sec()));
            continue;
        }

        if let Some(reason) = unexportable_reason(clip) {
            report.unsupported.push(format!(
                "clip '{}' on track '{}' was exported as a gap: {reason}",
                clip.id, track.name
            ));
            skipped_end =
                skipped_end.max(clock.seconds_to_nearest_frame(clip.place.timeline_out_sec()));
            continue;
        }

        let start = clock.seconds_to_nearest_frame(clip.place.timeline_in_sec);
        let end = clock.seconds_to_nearest_frame(clip.place.timeline_out_sec());

        let (start, duration) = if start < cursor {
            report.warnings.push(format!(
                "clip '{}' on track '{}' overlaps the clip before it; the overlap was trimmed \
                 because an OTIO track cannot hold two items at one time",
                clip.id, track.name
            ));
            (cursor, end - cursor)
        } else {
            (start, end - start)
        };

        if duration <= 0 {
            report.warnings.push(format!(
                "clip '{}' on track '{}' is shorter than one frame and was not exported",
                clip.id, track.name
            ));
            continue;
        }

        if start > cursor {
            children.push(OtioComposable::Gap(OtioGap::of_frames(
                start - cursor,
                rate,
            )));
        }

        record_clip_losses(clip, track, effects, report);

        let otio_clip = build_clip(clip, assets, clock, rate, duration, report);
        if let Some(transition) =
            build_transition(clip, effects, rate, report, &track.name, duration)
        {
            pending.push(PendingTransition {
                child_index: children.len(),
                outgoing_clip_id: clip.id.clone(),
                transition,
            });
        }

        children.push(OtioComposable::Clip(Box::new(otio_clip)));
        clip_count += 1;
        cursor = start + duration;
    }

    // A trailing skipped clip leaves the track shorter than the timeline it came
    // from, and a track's length is part of the cut. The hole is filled in the
    // one place the track's real end is known: after the walk.
    if skipped_end > cursor {
        children.push(OtioComposable::Gap(OtioGap::of_frames(
            skipped_end - cursor,
            rate,
        )));
    }

    // Insert from the back so earlier indices stay valid. A transition is only
    // meaningful between two shots: one hanging off the last clip, or off a clip
    // followed by a gap, blends into nothing.
    for owed in pending.into_iter().rev() {
        match children.get(owed.child_index + 1) {
            // The incoming shot is only known here, which is why the fit test
            // lives here and not where the transition was built: out_offset
            // reaches *into* the next item, so an 8s dissolve in front of a
            // quarter-second shot writes a 96-frame reach into a 6-frame item —
            // an invalid document that no reader can make sense of.
            Some(OtioComposable::Clip(incoming))
                if owed.transition.out_offset.value >= incoming.source_range.duration.value =>
            {
                report.warnings.push(format!(
                    "the transition on clip '{}' (track '{}') was not exported: its {} frames \
                     after the cut do not fit inside the {}-frame incoming shot",
                    owed.outgoing_clip_id,
                    track.name,
                    owed.transition.out_offset.value,
                    incoming.source_range.duration.value
                ));
            }
            Some(OtioComposable::Clip(_)) => {
                children.insert(
                    owed.child_index + 1,
                    OtioComposable::Transition(owed.transition),
                );
            }
            Some(_) => report.warnings.push(format!(
                "the transition on clip '{}' (track '{}') was not exported: the next item on the \
                 track is a gap, and OTIO transitions blend two shots",
                owed.outgoing_clip_id, track.name
            )),
            None => report.warnings.push(format!(
                "the transition on clip '{}' (track '{}') was not exported: it is the last clip \
                 on the track, so there is nothing to blend into",
                owed.outgoing_clip_id, track.name
            )),
        }
    }

    let metadata = json!({
        OPENREELIO_METADATA_KEY: {
            "trackId": track.id,
            "trackKind": track_kind_label(&track.kind),
            "muted": track.muted,
            "locked": track.locked,
            "visible": track.visible,
        }
    });

    if track.muted {
        report.warnings.push(format!(
            "track '{}' is muted; OTIO has no mute flag, so it was exported audible (the original \
             state is under metadata.{OPENREELIO_METADATA_KEY}.muted)",
            track.name
        ));
    }

    BuiltTrack {
        track: OtioTrack {
            otio_schema: schema_track(),
            name: track.name.clone(),
            kind: otio_track_kind(&track.kind).to_string(),
            children,
            markers: Vec::new(),
            metadata,
        },
        clip_count,
    }
}

/// Clips in timeline order, tie-broken by id so the output is deterministic.
fn sorted_clips(track: &Track) -> Vec<&Clip> {
    let mut clips: Vec<&Clip> = track.clips.iter().collect();
    clips.sort_by(|a, b| {
        a.place
            .timeline_in_sec
            .total_cmp(&b.place.timeline_in_sec)
            .then_with(|| a.id.cmp(&b.id))
    });
    clips
}

/// Returns why a clip has no OTIO representation at all, if it has none.
fn unexportable_reason(clip: &Clip) -> Option<&'static str> {
    if clip.is_compound() || clip.asset_id.starts_with(Clip::COMPOUND_ASSET_PREFIX) {
        return Some("it is a compound clip, and OTIO cut interchange has no nested sequence");
    }
    if clip.is_adjustment_layer() || clip.asset_id == Clip::ADJUSTMENT_LAYER_ASSET_ID {
        return Some("it is an adjustment layer, which carries grading rather than media");
    }
    if is_text_clip(clip) {
        return Some("it is a text clip, and OTIO has no text generator in this subset");
    }
    None
}

/// Records the editorial detail this clip carries that OTIO cannot express.
fn record_clip_losses(
    clip: &Clip,
    track: &Track,
    effects: &HashMap<String, Effect>,
    report: &mut LossReport,
) {
    // Timing losses change *when* a viewer sees a frame, so each one is named.
    let mut timing: Vec<&str> = Vec::new();
    if (clip.speed - 1.0).abs() > f32::EPSILON {
        timing.push("a speed change");
    }
    if clip.reverse {
        timing.push("reverse playback");
    }
    if clip.freeze_frame {
        timing.push("a freeze frame");
    }
    if clip.time_remap.is_some() {
        timing.push("a time remap curve");
    }

    if !timing.is_empty() {
        report.unsupported.push(format!(
            "clip '{}' on track '{}' has {} that OTIO cut interchange does not represent; it was \
             exported occupying the same timeline slot from the same source in-point, so it will \
             play at unmodified speed in the importing tool",
            clip.id,
            track.name,
            timing.join(" and ")
        ));
    }

    // Appearance losses are aggregated: a graded timeline would otherwise bury
    // the structural warnings under one line per clip.
    //
    // A two-input transition is not among them: it is exported as an OTIO
    // transition, so counting it here would tell the caller their dissolve was
    // dropped on the one export where it survived. When such a transition cannot
    // be placed after all, [`build_transition`] and the insertion pass say so by
    // name, which is more useful than a count.
    // An id the project cannot resolve counts as dropped: something was on this
    // clip and is not in the file.
    if clip.effects.iter().any(|effect_id| {
        !effects
            .get(effect_id)
            .is_some_and(|effect| effect.enabled && effect.effect_type.is_two_input_transition())
    }) {
        report
            .aggregates
            .record("effects", "carry effects that were dropped", &clip.id);
    }
    if clip.transform != Transform::default() || !clip.motion_keyframes.is_empty() {
        report
            .aggregates
            .record("transform", "carry a transform that was dropped", &clip.id);
    }
    if (clip.opacity - 1.0).abs() > f32::EPSILON {
        report.aggregates.record(
            "opacity",
            "have a non-opaque opacity that was dropped",
            &clip.id,
        );
    }
    if clip.blend_mode != crate::core::timeline::BlendMode::Normal {
        report
            .aggregates
            .record("blendMode", "have a blend mode that was dropped", &clip.id);
    }
    if clip.audio != crate::core::timeline::AudioSettings::default() {
        report.aggregates.record(
            "audio",
            "have level, pan or fade settings that were dropped",
            &clip.id,
        );
    }
}

// =============================================================================
// Internal: clip building
// =============================================================================

/// Builds one OTIO clip.
///
/// `duration_frames` is the clip's span **on the timeline**, and it is also what
/// goes into `source_range.duration`. That is not an approximation: an OTIO
/// clip's extent in its parent track *is* `source_range.duration`, and a speed
/// change is expressed by a separate `LinearTimeWarp` effect that scales the
/// media read without touching that duration. Writing the raw source span
/// instead would make a 2x clip occupy twice its slot and push every later cut
/// out of place — the cut structure is precisely what this format exists to
/// carry, so it is the thing that must stay exact.
fn build_clip(
    clip: &Clip,
    assets: &HashMap<String, Asset>,
    clock: &TimelineClock,
    rate: f64,
    duration_frames: Frame,
    report: &mut LossReport,
) -> OtioClip {
    let source_start = clock.seconds_to_nearest_frame(clip.range.source_in_sec);
    let asset = assets.get(&clip.asset_id);

    let media_reference = match asset {
        Some(asset) => {
            let available_range = asset
                .duration_sec
                .filter(|duration| duration.is_finite() && *duration > 0.0)
                .map(|duration| {
                    TimeRange::from_frames(0, clock.seconds_to_nearest_frame(duration), rate)
                });

            if let Some(available) = available_range.as_ref() {
                let available_frames = available.duration.value as Frame;
                if source_start + duration_frames > available_frames {
                    report.warnings.push(format!(
                        "clip '{}' reads past the end of '{}': the importing tool will show media \
                         offline for the tail",
                        clip.id, asset.name
                    ));
                }
            }

            OtioMediaRef::External(ExternalReference::new(
                asset_src_url(&asset.uri),
                available_range,
            ))
        }
        None => {
            report.warnings.push(format!(
                "clip '{}' references asset '{}', which is not in the project; it was exported \
                 with a MissingReference and will import offline",
                clip.id, clip.asset_id
            ));
            OtioMediaRef::Missing(MissingReference {
                name: Some(clip.asset_id.clone()),
                ..MissingReference::default()
            })
        }
    };

    let mut openreelio = json!({ "clipId": clip.id, "assetId": clip.asset_id });
    if let Some(map) = openreelio.as_object_mut() {
        if (clip.speed - 1.0).abs() > f32::EPSILON {
            map.insert("speed".to_string(), json!(clip.speed));
        }
        if clip.reverse {
            map.insert("reverse".to_string(), json!(true));
        }
        if clip.freeze_frame {
            map.insert("freezeFrame".to_string(), json!(true));
        }
        if clip.time_remap.is_some() {
            map.insert("timeRemap".to_string(), json!(true));
        }
    }

    let name = clip
        .label
        .clone()
        .or_else(|| asset.map(|asset| asset.name.clone()))
        .unwrap_or_else(|| clip.id.clone());

    OtioClip {
        otio_schema: schema_clip(),
        name,
        source_range: TimeRange::from_frames(source_start, duration_frames, rate),
        media_reference,
        markers: Vec::new(),
        metadata: json!({ OPENREELIO_METADATA_KEY: openreelio }),
    }
}

// =============================================================================
// Internal: transitions
// =============================================================================

/// Builds the OTIO transition a clip's effects ask for, if any.
///
/// Only two-input transitions qualify — cross dissolve, wipe and slide. `Fade`
/// and `Zoom` sit in the same effect *category* but are single-input filters
/// that belong to one clip, so exporting them as a transition would invent a
/// blend that does not exist.
fn build_transition(
    clip: &Clip,
    effects: &HashMap<String, Effect>,
    rate: f64,
    report: &mut LossReport,
    track_name: &str,
    clip_duration_frames: Frame,
) -> Option<OtioTransition> {
    let effect = clip
        .effects
        .iter()
        .filter_map(|effect_id| effects.get(effect_id))
        .find(|effect| effect.enabled && effect.effect_type.is_two_input_transition())?;

    let requested_sec = effect
        .get_float("duration")
        .filter(|value| value.is_finite() && *value > 0.0)
        .unwrap_or(DEFAULT_TRANSITION_SEC);

    let frames = (requested_sec * rate).round().max(1.0) as Frame;
    if frames >= clip_duration_frames {
        report.warnings.push(format!(
            "the transition on clip '{}' (track '{track_name}') was not exported: its {frames} \
             frames do not fit inside the {clip_duration_frames}-frame shot",
            clip.id
        ));
        return None;
    }

    // An odd frame count cannot be split evenly; the extra frame goes to the
    // outgoing side, matching how the render engine places the same blend.
    let in_offset = frames / 2;
    let out_offset = frames - in_offset;

    let effect_type = serde_json::to_value(&effect.effect_type)
        .ok()
        .and_then(|value| value.as_str().map(str::to_string))
        .unwrap_or_else(|| "cross_dissolve".to_string());

    let transition_type = if effect_type == "cross_dissolve" {
        "SMPTE_Dissolve"
    } else {
        "Custom"
    };

    if transition_type == "Custom" {
        report.warnings.push(format!(
            "the '{effect_type}' transition on clip '{}' has no standard OTIO type; it was \
             exported as \"Custom\" and will import as a cut in tools that do not read \
             metadata.{OPENREELIO_METADATA_KEY}.transitionType",
            clip.id
        ));
    }

    let mut openreelio = json!({
        "transitionType": effect_type,
        "effectId": effect.id,
        "outgoingClipId": clip.id,
    });
    if let (Some(map), Some(direction)) = (
        openreelio.as_object_mut(),
        effect
            .params
            .get("direction")
            .and_then(|value| value.as_str()),
    ) {
        map.insert("direction".to_string(), json!(direction));
    }

    Some(OtioTransition {
        otio_schema: schema_transition(),
        name: effect_type.clone(),
        transition_type: transition_type.to_string(),
        in_offset: RationalTime::new(in_offset as f64, rate),
        out_offset: RationalTime::new(out_offset as f64, rate),
        metadata: json!({ OPENREELIO_METADATA_KEY: openreelio }),
    })
}

// =============================================================================
// Internal: markers
// =============================================================================

fn build_markers(markers: &[Marker], clock: &TimelineClock, rate: f64) -> Vec<OtioMarker> {
    markers
        .iter()
        .map(|marker| {
            let frame = clock.seconds_to_nearest_frame(marker.time_sec);
            let mut otio = OtioMarker::new(
                marker.label.clone(),
                TimeRange::from_frames(frame, 0, rate),
                nearest_otio_color(&marker.color).to_string(),
            );
            otio.metadata = json!({
                OPENREELIO_METADATA_KEY: {
                    "markerId": marker.id,
                    "markerType": marker.marker_type,
                    "color": { "r": marker.color.r, "g": marker.color.g, "b": marker.color.b },
                }
            });
            otio
        })
        .collect()
}

/// OTIO's marker palette. A marker keeps its exact RGB under
/// `metadata.openreelio.color`; this is only what foreign tools display.
const OTIO_MARKER_COLORS: &[(&str, f32, f32, f32)] = &[
    ("RED", 1.0, 0.0, 0.0),
    ("GREEN", 0.0, 1.0, 0.0),
    ("BLUE", 0.0, 0.0, 1.0),
    ("CYAN", 0.0, 1.0, 1.0),
    ("MAGENTA", 1.0, 0.0, 1.0),
    ("YELLOW", 1.0, 1.0, 0.0),
    ("ORANGE", 1.0, 0.65, 0.0),
    ("PINK", 1.0, 0.75, 0.8),
    ("PURPLE", 0.5, 0.0, 0.5),
    ("BLACK", 0.0, 0.0, 0.0),
    ("WHITE", 1.0, 1.0, 1.0),
];

fn nearest_otio_color(color: &Color) -> &'static str {
    OTIO_MARKER_COLORS
        .iter()
        .min_by(|left, right| {
            let distance = |candidate: &(&str, f32, f32, f32)| {
                (color.r - candidate.1).powi(2)
                    + (color.g - candidate.2).powi(2)
                    + (color.b - candidate.3).powi(2)
            };
            distance(left).total_cmp(&distance(right))
        })
        .map(|candidate| candidate.0)
        .unwrap_or("RED")
}

// =============================================================================
// Internal: track kinds
// =============================================================================

/// The OTIO track kind string for a track that has one.
fn otio_track_kind(kind: &TrackKind) -> &'static str {
    match kind {
        TrackKind::Audio => "Audio",
        _ => "Video",
    }
}

/// The OpenReelio track kind name, as it appears in our own metadata.
fn track_kind_label(kind: &TrackKind) -> &'static str {
    match kind {
        TrackKind::Video => "video",
        TrackKind::Audio => "audio",
        TrackKind::Caption => "caption",
        TrackKind::Overlay => "overlay",
    }
}

/// Reads the OTIO document back into a value tree. Used by tests and by the
/// importer's structural comparisons.
#[cfg(test)]
fn parse_value(json: &str) -> serde_json::Value {
    serde_json::from_str(json).expect("exported OTIO should be valid JSON")
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::assets::{AssetKind, LicenseInfo, ProxyStatus};
    use crate::core::effects::{EffectType, ParamValue};
    use crate::core::timeline::{
        AudioSettings, BlendMode, ClipPlace, ClipRange, SequenceFormat, SlowMotionInterpolation,
    };

    fn make_asset(id: &str, name: &str, uri: &str, duration: Option<f64>) -> Asset {
        Asset {
            id: id.to_string(),
            kind: AssetKind::Video,
            name: name.to_string(),
            uri: uri.to_string(),
            hash: "abc123".to_string(),
            duration_sec: duration,
            file_size: 1024,
            imported_at: "2026-01-01T00:00:00Z".to_string(),
            video: None,
            audio: None,
            license: LicenseInfo::default(),
            tags: vec![],
            thumbnail_url: None,
            proxy_status: ProxyStatus::NotNeeded,
            proxy_url: None,
            bin_id: None,
            relative_path: None,
            workspace_managed: false,
            missing: false,
        }
    }

    fn make_clip(id: &str, asset_id: &str, src_in: f64, tl_in: f64, duration: f64) -> Clip {
        Clip {
            id: id.to_string(),
            asset_id: asset_id.to_string(),
            range: ClipRange::new(src_in, src_in + duration),
            place: ClipPlace::new(tl_in, duration),
            transform: Transform::default(),
            motion_keyframes: Vec::new(),
            opacity: 1.0,
            blend_mode: BlendMode::Normal,
            speed: 1.0,
            reverse: false,
            freeze_frame: false,
            time_remap: None,
            slow_motion_interpolation: SlowMotionInterpolation::Nearest,
            effects: vec![],
            audio: AudioSettings::default(),
            label: None,
            color: None,
            caption_style: None,
            caption_position: None,
            enabled: true,
            link_group_id: None,
            compound_sequence_id: None,
            is_adjustment_layer: false,
            group_id: None,
        }
    }

    fn make_sequence(name: &str) -> Sequence {
        Sequence::new(name, SequenceFormat::new(1920, 1080, 24, 1, 48000))
    }

    fn assets_with(entries: &[(&str, &str, &str, Option<f64>)]) -> HashMap<String, Asset> {
        entries
            .iter()
            .map(|(id, name, uri, duration)| (id.to_string(), make_asset(id, name, uri, *duration)))
            .collect()
    }

    fn children_of(document: &serde_json::Value, track_index: usize) -> Vec<serde_json::Value> {
        document["tracks"]["children"][track_index]["children"]
            .as_array()
            .expect("track children must be an array")
            .clone()
    }

    // =========================================================================
    // Document shape
    // =========================================================================

    #[test]
    fn should_write_the_otio_schema_strings_every_node_needs() {
        // Given: a sequence with a single clip
        let mut sequence = make_sequence("Schema Test");
        let mut track = Track::new_video("V1");
        track.add_clip(make_clip("c1", "a1", 0.0, 0.0, 2.0));
        sequence.add_track(track);
        let assets = assets_with(&[("a1", "a.mp4", "/media/a.mp4", Some(60.0))]);

        // When: exporting to OTIO
        let export = export_otio(&sequence, &assets, &HashMap::new()).expect("export should work");
        let document = parse_value(&export.json);

        // Then: every node carries the schema string a reader keys on
        assert_eq!(document["OTIO_SCHEMA"], "Timeline.1");
        assert_eq!(document["tracks"]["OTIO_SCHEMA"], "Stack.1");
        assert_eq!(document["tracks"]["children"][0]["OTIO_SCHEMA"], "Track.1");
        assert_eq!(children_of(&document, 0)[0]["OTIO_SCHEMA"], "Clip.2");
        assert_eq!(
            document["global_start_time"]["OTIO_SCHEMA"],
            "RationalTime.1"
        );
        assert_eq!(document["global_start_time"]["value"], 0.0);
    }

    #[test]
    fn should_express_every_boundary_in_frames_at_the_sequence_rate() {
        // Given: a clip starting 1.5s into its source, placed at 2s for 3s at 24fps
        let mut sequence = make_sequence("Frame Math");
        let mut track = Track::new_video("V1");
        track.add_clip(make_clip("c1", "a1", 1.5, 2.0, 3.0));
        sequence.add_track(track);
        let assets = assets_with(&[("a1", "a.mp4", "/media/a.mp4", Some(60.0))]);

        // When: exporting
        let export = export_otio(&sequence, &assets, &HashMap::new()).expect("export should work");
        let document = parse_value(&export.json);
        let children = children_of(&document, 0);

        // Then: the leading gap is 48 frames and the clip is 72 frames from frame 36
        assert_eq!(children[0]["OTIO_SCHEMA"], "Gap.1");
        assert_eq!(children[0]["source_range"]["duration"]["value"], 48.0);
        assert_eq!(children[1]["source_range"]["start_time"]["value"], 36.0);
        assert_eq!(children[1]["source_range"]["duration"]["value"], 72.0);
        assert_eq!(children[1]["source_range"]["duration"]["rate"], 24.0);
    }

    #[test]
    fn should_synthesize_a_gap_between_clips_but_never_after_the_last_one() {
        // Given: clips at 0-2s and 5-7s
        let mut sequence = make_sequence("Gap Test");
        let mut track = Track::new_video("V1");
        track.add_clip(make_clip("c1", "a1", 0.0, 0.0, 2.0));
        track.add_clip(make_clip("c2", "a1", 0.0, 5.0, 2.0));
        sequence.add_track(track);
        let assets = assets_with(&[("a1", "a.mp4", "/media/a.mp4", Some(60.0))]);

        // When: exporting
        let export = export_otio(&sequence, &assets, &HashMap::new()).expect("export should work");
        let children = children_of(&parse_value(&export.json), 0);

        // Then: clip, 3s gap, clip — and nothing after
        assert_eq!(children.len(), 3);
        assert_eq!(children[0]["OTIO_SCHEMA"], "Clip.2");
        assert_eq!(children[1]["OTIO_SCHEMA"], "Gap.1");
        assert_eq!(children[1]["source_range"]["duration"]["value"], 72.0);
        assert_eq!(children[2]["OTIO_SCHEMA"], "Clip.2");
        assert_eq!(export.clip_count, 2);
    }

    #[test]
    fn should_not_accumulate_drift_across_many_gapped_clips() {
        // Given: 200 one-third-second clips separated by one-third-second gaps at
        // a rate where neither lands on a clean decimal
        let mut sequence =
            Sequence::new("Drift", SequenceFormat::new(1920, 1080, 30000, 1001, 48000));
        let mut track = Track::new_video("V1");
        let step = 1.0 / 3.0;
        for index in 0..200 {
            track.add_clip(make_clip(
                &format!("c{index:03}"),
                "a1",
                0.0,
                index as f64 * 2.0 * step,
                step,
            ));
        }
        sequence.add_track(track);
        let assets = assets_with(&[("a1", "a.mp4", "/media/a.mp4", Some(600.0))]);

        // When: exporting
        let export = export_otio(&sequence, &assets, &HashMap::new()).expect("export should work");
        let children = children_of(&parse_value(&export.json), 0);
        let clock = TimelineClock::new(crate::core::Ratio::new(30000, 1001));

        // Then: the accumulated child durations still land the last clip exactly
        // where the sequence puts it
        let accumulated: f64 = children
            .iter()
            .take(children.len() - 1)
            .map(|child| {
                child["source_range"]["duration"]["value"]
                    .as_f64()
                    .unwrap_or(0.0)
            })
            .sum();
        let expected = clock.seconds_to_nearest_frame(199.0 * 2.0 * step) as f64;
        assert_eq!(accumulated, expected);
    }

    // =========================================================================
    // Media references
    // =========================================================================

    #[test]
    fn should_reference_media_by_file_url_with_its_available_range() {
        let mut sequence = make_sequence("Media");
        let mut track = Track::new_video("V1");
        track.add_clip(make_clip("c1", "a1", 0.0, 0.0, 2.0));
        sequence.add_track(track);
        let assets = assets_with(&[("a1", "a.mp4", "/media/My Clip.mp4", Some(10.0))]);

        let export = export_otio(&sequence, &assets, &HashMap::new()).expect("export should work");
        let reference = children_of(&parse_value(&export.json), 0)[0]["media_reference"].clone();

        assert_eq!(reference["OTIO_SCHEMA"], "ExternalReference.1");
        assert_eq!(reference["target_url"], "file:///media/My%20Clip.mp4");
        assert_eq!(reference["available_range"]["duration"]["value"], 240.0);
    }

    #[test]
    fn should_omit_available_range_when_the_source_length_is_unknown() {
        let mut sequence = make_sequence("No Duration");
        let mut track = Track::new_video("V1");
        track.add_clip(make_clip("c1", "a1", 0.0, 0.0, 2.0));
        sequence.add_track(track);
        let assets = assets_with(&[("a1", "a.mp4", "/media/a.mp4", None)]);

        let export = export_otio(&sequence, &assets, &HashMap::new()).expect("export should work");
        let reference = children_of(&parse_value(&export.json), 0)[0]["media_reference"].clone();

        assert!(reference.get("available_range").is_none());
    }

    #[test]
    fn should_export_a_missing_asset_as_a_missing_reference_and_warn() {
        let mut sequence = make_sequence("Offline");
        let mut track = Track::new_video("V1");
        track.add_clip(make_clip("c1", "ghost", 0.0, 0.0, 2.0));
        sequence.add_track(track);

        let export =
            export_otio(&sequence, &HashMap::new(), &HashMap::new()).expect("export should work");
        let reference = children_of(&parse_value(&export.json), 0)[0]["media_reference"].clone();

        assert_eq!(reference["OTIO_SCHEMA"], "MissingReference.1");
        assert!(export
            .warnings
            .iter()
            .any(|warning| warning.contains("ghost")));
    }

    // =========================================================================
    // Track kinds
    // =========================================================================

    #[test]
    fn should_export_video_and_audio_tracks_with_their_otio_kind() {
        let mut sequence = make_sequence("AV");
        let mut video = Track::new_video("V1");
        video.add_clip(make_clip("v1", "a1", 0.0, 0.0, 2.0));
        let mut audio = Track::new_audio("A1");
        audio.add_clip(make_clip("s1", "a2", 0.0, 0.0, 2.0));
        sequence.add_track(video);
        sequence.add_track(audio);
        let assets = assets_with(&[
            ("a1", "a.mp4", "/media/a.mp4", Some(60.0)),
            ("a2", "m.wav", "/media/m.wav", Some(60.0)),
        ]);

        let export = export_otio(&sequence, &assets, &HashMap::new()).expect("export should work");
        let document = parse_value(&export.json);

        assert_eq!(export.track_count, 2);
        assert_eq!(document["tracks"]["children"][0]["kind"], "Video");
        assert_eq!(document["tracks"]["children"][1]["kind"], "Audio");
    }

    #[test]
    fn should_skip_caption_and_overlay_tracks_and_say_so() {
        let mut sequence = make_sequence("Captions");
        let mut captions = Track::new_caption("Subtitles");
        captions.add_clip(make_clip("cc1", "a1", 0.0, 0.0, 2.0));
        sequence.add_track(captions);
        sequence.add_track(Track::new("Titles", TrackKind::Overlay));

        let export =
            export_otio(&sequence, &HashMap::new(), &HashMap::new()).expect("export should work");

        assert_eq!(export.track_count, 0);
        assert!(export
            .unsupported
            .iter()
            .any(|entry| entry.contains("caption track 'Subtitles'")));
        assert!(export
            .unsupported
            .iter()
            .any(|entry| entry.contains("overlay track 'Titles'")));
    }

    #[test]
    fn should_export_a_muted_track_and_record_the_mute_in_metadata() {
        let mut sequence = make_sequence("Muted");
        let mut track = Track::new_audio("A1");
        track.muted = true;
        track.add_clip(make_clip("s1", "a1", 0.0, 0.0, 2.0));
        sequence.add_track(track);
        let assets = assets_with(&[("a1", "m.wav", "/media/m.wav", Some(60.0))]);

        let export = export_otio(&sequence, &assets, &HashMap::new()).expect("export should work");
        let document = parse_value(&export.json);

        assert_eq!(
            document["tracks"]["children"][0]["metadata"]["openreelio"]["muted"],
            true
        );
        assert!(export
            .warnings
            .iter()
            .any(|warning| warning.contains("is muted")));
    }

    // =========================================================================
    // Lossiness
    // =========================================================================

    #[test]
    fn should_keep_the_slot_of_a_speed_clip_and_report_the_speed_as_unsupported() {
        // Given: a 2x clip occupying 2s of timeline from 4s of source
        let mut sequence = make_sequence("Speed");
        let mut track = Track::new_video("V1");
        let mut clip = make_clip("c1", "a1", 1.0, 0.0, 2.0);
        clip.range = ClipRange::new(1.0, 5.0);
        clip.speed = 2.0;
        track.add_clip(clip);
        track.add_clip(make_clip("c2", "a1", 0.0, 2.0, 1.0));
        sequence.add_track(track);
        let assets = assets_with(&[("a1", "a.mp4", "/media/a.mp4", Some(60.0))]);

        // When: exporting
        let export = export_otio(&sequence, &assets, &HashMap::new()).expect("export should work");
        let children = children_of(&parse_value(&export.json), 0);

        // Then: the clip occupies its 48-frame timeline slot, the next cut is
        // still at frame 48, and the speed loss is reported by clip id
        assert_eq!(children[0]["source_range"]["duration"]["value"], 48.0);
        assert_eq!(children[1]["OTIO_SCHEMA"], "Clip.2");
        assert!(export
            .unsupported
            .iter()
            .any(|entry| entry.contains("clip 'c1'") && entry.contains("speed change")));
    }

    #[test]
    fn should_report_reverse_freeze_and_time_remap_per_clip() {
        let mut sequence = make_sequence("Timing");
        let mut track = Track::new_video("V1");
        let mut reversed = make_clip("rev", "a1", 0.0, 0.0, 1.0);
        reversed.reverse = true;
        let mut frozen = make_clip("frz", "a1", 0.0, 1.0, 1.0);
        frozen.freeze_frame = true;
        track.add_clip(reversed);
        track.add_clip(frozen);
        sequence.add_track(track);
        let assets = assets_with(&[("a1", "a.mp4", "/media/a.mp4", Some(60.0))]);

        let export = export_otio(&sequence, &assets, &HashMap::new()).expect("export should work");

        assert!(export
            .unsupported
            .iter()
            .any(|entry| entry.contains("clip 'rev'") && entry.contains("reverse playback")));
        assert!(export
            .unsupported
            .iter()
            .any(|entry| entry.contains("clip 'frz'") && entry.contains("freeze frame")));
    }

    #[test]
    fn should_aggregate_appearance_losses_rather_than_one_line_per_clip() {
        let mut sequence = make_sequence("Graded");
        let mut track = Track::new_video("V1");
        for index in 0..20 {
            let mut clip = make_clip(&format!("c{index}"), "a1", 0.0, index as f64, 1.0);
            clip.opacity = 0.5;
            track.add_clip(clip);
        }
        sequence.add_track(track);
        let assets = assets_with(&[("a1", "a.mp4", "/media/a.mp4", Some(60.0))]);

        let export = export_otio(&sequence, &assets, &HashMap::new()).expect("export should work");

        let opacity_entries: Vec<&String> = export
            .unsupported
            .iter()
            .filter(|entry| entry.contains("opacity"))
            .collect();
        assert_eq!(opacity_entries.len(), 1);
        assert!(opacity_entries[0].contains("20 clip(s)"));
        assert!(opacity_entries[0].contains("and 15 more"));
    }

    #[test]
    fn should_export_text_compound_and_adjustment_clips_as_gaps_and_report_them() {
        let mut sequence = make_sequence("Sentinels");
        let mut track = Track::new_video("V1");
        track.add_clip(make_clip("txt", "__text__t1", 0.0, 0.0, 1.0));
        track.add_clip(make_clip("cmp", "__compound__s1", 0.0, 1.0, 1.0));
        let mut adjustment = make_clip("adj", "__adjustment_layer__", 0.0, 2.0, 1.0);
        adjustment.is_adjustment_layer = true;
        track.add_clip(adjustment);
        track.add_clip(make_clip("real", "a1", 0.0, 3.0, 1.0));
        sequence.add_track(track);
        let assets = assets_with(&[("a1", "a.mp4", "/media/a.mp4", Some(60.0))]);

        let export = export_otio(&sequence, &assets, &HashMap::new()).expect("export should work");
        let children = children_of(&parse_value(&export.json), 0);

        // Only the real clip survives, preceded by one 72-frame gap covering the
        // three skipped clips.
        assert_eq!(export.clip_count, 1);
        assert_eq!(children.len(), 2);
        assert_eq!(children[0]["OTIO_SCHEMA"], "Gap.1");
        assert_eq!(children[0]["source_range"]["duration"]["value"], 72.0);
        for id in ["txt", "cmp", "adj"] {
            assert!(
                export
                    .unsupported
                    .iter()
                    .any(|entry| entry.contains(&format!("clip '{id}'"))),
                "expected an unsupported entry for {id}, got {:?}",
                export.unsupported
            );
        }
    }

    #[test]
    fn should_export_a_disabled_clip_as_a_gap_and_warn() {
        let mut sequence = make_sequence("Disabled");
        let mut track = Track::new_video("V1");
        let mut disabled = make_clip("off", "a1", 0.0, 0.0, 1.0);
        disabled.enabled = false;
        track.add_clip(disabled);
        track.add_clip(make_clip("on", "a1", 0.0, 1.0, 1.0));
        sequence.add_track(track);
        let assets = assets_with(&[("a1", "a.mp4", "/media/a.mp4", Some(60.0))]);

        let export = export_otio(&sequence, &assets, &HashMap::new()).expect("export should work");
        let children = children_of(&parse_value(&export.json), 0);

        assert_eq!(export.clip_count, 1);
        assert_eq!(children[0]["OTIO_SCHEMA"], "Gap.1");
        assert!(export
            .warnings
            .iter()
            .any(|warning| warning.contains("clip 'off'") && warning.contains("disabled")));
    }

    // =========================================================================
    // Transitions
    // =========================================================================

    fn dissolve(id: &str, duration_sec: f64) -> Effect {
        let mut effect = Effect::new(EffectType::CrossDissolve);
        effect.id = id.to_string();
        effect.set_param("duration", ParamValue::Float(duration_sec));
        effect
    }

    #[test]
    fn should_place_a_dissolve_between_the_two_shots_it_blends() {
        // Given: two adjacent clips, the first carrying a 1s cross dissolve
        let mut sequence = make_sequence("Dissolve");
        let mut track = Track::new_video("V1");
        let mut first = make_clip("c1", "a1", 2.0, 0.0, 3.0);
        first.effects = vec!["e1".to_string()];
        track.add_clip(first);
        track.add_clip(make_clip("c2", "a1", 10.0, 3.0, 3.0));
        sequence.add_track(track);
        let assets = assets_with(&[("a1", "a.mp4", "/media/a.mp4", Some(60.0))]);
        let effects: HashMap<String, Effect> = [("e1".to_string(), dissolve("e1", 1.0))]
            .into_iter()
            .collect();

        // When: exporting
        let export = export_otio(&sequence, &assets, &effects).expect("export should work");
        let children = children_of(&parse_value(&export.json), 0);

        // Then: clip, transition, clip — split 12/12 frames around the cut
        assert_eq!(children.len(), 3);
        assert_eq!(children[1]["OTIO_SCHEMA"], "Transition.1");
        assert_eq!(children[1]["transition_type"], "SMPTE_Dissolve");
        assert_eq!(children[1]["in_offset"]["value"], 12.0);
        assert_eq!(children[1]["out_offset"]["value"], 12.0);
        assert_eq!(
            children[1]["metadata"]["openreelio"]["transitionType"],
            "cross_dissolve"
        );
    }

    #[test]
    fn should_give_the_extra_frame_of_an_odd_transition_to_the_outgoing_side() {
        let mut sequence = make_sequence("Odd");
        let mut track = Track::new_video("V1");
        let mut first = make_clip("c1", "a1", 2.0, 0.0, 3.0);
        first.effects = vec!["e1".to_string()];
        track.add_clip(first);
        track.add_clip(make_clip("c2", "a1", 10.0, 3.0, 3.0));
        sequence.add_track(track);
        let assets = assets_with(&[("a1", "a.mp4", "/media/a.mp4", Some(60.0))]);
        // 7/24s rounds to 7 frames.
        let effects: HashMap<String, Effect> = [("e1".to_string(), dissolve("e1", 7.0 / 24.0))]
            .into_iter()
            .collect();

        let export = export_otio(&sequence, &assets, &effects).expect("export should work");
        let children = children_of(&parse_value(&export.json), 0);

        assert_eq!(children[1]["in_offset"]["value"], 3.0);
        assert_eq!(children[1]["out_offset"]["value"], 4.0);
    }

    #[test]
    fn should_export_a_wipe_as_custom_and_keep_its_real_type_in_metadata() {
        let mut sequence = make_sequence("Wipe");
        let mut track = Track::new_video("V1");
        let mut first = make_clip("c1", "a1", 2.0, 0.0, 3.0);
        first.effects = vec!["e1".to_string()];
        track.add_clip(first);
        track.add_clip(make_clip("c2", "a1", 10.0, 3.0, 3.0));
        sequence.add_track(track);
        let assets = assets_with(&[("a1", "a.mp4", "/media/a.mp4", Some(60.0))]);
        let mut wipe = Effect::new(EffectType::Wipe);
        wipe.id = "e1".to_string();
        wipe.set_param("duration", ParamValue::Float(1.0));
        let effects: HashMap<String, Effect> = [("e1".to_string(), wipe)].into_iter().collect();

        let export = export_otio(&sequence, &assets, &effects).expect("export should work");
        let children = children_of(&parse_value(&export.json), 0);

        assert_eq!(children[1]["transition_type"], "Custom");
        assert_eq!(
            children[1]["metadata"]["openreelio"]["transitionType"],
            "wipe"
        );
    }

    #[test]
    fn should_not_export_a_transition_longer_than_the_shot_it_blends_into() {
        // Given: an 8s dissolve on a long clip, followed by a quarter-second one.
        // The fit check only ever saw the outgoing clip, because the incoming one
        // is not known until the transition is placed — so out_offset reached 96
        // frames into a 6-frame item, which is not a valid OTIO document and was
        // written without a word.
        let mut sequence = make_sequence("Overrun");
        let mut track = Track::new_video("V1");
        let mut first = make_clip("c1", "a1", 0.0, 0.0, 20.0);
        first.effects = vec!["e1".to_string()];
        track.add_clip(first);
        track.add_clip(make_clip("c2", "a1", 30.0, 20.0, 0.25));
        sequence.add_track(track);
        let assets = assets_with(&[("a1", "a.mp4", "/media/a.mp4", Some(60.0))]);
        let effects: HashMap<String, Effect> = [("e1".to_string(), dissolve("e1", 8.0))]
            .into_iter()
            .collect();

        // When: exporting
        let export = export_otio(&sequence, &assets, &effects).expect("export should work");
        let children = children_of(&parse_value(&export.json), 0);

        // Then: no transition is written, and the drop is reported
        assert!(
            children
                .iter()
                .all(|child| child["OTIO_SCHEMA"] != "Transition.1"),
            "a transition that overruns the incoming shot must not be written: {children:#?}"
        );
        assert!(
            export
                .warnings
                .iter()
                .any(|warning| warning.contains("incoming")),
            "the drop must be reported: {:?}",
            export.warnings
        );
    }

    #[test]
    fn should_keep_a_tracks_length_when_its_last_clip_cannot_be_exported() {
        // Given: a track whose final clip is disabled. The warning said it was
        // exported as a gap, and no gap was written — gaps are only synthesised
        // to reach a *later* clip — so the track silently lost its tail.
        let mut sequence = make_sequence("Trailing");
        let mut track = Track::new_video("V1");
        track.add_clip(make_clip("c1", "a1", 0.0, 0.0, 4.0));
        let mut disabled = make_clip("c2", "a1", 10.0, 4.0, 6.0);
        disabled.enabled = false;
        track.add_clip(disabled);
        sequence.add_track(track);
        let assets = assets_with(&[("a1", "a.mp4", "/media/a.mp4", Some(60.0))]);

        // When: exporting
        let export = export_otio(&sequence, &assets, &HashMap::new()).expect("export should work");
        let children = children_of(&parse_value(&export.json), 0);

        // Then: the track still runs 10s — 96 frames of clip, 144 of gap
        let frames: f64 = children
            .iter()
            .map(|child| {
                child["source_range"]["duration"]["value"]
                    .as_f64()
                    .unwrap_or_default()
            })
            .sum();
        assert_eq!(frames, 240.0, "the track lost its tail: {children:#?}");
        assert_eq!(
            children.last().expect("a trailing gap")["OTIO_SCHEMA"],
            "Gap.1"
        );
    }

    #[test]
    fn should_not_report_an_exported_transition_as_a_dropped_effect() {
        // The dissolve below *is* exported, as the transition between the two
        // shots. Counting it again in the dropped-effects aggregate tells the
        // caller their transition did not survive, which is the opposite of true.
        let mut sequence = make_sequence("Clean");
        let mut track = Track::new_video("V1");
        let mut first = make_clip("c1", "a1", 2.0, 0.0, 3.0);
        first.effects = vec!["e1".to_string()];
        track.add_clip(first);
        track.add_clip(make_clip("c2", "a1", 10.0, 3.0, 3.0));
        sequence.add_track(track);
        let assets = assets_with(&[("a1", "a.mp4", "/media/a.mp4", Some(60.0))]);
        let effects: HashMap<String, Effect> = [("e1".to_string(), dissolve("e1", 1.0))]
            .into_iter()
            .collect();

        let export = export_otio(&sequence, &assets, &effects).expect("export should work");

        assert!(
            !export
                .unsupported
                .iter()
                .any(|entry| entry.contains("effects that were dropped")),
            "a clean dissolve export must not claim an effect was dropped: {:?}",
            export.unsupported
        );
    }

    #[test]
    fn should_still_report_a_real_effect_on_a_clip_that_also_has_a_transition() {
        let mut sequence = make_sequence("Mixed");
        let mut track = Track::new_video("V1");
        let mut first = make_clip("c1", "a1", 2.0, 0.0, 3.0);
        first.effects = vec!["e1".to_string(), "e2".to_string()];
        track.add_clip(first);
        track.add_clip(make_clip("c2", "a1", 10.0, 3.0, 3.0));
        sequence.add_track(track);
        let assets = assets_with(&[("a1", "a.mp4", "/media/a.mp4", Some(60.0))]);
        let mut grade = Effect::new(EffectType::Brightness);
        grade.id = "e2".to_string();
        let effects: HashMap<String, Effect> = [
            ("e1".to_string(), dissolve("e1", 1.0)),
            ("e2".to_string(), grade),
        ]
        .into_iter()
        .collect();

        let export = export_otio(&sequence, &assets, &effects).expect("export should work");

        assert!(
            export
                .unsupported
                .iter()
                .any(|entry| entry.contains("effects that were dropped")),
            "the grade is still lost and must be reported: {:?}",
            export.unsupported
        );
    }

    #[test]
    fn should_not_export_a_transition_that_has_nothing_to_blend_into() {
        let mut sequence = make_sequence("Dangling");
        let mut track = Track::new_video("V1");
        let mut only = make_clip("c1", "a1", 2.0, 0.0, 3.0);
        only.effects = vec!["e1".to_string()];
        track.add_clip(only);
        sequence.add_track(track);
        let assets = assets_with(&[("a1", "a.mp4", "/media/a.mp4", Some(60.0))]);
        let effects: HashMap<String, Effect> = [("e1".to_string(), dissolve("e1", 1.0))]
            .into_iter()
            .collect();

        let export = export_otio(&sequence, &assets, &effects).expect("export should work");
        let children = children_of(&parse_value(&export.json), 0);

        assert_eq!(children.len(), 1);
        assert!(export
            .warnings
            .iter()
            .any(|warning| warning.contains("last clip on the track")));
    }

    #[test]
    fn should_not_treat_a_fade_as_a_transition() {
        let mut sequence = make_sequence("Fade");
        let mut track = Track::new_video("V1");
        let mut first = make_clip("c1", "a1", 2.0, 0.0, 3.0);
        first.effects = vec!["e1".to_string()];
        track.add_clip(first);
        track.add_clip(make_clip("c2", "a1", 10.0, 3.0, 3.0));
        sequence.add_track(track);
        let assets = assets_with(&[("a1", "a.mp4", "/media/a.mp4", Some(60.0))]);
        let mut fade = Effect::new(EffectType::Fade);
        fade.id = "e1".to_string();
        let effects: HashMap<String, Effect> = [("e1".to_string(), fade)].into_iter().collect();

        let export = export_otio(&sequence, &assets, &effects).expect("export should work");
        let children = children_of(&parse_value(&export.json), 0);

        assert!(children
            .iter()
            .all(|child| child["OTIO_SCHEMA"] != "Transition.1"));
    }

    // =========================================================================
    // Markers and metadata
    // =========================================================================

    #[test]
    fn should_export_sequence_markers_on_the_stack() {
        let mut sequence = make_sequence("Markers");
        sequence.add_marker(Marker::new(2.0, "Hook"));

        let export =
            export_otio(&sequence, &HashMap::new(), &HashMap::new()).expect("export should work");
        let document = parse_value(&export.json);
        let marker = document["tracks"]["markers"][0].clone();

        assert_eq!(marker["OTIO_SCHEMA"], "Marker.1");
        assert_eq!(marker["name"], "Hook");
        assert_eq!(marker["marked_range"]["start_time"]["value"], 48.0);
        assert_eq!(marker["marked_range"]["duration"]["value"], 0.0);
        // Our default marker amber (1.0, 0.8, 0.0) is nearer OTIO's ORANGE than
        // its YELLOW; the exact RGB is kept in our own metadata namespace.
        assert_eq!(marker["color"], "ORANGE");
        assert_eq!(marker["metadata"]["openreelio"]["markerType"], "generic");
    }

    #[test]
    fn should_pick_the_nearest_otio_marker_color() {
        assert_eq!(nearest_otio_color(&Color::rgb(1.0, 0.0, 0.0)), "RED");
        assert_eq!(nearest_otio_color(&Color::rgb(0.05, 0.05, 0.95)), "BLUE");
        assert_eq!(nearest_otio_color(&Color::rgb(0.98, 0.98, 0.98)), "WHITE");
    }

    #[test]
    fn should_stash_the_sequence_identity_in_the_openreelio_namespace() {
        let sequence = make_sequence("Identity");
        let export =
            export_otio(&sequence, &HashMap::new(), &HashMap::new()).expect("export should work");
        let document = parse_value(&export.json);
        let meta = document["metadata"]["openreelio"].clone();

        assert_eq!(meta["sequenceId"], sequence.id);
        assert_eq!(meta["sequenceName"], "Identity");
        assert_eq!(meta["fps"]["num"], 24);
        assert_eq!(meta["fps"]["den"], 1);
    }

    #[test]
    fn should_produce_a_document_its_own_parser_accepts() {
        let mut sequence = make_sequence("Round Trip");
        let mut track = Track::new_video("V1");
        track.add_clip(make_clip("c1", "a1", 0.0, 0.0, 2.0));
        track.add_clip(make_clip("c2", "a1", 0.0, 4.0, 2.0));
        sequence.add_track(track);
        sequence.add_marker(Marker::new(1.0, "Beat"));
        let assets = assets_with(&[("a1", "a.mp4", "/media/a.mp4", Some(60.0))]);

        let export = export_otio(&sequence, &assets, &HashMap::new()).expect("export should work");
        let parsed = parse_otio(&export.json).expect("our own output must parse");

        assert_eq!(parsed.name, "Round Trip");
        assert_eq!(parsed.tracks_only().count(), 1);
        assert_eq!(parsed.tracks.markers.len(), 1);
    }

    // =========================================================================
    // Round trip: Sequence -> OTIO -> plan steps
    // =========================================================================

    /// Builds the fixture the round-trip tests share: two tracks, a gap, and a
    /// dissolve on the first cut of the video track.
    fn round_trip_fixture() -> (Sequence, HashMap<String, Asset>, HashMap<String, Effect>) {
        let mut sequence = make_sequence("Round Trip");

        let mut video = Track::new_video("V1");
        let mut first = make_clip("v1", "a1", 2.0, 0.0, 3.0);
        first.effects = vec!["e1".to_string()];
        video.add_clip(first);
        video.add_clip(make_clip("v2", "a1", 10.0, 3.0, 3.0));
        // A 2s hole, then a tail shot.
        video.add_clip(make_clip("v3", "a1", 20.0, 8.0, 2.0));
        sequence.add_track(video);

        let mut audio = Track::new_audio("A1");
        audio.add_clip(make_clip("s1", "a2", 0.0, 0.0, 10.0));
        sequence.add_track(audio);

        sequence.add_marker(Marker::new(4.0, "Beat"));

        let assets = assets_with(&[
            ("a1", "a.mp4", "/media/a.mp4", Some(60.0)),
            ("a2", "m.wav", "/media/m.wav", Some(60.0)),
        ]);
        let effects: HashMap<String, Effect> = [("e1".to_string(), dissolve("e1", 1.0))]
            .into_iter()
            .collect();

        (sequence, assets, effects)
    }

    /// Builds the import plan for a document the round-trip tests just exported.
    ///
    /// The fixtures keep their media under `/media`, so the project root is that
    /// directory: the importer only reads media from inside the project, and a
    /// round trip is exactly the case where it should not have to be told twice.
    fn import_plan(
        timeline: &OtioTimeline,
        sequence_id: &str,
        assets: &HashMap<String, Asset>,
    ) -> crate::core::interchange::otio_import::OtioImportPlan {
        use crate::core::interchange::otio_import::{otio_to_plan_steps, OtioImportContext};

        otio_to_plan_steps(
            timeline,
            &OtioImportContext {
                sequence_id,
                assets,
                project_root: std::path::Path::new("/media"),
                sequence_fps: crate::core::Ratio::new(24, 1),
                allow_external_media: false,
            },
        )
        .expect("plan should build")
    }

    #[test]
    fn should_round_trip_a_two_track_sequence_into_plan_steps_that_rebuild_it() {
        // Given: a two-track sequence with a gap and a dissolve
        let (sequence, assets, effects) = round_trip_fixture();

        // When: exported, parsed back, and turned into an import plan
        let export = export_otio(&sequence, &assets, &effects).expect("export should work");
        let parsed = parse_otio(&export.json).expect("our own output must parse");
        let plan = import_plan(&parsed, "target-seq", &assets);

        // Then: the plan rebuilds the same structure — ids regenerate, so this
        // compares shape and timing rather than identity
        let commands: Vec<&str> = plan
            .steps
            .iter()
            .filter_map(|step| step["commandType"].as_str())
            .collect();
        assert_eq!(
            commands,
            vec![
                "CreateTrack",
                "InsertClip",
                "InsertClip",
                "InsertClip",
                "AddEffect",
                "CreateTrack",
                "InsertClip",
                "AddMarker",
            ]
        );

        // Every clip lands back on the frame it came from.
        let starts: Vec<f64> = plan
            .steps
            .iter()
            .filter(|step| step["commandType"] == "InsertClip")
            .filter_map(|step| step["payload"]["timelineStart"].as_f64())
            .collect();
        assert_eq!(starts, vec![0.0, 3.0, 8.0, 0.0]);

        // Source in-points survive.
        let source_ins: Vec<f64> = plan
            .steps
            .iter()
            .filter(|step| step["commandType"] == "InsertClip")
            .filter_map(|step| step["payload"]["sourceIn"].as_f64())
            .collect();
        assert_eq!(source_ins, vec![2.0, 10.0, 20.0, 0.0]);

        // The dissolve comes back on the outgoing clip at its original length.
        let transition = plan
            .steps
            .iter()
            .find(|step| step["commandType"] == "AddEffect")
            .expect("the dissolve should survive");
        assert_eq!(transition["payload"]["effectType"], "cross_dissolve");
        assert_eq!(transition["payload"]["params"]["duration"], 1.0);

        // Media resolves back to the assets already in the project.
        assert!(plan.asset_imports.is_empty());
        assert_eq!(plan.steps[1]["payload"]["assetId"], "a1");
        assert_eq!(plan.steps[6]["payload"]["assetId"], "a2");

        // The marker survives with its time.
        assert_eq!(plan.steps[7]["payload"]["timeSec"], 4.0);
    }

    #[test]
    fn should_be_structurally_stable_across_a_second_export() {
        // Given: a sequence exported once
        let (sequence, assets, effects) = round_trip_fixture();
        let first = export_otio(&sequence, &assets, &effects).expect("export should work");
        let parsed = parse_otio(&first.json).expect("our own output must parse");

        // When: the parsed document is exported again by re-serialising it
        let second = serde_json::to_string_pretty(&parsed).expect("re-serialize should work");

        // Then: the two documents are byte-identical, so a file that has been
        // through our reader is still the file our writer produced
        assert_eq!(first.json, second);

        // And the plan built from either is the same
        let plan_a = import_plan(&parsed, "seq", &assets);
        let reparsed = parse_otio(&second).expect("second pass must parse");
        let plan_b = import_plan(&reparsed, "seq", &assets);
        assert_eq!(plan_a.steps, plan_b.steps);
    }

    #[test]
    fn should_build_an_export_result_that_carries_the_lossiness_forward() {
        // Given: an export that had to skip a caption track
        let mut sequence = make_sequence("Result");
        let mut captions = Track::new_caption("Subtitles");
        captions.add_clip(make_clip("cc1", "a1", 0.0, 0.0, 2.0));
        sequence.add_track(captions);
        let export =
            export_otio(&sequence, &HashMap::new(), &HashMap::new()).expect("export should work");

        // When: building the IPC result
        let result = build_export_result("/tmp/out.otio", &export, 12.5);

        // Then: the caller is told what did not survive
        assert_eq!(result.format, InterchangeFormat::Otio);
        assert_eq!(result.track_count, 0);
        assert!(result
            .unsupported
            .iter()
            .any(|entry| entry.contains("caption track")));
    }
}
