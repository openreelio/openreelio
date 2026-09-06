//! JSON Schema for the backend command payloads.
//!
//! An agent composing a command needs the payload's field names, their types,
//! which of them are required, and what an enum field accepts. Before this
//! module the only answer was the Rust source: `command schema` listed the
//! command *names* and nothing about their shapes, so a headless agent either
//! guessed a payload and read the parse error, or reverse-engineered one out of
//! a `verify` `suggestedFix`.
//!
//! The schemas are derived from the payload types themselves rather than
//! written out a second time. The serde attributes stay the source of truth:
//! `rename_all = "camelCase"` decides the property names, `Option<T>` decides
//! what is optional, `deny_unknown_fields` becomes `additionalProperties:
//! false`, and each field's doc comment becomes its `description`.
//!
//! What `schemars` cannot see is `#[serde(alias = "...")]` and the shapes a
//! hand written `Deserialize` reads off the wire. Left alone, that combination
//! produces a schema that formally forbids the very spelling a field's own
//! description recommends, so both are declared afterwards from the tables
//! below: every alias becomes a sibling property, and a required field with
//! more than one spelling is required through a group over them rather than by
//! name. The group is a `oneOf` for a `#[serde(alias)]` field, because serde
//! reads a second spelling as the same field twice and fails with `duplicate
//! field`; it is an `anyOf` only where the parser really does read two separate
//! properties, as `RippleDelete` reads `clipIds` and `clipId`. An *optional*
//! aliased field carries the same exclusivity as a `not` over the pairs.
//! Guards in [`super::payloads`] read the payload source and fail the build
//! when an alias reaches neither the doc comment nor the schema, or when the
//! table names a spelling the parser does not accept.
//!
//! A lookup also resolves the `commandType` aliases the `CommandPayload`
//! variants declare — `changeClipSpeed`, `freezeFrame`, `addTrack` — so the
//! surface an agent reads before composing a payload accepts every name the
//! two surfaces beside it accept.

use schemars::JsonSchema;
use serde_json::{json, Value};

/// Declares the backend command surface once.
///
/// Each entry pairs the canonical PascalCase command type an agent writes with
/// the payload struct it parses into. One table drives both the
/// `SUPPORTED_COMMAND_TYPES` list every surface advertises and the JSON Schema
/// lookup below, so a command can never appear in one and be missing from the
/// other.
macro_rules! declare_command_payloads {
    ($($command_type:literal => $payload:ty),* $(,)?) => {
        impl CommandPayload {
            /// Canonical PascalCase names of every command a JSON entry point accepts.
            pub const SUPPORTED_COMMAND_TYPES: &'static [&'static str] = &[$($command_type),*];
        }

        /// Returns the JSON Schema of one command's payload object.
        ///
        /// The command type is resolved the way the parser resolves it: the
        /// canonical PascalCase spelling
        /// [`CommandPayload::SUPPORTED_COMMAND_TYPES`] lists, or any of the
        /// alternative spellings the variants declare — see
        /// [`command_schema::canonical_command_type`]. `None` means the name is
        /// not a supported command. The schema is titled by the canonical name
        /// however it was asked for, and describes the `payload` object alone —
        /// the `commandType` wrapper is the caller's envelope, not part of it.
        ///
        /// [`command_schema::canonical_command_type`]: crate::ipc::command_schema::canonical_command_type
        pub fn command_payload_schema(command_type: &str) -> Option<serde_json::Value> {
            let canonical =
                $crate::ipc::command_schema::canonical_command_type(command_type)?;
            match canonical {
                $($command_type => Some(
                    $crate::ipc::command_schema::payload_schema::<$payload>($command_type)
                ),)*
                _ => None,
            }
        }

        /// The payload struct each command parses into, for the pairing guard.
        #[cfg(test)]
        pub(crate) const COMMAND_PAYLOAD_STRUCT_NAMES: &[(&str, &str)] =
            &[$(($command_type, stringify!($payload))),*];
    };
}

pub(crate) use declare_command_payloads;

/// Alternative `commandType` spellings the parser accepts, by canonical name.
///
/// `#[serde(alias = "…")]` on the `CommandPayload` variants makes
/// `changeClipSpeed`, `freezeFrame`, `addTrack`, `LiftEdit` and a hundred more
/// real command types: `command execute` runs them and `command validate`
/// accepts them. The schema lookup matched the canonical name alone, so the one
/// surface an agent reads *before* composing a payload answered "not a
/// supported command type" about names the two surfaces beside it accept.
///
/// Entries are `(spelling, canonical command type)`. A spelling that is already
/// the canonical name is left out: it is resolved by the exact match first. A
/// guard in [`super::payloads`] reads the enum's own attributes and fails when
/// this table and the source disagree in either direction.
pub(crate) const PAYLOAD_VARIANT_ALIASES: &[(&str, &str)] = &[
    ("AddCaption", "CreateCaption"),
    ("AddCaptionsFromTranscription", "ImportGeneratedCaptions"),
    ("AddTrack", "CreateTrack"),
    ("CreateCaptionsFromTranscript", "ImportGeneratedCaptions"),
    ("DeleteClip", "RemoveClip"),
    ("DeleteMarker", "RemoveMarker"),
    ("DeleteMask", "RemoveMask"),
    ("DeleteTrack", "RemoveTrack"),
    ("Extract", "ExtractEdit"),
    ("LiftEdit", "Lift"),
    ("StyleCaption", "UpdateCaption"),
    ("addAudioKeyframe", "AddAudioKeyframe"),
    ("addCaption", "CreateCaption"),
    ("addCaptionsFromTranscription", "ImportGeneratedCaptions"),
    ("addEffect", "AddEffect"),
    ("addMarker", "AddMarker"),
    ("addMask", "AddMask"),
    ("addTextClip", "AddTextClip"),
    ("addTrack", "CreateTrack"),
    ("applyAudioDucking", "ApplyAudioDucking"),
    ("changeClipSpeed", "SetClipSpeed"),
    ("clearTimeRemap", "ClearTimeRemap"),
    ("closeAllGaps", "CloseAllGaps"),
    ("closeGap", "CloseGap"),
    ("createAdjustmentLayer", "CreateAdjustmentLayer"),
    ("createCaption", "CreateCaption"),
    ("createCaptionsFromTranscript", "ImportGeneratedCaptions"),
    ("createCompoundClip", "CreateCompoundClip"),
    ("createFolder", "CreateFolder"),
    ("createFreezeFrame", "CreateFreezeFrame"),
    ("createSequence", "CreateSequence"),
    ("createTrack", "CreateTrack"),
    ("deleteCaption", "DeleteCaption"),
    ("deleteClip", "RemoveClip"),
    ("deleteFile", "DeleteFile"),
    ("deleteMarker", "RemoveMarker"),
    ("deleteMask", "RemoveMask"),
    ("deleteTrack", "RemoveTrack"),
    ("detachAudio", "DetachAudio"),
    ("extract", "ExtractEdit"),
    ("extractEdit", "ExtractEdit"),
    ("freezeFrame", "CreateFreezeFrame"),
    ("groupClips", "GroupClips"),
    ("importAsset", "ImportAsset"),
    ("importGeneratedCaptions", "ImportGeneratedCaptions"),
    ("insertClip", "InsertClip"),
    ("insertEdit", "InsertEdit"),
    ("insertMedia", "InsertMedia"),
    ("lift", "Lift"),
    ("liftEdit", "Lift"),
    ("linkClips", "LinkClips"),
    ("moveAudioKeyframe", "MoveAudioKeyframe"),
    ("moveClip", "MoveClip"),
    ("moveFile", "MoveFile"),
    ("overwriteEdit", "OverwriteEdit"),
    ("pasteAttributes", "PasteAttributes"),
    ("pasteEffects", "PasteEffects"),
    ("removeAsset", "RemoveAsset"),
    ("removeAttributes", "RemoveAttributes"),
    ("removeAudioKeyframe", "RemoveAudioKeyframe"),
    ("removeClip", "RemoveClip"),
    ("removeEffect", "RemoveEffect"),
    ("removeMarker", "RemoveMarker"),
    ("removeMask", "RemoveMask"),
    ("removeTextClip", "RemoveTextClip"),
    ("removeTrack", "RemoveTrack"),
    ("renameFile", "RenameFile"),
    ("renameTrack", "RenameTrack"),
    ("reorderTracks", "ReorderTracks"),
    ("reverseClip", "ReverseClip"),
    ("rippleDelete", "RippleDelete"),
    ("setAudioFadeIn", "SetAudioFadeIn"),
    ("setAudioFadeOut", "SetAudioFadeOut"),
    ("setAudioKeyframeValue", "SetAudioKeyframeValue"),
    ("setCaptionTrackLanguage", "SetCaptionTrackLanguage"),
    ("setClipAudio", "SetClipAudio"),
    ("setClipBlendMode", "SetClipBlendMode"),
    ("setClipEnabled", "SetClipEnabled"),
    ("setClipMotionKeyframes", "SetClipMotionKeyframes"),
    ("setClipMute", "SetClipMute"),
    ("setClipOpacity", "SetClipOpacity"),
    (
        "setClipSlowMotionInterpolation",
        "SetClipSlowMotionInterpolation",
    ),
    ("setClipSpeed", "SetClipSpeed"),
    ("setClipTransform", "SetClipTransform"),
    ("setMasterVolume", "SetMasterVolume"),
    ("setSequenceFormat", "SetSequenceFormat"),
    ("setTimeRemap", "SetTimeRemap"),
    ("setTrackBlendMode", "SetTrackBlendMode"),
    ("setTrackVolume", "SetTrackVolume"),
    ("splitClip", "SplitClip"),
    ("styleCaption", "UpdateCaption"),
    ("toggleTrackLock", "ToggleTrackLock"),
    ("toggleTrackMute", "ToggleTrackMute"),
    ("toggleTrackVisibility", "ToggleTrackVisibility"),
    ("trimClip", "TrimClip"),
    ("ungroupClips", "UngroupClips"),
    ("unlinkClips", "UnlinkClips"),
    ("unnestCompoundClip", "UnnestCompoundClip"),
    ("updateAsset", "UpdateAsset"),
    ("updateCaption", "UpdateCaption"),
    ("updateEffect", "UpdateEffect"),
    ("updateMask", "UpdateMask"),
    ("updateSequenceHdrSettings", "UpdateSequenceHdrSettings"),
    ("updateTextClip", "UpdateTextClip"),
];

/// Resolves a caller's `commandType` to the canonical name the tables are keyed by.
///
/// The exact canonical spelling wins first, then the alternative spellings the
/// `CommandPayload` variants declare; anything else is not a command and
/// answers `None`. Surrounding whitespace is trimmed, because
/// `CommandPayload::parse` trims it and the two have to agree about the same
/// name. The returned name is the one
/// [`CommandPayload::SUPPORTED_COMMAND_TYPES`] advertises.
pub fn canonical_command_type(command_type: &str) -> Option<&'static str> {
    let candidate = command_type.trim();
    let supported = super::CommandPayload::SUPPORTED_COMMAND_TYPES;

    if let Some(exact) = supported.iter().find(|name| **name == candidate) {
        return Some(exact);
    }

    let canonical = PAYLOAD_VARIANT_ALIASES
        .iter()
        .find(|(alias, _)| *alias == candidate)
        .map(|(_, canonical)| *canonical)?;

    supported.iter().find(|name| **name == canonical).copied()
}

/// The JSON Schema keyword that says whether `command execute` will run a
/// command, as opposed to merely parsing and validating it.
///
/// JSON Schema has no vocabulary for "this is real but not wired up yet", and
/// silently omitting the eight commands would take them away from `command
/// validate`, which does accept them. An `x-` keyword is the standard escape
/// hatch: a validator ignores it, and an agent reading the schema sees the
/// difference before it composes a payload that would be refused.
pub const EXECUTABLE_KEYWORD: &str = "x-openreelio-executable";

/// Command types every surface advertises that `CommandExecutor::execute`
/// still refuses.
///
/// Registering a command is only half of making it work: the op it appends
/// must also replay, and each of these needs more than an op-kind arm.
/// `SetTimeRemap`/`ClearTimeRemap` change a derived clip duration that the
/// payload does not carry; `RemoveAttributes`, `PasteEffects` and
/// `PasteAttributes` touch the effect registry and several clips at once;
/// `DetachAudio` and `CreateFreezeFrame` create clips (and possibly a track)
/// with runtime-generated ids their `to_json` drops; `ApplyAudioDucking` drops
/// its keyframes the same way. Registering them without fixing the logged
/// payload would trade a clean rejection for silent data loss on the next
/// reopen.
///
/// This list may only shrink. Adding to it means shipping a command the
/// executor cannot run. A guard in [`crate::core::commands::executor`] proves
/// each entry is still both supported and unregistered.
pub const NON_EXECUTABLE_COMMAND_TYPES: &[&str] = &[
    "ApplyAudioDucking",
    "ClearTimeRemap",
    "CreateFreezeFrame",
    "DetachAudio",
    "PasteAttributes",
    "PasteEffects",
    "RemoveAttributes",
    "SetTimeRemap",
];

/// The sentence appended to a non-executable command's schema description.
const NOT_EXECUTABLE_NOTE: &str = "This command is parseable and validatable, \
     but `command execute` refuses it until it is registered with the executor.";

/// Builds the JSON Schema of one payload type, titled by its command type.
///
/// The derived title is the Rust struct name (`UpdateCaptionPayload`), which is
/// not a name any caller can use. It is replaced by the command type so the
/// schema names the thing an agent actually writes into `commandType`.
///
/// Two things `schemars` cannot see are added afterwards: the alternative
/// spellings `#[serde(alias = "…")]` accepts, and the properties a hand written
/// `Deserialize` reads off the wire — see [`declare_wire_spellings`].
pub fn payload_schema<T: JsonSchema>(command_type: &str) -> Value {
    let generator = schemars::gen::SchemaSettings::draft07().into_generator();
    let root = generator.into_root_schema_for::<T>();

    // A `RootSchema` is plain data — maps, strings and bools — so this cannot
    // fail in practice. It is still not worth failing a whole schema listing
    // over one command: an empty object says "no shape known" honestly, and the
    // command's own name is still carried below.
    let mut value = serde_json::to_value(root).unwrap_or_else(|_| json!({}));

    if let Value::Object(object) = &mut value {
        // The derived title is the Rust type name, which is the key the wire
        // tables below are written against. Read it before it is replaced.
        let type_name = object
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();

        declare_wire_spellings(object, &type_name);

        if let Some(Value::Object(definitions)) = object.get_mut("definitions") {
            for (name, definition) in definitions.iter_mut() {
                let name = name.clone();
                if let Value::Object(definition) = definition {
                    declare_wire_spellings(definition, &name);
                }
            }
        }

        object.insert("title".to_string(), Value::String(command_type.to_string()));

        if NON_EXECUTABLE_COMMAND_TYPES.contains(&command_type) {
            object.insert(EXECUTABLE_KEYWORD.to_string(), Value::Bool(false));
            let description = match object.get("description").and_then(Value::as_str) {
                Some(existing) if !existing.trim().is_empty() => {
                    format!("{existing}\n\n{NOT_EXECUTABLE_NOTE}")
                }
                _ => NOT_EXECUTABLE_NOTE.to_string(),
            };
            object.insert("description".to_string(), Value::String(description));
        }
    }

    restore_fenced_examples(&mut value);

    value
}

/// Puts the line breaks back into every fenced JSON example in a schema.
///
/// `schemars` builds a description by flattening each paragraph of the doc
/// comment onto one line, which turns a worked payload example into a single
/// run-on line an agent has to re-indent in its head before it can read the
/// nesting. Every fenced `json` block is parsed and pretty-printed again, so
/// the example arrives shaped like the payload it is an example of. A fence
/// whose body is not valid JSON is left exactly as it was.
fn restore_fenced_examples(value: &mut Value) {
    match value {
        Value::Object(object) => {
            for (key, child) in object.iter_mut() {
                match (key.as_str(), child.as_str()) {
                    ("description", Some(text)) => {
                        if let Some(restored) = reindent_json_fences(text) {
                            *child = Value::String(restored);
                        }
                    }
                    _ => restore_fenced_examples(child),
                }
            }
        }
        Value::Array(entries) => entries.iter_mut().for_each(restore_fenced_examples),
        _ => {}
    }
}

/// Re-indents the fenced `json` blocks in one description, if it has any.
///
/// Returns `None` when there is nothing to do — no fences, an unclosed one, or
/// no fence whose body parses — so an untouched description keeps its exact
/// text rather than being rebuilt.
fn reindent_json_fences(description: &str) -> Option<String> {
    const FENCE: &str = "```";

    let parts: Vec<&str> = description.split(FENCE).collect();
    // An opening fence, a body and a closing fence split into three parts; an
    // even count means a fence was never closed.
    if parts.len() < 3 || parts.len().is_multiple_of(2) {
        return None;
    }

    let mut restored = String::with_capacity(description.len());
    let mut changed = false;

    for (index, part) in parts.iter().enumerate() {
        let is_fenced = index % 2 == 1;
        if !is_fenced {
            let prose = part.trim();
            if !prose.is_empty() {
                if !restored.is_empty() {
                    restored.push_str("\n\n");
                }
                restored.push_str(prose);
            }
            continue;
        }

        let body = part.strip_prefix("json").unwrap_or(part).trim();
        let pretty = serde_json::from_str::<Value>(body)
            .ok()
            .and_then(|parsed| serde_json::to_string_pretty(&parsed).ok());

        if !restored.is_empty() {
            restored.push_str("\n\n");
        }
        match pretty {
            Some(pretty) => {
                changed = true;
                restored.push_str("```json\n");
                restored.push_str(&pretty);
                restored.push_str("\n```");
            }
            None => {
                restored.push_str(FENCE);
                restored.push_str(part);
                restored.push_str(FENCE);
            }
        }
    }

    changed.then_some(restored)
}

/// Alternative spellings a payload field accepts, by the type that declares it.
///
/// `schemars` reads `rename_all` but never `#[serde(alias = "…")]`, so a schema
/// derived straight from the struct declares `additionalProperties: false`
/// while the parser happily accepts a spelling the property list does not name
/// — the schema would formally forbid exactly what the field's own description
/// recommends. Each entry is `(type, canonical property, other spellings)`, and
/// a guard in [`super::payloads`] reads the source to prove the table names
/// every alias the parser actually accepts.
pub(crate) const PAYLOAD_FIELD_ALIASES: &[(&str, &str, &[&str])] = &[
    ("InsertClipPayload", "timelineStart", &["timelineIn"]),
    ("InsertMediaPayload", "timelineStart", &["timelineIn"]),
    ("MoveClipPayload", "newTimelineIn", &["newStart"]),
    ("TrimClipPayload", "newSourceIn", &["newStart"]),
    ("TrimClipPayload", "newSourceOut", &["newEnd"]),
    ("SplitClipPayload", "splitTime", &["atTimelineSec"]),
    ("RenameTrackPayload", "newName", &["name"]),
    ("AddMarkerPayload", "timeSec", &["time"]),
    ("UpdateCaptionPayload", "captionId", &["clipId"]),
    ("UpdateCaptionPayload", "startSec", &["startTime"]),
    ("UpdateCaptionPayload", "endSec", &["endTime"]),
    ("CreateCaptionPayload", "startSec", &["startTime"]),
    ("CreateCaptionPayload", "endSec", &["endTime"]),
    (
        "GeneratedCaptionSegmentPayload",
        "startSec",
        &["startTime", "start"],
    ),
    (
        "GeneratedCaptionSegmentPayload",
        "endSec",
        &["endTime", "end"],
    ),
    ("GeneratedCaptionSegmentPayload", "speaker", &["speakerId"]),
    ("DeleteCaptionPayload", "captionId", &["clipId"]),
    ("AddEffectPayload", "params", &["parameters"]),
    // Declared on the private wire shape inside `AddTextClipPayload`'s hand
    // written `Deserialize`, which the source guard cannot reach.
    ("AddTextClipPayload", "timelineIn", &["timelineStart"]),
];

/// A property a hand written `Deserialize` reads that the struct does not carry.
///
/// These cannot be expressed as aliases: `RippleDelete`'s `clipId` is a single
/// string standing in for an array of them, and `affectAllTracks` is read and
/// thrown away. Without them the derived schema would be open where the parser
/// is closed, or closed against a spelling the parser accepts.
pub(crate) struct WireOnlyProperty {
    /// Rust type whose `Deserialize` reads this property.
    pub owner: &'static str,
    /// Property name, in the spelling the parser reads.
    pub name: &'static str,
    /// The JSON Schema `type` of the value the parser accepts.
    pub json_type: &'static str,
    /// What the property means, for the schema's `description`.
    pub description: &'static str,
    /// The required property this spelling stands in for, if any.
    pub satisfies: Option<&'static str>,
    /// How many entries the property named by `satisfies` needs before it
    /// satisfies the requirement without this stand-in.
    ///
    /// `RippleDelete` reads `clipIds` only when it is non-empty and falls
    /// through an empty one to `clipId`, so `{"clipIds": []}` on its own is a
    /// parse error and the canonical branch of the requirement has to say
    /// `minItems: 1` rather than merely `required`.
    pub satisfies_min_items: Option<u64>,
}

/// Every wire-only property, by the type that reads it.
pub(crate) const WIRE_ONLY_PROPERTIES: &[WireOnlyProperty] = &[
    WireOnlyProperty {
        owner: "RippleDeletePayload",
        name: "clipId",
        json_type: "string",
        description: "A single clip to remove, instead of `clipIds`. Exactly one \
                      of the two has to name a clip: a non-empty `clipIds` wins, \
                      and an empty or absent one falls back to this.",
        satisfies: Some("clipIds"),
        satisfies_min_items: Some(1),
    },
    WireOnlyProperty {
        owner: "RippleDeletePayload",
        name: "affectAllTracks",
        json_type: "boolean",
        description: "Deprecated and ignored. Accepted so an older caller is not \
                      refused; ripple delete only ever touched `trackId`.",
        satisfies: None,
        satisfies_min_items: None,
    },
];

/// A requirement one payload's parse step enforces that its field types do not.
///
/// `AddTextClip` takes `textData` or a `preset` — each optional on its own,
/// because either supplies what the other leaves out — and refuses a payload
/// carrying neither. `AddEffect` reads `effectType` or a `recipe` the same way.
/// Neither shows up in `required`, so a schema derived from the struct alone
/// accepts a payload `command validate` refuses.
///
/// Each entry becomes an `anyOf` over its branches. Sending both is fine only
/// when the two agree: `AddTextClip` merges an explicit `textData` over its
/// `preset` key by key, while `AddEffect` refuses a `recipe` beside an
/// `effectType` the recipe does not apply, because the two express
/// contradictory intent rather than an override.
///
/// A branch requires its property to carry a value: every one of these
/// properties is nullable, so `required` alone would call
/// `{"effectType": null}` a satisfied branch while the parser reads it as the
/// absent field it is.
pub(crate) struct EitherOrRequirement {
    /// Rust type whose parsing enforces it.
    pub owner: &'static str,
    /// The branches, at least one of which has to hold.
    ///
    /// The first one has to be the branch a caller can satisfy out of the
    /// payload alone: the schema-minimal sweep in [`super::payloads`] builds
    /// its sample from it, and a curated `preset` or `recipe` id is a lookup
    /// into a registry the sweep cannot invent an entry for.
    pub branches: &'static [EitherOrBranch],
}

/// One way of satisfying an [`EitherOrRequirement`].
///
/// A branch is normally just a property that has to be present. `AddTextClip`
/// is the one that needs more: without a `preset` there is nothing to merge a
/// partial `textData` onto, so the object itself has to be complete, and a
/// schema that only said "textData or preset" would still accept `{}`.
pub(crate) struct EitherOrBranch {
    /// The property whose presence takes this branch.
    pub property: &'static str,
    /// Properties the value must then carry itself.
    pub value_requires: &'static [&'static str],
    /// Properties each named sub-object of the value must then carry.
    pub nested_requires: &'static [(&'static str, &'static [&'static str])],
}

impl EitherOrBranch {
    /// A branch that is satisfied by the property being present at all.
    const fn present(property: &'static str) -> Self {
        Self {
            property,
            value_requires: &[],
            nested_requires: &[],
        }
    }
}

/// Every either/or requirement, by the type that enforces it.
pub(crate) const PAYLOAD_EITHER_OR_REQUIREMENTS: &[EitherOrRequirement] = &[
    EitherOrRequirement {
        owner: "AddTextClipPayload",
        branches: &[
            EitherOrBranch {
                property: "textData",
                value_requires: &["content", "style", "position"],
                nested_requires: &[
                    ("style", &["fontFamily", "fontSize", "color"]),
                    ("position", &["x", "y"]),
                ],
            },
            EitherOrBranch::present("preset"),
        ],
    },
    EitherOrRequirement {
        owner: "AddEffectPayload",
        branches: &[
            EitherOrBranch::present("effectType"),
            EitherOrBranch::present("recipe"),
        ],
    },
];

impl EitherOrRequirement {
    /// The `anyOf` group this requirement states.
    ///
    /// Every branch pairs `required` with a `not: {"type": "null"}` on the
    /// property it takes: the properties are all nullable, so `required` on its
    /// own is satisfied by an explicit `null` the parser then reads as the
    /// missing field it is. A branch that descends into the value also states
    /// `"type": "object"` beside the `required` it imposes, because `required`
    /// says nothing at all about a value that is not an object —
    /// `{"style": "nope"}` would otherwise pass a check the parser fails.
    fn group(&self) -> Value {
        let branches: Vec<Value> = self
            .branches
            .iter()
            .map(|branch| {
                let mut value = serde_json::Map::new();
                value.insert("not".to_string(), json!({ "type": "null" }));

                if !branch.value_requires.is_empty() {
                    value.insert("type".to_string(), json!("object"));
                    value.insert("required".to_string(), json!(branch.value_requires));
                }
                if !branch.nested_requires.is_empty() {
                    value.insert("type".to_string(), json!("object"));
                    let nested: serde_json::Map<String, Value> = branch
                        .nested_requires
                        .iter()
                        .map(|(name, names)| {
                            (
                                (*name).to_string(),
                                json!({ "type": "object", "required": names }),
                            )
                        })
                        .collect();
                    value.insert("properties".to_string(), Value::Object(nested));
                }

                json!({
                    "required": [branch.property],
                    "properties": { branch.property: Value::Object(value) },
                })
            })
            .collect();

        json!({ "anyOf": branches })
    }
}

/// One property and every spelling of it the parser accepts.
struct SpellingGroup {
    /// The canonical property name, as `rename_all` spells it.
    canonical: String,
    /// Every accepted spelling, the canonical one first.
    spellings: Vec<String>,
    /// Whether sending two of these spellings at once is refused.
    ///
    /// A `#[serde(alias)]` group is exclusive: serde reads the second spelling
    /// as the same field a second time and fails with `duplicate field`. A
    /// wire-only stand-in is not, because the hand written `Deserialize` reads
    /// it as its own field and picks between them — `RippleDelete` takes
    /// `clipIds` and `clipId` together without complaint.
    exclusive: bool,
    /// What the canonical spelling has to look like to satisfy the requirement
    /// on its own, beyond merely being present.
    canonical_constraints: Option<Value>,
}

impl SpellingGroup {
    /// The requirement group for a field the parser will not do without.
    ///
    /// `oneOf` when the spellings are mutually exclusive, so a payload carrying
    /// two of them fails against the schema exactly as it fails against serde;
    /// `anyOf` where the parser really does accept both at once.
    fn required_group(&self) -> Value {
        let options: Vec<Value> = self
            .spellings
            .iter()
            .map(|spelling| {
                let mut option = json!({ "required": [spelling] });
                match (&self.canonical_constraints, option.as_object_mut()) {
                    (Some(constraints), Some(option)) if *spelling == self.canonical => {
                        option.insert(
                            "properties".to_string(),
                            json!({ spelling.as_str(): constraints }),
                        );
                    }
                    _ => {}
                }
                option
            })
            .collect();

        if self.exclusive {
            json!({ "oneOf": options })
        } else {
            json!({ "anyOf": options })
        }
    }

    /// The exclusivity constraint for a field that is optional but aliased.
    ///
    /// An optional aliased field never reaches `required`, so nothing in the
    /// schema said that `newSourceIn` and `newStart` cannot both be sent —
    /// while serde refuses the pair as a duplicate field. `None` when there is
    /// nothing to forbid.
    fn at_most_one(&self) -> Option<Value> {
        if !self.exclusive {
            return None;
        }

        let mut pairs: Vec<Value> = Vec::new();
        for (index, first) in self.spellings.iter().enumerate() {
            for second in &self.spellings[index + 1..] {
                pairs.push(json!({ "allOf": [{ "required": [first] }, { "required": [second] }] }));
            }
        }

        match pairs.len() {
            0 => None,
            1 => pairs.pop().map(|only| json!({ "not": only })),
            _ => Some(json!({ "not": { "anyOf": pairs } })),
        }
    }
}

/// Adds the spellings the parser accepts but `schemars` cannot derive.
///
/// Each alternative spelling becomes a sibling property carrying the same
/// subschema as the canonical one, so `additionalProperties: false` stops
/// forbidding what the field's description recommends. The requirement itself
/// moves out of `required` and into a group over the spellings that satisfy it:
/// saying `required: ["captionId"]` while accepting `clipId` would be a
/// different lie in the same place.
fn declare_wire_spellings(object: &mut serde_json::Map<String, Value>, type_name: &str) {
    if type_name.is_empty() {
        return;
    }

    let mut groups: Vec<SpellingGroup> = Vec::new();

    let Some(Value::Object(properties)) = object.get_mut("properties") else {
        return;
    };

    for (_, canonical, aliases) in PAYLOAD_FIELD_ALIASES
        .iter()
        .filter(|(owner, ..)| *owner == type_name)
    {
        let Some(canonical_schema) = properties.get(*canonical).cloned() else {
            continue;
        };
        for alias in aliases.iter() {
            properties.insert(
                (*alias).to_string(),
                alias_property(&canonical_schema, canonical),
            );
        }
        let mut spellings = vec![(*canonical).to_string()];
        spellings.extend(aliases.iter().map(|alias| (*alias).to_string()));
        groups.push(SpellingGroup {
            canonical: (*canonical).to_string(),
            spellings,
            exclusive: true,
            canonical_constraints: None,
        });
    }

    for extra in WIRE_ONLY_PROPERTIES
        .iter()
        .filter(|extra| extra.owner == type_name)
    {
        properties.insert(
            extra.name.to_string(),
            json!({ "type": extra.json_type, "description": extra.description }),
        );
        let Some(canonical) = extra.satisfies else {
            continue;
        };
        let constraints = extra
            .satisfies_min_items
            .map(|minimum| json!({ "minItems": minimum }));
        match groups.iter_mut().find(|group| group.canonical == canonical) {
            // A stand-in the parser reads as a field of its own can be sent
            // beside the spellings it substitutes for, so a group it joins
            // stops being mutually exclusive.
            Some(group) => {
                group.spellings.push(extra.name.to_string());
                group.exclusive = false;
                if constraints.is_some() {
                    group.canonical_constraints = constraints;
                }
            }
            None => groups.push(SpellingGroup {
                canonical: canonical.to_string(),
                spellings: vec![canonical.to_string(), extra.name.to_string()],
                exclusive: false,
                canonical_constraints: constraints,
            }),
        }
    }

    let either_or: Vec<Value> = PAYLOAD_EITHER_OR_REQUIREMENTS
        .iter()
        .filter(|requirement| requirement.owner == type_name)
        .filter(|requirement| {
            // A requirement naming a property this type no longer has would
            // forbid every payload; the guard in `super::payloads` fails on it
            // rather than letting it ship, and this keeps the schema honest
            // meanwhile.
            requirement
                .branches
                .iter()
                .all(|branch| properties.contains_key(branch.property))
        })
        .map(EitherOrRequirement::group)
        .collect();

    declare_requirements(object, &groups, either_or);
}

/// Copies a canonical property's subschema for one of its other spellings.
///
/// A bare `$ref` is wrapped in an `allOf` first, because draft-07 ignores every
/// sibling of `$ref` — including the `description` that says which property
/// this spells.
fn alias_property(canonical_schema: &Value, canonical: &str) -> Value {
    let note = format!(
        "Alternative spelling of `{canonical}`; the two mean the same thing. Send only one of \
         them — a payload carrying both spellings is refused as a duplicate field."
    );

    let mut alias = match canonical_schema.get("$ref") {
        Some(reference) => json!({ "allOf": [{ "$ref": reference }] }),
        None => canonical_schema.clone(),
    };

    if let Value::Object(object) = &mut alias {
        let description = match object.get("description").and_then(Value::as_str) {
            Some(existing) if !existing.trim().is_empty() => format!("{note}\n\n{existing}"),
            _ => note,
        };
        object.insert("description".to_string(), Value::String(description));
    }

    alias
}

/// Moves every requirement `required` cannot state into an `allOf` of groups.
///
/// The remaining `required` list keeps every property that is spelled exactly
/// one way and needed by that name, so the common reading of a schema is
/// unchanged. What moves is the handful of fields with a second spelling, plus
/// the either/or requirements a parse step enforces; an *optional* field with a
/// second spelling adds no requirement at all, only the `not` that says the two
/// spellings cannot both be sent.
fn declare_requirements(
    object: &mut serde_json::Map<String, Value>,
    spelling_groups: &[SpellingGroup],
    either_or: Vec<Value>,
) {
    if spelling_groups.is_empty() && either_or.is_empty() {
        return;
    }

    let mut required: Vec<String> = object
        .get("required")
        .and_then(Value::as_array)
        .map(|names| {
            names
                .iter()
                .filter_map(Value::as_str)
                .map(ToOwned::to_owned)
                .collect()
        })
        .unwrap_or_default();

    let mut groups: Vec<Value> = Vec::new();
    for group in spelling_groups {
        match required.iter().position(|name| *name == group.canonical) {
            Some(position) => {
                required.remove(position);
                groups.push(group.required_group());
            }
            None => groups.extend(group.at_most_one()),
        }
    }
    groups.extend(either_or);

    if groups.is_empty() {
        return;
    }

    if required.is_empty() {
        object.remove("required");
    } else {
        object.insert("required".to_string(), json!(required));
    }

    match object.get_mut("allOf").and_then(Value::as_array_mut) {
        Some(existing) => existing.extend(groups),
        None => {
            object.insert("allOf".to_string(), Value::Array(groups));
        }
    }
}

/// Returns every supported command's payload schema.
///
/// The shape matches what a single-command lookup returns, so a caller reading
/// one schema and a caller reading all of them parse the same entries:
///
/// ```json
/// { "count": 80, "schemas": [{ "commandType": "InsertClip", "schema": { … } }] }
/// ```
pub fn all_command_payload_schemas() -> Value {
    let schemas: Vec<Value> = super::CommandPayload::SUPPORTED_COMMAND_TYPES
        .iter()
        .filter_map(|command_type| {
            super::command_payload_schema(command_type)
                .map(|schema| command_schema_entry(command_type, schema))
        })
        .collect();

    json!({ "count": schemas.len(), "schemas": schemas })
}

/// Wraps one derived schema in the `{ commandType, schema }` entry every
/// surface returns, so the CLI, the MCP tool and the IPC bridge cannot drift
/// about what a schema lookup looks like. An entry asked for by an alternative
/// spelling also carries `canonicalType`, added by the caller that resolved it.
pub fn command_schema_entry(command_type: &str, schema: Value) -> Value {
    json!({ "commandType": command_type, "schema": schema })
}

/// Looks up the schemas for a list of command types.
///
/// Returns the same `{ count, schemas }` shape as
/// [`all_command_payload_schemas`], or the first unsupported name's error, so
/// an agent that misspells one type in a batch is told which one. Alternative
/// spellings are resolved the way the parser resolves them, and an entry asked
/// for by one carries `canonicalType` beside the name it was asked for. Two
/// spellings of the same command are answered once: these schemas are large,
/// and a duplicate spends an agent's context without telling it anything new.
pub fn command_payload_schemas(command_types: &[String]) -> Result<Value, String> {
    let mut schemas = Vec::with_capacity(command_types.len());
    let mut seen: Vec<&str> = Vec::with_capacity(command_types.len());
    for command_type in command_types {
        let command_type = command_type.trim();
        let canonical = canonical_command_type(command_type)
            .ok_or_else(|| unsupported_command_type_error(command_type))?;
        let schema = super::command_payload_schema(canonical)
            .ok_or_else(|| unsupported_command_type_error(command_type))?;
        if seen.contains(&canonical) {
            continue;
        }
        seen.push(canonical);

        let mut entry = command_schema_entry(command_type, schema);
        if canonical != command_type {
            if let Some(entry) = entry.as_object_mut() {
                entry.insert("canonicalType".to_string(), json!(canonical));
            }
        }
        schemas.push(entry);
    }

    Ok(json!({ "count": schemas.len(), "schemas": schemas }))
}

/// Explains that a command type is not supported, naming the closest match.
///
/// A bare "not supported" leaves an agent to diff its spelling against eighty
/// names. The common failures are a plural, a case slip and a synonym, all of
/// which land within one or two edits of the real name.
pub fn unsupported_command_type_error(command_type: &str) -> String {
    let suggestions = closest_command_types(command_type);
    match suggestions.split_first() {
        Some((only, [])) => format!(
            "'{command_type}' is not a supported command type. Did you mean '{only}'? \
             Run 'command schema' for the full list."
        ),
        Some(_) => {
            let names = suggestions
                .iter()
                .map(|name| format!("'{name}'"))
                .collect::<Vec<_>>()
                .join(", ");
            format!(
                "'{command_type}' is not a supported command type. Did you mean one of: {names}? \
                 Run 'command schema' for the full list."
            )
        }
        None => format!(
            "'{command_type}' is not a supported command type. \
             Run 'command schema' for the full list."
        ),
    }
}

/// Names every supported command type closest to a caller's spelling.
///
/// A case-only difference is answered first, because `updatecaption` is a
/// spelling the parser itself would reject while meaning exactly one command.
/// Otherwise the nearest names by edit distance win, and only when they are
/// close enough that the caller plausibly meant one — a third of the name's
/// length, so a short name needs a near-exact match and a long one tolerates a
/// word.
///
/// Ties are all returned rather than broken. `RemoveCaption` is exactly as far
/// from `DeleteCaption` as from `CreateCaption`, and picking one by list order
/// suggested creating a caption to an agent trying to delete one — the opposite
/// operation, in a sentence that reads like an answer. Several names in list
/// order is the honest reply.
///
/// Every alternative spelling in [`PAYLOAD_VARIANT_ALIASES`] is scored beside
/// the canonical list, because an agent that lowercased `addTrack` meant a real
/// command and measuring only against `CreateTrack` put it out of reach. The
/// suggestion is always the canonical name the spelling resolves to: naming
/// `addTrack` back would answer a synonym instead of the command.
pub fn closest_command_types(command_type: &str) -> Vec<&'static str> {
    let candidate = command_type.trim();
    if candidate.is_empty() {
        return Vec::new();
    }

    let supported = super::CommandPayload::SUPPORTED_COMMAND_TYPES;
    let spellings = || {
        supported.iter().copied().chain(
            PAYLOAD_VARIANT_ALIASES
                .iter()
                .map(|(spelling, _)| *spelling),
        )
    };

    if let Some(matched) = spellings()
        .find(|spelling| spelling.eq_ignore_ascii_case(candidate))
        .and_then(canonical_command_type)
    {
        return vec![matched];
    }

    // One entry per command, keeping the spelling that came closest: several
    // spellings of one command are one suggestion, and the shortest of them is
    // what the tolerance below is measured against.
    let lowered = candidate.to_ascii_lowercase();
    let mut scored: Vec<(&'static str, &'static str, usize)> = Vec::new();
    for spelling in spellings() {
        let Some(canonical) = canonical_command_type(spelling) else {
            continue;
        };
        let distance = edit_distance(&lowered, &spelling.to_ascii_lowercase());
        match scored.iter_mut().find(|(seen, ..)| *seen == canonical) {
            Some(entry) if distance < entry.2 => *entry = (canonical, spelling, distance),
            Some(_) => {}
            None => scored.push((canonical, spelling, distance)),
        }
    }

    let Some(best) = scored.iter().map(|(_, _, distance)| *distance).min() else {
        return Vec::new();
    };

    let tied: Vec<(&'static str, &'static str)> = scored
        .iter()
        .filter(|(_, _, distance)| *distance == best)
        .map(|(canonical, spelling, _)| (*canonical, *spelling))
        .collect();

    // The tolerance is measured against the shortest tied spelling, which is
    // the strictest of them: a five-edit hop is a guess even when one candidate
    // happens to be long.
    let shortest = tied
        .iter()
        .map(|(_, spelling)| spelling.len())
        .min()
        .unwrap_or(0);
    let tolerance = (shortest / 3).max(2);
    if best <= tolerance {
        tied.into_iter().map(|(canonical, _)| canonical).collect()
    } else {
        Vec::new()
    }
}

/// Levenshtein distance between two ASCII-lowercased names.
///
/// Command types are short ASCII identifiers, so the two-row form is both exact
/// and cheap enough to run against the whole supported list per lookup.
fn edit_distance(left: &str, right: &str) -> usize {
    let left: Vec<char> = left.chars().collect();
    let right: Vec<char> = right.chars().collect();

    let mut previous: Vec<usize> = (0..=right.len()).collect();
    let mut current = vec![0usize; right.len() + 1];

    for (row, left_char) in left.iter().enumerate() {
        current[0] = row + 1;
        for (column, right_char) in right.iter().enumerate() {
            let substitution = previous[column] + usize::from(left_char != right_char);
            let insertion = current[column] + 1;
            let deletion = previous[column + 1] + 1;
            current[column + 1] = substitution.min(insertion).min(deletion);
        }
        std::mem::swap(&mut previous, &mut current);
    }

    previous[right.len()]
}

/// Checks a JSON value against the structural rules a derived payload schema
/// states: required properties, known properties, and the declared JSON types.
///
/// This is deliberately shallow — it is a guard that the derived schema agrees
/// with the parser the commands actually run through, not a JSON Schema engine.
/// It resolves a local `$ref` one level, so a nested object is checked against
/// the definition it points at and no further.
#[cfg(test)]
pub(crate) fn check_against_schema(schema: &Value, payload: &Value) -> Result<(), String> {
    check_object_against(schema, schema, payload, 1)
}

/// Checks one object against one (possibly nested) subschema.
///
/// `root` carries the `definitions` a `$ref` points into; `depth` is how many
/// more levels of `$ref` are worth following before the check stops being a
/// guard and starts being a validator.
#[cfg(test)]
fn check_object_against(
    root: &Value,
    schema: &Value,
    payload: &Value,
    depth: usize,
) -> Result<(), String> {
    let Some(payload) = payload.as_object() else {
        return Err("payload is not a JSON object".to_string());
    };
    let Some(schema) = schema.as_object() else {
        return Err("schema is not a JSON object".to_string());
    };

    let properties = schema
        .get("properties")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();

    // A required property is one `schemars` derived from a field that is not an
    // `Option`, so an explicit `null` is refused by the parser exactly as an
    // absent property is; the guard reads the two the same way.
    if let Some(required) = schema.get("required").and_then(Value::as_array) {
        for name in required.iter().filter_map(Value::as_str) {
            match payload.get(name) {
                None => return Err(format!("missing required property '{name}'")),
                Some(Value::Null) => {
                    return Err(format!("required property '{name}' is null"));
                }
                Some(_) => {}
            }
        }
    }

    // A field with more than one accepted spelling, and an either/or a parse
    // step enforces, are stated as `allOf` groups rather than by name.
    if let Some(groups) = schema.get("allOf").and_then(Value::as_array) {
        for group in groups {
            check_requirement_group(payload, group)?;
        }
    }

    let additional_allowed = schema
        .get("additionalProperties")
        .and_then(Value::as_bool)
        .unwrap_or(true);

    for (name, value) in payload {
        let Some(property) = properties.get(name) else {
            if additional_allowed {
                continue;
            }
            return Err(format!("unknown property '{name}'"));
        };
        check_declared_type(root, property, value, depth)
            .map_err(|error| format!("'{name}': {error}"))?;
    }

    Ok(())
}

/// Checks one payload against one `allOf` requirement group.
///
/// The three shapes a derived schema states are `anyOf` (at least one branch),
/// `oneOf` (exactly one, which is how an aliased field says that two spellings
/// are a duplicate field) and `not` (an optional aliased field saying the same
/// thing without requiring either). Anything else is left to a real validator.
#[cfg(test)]
fn check_requirement_group(
    payload: &serde_json::Map<String, Value>,
    group: &Value,
) -> Result<(), String> {
    if let Some(options) = group.get("anyOf").and_then(Value::as_array) {
        if !options
            .iter()
            .any(|option| satisfies_branch(payload, option))
        {
            return Err(format!("no branch of a required group is present: {group}"));
        }
        return Ok(());
    }

    if let Some(options) = group.get("oneOf").and_then(Value::as_array) {
        let matched = options
            .iter()
            .filter(|option| satisfies_branch(payload, option))
            .count();
        if matched != 1 {
            return Err(format!(
                "exactly one branch of a required group must match, {matched} did: {group}"
            ));
        }
        return Ok(());
    }

    if let Some(forbidden) = group.get("not") {
        if satisfies_branch(payload, forbidden) {
            return Err(format!(
                "two spellings of the same property are present: {group}"
            ));
        }
    }

    Ok(())
}

/// Whether a payload matches one branch of a requirement group.
///
/// A branch states `required`, the constraints it puts on a property it
/// requires, and the `allOf`/`anyOf` nesting the exclusivity constraints are
/// built from.
///
/// A property whose value is an explicit `null` does not satisfy `required`
/// here. That is stricter than JSON Schema reads the keyword alone, and it is
/// what every group the derived schemas state means: each pairs its `required`
/// with a `not: {"type": "null"}` on the same property, because the parser
/// reads a null as the absent field it is.
#[cfg(test)]
fn satisfies_branch(payload: &serde_json::Map<String, Value>, branch: &Value) -> bool {
    if let Some(names) = branch.get("required").and_then(Value::as_array) {
        if !names
            .iter()
            .filter_map(Value::as_str)
            .all(|name| payload.get(name).is_some_and(|value| !value.is_null()))
        {
            return false;
        }
    }

    if let Some(properties) = branch.get("properties").and_then(Value::as_object) {
        for (name, constraints) in properties {
            let Some(value) = payload.get(name) else {
                continue;
            };
            if !satisfies_constraints(value, constraints) {
                return false;
            }
        }
    }

    if let Some(options) = branch.get("allOf").and_then(Value::as_array) {
        if !options
            .iter()
            .all(|option| satisfies_branch(payload, option))
        {
            return false;
        }
    }

    if let Some(options) = branch.get("anyOf").and_then(Value::as_array) {
        if !options
            .iter()
            .any(|option| satisfies_branch(payload, option))
        {
            return false;
        }
    }

    true
}

/// Whether one value matches the constraints a requirement branch puts on it.
///
/// The vocabulary is the one the derived groups use and no more: `type`, the
/// `not` that excludes an explicit `null`, the `minItems` a stand-in property
/// requires of the list it substitutes for, and the `required`/`properties`
/// nesting that is the same check one level down — `AddTextClip`'s preset-less
/// branch demands a complete `textData`.
#[cfg(test)]
fn satisfies_constraints(value: &Value, constraints: &Value) -> bool {
    if let Some(declared) = constraints.get("type").and_then(Value::as_str) {
        if !value_is(declared, value) {
            return false;
        }
    }

    if let Some(excluded) = constraints.get("not") {
        if satisfies_constraints(value, excluded) {
            return false;
        }
    }

    if let Some(minimum) = constraints.get("minItems").and_then(Value::as_u64) {
        let length = value.as_array().map_or(0, |entries| entries.len() as u64);
        if length < minimum {
            return false;
        }
    }

    if constraints.get("required").is_some() || constraints.get("properties").is_some() {
        return match value.as_object() {
            Some(object) => satisfies_branch(object, constraints),
            None => false,
        };
    }

    true
}

/// Whether a value is of the JSON type a schema declares.
///
/// A keyword this shallow guard does not model answers `true`: it is here to
/// catch a payload the parser refuses, not to reject one it accepts.
#[cfg(test)]
fn value_is(declared: &str, value: &Value) -> bool {
    match declared {
        "object" => value.is_object(),
        "array" => value.is_array(),
        "string" => value.is_string(),
        "boolean" => value.is_boolean(),
        "integer" => value.is_i64() || value.is_u64(),
        "number" => value.is_number(),
        "null" => value.is_null(),
        _ => true,
    }
}

/// Resolves a property's single local `$ref`, directly or through an `allOf`.
#[cfg(test)]
fn resolve_local_ref<'a>(
    root: &'a Value,
    property: &serde_json::Map<String, Value>,
) -> Option<&'a Value> {
    let reference = match property.get("$ref").and_then(Value::as_str) {
        Some(reference) => Some(reference),
        None => property
            .get("allOf")
            .and_then(Value::as_array)
            .filter(|entries| entries.len() == 1)
            .and_then(|entries| entries[0].get("$ref"))
            .and_then(Value::as_str),
    }?;

    let name = reference.strip_prefix("#/definitions/")?;
    root.get("definitions")?.get(name)
}

/// Checks one value against a property schema's `type`, when it states one.
#[cfg(test)]
fn check_declared_type(
    root: &Value,
    property: &Value,
    value: &Value,
    depth: usize,
) -> Result<(), String> {
    let Some(property) = property.as_object() else {
        return Ok(());
    };

    if depth > 0 {
        if let Some(definition) = resolve_local_ref(root, property) {
            if value.is_null() {
                return Ok(());
            }
            // A definition that names an object is worth stepping into; one
            // that names an enum or a scalar is only worth type-checking, and
            // stepping into it would report "not a JSON object" about a string
            // the parser is perfectly happy with.
            if definition.get("type") == Some(&json!("object")) && value.is_object() {
                return check_object_against(root, definition, value, depth - 1);
            }
            return check_declared_type(root, definition, value, 0);
        }
    }

    // `Option<T>` is emitted as `["T", "null"]`, and an untagged enum as an
    // `anyOf` with no type of its own. Both are satisfied by anything the
    // shallow check could say, so they are passed over.
    let declared = match property.get("type") {
        Some(Value::String(declared)) => declared.as_str(),
        _ => return Ok(()),
    };

    if value_is(declared, value) {
        Ok(())
    } else {
        Err(format!("expected {declared}, got {value}"))
    }
}

/// Reads one property's schema out of a derived command schema.
#[cfg(test)]
pub(crate) fn property<'a>(
    schema: &'a Value,
    name: &str,
) -> Option<&'a serde_json::Map<String, Value>> {
    schema.get("properties")?.get(name)?.as_object()
}

/// Names the required properties of a derived command schema.
#[cfg(test)]
pub(crate) fn required(schema: &Value) -> Vec<String> {
    schema
        .get("required")
        .and_then(Value::as_array)
        .map(|names| {
            names
                .iter()
                .filter_map(Value::as_str)
                .map(ToOwned::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn should_answer_a_case_slip_with_the_canonical_spelling() {
        assert_eq!(
            closest_command_types("updatecaption"),
            vec!["UpdateCaption"]
        );
        assert_eq!(closest_command_types("SPLITCLIP"), vec!["SplitClip"]);
    }

    #[test]
    fn should_answer_a_near_miss_with_the_command_the_caller_meant() {
        assert_eq!(
            closest_command_types("UpdateCaptions"),
            vec!["UpdateCaption"]
        );
        assert_eq!(
            closest_command_types("SetClipTransfrom"),
            vec!["SetClipTransform"]
        );
    }

    #[test]
    fn should_not_guess_when_nothing_is_close() {
        assert!(closest_command_types("RenderTheWholeMovie").is_empty());
        assert!(closest_command_types("").is_empty());
    }

    /// Feature: suggesting the command an agent meant
    /// Scenario: two commands are equally close and one is the opposite verb
    ///
    /// The bug this replaces: `RemoveCaption` is four edits from both
    /// `DeleteCaption` and `CreateCaption`, and the tie was broken by the order
    /// of the supported list — so an agent trying to delete a caption was told
    /// "Did you mean 'CreateCaption'?", which reads like an answer and names
    /// the opposite operation.
    #[test]
    fn should_offer_every_tied_candidate_rather_than_picking_by_list_order() {
        assert_eq!(
            closest_command_types("RemoveCaption"),
            vec!["CreateCaption", "DeleteCaption"],
            "a tie names both, in the order the supported list advertises them"
        );

        let error = unsupported_command_type_error("RemoveCaption");
        assert!(error.contains("one of"), "{error}");
        assert!(error.contains("'DeleteCaption'"), "{error}");
        assert!(error.contains("'CreateCaption'"), "{error}");
    }

    /// A single close name is still answered as one suggestion, not a list.
    #[test]
    fn should_answer_an_unambiguous_near_miss_with_one_name() {
        assert_eq!(closest_command_types("MoveTrack"), vec!["RemoveTrack"]);
        assert_eq!(closest_command_types("RemoveTracks"), vec!["RemoveTrack"]);
        assert_eq!(closest_command_types("SetOpacity"), vec!["SetClipOpacity"]);

        let error = unsupported_command_type_error("SetOpacity");
        assert!(error.contains("Did you mean 'SetClipOpacity'?"), "{error}");
    }

    /// Feature: suggesting the command an agent meant
    /// Scenario: the caller lowercased an alternative spelling
    ///
    /// The bug this replaces: only the canonical names were scored, so
    /// `addtrack` — one case slip away from the `addTrack` the parser takes —
    /// was measured against `CreateTrack` alone and answered with nothing.
    #[test]
    fn should_answer_an_alias_spelling_with_the_canonical_command() {
        assert_eq!(closest_command_types("addtrack"), vec!["CreateTrack"]);
        assert_eq!(
            closest_command_types("freezeframe"),
            vec!["CreateFreezeFrame"]
        );
        assert_eq!(
            closest_command_types("changeclipspeed"),
            vec!["SetClipSpeed"]
        );
        assert_eq!(closest_command_types("liftedit"), vec!["Lift"]);
    }

    /// Feature: derived command payload schemas
    /// Scenario: three spellings of one field are one at a time
    ///
    /// `at_most_one` builds a `not` over every pair, and a group of three has
    /// three of them. All three spellings at once has to be refused as surely
    /// as any two, or a payload serde reads as two duplicate fields would pass
    /// the schema that describes it.
    #[test]
    fn should_forbid_every_pair_of_three_spellings_of_one_field() {
        let group = SpellingGroup {
            canonical: "captionId".to_string(),
            spellings: vec![
                "captionId".to_string(),
                "clipId".to_string(),
                "id".to_string(),
            ],
            exclusive: true,
            canonical_constraints: None,
        }
        .at_most_one()
        .expect("an exclusive group forbids its pairs");

        let payload = |names: &[&str]| {
            names
                .iter()
                .map(|name| ((*name).to_string(), json!("x")))
                .collect::<serde_json::Map<String, Value>>()
        };

        check_requirement_group(&payload(&["captionId", "clipId", "id"]), &group)
            .expect_err("all three spellings at once is three duplicate fields");

        for one in ["captionId", "clipId", "id"] {
            check_requirement_group(&payload(&[one]), &group).unwrap_or_else(|error| {
                panic!("`{one}` alone is what the field asks for: {error}")
            });
        }

        for pair in [
            ["captionId", "clipId"],
            ["captionId", "id"],
            ["clipId", "id"],
        ] {
            check_requirement_group(&payload(&pair), &group).expect_err(&format!(
                "`{}` and `{}` are the same field twice",
                pair[0], pair[1]
            ));
        }
    }

    #[test]
    fn should_name_the_suggestion_in_the_unsupported_error() {
        let error = unsupported_command_type_error("UpdateCaptions");
        assert!(error.contains("UpdateCaptions"), "{error}");
        assert!(error.contains("UpdateCaption'"), "{error}");
        assert!(error.contains("command schema"), "{error}");
    }

    /// Feature: derived command payload schemas
    /// Scenario: the same command asked for twice is answered once
    #[test]
    fn should_answer_a_repeated_command_type_once() {
        let repeated = command_payload_schemas(&[
            "SplitClip".to_string(),
            "SplitClip".to_string(),
            "InsertClip".to_string(),
        ])
        .expect("both names are supported");

        assert_eq!(repeated["count"].as_u64(), Some(2));
        assert_eq!(repeated["schemas"][0]["commandType"], "SplitClip");
        assert_eq!(repeated["schemas"][1]["commandType"], "InsertClip");
    }

    /// Feature: derived command payload schemas
    /// Scenario: whitespace around a command type is forgiven in both places
    ///
    /// A shell heredoc or a JSON list an agent assembled by hand can carry a
    /// stray space. The parser trims it, so the schema lookup an agent uses to
    /// compose that very payload has to trim it too, or the two surfaces
    /// disagree about the same name.
    #[test]
    fn should_trim_a_command_type_the_way_the_parser_does() {
        let padded = command_payload_schemas(&["  SplitClip \n".to_string()])
            .expect("the parser accepts the same padding");
        assert_eq!(padded["schemas"][0]["commandType"], "SplitClip");

        super::super::CommandPayload::parse(
            "  SplitClip \n".to_string(),
            json!({
                "sequenceId": "seq_1",
                "trackId": "track_v1",
                "clipId": "clip_1",
                "splitTime": 5.0
            }),
        )
        .expect("the parser trims the command type");
    }

    #[test]
    fn should_report_an_unsupported_type_rather_than_a_wrong_schema() {
        let error = command_payload_schemas(&["Bogus".to_string()])
            .expect_err("an unsupported command type has no schema");
        assert!(error.contains("Bogus"), "{error}");
    }

    /// Feature: derived command payload schemas
    /// Scenario: a worked example arrives shaped like the payload it describes
    #[test]
    fn should_put_the_line_breaks_back_into_a_flattened_json_example() {
        let flattened = "Payload for adding a text clip.\n\n# Example\n\n```json { \"a\": 1, \
                         \"b\": { \"c\": 2 } } ```\n\nTrailing prose.";
        let restored = reindent_json_fences(flattened).expect("the example is valid JSON");

        assert!(
            restored.contains("```json\n{\n  \"a\": 1,"),
            "the fence must open on its own line and the object must be indented: {restored}"
        );
        assert!(restored.contains("Trailing prose."));
        assert!(restored.starts_with("Payload for adding a text clip."));
    }

    #[test]
    fn should_leave_a_description_alone_when_there_is_nothing_to_re_indent() {
        assert_eq!(reindent_json_fences("Just prose, no fences."), None);
        assert_eq!(reindent_json_fences("An unclosed ```json fence"), None);
        assert_eq!(reindent_json_fences("A ```bash echo hi ``` block"), None);
    }

    /// Feature: derived command payload schemas
    /// Scenario: a command the executor refuses says so in its own schema
    #[test]
    fn should_flag_a_command_the_executor_cannot_run() {
        let refused = super::super::command_payload_schema("PasteEffects")
            .expect("PasteEffects is advertised");
        assert_eq!(refused[EXECUTABLE_KEYWORD], false);
        assert!(refused["description"]
            .as_str()
            .is_some_and(|text| text.contains("command execute")));

        let runnable =
            super::super::command_payload_schema("SplitClip").expect("SplitClip is advertised");
        assert!(
            runnable.get(EXECUTABLE_KEYWORD).is_none(),
            "a command that runs carries no flag at all"
        );
    }

    #[test]
    fn edit_distance_should_count_single_character_edits() {
        assert_eq!(edit_distance("abc", "abc"), 0);
        assert_eq!(edit_distance("abc", "abd"), 1);
        assert_eq!(edit_distance("abc", "ab"), 1);
        assert_eq!(edit_distance("", "abc"), 3);
    }
}
