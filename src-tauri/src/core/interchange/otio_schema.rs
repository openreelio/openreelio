//! OpenTimelineIO wire schema — the narrow subset OpenReelio reads and writes.
//!
//! [OpenTimelineIO](https://opentimeline.io/) is the Academy Software
//! Foundation's editorial interchange format. Every node in an OTIO file is a
//! JSON object carrying an `OTIO_SCHEMA` string such as `"Timeline.1"`, and the
//! format as a whole is far wider than anything a cut interchange needs.
//!
//! These types cover **cut interchange only**: tracks, clips, gaps, two-input
//! transitions, markers and external media references. Effects, transforms,
//! captions, text, opacity, blend modes and time remapping have no
//! representation here and do not survive a round trip — see
//! [`super::otio`] and [`super::otio_import`], which report every such loss
//! rather than dropping it silently.
//!
//! These are **wire types**, not IPC types: they deliberately do not derive
//! `specta::Type`, because nothing in the frontend bindings should be shaped by
//! a foreign file format.
//!
//! ## Schema versions
//!
//! Reading is strict. A node whose `OTIO_SCHEMA` is not one this build
//! understands is rejected with the offending schema string in the error,
//! because silently treating an unknown `Clip.7` as a `Clip.2` would produce a
//! timeline that looks plausible and is wrong.

use serde::de::Error as DeError;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value as JsonValue};

/// Metadata namespace OpenReelio stashes its lossless extras under.
///
/// Foreign tools see standard OTIO and ignore this key; our own importer reads
/// it to restore detail the standard schema cannot carry (exact track kind,
/// original ids, the real transition type behind a `"Custom"`).
pub const OPENREELIO_METADATA_KEY: &str = "openreelio";

/// Returns an empty JSON object — the default for every `metadata` field.
pub fn empty_metadata() -> JsonValue {
    JsonValue::Object(Map::new())
}

/// Declares the validating `OTIO_SCHEMA` deserializer for one node type, and —
/// in the `write` form — the canonical string its constructor stamps. The first
/// literal is what we write; the rest are additionally accepted on read.
///
/// No form declares a serde `default`. `OTIO_SCHEMA` is the discriminator that
/// says what a node *is*, so a node that omits it is a node this build cannot
/// identify; defaulting it would let a `{"value": …, "rate": …}` blob through as
/// a `RationalTime` and read a foreign file by guessing.
macro_rules! otio_schema {
    // A node this build both reads and writes.
    (write $default_fn:ident, $de_fn:ident, $canonical:literal $(, $also:literal)*) => {
        /// The `OTIO_SCHEMA` string this build stamps on the node it writes.
        pub(super) fn $default_fn() -> String {
            $canonical.to_string()
        }

        otio_schema!(read $de_fn, $canonical $(, $also)*);
    };
    // A node this build only reads, so it needs no canonical string.
    (read $de_fn:ident, $canonical:literal $(, $also:literal)*) => {
        fn $de_fn<'de, D>(deserializer: D) -> Result<String, D::Error>
        where
            D: Deserializer<'de>,
        {
            const ACCEPTED: &[&str] = &[$canonical $(, $also)*];
            let raw = String::deserialize(deserializer)?;
            if ACCEPTED.contains(&raw.as_str()) {
                Ok(raw)
            } else {
                Err(DeError::custom(format!(
                    "unsupported OTIO_SCHEMA \"{}\": this build reads {}",
                    raw,
                    ACCEPTED.join(" or ")
                )))
            }
        }
    };
}

otio_schema!(write schema_timeline, de_schema_timeline, "Timeline.1");
otio_schema!(write schema_stack, de_schema_stack, "Stack.1");
otio_schema!(write schema_track, de_schema_track, "Track.1");
otio_schema!(write schema_clip, de_schema_clip, "Clip.2", "Clip.1");
otio_schema!(write schema_gap, de_schema_gap, "Gap.1");
otio_schema!(write schema_transition, de_schema_transition, "Transition.1");
otio_schema!(write schema_marker, de_schema_marker, "Marker.1", "Marker.2");
otio_schema!(
    write schema_external_reference,
    de_schema_external_reference,
    "ExternalReference.1"
);
otio_schema!(
    write schema_missing_reference,
    de_schema_missing_reference,
    "MissingReference.1"
);
otio_schema!(read de_schema_image_sequence_reference, "ImageSequenceReference.1");
otio_schema!(
    write schema_rational_time,
    de_schema_rational_time,
    "RationalTime.1"
);
otio_schema!(write schema_time_range, de_schema_time_range, "TimeRange.1");

// =============================================================================
// Time
// =============================================================================

/// A time expressed as a count of ticks at an explicit rate.
///
/// The rate is per-node in OTIO, so a foreign file can mix rates within one
/// timeline. Always convert through [`RationalTime::to_seconds`] rather than
/// assuming the sequence frame rate.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RationalTime {
    #[serde(rename = "OTIO_SCHEMA", deserialize_with = "de_schema_rational_time")]
    pub otio_schema: String,
    pub value: f64,
    pub rate: f64,
}

impl RationalTime {
    /// Creates a time of `value` ticks at `rate` ticks per second.
    pub fn new(value: f64, rate: f64) -> Self {
        Self {
            otio_schema: schema_rational_time(),
            value,
            rate,
        }
    }

    /// Converts to seconds using this node's own rate.
    ///
    /// Returns `0.0` for a non-positive or non-finite rate rather than an
    /// infinity that would poison every downstream calculation.
    pub fn to_seconds(&self) -> f64 {
        if !self.rate.is_finite() || self.rate <= 0.0 || !self.value.is_finite() {
            return 0.0;
        }
        self.value / self.rate
    }
}

/// A half-open span `[start_time, start_time + duration)`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TimeRange {
    #[serde(rename = "OTIO_SCHEMA", deserialize_with = "de_schema_time_range")]
    pub otio_schema: String,
    pub start_time: RationalTime,
    pub duration: RationalTime,
}

impl TimeRange {
    /// Creates a range from a start time and a duration.
    pub fn new(start_time: RationalTime, duration: RationalTime) -> Self {
        Self {
            otio_schema: schema_time_range(),
            start_time,
            duration,
        }
    }

    /// Creates a range from frame counts at a single rate.
    pub fn from_frames(start_frame: i64, duration_frames: i64, rate: f64) -> Self {
        Self::new(
            RationalTime::new(start_frame as f64, rate),
            RationalTime::new(duration_frames as f64, rate),
        )
    }
}

// =============================================================================
// Media references
// =============================================================================

/// A media reference to a file on disk.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ExternalReference {
    #[serde(
        rename = "OTIO_SCHEMA",
        deserialize_with = "de_schema_external_reference"
    )]
    pub otio_schema: String,
    pub target_url: String,
    /// Span of media the file actually offers. Omitted when the source
    /// duration is unknown — an invented range is worse than none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub available_range: Option<TimeRange>,
    #[serde(default = "empty_metadata")]
    pub metadata: JsonValue,
}

impl ExternalReference {
    /// Creates a reference to `target_url` with an optional available range.
    pub fn new(target_url: String, available_range: Option<TimeRange>) -> Self {
        Self {
            otio_schema: schema_external_reference(),
            target_url,
            available_range,
            metadata: empty_metadata(),
        }
    }
}

/// The placeholder OTIO uses for a clip whose media is not known.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MissingReference {
    #[serde(
        rename = "OTIO_SCHEMA",
        deserialize_with = "de_schema_missing_reference"
    )]
    pub otio_schema: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub available_range: Option<TimeRange>,
    #[serde(default = "empty_metadata")]
    pub metadata: JsonValue,
}

impl Default for MissingReference {
    fn default() -> Self {
        Self {
            otio_schema: schema_missing_reference(),
            name: None,
            available_range: None,
            metadata: empty_metadata(),
        }
    }
}

/// A numbered-frame image sequence.
///
/// Parsed so a file carrying one is reported rather than rejected at the JSON
/// layer, then refused by name during import — OpenReelio has no image-sequence
/// asset kind to map it onto.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ImageSequenceReference {
    #[serde(
        rename = "OTIO_SCHEMA",
        deserialize_with = "de_schema_image_sequence_reference"
    )]
    pub otio_schema: String,
    #[serde(default)]
    pub target_url_base: String,
    #[serde(default)]
    pub name_prefix: String,
    #[serde(default)]
    pub name_suffix: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub available_range: Option<TimeRange>,
    #[serde(default = "empty_metadata")]
    pub metadata: JsonValue,
}

/// The media reference on a clip.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(untagged)]
pub enum OtioMediaRef {
    External(ExternalReference),
    Missing(MissingReference),
    ImageSequence(ImageSequenceReference),
}

impl OtioMediaRef {
    /// Human label for the reference kind, used in import diagnostics.
    pub fn kind_label(&self) -> &'static str {
        match self {
            Self::External(_) => "ExternalReference",
            Self::Missing(_) => "MissingReference",
            Self::ImageSequence(_) => "ImageSequenceReference",
        }
    }
}

impl<'de> Deserialize<'de> for OtioMediaRef {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = JsonValue::deserialize(deserializer)?;
        match read_schema(&value, "media_reference")? {
            "ExternalReference.1" => from_value(value).map(Self::External),
            "MissingReference.1" => from_value(value).map(Self::Missing),
            "ImageSequenceReference.1" => from_value(value).map(Self::ImageSequence),
            other => Err(DeError::custom(format!(
                "unsupported media_reference OTIO_SCHEMA \"{other}\": this build reads \
                 ExternalReference.1, MissingReference.1 or ImageSequenceReference.1"
            ))),
        }
    }
}

// =============================================================================
// Markers
// =============================================================================

/// A marker attached to a stack or track.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct OtioMarker {
    #[serde(rename = "OTIO_SCHEMA", deserialize_with = "de_schema_marker")]
    pub otio_schema: String,
    #[serde(default)]
    pub name: String,
    pub marked_range: TimeRange,
    /// One of OTIO's named marker colours (`RED`, `GREEN`, …).
    #[serde(default = "default_marker_color")]
    pub color: String,
    #[serde(default = "empty_metadata")]
    pub metadata: JsonValue,
}

fn default_marker_color() -> String {
    "RED".to_string()
}

impl OtioMarker {
    /// Creates a marker over `marked_range` with an OTIO colour name.
    pub fn new(name: String, marked_range: TimeRange, color: String) -> Self {
        Self {
            otio_schema: schema_marker(),
            name,
            marked_range,
            color,
            metadata: empty_metadata(),
        }
    }
}

// =============================================================================
// Composable track children
// =============================================================================

/// A clip: a span of one media reference placed on a track.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct OtioClip {
    #[serde(rename = "OTIO_SCHEMA", deserialize_with = "de_schema_clip")]
    pub otio_schema: String,
    #[serde(default)]
    pub name: String,
    /// Span read out of the media reference. Its `duration` is also the clip's
    /// extent on the track: an OTIO track's children are contiguous, so a
    /// child's duration is what advances the timeline cursor.
    pub source_range: TimeRange,
    pub media_reference: OtioMediaRef,
    #[serde(default)]
    pub markers: Vec<OtioMarker>,
    #[serde(default = "empty_metadata")]
    pub metadata: JsonValue,
}

/// A hole in a track. OTIO tracks are contiguous, so every hole is explicit.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct OtioGap {
    #[serde(rename = "OTIO_SCHEMA", deserialize_with = "de_schema_gap")]
    pub otio_schema: String,
    #[serde(default)]
    pub name: String,
    pub source_range: TimeRange,
    #[serde(default = "empty_metadata")]
    pub metadata: JsonValue,
}

impl OtioGap {
    /// Creates a gap of `duration_frames` at `rate`.
    pub fn of_frames(duration_frames: i64, rate: f64) -> Self {
        Self {
            otio_schema: schema_gap(),
            name: "gap".to_string(),
            source_range: TimeRange::from_frames(0, duration_frames, rate),
            metadata: empty_metadata(),
        }
    }
}

/// A two-input transition sitting between the children on either side of it.
///
/// A transition consumes no time of its own: `in_offset` reaches back into the
/// outgoing item and `out_offset` reaches forward into the incoming one, so the
/// timeline cursor does not advance across it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct OtioTransition {
    #[serde(rename = "OTIO_SCHEMA", deserialize_with = "de_schema_transition")]
    pub otio_schema: String,
    #[serde(default)]
    pub name: String,
    /// `SMPTE_Dissolve` or `Custom`; the real OpenReelio effect type is stashed
    /// under `metadata.openreelio.transitionType`.
    #[serde(default = "default_transition_type")]
    pub transition_type: String,
    pub in_offset: RationalTime,
    pub out_offset: RationalTime,
    #[serde(default = "empty_metadata")]
    pub metadata: JsonValue,
}

fn default_transition_type() -> String {
    "Custom".to_string()
}

/// One child of a track.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(untagged)]
pub enum OtioComposable {
    /// Boxed because a clip carries a media reference and is several times the
    /// size of a gap or a transition, and a track is mostly gaps and clips —
    /// an unboxed variant would pay the clip's size for every child.
    Clip(Box<OtioClip>),
    Gap(OtioGap),
    Transition(OtioTransition),
}

impl<'de> Deserialize<'de> for OtioComposable {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = JsonValue::deserialize(deserializer)?;
        match read_schema(&value, "track child")? {
            "Clip.1" | "Clip.2" => from_value(value).map(Box::new).map(Self::Clip),
            "Gap.1" => from_value(value).map(Self::Gap),
            "Transition.1" => from_value(value).map(Self::Transition),
            other => Err(DeError::custom(format!(
                "unsupported track child OTIO_SCHEMA \"{other}\": this build reads Clip.1, \
                 Clip.2, Gap.1 or Transition.1"
            ))),
        }
    }
}

// =============================================================================
// Track and stack
// =============================================================================

/// A track: an ordered, contiguous list of clips, gaps and transitions.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct OtioTrack {
    #[serde(rename = "OTIO_SCHEMA", deserialize_with = "de_schema_track")]
    pub otio_schema: String,
    #[serde(default)]
    pub name: String,
    /// `"Video"` or `"Audio"`. Kept as a string because a foreign file may name
    /// a kind this build does not map, which import reports rather than guesses.
    #[serde(default = "default_track_kind")]
    pub kind: String,
    #[serde(default)]
    pub children: Vec<OtioComposable>,
    #[serde(default)]
    pub markers: Vec<OtioMarker>,
    #[serde(default = "empty_metadata")]
    pub metadata: JsonValue,
}

fn default_track_kind() -> String {
    "Video".to_string()
}

/// One child of a stack.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(untagged)]
pub enum OtioTrackOrItem {
    Track(OtioTrack),
    /// A nested stack. Parsed so the file is readable, refused by import: a
    /// nested composition is not a flat cut.
    Stack(OtioStack),
}

impl<'de> Deserialize<'de> for OtioTrackOrItem {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = JsonValue::deserialize(deserializer)?;
        match read_schema(&value, "stack child")? {
            "Track.1" => from_value(value).map(Self::Track),
            "Stack.1" => from_value(value).map(Self::Stack),
            other => Err(DeError::custom(format!(
                "unsupported stack child OTIO_SCHEMA \"{other}\": this build reads Track.1 or \
                 Stack.1"
            ))),
        }
    }
}

/// A stack: tracks layered over one another, all starting at the same instant.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct OtioStack {
    #[serde(rename = "OTIO_SCHEMA", deserialize_with = "de_schema_stack")]
    pub otio_schema: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub children: Vec<OtioTrackOrItem>,
    #[serde(default)]
    pub markers: Vec<OtioMarker>,
    #[serde(default = "empty_metadata")]
    pub metadata: JsonValue,
}

impl OtioStack {
    /// Creates a stack named `name` holding `children`.
    pub fn new(name: String, children: Vec<OtioTrackOrItem>, markers: Vec<OtioMarker>) -> Self {
        Self {
            otio_schema: schema_stack(),
            name,
            children,
            markers,
            metadata: empty_metadata(),
        }
    }
}

/// The root node of an OTIO file.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct OtioTimeline {
    #[serde(rename = "OTIO_SCHEMA", deserialize_with = "de_schema_timeline")]
    pub otio_schema: String,
    #[serde(default)]
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub global_start_time: Option<RationalTime>,
    pub tracks: OtioStack,
    #[serde(default = "empty_metadata")]
    pub metadata: JsonValue,
}

impl OtioTimeline {
    /// Creates a timeline whose program starts at frame zero.
    pub fn new(name: String, rate: f64, tracks: OtioStack) -> Self {
        Self {
            otio_schema: schema_timeline(),
            name,
            global_start_time: Some(RationalTime::new(0.0, rate)),
            tracks,
            metadata: empty_metadata(),
        }
    }

    /// Returns the tracks the stack holds directly, skipping nested stacks.
    pub fn tracks_only(&self) -> impl Iterator<Item = &OtioTrack> {
        self.tracks.children.iter().filter_map(|child| match child {
            OtioTrackOrItem::Track(track) => Some(track),
            OtioTrackOrItem::Stack(_) => None,
        })
    }
}

// =============================================================================
// Internal helpers
// =============================================================================

/// Reads the `OTIO_SCHEMA` discriminator out of a raw node.
fn read_schema<'a, E: DeError>(value: &'a JsonValue, label: &str) -> Result<&'a str, E> {
    value
        .get("OTIO_SCHEMA")
        .and_then(JsonValue::as_str)
        .ok_or_else(|| DeError::custom(format!("{label} is missing its \"OTIO_SCHEMA\" field")))
}

/// Re-deserializes an already-parsed node into a concrete type.
fn from_value<T: for<'d> Deserialize<'d>, E: DeError>(value: JsonValue) -> Result<T, E> {
    serde_json::from_value(value).map_err(DeError::custom)
}

/// Reads `metadata.openreelio.<key>` as a string.
pub fn openreelio_meta_str<'a>(metadata: &'a JsonValue, key: &str) -> Option<&'a str> {
    metadata
        .get(OPENREELIO_METADATA_KEY)?
        .get(key)?
        .as_str()
        .filter(|value| !value.is_empty())
}

/// Reads `metadata.openreelio.<key>` as a bool.
pub fn openreelio_meta_bool(metadata: &JsonValue, key: &str) -> Option<bool> {
    metadata.get(OPENREELIO_METADATA_KEY)?.get(key)?.as_bool()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_clip_json() -> JsonValue {
        serde_json::json!({
            "OTIO_SCHEMA": "Clip.2",
            "name": "shot_a",
            "source_range": {
                "OTIO_SCHEMA": "TimeRange.1",
                "start_time": { "OTIO_SCHEMA": "RationalTime.1", "value": 24.0, "rate": 24.0 },
                "duration": { "OTIO_SCHEMA": "RationalTime.1", "value": 48.0, "rate": 24.0 }
            },
            "media_reference": {
                "OTIO_SCHEMA": "ExternalReference.1",
                "target_url": "file:///media/a.mp4",
                "metadata": {}
            },
            "markers": [],
            "metadata": {}
        })
    }

    #[test]
    fn should_round_trip_a_clip_through_json() {
        // Given: a clip node in OTIO's own encoding
        let parsed: OtioComposable =
            serde_json::from_value(sample_clip_json()).expect("clip should parse");

        // When: it is written back out
        let written = serde_json::to_value(&parsed).expect("clip should serialize");

        // Then: the encoding is unchanged
        assert_eq!(written, sample_clip_json());
    }

    #[test]
    fn should_discriminate_track_children_by_schema() {
        let gap: OtioComposable = serde_json::from_value(serde_json::json!({
            "OTIO_SCHEMA": "Gap.1",
            "name": "gap",
            "source_range": {
                "OTIO_SCHEMA": "TimeRange.1",
                "start_time": { "OTIO_SCHEMA": "RationalTime.1", "value": 0.0, "rate": 24.0 },
                "duration": { "OTIO_SCHEMA": "RationalTime.1", "value": 12.0, "rate": 24.0 }
            }
        }))
        .expect("gap should parse");

        assert!(matches!(gap, OtioComposable::Gap(_)));
    }

    #[test]
    fn should_reject_unknown_schema_version_naming_it() {
        let error = serde_json::from_value::<OtioComposable>(serde_json::json!({
            "OTIO_SCHEMA": "Clip.7",
            "name": "future",
        }))
        .expect_err("an unknown clip version should be rejected");

        assert!(
            error.to_string().contains("Clip.7"),
            "the error must name the schema it refused, got: {error}"
        );
    }

    #[test]
    fn should_reject_a_node_without_a_schema_field() {
        let error = serde_json::from_value::<OtioComposable>(serde_json::json!({ "name": "x" }))
            .expect_err("a node without OTIO_SCHEMA should be rejected");

        assert!(error.to_string().contains("OTIO_SCHEMA"));
    }

    #[test]
    fn should_reject_a_node_whose_schema_field_is_absent_rather_than_assuming_one() {
        // Given: a time blob with no OTIO_SCHEMA. Defaulting the discriminator
        // reads a foreign file by guessing what its nodes are.
        let error = serde_json::from_value::<RationalTime>(serde_json::json!({
            "value": 24.0,
            "rate": 24.0,
        }))
        .expect_err("a RationalTime without OTIO_SCHEMA should be rejected");
        assert!(error.to_string().contains("OTIO_SCHEMA"));

        let error = serde_json::from_value::<TimeRange>(serde_json::json!({
            "start_time": { "OTIO_SCHEMA": "RationalTime.1", "value": 0.0, "rate": 24.0 },
            "duration": { "OTIO_SCHEMA": "RationalTime.1", "value": 24.0, "rate": 24.0 },
        }))
        .expect_err("a TimeRange without OTIO_SCHEMA should be rejected");
        assert!(error.to_string().contains("OTIO_SCHEMA"));

        let error = serde_json::from_str::<OtioTimeline>(
            r#"{"name":"x","tracks":{"OTIO_SCHEMA":"Stack.1"}}"#,
        )
        .expect_err("a timeline without OTIO_SCHEMA should be rejected");
        assert!(error.to_string().contains("OTIO_SCHEMA"));
    }

    #[test]
    fn should_reject_a_timeline_whose_root_schema_is_unknown() {
        let error = serde_json::from_str::<OtioTimeline>(
            r#"{"OTIO_SCHEMA":"Timeline.9","name":"x","tracks":{"OTIO_SCHEMA":"Stack.1"}}"#,
        )
        .expect_err("an unknown timeline version should be rejected");

        assert!(error.to_string().contains("Timeline.9"));
    }

    #[test]
    fn should_convert_rational_time_using_its_own_rate() {
        // Given: a time expressed at 48fps inside a 24fps timeline
        let time = RationalTime::new(48.0, 48.0);

        // Then: it is one second, not two
        assert!((time.to_seconds() - 1.0).abs() < 1e-9);
    }

    #[test]
    fn should_treat_a_non_positive_rate_as_zero_seconds() {
        assert_eq!(RationalTime::new(10.0, 0.0).to_seconds(), 0.0);
        assert_eq!(RationalTime::new(10.0, f64::NAN).to_seconds(), 0.0);
    }

    #[test]
    fn should_default_optional_fields_when_absent() {
        let track: OtioTrack = serde_json::from_value(serde_json::json!({
            "OTIO_SCHEMA": "Track.1",
            "name": "V1"
        }))
        .expect("a minimal track should parse");

        assert_eq!(track.kind, "Video");
        assert!(track.children.is_empty());
        assert_eq!(track.metadata, empty_metadata());
    }

    #[test]
    fn should_omit_available_range_when_media_length_is_unknown() {
        let reference = ExternalReference::new("file:///a.mp4".to_string(), None);
        let json = serde_json::to_value(&reference).expect("reference should serialize");

        assert!(json.get("available_range").is_none());
    }

    #[test]
    fn should_read_the_openreelio_metadata_namespace() {
        let metadata = serde_json::json!({ "openreelio": { "clipId": "c1", "muted": true } });

        assert_eq!(openreelio_meta_str(&metadata, "clipId"), Some("c1"));
        assert_eq!(openreelio_meta_bool(&metadata, "muted"), Some(true));
        assert_eq!(openreelio_meta_str(&metadata, "absent"), None);
    }
}
