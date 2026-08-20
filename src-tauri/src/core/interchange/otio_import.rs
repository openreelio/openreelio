//! OpenTimelineIO Import
//!
//! Turns a parsed [`OtioTimeline`] into the plan steps that rebuild it as an
//! OpenReelio sequence. Nothing here mutates state: an OTIO file arrives as a
//! *proposal*, and the caller runs it through the ordinary plan machinery so the
//! whole import is one atomic, undoable, rollback-on-failure unit — the same
//! path every other batch edit takes.
//!
//! `EditPlan` and `PlanStep` live in the CLI crate, which core cannot reference,
//! so the steps come back as plain JSON in exactly the shape `EditPlan.steps`
//! deserializes from. The CLI wraps them and hands them to `apply_edit_plan`.
//!
//! ## What an import can carry
//!
//! Video and audio tracks, clips with their media and source in-point, gaps,
//! two-input transitions and markers. Everything else in an OTIO file — nested
//! stacks, image sequences, effects, non-editorial track kinds — is reported in
//! [`OtioImportPlan::warnings`] or [`OtioImportPlan::unsupported`], and a file
//! that cannot be represented at all is refused by name rather than imported
//! approximately.
//!
//! ## Time
//!
//! Every `RationalTime` in an OTIO file carries its own rate, and a foreign file
//! may mix rates within one timeline. Times are therefore converted through the
//! node's own rate before anything else happens; the sequence frame rate is
//! never assumed.

use std::collections::HashMap;

use serde_json::{json, Value as JsonValue};

use crate::core::ai::MAX_PLAN_STEPS;
use crate::core::assets::Asset;

use super::models::file_url_to_path;
use super::otio_schema::{
    openreelio_meta_str, OtioClip, OtioComposable, OtioMarker, OtioMediaRef, OtioTimeline,
    OtioTrack, OtioTrackOrItem, OtioTransition,
};

/// Extra handle, in frames, a transition is required to have beyond its own
/// length. Mirrors the render engine's slack so a plan this importer accepts
/// does not produce a transition the renderer then refuses.
const HANDLE_SLACK_FRAMES: f64 = 1.0;

/// Effect type used when a `SMPTE_Dissolve` arrives with no OpenReelio metadata.
const DEFAULT_TRANSITION_EFFECT: &str = "cross_dissolve";

// =============================================================================
// Public API
// =============================================================================

/// A media file an imported clip needs that the project does not have yet.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OtioAssetImport {
    /// Display name for the asset (the file's base name).
    pub name: String,
    /// Filesystem path decoded from the clip's `target_url`.
    pub uri: String,
}

/// The plan an OTIO file proposes.
#[derive(Clone, Debug, Default)]
pub struct OtioImportPlan {
    /// `EditPlan.steps`-shaped JSON, in dependency order.
    pub steps: Vec<JsonValue>,
    /// Structural notes: skipped children, unresolved media, transitions whose
    /// handles cannot be verified.
    pub warnings: Vec<String>,
    /// Editorial detail the file carried that OpenReelio does not import.
    pub unsupported: Vec<String>,
    /// Media the plan imports before it can place clips, in step order.
    pub asset_imports: Vec<OtioAssetImport>,
}

/// Converts an OTIO timeline into plan steps that rebuild it in `sequence_id`.
///
/// # Errors
///
/// Refuses, rather than importing something misleading, when:
/// - the file references an image sequence, which has no OpenReelio asset kind;
/// - the plan would exceed [`MAX_PLAN_STEPS`]. The cap is not worked around by
///   chunking: a chunked import is no longer atomic, and a half-applied timeline
///   is worse than one the caller was told to split deliberately.
pub fn otio_to_plan_steps(
    timeline: &OtioTimeline,
    sequence_id: &str,
    assets: &HashMap<String, Asset>,
) -> Result<OtioImportPlan, String> {
    let mut builder = PlanBuilder::new(sequence_id, assets);

    for (index, child) in timeline.tracks.children.iter().enumerate() {
        match child {
            OtioTrackOrItem::Track(track) => builder.add_track(index, track)?,
            OtioTrackOrItem::Stack(stack) => builder.plan.unsupported.push(format!(
                "the nested stack '{}' was not imported: OpenReelio imports a flat cut, not a \
                 nested composition",
                stack.name
            )),
        }
    }

    for (index, marker) in timeline.tracks.markers.iter().enumerate() {
        builder.add_marker(index, marker);
    }

    let plan = builder.finish();

    if plan.steps.len() > MAX_PLAN_STEPS {
        return Err(format!(
            "This OTIO file needs {} plan steps, which exceeds the maximum of {MAX_PLAN_STEPS} a \
             single plan may carry. Splitting it into several plans would give up atomicity — a \
             failure halfway would leave a partly built timeline — so import a shorter timeline, \
             or remove tracks from the file, instead.",
            plan.steps.len()
        ));
    }

    Ok(plan)
}

// =============================================================================
// Internal: plan building
// =============================================================================

/// A clip step already emitted, remembered so a later transition can attach to
/// it and so its handles can be checked.
struct PlacedClip {
    step_id: String,
    asset_id: Option<String>,
    source_in_sec: f64,
    source_out_sec: f64,
}

struct PlanBuilder<'a> {
    sequence_id: &'a str,
    assets: &'a HashMap<String, Asset>,
    plan: OtioImportPlan,
    /// Import steps already emitted, keyed by the media path, so two clips off
    /// the same file import it once.
    imported: HashMap<String, String>,
}

impl<'a> PlanBuilder<'a> {
    fn new(sequence_id: &'a str, assets: &'a HashMap<String, Asset>) -> Self {
        Self {
            sequence_id,
            assets,
            plan: OtioImportPlan::default(),
            imported: HashMap::new(),
        }
    }

    fn finish(self) -> OtioImportPlan {
        self.plan
    }

    fn push_step(&mut self, id: &str, command_type: &str, payload: JsonValue, depends_on: &[&str]) {
        self.plan.steps.push(json!({
            "id": id,
            "commandType": command_type,
            "payload": payload,
            "dependsOn": depends_on,
        }));
    }

    // -------------------------------------------------------------------------
    // Tracks
    // -------------------------------------------------------------------------

    fn add_track(&mut self, index: usize, track: &OtioTrack) -> Result<(), String> {
        let Some(kind) = track_kind(track) else {
            self.plan.warnings.push(format!(
                "track '{}' has kind \"{}\", which OpenReelio does not import; only Video and \
                 Audio tracks are editorial",
                track.name, track.kind
            ));
            return Ok(());
        };

        let track_step = format!("track_{index}");
        self.push_step(
            &track_step,
            "CreateTrack",
            json!({
                "sequenceId": self.sequence_id,
                "kind": kind,
                "name": track_name(track, index),
            }),
            &[],
        );

        let mut cursor_sec = 0.0f64;
        let mut placed: Vec<PlacedClip> = Vec::new();
        let mut pending_transitions: Vec<(usize, &OtioTransition)> = Vec::new();

        for (child_index, child) in track.children.iter().enumerate() {
            match child {
                OtioComposable::Gap(gap) => {
                    // A hole is implicit in our model: nothing is placed, the
                    // cursor simply advances. This is the exact inverse of the
                    // gap synthesis the exporter does.
                    cursor_sec += gap.source_range.duration.to_seconds();
                }
                OtioComposable::Clip(clip) => {
                    let duration_sec = clip.source_range.duration.to_seconds();
                    if let Some(place) =
                        self.add_clip(index, child_index, &track_step, clip, cursor_sec)?
                    {
                        placed.push(place);
                    }
                    cursor_sec += duration_sec;
                }
                OtioComposable::Transition(transition) => {
                    // A transition consumes no time of its own, so it does not
                    // move the cursor. It is resolved after the pass, once the
                    // clip on each side is known.
                    pending_transitions.push((placed.len(), transition));
                }
            }
        }

        for (position, transition) in pending_transitions {
            self.add_transition(
                index,
                &track_step,
                &placed,
                position,
                transition,
                &track.name,
            );
        }

        for marker in &track.markers {
            self.plan.warnings.push(format!(
                "the marker '{}' on track '{}' was imported onto the sequence: OpenReelio holds \
                 markers on the sequence, not per track",
                marker.name, track.name
            ));
        }

        Ok(())
    }

    // -------------------------------------------------------------------------
    // Clips
    // -------------------------------------------------------------------------

    fn add_clip(
        &mut self,
        track_index: usize,
        child_index: usize,
        track_step: &str,
        clip: &OtioClip,
        timeline_start_sec: f64,
    ) -> Result<Option<PlacedClip>, String> {
        let source_in_sec = clip.source_range.start_time.to_seconds();
        let duration_sec = clip.source_range.duration.to_seconds();

        if duration_sec <= 0.0 {
            self.plan.warnings.push(format!(
                "clip '{}' has a duration of {duration_sec}s and was not imported",
                clip.name
            ));
            return Ok(None);
        }

        let resolved = self.resolve_media(clip)?;
        let Some(resolved) = resolved else {
            return Ok(None);
        };

        let step_id = format!("clip_{track_index}_{child_index}");
        let mut depends_on = vec![track_step.to_string()];
        let asset_value = match &resolved {
            ResolvedMedia::Existing(asset_id) => json!(asset_id),
            ResolvedMedia::Imported(import_step) => {
                depends_on.push(import_step.clone());
                step_reference(import_step)
            }
        };
        let depends_refs: Vec<&str> = depends_on.iter().map(String::as_str).collect();

        self.push_step(
            &step_id,
            "InsertClip",
            json!({
                "sequenceId": self.sequence_id,
                "trackId": step_reference(track_step),
                "assetId": asset_value,
                "timelineStart": timeline_start_sec,
                "sourceIn": source_in_sec,
                "sourceOut": source_in_sec + duration_sec,
            }),
            &depends_refs,
        );

        Ok(Some(PlacedClip {
            step_id,
            asset_id: match resolved {
                ResolvedMedia::Existing(asset_id) => Some(asset_id),
                ResolvedMedia::Imported(_) => None,
            },
            source_in_sec,
            source_out_sec: source_in_sec + duration_sec,
        }))
    }

    /// Finds the asset a clip's media reference names, importing it if needed.
    ///
    /// Returns `Ok(None)` when the clip has to be skipped — an offline
    /// reference has no media to place, and inventing one would put a clip on
    /// the timeline that points at nothing.
    fn resolve_media(&mut self, clip: &OtioClip) -> Result<Option<ResolvedMedia>, String> {
        let reference = match &clip.media_reference {
            OtioMediaRef::External(reference) => reference,
            OtioMediaRef::ImageSequence(_) => {
                return Err(format!(
                    "clip '{}' references an image sequence, which OpenReelio has no asset kind \
                     for; convert the sequence to a movie file and export the OTIO again",
                    clip.name
                ))
            }
            OtioMediaRef::Missing(_) => {
                self.plan.warnings.push(format!(
                    "clip '{}' carries a {} and was not imported: there is no media to place",
                    clip.name,
                    clip.media_reference.kind_label()
                ));
                return Ok(None);
            }
        };

        // Our own file names the asset outright, which survives a rename the
        // path-based match would miss.
        if let Some(asset_id) = openreelio_meta_str(&clip.metadata, "assetId") {
            if self.assets.contains_key(asset_id) {
                return Ok(Some(ResolvedMedia::Existing(asset_id.to_string())));
            }
        }

        let Some(path) = file_url_to_path(&reference.target_url) else {
            self.plan.warnings.push(format!(
                "clip '{}' references '{}', which is not a local file URL, and was not imported",
                clip.name, reference.target_url
            ));
            return Ok(None);
        };

        if let Some(asset_id) = self.find_asset_by_path(&path) {
            return Ok(Some(ResolvedMedia::Existing(asset_id)));
        }

        let base_name = base_name(&path);
        if let Some(asset_id) = self.find_asset_by_name(&base_name) {
            self.plan.warnings.push(format!(
                "clip '{}' was matched to asset '{}' by file name because '{}' is not the path \
                 that asset was imported from; check it is the intended media",
                clip.name, asset_id, path
            ));
            return Ok(Some(ResolvedMedia::Existing(asset_id)));
        }

        if let Some(existing_step) = self.imported.get(&path) {
            return Ok(Some(ResolvedMedia::Imported(existing_step.clone())));
        }

        let step_id = format!("import_{}", self.imported.len());
        self.push_step(
            &step_id,
            "ImportAsset",
            json!({ "name": base_name, "uri": path }),
            &[],
        );
        self.imported.insert(path.clone(), step_id.clone());
        self.plan.asset_imports.push(OtioAssetImport {
            name: base_name,
            uri: path,
        });

        Ok(Some(ResolvedMedia::Imported(step_id)))
    }

    fn find_asset_by_path(&self, path: &str) -> Option<String> {
        let wanted = normalize_path(path);
        self.assets
            .values()
            .find(|asset| normalize_path(&asset.uri) == wanted)
            .map(|asset| asset.id.clone())
    }

    fn find_asset_by_name(&self, name: &str) -> Option<String> {
        let wanted = name.to_lowercase();
        self.assets
            .values()
            .find(|asset| asset.name.to_lowercase() == wanted)
            .map(|asset| asset.id.clone())
    }

    // -------------------------------------------------------------------------
    // Transitions
    // -------------------------------------------------------------------------

    /// Attaches a transition to the outgoing clip of the boundary it sits on.
    ///
    /// `position` is the number of clips already placed when the transition was
    /// read, so the outgoing clip is `placed[position - 1]` and the incoming one
    /// is `placed[position]`.
    fn add_transition(
        &mut self,
        track_index: usize,
        track_step: &str,
        placed: &[PlacedClip],
        position: usize,
        transition: &OtioTransition,
        track_name: &str,
    ) {
        let (Some(outgoing), Some(incoming)) = (
            position.checked_sub(1).and_then(|index| placed.get(index)),
            placed.get(position),
        ) else {
            self.plan.warnings.push(format!(
                "a transition on track '{track_name}' was not imported: it does not sit between \
                 two imported clips"
            ));
            return;
        };

        let in_sec = transition.in_offset.to_seconds();
        let out_sec = transition.out_offset.to_seconds();
        let duration_sec = in_sec + out_sec;

        if duration_sec <= 0.0 {
            self.plan.warnings.push(format!(
                "a transition on track '{track_name}' has no length and was not imported"
            ));
            return;
        }

        if (in_sec - out_sec).abs() > f64::EPSILON {
            self.plan.unsupported.push(format!(
                "the transition on track '{track_name}' is asymmetric ({in_sec:.3}s before the \
                 cut, {out_sec:.3}s after); OpenReelio stores a single duration, so it was \
                 imported as {duration_sec:.3}s centred on the cut"
            ));
        }

        let effect_type = self.transition_effect_type(transition, track_name);
        self.check_handles(transition, outgoing, incoming, track_name);

        let step_id = format!("transition_{track_index}_{}", position);
        self.push_step(
            &step_id,
            "AddEffect",
            json!({
                "sequenceId": self.sequence_id,
                "trackId": step_reference(track_step),
                "clipId": step_reference(&outgoing.step_id),
                "effectType": effect_type,
                "params": { "duration": duration_sec },
            }),
            &[&outgoing.step_id, &incoming.step_id],
        );
    }

    fn transition_effect_type(&mut self, transition: &OtioTransition, track_name: &str) -> String {
        if let Some(effect_type) = openreelio_meta_str(&transition.metadata, "transitionType") {
            return effect_type.to_string();
        }

        if transition.transition_type != "SMPTE_Dissolve" {
            self.plan.warnings.push(format!(
                "the \"{}\" transition on track '{track_name}' has no OpenReelio equivalent and \
                 was imported as a cross dissolve",
                transition.transition_type
            ));
        }

        DEFAULT_TRANSITION_EFFECT.to_string()
    }

    /// Warns when a boundary does not have the unused source media a blend
    /// needs on both sides.
    ///
    /// This mirrors the render engine's own handle test, including its one-frame
    /// slack, so an import is told up front what the renderer would later refuse.
    /// It warns rather than fails: the clips are still worth having, and the
    /// render path soft-refuses the blend instead of failing the export.
    fn check_handles(
        &mut self,
        transition: &OtioTransition,
        outgoing: &PlacedClip,
        incoming: &PlacedClip,
        track_name: &str,
    ) {
        let rate = transition.in_offset.rate.max(transition.out_offset.rate);
        let slack_sec = if rate.is_finite() && rate > 0.0 {
            HANDLE_SLACK_FRAMES / rate
        } else {
            0.0
        };

        // OTIO's in_offset reaches back into the outgoing item and out_offset
        // reaches forward into the incoming one.
        let outgoing_needed = transition.in_offset.to_seconds() + slack_sec;
        let incoming_needed = transition.out_offset.to_seconds() + slack_sec;

        match outgoing
            .asset_id
            .as_ref()
            .and_then(|asset_id| self.assets.get(asset_id))
            .and_then(|asset| asset.duration_sec)
            .filter(|duration| duration.is_finite() && *duration > 0.0)
        {
            Some(available) => {
                if outgoing.source_out_sec + outgoing_needed > available {
                    self.plan.warnings.push(format!(
                        "the transition on track '{track_name}' needs {outgoing_needed:.3}s of \
                         unused media after the outgoing clip's out point but only \
                         {:.3}s is available; it will render as a cut",
                        (available - outgoing.source_out_sec).max(0.0)
                    ));
                }
            }
            None => self.plan.warnings.push(format!(
                "the length of the outgoing clip's source on track '{track_name}' is unknown, so \
                 its transition handles cannot be verified; the blend may render as a cut"
            )),
        }

        if incoming.source_in_sec - incoming_needed < 0.0 {
            self.plan.warnings.push(format!(
                "the transition on track '{track_name}' needs {incoming_needed:.3}s of unused \
                 media before the incoming clip's in point but it starts {:.3}s into its source; \
                 it will render as a cut",
                incoming.source_in_sec.max(0.0)
            ));
        }
    }

    // -------------------------------------------------------------------------
    // Markers
    // -------------------------------------------------------------------------

    fn add_marker(&mut self, index: usize, marker: &OtioMarker) {
        let time_sec = marker.marked_range.start_time.to_seconds();
        let mut payload = json!({
            "sequenceId": self.sequence_id,
            "timeSec": time_sec,
            "label": marker.name,
        });

        if let Some(map) = payload.as_object_mut() {
            if let Some(marker_type) = openreelio_meta_str(&marker.metadata, "markerType") {
                map.insert("markerType".to_string(), json!(marker_type));
            }
            if let Some(color) = marker
                .metadata
                .get(super::otio_schema::OPENREELIO_METADATA_KEY)
                .and_then(|meta| meta.get("color"))
            {
                map.insert("color".to_string(), color.clone());
            }
        }

        if marker.marked_range.duration.to_seconds() > 0.0 {
            self.plan.unsupported.push(format!(
                "the marker '{}' spans a range; OpenReelio markers are points, so only its start \
                 was imported",
                marker.name
            ));
        }

        self.push_step(&format!("marker_{index}"), "AddMarker", payload, &[]);
    }
}

/// Where a clip's media came from.
enum ResolvedMedia {
    /// An asset already in the project.
    Existing(String),
    /// An `ImportAsset` step this plan emits; the id is only known at run time.
    Imported(String),
}

// =============================================================================
// Internal: helpers
// =============================================================================

/// Builds a `$fromStep` reference to the first id a step creates.
fn step_reference(step_id: &str) -> JsonValue {
    json!({ "$fromStep": step_id, "$path": "createdIds.0" })
}

/// Maps an OTIO track kind onto ours. `None` for anything non-editorial.
fn track_kind(track: &OtioTrack) -> Option<&'static str> {
    match track.kind.as_str() {
        "Video" => Some("video"),
        "Audio" => Some("audio"),
        _ => None,
    }
}

fn track_name(track: &OtioTrack, index: usize) -> String {
    let trimmed = track.name.trim();
    if trimmed.is_empty() {
        format!("Track {}", index + 1)
    } else {
        trimmed.to_string()
    }
}

/// Normalises a path for comparison: forward slashes, case-folded.
///
/// Case folding is not correct on a case-sensitive filesystem, but a false
/// match here reuses an asset the user already has rather than importing a
/// duplicate, and the alternative — two assets for one file — is the worse
/// failure.
fn normalize_path(path: &str) -> String {
    path.replace('\\', "/").to_lowercase()
}

fn base_name(path: &str) -> String {
    path.replace('\\', "/")
        .rsplit('/')
        .next()
        .filter(|name| !name.is_empty())
        .unwrap_or(path)
        .to_string()
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::assets::{AssetKind, LicenseInfo, ProxyStatus};
    use crate::core::interchange::otio::parse_otio;

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

    fn rational(value: f64, rate: f64) -> JsonValue {
        json!({ "OTIO_SCHEMA": "RationalTime.1", "value": value, "rate": rate })
    }

    fn range(start: f64, duration: f64, rate: f64) -> JsonValue {
        json!({
            "OTIO_SCHEMA": "TimeRange.1",
            "start_time": rational(start, rate),
            "duration": rational(duration, rate),
        })
    }

    fn clip_node(name: &str, start: f64, duration: f64, url: &str) -> JsonValue {
        json!({
            "OTIO_SCHEMA": "Clip.2",
            "name": name,
            "source_range": range(start, duration, 24.0),
            "media_reference": {
                "OTIO_SCHEMA": "ExternalReference.1",
                "target_url": url,
            },
        })
    }

    fn timeline_of(children: JsonValue, markers: JsonValue) -> OtioTimeline {
        let document = json!({
            "OTIO_SCHEMA": "Timeline.1",
            "name": "Imported",
            "tracks": {
                "OTIO_SCHEMA": "Stack.1",
                "name": "Imported",
                "children": children,
                "markers": markers,
            },
        });
        parse_otio(&document.to_string()).expect("fixture should parse")
    }

    fn video_track(children: JsonValue) -> JsonValue {
        json!({
            "OTIO_SCHEMA": "Track.1",
            "name": "V1",
            "kind": "Video",
            "children": children,
        })
    }

    fn assets_with(entries: &[(&str, &str, &str, Option<f64>)]) -> HashMap<String, Asset> {
        entries
            .iter()
            .map(|(id, name, uri, duration)| (id.to_string(), make_asset(id, name, uri, *duration)))
            .collect()
    }

    fn step_types(plan: &OtioImportPlan) -> Vec<String> {
        plan.steps
            .iter()
            .map(|step| step["commandType"].as_str().unwrap_or_default().to_string())
            .collect()
    }

    // =========================================================================
    // Tracks and clips
    // =========================================================================

    #[test]
    fn should_create_one_track_step_per_editorial_track() {
        // Given: a file with a video and an audio track
        let timeline = timeline_of(
            json!([
                video_track(json!([])),
                { "OTIO_SCHEMA": "Track.1", "name": "A1", "kind": "Audio", "children": [] },
            ]),
            json!([]),
        );

        // When: converting to plan steps
        let plan =
            otio_to_plan_steps(&timeline, "seq1", &HashMap::new()).expect("plan should build");

        // Then: two CreateTrack steps carrying our own kind names
        assert_eq!(step_types(&plan), vec!["CreateTrack", "CreateTrack"]);
        assert_eq!(plan.steps[0]["payload"]["kind"], "video");
        assert_eq!(plan.steps[1]["payload"]["kind"], "audio");
        assert_eq!(plan.steps[0]["payload"]["sequenceId"], "seq1");
    }

    #[test]
    fn should_skip_a_track_kind_that_is_not_editorial_and_say_so() {
        let timeline = timeline_of(
            json!([{ "OTIO_SCHEMA": "Track.1", "name": "FX", "kind": "Effect", "children": [] }]),
            json!([]),
        );

        let plan =
            otio_to_plan_steps(&timeline, "seq1", &HashMap::new()).expect("plan should build");

        assert!(plan.steps.is_empty());
        assert!(plan.warnings.iter().any(|w| w.contains("Effect")));
    }

    #[test]
    fn should_place_clips_at_the_accumulated_position_of_their_predecessors() {
        // Given: a 2s clip, a 3s gap, then a 2s clip
        let timeline = timeline_of(
            json!([video_track(json!([
                clip_node("a", 24.0, 48.0, "file:///media/a.mp4"),
                { "OTIO_SCHEMA": "Gap.1", "name": "gap", "source_range": range(0.0, 72.0, 24.0) },
                clip_node("b", 0.0, 48.0, "file:///media/a.mp4"),
            ]))]),
            json!([]),
        );
        let assets = assets_with(&[("a1", "a.mp4", "/media/a.mp4", Some(60.0))]);

        // When: converting
        let plan = otio_to_plan_steps(&timeline, "seq1", &assets).expect("plan should build");

        // Then: the gap emits no step and the second clip starts at 5s
        assert_eq!(
            step_types(&plan),
            vec!["CreateTrack", "InsertClip", "InsertClip"]
        );
        assert_eq!(plan.steps[1]["payload"]["timelineStart"], 0.0);
        assert_eq!(plan.steps[1]["payload"]["sourceIn"], 1.0);
        assert_eq!(plan.steps[1]["payload"]["sourceOut"], 3.0);
        assert_eq!(plan.steps[2]["payload"]["timelineStart"], 5.0);
    }

    #[test]
    fn should_reference_the_track_step_rather_than_a_track_id() {
        let timeline = timeline_of(
            json!([video_track(json!([clip_node(
                "a",
                0.0,
                48.0,
                "file:///media/a.mp4"
            )]))]),
            json!([]),
        );
        let assets = assets_with(&[("a1", "a.mp4", "/media/a.mp4", Some(60.0))]);

        let plan = otio_to_plan_steps(&timeline, "seq1", &assets).expect("plan should build");

        assert_eq!(plan.steps[1]["payload"]["trackId"]["$fromStep"], "track_0");
        assert_eq!(plan.steps[1]["payload"]["trackId"]["$path"], "createdIds.0");
        assert_eq!(plan.steps[1]["dependsOn"][0], "track_0");
    }

    #[test]
    fn should_convert_each_time_using_its_own_rate_not_the_first_one_seen() {
        // Given: a track whose second clip is expressed at 48fps
        let timeline = timeline_of(
            json!([video_track(json!([
                clip_node("a", 0.0, 48.0, "file:///media/a.mp4"),
                {
                    "OTIO_SCHEMA": "Clip.2",
                    "name": "b",
                    "source_range": range(96.0, 96.0, 48.0),
                    "media_reference": {
                        "OTIO_SCHEMA": "ExternalReference.1",
                        "target_url": "file:///media/a.mp4",
                    },
                },
            ]))]),
            json!([]),
        );
        let assets = assets_with(&[("a1", "a.mp4", "/media/a.mp4", Some(60.0))]);

        // When: converting
        let plan = otio_to_plan_steps(&timeline, "seq1", &assets).expect("plan should build");

        // Then: 96 ticks at 48fps is 2s of source, not 4s
        assert_eq!(plan.steps[2]["payload"]["timelineStart"], 2.0);
        assert_eq!(plan.steps[2]["payload"]["sourceIn"], 2.0);
        assert_eq!(plan.steps[2]["payload"]["sourceOut"], 4.0);
    }

    // =========================================================================
    // Media resolution
    // =========================================================================

    #[test]
    fn should_match_an_existing_asset_by_its_path() {
        let timeline = timeline_of(
            json!([video_track(json!([clip_node(
                "a",
                0.0,
                48.0,
                "file:///media/My%20Clip.mp4"
            )]))]),
            json!([]),
        );
        let assets = assets_with(&[("a1", "My Clip.mp4", "/media/My Clip.mp4", Some(60.0))]);

        let plan = otio_to_plan_steps(&timeline, "seq1", &assets).expect("plan should build");

        assert_eq!(plan.steps[1]["payload"]["assetId"], "a1");
        assert!(plan.asset_imports.is_empty());
    }

    #[test]
    fn should_prefer_the_asset_id_our_own_metadata_names() {
        let mut clip = clip_node("a", 0.0, 48.0, "file:///elsewhere/moved.mp4");
        clip["metadata"] = json!({ "openreelio": { "assetId": "a1" } });
        let timeline = timeline_of(json!([video_track(json!([clip]))]), json!([]));
        let assets = assets_with(&[("a1", "a.mp4", "/media/a.mp4", Some(60.0))]);

        let plan = otio_to_plan_steps(&timeline, "seq1", &assets).expect("plan should build");

        assert_eq!(plan.steps[1]["payload"]["assetId"], "a1");
    }

    #[test]
    fn should_import_unknown_media_once_and_reference_the_import_step() {
        let timeline = timeline_of(
            json!([video_track(json!([
                clip_node("a", 0.0, 48.0, "file:///media/new.mp4"),
                clip_node("b", 48.0, 48.0, "file:///media/new.mp4"),
            ]))]),
            json!([]),
        );

        let plan =
            otio_to_plan_steps(&timeline, "seq1", &HashMap::new()).expect("plan should build");

        assert_eq!(
            step_types(&plan),
            vec!["CreateTrack", "ImportAsset", "InsertClip", "InsertClip"]
        );
        assert_eq!(plan.asset_imports.len(), 1);
        assert_eq!(plan.asset_imports[0].name, "new.mp4");
        assert_eq!(plan.steps[2]["payload"]["assetId"]["$fromStep"], "import_0");
        assert_eq!(plan.steps[3]["payload"]["assetId"]["$fromStep"], "import_0");
        assert!(plan.steps[2]["dependsOn"]
            .as_array()
            .expect("dependsOn is an array")
            .iter()
            .any(|dep| dep == "import_0"));
    }

    #[test]
    fn should_skip_a_clip_whose_media_is_missing() {
        let timeline = timeline_of(
            json!([video_track(json!([{
                "OTIO_SCHEMA": "Clip.2",
                "name": "offline",
                "source_range": range(0.0, 48.0, 24.0),
                "media_reference": { "OTIO_SCHEMA": "MissingReference.1" },
            }]))]),
            json!([]),
        );

        let plan =
            otio_to_plan_steps(&timeline, "seq1", &HashMap::new()).expect("plan should build");

        assert_eq!(step_types(&plan), vec!["CreateTrack"]);
        assert!(plan.warnings.iter().any(|w| w.contains("offline")));
    }

    #[test]
    fn should_refuse_an_image_sequence_by_name() {
        let timeline = timeline_of(
            json!([video_track(json!([{
                "OTIO_SCHEMA": "Clip.2",
                "name": "frames",
                "source_range": range(0.0, 48.0, 24.0),
                "media_reference": {
                    "OTIO_SCHEMA": "ImageSequenceReference.1",
                    "target_url_base": "file:///media/seq/",
                },
            }]))]),
            json!([]),
        );

        let error = otio_to_plan_steps(&timeline, "seq1", &HashMap::new())
            .expect_err("an image sequence should be refused");

        assert!(error.contains("image sequence"));
        assert!(error.contains("frames"));
    }

    // =========================================================================
    // Transitions
    // =========================================================================

    fn dissolve_node(in_frames: f64, out_frames: f64, effect_type: Option<&str>) -> JsonValue {
        let mut node = json!({
            "OTIO_SCHEMA": "Transition.1",
            "name": "dissolve",
            "transition_type": "SMPTE_Dissolve",
            "in_offset": rational(in_frames, 24.0),
            "out_offset": rational(out_frames, 24.0),
        });
        if let Some(effect_type) = effect_type {
            node["metadata"] = json!({ "openreelio": { "transitionType": effect_type } });
        }
        node
    }

    #[test]
    fn should_attach_a_transition_to_the_outgoing_clip_with_its_total_duration() {
        // Given: two clips with a 12/12-frame dissolve between them
        let timeline = timeline_of(
            json!([video_track(json!([
                clip_node("a", 48.0, 72.0, "file:///media/a.mp4"),
                dissolve_node(12.0, 12.0, None),
                clip_node("b", 240.0, 72.0, "file:///media/a.mp4"),
            ]))]),
            json!([]),
        );
        let assets = assets_with(&[("a1", "a.mp4", "/media/a.mp4", Some(60.0))]);

        // When: converting
        let plan = otio_to_plan_steps(&timeline, "seq1", &assets).expect("plan should build");

        // Then: an AddEffect on the first clip, 1s long, ordered behind both
        let effect = plan
            .steps
            .iter()
            .find(|step| step["commandType"] == "AddEffect")
            .expect("a transition step should exist");
        assert_eq!(effect["payload"]["clipId"]["$fromStep"], "clip_0_0");
        assert_eq!(effect["payload"]["effectType"], "cross_dissolve");
        assert_eq!(effect["payload"]["params"]["duration"], 1.0);
        let depends: Vec<&str> = effect["dependsOn"]
            .as_array()
            .expect("dependsOn is an array")
            .iter()
            .filter_map(JsonValue::as_str)
            .collect();
        assert!(depends.contains(&"clip_0_0") && depends.contains(&"clip_0_2"));
    }

    #[test]
    fn should_restore_the_real_transition_type_from_our_metadata() {
        let timeline = timeline_of(
            json!([video_track(json!([
                clip_node("a", 48.0, 72.0, "file:///media/a.mp4"),
                dissolve_node(12.0, 12.0, Some("wipe")),
                clip_node("b", 240.0, 72.0, "file:///media/a.mp4"),
            ]))]),
            json!([]),
        );
        let assets = assets_with(&[("a1", "a.mp4", "/media/a.mp4", Some(60.0))]);

        let plan = otio_to_plan_steps(&timeline, "seq1", &assets).expect("plan should build");
        let effect = plan
            .steps
            .iter()
            .find(|step| step["commandType"] == "AddEffect")
            .expect("a transition step should exist");

        assert_eq!(effect["payload"]["effectType"], "wipe");
    }

    #[test]
    fn should_report_an_asymmetric_transition_as_lossy() {
        let timeline = timeline_of(
            json!([video_track(json!([
                clip_node("a", 48.0, 72.0, "file:///media/a.mp4"),
                dissolve_node(6.0, 18.0, None),
                clip_node("b", 240.0, 72.0, "file:///media/a.mp4"),
            ]))]),
            json!([]),
        );
        let assets = assets_with(&[("a1", "a.mp4", "/media/a.mp4", Some(60.0))]);

        let plan = otio_to_plan_steps(&timeline, "seq1", &assets).expect("plan should build");

        assert!(plan
            .unsupported
            .iter()
            .any(|entry| entry.contains("asymmetric")));
    }

    #[test]
    fn should_warn_when_the_incoming_clip_has_no_handle_before_its_in_point() {
        // Given: an incoming clip that starts at the very beginning of its source
        let timeline = timeline_of(
            json!([video_track(json!([
                clip_node("a", 48.0, 72.0, "file:///media/a.mp4"),
                dissolve_node(12.0, 12.0, None),
                clip_node("b", 0.0, 72.0, "file:///media/a.mp4"),
            ]))]),
            json!([]),
        );
        let assets = assets_with(&[("a1", "a.mp4", "/media/a.mp4", Some(60.0))]);

        // When: converting
        let plan = otio_to_plan_steps(&timeline, "seq1", &assets).expect("plan should build");

        // Then: the plan still carries the step, with a warning about the handle
        assert!(plan
            .warnings
            .iter()
            .any(|w| w.contains("before the incoming clip's in point")));
        assert!(plan
            .steps
            .iter()
            .any(|step| step["commandType"] == "AddEffect"));
    }

    #[test]
    fn should_warn_when_the_outgoing_clip_runs_out_of_source() {
        let timeline = timeline_of(
            json!([video_track(json!([
                clip_node("a", 48.0, 72.0, "file:///media/short.mp4"),
                dissolve_node(12.0, 12.0, None),
                clip_node("b", 240.0, 72.0, "file:///media/short.mp4"),
            ]))]),
            json!([]),
        );
        // The outgoing clip ends at 5s in a source that is only 5s long.
        let assets = assets_with(&[("a1", "short.mp4", "/media/short.mp4", Some(5.0))]);

        let plan = otio_to_plan_steps(&timeline, "seq1", &assets).expect("plan should build");

        assert!(plan
            .warnings
            .iter()
            .any(|w| w.contains("after the outgoing clip's out point")));
    }

    #[test]
    fn should_warn_when_source_length_is_unknown_so_handles_cannot_be_verified() {
        let timeline = timeline_of(
            json!([video_track(json!([
                clip_node("a", 48.0, 72.0, "file:///media/a.mp4"),
                dissolve_node(12.0, 12.0, None),
                clip_node("b", 240.0, 72.0, "file:///media/a.mp4"),
            ]))]),
            json!([]),
        );
        let assets = assets_with(&[("a1", "a.mp4", "/media/a.mp4", None)]);

        let plan = otio_to_plan_steps(&timeline, "seq1", &assets).expect("plan should build");

        assert!(plan
            .warnings
            .iter()
            .any(|w| w.contains("cannot be verified")));
    }

    #[test]
    fn should_skip_a_transition_that_does_not_sit_between_two_clips() {
        let timeline = timeline_of(
            json!([video_track(json!([
                clip_node("a", 48.0, 72.0, "file:///media/a.mp4"),
                dissolve_node(12.0, 12.0, None),
            ]))]),
            json!([]),
        );
        let assets = assets_with(&[("a1", "a.mp4", "/media/a.mp4", Some(60.0))]);

        let plan = otio_to_plan_steps(&timeline, "seq1", &assets).expect("plan should build");

        assert!(plan
            .steps
            .iter()
            .all(|step| step["commandType"] != "AddEffect"));
        assert!(plan
            .warnings
            .iter()
            .any(|w| w.contains("does not sit between two imported clips")));
    }

    // =========================================================================
    // Markers, nesting and caps
    // =========================================================================

    #[test]
    fn should_import_stack_markers_as_sequence_markers() {
        let timeline = timeline_of(
            json!([]),
            json!([{
                "OTIO_SCHEMA": "Marker.1",
                "name": "Hook",
                "marked_range": range(48.0, 0.0, 24.0),
                "color": "YELLOW",
                "metadata": { "openreelio": { "markerType": "hook" } },
            }]),
        );

        let plan =
            otio_to_plan_steps(&timeline, "seq1", &HashMap::new()).expect("plan should build");

        assert_eq!(step_types(&plan), vec!["AddMarker"]);
        assert_eq!(plan.steps[0]["payload"]["timeSec"], 2.0);
        assert_eq!(plan.steps[0]["payload"]["label"], "Hook");
        assert_eq!(plan.steps[0]["payload"]["markerType"], "hook");
    }

    #[test]
    fn should_report_a_nested_stack_as_unsupported() {
        let timeline = timeline_of(
            json!([{ "OTIO_SCHEMA": "Stack.1", "name": "Nested", "children": [] }]),
            json!([]),
        );

        let plan =
            otio_to_plan_steps(&timeline, "seq1", &HashMap::new()).expect("plan should build");

        assert!(plan.steps.is_empty());
        assert!(plan
            .unsupported
            .iter()
            .any(|entry| entry.contains("Nested")));
    }

    #[test]
    fn should_refuse_a_file_that_needs_more_steps_than_a_plan_may_carry() {
        // Given: a track with one clip more than the cap allows once the
        // CreateTrack step is counted
        let clips: Vec<JsonValue> = (0..MAX_PLAN_STEPS)
            .map(|index| clip_node(&format!("c{index}"), 0.0, 24.0, "file:///media/a.mp4"))
            .collect();
        let timeline = timeline_of(json!([video_track(json!(clips))]), json!([]));
        let assets = assets_with(&[("a1", "a.mp4", "/media/a.mp4", Some(60000.0))]);

        // When: converting
        let error = otio_to_plan_steps(&timeline, "seq1", &assets)
            .expect_err("an oversized file should be refused");

        // Then: the refusal names the cap rather than chunking the plan
        assert!(error.contains(&MAX_PLAN_STEPS.to_string()));
        assert!(error.contains("atomicity"));
    }

    #[test]
    fn should_decode_a_percent_encoded_windows_path_for_the_import_step() {
        let timeline = timeline_of(
            json!([video_track(json!([clip_node(
                "a",
                0.0,
                48.0,
                "file:///C:/Media/My%20Clip.mp4"
            )]))]),
            json!([]),
        );

        let plan =
            otio_to_plan_steps(&timeline, "seq1", &HashMap::new()).expect("plan should build");

        assert_eq!(plan.asset_imports[0].uri, "C:/Media/My Clip.mp4");
        assert_eq!(plan.asset_imports[0].name, "My Clip.mp4");
    }
}
