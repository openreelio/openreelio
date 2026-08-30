//! Render Cache System
//!
//! Pre-renders timeline segments to cache files for smooth playback.
//! Supports cache invalidation when clips or effects change, and smart
//! rendering that copies cached segments instead of re-encoding.
//!
//! # Architecture
//!
//! The timeline is split into fixed-duration segments (default 5 seconds).
//!
//! # Segment identity
//!
//! A segment is identified by exactly one fingerprint, and
//! [`refresh_manifest_plan_fingerprints`] is its sole writer. Every other
//! manifest operation — creating segments, reconciling a duration change,
//! recovering from an interrupted render — carries the stored value through
//! untouched. A manifest whose segments have never been planned carries
//! [`SEGMENT_FINGERPRINT_UNSET`].
//!
//! That one fingerprint combines four inputs, because no one of them covers the
//! rendered result on its own (see [`compute_plan_segment_fingerprint`]):
//!
//! 1. the hash of the [`RenderPlan`](crate::core::render::RenderPlan) that would
//!    produce the segment — the same boundary final export validates against,
//!    which is also what notices an asset re-probe or a capability verdict change
//! 2. the encode profile ([`compute_profile_hash`]), invisible to the plan
//! 3. [`RENDERER_SEMANTICS_VERSION`], so a build whose compositor math changed
//!    cannot serve pixels the old math produced
//! 4. a content hash of the timeline inside the segment's window
//!    ([`compute_window_content_hash`]), covering the render inputs the render
//!    graph drops on its way to the plan — motion keyframes, freeze/reverse,
//!    time remap, speed, track blending and volume, canvas and audio format
//!
//! Input 4 is a supplement forced by the graph's current coverage, not a second
//! notion of identity: it is folded into the same value, written at the same
//! place, and can be dropped once the graph carries every render input.
//!
//! # Profile partitioning
//!
//! Encode settings are not part of a render plan, so two profiles (the preview
//! cache vs. an export ladder, say) plan identically while producing
//! incompatible files. The profile hash therefore both feeds the fingerprint
//! and names the directory segments live in
//! (`renders/<sequenceId>/<profileHash>/segment_0000.mov`), so one profile's
//! files can never be handed to a request for another.

use std::collections::{HashMap, HashSet};
use std::fmt;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::core::assets::{Asset, AssetKind};
use crate::core::effects::Effect;
use crate::core::fs::validate_path_id_component;
use crate::core::render::export::{effective_blend_mode_for_clip, is_text_clip, output_video_fps};
use crate::core::render::transition_stitch::{DEFAULT_TRANSITION_SEC, MAX_TRANSITION_SEC};
use crate::core::render::{
    build_render_plan, ExportSettings, RenderGraph, RENDERER_SEMANTICS_VERSION,
};
use crate::core::timeline::{BlendMode, Canvas, Clip, Sequence, Track, TrackKind, Transform};
use crate::core::types::SequenceId;

// =============================================================================
// Constants
// =============================================================================

/// Default segment duration in seconds for cache splitting
const DEFAULT_SEGMENT_DURATION_SEC: f64 = 5.0;

/// Minimum segment duration (avoids tiny fragments at timeline end)
const MIN_SEGMENT_DURATION_SEC: f64 = 0.5;

/// Cache manifest file name within the cache directory
const CACHE_MANIFEST_FILENAME: &str = "manifest.json";

/// Number of hex digits in a render profile hash.
const PROFILE_HASH_LEN: usize = 16;

// =============================================================================
// Cache Segment State
// =============================================================================

/// State of a single cache segment
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum CacheSegmentState {
    /// Not yet rendered
    #[default]
    Empty,
    /// Previously cached but invalidated by an edit
    Stale,
    /// Currently being rendered
    Rendering,
    /// Fully rendered and valid
    Cached,
    /// Rendering failed
    Error,
}

impl fmt::Display for CacheSegmentState {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Empty => write!(f, "empty"),
            Self::Stale => write!(f, "stale"),
            Self::Rendering => write!(f, "rendering"),
            Self::Cached => write!(f, "cached"),
            Self::Error => write!(f, "error"),
        }
    }
}

// =============================================================================
// Segment Flags
// =============================================================================

/// Why the live preview cannot draw a cache segment faithfully.
///
/// This is the cache's auto-flag vocabulary, modelled on DaVinci Resolve Smart
/// Cache's automatic flag list: the timeline is scanned for constructs the
/// interactive preview cannot reproduce, and those stretches are the ones the
/// cache fills automatically.
///
/// # Relationship to the frontend's preview-mode fallback
///
/// It covers every divergence `getCanvasFallbackReason`
/// (`src/hooks/usePreviewMode.ts`) reports, and more. That function asks a
/// narrower question — must the WebView switch from `<video>` playback to
/// canvas compositing? — so it stays quiet wherever the WebView can draw
/// *something*, even when that something is not what export writes:
///
/// - text clips and caption clips are drawn by the WebView as HTML overlays, so
///   the frontend does not fall back for them — but HTML text is laid out and
///   rasterized by the browser, while export burns the same text with
///   `drawtext`/ASS. Fonts, kerning, wrapping and antialiasing all differ, so
///   the preview is never pixel-identical and both are flagged here.
/// - the frontend returns the first reason it finds; this returns every reason
///   that applies, so a status readout can explain the whole segment.
///
/// The containment is not literal in one place, deliberately: the frontend
/// falls back whenever `clip.effects` is non-empty, including for a *disabled*
/// effect. A disabled effect changes neither path, so it is not a divergence and
/// is not flagged here. That is the frontend being conservative about its own
/// renderer, not a difference this vocabulary is missing.
///
/// The rule that decides membership is: *would the export path and the live
/// preview disagree about these pixels?* If yes, it is flagged.
///
/// # Fill eligibility
///
/// A flag says the preview cannot be trusted here; it does not promise the
/// cache can do better. Some reasons mark content the export pipeline itself
/// refuses or errors on — see [`SegmentFlagReason::fill_renderable`]. A segment
/// is eligible for an automatic fill only when **every** reason it carries is
/// `fill_renderable`, because one unrenderable ingredient fails the whole
/// segment's render.
///
/// # Ordering
///
/// `Ord` derives from declaration order, and classifier output is sorted, so the
/// declaration order is what gets persisted into manifests. Serde keys on the
/// variant *names*, so inserting a variant anywhere is safe to deserialize —
/// but it does re-order stored lists, which makes the next
/// [`refresh_manifest_segment_flags`] report a change and re-save every
/// manifest once. That is the whole cost; nothing is invalidated.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum SegmentFlagReason {
    /// A non-`Normal` effective blend mode (clip's own, or folded from its track).
    BlendMode,
    /// A non-identity clip transform (position, scale, rotation or anchor).
    Transform,
    /// Animated transform keyframes.
    MotionKeyframes,
    /// Clip opacity below 1.0.
    Opacity,
    /// One or more enabled single-input clip effects, or an effect id that
    /// resolves to nothing.
    ClipEffects,
    /// Retiming: speed, reverse, freeze frame or a time remap curve.
    Speed,
    /// A two-input transition, which blends across a cut with handles.
    Transition,
    /// A text clip, burned in by export but drawn as an HTML overlay live.
    TextClip,
    /// A caption clip, burned in by export but drawn as an HTML overlay live.
    StyledCaption,
    /// A visual clip whose asset is not video (an image, say).
    NonVideoAsset,
    /// A clip whose asset is not in the project's asset table.
    MissingAsset,
    /// A compound clip, whose picture comes from a nested sequence.
    CompoundClip,
    /// An adjustment layer carrying effects, which apply to everything beneath it.
    AdjustmentLayer,
    /// Media on an overlay track: the canvas preview composites it, the export
    /// pipeline refuses it.
    OverlayTrackMedia,
}

impl SegmentFlagReason {
    /// Whether the export pipeline can actually render a segment carrying this
    /// reason.
    ///
    /// Reasons that mark content the export path refuses or errors on still
    /// warn that the live preview is untrustworthy — that is what they are for —
    /// but an automatic fill must skip segments whose only path to truth cannot
    /// run, or it retries a failing render forever:
    ///
    /// - [`CompoundClip`](Self::CompoundClip) and
    ///   [`MissingAsset`](Self::MissingAsset): the media walk resolves the clip's
    ///   asset id and fails with `Asset not found` (a compound clip's
    ///   `__compound__…` id resolves to nothing by construction).
    /// - [`OverlayTrackMedia`](Self::OverlayTrackMedia): the media walk skips
    ///   overlay tracks outright, and export preflight rejects the sequence with
    ///   "Overlay tracks are not supported in final render export yet".
    ///
    /// A segment is fill-eligible only when every reason it carries returns
    /// `true` here.
    pub fn fill_renderable(&self) -> bool {
        !matches!(
            self,
            Self::CompoundClip | Self::MissingAsset | Self::OverlayTrackMedia
        )
    }
}

// =============================================================================
// Fingerprinting
// =============================================================================

/// A deterministic fingerprint of the render plan that produces a segment.
///
/// Written only by [`refresh_manifest_plan_fingerprints`]; see the module docs.
pub type SegmentFingerprint = u64;

/// Fingerprint of a segment whose render plan has not been hashed yet.
///
/// Segments are created with this value and stay at it until
/// [`refresh_manifest_plan_fingerprints`] runs, so a never-planned segment can
/// never compare equal to a planned one.
pub const SEGMENT_FINGERPRINT_UNSET: SegmentFingerprint = 0;

/// Helper: hash an f64 by converting to bits (avoids NaN issues).
fn hash_f64(value: f64, hasher: &mut impl Hasher) {
    let bits = if value.is_nan() {
        0u64
    } else {
        value.to_bits()
    };
    bits.hash(hasher);
}

/// Hashes a `serde_json::Value` deterministically.
///
/// Object keys are sorted before hashing, so a struct containing a `HashMap`
/// (effect params, for one) hashes the same on every run and in every process.
/// Each variant is tagged so a value cannot collide with a different-typed one
/// that happens to share a representation.
fn hash_json(value: &serde_json::Value, hasher: &mut impl Hasher) {
    use serde_json::Value;

    match value {
        Value::Null => 0u8.hash(hasher),
        Value::Bool(flag) => {
            1u8.hash(hasher);
            flag.hash(hasher);
        }
        Value::Number(number) => {
            2u8.hash(hasher);
            number.to_string().hash(hasher);
        }
        Value::String(text) => {
            3u8.hash(hasher);
            text.hash(hasher);
        }
        Value::Array(items) => {
            4u8.hash(hasher);
            items.len().hash(hasher);
            for item in items {
                hash_json(item, hasher);
            }
        }
        Value::Object(fields) => {
            5u8.hash(hasher);
            let mut keys: Vec<&String> = fields.keys().collect();
            keys.sort_unstable();
            keys.len().hash(hasher);
            for key in keys {
                key.hash(hasher);
                hash_json(&fields[key], hasher);
            }
        }
    }
}

/// A render input serialized for hashing, minus its denied fields.
///
/// Caching this lets a window-independent input (the sequence, a track) be
/// serialized once and re-hashed per segment instead of re-serialized. The
/// serialize-failure case is preserved as a distinct variant so the hashed
/// bytes are identical whether the value is cached or hashed inline.
enum RenderJson {
    Value(serde_json::Value),
    SerializeError,
}

/// Serializes `value` minus the named top-level fields, for later hashing.
///
/// The list is a *deny*-list on purpose. An allow-list of render-affecting
/// fields is exactly what let `motion_keyframes`, `freeze_frame` and friends
/// escape the render plan's coverage: a field added later is invisible to it
/// and silently unfingerprinted. Denying is the safe default — a field nobody
/// classified is hashed, costing at worst an unnecessary re-render.
fn render_json(value: &impl Serialize, ignored: &[&str]) -> RenderJson {
    match serde_json::to_value(value) {
        Ok(mut json) => {
            if let Some(object) = json.as_object_mut() {
                for key in ignored {
                    object.remove(*key);
                }
            }
            RenderJson::Value(json)
        }
        Err(error) => {
            tracing::warn!("Failed to serialize render input for cache fingerprint: {error}");
            RenderJson::SerializeError
        }
    }
}

/// Hashes a previously serialized render input.
fn hash_cached_render_json(cached: &RenderJson, hasher: &mut impl Hasher) {
    match cached {
        RenderJson::Value(json) => hash_json(json, hasher),
        RenderJson::SerializeError => "render_input_serialize_error".hash(hasher),
    }
}

/// Hashes everything `value` serializes to, minus the named top-level fields.
fn hash_render_json(value: &impl Serialize, ignored: &[&str], hasher: &mut impl Hasher) {
    hash_cached_render_json(&render_json(value, ignored), hasher);
}

/// Sequence fields that do not reach the renderer.
///
/// `tracks` is hashed per track, and only for the clips inside the window;
/// hashing it here would make every segment depend on the whole timeline.
const SEQUENCE_NON_RENDER_FIELDS: &[&str] =
    &["tracks", "markers", "name", "createdAt", "modifiedAt"];

/// Track fields that do not reach the renderer.
///
/// `clips` is hashed per window. `locked` and `syncLock` constrain editing, not
/// rendering.
const TRACK_NON_RENDER_FIELDS: &[&str] = &["clips", "name", "locked", "syncLock"];

/// Clip fields that do not reach the renderer: labelling and grouping only.
const CLIP_NON_RENDER_FIELDS: &[&str] = &["label", "color", "linkGroupId", "groupId"];

/// Collects clips from a track that overlap a given time range [start, end).
fn clips_in_range(track: &Track, start_sec: f64, end_sec: f64) -> Vec<&Clip> {
    track
        .clips
        .iter()
        .filter(|clip| {
            clip.enabled
                && clip.place.timeline_in_sec < end_sec
                && clip.place.timeline_out_sec() > start_sec
        })
        .collect()
}

/// Hashes every render input inside a time window that the render plan misses.
///
/// # Why this exists
///
/// [`RenderPlan`](crate::core::render::RenderPlan) is built from
/// [`RenderGraph`](RenderGraph) layers, and those layers do not carry every
/// property the export path reads off the timeline — `motion_keyframes`,
/// `freeze_frame`, `reverse`, `time_remap`, `slow_motion_interpolation` and
/// `speed` on the video side, track `blend_mode` and `volume`, the sequence's
/// master volume, canvas size and audio format. All of them change the rendered
/// pixels or samples, and all of them would leave the plan hash untouched: add
/// two motion keyframes to a cached clip and a plan-hash-only fingerprint keeps
/// serving the static frame.
///
/// So this is a *supplement*, not a replacement. The plan hash still carries
/// what only planning knows — asset re-probes, effect capability verdicts,
/// validation outcomes — and this carries the timeline state the graph drops.
/// Both are folded into [`compute_plan_segment_fingerprint`].
///
/// Coverage is defined by exclusion (see [`hash_render_json`]) so a field added
/// to `Clip`, `Track` or `Sequence` later is fingerprinted by default rather
/// than escaping unnoticed.
///
/// # Known limitation
///
/// This hashes only the outer sequence. A compound clip references a nested
/// sequence by id (`compound_sequence_id`); editing that nested sequence changes
/// neither this hash nor the plan hash, so the outer sequence's cached segments
/// are not invalidated. Following the reference is deferred — it is a *reference
/// not resolved* rather than an excluded field, so the deny-list strategy does
/// not close it.
pub fn compute_window_content_hash(
    sequence: &Sequence,
    effects: &HashMap<String, Effect>,
    start_sec: f64,
    end_sec: f64,
) -> u64 {
    let prelude = WindowContentPrelude::new(sequence);
    compute_window_content_hash_with(&prelude, sequence, effects, start_sec, end_sec)
}

/// The window-independent half of [`compute_window_content_hash`], serialized once.
///
/// Hashing every segment's window re-hashes the sequence header and each track
/// header, and those serializations do not depend on the window — only the
/// per-clip hashing does. A caller fingerprinting many segments of one sequence
/// (see [`refresh_manifest_plan_fingerprints`]) builds this once so the
/// whole-timeline serialization is not repeated per segment, which would make
/// the cost grow with the square of the timeline length.
struct WindowContentPrelude {
    sequence: RenderJson,
    tracks: Vec<RenderJson>,
}

impl WindowContentPrelude {
    fn new(sequence: &Sequence) -> Self {
        Self {
            sequence: render_json(sequence, SEQUENCE_NON_RENDER_FIELDS),
            tracks: sequence
                .tracks
                .iter()
                .map(|track| render_json(track, TRACK_NON_RENDER_FIELDS))
                .collect(),
        }
    }
}

/// Hashes one window using a prelude built from the *same* sequence.
///
/// The hashed bytes are identical to inlining the serialization: the prelude
/// only moves the window-independent `serde_json::to_value` calls out of the
/// per-segment loop, so fingerprints are unchanged.
fn compute_window_content_hash_with(
    prelude: &WindowContentPrelude,
    sequence: &Sequence,
    effects: &HashMap<String, Effect>,
    start_sec: f64,
    end_sec: f64,
) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();

    hash_f64(start_sec, &mut hasher);
    hash_f64(end_sec, &mut hasher);
    hash_cached_render_json(&prelude.sequence, &mut hasher);

    // Track order is compositing order. The prelude is built from this sequence,
    // so its track serializations line up with `sequence.tracks` one-to-one.
    for (track, track_json) in sequence.tracks.iter().zip(&prelude.tracks) {
        hash_cached_render_json(track_json, &mut hasher);

        let overlapping = clips_in_range(track, start_sec, end_sec);
        overlapping.len().hash(&mut hasher);

        for clip in overlapping {
            hash_render_json(clip, CLIP_NON_RENDER_FIELDS, &mut hasher);

            // Effect bodies, not just the ids the clip lists.
            for effect_id in &clip.effects {
                if let Some(effect) = effects.get(effect_id) {
                    hash_render_json(effect, &[], &mut hasher);
                }
            }
        }
    }

    hasher.finish()
}

/// Computes the cache fingerprint for a segment.
///
/// Four inputs, each covering what the others cannot:
/// - `plan_hash` — the export contract: the same
///   [`RenderPlan`](crate::core::render::RenderPlan) boundary final export
///   validates, which also catches asset re-probes and effect capability changes
/// - `profile_hash` — the encode profile, invisible to the plan: two profiles
///   produce byte-incompatible files from an identical plan
/// - [`RENDERER_SEMANTICS_VERSION`] — the compositor's own behaviour, so a build
///   that changed the math cannot serve pixels produced by the old one
/// - `content_hash` — the timeline state the render graph drops on the way to
///   the plan (see [`compute_window_content_hash`])
pub fn compute_plan_segment_fingerprint(
    plan_hash: &str,
    profile_hash: &str,
    content_hash: u64,
) -> SegmentFingerprint {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    plan_hash.hash(&mut hasher);
    profile_hash.hash(&mut hasher);
    RENDERER_SEMANTICS_VERSION.hash(&mut hasher);
    content_hash.hash(&mut hasher);
    hasher.finish()
}

/// Computes the encode-profile hash for a set of export settings.
///
/// Everything the settings carry is hashed except the output path and the time
/// range, which identify a segment rather than a profile. Coverage is defined
/// by exclusion so an encode option added later partitions the cache by default
/// instead of silently sharing a directory with an incompatible encode.
pub fn compute_profile_hash(settings: &ExportSettings) -> String {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    hash_render_json(
        settings,
        &["outputPath", "startTime", "endTime"],
        &mut hasher,
    );
    format!("{:0width$x}", hasher.finish(), width = PROFILE_HASH_LEN)
}

/// Profile hash of the preview-cache encode profile for a sequence canvas.
///
/// Derived from [`ExportSettings::preview_cache`] itself rather than restating
/// its values, so changing the preview-cache profile automatically retires
/// caches written with the old one.
///
/// The canvas is part of the profile because the cache renders at the sequence's
/// own resolution: two canvases produce different hashes, so resizing a sequence
/// partitions the cache into a fresh directory and the old segments are pruned
/// by [`manifest_for_profile`] / [`prune_other_profile_caches`] instead of being
/// served at the wrong resolution.
pub fn preview_profile_hash(canvas: &Canvas) -> String {
    compute_profile_hash(&ExportSettings::preview_cache(
        PathBuf::new(),
        canvas,
        None,
        None,
    ))
}

/// Reports whether `value` is a profile hash this module could have produced.
///
/// # Security
/// A profile hash names a directory inside the cache tree, and reaches path
/// construction from the on-disk manifest. Exactly as with segment file names,
/// this allowlists the writer's own output — 16 lowercase hex digits, which
/// cannot express a separator or a `..` component — instead of blocklisting
/// traversal.
fn is_profile_hash(value: &str) -> bool {
    value.len() == PROFILE_HASH_LEN
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// Seconds of neighbouring timeline a segment's picture can depend on.
///
/// A two-input transition of length `D` is rendered with handles: the outgoing
/// clip plays past its out point and the incoming clip starts before its in
/// point, so the blend straddles the cut (see
/// [`transition_stitch`](crate::core::render::transition_stitch)). A segment
/// boundary inside that blend therefore depends on a clip that does not overlap
/// the segment at all, and its fingerprint has to look that far out or a
/// transition edit would leave one of the two neighbours cached and wrong.
///
/// The reach is measured the way the stitcher measures a handle, and then
/// rounded outwards: the stitcher quantizes `D` to `round(D * fps)` frames and
/// splits them *unevenly* — the outgoing side gets the extra frame of an odd
/// count — so half of `D` is not an upper bound. Taking `ceil(D * fps)` frames
/// and adding one frame of slack covers both the rounding and the uneven split.
///
/// A transition whose effect carries no duration is planned at
/// [`DEFAULT_TRANSITION_SEC`], so it is measured at that length here too rather
/// than being skipped for want of a param.
///
/// The reach is the widest any enabled two-input transition in the project asks
/// for, and is zero when there are none — so a timeline without transitions
/// keeps exact per-segment invalidation.
///
/// It is deliberately one number for the whole timeline rather than one per
/// boundary. That over-invalidates: with a transition anywhere, an edit within
/// the reach of a segment's edge invalidates that segment too, even across a
/// boundary that carries no transition. Erring that way costs a re-render;
/// erring the other way ships a stale frame. Narrowing it needs the planned
/// transition set (which boundaries actually blend, and how wide), and that
/// planner lives behind the export engine's asset probing.
fn transition_window_reach_sec(effects: &HashMap<String, Effect>, fps: f64) -> f64 {
    if !fps.is_finite() || fps <= 0.0 {
        return 0.0;
    }

    effects
        .values()
        .filter(|effect| effect.enabled && effect.effect_type.is_two_input_transition())
        .map(|effect| {
            effect
                .get_float("duration")
                .unwrap_or(DEFAULT_TRANSITION_SEC)
        })
        // A transition the stitcher would refuse blends nothing, so it reaches nowhere.
        .filter(|duration| duration.is_finite() && *duration > 0.0)
        .map(|duration| {
            let frames = (duration.min(MAX_TRANSITION_SEC) * fps).ceil();
            (frames / 2.0 + 1.0) / fps
        })
        .fold(0.0f64, f64::max)
}

/// Refreshes segment fingerprints.
///
/// This is the cache side of the preview/export contract: cache identity is
/// derived from the same graph/plan boundary that export validates, plus the
/// timeline state that boundary drops (see [`compute_window_content_hash`]),
/// the encode profile and the renderer's own version. It is the only writer of
/// [`RenderCacheSegment::fingerprint`] — see the module docs.
///
/// Each segment is fingerprinted over its own window, widened by
/// [`transition_window_reach_sec`] so a transition blending across a segment
/// boundary invalidates both of its neighbours.
///
/// Returns whether any fingerprint changed.
pub fn refresh_manifest_plan_fingerprints(
    manifest: &mut RenderCacheManifest,
    project_path: &Path,
    sequence: &Sequence,
    graph: &RenderGraph,
    assets: &HashMap<String, Asset>,
    effects: &HashMap<String, Effect>,
) -> Result<bool, String> {
    let mut changed = false;
    let sequence_id = manifest.sequence_id.clone();
    let profile_hash = manifest.profile_hash.clone();
    // Measure the transition reach at the fps the segments are actually encoded
    // at, which is what `output_video_fps` resolves from the cache profile. The
    // stitcher quantizes the transition split at that same rate; measuring reach
    // at a different rate can leave the window one output frame short of the real
    // tail. (The cache profile follows the sequence fps, so the two agree — this
    // stays derived from the profile so a profile that pins an fps still matches.)
    let encode_fps = output_video_fps(
        sequence,
        &ExportSettings::preview_cache(PathBuf::new(), &sequence.format.canvas, None, None),
    );
    let reach_sec = transition_window_reach_sec(effects, encode_fps);

    // Serialize the window-independent content (sequence + track headers) once,
    // not once per segment — otherwise the poll's cost grows with the square of
    // the timeline length.
    let content_prelude = WindowContentPrelude::new(sequence);

    for segment in &mut manifest.segments {
        let segment_output =
            segment_cache_file(project_path, &sequence_id, &profile_hash, segment.index)?;
        let window_start_sec = (segment.start_sec - reach_sec).max(0.0);
        let window_end_sec = segment.end_sec + reach_sec;
        let settings = ExportSettings::preview_cache(
            segment_output,
            &sequence.format.canvas,
            Some(window_start_sec),
            Some(window_end_sec),
        );
        let plan = build_render_plan(graph, assets, effects, &settings);
        if !plan.validation.is_valid {
            return Err(format!(
                "Preview cache segment {} render plan validation failed: {}",
                segment.index,
                plan.validation.errors.join("; ")
            ));
        }

        let content_hash = compute_window_content_hash_with(
            &content_prelude,
            sequence,
            effects,
            window_start_sec,
            window_end_sec,
        );
        let next_fingerprint =
            compute_plan_segment_fingerprint(&plan.plan_hash, &profile_hash, content_hash);
        if next_fingerprint != segment.fingerprint {
            if segment.state == CacheSegmentState::Cached {
                segment.state = CacheSegmentState::Stale;
            }
            segment.fingerprint = next_fingerprint;
            changed = true;
        }
    }

    if changed {
        manifest.updated_at = chrono::Utc::now().to_rfc3339();
    }

    Ok(changed)
}

// =============================================================================
// Segment Flag Classifier
// =============================================================================

/// Asset id the backend gives to generated caption clips.
///
/// Mirrors `CAPTION_CLIP_ASSET_ID` in `src/utils/captionClip.ts`; a clip
/// carrying it is caption text even on a plain video track.
const CAPTION_CLIP_ASSET_ID: &str = "caption";

/// Tolerance for treating a float property as "left at its default".
///
/// A transform or opacity that survived a JSON round-trip can come back a few
/// ULPs off the value it was written with, and exact equality would flag an
/// untouched clip. `1e-4` is the same tolerance the frontend's preview-mode
/// check uses, so the two agree on what counts as identity.
const FLAG_EPSILON: f64 = 1e-4;

/// Reports whether a transform leaves the frame exactly as the source drew it.
///
/// Compared component-wise against [`Transform::default`] rather than by
/// `PartialEq`, so round-trip noise below [`FLAG_EPSILON`] is not a transform.
fn is_identity_transform(transform: &Transform) -> bool {
    let identity = Transform::default();
    let near = |a: f64, b: f64| (a - b).abs() <= FLAG_EPSILON;

    near(transform.position.x, identity.position.x)
        && near(transform.position.y, identity.position.y)
        && near(transform.scale.x, identity.scale.x)
        && near(transform.scale.y, identity.scale.y)
        && near(transform.rotation_deg, identity.rotation_deg)
        && near(transform.anchor.x, identity.anchor.x)
        && near(transform.anchor.y, identity.anchor.y)
}

/// Reports whether a clip carries caption text rather than media.
///
/// Mirrors `isCaptionLikeClip` in `src/utils/captionClip.ts`: a caption track,
/// a subtitle asset, or the reserved caption asset id.
fn is_caption_like_clip(clip: &Clip, track: &Track, asset: Option<&Asset>) -> bool {
    track.kind == TrackKind::Caption
        || asset.is_some_and(|asset| asset.kind == AssetKind::Subtitle)
        || clip.asset_id == CAPTION_CLIP_ASSET_ID
}

/// Reports whether a track contributes *media pixels* to the frame.
///
/// This is the gate the visual builders use — `contributes_to_output() &&
/// visible` in both [`ffmpeg_plan`](crate::core::render::ffmpeg_plan) and
/// [`pip_stitch`](crate::core::render::pip_stitch) — plus dropping audio tracks,
/// which reach no frame at all. `contributes_to_output` alone would keep a
/// hidden video track, because such a track still contributes its audio.
///
/// # It is not the only gate the export path uses
///
/// The text and caption overlay walks are deliberately wider: they gate on
/// `track_included_in_media_collection`, which is plain
/// [`Track::contributes_to_output`] with no `visible` term (see
/// `collect_drawtext_text_overlays` and the ASS builder in
/// [`export`](crate::core::render::export)). A hidden — but unmuted — video
/// track therefore contributes **no media pixels and yet still burns its text
/// clips** into the output. [`classify_segment_window`] walks that asymmetry as
/// a separate arm rather than widening this predicate, because widening it here
/// would wrongly flag the hidden track's *media* clips too.
fn track_affects_picture(track: &Track) -> bool {
    track.kind != TrackKind::Audio && track.contributes_to_output() && track.visible
}

/// Reports whether a track draws no media but still burns its text clips.
///
/// The complement of [`track_affects_picture`] over the text overlay walk's own
/// gate: an unmuted video track that is hidden. See that function for why the
/// two gates differ.
fn track_burns_text_only(track: &Track) -> bool {
    track.kind == TrackKind::Video && track.contributes_to_output() && !track.visible
}

/// Every reason one clip makes the live preview diverge from the export.
///
/// Reasons are independent facts about the clip, so all that apply are
/// collected — except the media-identity reasons ([`TextClip`], [`StyledCaption`],
/// [`NonVideoAsset`], [`MissingAsset`]), of which at most one can describe where
/// a clip's picture comes from.
///
/// Unresolvable inputs fail closed: an effect id with no effect behind it counts
/// as [`ClipEffects`], because "unknown" and "the preview cannot draw it" must
/// have the same consequence.
///
/// [`TextClip`]: SegmentFlagReason::TextClip
/// [`StyledCaption`]: SegmentFlagReason::StyledCaption
/// [`NonVideoAsset`]: SegmentFlagReason::NonVideoAsset
/// [`MissingAsset`]: SegmentFlagReason::MissingAsset
/// [`ClipEffects`]: SegmentFlagReason::ClipEffects
fn clip_flag_reasons(
    clip: &Clip,
    track: &Track,
    assets: &HashMap<String, Asset>,
    effects: &HashMap<String, Effect>,
) -> Vec<SegmentFlagReason> {
    let mut reasons = Vec::new();
    let asset = assets.get(&clip.asset_id);
    let is_text = is_text_clip(clip);

    // Where the picture comes from. Compound clips and adjustment layers carry
    // synthetic asset ids that resolve to nothing by design, so they are named
    // by their own reasons below rather than reported as a missing asset.
    if is_caption_like_clip(clip, track, asset) {
        reasons.push(SegmentFlagReason::StyledCaption);
    } else if is_text {
        reasons.push(SegmentFlagReason::TextClip);
    } else if clip.compound_sequence_id.is_none() && !clip.is_adjustment_layer {
        match asset {
            Some(asset) if asset.kind != AssetKind::Video => {
                reasons.push(SegmentFlagReason::NonVideoAsset);
            }
            None => reasons.push(SegmentFlagReason::MissingAsset),
            Some(_) => {}
        }
    }

    // Media on an overlay track. The canvas preview composites overlay tracks,
    // but the export media walk skips them (`Caption | Overlay => continue`) and
    // preflight rejects the sequence outright — so the two can never agree here.
    // Text clips are the one exception: they reach the output through the text
    // overlay walk, which does serve overlay tracks.
    if track.kind == TrackKind::Overlay && !is_text {
        reasons.push(SegmentFlagReason::OverlayTrackMedia);
    }

    if clip.compound_sequence_id.is_some() {
        reasons.push(SegmentFlagReason::CompoundClip);
    }
    // An adjustment layer with no effects composites nothing onto the clips
    // below it, so it changes no pixels in either path. The export planner gates
    // on exactly this pair (`is_adjustment_layer() && !effects.is_empty()`).
    if clip.is_adjustment_layer && !clip.effects.is_empty() {
        reasons.push(SegmentFlagReason::AdjustmentLayer);
    }

    // Compositing.
    if effective_blend_mode_for_clip(clip, track) != BlendMode::Normal {
        reasons.push(SegmentFlagReason::BlendMode);
    }
    if !is_identity_transform(&clip.transform) {
        reasons.push(SegmentFlagReason::Transform);
    }
    if !clip.motion_keyframes.is_empty() {
        reasons.push(SegmentFlagReason::MotionKeyframes);
    }
    if (f64::from(clip.opacity) - 1.0).abs() > FLAG_EPSILON {
        reasons.push(SegmentFlagReason::Opacity);
    }

    // Retiming. Any of these makes the frame at a timeline time come from a
    // source time the live preview does not compute.
    if (f64::from(clip.speed) - 1.0).abs() > FLAG_EPSILON
        || clip.reverse
        || clip.freeze_frame
        || clip.time_remap.is_some()
    {
        reasons.push(SegmentFlagReason::Speed);
    }

    // Effects. Two-input transitions are consumed at the timeline stitch, not in
    // the clip's filter chain (see `EffectType::is_two_input_transition`), so
    // they are reported as transitions instead of as clip effects.
    //
    // The predicate deliberately over-approximates what `transition_stitch`
    // actually renders, exactly as `transition_window_reach_sec` does: it asks
    // only "is an enabled two-input transition attached to this clip", and never
    // whether the clip abuts a neighbour to blend with, whether it is the first
    // such transition the stitcher would keep, or whether its duration survives
    // quantization. Answering those needs the planned transition set, which
    // lives behind the export engine's asset probing. Over-flagging costs a
    // segment that did not need caching; under-flagging leaves the user trusting
    // a preview of a blend that is not there.
    let mut has_transition = false;
    let mut has_clip_effect = false;
    for effect_id in &clip.effects {
        match effects.get(effect_id) {
            Some(effect) if !effect.enabled => {}
            Some(effect) if effect.effect_type.is_two_input_transition() => has_transition = true,
            Some(_) => has_clip_effect = true,
            None => has_clip_effect = true,
        }
    }
    if has_clip_effect {
        reasons.push(SegmentFlagReason::ClipEffects);
    }
    if has_transition {
        reasons.push(SegmentFlagReason::Transition);
    }

    reasons.sort();
    reasons.dedup();
    reasons
}

/// Classifies the timeline inside `[start_sec, end_sec)` for preview fidelity.
///
/// Pure: it reads the timeline and returns why the live WebView preview cannot
/// draw this window the way the export path would — see [`SegmentFlagReason`]
/// for the vocabulary and for how it relates to the frontend's own preview-mode
/// fallback. An empty result means the preview can be trusted here.
///
/// Only enabled clips overlapping the window are considered
/// ([`clips_in_range`]) — the same clip selection the window content hash uses,
/// so flags and fingerprints are computed over the same material.
///
/// Tracks are walked in two arms, because the export path does not use one
/// track gate. Media pixels come from [`track_affects_picture`] tracks. Text
/// clips additionally come from [`track_burns_text_only`] tracks — hidden but
/// unmuted video tracks, whose text the export still burns while the live
/// preview draws nothing at all. Only [`SegmentFlagReason::TextClip`] is raised
/// from that second arm: it is the sole thing such a track puts on screen, so
/// flagging its media clips would invent a divergence that cannot happen.
///
/// The result is sorted and deduplicated, so a window carrying the same set of
/// problems always produces the same list regardless of track or clip order.
pub fn classify_segment_window(
    sequence: &Sequence,
    assets: &HashMap<String, Asset>,
    effects: &HashMap<String, Effect>,
    start_sec: f64,
    end_sec: f64,
) -> Vec<SegmentFlagReason> {
    let mut reasons = Vec::new();

    for track in &sequence.tracks {
        if track_affects_picture(track) {
            for clip in clips_in_range(track, start_sec, end_sec) {
                reasons.extend(clip_flag_reasons(clip, track, assets, effects));
            }
        } else if track_burns_text_only(track) {
            // Not `clip_flag_reasons`: nothing else on this track is drawn, so
            // no other property of these clips can make the preview wrong.
            for clip in clips_in_range(track, start_sec, end_sec) {
                if is_text_clip(clip) {
                    reasons.push(SegmentFlagReason::TextClip);
                }
            }
        }
    }

    reasons.sort();
    reasons.dedup();
    reasons
}

/// Refreshes the preview-fidelity flags on every segment of a manifest.
///
/// A segment's flags are classified in exactly one place, and this is it. Every
/// other manifest operation — creating segments, reconciling a duration change,
/// recovering from an interrupted render — carries the stored value through
/// untouched, exactly as it does for the fingerprint.
///
/// Each segment is classified over its own window widened by
/// [`transition_window_reach_sec`], the same widening
/// [`refresh_manifest_plan_fingerprints`] applies — a transition blending across
/// a segment boundary belongs to both of its neighbours, and flags that saw a
/// narrower window than the fingerprint did would disagree about which segments
/// contain it.
///
/// # Flags never demote a segment
///
/// A flag change leaves [`RenderCacheSegment::state`] alone. Flags say *what
/// should be filled automatically*; fingerprints say *whether what is already
/// filled is still valid*. Removing the last flag from a segment does not make
/// its cached file wrong, and adding one does not either — only a fingerprint
/// change can demote `Cached` to `Stale`.
///
/// Returns whether any segment's flag set changed. There is no failure mode:
/// classification builds no render plan and touches no disk.
pub fn refresh_manifest_segment_flags(
    manifest: &mut RenderCacheManifest,
    sequence: &Sequence,
    assets: &HashMap<String, Asset>,
    effects: &HashMap<String, Effect>,
) -> bool {
    // Measure the transition reach at the fps the segments are encoded at, for
    // the same reason `refresh_manifest_plan_fingerprints` does.
    let encode_fps = output_video_fps(
        sequence,
        &ExportSettings::preview_cache(PathBuf::new(), &sequence.format.canvas, None, None),
    );
    let reach_sec = transition_window_reach_sec(effects, encode_fps);

    let mut changed = false;
    for segment in &mut manifest.segments {
        let next = classify_segment_window(
            sequence,
            assets,
            effects,
            (segment.start_sec - reach_sec).max(0.0),
            segment.end_sec + reach_sec,
        );
        if next != segment.flag_reasons {
            segment.flag_reasons = next;
            changed = true;
        }
    }

    if changed {
        manifest.updated_at = chrono::Utc::now().to_rfc3339();
    }

    changed
}

// =============================================================================
// Cache Segment
// =============================================================================

/// A single cached timeline segment
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RenderCacheSegment {
    /// Segment index (0-based)
    pub index: u32,
    /// Start time in seconds
    pub start_sec: f64,
    /// End time in seconds
    pub end_sec: f64,
    /// Current segment state
    pub state: CacheSegmentState,
    /// Hash of the render plan (and profile) this segment was last planned for.
    ///
    /// [`SEGMENT_FINGERPRINT_UNSET`] until
    /// [`refresh_manifest_plan_fingerprints`] — its only writer — has run.
    pub fingerprint: SegmentFingerprint,
    /// Why the live preview cannot draw this segment; empty when it can.
    ///
    /// Classified only by [`refresh_manifest_segment_flags`]. Defaults to empty so
    /// a manifest written before flags existed still deserializes, and is
    /// omitted when empty so an unflagged manifest is unchanged on disk.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub flag_reasons: Vec<SegmentFlagReason>,
    /// Relative path to cached file (within the profile cache directory)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cached_file: Option<String>,
    /// File size in bytes (when cached)
    pub file_size_bytes: u64,
}

impl RenderCacheSegment {
    /// Creates a new empty, never-planned segment.
    pub fn new(index: u32, start_sec: f64, end_sec: f64) -> Self {
        Self {
            index,
            start_sec,
            end_sec,
            state: CacheSegmentState::Empty,
            fingerprint: SEGMENT_FINGERPRINT_UNSET,
            flag_reasons: Vec::new(),
            cached_file: None,
            file_size_bytes: 0,
        }
    }

    /// Duration of this segment in seconds
    pub fn duration_sec(&self) -> f64 {
        self.end_sec - self.start_sec
    }

    /// Whether this segment needs rendering (not cached or stale)
    pub fn needs_render(&self) -> bool {
        matches!(
            self.state,
            CacheSegmentState::Empty | CacheSegmentState::Stale | CacheSegmentState::Error
        )
    }

    /// Whether the live preview cannot draw this segment faithfully.
    ///
    /// A flagged segment is one the cache should fill automatically; it says
    /// nothing about whether the segment is currently cached or stale.
    pub fn flagged(&self) -> bool {
        !self.flag_reasons.is_empty()
    }

    /// Whether this segment is valid for smart rendering copy
    pub fn is_valid_cache(&self) -> bool {
        self.state == CacheSegmentState::Cached && self.cached_file.is_some()
    }
}

// =============================================================================
// Cache Manifest
// =============================================================================

/// Render cache manifest for an entire sequence
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RenderCacheManifest {
    /// Sequence this cache belongs to
    pub sequence_id: SequenceId,
    /// Encode profile the segments were produced with.
    ///
    /// Segment files live in `renders/<sequenceId>/<profileHash>/`, and a
    /// manifest written for a different profile is discarded rather than
    /// reused — see [`manifest_for_profile`]. Defaults to the empty string so
    /// a manifest written before profile partitioning still deserializes; it
    /// then matches no profile and is discarded on first use.
    #[serde(default)]
    pub profile_hash: String,
    /// Segment duration used for splitting
    pub segment_duration_sec: f64,
    /// All cache segments
    pub segments: Vec<RenderCacheSegment>,
    /// Total cached size in bytes
    pub total_cached_bytes: u64,
    /// Timestamp of last update (ISO 8601)
    pub updated_at: String,
}

/// Outcome of reconciling a manifest with the current sequence state.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ManifestSyncResult {
    /// Whether the manifest contents changed and should be persisted.
    pub changed: bool,
    /// Cache files no longer referenced by the manifest.
    pub orphaned_files: Vec<String>,
}

/// How reconciliation treats segments stored in [`CacheSegmentState::Rendering`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InterruptedRenderPolicy {
    /// Treat `Rendering` as a crashed render: reset it to
    /// [`CacheSegmentState::Error`] and orphan whatever partial file it names.
    ///
    /// Only correct where the caller owns the manifest — i.e. when starting a
    /// render, which is also the only place allowed to persist the result.
    Reset,
    /// Leave `Rendering` as it is.
    ///
    /// Required by read-only callers such as the status projection: a
    /// background render legitimately owns that segment right now, and
    /// reporting it as failed would make the cache indicator flash red for
    /// every segment while it is being filled.
    Preserve,
}

impl RenderCacheManifest {
    /// Creates a new manifest with never-planned segments covering the given
    /// duration.
    ///
    /// Fingerprints stay [`SEGMENT_FINGERPRINT_UNSET`] until
    /// [`refresh_manifest_plan_fingerprints`] runs.
    pub fn new(
        sequence_id: &str,
        profile_hash: &str,
        duration_sec: f64,
        segment_duration_sec: f64,
    ) -> Self {
        let seg_dur = segment_duration_sec.max(MIN_SEGMENT_DURATION_SEC);
        let segments = generate_segments(duration_sec, seg_dur);

        Self {
            sequence_id: sequence_id.to_string(),
            profile_hash: profile_hash.to_string(),
            segment_duration_sec: seg_dur,
            segments,
            total_cached_bytes: 0,
            updated_at: chrono::Utc::now().to_rfc3339(),
        }
    }

    /// Whether this manifest's segments were produced with `profile_hash`.
    pub fn matches_profile(&self, profile_hash: &str) -> bool {
        !self.profile_hash.is_empty() && self.profile_hash == profile_hash
    }

    /// Number of segments that are fully cached
    pub fn cached_count(&self) -> usize {
        self.segments
            .iter()
            .filter(|s| s.state == CacheSegmentState::Cached)
            .count()
    }

    /// Number of segments that need rendering
    pub fn pending_count(&self) -> usize {
        self.segments.iter().filter(|s| s.needs_render()).count()
    }

    /// Cache completeness as a percentage (0.0 - 100.0)
    pub fn completion_percent(&self) -> f64 {
        if self.segments.is_empty() {
            return 0.0;
        }
        (self.cached_count() as f64 / self.segments.len() as f64) * 100.0
    }

    /// Reconciles segment layout and transient state with the current sequence.
    ///
    /// This keeps cache manifests valid across timeline-duration changes,
    /// segment-duration changes, and interrupted background renders.
    ///
    /// It deliberately does **not** decide validity. Segment identity lives in
    /// the plan fingerprint, which only [`refresh_manifest_plan_fingerprints`]
    /// writes; reconciliation carries the stored value across to the segment
    /// occupying the same range. Recomputing an identity here — as an earlier
    /// version did, from the timeline rather than the plan — invalidated every
    /// cached segment on every call, including the calls the status poll makes
    /// while a render is filling the cache.
    pub fn reconcile_with_sequence(
        &mut self,
        duration_sec: f64,
        segment_duration_sec: f64,
        interrupted: InterruptedRenderPolicy,
    ) -> ManifestSyncResult {
        let normalized_seg_dur = segment_duration_sec.max(MIN_SEGMENT_DURATION_SEC);
        let previous_segments = self.segments.clone();
        let previous_segment_duration = self.segment_duration_sec;
        let previous_total_cached_bytes = self.total_cached_bytes;
        let desired_segments = generate_segments(duration_sec.max(0.0), normalized_seg_dur);

        let mut previous_by_range: HashMap<(u64, u64), RenderCacheSegment> = previous_segments
            .iter()
            .cloned()
            .map(|segment| {
                (
                    segment_range_key(segment.start_sec, segment.end_sec),
                    segment,
                )
            })
            .collect();
        let mut next_segments = Vec::with_capacity(desired_segments.len());
        let mut orphaned_files: Vec<String> = Vec::new();

        for mut segment in desired_segments {
            if let Some(previous) =
                previous_by_range.remove(&segment_range_key(segment.start_sec, segment.end_sec))
            {
                // The stored plan fingerprint travels with the range it was
                // computed for. A segment whose range is new keeps
                // `SEGMENT_FINGERPRINT_UNSET` and is planned on the next refresh.
                segment.fingerprint = previous.fingerprint;
                // Flags travel with the range for the same reason: they were
                // classified over it. A new range starts unflagged and is
                // classified on the next refresh.
                segment.flag_reasons = previous.flag_reasons;

                match previous.state {
                    CacheSegmentState::Cached => {
                        // A "cached" segment with no file is not cached.
                        if let Some(cached_file) = previous.cached_file {
                            segment.state = CacheSegmentState::Cached;
                            segment.cached_file = Some(cached_file);
                            segment.file_size_bytes = previous.file_size_bytes;
                        }
                    }
                    CacheSegmentState::Stale => {
                        segment.state = CacheSegmentState::Stale;
                        segment.cached_file = previous.cached_file;
                        segment.file_size_bytes = previous.file_size_bytes;
                    }
                    CacheSegmentState::Rendering => match interrupted {
                        InterruptedRenderPolicy::Reset => {
                            segment.state = CacheSegmentState::Error;
                            if let Some(cached_file) = previous.cached_file {
                                orphaned_files.push(cached_file);
                            }
                        }
                        InterruptedRenderPolicy::Preserve => {
                            segment.state = CacheSegmentState::Rendering;
                            segment.cached_file = previous.cached_file;
                            segment.file_size_bytes = previous.file_size_bytes;
                        }
                    },
                    CacheSegmentState::Error => {
                        segment.state = CacheSegmentState::Error;
                        if let Some(cached_file) = previous.cached_file {
                            orphaned_files.push(cached_file);
                        }
                    }
                    CacheSegmentState::Empty => {}
                }
            }

            next_segments.push(segment);
        }

        for remaining in previous_by_range.into_values() {
            if let Some(cached_file) = remaining.cached_file {
                orphaned_files.push(cached_file);
            }
        }

        orphaned_files.sort();
        orphaned_files.dedup();

        self.segment_duration_sec = normalized_seg_dur;
        self.segments = next_segments;
        self.recalculate_total_size();

        let changed = previous_segment_duration.to_bits() != normalized_seg_dur.to_bits()
            || previous_total_cached_bytes != self.total_cached_bytes
            || previous_segments != self.segments
            || !orphaned_files.is_empty();

        if changed {
            self.updated_at = chrono::Utc::now().to_rfc3339();
        }

        ManifestSyncResult {
            changed,
            orphaned_files,
        }
    }

    /// Marks a segment as cached after successful rendering
    pub fn mark_segment_cached(
        &mut self,
        index: u32,
        cached_file: String,
        file_size_bytes: u64,
    ) -> bool {
        if let Some(segment) = self.segments.iter_mut().find(|s| s.index == index) {
            segment.state = CacheSegmentState::Cached;
            segment.cached_file = Some(cached_file);
            segment.file_size_bytes = file_size_bytes;
            self.recalculate_total_size();
            self.updated_at = chrono::Utc::now().to_rfc3339();
            true
        } else {
            false
        }
    }

    /// Clears all cached data (marks all segments as empty)
    pub fn clear(&mut self) {
        for segment in &mut self.segments {
            segment.state = CacheSegmentState::Empty;
            segment.cached_file = None;
            segment.file_size_bytes = 0;
        }
        self.total_cached_bytes = 0;
        self.updated_at = chrono::Utc::now().to_rfc3339();
    }

    /// Recalculates total cached size from segments
    fn recalculate_total_size(&mut self) {
        self.total_cached_bytes = self
            .segments
            .iter()
            .filter(|s| s.state == CacheSegmentState::Cached)
            .map(|s| s.file_size_bytes)
            .sum();
    }
}

/// Generates never-planned cache segments for the given timeline duration.
///
/// Layout only: fingerprints are the business of
/// [`refresh_manifest_plan_fingerprints`].
fn generate_segments(duration_sec: f64, segment_duration_sec: f64) -> Vec<RenderCacheSegment> {
    if duration_sec <= 0.0 {
        return Vec::new();
    }

    let count = (duration_sec / segment_duration_sec).ceil() as u32;
    let mut segments = Vec::with_capacity(count as usize);

    for i in 0..count {
        let start = i as f64 * segment_duration_sec;
        let end = (start + segment_duration_sec).min(duration_sec);

        // Skip tiny trailing segments
        if end - start < MIN_SEGMENT_DURATION_SEC && i > 0 {
            // Extend the previous segment instead
            if let Some(prev) = segments.last_mut() {
                let prev_seg: &mut RenderCacheSegment = prev;
                prev_seg.end_sec = end;
            }
            break;
        }

        segments.push(RenderCacheSegment::new(i, start, end));
    }

    segments
}

fn segment_range_key(start_sec: f64, end_sec: f64) -> (u64, u64) {
    (start_sec.to_bits(), end_sec.to_bits())
}

// =============================================================================
// Cache Configuration
// =============================================================================

/// Configuration for the render cache system
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderCacheConfig {
    /// Maximum cache size in bytes
    pub max_cache_bytes: u64,
    /// Segment duration in seconds
    pub segment_duration_sec: f64,
    /// Whether render cache is enabled
    pub enabled: bool,
    /// Whether smart rendering is enabled for export
    pub smart_render_enabled: bool,
}

impl Default for RenderCacheConfig {
    fn default() -> Self {
        Self {
            max_cache_bytes: 8 * 1024 * 1024 * 1024, // 8 GB (lossless cache is ~45x larger than the old H.264 one)
            segment_duration_sec: DEFAULT_SEGMENT_DURATION_SEC,
            enabled: true,
            smart_render_enabled: true,
        }
    }
}

impl RenderCacheConfig {
    /// Creates config from performance settings cache_size_mb
    pub fn from_cache_size_mb(cache_size_mb: u32) -> Self {
        Self {
            max_cache_bytes: cache_size_mb as u64 * 1024 * 1024,
            ..Default::default()
        }
    }
}

// =============================================================================
// Cache Status DTO (for IPC)
// =============================================================================

/// Cache status information returned to the frontend
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RenderCacheStatus {
    /// Whether render cache is enabled
    pub enabled: bool,
    /// Sequence ID this status is for
    pub sequence_id: SequenceId,
    /// Total number of segments
    pub total_segments: u32,
    /// Number of fully cached segments
    pub cached_segments: u32,
    /// Number of stale segments needing re-render
    pub stale_segments: u32,
    /// Number of segments currently rendering
    pub rendering_segments: u32,
    /// Completion percentage (0.0 - 100.0)
    pub completion_percent: f64,
    /// Total cached file size in bytes
    pub total_cached_bytes: u64,
    /// Maximum allowed cache size in bytes
    pub max_cache_bytes: u64,
    /// Per-segment status for timeline indicator
    pub segment_states: Vec<CacheSegmentStatusDto>,
}

/// Per-segment info for the timeline cache indicator bar and for a cache-first
/// preview: which segment file backs a time, and whether it is still current.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CacheSegmentStatusDto {
    /// Segment index (0-based), so a caller can address the segment covering a time
    pub index: u32,
    /// Start time in seconds
    pub start_sec: f64,
    /// End time in seconds
    pub end_sec: f64,
    /// Segment state
    pub state: CacheSegmentState,
    /// The segment's render+content fingerprint, as a decimal string.
    ///
    /// A `u64` loses precision crossing JSON, so it is carried as text. A
    /// cache-first preview keys its frame cache on this: when the fingerprint
    /// changes, the picture the segment holds is stale and must not be reused.
    pub fingerprint: String,
    /// Absolute path to the cached segment file — `Some` only when the segment is
    /// [`Cached`](CacheSegmentState::Cached) and its manifest-named file resolves
    /// through the segment-name allowlist, `None` otherwise.
    ///
    /// The manifest lives inside the project directory and is therefore
    /// attacker-controlled, so the path is produced by
    /// [`resolve_cached_segment_path`] rather than by joining the raw name.
    pub cached_path: Option<String>,
    /// Whether the live preview cannot draw this segment faithfully.
    ///
    /// Independent of `state`: a flagged segment may already be cached, and an
    /// unflagged one may be empty. Flags say what the cache should fill for the
    /// picture to be trustworthy; `state` and `fingerprint` say what it holds.
    pub flagged: bool,
    /// Why, in a stable order; empty when `flagged` is false.
    pub flag_reasons: Vec<SegmentFlagReason>,
}

impl RenderCacheStatus {
    /// Builds a status DTO from a manifest and config.
    ///
    /// `project_dir` is needed to resolve each cached segment's file path safely
    /// (through the segment-name allowlist), so a cache-first preview can decode
    /// the segment that backs a time without trusting the manifest's raw name.
    pub fn from_manifest(
        manifest: &RenderCacheManifest,
        config: &RenderCacheConfig,
        project_dir: &Path,
    ) -> Self {
        let total = manifest.segments.len() as u32;
        let cached = manifest
            .segments
            .iter()
            .filter(|s| s.state == CacheSegmentState::Cached)
            .count() as u32;
        let stale = manifest
            .segments
            .iter()
            .filter(|s| s.state == CacheSegmentState::Stale)
            .count() as u32;
        let rendering = manifest
            .segments
            .iter()
            .filter(|s| s.state == CacheSegmentState::Rendering)
            .count() as u32;

        // Resolve the profile directory once; a bad sequence id or profile hash
        // simply leaves every path `None` rather than failing the whole status.
        let profile_dir =
            profile_cache_dir(project_dir, &manifest.sequence_id, &manifest.profile_hash).ok();

        let segment_states = manifest
            .segments
            .iter()
            .map(|s| {
                // A path is offered only for a segment that actually has a current
                // file on disk, and only when the name clears the allowlist.
                let cached_path = if s.state == CacheSegmentState::Cached {
                    profile_dir
                        .as_ref()
                        .zip(s.cached_file.as_ref())
                        .and_then(|(dir, file)| resolve_cached_segment_path(dir, file))
                        .map(|path| path.to_string_lossy().to_string())
                } else {
                    None
                };
                CacheSegmentStatusDto {
                    index: s.index,
                    start_sec: s.start_sec,
                    end_sec: s.end_sec,
                    state: s.state.clone(),
                    fingerprint: s.fingerprint.to_string(),
                    cached_path,
                    flagged: s.flagged(),
                    flag_reasons: s.flag_reasons.clone(),
                }
            })
            .collect();

        Self {
            enabled: config.enabled,
            sequence_id: manifest.sequence_id.clone(),
            total_segments: total,
            cached_segments: cached,
            stale_segments: stale,
            rendering_segments: rendering,
            completion_percent: manifest.completion_percent(),
            total_cached_bytes: manifest.total_cached_bytes,
            max_cache_bytes: config.max_cache_bytes,
            segment_states,
        }
    }

    /// Creates an empty status when no manifest exists
    pub fn empty(sequence_id: &str, config: &RenderCacheConfig) -> Self {
        Self {
            enabled: config.enabled,
            sequence_id: sequence_id.to_string(),
            total_segments: 0,
            cached_segments: 0,
            stale_segments: 0,
            rendering_segments: 0,
            completion_percent: 0.0,
            total_cached_bytes: 0,
            max_cache_bytes: config.max_cache_bytes,
            segment_states: Vec::new(),
        }
    }
}

// =============================================================================
// Cache Directory Helpers
// =============================================================================

/// Returns the render cache directory for a project
pub fn render_cache_dir(project_dir: &Path) -> PathBuf {
    project_dir
        .join(".openreelio")
        .join("cache")
        .join("renders")
}

/// Returns the cache directory for a specific sequence.
///
/// # Security
/// `sequence_id` reaches this function from the project file and from IPC arguments,
/// neither of which is trusted, and the directory it names is passed to
/// `remove_dir_all` by [`clear_sequence_cache`] without the id ever being looked up in
/// `project.state.sequences`. Validation lives here, at the single choke point every
/// cache path helper funnels through, so no caller can construct an unvalidated one.
pub fn sequence_cache_dir(project_dir: &Path, sequence_id: &str) -> Result<PathBuf, String> {
    validate_path_id_component(sequence_id, "sequenceId")?;
    Ok(render_cache_dir(project_dir).join(sequence_id))
}

/// Returns the cache directory holding one sequence's segments for one encode
/// profile.
///
/// # Security
/// `profile_hash` is written into the manifest and read back from it, so it is
/// no more trusted than `sequence_id`. It is validated here — the single choke
/// point for profile-scoped paths — against the exact shape
/// [`compute_profile_hash`] emits; see [`is_profile_hash`].
pub fn profile_cache_dir(
    project_dir: &Path,
    sequence_id: &str,
    profile_hash: &str,
) -> Result<PathBuf, String> {
    let sequence_dir = sequence_cache_dir(project_dir, sequence_id)?;
    if !is_profile_hash(profile_hash) {
        return Err(format!(
            "Invalid render profile hash: {profile_hash:?} (expected {PROFILE_HASH_LEN} hex digits)"
        ));
    }
    Ok(sequence_dir.join(profile_hash))
}

/// Returns the manifest file path for a sequence.
///
/// The manifest sits above the per-profile segment directories: it records
/// which profile its segments belong to, so exactly one profile's segments are
/// ever referenced.
pub fn manifest_path(project_dir: &Path, sequence_id: &str) -> Result<PathBuf, String> {
    Ok(sequence_cache_dir(project_dir, sequence_id)?.join(CACHE_MANIFEST_FILENAME))
}

/// Returns the cache file path for a segment of a given encode profile.
pub fn segment_cache_file(
    project_dir: &Path,
    sequence_id: &str,
    profile_hash: &str,
    index: u32,
) -> Result<PathBuf, String> {
    Ok(profile_cache_dir(project_dir, sequence_id, profile_hash)?
        .join(segment_cache_file_name(index)))
}

/// Extension segments are written with today.
///
/// The preview cache encodes Ut Video, which MP4 cannot carry; see
/// [`ExportSettings::preview_cache`].
const SEGMENT_FILE_EXTENSION: &str = "mov";

/// Extensions a segment file may have been written with by *some* build.
///
/// Only [`SEGMENT_FILE_EXTENSION`] is ever emitted. `mp4` is the extension the
/// H.264 preview-cache profile used, and it stays recognized so segments an
/// older build left on disk are still deletable by
/// [`prune_other_profile_caches`] and the eviction path — a name we refuse to
/// recognize is a file we can never clean up.
const RECOGNIZED_SEGMENT_FILE_EXTENSIONS: [&str; 2] = [SEGMENT_FILE_EXTENSION, "mp4"];

/// Builds the on-disk name for a cached segment.
///
/// This is the sole writer of the naming scheme; [`is_cached_segment_name`] mirrors it.
fn segment_cache_file_name(index: u32) -> String {
    format!("segment_{index:04}.{SEGMENT_FILE_EXTENSION}")
}

/// Reports whether `name` is a file name this module could have produced.
///
/// Accepts every extension in [`RECOGNIZED_SEGMENT_FILE_EXTENSIONS`], not just
/// the one the writer emits today, because this predicate also gates *deletion*
/// of files older builds wrote.
///
/// # Security
/// `RenderCacheSegment::cached_file` is deserialized from `manifest.json` inside the
/// project directory, so it is attacker-controlled whenever the project is. It is then
/// joined onto the sequence cache directory and handed to `remove_file` or `fs::copy`.
/// A value such as `../../../snapshot.json` would escape the cache directory entirely.
/// Rather than blocklisting traversal, this allowlists exactly what
/// [`segment_cache_file_name`] emits (modulo the legacy extensions above): a name that
/// does not round-trip through the writer's own formatting was not written by us and is
/// never touched.
pub fn is_cached_segment_name(name: &str) -> bool {
    RECOGNIZED_SEGMENT_FILE_EXTENSIONS
        .iter()
        .any(|extension| segment_name_matches_extension(name, extension))
}

/// Round-trips `name` through the writer's formatting with `extension` substituted.
fn segment_name_matches_extension(name: &str, extension: &str) -> bool {
    let Some(digits) = name
        .strip_prefix("segment_")
        .and_then(|rest| rest.strip_suffix(&format!(".{extension}")))
    else {
        return false;
    };
    if !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return false;
    }
    digits
        .parse::<u32>()
        .is_ok_and(|index| format!("segment_{index:04}.{extension}") == name)
}

/// Resolves a manifest-recorded segment file name to a path inside
/// `profile_cache_dir`, the directory returned by [`profile_cache_dir`].
///
/// Returns `None` when the recorded name is not one this module writes; see
/// [`is_cached_segment_name`]. Every consumer of `cached_file` must go through here
/// before touching the filesystem.
pub fn resolve_cached_segment_path(profile_cache_dir: &Path, cached_file: &str) -> Option<PathBuf> {
    if !is_cached_segment_name(cached_file) {
        tracing::warn!(
            "Ignoring render cache entry with an unrecognized file name: {cached_file:?}"
        );
        return None;
    }
    Some(profile_cache_dir.join(cached_file))
}

/// Wraps a path-validation failure as an `io::Error` for the `io::Result` helpers.
fn invalid_input(message: String) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::InvalidInput, message)
}

// =============================================================================
// Manifest Persistence
// =============================================================================

/// Saves a cache manifest to disk (JSON)
pub fn save_manifest(project_dir: &Path, manifest: &RenderCacheManifest) -> std::io::Result<()> {
    let dir = sequence_cache_dir(project_dir, &manifest.sequence_id).map_err(invalid_input)?;
    std::fs::create_dir_all(&dir)?;

    let path = dir.join(CACHE_MANIFEST_FILENAME);
    let json = serde_json::to_string_pretty(manifest)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;

    // Atomic write: write to temp then rename
    let tmp_path = path.with_extension("json.tmp");
    std::fs::write(&tmp_path, json)?;
    std::fs::rename(&tmp_path, &path)?;

    Ok(())
}

/// Loads a cache manifest from disk. Returns None if not found.
pub fn load_manifest(
    project_dir: &Path,
    sequence_id: &str,
) -> std::io::Result<Option<RenderCacheManifest>> {
    let path = manifest_path(project_dir, sequence_id).map_err(invalid_input)?;
    if !path.exists() {
        return Ok(None);
    }

    let json = std::fs::read_to_string(&path)?;
    let manifest: RenderCacheManifest = serde_json::from_str(&json)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;

    Ok(Some(manifest))
}

/// The manifest to work with for one encode profile.
#[derive(Clone, Debug)]
pub struct ManifestForProfile {
    /// Either the stored manifest, or a fresh one when none applied.
    pub manifest: RenderCacheManifest,
    /// Profile hash of a stored manifest that was dropped because it belonged
    /// to another encode profile. Its segment files are still on disk;
    /// [`prune_other_profile_caches`] removes them.
    pub discarded_profile: Option<String>,
}

/// Loads the cache manifest for `profile_hash`, or builds a fresh one.
///
/// A stored manifest describing another profile's segments is discarded rather
/// than adopted: its segment files are in a different directory and were
/// encoded to different settings, so none of them can satisfy a request for
/// this profile.
///
/// Reads only — callers decide whether to persist or to clean up.
pub fn manifest_for_profile(
    project_dir: &Path,
    sequence_id: &str,
    profile_hash: &str,
    duration_sec: f64,
    segment_duration_sec: f64,
) -> std::io::Result<ManifestForProfile> {
    let stored = load_manifest(project_dir, sequence_id)?;

    match stored {
        Some(manifest) if manifest.matches_profile(profile_hash) => Ok(ManifestForProfile {
            manifest,
            discarded_profile: None,
        }),
        other => Ok(ManifestForProfile {
            manifest: RenderCacheManifest::new(
                sequence_id,
                profile_hash,
                duration_sec,
                segment_duration_sec,
            ),
            discarded_profile: other.map(|manifest| manifest.profile_hash),
        }),
    }
}

/// Removes every unreachable segment file of a sequence.
///
/// That is every profile cache directory except `keep_profile_hash`, plus any
/// segment file sitting directly in the sequence directory — where builds from
/// before profile partitioning wrote them. Only one profile's segments are
/// referenced by the manifest at a time, so everything else is unreachable
/// bytes that nothing will ever clean up otherwise.
///
/// Entries this module could not have written — the manifest, a directory that
/// is not a profile hash, a file that is not a segment — are left alone.
///
/// Returns the number of entries removed.
pub fn prune_other_profile_caches(
    project_dir: &Path,
    sequence_id: &str,
    keep_profile_hash: &str,
) -> std::io::Result<usize> {
    let sequence_dir = sequence_cache_dir(project_dir, sequence_id).map_err(invalid_input)?;
    let entries = match std::fs::read_dir(&sequence_dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(error) => return Err(error),
    };

    let mut removed = 0usize;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        let Ok(file_type) = entry.file_type() else {
            continue;
        };

        let outcome = if file_type.is_dir() {
            if name == keep_profile_hash || !is_profile_hash(name) {
                continue;
            }
            std::fs::remove_dir_all(entry.path())
        } else if is_cached_segment_name(name) {
            // A segment written before the cache was partitioned by profile. No
            // manifest can reference it any more.
            std::fs::remove_file(entry.path())
        } else {
            continue;
        };

        match outcome {
            Ok(()) => removed += 1,
            Err(error) => tracing::warn!(
                "Failed to remove unreachable render cache entry {}: {error}",
                entry.path().display()
            ),
        }
    }

    Ok(removed)
}

/// Reports cache status without touching the manifest on disk.
///
/// The status poll runs on every render-cache progress event. It therefore may
/// not persist anything: a persisted reconcile from this path is what let the
/// poll invalidate the very cache the renderer was filling. All work here
/// happens on a private copy that is dropped without saving — the on-disk
/// manifest the background render is filling is never rewritten, interrupted
/// renders are preserved rather than reset (see
/// [`InterruptedRenderPolicy::Preserve`]), and no orphaned file is removed.
///
/// Beyond layout reconciliation, the private copy is re-fingerprinted against
/// the current timeline so the indicator honestly demotes segments whose plan
/// or content changed (motion keyframes, blend mode, canvas reframe, …). Without
/// this the bar would show a changed timeline as still-cached until the user
/// manually triggered a render. Fingerprinting only mutates the in-memory copy;
/// [`refresh_manifest_plan_fingerprints`] performs no disk writes.
pub fn cache_status_snapshot(
    project_dir: &Path,
    sequence: &Sequence,
    profile_hash: &str,
    graph: &RenderGraph,
    assets: &HashMap<String, Asset>,
    effects: &HashMap<String, Effect>,
    config: &RenderCacheConfig,
) -> std::io::Result<RenderCacheStatus> {
    let duration_sec = sequence.duration();
    let mut view = manifest_for_profile(
        project_dir,
        &sequence.id,
        profile_hash,
        duration_sec,
        config.segment_duration_sec,
    )?
    .manifest;

    view.reconcile_with_sequence(
        duration_sec,
        config.segment_duration_sec,
        InterruptedRenderPolicy::Preserve,
    );

    // Re-fingerprint the private copy so staleness is reported honestly. A plan
    // that fails to validate (e.g. mid-edit into a transient invalid state) must
    // not fail the status poll, so the error is swallowed. The refresh mutates
    // segments in place and stops at the first invalid one, so `view` may be
    // partially refreshed — that is sound, because refresh only ever demotes
    // Cached to Stale, so a partial pass can over-report staleness but never
    // under-report it.
    if let Err(error) =
        refresh_manifest_plan_fingerprints(&mut view, project_dir, sequence, graph, assets, effects)
    {
        tracing::debug!(
            "Skipping status fingerprint refresh for sequence {}: {error}",
            sequence.id
        );
    }

    // Classify the same private copy, so the status always reports flags for the
    // timeline as it stands now. Like the fingerprint refresh this is in-memory
    // only; unlike it, it cannot fail, so it runs unconditionally.
    refresh_manifest_segment_flags(&mut view, sequence, assets, effects);

    Ok(RenderCacheStatus::from_manifest(&view, config, project_dir))
}

// =============================================================================
// Cache Cleanup
// =============================================================================

/// Removes all stale cache files for a manifest.
/// Returns the total bytes freed.
pub fn cleanup_stale_files(project_dir: &Path, manifest: &mut RenderCacheManifest) -> u64 {
    let mut freed = 0u64;
    // Fail closed: an unusable sequence id or profile hash means no file here can be
    // identified, so remove nothing rather than guessing at a path.
    let seq_dir =
        match profile_cache_dir(project_dir, &manifest.sequence_id, &manifest.profile_hash) {
            Ok(dir) => dir,
            Err(error) => {
                tracing::warn!("Skipping render cache cleanup: {error}");
                return 0;
            }
        };

    for segment in &mut manifest.segments {
        if segment.state == CacheSegmentState::Stale {
            if let Some(ref file) = segment.cached_file {
                let resolved = resolve_cached_segment_path(&seq_dir, file);
                let Some(full_path) = resolved else {
                    // The manifest names a file we never wrote. Drop the entry instead
                    // of deleting whatever it points at.
                    segment.cached_file = None;
                    segment.file_size_bytes = 0;
                    segment.state = CacheSegmentState::Empty;
                    continue;
                };
                if full_path.exists() {
                    match std::fs::remove_file(&full_path) {
                        Ok(()) => {
                            freed += segment.file_size_bytes;
                            segment.cached_file = None;
                            segment.file_size_bytes = 0;
                            segment.state = CacheSegmentState::Empty;
                        }
                        Err(e) => {
                            tracing::warn!(
                                "Failed to remove stale cache file {}: {e}",
                                full_path.display()
                            );
                            // Leave segment untouched so size tracking stays accurate
                        }
                    }
                } else {
                    // File already gone — reset segment
                    segment.cached_file = None;
                    segment.file_size_bytes = 0;
                    segment.state = CacheSegmentState::Empty;
                }
            } else {
                segment.state = CacheSegmentState::Empty;
            }
        }
    }

    if freed > 0 {
        manifest.recalculate_total_size();
        manifest.updated_at = chrono::Utc::now().to_rfc3339();
    }

    freed
}

/// Removes the entire cache directory for a sequence.
pub fn clear_sequence_cache(project_dir: &Path, sequence_id: &str) -> std::io::Result<()> {
    let dir = sequence_cache_dir(project_dir, sequence_id).map_err(invalid_input)?;
    if dir.exists() {
        std::fs::remove_dir_all(&dir)?;
    }
    Ok(())
}

/// Enforces cache size limit by evicting the oldest cached segments (LRU by index).
/// Returns the number of segments evicted.
///
/// `protected` names segments an in-flight fill is currently producing; they are
/// never evicted. Without that, a fill and the size cap deadlock each other: the
/// cap evicts highest-index-first, a fill renders low-to-high, and once the
/// resident set is smaller than the fill's own window the highest cached segment
/// is always the one the fill just wrote. Every segment would be deleted the
/// moment it landed and re-requested on the next pass, forever. Callers with no
/// fill in flight pass an empty set.
///
/// This is a guard, not the eviction policy: choosing victims by distance from
/// the playhead instead of by index is a separate change.
pub fn enforce_cache_limit(
    project_dir: &Path,
    manifest: &mut RenderCacheManifest,
    max_bytes: u64,
    protected: &HashSet<u32>,
) -> usize {
    if manifest.total_cached_bytes <= max_bytes {
        return 0;
    }

    // Fail closed, as in `cleanup_stale_files`.
    let seq_dir =
        match profile_cache_dir(project_dir, &manifest.sequence_id, &manifest.profile_hash) {
            Ok(dir) => dir,
            Err(error) => {
                tracing::warn!("Skipping render cache eviction: {error}");
                return 0;
            }
        };
    let mut evicted = 0;

    // Evict from the end (highest index) first — user is more likely to play from the start
    let indices: Vec<u32> = manifest
        .segments
        .iter()
        .filter(|s| s.state == CacheSegmentState::Cached)
        .filter(|s| !protected.contains(&s.index))
        .map(|s| s.index)
        .rev()
        .collect();

    for idx in indices {
        if manifest.total_cached_bytes <= max_bytes {
            break;
        }

        if let Some(segment) = manifest.segments.iter_mut().find(|s| s.index == idx) {
            let mut file_removed = false;
            if let Some(ref file) = segment.cached_file {
                match resolve_cached_segment_path(&seq_dir, file) {
                    Some(full_path) => match std::fs::remove_file(&full_path) {
                        Ok(()) => file_removed = true,
                        Err(e) => {
                            tracing::warn!(
                                "Failed to evict cache file {}: {e}",
                                full_path.display()
                            );
                        }
                    },
                    // Unrecognized name: nothing of ours to remove, so drop the entry
                    // and let the accounting below reclaim its recorded size.
                    None => file_removed = true,
                }
            } else {
                file_removed = true; // No file to remove
            }

            if file_removed {
                // Subtract this segment's size from the running total instead of
                // recalculating across all segments (avoids O(n*m) cost).
                manifest.total_cached_bytes = manifest
                    .total_cached_bytes
                    .saturating_sub(segment.file_size_bytes);
                segment.state = CacheSegmentState::Empty;
                segment.cached_file = None;
                segment.file_size_bytes = 0;
                evicted += 1;
            }
        }
    }

    if evicted > 0 {
        manifest.updated_at = chrono::Utc::now().to_rfc3339();
    }

    evicted
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::assets::{Asset, VideoInfo};
    use crate::core::effects::{EffectType, ParamValue};
    use crate::core::project::ProjectState;
    use crate::core::render::{build_render_graph, VideoCodec};
    use crate::core::timeline::{
        AudioSettings, BlendMode, Canvas, Clip, ClipPlace, ClipRange, KeyframeInterpolation,
        Sequence, SequenceFormat, Track, TrackKind, Transform, TransformKeyframe,
    };
    use crate::core::types::Ratio;

    // -----------------------------------------------------------------------
    // Test Helpers
    // -----------------------------------------------------------------------

    /// The canvas every fixture sequence in this module uses (see
    /// [`make_test_sequence`]). The preview-cache profile is canvas-dependent,
    /// so tests must hash against the same canvas their sequences render at.
    fn test_canvas() -> Canvas {
        Canvas::new(1920, 1080)
    }

    fn make_test_clip(id: &str, asset_id: &str, start: f64, duration: f64) -> Clip {
        Clip {
            id: id.to_string(),
            asset_id: asset_id.to_string(),
            range: ClipRange {
                source_in_sec: 0.0,
                source_out_sec: duration,
            },
            place: ClipPlace {
                timeline_in_sec: start,
                duration_sec: duration,
            },
            transform: Transform::default(),
            motion_keyframes: Vec::new(),
            opacity: 1.0,
            blend_mode: BlendMode::Normal,
            speed: 1.0,
            reverse: false,
            freeze_frame: false,
            time_remap: None,
            slow_motion_interpolation: crate::core::timeline::SlowMotionInterpolation::Nearest,
            effects: vec![],
            audio: AudioSettings::default(),
            label: None,
            color: None,
            caption_style: None,
            caption_position: None,
            enabled: true,
            link_group_id: None,
            group_id: None,
            compound_sequence_id: None,
            is_adjustment_layer: false,
        }
    }

    fn make_test_track(id: &str, kind: TrackKind, clips: Vec<Clip>) -> Track {
        Track {
            id: id.to_string(),
            kind,
            name: format!("Track {id}"),
            clips,
            blend_mode: BlendMode::Normal,
            is_base_track: None,
            muted: false,
            locked: false,
            visible: true,
            sync_lock: false,
            volume: 1.0,
            caption_language: None,
        }
    }

    fn make_test_sequence(id: &str, tracks: Vec<Track>) -> Sequence {
        Sequence {
            id: id.to_string(),
            name: format!("Seq {id}"),
            format: SequenceFormat {
                canvas: Canvas {
                    width: 1920,
                    height: 1080,
                },
                fps: Ratio::new(30, 1),
                audio_sample_rate: 48000,
                audio_channels: 2,
            },
            tracks,
            markers: vec![],
            master_volume_db: 0.0,
            hdr_settings: Default::default(),
            created_at: "2026-01-01T00:00:00Z".to_string(),
            modified_at: "2026-01-01T00:00:00Z".to_string(),
        }
    }

    fn make_test_effect(id: &str, effect_type: EffectType) -> Effect {
        let mut effect = Effect::new(effect_type);
        effect.id = id.to_string();
        effect
    }

    fn make_video_asset(id: &str) -> Asset {
        let name = format!("{id}.mp4");
        let uri = format!("/tmp/{id}.mp4");
        let mut asset = Asset::new_video(&name, &uri, VideoInfo::default());
        asset.id = id.to_string();
        asset.hash = format!("hash-{id}");
        asset
    }

    /// Builds the render graph for a sequence, the way the IPC layer does.
    fn build_graph(sequence: &Sequence) -> RenderGraph {
        let mut state = ProjectState::new("Cache Test");
        state.sequences.clear();
        state
            .sequences
            .insert(sequence.id.clone(), sequence.clone());
        state.active_sequence_id = Some(sequence.id.clone());
        build_render_graph(&state, &sequence.id).expect("render graph")
    }

    /// A four-clip, 20-second sequence: one clip per 5-second cache segment.
    fn four_segment_sequence() -> (Sequence, HashMap<String, Asset>) {
        let clips = vec![
            make_test_clip("c0", "a0", 0.0, 5.0),
            make_test_clip("c1", "a1", 5.0, 5.0),
            make_test_clip("c2", "a2", 10.0, 5.0),
            make_test_clip("c3", "a3", 15.0, 5.0),
        ];
        let assets = (0..4)
            .map(|i| (format!("a{i}"), make_video_asset(&format!("a{i}"))))
            .collect();
        let track = make_test_track("t1", TrackKind::Video, clips);
        (make_test_sequence("seq1", vec![track]), assets)
    }

    /// A two-clip, 10-second `seq1` — the 0..10s prefix of
    /// [`four_segment_sequence`], sharing its assets so overlapping segment
    /// windows fingerprint identically across the two.
    fn two_segment_sequence() -> (Sequence, HashMap<String, Asset>) {
        let clips = vec![
            make_test_clip("c0", "a0", 0.0, 5.0),
            make_test_clip("c1", "a1", 5.0, 5.0),
        ];
        let assets = (0..4)
            .map(|i| (format!("a{i}"), make_video_asset(&format!("a{i}"))))
            .collect();
        let track = make_test_track("t1", TrackKind::Video, clips);
        (make_test_sequence("seq1", vec![track]), assets)
    }

    /// Full render-command bootstrap: layout reconcile, then plan fingerprints.
    fn prepare_manifest(
        project_dir: &Path,
        sequence: &Sequence,
        assets: &HashMap<String, Asset>,
        effects: &HashMap<String, Effect>,
        duration_sec: f64,
    ) -> RenderCacheManifest {
        let mut manifest = RenderCacheManifest::new(
            &sequence.id,
            &preview_profile_hash(&test_canvas()),
            duration_sec,
            5.0,
        );
        manifest.reconcile_with_sequence(duration_sec, 5.0, InterruptedRenderPolicy::Reset);
        refresh(&mut manifest, project_dir, sequence, assets, effects);
        manifest
    }

    /// Re-fingerprints a manifest against a (possibly edited) sequence.
    fn refresh(
        manifest: &mut RenderCacheManifest,
        project_dir: &Path,
        sequence: &Sequence,
        assets: &HashMap<String, Asset>,
        effects: &HashMap<String, Effect>,
    ) -> bool {
        refresh_manifest_plan_fingerprints(
            manifest,
            project_dir,
            sequence,
            &build_graph(sequence),
            assets,
            effects,
        )
        .expect("plan fingerprints")
    }

    /// The plan hash for one segment window — what a plan-hash-only fingerprint
    /// would have seen.
    fn window_plan_hash(
        sequence: &Sequence,
        assets: &HashMap<String, Asset>,
        effects: &HashMap<String, Effect>,
        start_sec: f64,
        end_sec: f64,
    ) -> String {
        let settings = ExportSettings::preview_cache(
            PathBuf::from("probe.mp4"),
            &sequence.format.canvas,
            Some(start_sec),
            Some(end_sec),
        );
        build_render_plan(&build_graph(sequence), assets, effects, &settings).plan_hash
    }

    /// Asserts that an edit is invisible to the render plan, then that the cache
    /// invalidates the segments in `expected_stale` anyway. Every one of these
    /// cases passed a plan-hash-only fingerprint as still-Cached.
    fn assert_invalidated_although_the_plan_cannot_see_it(
        edit: impl Fn(&mut Sequence),
        expected_stale: &[usize],
    ) {
        let tmp = tempfile::tempdir().unwrap();
        let (sequence, assets) = four_segment_sequence();
        let effects = HashMap::new();
        let mut manifest = prepare_manifest(tmp.path(), &sequence, &assets, &effects, 20.0);
        cache_every_segment(&mut manifest);

        let mut edited = sequence.clone();
        edit(&mut edited);

        for segment in &manifest.segments {
            assert_eq!(
                window_plan_hash(
                    &sequence,
                    &assets,
                    &effects,
                    segment.start_sec,
                    segment.end_sec
                ),
                window_plan_hash(
                    &edited,
                    &assets,
                    &effects,
                    segment.start_sec,
                    segment.end_sec
                ),
                "segment {} render plan changed, so this edit does not exercise the \
                 content-hash supplement",
                segment.index
            );
        }

        assert!(refresh(
            &mut manifest,
            tmp.path(),
            &edited,
            &assets,
            &effects
        ));

        for (index, state) in states(&manifest).iter().enumerate() {
            let expected = if expected_stale.contains(&index) {
                CacheSegmentState::Stale
            } else {
                CacheSegmentState::Cached
            };
            assert_eq!(state, &expected, "segment {index}");
        }
    }

    fn cache_every_segment(manifest: &mut RenderCacheManifest) {
        let indices: Vec<u32> = manifest.segments.iter().map(|s| s.index).collect();
        for index in indices {
            manifest.mark_segment_cached(index, format!("segment_{index:04}.mp4"), 1024);
        }
    }

    fn states(manifest: &RenderCacheManifest) -> Vec<CacheSegmentState> {
        manifest.segments.iter().map(|s| s.state.clone()).collect()
    }

    // -----------------------------------------------------------------------
    // Segment layout
    // -----------------------------------------------------------------------

    #[test]
    fn should_create_correct_number_of_segments_for_30_second_timeline() {
        // Given a 30-second timeline
        // When creating a manifest with 5-second segments
        let manifest =
            RenderCacheManifest::new("seq1", &preview_profile_hash(&test_canvas()), 30.0, 5.0);

        // Then there should be 6 segments, each 5 seconds
        assert_eq!(manifest.segments.len(), 6);
        assert_eq!(manifest.segments[0].start_sec, 0.0);
        assert_eq!(manifest.segments[0].end_sec, 5.0);
        assert_eq!(manifest.segments[5].start_sec, 25.0);
        assert_eq!(manifest.segments[5].end_sec, 30.0);
    }

    #[test]
    fn should_create_segments_without_a_fingerprint_until_they_are_planned() {
        // Given a fresh manifest
        let manifest =
            RenderCacheManifest::new("seq1", &preview_profile_hash(&test_canvas()), 10.0, 5.0);

        // Then no segment claims an identity it has not been planned for
        assert!(manifest
            .segments
            .iter()
            .all(|s| s.fingerprint == SEGMENT_FINGERPRINT_UNSET));
        assert!(manifest
            .segments
            .iter()
            .all(|s| s.state == CacheSegmentState::Empty));
    }

    #[test]
    fn should_merge_tiny_trailing_segment_into_previous() {
        // Given a 12.3-second timeline with 5-second segments
        // When generating segments (12.3 / 5.0 = 2 full + 2.3 remainder)
        let manifest =
            RenderCacheManifest::new("seq1", &preview_profile_hash(&test_canvas()), 12.3, 5.0);

        // Then the last segment should cover the remainder (not a tiny fragment)
        assert_eq!(manifest.segments.len(), 3);
        assert_eq!(manifest.segments[2].start_sec, 10.0);
        assert!((manifest.segments[2].end_sec - 12.3).abs() < 0.001);
    }

    #[test]
    fn should_produce_zero_segments_for_empty_timeline() {
        // Given a sequence with zero duration
        // When creating a manifest
        let manifest =
            RenderCacheManifest::new("seq1", &preview_profile_hash(&test_canvas()), 0.0, 5.0);

        // Then there should be no segments
        assert!(manifest.segments.is_empty());
        assert_eq!(manifest.completion_percent(), 0.0);
    }

    // -----------------------------------------------------------------------
    // Plan fingerprints — the single identity scheme
    // -----------------------------------------------------------------------

    #[test]
    fn should_refresh_cache_fingerprints_from_render_plan_hashes() {
        // Given a planned, cached manifest
        let tmp = tempfile::tempdir().unwrap();
        let clip = make_test_clip("c1", "a1", 0.0, 5.0);
        let track = make_test_track("t1", TrackKind::Video, vec![clip]);
        let seq = make_test_sequence("seq1", vec![track]);
        let effects = HashMap::new();
        let mut assets = HashMap::from([("a1".to_string(), make_video_asset("a1"))]);
        let mut manifest = prepare_manifest(tmp.path(), &seq, &assets, &effects, 5.0);
        manifest.segments[0].state = CacheSegmentState::Cached;
        let original_fingerprint = manifest.segments[0].fingerprint;
        assert_ne!(original_fingerprint, SEGMENT_FINGERPRINT_UNSET);

        // When a render input the plan covers changes
        assets.get_mut("a1").unwrap().hash = "changed-asset-hash".to_string();
        let changed = refresh(&mut manifest, tmp.path(), &seq, &assets, &effects);

        // Then the segment is invalidated
        assert!(changed);
        assert_eq!(manifest.segments[0].state, CacheSegmentState::Stale);
        assert_ne!(manifest.segments[0].fingerprint, original_fingerprint);
    }

    #[test]
    fn should_keep_segments_cached_when_the_manifest_is_reconciled_again() {
        // Regression: `reconcile_with_sequence` used to recompute a *timeline*
        // fingerprint and compare it against the *plan* fingerprint written by
        // `refresh_manifest_plan_fingerprints`. The two schemes never agreed, so
        // every reconcile demoted every cached segment to Stale — and the status
        // poll, which reconciled on every progress event, invalidated the cache
        // the renderer was filling.

        // Given a planned, fully cached manifest
        let tmp = tempfile::tempdir().unwrap();
        let (seq, assets) = four_segment_sequence();
        let effects = HashMap::new();
        let mut manifest = prepare_manifest(tmp.path(), &seq, &assets, &effects, 20.0);
        cache_every_segment(&mut manifest);
        let fingerprints: Vec<u64> = manifest.segments.iter().map(|s| s.fingerprint).collect();

        // When the manifest is reconciled again with an unchanged sequence
        manifest.reconcile_with_sequence(20.0, 5.0, InterruptedRenderPolicy::Reset);

        // Then nothing is invalidated and the stored plan fingerprints survive
        assert_eq!(states(&manifest), vec![CacheSegmentState::Cached; 4]);
        assert_eq!(
            manifest
                .segments
                .iter()
                .map(|s| s.fingerprint)
                .collect::<Vec<_>>(),
            fingerprints
        );

        // And a second refresh over the same inputs reports no change either
        assert!(!refresh(&mut manifest, tmp.path(), &seq, &assets, &effects));
        assert_eq!(states(&manifest), vec![CacheSegmentState::Cached; 4]);
    }

    #[test]
    fn should_only_invalidate_segments_whose_window_covers_an_edit() {
        // Given a planned, fully cached 20-second manifest of four clips
        let tmp = tempfile::tempdir().unwrap();
        let (seq, assets) = four_segment_sequence();
        let effects = HashMap::new();
        let mut manifest = prepare_manifest(tmp.path(), &seq, &assets, &effects, 20.0);
        cache_every_segment(&mut manifest);

        // When the clip playing at t=12 changes
        let mut edited = seq.clone();
        edited.tracks[0].clips[2].opacity = 0.5;

        let changed = refresh(&mut manifest, tmp.path(), &edited, &assets, &effects);

        // Then only the segment covering t=12 is invalidated
        assert!(changed);
        assert_eq!(
            states(&manifest),
            vec![
                CacheSegmentState::Cached,
                CacheSegmentState::Cached,
                CacheSegmentState::Stale,
                CacheSegmentState::Cached,
            ]
        );
    }

    #[test]
    fn should_invalidate_both_neighbours_of_a_transition_that_changes() {
        // A two-input transition at a segment boundary blends across it: the
        // outgoing clip reaches D/2 past the cut and the incoming clip starts
        // D/2 before it, so both neighbouring segments render differently when
        // the transition changes — even though the effect lives on one clip.

        // Given a 2-second cross dissolve on the clip that ends at t=10
        let tmp = tempfile::tempdir().unwrap();
        let (mut seq, assets) = four_segment_sequence();
        let mut dissolve = make_test_effect("fx-dissolve", EffectType::CrossDissolve);
        dissolve.set_param("duration", ParamValue::Float(2.0));
        seq.tracks[0].clips[1].effects = vec![dissolve.id.clone()];
        let mut effects = HashMap::from([(dissolve.id.clone(), dissolve.clone())]);

        let mut manifest = prepare_manifest(tmp.path(), &seq, &assets, &effects, 20.0);
        cache_every_segment(&mut manifest);

        // When the transition changes (its length stays the same)
        dissolve.set_param("softness", ParamValue::Float(0.25));
        effects.insert(dissolve.id.clone(), dissolve);

        let changed = refresh(&mut manifest, tmp.path(), &seq, &assets, &effects);

        // Then both segments meeting at t=10 are invalidated, and a segment out
        // of the blend's reach is not
        assert!(changed);
        assert_eq!(manifest.segments[1].state, CacheSegmentState::Stale);
        assert_eq!(manifest.segments[2].state, CacheSegmentState::Stale);
        assert_eq!(manifest.segments[3].state, CacheSegmentState::Cached);
    }

    #[test]
    fn should_not_widen_fingerprint_windows_without_transitions() {
        // Given a sequence with no two-input transitions
        let effects = HashMap::new();

        // Then segment windows are not widened at all
        assert_eq!(transition_window_reach_sec(&effects, 30.0), 0.0);

        // And a disabled transition buys no reach either
        let mut disabled = make_test_effect("fx", EffectType::CrossDissolve);
        disabled.set_param("duration", ParamValue::Float(2.0));
        disabled.enabled = false;
        let effects = HashMap::from([(disabled.id.clone(), disabled)]);
        assert_eq!(transition_window_reach_sec(&effects, 30.0), 0.0);
    }

    #[test]
    fn should_reach_past_the_handle_the_stitcher_actually_plans() {
        // The stitcher quantizes to round(duration * fps) frames and gives the
        // odd frame to the outgoing side, so half the requested duration is not
        // an upper bound on the handle.

        // Given an odd frame count: 1.05s at 30fps rounds to 31 frames, tail 16
        let mut odd = make_test_effect("fx-odd", EffectType::CrossDissolve);
        odd.set_param("duration", ParamValue::Float(1.05));
        let effects = HashMap::from([(odd.id.clone(), odd)]);

        // Then the reach covers the longer of the two handles, with slack
        let reach = transition_window_reach_sec(&effects, 30.0);
        let planned_tail_sec = 16.0 / 30.0;
        assert!(
            reach > planned_tail_sec,
            "reach {reach} does not cover the {planned_tail_sec}s tail handle"
        );
        assert!(reach < 1.05, "reach {reach} is wider than the transition");
    }

    #[test]
    fn should_measure_a_transition_with_no_duration_at_the_planned_default() {
        // `AddEffect` leaves params empty and no two-input transition declares a
        // default duration, so an agent- or CLI-added transition arrives without
        // one. The stitcher still plans it at DEFAULT_TRANSITION_SEC.

        // Given a cross dissolve with no duration param at all
        let bare = make_test_effect("fx-bare", EffectType::CrossDissolve);
        assert!(bare.get_float("duration").is_none());
        let effects = HashMap::from([(bare.id.clone(), bare)]);

        // Then it reaches as far as a transition of the default length
        let mut explicit = make_test_effect("fx-explicit", EffectType::CrossDissolve);
        explicit.set_param("duration", ParamValue::Float(DEFAULT_TRANSITION_SEC));
        let explicit = HashMap::from([(explicit.id.clone(), explicit)]);

        let reach = transition_window_reach_sec(&effects, 30.0);
        assert!(reach > 0.0);
        assert_eq!(reach, transition_window_reach_sec(&explicit, 30.0));
    }

    #[test]
    fn should_cap_the_transition_window_reach_at_the_longest_transition_placed() {
        // Given transitions of different lengths, plus one absurd value
        let mut short = make_test_effect("fx-short", EffectType::CrossDissolve);
        short.set_param("duration", ParamValue::Float(1.0));
        let mut absurd = make_test_effect("fx-absurd", EffectType::Wipe);
        absurd.set_param("duration", ParamValue::Float(600.0));
        let effects = HashMap::from([(short.id.clone(), short), (absurd.id.clone(), absurd)]);

        // Then the reach is bounded by the longest transition the engine places
        let reach = transition_window_reach_sec(&effects, 30.0);
        assert!(reach >= MAX_TRANSITION_SEC / 2.0);
        assert!(reach < MAX_TRANSITION_SEC / 2.0 + 0.1);
    }

    #[test]
    fn should_invalidate_a_neighbour_across_a_transition_added_without_a_duration() {
        // Regression: a transition with no duration param used to contribute no
        // reach at all, leaving the previous segment cached over the frames the
        // blend rewrites.

        // Given a bare cross dissolve on the clip that ends at t=10
        let tmp = tempfile::tempdir().unwrap();
        let (mut seq, assets) = four_segment_sequence();
        let dissolve = make_test_effect("fx-bare", EffectType::CrossDissolve);
        seq.tracks[0].clips[1].effects = vec![dissolve.id.clone()];
        let effects = HashMap::from([(dissolve.id.clone(), dissolve)]);

        let mut manifest = prepare_manifest(tmp.path(), &seq, &assets, &effects, 20.0);
        cache_every_segment(&mut manifest);

        // When the incoming clip changes
        let mut edited = seq.clone();
        edited.tracks[0].clips[2].opacity = 0.5;

        assert!(refresh(
            &mut manifest,
            tmp.path(),
            &edited,
            &assets,
            &effects
        ));

        // Then the segment before the blend is invalidated too
        assert_eq!(manifest.segments[1].state, CacheSegmentState::Stale);
        assert_eq!(manifest.segments[2].state, CacheSegmentState::Stale);
    }

    // -----------------------------------------------------------------------
    // Render inputs the render plan cannot see
    // -----------------------------------------------------------------------

    #[test]
    fn should_invalidate_a_segment_when_motion_keyframes_are_added() {
        // Ken Burns: the clip's static transform never changes, and
        // VisualRenderLayer carries no keyframes, so the plan hash is identical.
        assert_invalidated_although_the_plan_cannot_see_it(
            |sequence| {
                let clip = &mut sequence.tracks[0].clips[2];
                let mut zoomed = clip.transform.clone();
                zoomed.scale.x = 1.4;
                zoomed.scale.y = 1.4;
                clip.motion_keyframes = vec![
                    TransformKeyframe {
                        time_offset: 0.0,
                        transform: clip.transform.clone(),
                        interpolation: KeyframeInterpolation::default(),
                    },
                    TransformKeyframe {
                        time_offset: 5.0,
                        transform: zoomed,
                        interpolation: KeyframeInterpolation::default(),
                    },
                ];
            },
            &[2],
        );
    }

    #[test]
    fn should_invalidate_a_segment_when_freeze_frame_is_toggled() {
        assert_invalidated_although_the_plan_cannot_see_it(
            |sequence| sequence.tracks[0].clips[2].freeze_frame = true,
            &[2],
        );
    }

    #[test]
    fn should_invalidate_a_segment_when_a_clip_is_reversed() {
        assert_invalidated_although_the_plan_cannot_see_it(
            |sequence| sequence.tracks[0].clips[2].reverse = true,
            &[2],
        );
    }

    #[test]
    fn should_invalidate_a_segment_when_slow_motion_interpolation_changes() {
        assert_invalidated_although_the_plan_cannot_see_it(
            |sequence| {
                sequence.tracks[0].clips[2].slow_motion_interpolation =
                    crate::core::timeline::SlowMotionInterpolation::MotionCompensated;
            },
            &[2],
        );
    }

    #[test]
    fn should_invalidate_a_segment_when_clip_speed_changes() {
        // Speed retimes the source read but leaves the clip's timeline
        // placement — and therefore VisualRenderLayer — untouched, so the plan
        // hash cannot see it.
        assert_invalidated_although_the_plan_cannot_see_it(
            |sequence| sequence.tracks[0].clips[2].speed = 2.0,
            &[2],
        );
    }

    #[test]
    fn should_invalidate_a_segment_when_a_time_remap_is_added() {
        // Time remapping warps the source-time curve; no VisualRenderLayer field
        // carries it.
        assert_invalidated_although_the_plan_cannot_see_it(
            |sequence| {
                sequence.tracks[0].clips[2].time_remap =
                    Some(crate::core::timeline::TimeRemapCurve {
                        keyframes: vec![
                            crate::core::timeline::TimeRemapKeyframe {
                                timeline_time: 0.0,
                                source_time: 0.0,
                                interpolation: KeyframeInterpolation::default(),
                            },
                            crate::core::timeline::TimeRemapKeyframe {
                                timeline_time: 5.0,
                                source_time: 2.5,
                                interpolation: KeyframeInterpolation::default(),
                            },
                        ],
                    });
            },
            &[2],
        );
    }

    #[test]
    fn should_invalidate_every_segment_of_a_track_whose_blend_mode_changes() {
        // Track compositing is nowhere in the render graph.
        assert_invalidated_although_the_plan_cannot_see_it(
            |sequence| sequence.tracks[0].blend_mode = BlendMode::Multiply,
            &[0, 1, 2, 3],
        );
    }

    #[test]
    fn should_invalidate_every_segment_when_the_canvas_is_reframed() {
        // A vertical reframe changes every rendered pixel and no plan field.
        assert_invalidated_although_the_plan_cannot_see_it(
            |sequence| {
                sequence.format.canvas = Canvas {
                    width: 1080,
                    height: 1920,
                };
            },
            &[0, 1, 2, 3],
        );
    }

    #[test]
    fn should_invalidate_every_segment_when_master_volume_changes() {
        assert_invalidated_although_the_plan_cannot_see_it(
            |sequence| sequence.master_volume_db = -6.0,
            &[0, 1, 2, 3],
        );
    }

    #[test]
    fn should_invalidate_every_segment_when_the_renderer_semantics_version_changes() {
        // A cached project survives an app upgrade. If the compositor's maths
        // changed in that upgrade, its pixels are stale even though nothing in
        // the project did.
        let content =
            compute_window_content_hash(&four_segment_sequence().0, &HashMap::new(), 0.0, 5.0);
        let fingerprint = compute_plan_segment_fingerprint(
            "plan-hash",
            &preview_profile_hash(&test_canvas()),
            content,
        );

        let mut bumped = std::collections::hash_map::DefaultHasher::new();
        "plan-hash".hash(&mut bumped);
        preview_profile_hash(&test_canvas()).hash(&mut bumped);
        (RENDERER_SEMANTICS_VERSION + 1).hash(&mut bumped);
        content.hash(&mut bumped);

        assert_ne!(fingerprint, bumped.finish());

        // And the version is genuinely folded in: a mirror built with the *real*
        // constant matches. Without this, deleting the version from the
        // fingerprint constructor would still leave the assert_ne! above passing
        // (V vs V+1 differ either way), so the test could not catch that
        // regression.
        let mut matching = std::collections::hash_map::DefaultHasher::new();
        "plan-hash".hash(&mut matching);
        preview_profile_hash(&test_canvas()).hash(&mut matching);
        RENDERER_SEMANTICS_VERSION.hash(&mut matching);
        content.hash(&mut matching);

        assert_eq!(fingerprint, matching.finish());
    }

    #[test]
    fn should_not_invalidate_a_segment_for_an_edit_the_renderer_ignores() {
        // The content hash denies UI-only fields, so relabelling a clip or
        // renaming a track does not throw away a render.
        let tmp = tempfile::tempdir().unwrap();
        let (sequence, assets) = four_segment_sequence();
        let effects = HashMap::new();
        let mut manifest = prepare_manifest(tmp.path(), &sequence, &assets, &effects, 20.0);
        cache_every_segment(&mut manifest);

        let mut edited = sequence.clone();
        edited.tracks[0].name = "Renamed".to_string();
        edited.tracks[0].locked = true;
        edited.tracks[0].clips[2].label = Some("Take 2".to_string());
        edited.name = "Renamed sequence".to_string();
        edited.modified_at = "2026-08-28T00:00:00Z".to_string();
        edited
            .markers
            .push(crate::core::timeline::Marker::new(12.0, "note"));

        assert!(!refresh(
            &mut manifest,
            tmp.path(),
            &edited,
            &assets,
            &effects
        ));
        assert_eq!(states(&manifest), vec![CacheSegmentState::Cached; 4]);
    }

    #[test]
    fn should_hash_window_content_independently_of_map_ordering() {
        // Effect params live in a hash map; a fingerprint that inherited its
        // iteration order would change between processes.
        let (mut sequence, _) = four_segment_sequence();
        let mut effect = make_test_effect("fx", EffectType::Brightness);
        for key in ["alpha", "beta", "gamma", "delta", "epsilon"] {
            effect.set_param(key, ParamValue::Float(1.0));
        }
        sequence.tracks[0].clips[0].effects = vec![effect.id.clone()];

        let first = HashMap::from([(effect.id.clone(), effect.clone())]);
        let mut second: HashMap<String, Effect> = HashMap::new();
        second.insert(effect.id.clone(), effect);

        assert_eq!(
            compute_window_content_hash(&sequence, &first, 0.0, 5.0),
            compute_window_content_hash(&sequence, &second, 0.0, 5.0)
        );
    }

    // -----------------------------------------------------------------------
    // Reconciliation
    // -----------------------------------------------------------------------

    #[test]
    fn should_reconcile_segments_when_timeline_duration_changes() {
        // Given a cached 10-second manifest
        let mut manifest =
            RenderCacheManifest::new("seq1", &preview_profile_hash(&test_canvas()), 10.0, 5.0);
        manifest.segments[0].fingerprint = 0xabc;
        manifest.mark_segment_cached(0, "segment_0000.mp4".to_string(), 1024);

        // When the timeline expands
        let sync = manifest.reconcile_with_sequence(15.0, 5.0, InterruptedRenderPolicy::Reset);

        // Then existing cache is preserved and a new trailing segment is added
        assert!(sync.changed);
        assert!(sync.orphaned_files.is_empty());
        assert_eq!(manifest.segments.len(), 3);
        assert_eq!(manifest.segments[0].state, CacheSegmentState::Cached);
        assert_eq!(manifest.segments[0].fingerprint, 0xabc);
        assert_eq!(manifest.segments[2].state, CacheSegmentState::Empty);
        assert_eq!(
            manifest.segments[2].fingerprint, SEGMENT_FINGERPRINT_UNSET,
            "a segment covering new ground must be planned before it can match"
        );
    }

    #[test]
    fn should_drop_cached_segments_whose_range_no_longer_exists() {
        // Given a cached manifest
        let mut manifest =
            RenderCacheManifest::new("seq1", &preview_profile_hash(&test_canvas()), 15.0, 5.0);
        cache_every_segment(&mut manifest);

        // When the timeline shrinks past the last segment
        let sync = manifest.reconcile_with_sequence(10.0, 5.0, InterruptedRenderPolicy::Reset);

        // Then its file is reported as orphaned
        assert!(sync.changed);
        assert_eq!(sync.orphaned_files, vec!["segment_0002.mp4".to_string()]);
        assert_eq!(manifest.segments.len(), 2);
    }

    #[test]
    fn should_reset_interrupted_rendering_segments_during_reconcile() {
        // Given a manifest persisted while a segment was rendering
        let mut manifest =
            RenderCacheManifest::new("seq1", &preview_profile_hash(&test_canvas()), 10.0, 5.0);
        manifest.segments[0].state = CacheSegmentState::Rendering;
        manifest.segments[0].cached_file = Some("segment_0000.mp4".to_string());
        manifest.segments[0].file_size_bytes = 128;

        // When a render command reconciles the manifest it is about to own
        let sync = manifest.reconcile_with_sequence(10.0, 5.0, InterruptedRenderPolicy::Reset);

        // Then the interrupted segment becomes re-renderable and its partial file
        // is orphaned
        assert!(sync.changed);
        assert_eq!(sync.orphaned_files, vec!["segment_0000.mp4".to_string()]);
        assert_eq!(manifest.segments[0].state, CacheSegmentState::Error);
        assert!(manifest.segments[0].needs_render());
        assert!(manifest.segments[0].cached_file.is_none());
    }

    #[test]
    fn should_preserve_in_flight_rendering_segments_for_read_only_callers() {
        // Given a segment a background render currently owns
        let mut manifest =
            RenderCacheManifest::new("seq1", &preview_profile_hash(&test_canvas()), 10.0, 5.0);
        manifest.segments[0].state = CacheSegmentState::Rendering;
        manifest.segments[0].cached_file = Some("segment_0000.mp4".to_string());

        // When a read-only caller reconciles a copy of the manifest
        let sync = manifest.reconcile_with_sequence(10.0, 5.0, InterruptedRenderPolicy::Preserve);

        // Then the in-flight render is left alone rather than reported as failed
        assert!(sync.orphaned_files.is_empty());
        assert_eq!(manifest.segments[0].state, CacheSegmentState::Rendering);
    }

    // -----------------------------------------------------------------------
    // Status
    // -----------------------------------------------------------------------

    #[test]
    fn should_report_correct_completion_percent() {
        // Given a manifest with 4 segments
        let mut manifest =
            RenderCacheManifest::new("seq1", &preview_profile_hash(&test_canvas()), 20.0, 5.0);

        // When 2 out of 4 segments are cached
        manifest.mark_segment_cached(0, "segment_0000.mp4".to_string(), 512);
        manifest.mark_segment_cached(1, "segment_0001.mp4".to_string(), 512);

        // Then completion should be 50%
        assert!((manifest.completion_percent() - 50.0).abs() < 0.01);
        assert_eq!(manifest.cached_count(), 2);
        assert_eq!(manifest.pending_count(), 2);
    }

    #[test]
    fn should_build_cache_status_dto_from_manifest() {
        // Given a manifest with mixed segment states
        let mut manifest =
            RenderCacheManifest::new("seq1", &preview_profile_hash(&test_canvas()), 15.0, 5.0);
        manifest.mark_segment_cached(0, "segment_0000.mp4".to_string(), 1000);
        manifest.segments[1].state = CacheSegmentState::Stale;

        let tmp = tempfile::tempdir().unwrap();
        let config = RenderCacheConfig::default();
        let status = RenderCacheStatus::from_manifest(&manifest, &config, tmp.path());

        // Then status should reflect the manifest
        assert_eq!(status.total_segments, 3);
        assert_eq!(status.cached_segments, 1);
        assert_eq!(status.stale_segments, 1);
        assert_eq!(status.sequence_id, "seq1");
        assert_eq!(status.segment_states.len(), 3);
        assert_eq!(status.segment_states[0].state, CacheSegmentState::Cached);
        assert_eq!(status.segment_states[1].state, CacheSegmentState::Stale);
        assert_eq!(status.segment_states[2].state, CacheSegmentState::Empty);

        // The segment identity a cache-first preview needs: index, fingerprint,
        // and a resolved path for the cached segment (but not for the others).
        assert_eq!(status.segment_states[0].index, 0);
        assert_eq!(status.segment_states[2].index, 2);
        assert!(status.segment_states[0].cached_path.is_some());
        assert!(status.segment_states[1].cached_path.is_none());
        assert!(status.segment_states[2].cached_path.is_none());
    }

    #[test]
    fn should_not_offer_a_path_for_a_manifest_named_file_outside_the_cache() {
        // The manifest is inside the project directory and so attacker-controlled;
        // a status read must never hand back a path escaping the cache directory.
        let tmp = tempfile::tempdir().unwrap();
        let mut manifest =
            RenderCacheManifest::new("seq1", &preview_profile_hash(&test_canvas()), 5.0, 5.0);
        manifest.mark_segment_cached(0, "../../etc/passwd".to_string(), 1);

        let config = RenderCacheConfig::default();
        let status = RenderCacheStatus::from_manifest(&manifest, &config, tmp.path());

        assert_eq!(status.segment_states[0].state, CacheSegmentState::Cached);
        assert!(
            status.segment_states[0].cached_path.is_none(),
            "a traversing segment name must not resolve to a path"
        );
    }

    #[test]
    fn should_not_write_anything_when_reporting_cache_status() {
        // The frontend polls status on every render-cache progress event, so a
        // status read that persisted a reconcile — or the fingerprint refresh it
        // now runs to report staleness — would fight the renderer for the
        // manifest.

        // Given a persisted 10s manifest (segment 0 cached, segment 1 mid-render)
        // fingerprinted against the real timeline
        let tmp = tempfile::tempdir().unwrap();
        let config = RenderCacheConfig::default();
        let effects = HashMap::new();
        let (seq_ten, assets) = two_segment_sequence();
        let (seq_twenty, _) = four_segment_sequence();

        let mut manifest = prepare_manifest(tmp.path(), &seq_ten, &assets, &effects, 10.0);
        manifest.mark_segment_cached(0, "segment_0000.mp4".to_string(), 1024);
        manifest.segments[1].state = CacheSegmentState::Rendering;
        save_manifest(tmp.path(), &manifest).unwrap();

        let path = manifest_path(tmp.path(), &seq_ten.id).unwrap();
        let before = std::fs::read(&path).unwrap();

        // When status is read — including at a duration that grows the layout
        let status = cache_status_snapshot(
            tmp.path(),
            &seq_ten,
            &preview_profile_hash(&test_canvas()),
            &build_graph(&seq_ten),
            &assets,
            &effects,
            &config,
        )
        .unwrap();
        let grown = cache_status_snapshot(
            tmp.path(),
            &seq_twenty,
            &preview_profile_hash(&test_canvas()),
            &build_graph(&seq_twenty),
            &assets,
            &effects,
            &config,
        )
        .unwrap();

        // Then the on-disk manifest is untouched by either read
        assert_eq!(std::fs::read(&path).unwrap(), before);

        // And the report is still accurate, without failing the in-flight render
        assert_eq!(status.cached_segments, 1);
        assert_eq!(status.rendering_segments, 1);
        assert_eq!(status.total_segments, 2);
        assert_eq!(grown.total_segments, 4);
        assert_eq!(grown.cached_segments, 1);
    }

    #[test]
    fn should_report_stale_status_for_a_changed_timeline_without_writing_to_disk() {
        // The status poll is the cache's only production consumer today, so it —
        // not just the fill path — must report a changed timeline as stale.

        // Given a persisted manifest whose two segments are cached against the
        // real timeline
        let tmp = tempfile::tempdir().unwrap();
        let config = RenderCacheConfig::default();
        let effects = HashMap::new();
        let (sequence, assets) = two_segment_sequence();

        let mut manifest = prepare_manifest(tmp.path(), &sequence, &assets, &effects, 10.0);
        cache_every_segment(&mut manifest);
        save_manifest(tmp.path(), &manifest).unwrap();

        let path = manifest_path(tmp.path(), &sequence.id).unwrap();
        let before = std::fs::read(&path).unwrap();

        // When the second clip gains a motion keyframe (invisible to the plan)
        // and status is polled
        let mut edited = sequence.clone();
        let base = edited.tracks[0].clips[1].transform.clone();
        let mut zoomed = base.clone();
        zoomed.scale.x = 1.4;
        zoomed.scale.y = 1.4;
        edited.tracks[0].clips[1].motion_keyframes = vec![
            TransformKeyframe {
                time_offset: 0.0,
                transform: base,
                interpolation: KeyframeInterpolation::default(),
            },
            TransformKeyframe {
                time_offset: 5.0,
                transform: zoomed,
                interpolation: KeyframeInterpolation::default(),
            },
        ];
        let status = cache_status_snapshot(
            tmp.path(),
            &edited,
            &preview_profile_hash(&test_canvas()),
            &build_graph(&edited),
            &assets,
            &effects,
            &config,
        )
        .unwrap();

        // Then the report demotes the edited segment while leaving the untouched
        // one cached, and the on-disk manifest the renderer owns is unchanged
        assert_eq!(std::fs::read(&path).unwrap(), before);
        assert_eq!(status.cached_segments, 1);
        assert_eq!(status.stale_segments, 1);
    }

    #[test]
    fn should_report_an_empty_status_when_no_manifest_exists() {
        // Given a project with no render cache
        let tmp = tempfile::tempdir().unwrap();
        let config = RenderCacheConfig::default();
        let effects = HashMap::new();
        let (sequence, assets) = two_segment_sequence();

        // When status is read
        let status = cache_status_snapshot(
            tmp.path(),
            &sequence,
            &preview_profile_hash(&test_canvas()),
            &build_graph(&sequence),
            &assets,
            &effects,
            &config,
        )
        .unwrap();

        // Then the timeline is described but nothing is cached, and nothing was
        // written to disk
        assert_eq!(status.total_segments, 2);
        assert_eq!(status.cached_segments, 0);
        assert!(!manifest_path(tmp.path(), &sequence.id).unwrap().exists());
    }

    // -----------------------------------------------------------------------
    // Encode profiles
    // -----------------------------------------------------------------------

    fn half_size_preview_settings() -> ExportSettings {
        ExportSettings {
            width: Some(960),
            height: Some(540),
            ..ExportSettings::preview_cache(PathBuf::new(), &test_canvas(), None, None)
        }
    }

    #[test]
    fn should_produce_a_different_fingerprint_for_each_encode_profile() {
        // Given one render plan and two encode profiles
        let preview = preview_profile_hash(&test_canvas());
        let half = compute_profile_hash(&half_size_preview_settings());
        assert_ne!(preview, half);

        // Then the same plan fingerprints differently under each
        assert_ne!(
            compute_plan_segment_fingerprint("plan-hash", &preview, 42),
            compute_plan_segment_fingerprint("plan-hash", &half, 42)
        );
    }

    /// Feature: Preview cache partitioning
    /// Scenario: a canvas change retires the cache written at the old canvas
    #[test]
    fn should_partition_the_preview_cache_per_canvas() {
        // Given the same sequence at two canvases
        let landscape = preview_profile_hash(&Canvas::new(1920, 1080));
        let vertical = preview_profile_hash(&Canvas::new(1080, 1920));
        let smaller = preview_profile_hash(&Canvas::new(1280, 720));

        // Then each canvas is its own encode profile
        assert_ne!(landscape, vertical);
        assert_ne!(landscape, smaller);
        assert_ne!(vertical, smaller);

        // And a manifest written at the old canvas is discarded rather than
        // reused, so segments encoded at the wrong resolution are never served.
        let tmp = tempfile::tempdir().unwrap();
        let manifest = RenderCacheManifest::new("seq1", &landscape, 10.0, 5.0);
        save_manifest(tmp.path(), &manifest).unwrap();

        let loaded = manifest_for_profile(tmp.path(), "seq1", &vertical, 10.0, 5.0).unwrap();
        assert_eq!(
            loaded.discarded_profile.as_deref(),
            Some(landscape.as_str())
        );
        assert_eq!(loaded.manifest.profile_hash, vertical);
    }

    #[test]
    fn should_change_the_profile_hash_when_encode_settings_change() {
        let base = ExportSettings::preview_cache(PathBuf::new(), &test_canvas(), None, None);
        let baseline = compute_profile_hash(&base);

        // Time range and output path identify a segment, not a profile
        assert_eq!(
            compute_profile_hash(&ExportSettings::preview_cache(
                PathBuf::from("elsewhere.mp4"),
                &test_canvas(),
                Some(5.0),
                Some(10.0)
            )),
            baseline
        );

        // Everything that changes the produced file does change the profile
        for changed in [
            ExportSettings {
                height: Some(2160),
                ..base.clone()
            },
            ExportSettings {
                fps: Some(60.0),
                ..base.clone()
            },
            ExportSettings {
                crf: Some(18),
                ..base.clone()
            },
            ExportSettings {
                video_codec: VideoCodec::H265,
                ..base.clone()
            },
            ExportSettings {
                bit_depth: Some(10),
                ..base.clone()
            },
            ExportSettings {
                hdr_mode: crate::core::render::export::HdrMode::Hdr10,
                ..base.clone()
            },
        ] {
            assert_ne!(compute_profile_hash(&changed), baseline);
        }
    }

    #[test]
    fn should_store_each_profiles_segments_in_its_own_directory() {
        // Given two profiles
        let tmp = tempfile::tempdir().unwrap();
        let preview = preview_profile_hash(&test_canvas());
        let half = compute_profile_hash(&half_size_preview_settings());

        // When resolving the same segment index under each
        let preview_path = segment_cache_file(tmp.path(), "seq1", &preview, 0).unwrap();
        let half_path = segment_cache_file(tmp.path(), "seq1", &half, 0).unwrap();

        // Then they are different files, both under the sequence cache directory
        assert_ne!(preview_path, half_path);
        assert_eq!(
            preview_path,
            sequence_cache_dir(tmp.path(), "seq1")
                .unwrap()
                .join(&preview)
                .join("segment_0000.mov")
        );
        assert_eq!(half_path.file_name(), preview_path.file_name());
    }

    #[test]
    fn should_not_hand_one_profiles_cached_segment_to_another() {
        // Given a segment cached under the preview profile
        let tmp = tempfile::tempdir().unwrap();
        let preview = preview_profile_hash(&test_canvas());
        let half = compute_profile_hash(&half_size_preview_settings());
        let preview_dir = profile_cache_dir(tmp.path(), "seq1", &preview).unwrap();
        std::fs::create_dir_all(&preview_dir).unwrap();
        std::fs::write(preview_dir.join("segment_0000.mp4"), b"preview").unwrap();

        let mut manifest = RenderCacheManifest::new("seq1", &preview, 10.0, 5.0);
        manifest.mark_segment_cached(0, "segment_0000.mp4".to_string(), 7);
        save_manifest(tmp.path(), &manifest).unwrap();

        // When the same sequence is asked for under the other profile
        let loaded = manifest_for_profile(tmp.path(), "seq1", &half, 10.0, 5.0).unwrap();

        // Then the stored manifest is discarded rather than reused
        assert_eq!(loaded.discarded_profile.as_deref(), Some(preview.as_str()));
        assert_eq!(loaded.manifest.profile_hash, half);
        assert_eq!(loaded.manifest.cached_count(), 0);

        // And the preview profile's file is not on the other profile's path
        assert!(!profile_cache_dir(tmp.path(), "seq1", &half)
            .unwrap()
            .join("segment_0000.mp4")
            .exists());
    }

    #[test]
    fn should_discard_a_manifest_written_before_profile_partitioning() {
        // Given a manifest from a build that had no profile hash
        let tmp = tempfile::tempdir().unwrap();
        let dir = sequence_cache_dir(tmp.path(), "seq1").unwrap();
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("manifest.json"),
            r#"{
                "sequenceId": "seq1",
                "segmentDurationSec": 5.0,
                "segments": [
                    {
                        "index": 0,
                        "startSec": 0.0,
                        "endSec": 5.0,
                        "state": "cached",
                        "fingerprint": 12345,
                        "cachedFile": "segment_0000.mp4",
                        "fileSizeBytes": 1024
                    }
                ],
                "totalCachedBytes": 1024,
                "updatedAt": "2026-01-01T00:00:00Z"
            }"#,
        )
        .unwrap();

        // When it is loaded for the current profile
        let profile = preview_profile_hash(&test_canvas());
        let loaded = manifest_for_profile(tmp.path(), "seq1", &profile, 5.0, 5.0).unwrap();

        // Then it deserializes but claims no cache
        assert_eq!(loaded.discarded_profile.as_deref(), Some(""));
        assert_eq!(loaded.manifest.cached_count(), 0);
        assert_eq!(loaded.manifest.profile_hash, profile);
    }

    #[test]
    fn should_prune_only_unreachable_cache_entries() {
        // Given cache directories for two profiles, a segment left at the
        // sequence root by a build from before profile partitioning, and two
        // entries this module never wrote
        let tmp = tempfile::tempdir().unwrap();
        let keep = preview_profile_hash(&test_canvas());
        let stale = compute_profile_hash(&half_size_preview_settings());
        for profile in [&keep, &stale] {
            let dir = profile_cache_dir(tmp.path(), "seq1", profile).unwrap();
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("segment_0000.mp4"), b"data").unwrap();
        }
        let sequence_dir = sequence_cache_dir(tmp.path(), "seq1").unwrap();
        let legacy_segment = sequence_dir.join("segment_0000.mp4");
        std::fs::write(&legacy_segment, b"legacy").unwrap();
        std::fs::write(sequence_dir.join("manifest.json"), b"{}").unwrap();
        std::fs::create_dir_all(sequence_dir.join("not-a-profile")).unwrap();

        // When pruning
        let removed = prune_other_profile_caches(tmp.path(), "seq1", &keep).unwrap();

        // Then the other profile's directory and the orphaned legacy segment are
        // gone, and nothing else is touched
        assert_eq!(removed, 2);
        assert!(profile_cache_dir(tmp.path(), "seq1", &keep)
            .unwrap()
            .join("segment_0000.mp4")
            .exists());
        assert!(!profile_cache_dir(tmp.path(), "seq1", &stale)
            .unwrap()
            .exists());
        assert!(!legacy_segment.exists());
        assert!(sequence_dir.join("manifest.json").exists());
        assert!(sequence_dir.join("not-a-profile").exists());
    }

    #[test]
    fn should_report_no_pruning_when_the_sequence_has_no_cache_directory() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(
            prune_other_profile_caches(tmp.path(), "seq1", &preview_profile_hash(&test_canvas()))
                .unwrap(),
            0
        );
    }

    // -----------------------------------------------------------------------
    // Cache management
    // -----------------------------------------------------------------------

    #[test]
    fn should_clear_all_cached_segments() {
        // Given a manifest with cached segments
        let mut manifest =
            RenderCacheManifest::new("seq1", &preview_profile_hash(&test_canvas()), 10.0, 5.0);
        manifest.mark_segment_cached(0, "segment_0000.mp4".to_string(), 1024);
        manifest.mark_segment_cached(1, "segment_0001.mp4".to_string(), 2048);
        assert_eq!(manifest.total_cached_bytes, 3072);

        // When clearing all cache
        manifest.clear();

        // Then all segments should be empty with zero size
        assert!(manifest
            .segments
            .iter()
            .all(|s| s.state == CacheSegmentState::Empty));
        assert!(manifest.segments.iter().all(|s| s.cached_file.is_none()));
        assert_eq!(manifest.total_cached_bytes, 0);
    }

    #[test]
    fn should_build_correct_cache_directory_paths() {
        // Given a project directory and a profile
        let project_dir = Path::new("/projects/my_video");
        let profile = preview_profile_hash(&test_canvas());

        // When getting cache paths
        let cache_dir = render_cache_dir(project_dir);
        let seq_dir = sequence_cache_dir(project_dir, "seq-001").unwrap();
        let manifest = manifest_path(project_dir, "seq-001").unwrap();
        let seg_file = segment_cache_file(project_dir, "seq-001", &profile, 3).unwrap();

        // Then paths should follow the convention
        assert_eq!(
            cache_dir,
            PathBuf::from("/projects/my_video/.openreelio/cache/renders")
        );
        assert_eq!(
            seq_dir,
            PathBuf::from("/projects/my_video/.openreelio/cache/renders/seq-001")
        );
        assert_eq!(
            manifest,
            PathBuf::from("/projects/my_video/.openreelio/cache/renders/seq-001/manifest.json")
        );
        assert_eq!(
            seg_file,
            PathBuf::from(format!(
                "/projects/my_video/.openreelio/cache/renders/seq-001/{profile}/segment_0003.mov"
            ))
        );
    }

    #[test]
    fn should_create_config_from_performance_settings() {
        // Given performance settings with 2GB cache
        let config = RenderCacheConfig::from_cache_size_mb(2048);

        // Then config should have correct max cache bytes
        assert_eq!(config.max_cache_bytes, 2048 * 1024 * 1024);
        assert!(config.enabled);
        assert!(config.smart_render_enabled);
        assert_eq!(config.segment_duration_sec, DEFAULT_SEGMENT_DURATION_SEC);
    }

    #[test]
    fn should_save_and_load_manifest_roundtrip() {
        // Given a manifest
        let profile = preview_profile_hash(&test_canvas());
        let mut manifest = RenderCacheManifest::new("seq1", &profile, 10.0, 5.0);
        manifest.segments[0].fingerprint = 4242;
        manifest.mark_segment_cached(0, "segment_0000.mp4".to_string(), 2048);

        // When saving and loading
        let tmp = tempfile::tempdir().unwrap();
        save_manifest(tmp.path(), &manifest).unwrap();
        let loaded = load_manifest(tmp.path(), "seq1").unwrap();

        // Then loaded manifest should match
        assert!(loaded.is_some());
        let loaded = loaded.unwrap();
        assert_eq!(loaded.sequence_id, "seq1");
        assert_eq!(loaded.profile_hash, profile);
        assert_eq!(loaded.segments.len(), 2);
        assert_eq!(loaded.segments[0].state, CacheSegmentState::Cached);
        assert_eq!(loaded.segments[0].fingerprint, 4242);
        assert_eq!(loaded.segments[0].file_size_bytes, 2048);
        assert_eq!(loaded.segments[1].state, CacheSegmentState::Empty);
    }

    #[test]
    fn should_return_none_when_manifest_not_found() {
        // Given a project dir with no cache
        let tmp = tempfile::tempdir().unwrap();

        // When loading
        let result = load_manifest(tmp.path(), "nonexistent").unwrap();

        // Then None should be returned
        assert!(result.is_none());
    }

    #[test]
    fn should_cleanup_stale_segment_files() {
        // Given a manifest with a stale segment that has a file
        let tmp = tempfile::tempdir().unwrap();
        let profile = preview_profile_hash(&test_canvas());
        let mut manifest = RenderCacheManifest::new("seq1", &profile, 10.0, 5.0);
        manifest.mark_segment_cached(0, "segment_0000.mp4".to_string(), 1024);

        let seg_dir = profile_cache_dir(tmp.path(), "seq1", &profile).unwrap();
        std::fs::create_dir_all(&seg_dir).unwrap();
        std::fs::write(seg_dir.join("segment_0000.mp4"), vec![0u8; 1024]).unwrap();

        manifest.segments[0].state = CacheSegmentState::Stale;

        // When cleaning up
        let freed = cleanup_stale_files(tmp.path(), &mut manifest);

        // Then the file should be deleted and bytes freed
        assert_eq!(freed, 1024);
        assert_eq!(manifest.segments[0].state, CacheSegmentState::Empty);
        assert!(manifest.segments[0].cached_file.is_none());
        assert!(!seg_dir.join("segment_0000.mp4").exists());
    }

    #[test]
    fn should_clear_entire_sequence_cache() {
        // Given a sequence cache directory with files for a profile
        let tmp = tempfile::tempdir().unwrap();
        let profile = preview_profile_hash(&test_canvas());
        let dir = profile_cache_dir(tmp.path(), "seq1", &profile).unwrap();
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("segment_0000.mp4"), b"test").unwrap();
        std::fs::write(
            sequence_cache_dir(tmp.path(), "seq1")
                .unwrap()
                .join("manifest.json"),
            b"{}",
        )
        .unwrap();

        // When clearing
        clear_sequence_cache(tmp.path(), "seq1").unwrap();

        // Then every profile's directory is gone with it
        assert!(!sequence_cache_dir(tmp.path(), "seq1").unwrap().exists());
    }

    #[test]
    fn should_reject_traversing_sequence_id_before_removing_anything() {
        // Given a directory that a traversing sequence id would resolve to. The render
        // cache lives at `<project>/.openreelio/cache/renders/<sequenceId>`, and
        // `clear_sequence_cache` calls `remove_dir_all` on it without ever looking the
        // id up in `project.state.sequences`.
        let tmp = tempfile::tempdir().unwrap();
        let profile = preview_profile_hash(&test_canvas());
        let victim = tmp.path().join("victim");
        std::fs::create_dir_all(&victim).unwrap();
        std::fs::write(victim.join("keep.txt"), b"keep").unwrap();

        // When a hostile id reaches any cache path helper
        for sequence_id in [
            "../../../../victim",
            "..\\..\\..\\..\\victim",
            "seq/../../victim",
            "C:",
            "",
            " seq1 ",
        ] {
            assert!(
                sequence_cache_dir(tmp.path(), sequence_id).is_err(),
                "sequence_cache_dir accepted {sequence_id:?}"
            );
            assert!(
                profile_cache_dir(tmp.path(), sequence_id, &profile).is_err(),
                "profile_cache_dir accepted {sequence_id:?}"
            );
            assert!(
                manifest_path(tmp.path(), sequence_id).is_err(),
                "manifest_path accepted {sequence_id:?}"
            );
            assert!(
                segment_cache_file(tmp.path(), sequence_id, &profile, 0).is_err(),
                "segment_cache_file accepted {sequence_id:?}"
            );
            assert!(
                clear_sequence_cache(tmp.path(), sequence_id).is_err(),
                "clear_sequence_cache accepted {sequence_id:?}"
            );
            assert!(
                load_manifest(tmp.path(), sequence_id).is_err(),
                "load_manifest accepted {sequence_id:?}"
            );
            assert!(
                prune_other_profile_caches(tmp.path(), sequence_id, &profile).is_err(),
                "prune_other_profile_caches accepted {sequence_id:?}"
            );
        }

        // Then nothing outside the cache directory was removed
        assert!(victim.join("keep.txt").exists());
    }

    #[test]
    fn should_only_accept_profile_hashes_the_writer_produces() {
        // Given a profile hash this module emitted
        let tmp = tempfile::tempdir().unwrap();
        assert!(
            profile_cache_dir(tmp.path(), "seq1", &preview_profile_hash(&test_canvas())).is_ok()
        );

        // Then nothing else names a directory — a profile hash reaches path
        // construction from the on-disk manifest
        for profile_hash in [
            "../../../../victim",
            "..\\..\\victim",
            "seq/../..",
            "",
            "ABCDEF0123456789", // uppercase is not what the writer emits
            "0123456789abcde",  // one digit short
            "0123456789abcdef0",
            "0123456789abcdeg",
        ] {
            assert!(
                profile_cache_dir(tmp.path(), "seq1", profile_hash).is_err(),
                "profile_cache_dir accepted {profile_hash:?}"
            );
            assert!(
                segment_cache_file(tmp.path(), "seq1", profile_hash, 0).is_err(),
                "segment_cache_file accepted {profile_hash:?}"
            );
        }
    }

    #[test]
    fn should_only_accept_segment_names_the_writer_produces() {
        // Given the exact names `segment_cache_file` emits
        for index in [0u32, 1, 42, 9999, 10_000, u32::MAX] {
            let name = segment_cache_file_name(index);
            assert!(
                is_cached_segment_name(&name),
                "rejected own output {name:?}"
            );
        }

        // Then everything else is rejected — most importantly anything that escapes the
        // profile cache directory, since `cached_file` comes from the on-disk manifest
        // and is handed to `remove_file` and `fs::copy`.
        for name in [
            "../../../../snapshot.json",
            "..\\..\\snapshot.json",
            "segment_0000.mp4/../../evil.mp4",
            "segment_0.mp4",     // width below the writer's `{:04}`
            "segment_00000.mp4", // padded past what `{:04}` emits for 0
            "segment_0000.mkv",
            "segment_00a0.mp4",
            "s0.mp4",
            "manifest.json",
            "",
        ] {
            assert!(!is_cached_segment_name(name), "accepted {name:?}");
        }
    }

    #[test]
    fn should_write_segments_as_mov_and_still_recognize_legacy_mp4_for_cleanup() {
        // Given the writer, which emits only the container the lossless
        // preview-cache codec needs
        assert_eq!(segment_cache_file_name(0), "segment_0000.mov");
        assert!(segment_cache_file_name(7).ends_with(".mov"));

        // Then the predicate accepts what the writer emits
        assert!(is_cached_segment_name("segment_0000.mov"));

        // And it still accepts the extension older builds wrote, so segments
        // left behind by the H.264 cache remain deletable rather than becoming
        // permanently unreachable garbage.
        assert!(is_cached_segment_name("segment_0000.mp4"));

        // While traversal is refused under either extension.
        assert!(!is_cached_segment_name("../segment_0000.mov"));
        assert!(!is_cached_segment_name("../segment_0000.mp4"));
    }

    #[test]
    fn should_not_remove_a_manifest_named_file_outside_the_cache_dir() {
        // Given a manifest whose `cached_file` traverses out of the cache directory
        let tmp = tempfile::tempdir().unwrap();
        let profile = preview_profile_hash(&test_canvas());
        let seg_dir = profile_cache_dir(tmp.path(), "seq1", &profile).unwrap();
        std::fs::create_dir_all(&seg_dir).unwrap();
        let victim = seg_dir.join("..").join("victim.mp4");
        std::fs::write(&victim, vec![0u8; 1024]).unwrap();

        let mut manifest = RenderCacheManifest::new("seq1", &profile, 10.0, 5.0);
        manifest.mark_segment_cached(0, "../victim.mp4".to_string(), 1024);
        manifest.segments[0].state = CacheSegmentState::Stale;

        // When the stale-file sweep runs
        let freed = cleanup_stale_files(tmp.path(), &mut manifest);

        // Then nothing was deleted and the poisoned entry was dropped
        assert_eq!(freed, 0);
        assert!(victim.exists());
        assert!(manifest.segments[0].cached_file.is_none());
        assert_eq!(manifest.segments[0].state, CacheSegmentState::Empty);
    }

    #[test]
    fn should_not_evict_a_manifest_named_file_outside_the_cache_dir() {
        // Given an over-limit manifest whose `cached_file` traverses out of the cache dir
        let tmp = tempfile::tempdir().unwrap();
        let profile = preview_profile_hash(&test_canvas());
        let seg_dir = profile_cache_dir(tmp.path(), "seq1", &profile).unwrap();
        std::fs::create_dir_all(&seg_dir).unwrap();
        let victim = seg_dir.join("..").join("victim.mp4");
        std::fs::write(&victim, vec![0u8; 4096]).unwrap();

        let mut manifest = RenderCacheManifest::new("seq1", &profile, 10.0, 5.0);
        manifest.mark_segment_cached(0, "../victim.mp4".to_string(), 4096);

        // When the size limit forces an eviction
        enforce_cache_limit(tmp.path(), &mut manifest, 0, &HashSet::new());

        // Then the file outside the cache directory survives
        assert!(victim.exists());
    }

    #[test]
    fn should_evict_segments_when_cache_exceeds_limit() {
        // Given a manifest where total size exceeds the limit
        let tmp = tempfile::tempdir().unwrap();
        let profile = preview_profile_hash(&test_canvas());
        let seg_dir = profile_cache_dir(tmp.path(), "seq1", &profile).unwrap();
        std::fs::create_dir_all(&seg_dir).unwrap();

        let mut manifest = RenderCacheManifest::new("seq1", &profile, 20.0, 5.0);

        // Cache all 4 segments (500 bytes each = 2000 total)
        for i in 0..4 {
            let name = segment_cache_file_name(i);
            std::fs::write(seg_dir.join(&name), vec![0u8; 500]).unwrap();
            manifest.mark_segment_cached(i, name, 500);
        }
        assert_eq!(manifest.total_cached_bytes, 2000);

        // When enforcing a 1000-byte limit
        let evicted = enforce_cache_limit(tmp.path(), &mut manifest, 1000, &HashSet::new());

        // Then segments should be evicted from the end
        assert_eq!(evicted, 2);
        assert!(manifest.total_cached_bytes <= 1000);
        // First segments preserved (more likely to be played)
        assert_eq!(manifest.segments[0].state, CacheSegmentState::Cached);
        assert_eq!(manifest.segments[1].state, CacheSegmentState::Cached);
        assert_eq!(manifest.segments[2].state, CacheSegmentState::Empty);
        assert_eq!(manifest.segments[3].state, CacheSegmentState::Empty);
    }

    #[test]
    fn should_not_evict_when_under_limit() {
        // Given a manifest under the size limit
        let tmp = tempfile::tempdir().unwrap();
        let mut manifest =
            RenderCacheManifest::new("seq1", &preview_profile_hash(&test_canvas()), 10.0, 5.0);
        manifest.mark_segment_cached(0, "segment_0000.mp4".to_string(), 100);

        // When enforcing a large limit
        let evicted = enforce_cache_limit(tmp.path(), &mut manifest, 10_000, &HashSet::new());

        // Then nothing should be evicted
        assert_eq!(evicted, 0);
        assert_eq!(manifest.segments[0].state, CacheSegmentState::Cached);
    }

    #[test]
    fn should_not_evict_segments_the_running_fill_is_producing() {
        // Given a cache well over its byte cap, where the segments a fill is
        // currently producing are the highest-index ones — exactly the victims
        // the index-descending eviction order would pick first.
        let tmp = tempfile::tempdir().unwrap();
        let profile = preview_profile_hash(&test_canvas());
        let seg_dir = profile_cache_dir(tmp.path(), "seq1", &profile).unwrap();
        std::fs::create_dir_all(&seg_dir).unwrap();

        let mut manifest = RenderCacheManifest::new("seq1", &profile, 20.0, 5.0);
        for index in 0..4 {
            let name = segment_cache_file_name(index);
            std::fs::write(seg_dir.join(&name), vec![0u8; 500]).unwrap();
            manifest.mark_segment_cached(index, name, 500);
        }

        // When the cap is enforced while that fill holds indices 2 and 3
        let protected: HashSet<u32> = [2, 3].into_iter().collect();
        let evicted = enforce_cache_limit(tmp.path(), &mut manifest, 500, &protected);

        // Then the fill's own output survives, files and all, even though the
        // cache is still over the cap afterwards — a fill that evicted what it
        // just wrote could never finish.
        assert_eq!(manifest.segments[2].state, CacheSegmentState::Cached);
        assert_eq!(manifest.segments[3].state, CacheSegmentState::Cached);
        assert!(seg_dir.join(segment_cache_file_name(2)).exists());
        assert!(seg_dir.join(segment_cache_file_name(3)).exists());

        // And the unprotected segments are the ones that were reclaimed.
        assert_eq!(evicted, 2);
        assert_eq!(manifest.segments[0].state, CacheSegmentState::Empty);
        assert_eq!(manifest.segments[1].state, CacheSegmentState::Empty);
    }

    // -----------------------------------------------------------------------
    // Segment flag classifier
    // -----------------------------------------------------------------------

    /// One asset table holding a video, an image and a subtitle, so a fixture
    /// can pick which kind a clip resolves to just by naming an asset id.
    fn flag_test_assets() -> HashMap<String, Asset> {
        let mut image = Asset::new_image("still.png", "/tmp/still.png", 1920, 1080);
        image.id = "img0".to_string();

        HashMap::from([
            ("a0".to_string(), make_video_asset("a0")),
            ("img0".to_string(), image),
        ])
    }

    /// Classifies a single 0..5s clip on one visible video track.
    ///
    /// `edit` gets both the clip and its track, so a fixture can move the flag
    /// onto whichever of the two carries it.
    fn flags_for(edit: impl FnOnce(&mut Clip, &mut Track)) -> Vec<SegmentFlagReason> {
        flags_with_effects(&HashMap::new(), edit)
    }

    /// [`flags_for`] with a project effect table the clip can reference.
    fn flags_with_effects(
        effects: &HashMap<String, Effect>,
        edit: impl FnOnce(&mut Clip, &mut Track),
    ) -> Vec<SegmentFlagReason> {
        let mut clip = make_test_clip("c0", "a0", 0.0, 5.0);
        let mut track = make_test_track("t1", TrackKind::Video, Vec::new());
        edit(&mut clip, &mut track);
        track.clips = vec![clip];

        let sequence = make_test_sequence("seq1", vec![track]);
        classify_segment_window(&sequence, &flag_test_assets(), effects, 0.0, 5.0)
    }

    #[test]
    fn should_not_flag_a_segment_when_it_holds_a_plain_full_frame_video_clip() {
        assert_eq!(flags_for(|_, _| {}), vec![]);
    }

    #[test]
    fn should_flag_blend_mode_when_the_clip_carries_one() {
        assert_eq!(
            flags_for(|clip, _| clip.blend_mode = BlendMode::Multiply),
            vec![SegmentFlagReason::BlendMode]
        );
    }

    #[test]
    fn should_flag_blend_mode_when_only_the_track_carries_one() {
        // The clip is Normal, so the reason exists only after the effective
        // mode is folded down from the track.
        assert_eq!(
            flags_for(|_, track| track.blend_mode = BlendMode::Screen),
            vec![SegmentFlagReason::BlendMode]
        );
    }

    #[test]
    fn should_flag_transform_when_the_clip_is_not_at_identity() {
        assert_eq!(
            flags_for(|clip, _| clip.transform.scale.x = 1.5),
            vec![SegmentFlagReason::Transform]
        );
    }

    #[test]
    fn should_not_flag_transform_when_the_clip_is_within_the_identity_tolerance() {
        // JSON round-trip noise must not read as a deliberate transform.
        assert_eq!(
            flags_for(|clip, _| {
                clip.transform.position.x = 0.5 + 1e-6;
                clip.transform.rotation_deg = -1e-6;
            }),
            vec![]
        );
    }

    #[test]
    fn should_flag_motion_keyframes_when_the_base_transform_is_still_identity() {
        // A Ken Burns move leaves `transform` untouched, so only the keyframes
        // themselves can reveal it.
        assert_eq!(
            flags_for(|clip, _| {
                let mut zoomed = clip.transform.clone();
                zoomed.scale.x = 1.4;
                zoomed.scale.y = 1.4;
                clip.motion_keyframes = vec![
                    TransformKeyframe {
                        time_offset: 0.0,
                        transform: clip.transform.clone(),
                        interpolation: KeyframeInterpolation::default(),
                    },
                    TransformKeyframe {
                        time_offset: 5.0,
                        transform: zoomed,
                        interpolation: KeyframeInterpolation::default(),
                    },
                ];
            }),
            vec![SegmentFlagReason::MotionKeyframes]
        );
    }

    #[test]
    fn should_flag_opacity_when_the_clip_is_not_fully_opaque() {
        assert_eq!(
            flags_for(|clip, _| clip.opacity = 0.5),
            vec![SegmentFlagReason::Opacity]
        );
    }

    #[test]
    fn should_not_flag_opacity_when_the_clip_is_fully_opaque() {
        assert_eq!(flags_for(|clip, _| clip.opacity = 1.0), vec![]);
    }

    #[test]
    fn should_flag_clip_effects_when_an_enabled_effect_is_applied() {
        let blur = make_test_effect("fx-blur", EffectType::GaussianBlur);
        let effects = HashMap::from([(blur.id.clone(), blur)]);
        assert_eq!(
            flags_with_effects(&effects, |clip, _| clip.effects =
                vec!["fx-blur".to_string()]),
            vec![SegmentFlagReason::ClipEffects]
        );
    }

    #[test]
    fn should_not_flag_clip_effects_when_the_effect_is_disabled() {
        let mut blur = make_test_effect("fx-blur", EffectType::GaussianBlur);
        blur.enabled = false;
        let effects = HashMap::from([(blur.id.clone(), blur)]);
        assert_eq!(
            flags_with_effects(&effects, |clip, _| clip.effects =
                vec!["fx-blur".to_string()]),
            vec![]
        );
    }

    #[test]
    fn should_flag_clip_effects_when_an_effect_id_resolves_to_nothing() {
        // Deny by default: an effect the classifier cannot inspect is an effect
        // it must assume the preview cannot draw.
        assert_eq!(
            flags_with_effects(&HashMap::new(), |clip, _| {
                clip.effects = vec!["fx-ghost".to_string()];
            }),
            vec![SegmentFlagReason::ClipEffects]
        );
    }

    #[test]
    fn should_flag_speed_when_the_clip_is_retimed() {
        assert_eq!(
            flags_for(|clip, _| clip.speed = 2.0),
            vec![SegmentFlagReason::Speed]
        );
    }

    #[test]
    fn should_flag_speed_when_the_clip_is_reversed() {
        assert_eq!(
            flags_for(|clip, _| clip.reverse = true),
            vec![SegmentFlagReason::Speed]
        );
    }

    #[test]
    fn should_flag_speed_when_the_clip_is_a_freeze_frame() {
        assert_eq!(
            flags_for(|clip, _| clip.freeze_frame = true),
            vec![SegmentFlagReason::Speed]
        );
    }

    #[test]
    fn should_flag_speed_when_the_clip_carries_a_time_remap_curve() {
        assert_eq!(
            flags_for(|clip, _| {
                clip.time_remap = Some(crate::core::timeline::TimeRemapCurve {
                    keyframes: vec![
                        crate::core::timeline::TimeRemapKeyframe {
                            timeline_time: 0.0,
                            source_time: 0.0,
                            interpolation: KeyframeInterpolation::default(),
                        },
                        crate::core::timeline::TimeRemapKeyframe {
                            timeline_time: 5.0,
                            source_time: 2.5,
                            interpolation: KeyframeInterpolation::default(),
                        },
                    ],
                });
            }),
            vec![SegmentFlagReason::Speed]
        );
    }

    #[test]
    fn should_flag_a_two_input_transition_as_transition_rather_than_clip_effects() {
        // `xfade` never enters the clip's own filter chain, so it is a different
        // problem for the preview than a single-input effect is.
        let dissolve = make_test_effect("fx-dissolve", EffectType::CrossDissolve);
        let effects = HashMap::from([(dissolve.id.clone(), dissolve)]);
        assert_eq!(
            flags_with_effects(&effects, |clip, _| {
                clip.effects = vec!["fx-dissolve".to_string()];
            }),
            vec![SegmentFlagReason::Transition]
        );
    }

    #[test]
    fn should_widen_transition_flags_to_every_segment_within_the_blend_reach() {
        // The blend straddles the cut with handles, so a segment that does not
        // contain the transitioned clip at all still shows frames the blend
        // wrote. The reach is one number for the whole timeline (see
        // `transition_window_reach_sec`), so it also spills onto the segment on
        // the clip's *other* edge — over-flagging, the same way the fingerprint
        // over-invalidates, and bounded by the reach rather than unbounded.
        let (mut sequence, assets) = four_segment_sequence();
        let dissolve = make_test_effect("fx-dissolve", EffectType::CrossDissolve);
        // The clip spanning 5..10, i.e. ending on the segment 1 / segment 2 cut.
        sequence.tracks[0].clips[1].effects = vec![dissolve.id.clone()];
        let effects = HashMap::from([(dissolve.id.clone(), dissolve)]);

        // Without widening, segment 2 holds no transitioned clip at all.
        assert_eq!(
            classify_segment_window(&sequence, &assets, &effects, 10.0, 15.0),
            vec![]
        );

        let mut manifest =
            RenderCacheManifest::new("seq1", &preview_profile_hash(&test_canvas()), 20.0, 5.0);
        assert!(refresh_manifest_segment_flags(
            &mut manifest,
            &sequence,
            &assets,
            &effects
        ));

        let transition = vec![SegmentFlagReason::Transition];
        // Segment 1 holds the clip; segment 2 is the far side of the cut; and
        // segment 0 is reached across the clip's leading edge at t=5.
        assert_eq!(manifest.segments[0].flag_reasons, transition);
        assert_eq!(manifest.segments[1].flag_reasons, transition);
        assert_eq!(manifest.segments[2].flag_reasons, transition);
        // Segment 3 (15..20) is further than the reach from the clip, so the
        // spread stops there rather than covering the timeline.
        assert!(!manifest.segments[3].flagged());
    }

    #[test]
    fn should_flag_a_text_clip_because_export_burns_it_in() {
        // The WebView draws this as an HTML overlay, so the frontend's preview
        // fallback stays quiet — but HTML text is not the export's drawtext.
        assert_eq!(
            flags_for(|clip, _| clip.asset_id = "__text__title".to_string()),
            vec![SegmentFlagReason::TextClip]
        );
    }

    #[test]
    fn should_flag_a_caption_clip_on_a_caption_track() {
        assert_eq!(
            flags_for(|clip, track| {
                track.kind = TrackKind::Caption;
                clip.label = Some("Hello".to_string());
            }),
            vec![SegmentFlagReason::StyledCaption]
        );
    }

    #[test]
    fn should_flag_a_caption_clip_that_only_the_reserved_asset_id_identifies() {
        assert_eq!(
            flags_for(|clip, _| clip.asset_id = "caption".to_string()),
            vec![SegmentFlagReason::StyledCaption]
        );
    }

    #[test]
    fn should_flag_a_non_video_asset_when_the_clip_shows_an_image() {
        assert_eq!(
            flags_for(|clip, _| clip.asset_id = "img0".to_string()),
            vec![SegmentFlagReason::NonVideoAsset]
        );
    }

    #[test]
    fn should_flag_a_missing_asset_when_the_clip_resolves_to_nothing() {
        assert_eq!(
            flags_for(|clip, _| clip.asset_id = "gone".to_string()),
            vec![SegmentFlagReason::MissingAsset]
        );
    }

    #[test]
    fn should_flag_a_compound_clip_without_calling_its_asset_missing() {
        // A compound clip's asset id is synthetic and resolves to nothing by
        // design, so the missing-asset reason would be pure noise here.
        assert_eq!(
            flags_for(|clip, _| {
                clip.asset_id = format!("{}inner", Clip::COMPOUND_ASSET_PREFIX);
                clip.compound_sequence_id = Some("inner".to_string());
            }),
            vec![SegmentFlagReason::CompoundClip]
        );
    }

    #[test]
    fn should_flag_an_adjustment_layer_without_calling_its_asset_missing() {
        let grade = make_test_effect("fx-grade", EffectType::Saturation);
        let effects = HashMap::from([(grade.id.clone(), grade)]);
        assert_eq!(
            flags_with_effects(&effects, |clip, _| {
                clip.asset_id = Clip::ADJUSTMENT_LAYER_ASSET_ID.to_string();
                clip.is_adjustment_layer = true;
                clip.effects = vec!["fx-grade".to_string()];
            }),
            vec![
                SegmentFlagReason::ClipEffects,
                SegmentFlagReason::AdjustmentLayer
            ]
        );
    }

    #[test]
    fn should_not_flag_an_adjustment_layer_that_carries_no_effects() {
        // An empty adjustment layer composites nothing onto the clips below it,
        // so it changes no pixels in either path — and the export planner skips
        // it on the same `is_adjustment_layer && !effects.is_empty()` gate.
        assert_eq!(
            flags_for(|clip, _| {
                clip.asset_id = Clip::ADJUSTMENT_LAYER_ASSET_ID.to_string();
                clip.is_adjustment_layer = true;
            }),
            vec![]
        );
    }

    #[test]
    fn should_flag_overlay_track_media_because_export_refuses_it() {
        // The canvas preview composites overlay tracks; the export media walk
        // skips them and preflight rejects the sequence.
        assert_eq!(
            flags_for(|_, track| track.kind = TrackKind::Overlay),
            vec![SegmentFlagReason::OverlayTrackMedia]
        );
    }

    #[test]
    fn should_not_flag_overlay_track_media_for_a_text_clip_on_an_overlay_track() {
        // Text clips do reach the output from an overlay track, through the text
        // overlay walk — so they diverge as text, not as unrenderable media.
        assert_eq!(
            flags_for(|clip, track| {
                track.kind = TrackKind::Overlay;
                clip.asset_id = "__text__title".to_string();
            }),
            vec![SegmentFlagReason::TextClip]
        );
    }

    #[test]
    fn should_flag_a_caption_asset_clip_on_an_overlay_track_as_unrenderable_too() {
        // The overlay walk's caption arm keys on the caption *track* kind, so a
        // caption-asset clip parked on an overlay track is never burned — and
        // preflight rejects it as unsupported overlay media. Both facts are
        // true, and only the second one stops an automatic fill.
        let reasons = flags_for(|clip, track| {
            track.kind = TrackKind::Overlay;
            clip.asset_id = "caption".to_string();
        });

        assert_eq!(
            reasons,
            vec![
                SegmentFlagReason::StyledCaption,
                SegmentFlagReason::OverlayTrackMedia
            ]
        );
        assert!(!reasons.iter().all(SegmentFlagReason::fill_renderable));
    }

    #[test]
    fn should_flag_a_text_clip_on_a_hidden_video_track_because_export_still_burns_it() {
        // The text overlay walk gates on plain `contributes_to_output`, which
        // has no `visible` term — so a hidden but unmuted video track draws no
        // media and yet still burns its text. The live preview draws nothing.
        assert_eq!(
            flags_for(|clip, track| {
                track.visible = false;
                clip.asset_id = "__text__title".to_string();
            }),
            vec![SegmentFlagReason::TextClip]
        );
    }

    #[test]
    fn should_not_flag_a_caption_asset_clip_on_a_hidden_video_track() {
        // Only the caption *track* arm of the overlay walk draws caption clips;
        // a caption-asset clip on a video track falls through it, hidden or not.
        assert_eq!(
            flags_for(|clip, track| {
                track.visible = false;
                clip.asset_id = "caption".to_string();
            }),
            vec![]
        );
    }

    #[test]
    fn should_report_which_reasons_an_automatic_fill_can_actually_render() {
        // A reason the export path refuses is still a true warning, but a fill
        // that acted on it would retry a failing render forever.
        for reason in [
            SegmentFlagReason::CompoundClip,
            SegmentFlagReason::MissingAsset,
            SegmentFlagReason::OverlayTrackMedia,
        ] {
            assert!(!reason.fill_renderable(), "{reason:?} should not be filled");
        }

        for reason in [
            SegmentFlagReason::BlendMode,
            SegmentFlagReason::Transform,
            SegmentFlagReason::MotionKeyframes,
            SegmentFlagReason::Opacity,
            SegmentFlagReason::ClipEffects,
            SegmentFlagReason::Speed,
            SegmentFlagReason::Transition,
            SegmentFlagReason::TextClip,
            SegmentFlagReason::StyledCaption,
            SegmentFlagReason::NonVideoAsset,
            SegmentFlagReason::AdjustmentLayer,
        ] {
            assert!(reason.fill_renderable(), "{reason:?} should be fillable");
        }
    }

    #[test]
    fn should_not_flag_a_segment_when_the_offending_track_is_muted() {
        assert_eq!(
            flags_for(|clip, track| {
                track.muted = true;
                clip.opacity = 0.5;
            }),
            vec![]
        );
    }

    #[test]
    fn should_not_flag_a_segment_when_the_offending_video_track_is_hidden() {
        // `contributes_to_output` keeps a hidden video track for its audio, so
        // the picture-only rule has to AND in `visible` itself.
        assert_eq!(
            flags_for(|clip, track| {
                track.visible = false;
                clip.blend_mode = BlendMode::Multiply;
            }),
            vec![]
        );
    }

    #[test]
    fn should_not_flag_a_segment_for_a_clip_on_an_audio_track() {
        // Nothing on an audio track reaches the frame.
        assert_eq!(
            flags_for(|clip, track| {
                track.kind = TrackKind::Audio;
                clip.opacity = 0.5;
            }),
            vec![]
        );
    }

    #[test]
    fn should_not_flag_a_segment_for_a_disabled_clip() {
        assert_eq!(
            flags_for(|clip, _| {
                clip.enabled = false;
                clip.speed = 2.0;
            }),
            vec![]
        );
    }

    #[test]
    fn should_return_sorted_and_deduplicated_reasons_when_many_clips_offend() {
        // Two clips share a reason and each adds one of its own; the result must
        // not depend on the order they were walked in.
        let mut first = make_test_clip("c0", "a0", 0.0, 2.0);
        first.opacity = 0.5;
        first.speed = 2.0;
        let mut second = make_test_clip("c1", "a0", 2.0, 3.0);
        second.opacity = 0.25;
        second.blend_mode = BlendMode::Multiply;

        let track = make_test_track("t1", TrackKind::Video, vec![first, second]);
        let sequence = make_test_sequence("seq1", vec![track]);
        let reasons =
            classify_segment_window(&sequence, &flag_test_assets(), &HashMap::new(), 0.0, 5.0);

        assert_eq!(
            reasons,
            vec![
                SegmentFlagReason::BlendMode,
                SegmentFlagReason::Opacity,
                SegmentFlagReason::Speed,
            ]
        );
    }

    #[test]
    fn should_report_no_change_when_segment_flags_are_refreshed_twice() {
        let (mut sequence, assets) = four_segment_sequence();
        sequence.tracks[0].clips[2].opacity = 0.5;
        let effects = HashMap::new();

        let mut manifest =
            RenderCacheManifest::new("seq1", &preview_profile_hash(&test_canvas()), 20.0, 5.0);

        assert!(refresh_manifest_segment_flags(
            &mut manifest,
            &sequence,
            &assets,
            &effects
        ));
        assert!(manifest.segments[2].flagged());
        assert!(!manifest.segments[0].flagged());

        assert!(!refresh_manifest_segment_flags(
            &mut manifest,
            &sequence,
            &assets,
            &effects
        ));
    }

    #[test]
    fn should_not_demote_a_cached_segment_when_its_flags_change() {
        // Flags decide what gets filled automatically; only the fingerprint
        // decides whether what is already filled is still valid.
        let tmp = tempfile::tempdir().unwrap();
        let (sequence, assets) = four_segment_sequence();
        let effects = HashMap::new();
        let mut manifest = prepare_manifest(tmp.path(), &sequence, &assets, &effects, 20.0);
        cache_every_segment(&mut manifest);

        let mut edited = sequence.clone();
        edited.tracks[0].clips[2].blend_mode = BlendMode::Multiply;

        assert!(refresh_manifest_segment_flags(
            &mut manifest,
            &edited,
            &assets,
            &effects
        ));

        assert_eq!(
            manifest.segments[2].flag_reasons,
            vec![SegmentFlagReason::BlendMode]
        );
        assert!(manifest
            .segments
            .iter()
            .all(|segment| segment.state == CacheSegmentState::Cached));
    }

    #[test]
    fn should_carry_segment_flags_through_a_layout_reconcile() {
        let (mut sequence, assets) = four_segment_sequence();
        sequence.tracks[0].clips[1].opacity = 0.5;
        let mut manifest =
            RenderCacheManifest::new("seq1", &preview_profile_hash(&test_canvas()), 20.0, 5.0);
        refresh_manifest_segment_flags(&mut manifest, &sequence, &assets, &HashMap::new());
        assert!(manifest.segments[1].flagged());

        // A duration change that keeps segment 1's range keeps its flags too.
        manifest.reconcile_with_sequence(25.0, 5.0, InterruptedRenderPolicy::Reset);

        assert_eq!(
            manifest.segments[1].flag_reasons,
            vec![SegmentFlagReason::Opacity]
        );
        // The range that did not exist before starts unflagged.
        assert!(!manifest.segments[4].flagged());
    }

    #[test]
    fn should_roundtrip_segment_flags_through_the_saved_manifest() {
        let tmp = tempfile::tempdir().unwrap();
        let mut manifest =
            RenderCacheManifest::new("seq1", &preview_profile_hash(&test_canvas()), 10.0, 5.0);
        manifest.segments[0].flag_reasons =
            vec![SegmentFlagReason::BlendMode, SegmentFlagReason::TextClip];

        save_manifest(tmp.path(), &manifest).unwrap();
        let loaded = load_manifest(tmp.path(), "seq1").unwrap().unwrap();

        assert_eq!(
            loaded.segments[0].flag_reasons,
            vec![SegmentFlagReason::BlendMode, SegmentFlagReason::TextClip]
        );
        assert!(!loaded.segments[1].flagged());
    }

    #[test]
    fn should_deserialize_a_segment_written_before_flags_existed() {
        let json = r#"{
            "index": 0,
            "startSec": 0.0,
            "endSec": 5.0,
            "state": "cached",
            "fingerprint": 4242,
            "cachedFile": "segment_0000.mov",
            "fileSizeBytes": 2048
        }"#;

        let segment: RenderCacheSegment = serde_json::from_str(json).unwrap();

        assert!(!segment.flagged());
        assert_eq!(segment.flag_reasons, vec![]);
    }
}
