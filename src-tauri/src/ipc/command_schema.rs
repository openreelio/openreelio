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
//! more than one spelling is required through an `anyOf` over them rather than
//! by name. Two colocated guards in [`super::payloads`] read the payload source
//! and fail the build when an alias reaches neither the doc comment nor the
//! schema.

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
        /// The command type is matched exactly, in the canonical PascalCase
        /// spelling [`CommandPayload::SUPPORTED_COMMAND_TYPES`] lists; `None`
        /// means the name is not a supported command. The returned schema
        /// describes the `payload` object alone — the `commandType` wrapper is
        /// the caller's envelope, not part of it.
        pub fn command_payload_schema(command_type: &str) -> Option<serde_json::Value> {
            match command_type {
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
}

/// Every wire-only property, by the type that reads it.
pub(crate) const WIRE_ONLY_PROPERTIES: &[WireOnlyProperty] = &[
    WireOnlyProperty {
        owner: "RippleDeletePayload",
        name: "clipId",
        json_type: "string",
        description: "A single clip to remove, instead of `clipIds`. Exactly one \
                      of the two is required; `clipIds` wins when both are sent.",
        satisfies: Some("clipIds"),
    },
    WireOnlyProperty {
        owner: "RippleDeletePayload",
        name: "affectAllTracks",
        json_type: "boolean",
        description: "Deprecated and ignored. Accepted so an older caller is not \
                      refused; ripple delete only ever touched `trackId`.",
        satisfies: None,
    },
];

/// Adds the spellings the parser accepts but `schemars` cannot derive.
///
/// Each alternative spelling becomes a sibling property carrying the same
/// subschema as the canonical one, so `additionalProperties: false` stops
/// forbidding what the field's description recommends. When the canonical
/// property was required, it is replaced by an `anyOf` over the spellings that
/// satisfy it: saying `required: ["captionId"]` while accepting `clipId` would
/// be a different lie in the same place.
fn declare_wire_spellings(object: &mut serde_json::Map<String, Value>, type_name: &str) {
    if type_name.is_empty() {
        return;
    }

    // (canonical property, every spelling that satisfies it including itself)
    let mut satisfied_by: Vec<(String, Vec<String>)> = Vec::new();

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
        satisfied_by.push(((*canonical).to_string(), spellings));
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
        match satisfied_by
            .iter_mut()
            .find(|(name, _)| name == canonical)
            .map(|(_, spellings)| spellings)
        {
            Some(spellings) => spellings.push(extra.name.to_string()),
            None => satisfied_by.push((
                canonical.to_string(),
                vec![canonical.to_string(), extra.name.to_string()],
            )),
        }
    }

    relax_required(object, &satisfied_by);
}

/// Copies a canonical property's subschema for one of its other spellings.
///
/// A bare `$ref` is wrapped in an `allOf` first, because draft-07 ignores every
/// sibling of `$ref` — including the `description` that says which property
/// this spells.
fn alias_property(canonical_schema: &Value, canonical: &str) -> Value {
    let note = format!("Alternative spelling of `{canonical}`; the two mean the same thing.");

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

/// Replaces each required property that has other spellings with an `anyOf`.
///
/// The remaining `required` list keeps every property that is spelled exactly
/// one way, so the common reading of a schema is unchanged; only the handful of
/// fields with a second spelling move into an `allOf` of `anyOf` groups.
fn relax_required(
    object: &mut serde_json::Map<String, Value>,
    satisfied_by: &[(String, Vec<String>)],
) {
    if satisfied_by.is_empty() {
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
    for (canonical, spellings) in satisfied_by {
        let Some(position) = required.iter().position(|name| name == canonical) else {
            continue;
        };
        required.remove(position);
        let options: Vec<Value> = spellings
            .iter()
            .map(|spelling| json!({ "required": [spelling] }))
            .collect();
        groups.push(json!({ "anyOf": options }));
    }

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
/// about what a schema lookup looks like.
pub fn command_schema_entry(command_type: &str, schema: Value) -> Value {
    json!({ "commandType": command_type, "schema": schema })
}

/// Looks up the schemas for a list of command types.
///
/// Returns the same `{ count, schemas }` shape as
/// [`all_command_payload_schemas`], or the first unsupported name's error, so
/// an agent that misspells one type in a batch is told which one. A name
/// repeated in the request is answered once: these schemas are large, and a
/// duplicate spends an agent's context without telling it anything new.
pub fn command_payload_schemas(command_types: &[String]) -> Result<Value, String> {
    let mut schemas = Vec::with_capacity(command_types.len());
    let mut seen: Vec<&str> = Vec::with_capacity(command_types.len());
    for command_type in command_types {
        let command_type = command_type.trim();
        let schema = super::command_payload_schema(command_type)
            .ok_or_else(|| unsupported_command_type_error(command_type))?;
        if seen.contains(&command_type) {
            continue;
        }
        seen.push(command_type);
        schemas.push(command_schema_entry(command_type, schema));
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
pub fn closest_command_types(command_type: &str) -> Vec<&'static str> {
    let candidate = command_type.trim();
    if candidate.is_empty() {
        return Vec::new();
    }

    let supported = super::CommandPayload::SUPPORTED_COMMAND_TYPES;

    if let Some(matched) = supported
        .iter()
        .find(|supported| supported.eq_ignore_ascii_case(candidate))
    {
        return vec![matched];
    }

    let lowered = candidate.to_ascii_lowercase();
    let scored: Vec<(&'static str, usize)> = supported
        .iter()
        .map(|supported| {
            (
                *supported,
                edit_distance(&lowered, &supported.to_ascii_lowercase()),
            )
        })
        .collect();

    let Some(best) = scored.iter().map(|(_, distance)| *distance).min() else {
        return Vec::new();
    };

    let tied: Vec<&'static str> = scored
        .iter()
        .filter(|(_, distance)| *distance == best)
        .map(|(name, _)| *name)
        .collect();

    // The tolerance is measured against the shortest tied name, which is the
    // strictest of them: a five-edit hop is a guess even when one candidate
    // happens to be long.
    let shortest = tied.iter().map(|name| name.len()).min().unwrap_or(0);
    let tolerance = (shortest / 3).max(2);
    if best <= tolerance {
        tied
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

    if let Some(required) = schema.get("required").and_then(Value::as_array) {
        for name in required.iter().filter_map(Value::as_str) {
            if !payload.contains_key(name) {
                return Err(format!("missing required property '{name}'"));
            }
        }
    }

    // A field with more than one accepted spelling is required through an
    // `anyOf` of one-property `required` groups rather than by name; at least
    // one spelling in each group has to be present.
    if let Some(groups) = schema.get("allOf").and_then(Value::as_array) {
        for group in groups {
            let Some(options) = group.get("anyOf").and_then(Value::as_array) else {
                continue;
            };
            let satisfied = options.iter().any(|option| {
                option
                    .get("required")
                    .and_then(Value::as_array)
                    .is_some_and(|names| {
                        names
                            .iter()
                            .filter_map(Value::as_str)
                            .all(|name| payload.contains_key(name))
                    })
            });
            if !satisfied {
                return Err(format!(
                    "no spelling of a required property is present: {group}"
                ));
            }
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

    let matches = match declared {
        "object" => value.is_object(),
        "array" => value.is_array(),
        "string" => value.is_string(),
        "boolean" => value.is_boolean(),
        "integer" => value.is_i64() || value.is_u64(),
        "number" => value.is_number(),
        "null" => value.is_null(),
        _ => true,
    };

    if matches {
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
