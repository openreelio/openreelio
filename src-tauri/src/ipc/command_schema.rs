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
//! false`, and each field's doc comment becomes its `description`. The one
//! thing `schemars` does not read is `#[serde(alias = "...")]`, so the accepted
//! spellings live in the doc comments — and a colocated guard in
//! [`super::payloads`] fails the build when an alias is added without one.

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

/// Builds the JSON Schema of one payload type, titled by its command type.
///
/// The derived title is the Rust struct name (`UpdateCaptionPayload`), which is
/// not a name any caller can use. It is replaced by the command type so the
/// schema names the thing an agent actually writes into `commandType`.
pub fn payload_schema<T: JsonSchema>(command_type: &str) -> Value {
    let generator = schemars::gen::SchemaSettings::draft07().into_generator();
    let root = generator.into_root_schema_for::<T>();

    // A `RootSchema` is plain data — maps, strings and bools — so this cannot
    // fail in practice. It is still not worth failing a whole schema listing
    // over one command: an empty object says "no shape known" honestly, and the
    // command's own name is still carried below.
    let mut value = serde_json::to_value(root).unwrap_or_else(|_| json!({}));

    if let Value::Object(object) = &mut value {
        object.insert("title".to_string(), Value::String(command_type.to_string()));
    }

    value
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
/// an agent that misspells one type in a batch is told which one.
pub fn command_payload_schemas(command_types: &[String]) -> Result<Value, String> {
    let mut schemas = Vec::with_capacity(command_types.len());
    for command_type in command_types {
        let command_type = command_type.trim();
        let schema = super::command_payload_schema(command_type)
            .ok_or_else(|| unsupported_command_type_error(command_type))?;
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
    match closest_command_type(command_type) {
        Some(suggestion) => format!(
            "'{command_type}' is not a supported command type. Did you mean '{suggestion}'? \
             Run 'command schema' for the full list."
        ),
        None => format!(
            "'{command_type}' is not a supported command type. \
             Run 'command schema' for the full list."
        ),
    }
}

/// Names the supported command type closest to a caller's spelling.
///
/// A case-only difference is answered first, because `updatecaption` is a
/// spelling the parser itself would reject while meaning exactly one command.
/// Otherwise the nearest name by edit distance wins, and only when it is close
/// enough that the caller plausibly meant it — a third of the name's length,
/// so a short name needs a near-exact match and a long one tolerates a word.
pub fn closest_command_type(command_type: &str) -> Option<&'static str> {
    let candidate = command_type.trim();
    if candidate.is_empty() {
        return None;
    }

    let supported = super::CommandPayload::SUPPORTED_COMMAND_TYPES;

    if let Some(matched) = supported
        .iter()
        .find(|supported| supported.eq_ignore_ascii_case(candidate))
    {
        return Some(matched);
    }

    let lowered = candidate.to_ascii_lowercase();
    let (best, distance) = supported
        .iter()
        .map(|supported| {
            (
                *supported,
                edit_distance(&lowered, &supported.to_ascii_lowercase()),
            )
        })
        .min_by_key(|(supported, distance)| (*distance, supported.len()))?;

    let tolerance = (best.len() / 3).max(2);
    (distance <= tolerance).then_some(best)
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
/// It resolves no `$ref`, so a nested object is checked for being an object and
/// no further.
#[cfg(test)]
pub(crate) fn check_against_schema(schema: &Value, payload: &Value) -> Result<(), String> {
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
        check_declared_type(property, value).map_err(|error| format!("'{name}': {error}"))?;
    }

    Ok(())
}

/// Checks one value against a property schema's `type`, when it states one.
#[cfg(test)]
fn check_declared_type(property: &Value, value: &Value) -> Result<(), String> {
    let Some(property) = property.as_object() else {
        return Ok(());
    };

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
        assert_eq!(closest_command_type("updatecaption"), Some("UpdateCaption"));
        assert_eq!(closest_command_type("SPLITCLIP"), Some("SplitClip"));
    }

    #[test]
    fn should_answer_a_near_miss_with_the_command_the_caller_meant() {
        assert_eq!(
            closest_command_type("UpdateCaptions"),
            Some("UpdateCaption")
        );
        assert_eq!(
            closest_command_type("SetClipTransfrom"),
            Some("SetClipTransform")
        );
    }

    #[test]
    fn should_not_guess_when_nothing_is_close() {
        assert_eq!(closest_command_type("RenderTheWholeMovie"), None);
        assert_eq!(closest_command_type(""), None);
    }

    #[test]
    fn should_name_the_suggestion_in_the_unsupported_error() {
        let error = unsupported_command_type_error("UpdateCaptions");
        assert!(error.contains("UpdateCaptions"), "{error}");
        assert!(error.contains("UpdateCaption'"), "{error}");
        assert!(error.contains("command schema"), "{error}");
    }

    #[test]
    fn should_report_an_unsupported_type_rather_than_a_wrong_schema() {
        let error = command_payload_schemas(&["Bogus".to_string()])
            .expect_err("an unsupported command type has no schema");
        assert!(error.contains("Bogus"), "{error}");
    }

    #[test]
    fn edit_distance_should_count_single_character_edits() {
        assert_eq!(edit_distance("abc", "abc"), 0);
        assert_eq!(edit_distance("abc", "abd"), 1);
        assert_eq!(edit_distance("abc", "ab"), 1);
        assert_eq!(edit_distance("", "abc"), 3);
    }
}
