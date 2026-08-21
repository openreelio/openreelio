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
//! never assumed for *reading*. It is imposed for *writing*: every timeline
//! position is snapped to the target sequence's frame grid, because a 24fps cut
//! dropped into a 29.97fps sequence otherwise opens sub-frame holes and overlaps
//! that no later edit can see.
//!
//! ## Trust
//!
//! An `.otio` file is untrusted input: it names media paths chosen by whoever
//! wrote it, and `ImportAsset` stats — and for some kinds ffprobes — whatever it
//! is handed. Import therefore only reads media from **inside the project
//! directory** unless the caller explicitly allows otherwise
//! ([`OtioImportContext::allow_external_media`]), which closes both the UNC /
//! SMB reflection vector and the "does this file exist" oracle a foreign file
//! would otherwise get over the whole filesystem.

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};

use serde_json::{json, Value as JsonValue};

use crate::core::ai::MAX_PLAN_STEPS;
use crate::core::assets::Asset;
use crate::core::timeline::TimelineClock;
use crate::core::Ratio;

use super::models::{file_url_to_path, strip_verbatim_prefix};
// `file_url_to_path` turns `file://host/share/x` into `//host/share/x`, and a
// hand-written `.otio` may carry `\\host\share\x`, `/\host\share\x` or the
// percent-encoded `%5C%5Chost`; the shared check recognises all of them.
use super::otio_schema::{
    openreelio_meta_bool, openreelio_meta_f64, openreelio_meta_str, OtioClip, OtioComposable,
    OtioMarker, OtioMediaRef, OtioTimeline, OtioTrack, OtioTrackOrItem, OtioTransition,
    RationalTime,
};
use crate::core::fs::is_network_path;

/// Extra handle, in frames, a transition is required to have beyond its own
/// length. Mirrors the render engine's slack so a plan this importer accepts
/// does not produce a transition the renderer then refuses.
const HANDLE_SLACK_FRAMES: f64 = 1.0;

/// Effect type used when a `SMPTE_Dissolve` arrives with no OpenReelio metadata.
const DEFAULT_TRANSITION_EFFECT: &str = "cross_dissolve";

/// The effect types an OTIO transition may become.
///
/// An OTIO transition is a two-input blend and nothing else. Without this list
/// `metadata.openreelio.transitionType` is an arbitrary-effect injection: a file
/// naming `"brightness"` would have a colour filter added to a clip by a verb
/// documented to carry cuts.
const IMPORTABLE_TRANSITIONS: &[&str] = &["cross_dissolve", "wipe", "slide"];

/// The wipe / slide directions the render engine understands.
const IMPORTABLE_TRANSITION_DIRECTIONS: &[&str] = &["left", "right", "up", "down"];

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

/// The project an OTIO file is being imported into.
///
/// Everything the importer is allowed to know about the target lives here, so
/// the rules that depend on it — which media may be read, which frame grid
/// positions land on — are decided from the project rather than from the file.
pub struct OtioImportContext<'a> {
    /// Sequence the plan builds into.
    pub sequence_id: &'a str,
    /// Assets already in the project, keyed by id.
    pub assets: &'a HashMap<String, Asset>,
    /// The project directory. Media outside it is refused unless
    /// [`Self::allow_external_media`] is set.
    pub project_root: &'a Path,
    /// Frame rate of the target sequence; every timeline position is snapped to
    /// its grid.
    pub sequence_fps: Ratio,
    /// Lets the file name media outside the project directory.
    ///
    /// Off by default. A `.otio` chooses its own media paths, and `ImportAsset`
    /// stats — and for some kinds ffprobes — whatever it is given, so an
    /// unscoped import hands the file's author a filesystem existence oracle and,
    /// on Windows, an outbound SMB connection. Relinking a foreign edit to media
    /// that genuinely lives elsewhere is a real workflow, so it is available; it
    /// is just not the default.
    pub allow_external_media: bool,
}

/// Converts an OTIO timeline into plan steps that rebuild it in the context's
/// sequence.
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
    context: &OtioImportContext<'_>,
) -> Result<OtioImportPlan, String> {
    let mut builder = PlanBuilder::new(context);

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
        builder.add_marker(&format!("marker_{index}"), marker, None);
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
    /// Index of the clip's node among its track's children.
    ///
    /// Not its position among the *placed* clips: a skipped child (offline
    /// media, a refused path, an unreadable time) makes those two disagree, and
    /// a transition resolved against the placed count then silently attaches to
    /// the wrong cut.
    child_index: usize,
    step_id: String,
    asset_id: Option<String>,
    source_in_sec: f64,
    source_out_sec: f64,
}

struct PlanBuilder<'a> {
    context: &'a OtioImportContext<'a>,
    /// Frame grid of the target sequence.
    clock: TimelineClock,
    plan: OtioImportPlan,
    /// Import steps already emitted, keyed by the media path, so two clips off
    /// the same file import it once.
    imported: HashMap<String, String>,
    /// Distinct node rates the file used, so a rate that is not the sequence's
    /// is reported once rather than once per clip.
    foreign_rates: Vec<f64>,
}

impl<'a> PlanBuilder<'a> {
    fn new(context: &'a OtioImportContext<'a>) -> Self {
        Self {
            context,
            clock: TimelineClock::new(context.sequence_fps.clone()),
            plan: OtioImportPlan::default(),
            imported: HashMap::new(),
            foreign_rates: Vec::new(),
        }
    }

    fn finish(mut self) -> OtioImportPlan {
        self.report_rate_mismatch();
        self.plan
    }

    fn sequence_id(&self) -> &str {
        self.context.sequence_id
    }

    fn assets(&self) -> &HashMap<String, Asset> {
        self.context.assets
    }

    /// Converts a time, remembering the rate it was expressed at.
    ///
    /// The rate is only remembered when the conversion succeeds: a node this
    /// build refuses to read is not evidence of what the file's timing is, and
    /// reporting `1e-308 fps` as the timeline's rate would be noise on top of a
    /// refusal the caller already has.
    fn seconds_of(&mut self, time: &RationalTime) -> Option<f64> {
        let seconds = time.to_seconds()?;
        if !self.foreign_rates.contains(&time.rate) {
            self.foreign_rates.push(time.rate);
        }
        Some(seconds)
    }

    /// Reports, once, that the file's timing does not live on the sequence's
    /// frame grid.
    fn report_rate_mismatch(&mut self) {
        let sequence_rate = self.clock.frames_per_second();
        let mut foreign: Vec<String> = self
            .foreign_rates
            .iter()
            .filter(|rate| (**rate - sequence_rate).abs() > 1e-9)
            .map(|rate| format!("{rate}"))
            .collect();
        if foreign.is_empty() {
            return;
        }
        foreign.dedup();
        self.plan.unsupported.push(format!(
            "the file expresses its timing at {} fps and the sequence runs at {sequence_rate} fps; \
             every position was snapped to the sequence's frame grid, so a cut may move by up to \
             half a frame",
            foreign.join(" and ")
        ));
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
        let sequence_id = self.sequence_id().to_string();
        self.push_step(
            &track_step,
            "CreateTrack",
            json!({
                "sequenceId": sequence_id,
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
                    match self.seconds_of(&gap.source_range.duration) {
                        Some(duration_sec) if duration_sec >= 0.0 => cursor_sec += duration_sec,
                        _ => self.plan.warnings.push(format!(
                            "a gap on track '{}' has a length this build cannot read and was \
                             ignored, so everything after it moved earlier",
                            track.name
                        )),
                    }
                }
                OtioComposable::Clip(clip) => {
                    let Some(duration_sec) = self.seconds_of(&clip.source_range.duration) else {
                        self.plan.warnings.push(format!(
                            "clip '{}' has a duration this build cannot read ({:e} at rate {:e}) \
                             and was not imported",
                            clip.name,
                            clip.source_range.duration.value,
                            clip.source_range.duration.rate
                        ));
                        continue;
                    };
                    if duration_sec <= 0.0 {
                        self.plan.warnings.push(format!(
                            "clip '{}' has a duration of {duration_sec}s and was not imported",
                            clip.name
                        ));
                        continue;
                    }

                    if let Some(place) = self.add_clip(
                        index,
                        child_index,
                        &track_step,
                        clip,
                        cursor_sec,
                        duration_sec,
                    )? {
                        placed.push(place);
                    }
                    // The cursor advances whether or not the clip was placed: an
                    // OTIO track's children are contiguous, so a skipped clip
                    // still owns its slot and everything after it keeps its time.
                    cursor_sec += duration_sec;
                }
                OtioComposable::Transition(transition) => {
                    // A transition consumes no time of its own, so it does not
                    // move the cursor. It is resolved after the pass, once the
                    // clip on each side is known.
                    pending_transitions.push((child_index, transition));
                }
            }
        }

        for (child_index, transition) in pending_transitions {
            self.add_transition(
                index,
                &track_step,
                &placed,
                child_index,
                transition,
                &track.name,
            );
        }

        for (marker_index, marker) in track.markers.iter().enumerate() {
            // OpenReelio holds markers on the sequence, so a track marker
            // becomes a sequence marker at the same instant. The step is emitted
            // here rather than merely announced: the previous code claimed the
            // import in a warning and produced no step at all.
            self.add_marker(
                &format!("marker_{index}_{marker_index}"),
                marker,
                Some(track.name.as_str()),
            );
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
        duration_sec: f64,
    ) -> Result<Option<PlacedClip>, String> {
        let Some(source_in_sec) = self.seconds_of(&clip.source_range.start_time) else {
            self.plan.warnings.push(format!(
                "clip '{}' has a source in-point this build cannot read ({:e} at rate {:e}) and \
                 was not imported",
                clip.name, clip.source_range.start_time.value, clip.source_range.start_time.rate
            ));
            return Ok(None);
        };
        if source_in_sec < 0.0 {
            self.plan.warnings.push(format!(
                "clip '{}' reads from {source_in_sec}s of its source, which is before the media \
                 starts, and was not imported",
                clip.name
            ));
            return Ok(None);
        }

        // The file's own grid is not the sequence's. Positions are snapped here,
        // at the edge, rather than during the walk: accumulating snapped values
        // would compound each rounding, while snapping an exactly accumulated
        // cursor rounds once.
        let start_frame = self.clock.seconds_to_nearest_frame(timeline_start_sec);
        let end_frame = self
            .clock
            .seconds_to_nearest_frame(timeline_start_sec + duration_sec);
        let timeline_start = self.clock.frame_to_seconds(start_frame);
        let snapped_duration = self.clock.frame_to_seconds(end_frame) - timeline_start;
        if snapped_duration <= 0.0 {
            self.plan.warnings.push(format!(
                "clip '{}' is shorter than one frame at the sequence's rate and was not imported",
                clip.name
            ));
            return Ok(None);
        }

        let resolved = self.resolve_media(clip)?;
        let Some(resolved) = resolved else {
            return Ok(None);
        };

        self.record_clip_losses(clip);

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
        let source_out_sec = source_in_sec + snapped_duration;
        let sequence_id = self.sequence_id().to_string();

        self.push_step(
            &step_id,
            "InsertClip",
            json!({
                "sequenceId": sequence_id,
                "trackId": step_reference(track_step),
                "assetId": asset_value,
                "timelineStart": timeline_start,
                "sourceIn": source_in_sec,
                "sourceOut": source_out_sec,
            }),
            &depends_refs,
        );

        Ok(Some(PlacedClip {
            child_index,
            step_id,
            asset_id: match resolved {
                ResolvedMedia::Existing(asset_id) => Some(asset_id),
                ResolvedMedia::Imported(_) => None,
            },
            source_in_sec,
            source_out_sec,
        }))
    }

    /// Reports the editorial detail the clip's node carries that the import does
    /// not restore.
    ///
    /// The exporter writes a clip's speed, reverse, freeze and time-remap flags
    /// into `metadata.openreelio` so nothing is lost silently, and the importer
    /// then places the clip at unmodified speed. Naming that here is what makes
    /// the round trip honest: the clip *looks* right on the timeline and plays
    /// at a different speed than it did.
    fn record_clip_losses(&mut self, clip: &OtioClip) {
        let mut lost: Vec<String> = Vec::new();
        if let Some(speed) = openreelio_meta_f64(&clip.metadata, "speed") {
            lost.push(format!("a {speed}x speed change"));
        }
        if openreelio_meta_bool(&clip.metadata, "reverse") == Some(true) {
            lost.push("reverse playback".to_string());
        }
        if openreelio_meta_bool(&clip.metadata, "freezeFrame") == Some(true) {
            lost.push("a freeze frame".to_string());
        }
        if openreelio_meta_bool(&clip.metadata, "timeRemap") == Some(true) {
            lost.push("a time remap curve".to_string());
        }

        if !lost.is_empty() {
            self.plan.unsupported.push(format!(
                "clip '{}' carried {} that OTIO import does not restore; it was placed at \
                 unmodified speed and plays its slot straight through",
                clip.name,
                lost.join(" and ")
            ));
        }

        if !clip.markers.is_empty() {
            self.plan.unsupported.push(format!(
                "clip '{}' carries {} marker(s) that were not imported: OpenReelio holds markers \
                 on the sequence, not on a clip",
                clip.name,
                clip.markers.len()
            ));
        }
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
            if self.assets().contains_key(asset_id) {
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

        // Matching an asset the project already holds reads nothing off the
        // foreign path, so both matches run before the scoping guard: the guard
        // exists to keep `ImportAsset` away from a path the file chose, not to
        // stop a clip from finding media the user imported themselves.
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

        let Some(uri) = self.scoped_import_path(&clip.name, &path) else {
            return Ok(None);
        };

        if let Some(existing_step) = self.imported.get(&uri) {
            return Ok(Some(ResolvedMedia::Imported(existing_step.clone())));
        }

        let step_id = format!("import_{}", self.imported.len());
        self.push_step(
            &step_id,
            "ImportAsset",
            json!({ "name": base_name, "uri": uri }),
            &[],
        );
        self.imported.insert(uri.clone(), step_id.clone());
        self.plan.asset_imports.push(OtioAssetImport {
            name: base_name,
            uri,
        });

        Ok(Some(ResolvedMedia::Imported(step_id)))
    }

    /// Turns a media path the file chose into one this import may actually read,
    /// or `None` — with the reason recorded — when it may not.
    ///
    /// This is the whole of the import's trust boundary, and it is deliberately
    /// one decision rather than a list of banned spellings. A path that does not
    /// match an asset the project already has is about to be handed to
    /// `ImportAsset`, which stats it and may ffprobe it, so the question is not
    /// "is this a UNC path" — `\\host\share`, `/\host\share`, `//host/share` and
    /// `%5C%5Chost` are all the same request — but "is this inside the project".
    /// Answering that refuses the SMB reflection and the filesystem existence
    /// oracle together, and keeps refusing spellings nobody has thought of yet.
    fn scoped_import_path(&mut self, clip_name: &str, path: &str) -> Option<String> {
        // Kept as its own check so a network path is named as one in the report
        // even when external media is allowed: an outbound SMB connection is a
        // different hazard from reading a local file the operator asked for.
        if is_network_path(path) {
            self.plan.warnings.push(format!(
                "clip '{clip_name}' references the network path '{path}', which OpenReelio will \
                 not import from an OTIO file; relink it to local media instead"
            ));
            return None;
        }

        if path.contains("://") {
            self.plan.warnings.push(format!(
                "clip '{clip_name}' references '{path}', which is not a local file, and was not \
                 imported"
            ));
            return None;
        }

        let candidate = if is_absolute_media_path(path) {
            PathBuf::from(path)
        } else {
            // A relative reference is ours: an asset stored inside the project
            // keeps a project-relative URI. It resolves against the project root,
            // which also makes it in-scope by construction — once `..` is out.
            self.context.project_root.join(path)
        };

        if candidate
            .components()
            .any(|component| matches!(component, Component::ParentDir))
        {
            self.plan.warnings.push(format!(
                "clip '{clip_name}' references '{path}', which walks out of the directory it \
                 starts in, and was not imported"
            ));
            return None;
        }

        if !self.context.allow_external_media
            && !is_inside_project(self.context.project_root, &candidate)
        {
            self.plan.warnings.push(format!(
                "clip '{clip_name}' references '{path}', which is outside the project directory, \
                 and was not imported; an OTIO file chooses its own media paths, so import only \
                 reads media from inside the project unless external media is explicitly allowed \
                 (`--allow-external-media`)"
            ));
            return None;
        }

        // The project root arrives canonicalised, which on Windows means
        // `\\?\C:\…`. Left in, joining a relative reference onto it and swapping
        // separators yields `//?/C:/…` — a path that reads as a network
        // authority, that ImportAsset cannot open, and that no longer matches
        // the same file named absolutely.
        Some(strip_verbatim_prefix(&candidate.to_string_lossy()).replace('\\', "/"))
    }

    fn find_asset_by_path(&self, path: &str) -> Option<String> {
        let wanted = normalize_path(path);
        self.assets()
            .values()
            .find(|asset| normalize_path(&asset.uri) == wanted)
            .map(|asset| asset.id.clone())
    }

    fn find_asset_by_name(&self, name: &str) -> Option<String> {
        let wanted = name.to_lowercase();
        self.assets()
            .values()
            .find(|asset| asset.name.to_lowercase() == wanted)
            .map(|asset| asset.id.clone())
    }

    // -------------------------------------------------------------------------
    // Transitions
    // -------------------------------------------------------------------------

    /// Attaches a transition to the outgoing clip of the boundary it sits on.
    ///
    /// `child_index` is the transition's own index among the track's children,
    /// so the boundary it sits on is between the children at `child_index - 1`
    /// and `child_index + 1`. Both of those must have been *placed*: if either
    /// was skipped there is no cut here any more, and attaching the blend to the
    /// nearest surviving clip would move it to a boundary the file never named.
    fn add_transition(
        &mut self,
        track_index: usize,
        track_step: &str,
        placed: &[PlacedClip],
        child_index: usize,
        transition: &OtioTransition,
        track_name: &str,
    ) {
        let (Some(outgoing), Some(incoming)) = (
            child_index
                .checked_sub(1)
                .and_then(|index| placed.iter().find(|clip| clip.child_index == index)),
            placed
                .iter()
                .find(|clip| clip.child_index == child_index + 1),
        ) else {
            self.plan.warnings.push(format!(
                "a transition on track '{track_name}' was not imported: it does not sit between \
                 two imported clips, because it is at the end of the track or because an adjacent \
                 clip was skipped"
            ));
            return;
        };

        let (Some(in_sec), Some(out_sec)) = (
            self.seconds_of(&transition.in_offset),
            self.seconds_of(&transition.out_offset),
        ) else {
            self.plan.warnings.push(format!(
                "a transition on track '{track_name}' has offsets this build cannot read and was \
                 not imported"
            ));
            return;
        };
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

        let Some(effect_type) = self.transition_effect_type(transition, track_name) else {
            return;
        };
        self.check_handles(in_sec, out_sec, outgoing, incoming, track_name);

        let mut params = json!({ "duration": duration_sec });
        if let (Some(map), Some(direction)) = (
            params.as_object_mut(),
            transition_direction(transition, &effect_type),
        ) {
            map.insert("direction".to_string(), json!(direction));
        }

        // Keyed by the transition's own child index, so two transitions on one
        // track cannot collide however many clips between them were skipped.
        let step_id = format!("transition_{track_index}_{child_index}");
        let sequence_id = self.sequence_id().to_string();
        self.push_step(
            &step_id,
            "AddEffect",
            json!({
                "sequenceId": sequence_id,
                "trackId": step_reference(track_step),
                "clipId": step_reference(&outgoing.step_id),
                "effectType": effect_type,
                "params": params,
            }),
            &[&outgoing.step_id, &incoming.step_id],
        );
    }

    /// The OpenReelio effect an OTIO transition becomes, or `None` when it
    /// becomes nothing.
    ///
    /// `metadata.openreelio.transitionType` is read from an untrusted file, so
    /// it is checked against [`IMPORTABLE_TRANSITIONS`] rather than passed
    /// through: unchecked, it lets an `.otio` add any effect in the catalogue —
    /// a colour grade, a blur — through a verb whose contract is that it carries
    /// cuts.
    fn transition_effect_type(
        &mut self,
        transition: &OtioTransition,
        track_name: &str,
    ) -> Option<String> {
        if let Some(effect_type) = openreelio_meta_str(&transition.metadata, "transitionType") {
            if IMPORTABLE_TRANSITIONS.contains(&effect_type) {
                return Some(effect_type.to_string());
            }
            self.plan.warnings.push(format!(
                "a transition on track '{track_name}' names the type \"{effect_type}\", which is \
                 not one of the two-input transitions an OTIO import may place ({}); it was not \
                 imported",
                IMPORTABLE_TRANSITIONS.join(", ")
            ));
            return None;
        }

        if transition.transition_type != "SMPTE_Dissolve" {
            self.plan.warnings.push(format!(
                "the \"{}\" transition on track '{track_name}' has no OpenReelio equivalent and \
                 was imported as a cross dissolve",
                transition.transition_type
            ));
        }

        Some(DEFAULT_TRANSITION_EFFECT.to_string())
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
        in_sec: f64,
        out_sec: f64,
        outgoing: &PlacedClip,
        incoming: &PlacedClip,
        track_name: &str,
    ) {
        let rate = self.clock.frames_per_second();
        let slack_sec = if rate.is_finite() && rate > 0.0 {
            HANDLE_SLACK_FRAMES / rate
        } else {
            0.0
        };

        // OTIO's in_offset reaches back into the outgoing item and out_offset
        // reaches forward into the incoming one.
        let outgoing_needed = in_sec + slack_sec;
        let incoming_needed = out_sec + slack_sec;

        match outgoing
            .asset_id
            .as_ref()
            .and_then(|asset_id| self.assets().get(asset_id))
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

    /// Emits an `AddMarker` step for a marker the file carried.
    ///
    /// `track` names the track the marker sat on, or `None` for one that already
    /// sat on the stack. OpenReelio holds markers on the sequence, so a track's
    /// markers land there too — which is a change worth reporting, and a step
    /// worth emitting: the previous code announced the import in a warning and
    /// emitted nothing, so the marker was reported as carried and was lost.
    fn add_marker(&mut self, step_id: &str, marker: &OtioMarker, track: Option<&str>) {
        let origin = match track {
            Some(name) => format!("track '{name}'"),
            None => "the sequence".to_string(),
        };
        let Some(time_sec) = self.seconds_of(&marker.marked_range.start_time) else {
            self.plan.warnings.push(format!(
                "the marker '{}' on {origin} has a position this build cannot read and was not \
                 imported",
                marker.name
            ));
            return;
        };
        if time_sec < 0.0 {
            self.plan.warnings.push(format!(
                "the marker '{}' on {origin} is at {time_sec}s, before the start of the sequence, \
                 and was not imported",
                marker.name
            ));
            return;
        }

        let sequence_id = self.sequence_id().to_string();
        let mut payload = json!({
            "sequenceId": sequence_id,
            "timeSec": self.clock.snap_seconds_to_frame(time_sec),
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

        if marker.marked_range.duration.to_seconds().unwrap_or(0.0) > 0.0 {
            self.plan.unsupported.push(format!(
                "the marker '{}' spans a range; OpenReelio markers are points, so only its start \
                 was imported",
                marker.name
            ));
        }

        if track.is_some() {
            self.plan.warnings.push(format!(
                "the marker '{}' on {origin} was imported onto the sequence: OpenReelio holds \
                 markers on the sequence, not per track",
                marker.name
            ));
        }

        self.push_step(step_id, "AddMarker", payload, &[]);
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

/// Normalises a path for comparison: no Windows verbatim prefix, forward
/// slashes, case-folded.
///
/// The prefix matters here as much as in the URL: an imported asset's stored
/// URI reads `\\?\C:\…` while the path decoded out of a `target_url` reads
/// `C:\…`, and without stripping it the two never compare equal, so every clip
/// would re-import media the project already has.
///
/// Case folding is not correct on a case-sensitive filesystem, but a false
/// match here reuses an asset the user already has rather than importing a
/// duplicate, and the alternative — two assets for one file — is the worse
/// failure.
fn normalize_path(path: &str) -> String {
    strip_verbatim_prefix(path)
        .replace('\\', "/")
        .to_lowercase()
}

fn base_name(path: &str) -> String {
    path.replace('\\', "/")
        .rsplit('/')
        .next()
        .filter(|name| !name.is_empty())
        .unwrap_or(path)
        .to_string()
}

/// The wipe / slide direction a transition asks for, if it asks for a valid one.
///
/// Only wipes and slides have a direction, and the value comes out of a foreign
/// file, so it is checked against the set the render engine understands: an
/// unrecognised direction would silently render as the default and turn a
/// wipe-right into a wipe-left on the round trip.
fn transition_direction(transition: &OtioTransition, effect_type: &str) -> Option<String> {
    if !matches!(effect_type, "wipe" | "slide") {
        return None;
    }
    let direction = openreelio_meta_str(&transition.metadata, "direction")?;
    IMPORTABLE_TRANSITION_DIRECTIONS
        .contains(&direction)
        .then(|| direction.to_string())
}

/// Whether a decoded media path names an absolute location.
///
/// Deliberately answered from the string rather than `Path::is_absolute`: an
/// `.otio` written on Windows is routinely read on Linux and the reverse, and
/// `Path::is_absolute` answers for the *host*, so `C:/Windows/win.ini` reads as a
/// relative path on Linux and would be joined onto the project root — landing
/// inside the scope it was supposed to be measured against.
fn is_absolute_media_path(path: &str) -> bool {
    let bytes = path.as_bytes();
    matches!(bytes.first(), Some(b'/') | Some(b'\\'))
        || matches!(bytes, [drive, b':', ..] if drive.is_ascii_alphabetic())
}

/// Whether a media path resolves inside the project directory.
///
/// A `..` component is refused outright rather than resolved: the containment
/// test below falls back to a textual comparison for a path that does not exist,
/// and `<project>/../../etc/passwd` passes a textual comparison.
fn is_inside_project(project_root: &Path, candidate: &Path) -> bool {
    if candidate
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return false;
    }
    crate::core::workspace::path_resolver::is_inside_project(project_root, candidate)
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
            quarantined_uri: None,
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

    /// Where every fixture keeps its media, and the project root the fixtures
    /// import into: the importer only reads media from inside the project, so a
    /// test that is not about scoping should satisfy scoping by construction.
    const PROJECT_ROOT: &str = "/media";

    fn plan_for(
        timeline: &OtioTimeline,
        assets: &HashMap<String, Asset>,
    ) -> Result<OtioImportPlan, String> {
        plan_in(timeline, assets, PROJECT_ROOT, false)
    }

    fn plan_in(
        timeline: &OtioTimeline,
        assets: &HashMap<String, Asset>,
        project_root: &str,
        allow_external_media: bool,
    ) -> Result<OtioImportPlan, String> {
        plan_at(
            timeline,
            assets,
            project_root,
            allow_external_media,
            Ratio::new(24, 1),
        )
    }

    fn plan_at(
        timeline: &OtioTimeline,
        assets: &HashMap<String, Asset>,
        project_root: &str,
        allow_external_media: bool,
        sequence_fps: Ratio,
    ) -> Result<OtioImportPlan, String> {
        otio_to_plan_steps(
            timeline,
            &OtioImportContext {
                sequence_id: "seq1",
                assets,
                project_root: Path::new(project_root),
                sequence_fps,
                allow_external_media,
            },
        )
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
        let plan = plan_for(&timeline, &HashMap::new()).expect("plan should build");

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

        let plan = plan_for(&timeline, &HashMap::new()).expect("plan should build");

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
        let plan = plan_for(&timeline, &assets).expect("plan should build");

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

        let plan = plan_for(&timeline, &assets).expect("plan should build");

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
        let plan = plan_for(&timeline, &assets).expect("plan should build");

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

        let plan = plan_for(&timeline, &assets).expect("plan should build");

        assert_eq!(plan.steps[1]["payload"]["assetId"], "a1");
        assert!(plan.asset_imports.is_empty());
    }

    #[test]
    fn should_prefer_the_asset_id_our_own_metadata_names() {
        let mut clip = clip_node("a", 0.0, 48.0, "file:///elsewhere/moved.mp4");
        clip["metadata"] = json!({ "openreelio": { "assetId": "a1" } });
        let timeline = timeline_of(json!([video_track(json!([clip]))]), json!([]));
        let assets = assets_with(&[("a1", "a.mp4", "/media/a.mp4", Some(60.0))]);

        let plan = plan_for(&timeline, &assets).expect("plan should build");

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

        let plan = plan_for(&timeline, &HashMap::new()).expect("plan should build");

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
    fn should_refuse_to_import_a_network_path_from_an_otio_file() {
        // file://host/share/x -> //host/share/x, the SMB/NTLM-leak vector.
        let timeline = timeline_of(
            json!([video_track(json!([clip_node(
                "a",
                0.0,
                48.0,
                "file://attacker.example.com/share/clip.mp4"
            )]))]),
            json!([]),
        );

        let plan = plan_for(&timeline, &HashMap::new()).expect("plan should build");

        // No ImportAsset step and no InsertClip for the offending clip.
        assert_eq!(step_types(&plan), vec!["CreateTrack"]);
        assert!(plan.asset_imports.is_empty());
        assert!(
            plan.warnings.iter().any(|w| w.contains("network path")),
            "a network reference must warn: {:?}",
            plan.warnings
        );
    }

    #[test]
    fn should_classify_unc_and_local_paths() {
        assert!(is_network_path("//host/share/x.mp4"));
        assert!(is_network_path("\\\\host\\share\\x.mp4"));
        assert!(!is_network_path("/media/x.mp4"));
        assert!(!is_network_path("C:/media/x.mp4"));
        assert!(!is_network_path("C:\\media\\x.mp4"));
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

        let plan = plan_for(&timeline, &HashMap::new()).expect("plan should build");

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

        let error =
            plan_for(&timeline, &HashMap::new()).expect_err("an image sequence should be refused");

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
        let plan = plan_for(&timeline, &assets).expect("plan should build");

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

        let plan = plan_for(&timeline, &assets).expect("plan should build");
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

        let plan = plan_for(&timeline, &assets).expect("plan should build");

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
        let plan = plan_for(&timeline, &assets).expect("plan should build");

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

        let plan = plan_for(&timeline, &assets).expect("plan should build");

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

        let plan = plan_for(&timeline, &assets).expect("plan should build");

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

        let plan = plan_for(&timeline, &assets).expect("plan should build");

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

        let plan = plan_for(&timeline, &HashMap::new()).expect("plan should build");

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

        let plan = plan_for(&timeline, &HashMap::new()).expect("plan should build");

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
        let error = plan_for(&timeline, &assets).expect_err("an oversized file should be refused");

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
            plan_in(&timeline, &HashMap::new(), "C:/Media", false).expect("plan should build");

        assert_eq!(plan.asset_imports[0].uri, "C:/Media/My Clip.mp4");
        assert_eq!(plan.asset_imports[0].name, "My Clip.mp4");
    }

    // =========================================================================
    // Media scoping
    // =========================================================================

    /// Builds a one-clip timeline pointing at `url`.
    fn timeline_referencing(url: &str) -> OtioTimeline {
        timeline_of(
            json!([video_track(json!([clip_node("a", 0.0, 48.0, url)]))]),
            json!([]),
        )
    }

    #[test]
    fn should_refuse_every_spelling_of_a_network_path() {
        // Windows resolves all of these as the same SMB share. A literal
        // `//`-or-`\\` prefix test only catches the last two, so a file that
        // spells the share `/\host\share` — or percent-encodes the separators —
        // walks straight past it into ImportAsset and an outbound NTLM handshake.
        for url in [
            "file:///\\\\host/share/clip.mp4",
            "file:////host/share/clip.mp4",
            "file:///%5Chost/share/clip.mp4",
            "file:///%5C%5Chost/share/clip.mp4",
            "file:///%5C/host/share/clip.mp4",
            "file://host/share/clip.mp4",
        ] {
            let plan =
                plan_for(&timeline_referencing(url), &HashMap::new()).expect("plan should build");

            assert_eq!(
                step_types(&plan),
                vec!["CreateTrack"],
                "'{url}' must not reach ImportAsset"
            );
            assert!(plan.asset_imports.is_empty(), "'{url}' imported media");
            assert!(
                plan.warnings
                    .iter()
                    .any(|warning| warning.contains("network path")
                        || warning.contains("outside the project directory")),
                "'{url}' must be refused by name: {:?}",
                plan.warnings
            );
        }
    }

    #[test]
    fn should_refuse_a_local_path_outside_the_project_even_when_it_is_not_a_share() {
        // An absolute local path is a filesystem existence oracle: ImportAsset
        // stats it, and for some kinds ffprobes it, so a hostile file learns
        // what is on the machine one clip at a time.
        for url in [
            "file:///C:/Windows/win.ini",
            "file:///etc/passwd",
            "file:///C%3A/Windows/win.ini",
        ] {
            let plan = plan_in(
                &timeline_referencing(url),
                &HashMap::new(),
                "/project",
                false,
            )
            .expect("plan should build");

            assert_eq!(
                step_types(&plan),
                vec!["CreateTrack"],
                "'{url}' must not reach ImportAsset"
            );
            assert!(
                plan.warnings
                    .iter()
                    .any(|warning| warning.contains("outside the project directory")),
                "'{url}' must be refused by name: {:?}",
                plan.warnings
            );
        }
    }

    #[test]
    fn should_refuse_a_relative_path_that_climbs_out_of_the_project() {
        let plan = plan_in(
            &timeline_referencing("../../secrets/passwords.mp4"),
            &HashMap::new(),
            "/project",
            false,
        )
        .expect("plan should build");

        assert_eq!(step_types(&plan), vec!["CreateTrack"]);
        assert!(plan
            .warnings
            .iter()
            .any(|warning| warning.contains("walks out of the directory")));
    }

    #[test]
    fn should_import_media_that_lives_inside_the_project() {
        let plan = plan_in(
            &timeline_referencing("file:///project/footage/a.mp4"),
            &HashMap::new(),
            "/project",
            false,
        )
        .expect("plan should build");

        assert_eq!(
            step_types(&plan),
            vec!["CreateTrack", "ImportAsset", "InsertClip"]
        );
        assert_eq!(plan.asset_imports[0].uri, "/project/footage/a.mp4");
    }

    #[test]
    fn should_resolve_a_project_relative_reference_against_the_project_root() {
        // Our own export writes a relative reference for media stored inside the
        // project, so this is the round trip, not an exotic input.
        let plan = plan_in(
            &timeline_referencing("footage/a.mp4"),
            &HashMap::new(),
            "/project",
            false,
        )
        .expect("plan should build");

        assert_eq!(plan.asset_imports[0].uri, "/project/footage/a.mp4");
    }

    #[test]
    fn should_import_media_outside_the_project_only_when_it_is_allowed() {
        let timeline = timeline_referencing("file:///elsewhere/a.mp4");

        let refused =
            plan_in(&timeline, &HashMap::new(), "/project", false).expect("plan should build");
        assert!(refused.asset_imports.is_empty());

        let allowed =
            plan_in(&timeline, &HashMap::new(), "/project", true).expect("plan should build");
        assert_eq!(allowed.asset_imports[0].uri, "/elsewhere/a.mp4");
    }

    #[test]
    fn should_still_match_an_existing_asset_that_lives_outside_the_project() {
        // Scoping guards ImportAsset, not the timeline: media the user already
        // imported themselves is media the project already trusts.
        let assets = assets_with(&[("a1", "a.mp4", "/elsewhere/a.mp4", Some(60.0))]);
        let plan = plan_in(
            &timeline_referencing("file:///elsewhere/a.mp4"),
            &assets,
            "/project",
            false,
        )
        .expect("plan should build");

        assert_eq!(plan.steps[1]["payload"]["assetId"], "a1");
        assert!(plan.asset_imports.is_empty());
    }

    #[test]
    fn should_classify_every_separator_spelling_of_a_network_path() {
        for path in [
            "//host/share/x.mp4",
            "\\\\host\\share\\x.mp4",
            "/\\host\\share\\x.mp4",
            "\\/host/share/x.mp4",
            r"\\?\UNC\host\share\x.mp4",
        ] {
            assert!(is_network_path(path), "'{path}' is a share");
        }
        for path in [
            "/media/x.mp4",
            "C:/media/x.mp4",
            "C:\\media\\x.mp4",
            r"\\?\C:\media\x.mp4",
            "media/x.mp4",
        ] {
            assert!(!is_network_path(path), "'{path}' is local");
        }
    }

    // =========================================================================
    // Invalid times
    // =========================================================================

    #[test]
    fn should_skip_a_clip_whose_duration_overflows_to_infinity() {
        // 1e308 / 1e-308 is finite over finite and still overflows. Coerced, it
        // serialises into the step as JSON null and the `<= 0` guard waves it
        // through, so the plan carries a clip with no in or out point at all.
        let timeline = timeline_of(
            json!([video_track(json!([{
                "OTIO_SCHEMA": "Clip.2",
                "name": "overflow",
                "source_range": {
                    "OTIO_SCHEMA": "TimeRange.1",
                    "start_time": rational(0.0, 24.0),
                    "duration": rational(1e308, 1e-308),
                },
                "media_reference": {
                    "OTIO_SCHEMA": "ExternalReference.1",
                    "target_url": "file:///media/a.mp4",
                },
            }]))]),
            json!([]),
        );
        let assets = assets_with(&[("a1", "a.mp4", "/media/a.mp4", Some(60.0))]);

        let plan = plan_for(&timeline, &assets).expect("plan should build");

        assert_eq!(step_types(&plan), vec!["CreateTrack"]);
        assert!(plan
            .warnings
            .iter()
            .any(|warning| warning.contains("cannot read")));
        assert_no_null_or_infinite_times(&plan);
    }

    #[test]
    fn should_skip_a_clip_whose_source_in_point_is_before_the_media_starts() {
        let timeline = timeline_of(
            json!([video_track(json!([clip_node(
                "backwards",
                -48.0,
                48.0,
                "file:///media/a.mp4"
            )]))]),
            json!([]),
        );
        let assets = assets_with(&[("a1", "a.mp4", "/media/a.mp4", Some(60.0))]);

        let plan = plan_for(&timeline, &assets).expect("plan should build");

        assert_eq!(step_types(&plan), vec!["CreateTrack"]);
        assert!(plan
            .warnings
            .iter()
            .any(|warning| warning.contains("before the media starts")));
    }

    #[test]
    fn should_skip_a_clip_whose_duration_is_negative() {
        let timeline = timeline_of(
            json!([video_track(json!([clip_node(
                "negative",
                0.0,
                -48.0,
                "file:///media/a.mp4"
            )]))]),
            json!([]),
        );
        let assets = assets_with(&[("a1", "a.mp4", "/media/a.mp4", Some(60.0))]);

        let plan = plan_for(&timeline, &assets).expect("plan should build");

        assert_eq!(step_types(&plan), vec!["CreateTrack"]);
        assert!(plan
            .warnings
            .iter()
            .any(|warning| warning.contains("was not imported")));
    }

    #[test]
    fn should_skip_a_marker_before_the_start_of_the_sequence() {
        let timeline = timeline_of(
            json!([]),
            json!([
                {
                    "OTIO_SCHEMA": "Marker.1",
                    "name": "Backwards",
                    "marked_range": range(-48.0, 0.0, 24.0),
                },
                {
                    "OTIO_SCHEMA": "Marker.1",
                    "name": "Unreadable",
                    "marked_range": {
                        "OTIO_SCHEMA": "TimeRange.1",
                        "start_time": rational(1.0, 0.0),
                        "duration": rational(0.0, 24.0),
                    },
                },
            ]),
        );

        let plan = plan_for(&timeline, &HashMap::new()).expect("plan should build");

        assert!(plan.steps.is_empty(), "no marker should be placed");
        assert!(plan
            .warnings
            .iter()
            .any(|warning| warning.contains("before the start of the sequence")));
        assert!(plan
            .warnings
            .iter()
            .any(|warning| warning.contains("cannot read")));
        assert_no_null_or_infinite_times(&plan);
    }

    /// Fails if any step carries a time that is not a real number.
    fn assert_no_null_or_infinite_times(plan: &OtioImportPlan) {
        for step in &plan.steps {
            for key in ["timelineStart", "sourceIn", "sourceOut", "timeSec"] {
                if let Some(value) = step["payload"].get(key) {
                    let number = value
                        .as_f64()
                        .unwrap_or_else(|| panic!("{key} must be a number, got {value}"));
                    assert!(number.is_finite(), "{key} must be finite, got {number}");
                }
            }
        }
    }

    // =========================================================================
    // Transition placement
    // =========================================================================

    #[test]
    fn should_not_attach_a_transition_to_a_cut_that_lost_its_neighbour() {
        // [A, T1, B(offline), T2, C]: B is skipped, so neither transition sits on
        // a surviving cut any more. Resolving by the count of placed clips walks
        // T1 onto the A|C boundary the file never named, and gives both
        // transitions the same step id.
        let timeline = timeline_of(
            json!([video_track(json!([
                clip_node("a", 48.0, 72.0, "file:///media/a.mp4"),
                dissolve_node(12.0, 12.0, None),
                {
                    "OTIO_SCHEMA": "Clip.2",
                    "name": "b_offline",
                    "source_range": range(0.0, 72.0, 24.0),
                    "media_reference": { "OTIO_SCHEMA": "MissingReference.1" },
                },
                dissolve_node(12.0, 12.0, None),
                clip_node("c", 240.0, 72.0, "file:///media/a.mp4"),
            ]))]),
            json!([]),
        );
        let assets = assets_with(&[("a1", "a.mp4", "/media/a.mp4", Some(60.0))]);

        let plan = plan_for(&timeline, &assets).expect("plan should build");

        assert!(
            plan.steps
                .iter()
                .all(|step| step["commandType"] != "AddEffect"),
            "neither transition sits between two imported clips: {:?}",
            step_types(&plan)
        );
        assert_unique_step_ids(&plan);
        assert_eq!(
            plan.warnings
                .iter()
                .filter(|warning| warning.contains("does not sit between two imported clips"))
                .count(),
            2
        );
    }

    #[test]
    fn should_keep_two_transitions_on_one_track_apart() {
        let timeline = timeline_of(
            json!([video_track(json!([
                clip_node("a", 48.0, 72.0, "file:///media/a.mp4"),
                dissolve_node(12.0, 12.0, None),
                clip_node("b", 240.0, 72.0, "file:///media/a.mp4"),
                dissolve_node(12.0, 12.0, None),
                clip_node("c", 480.0, 72.0, "file:///media/a.mp4"),
            ]))]),
            json!([]),
        );
        let assets = assets_with(&[("a1", "a.mp4", "/media/a.mp4", Some(60.0))]);

        let plan = plan_for(&timeline, &assets).expect("plan should build");

        let attached: Vec<&str> = plan
            .steps
            .iter()
            .filter(|step| step["commandType"] == "AddEffect")
            .filter_map(|step| step["payload"]["clipId"]["$fromStep"].as_str())
            .collect();
        assert_eq!(attached, vec!["clip_0_0", "clip_0_2"]);
        assert_unique_step_ids(&plan);
    }

    #[test]
    fn should_not_place_a_transition_on_the_clip_before_a_skipped_one() {
        // [A, B(offline), T, C]: the transition's outgoing side is the clip that
        // was skipped, so there is nothing to attach it to — attaching it to A
        // would silently move the blend to a different cut.
        let timeline = timeline_of(
            json!([video_track(json!([
                clip_node("a", 48.0, 72.0, "file:///media/a.mp4"),
                {
                    "OTIO_SCHEMA": "Clip.2",
                    "name": "b_offline",
                    "source_range": range(0.0, 72.0, 24.0),
                    "media_reference": { "OTIO_SCHEMA": "MissingReference.1" },
                },
                dissolve_node(12.0, 12.0, None),
                clip_node("c", 240.0, 72.0, "file:///media/a.mp4"),
            ]))]),
            json!([]),
        );
        let assets = assets_with(&[("a1", "a.mp4", "/media/a.mp4", Some(60.0))]);

        let plan = plan_for(&timeline, &assets).expect("plan should build");

        assert!(plan
            .steps
            .iter()
            .all(|step| step["commandType"] != "AddEffect"));
        assert!(plan
            .warnings
            .iter()
            .any(|warning| warning.contains("an adjacent \nclip was skipped")
                || warning.contains("adjacent clip was skipped")));
    }

    fn assert_unique_step_ids(plan: &OtioImportPlan) {
        let mut seen = std::collections::HashSet::new();
        for step in &plan.steps {
            let id = step["id"].as_str().expect("every step has an id");
            assert!(seen.insert(id.to_string()), "duplicate step id '{id}'");
        }
    }

    #[test]
    fn should_refuse_a_transition_type_that_is_not_a_two_input_transition() {
        // metadata.openreelio.transitionType is read from an untrusted file: with
        // no allowlist it adds any effect in the catalogue through a cut verb.
        let timeline = timeline_of(
            json!([video_track(json!([
                clip_node("a", 48.0, 72.0, "file:///media/a.mp4"),
                dissolve_node(12.0, 12.0, Some("brightness")),
                clip_node("b", 240.0, 72.0, "file:///media/a.mp4"),
            ]))]),
            json!([]),
        );
        let assets = assets_with(&[("a1", "a.mp4", "/media/a.mp4", Some(60.0))]);

        let plan = plan_for(&timeline, &assets).expect("plan should build");

        assert!(
            plan.steps
                .iter()
                .all(|step| step["commandType"] != "AddEffect"),
            "'brightness' is not a transition and must not be added as an effect"
        );
        assert!(plan
            .warnings
            .iter()
            .any(|warning| warning.contains("brightness")));
    }

    #[test]
    fn should_restore_the_direction_a_wipe_was_exported_with() {
        // Without the direction the renderer defaults to left, so a wipe-right
        // silently becomes a wipe-left on the round trip.
        let mut node = dissolve_node(12.0, 12.0, Some("wipe"));
        node["metadata"]["openreelio"]["direction"] = json!("right");
        let timeline = timeline_of(
            json!([video_track(json!([
                clip_node("a", 48.0, 72.0, "file:///media/a.mp4"),
                node,
                clip_node("b", 240.0, 72.0, "file:///media/a.mp4"),
            ]))]),
            json!([]),
        );
        let assets = assets_with(&[("a1", "a.mp4", "/media/a.mp4", Some(60.0))]);

        let plan = plan_for(&timeline, &assets).expect("plan should build");
        let effect = plan
            .steps
            .iter()
            .find(|step| step["commandType"] == "AddEffect")
            .expect("the wipe should import");

        assert_eq!(effect["payload"]["effectType"], "wipe");
        assert_eq!(effect["payload"]["params"]["direction"], "right");
    }

    // =========================================================================
    // Reported losses
    // =========================================================================

    #[test]
    fn should_report_the_speed_detail_the_import_does_not_restore() {
        let mut clip = clip_node("fast", 0.0, 48.0, "file:///media/a.mp4");
        clip["metadata"] = json!({
            "openreelio": { "speed": 2.0, "reverse": true, "freezeFrame": true, "timeRemap": true }
        });
        let timeline = timeline_of(json!([video_track(json!([clip]))]), json!([]));
        let assets = assets_with(&[("a1", "a.mp4", "/media/a.mp4", Some(60.0))]);

        let plan = plan_for(&timeline, &assets).expect("plan should build");

        let entry = plan
            .unsupported
            .iter()
            .find(|entry| entry.contains("fast"))
            .unwrap_or_else(|| panic!("the loss must be reported: {:?}", plan.unsupported));
        assert!(entry.contains("2x speed change"), "{entry}");
        assert!(entry.contains("reverse playback"), "{entry}");
        assert!(entry.contains("freeze frame"), "{entry}");
        assert!(entry.contains("time remap"), "{entry}");
    }

    #[test]
    fn should_import_a_track_marker_onto_the_sequence_rather_than_claiming_to() {
        let mut track = video_track(json!([]));
        track["markers"] = json!([{
            "OTIO_SCHEMA": "Marker.1",
            "name": "Beat",
            "marked_range": range(48.0, 0.0, 24.0),
        }]);
        let timeline = timeline_of(json!([track]), json!([]));

        let plan = plan_for(&timeline, &HashMap::new()).expect("plan should build");

        assert_eq!(step_types(&plan), vec!["CreateTrack", "AddMarker"]);
        assert_eq!(plan.steps[1]["payload"]["timeSec"], 2.0);
        assert_eq!(plan.steps[1]["payload"]["label"], "Beat");
        assert!(plan
            .warnings
            .iter()
            .any(|warning| warning.contains("was imported onto the sequence")));
    }

    #[test]
    fn should_report_clip_markers_as_lost_rather_than_dropping_them_silently() {
        let mut clip = clip_node("a", 0.0, 48.0, "file:///media/a.mp4");
        clip["markers"] = json!([{
            "OTIO_SCHEMA": "Marker.1",
            "name": "Note",
            "marked_range": range(12.0, 0.0, 24.0),
        }]);
        let timeline = timeline_of(json!([video_track(json!([clip]))]), json!([]));
        let assets = assets_with(&[("a1", "a.mp4", "/media/a.mp4", Some(60.0))]);

        let plan = plan_for(&timeline, &assets).expect("plan should build");

        assert!(plan
            .unsupported
            .iter()
            .any(|entry| entry.contains("marker(s) that were not imported")));
    }

    // =========================================================================
    // Frame grid
    // =========================================================================

    #[test]
    fn should_land_a_foreign_rate_on_the_target_sequences_frame_grid() {
        // Given: a 24fps cut imported into a 30fps sequence. 25 frames at 24fps
        // is 1.041666…s, which is not a position a 30fps sequence has.
        let timeline = timeline_of(
            json!([video_track(json!([
                clip_node("a", 0.0, 25.0, "file:///media/a.mp4"),
                clip_node("b", 0.0, 25.0, "file:///media/a.mp4"),
            ]))]),
            json!([]),
        );
        let assets = assets_with(&[("a1", "a.mp4", "/media/a.mp4", Some(60.0))]);

        // When: converting against a 30fps sequence
        let plan = plan_at(&timeline, &assets, PROJECT_ROOT, false, Ratio::new(30, 1))
            .expect("plan should build");

        // Then: every position is a whole 30fps frame, and the rate difference
        // is reported rather than silently absorbed
        for step in plan
            .steps
            .iter()
            .filter(|step| step["commandType"] == "InsertClip")
        {
            let start = step["payload"]["timelineStart"]
                .as_f64()
                .expect("a timeline start");
            let frame = start * 30.0;
            assert!(
                (frame - frame.round()).abs() < 1e-9,
                "{start}s is not on the 30fps grid"
            );
        }
        assert!(
            plan.unsupported
                .iter()
                .any(|entry| entry.contains("frame grid")),
            "the rate mismatch must be reported: {:?}",
            plan.unsupported
        );
    }
}
