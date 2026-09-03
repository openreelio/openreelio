//! Generic backend command execution for agent-native CLI clients.
//!
//! This exposes the same strict `CommandPayload` parser used by the GUI IPC and
//! backend agent plan executor, so headless agents are not limited to the
//! hand-written convenience subcommands.

use crate::output;
use clap::Subcommand;
use openreelio_core::commands::{
    save_last_affected_ranges, LastAffectedRanges, SequenceSnapshot, StateChange,
};
use openreelio_core::ipc::CommandPayload;
use openreelio_core::TimeRange;
use std::path::{Path, PathBuf};

#[derive(Subcommand)]
pub enum CommandAction {
    /// Execute any supported backend edit command from a JSON payload
    Execute {
        /// Project directory path
        #[arg(long)]
        path: PathBuf,

        /// Backend command type, e.g. SplitClip, AddMask, CreateCompoundClip
        #[arg(long = "type")]
        command_type: String,

        /// Inline JSON object payload
        #[arg(long, conflicts_with = "payload_file")]
        payload: Option<String>,

        /// Path to a JSON file containing the payload object
        #[arg(long = "payload-file", conflicts_with = "payload")]
        payload_file: Option<PathBuf>,
    },

    /// Validate a backend command payload without executing it
    Validate {
        /// Backend command type, e.g. SplitClip, AddMask, CreateCompoundClip
        #[arg(long = "type")]
        command_type: String,

        /// Inline JSON object payload
        #[arg(long, conflicts_with = "payload_file")]
        payload: Option<String>,

        /// Path to a JSON file containing the payload object
        #[arg(long = "payload-file", conflicts_with = "payload")]
        payload_file: Option<PathBuf>,
    },

    /// Print the backend command surface available to headless agents
    Schema,
}

pub fn execute(action: CommandAction) -> anyhow::Result<()> {
    match action {
        CommandAction::Execute {
            path,
            command_type,
            payload,
            payload_file,
        } => {
            let payload = read_payload(payload, payload_file)?;
            let payload_sequence_id = payload_sequence_id(&payload);
            let typed_payload = CommandPayload::parse(command_type.clone(), payload)
                .map_err(|error| anyhow::anyhow!("{error}"))?;

            let mut project = super::load_project(&path)?;
            // The before-image has to be taken while the state still holds it:
            // the ranges an edit changed are the diff across the mutation, and
            // a ripple move shifts clips no `StateChange` entry names.
            // Resolved leniently: a command that names no sequence and a
            // project with no active one still execute, they just have no
            // timeline to measure ranges against.
            let sequence_id = payload_sequence_id
                .or_else(|| project.state.active_sequence_id.clone())
                .unwrap_or_default();
            let before = SequenceSnapshot::capture(&project.state, &sequence_id);

            let command = typed_payload.build_command(&project.path);
            let result = project
                .executor
                .execute(command, &mut project.state)
                .map_err(|error| anyhow::anyhow!("Command '{}' failed: {}", command_type, error))?;
            let affected_ranges =
                before.affected_ranges(&project.state, &sequence_id, &result.changes);
            super::save_project(&mut project)?;

            record_affected_ranges(
                &project.path,
                &sequence_id,
                vec![result.op_id.clone()],
                &affected_ranges,
            );

            let reported_sequence_id = (!sequence_id.is_empty()).then_some(sequence_id);

            output::print_json(&serde_json::json!({
                "status": "ok",
                "commandType": command_type,
                "opId": result.op_id,
                "createdIds": result.created_ids,
                "deletedIds": result.deleted_ids,
                "sequenceId": reported_sequence_id,
                "affectedRanges": affected_ranges,
                "changes": camel_cased_changes(&result.changes)?,
            }))
        }

        CommandAction::Validate {
            command_type,
            payload,
            payload_file,
        } => {
            let payload = read_payload(payload, payload_file)?;
            CommandPayload::parse(command_type.clone(), payload)
                .map_err(|error| anyhow::anyhow!("{error}"))?;

            output::print_json(&serde_json::json!({
                "status": "ok",
                "commandType": command_type,
                "message": "Command payload is valid",
            }))
        }

        CommandAction::Schema => output::print_json_pretty(&serde_json::json!({
            "commands": CommandPayload::SUPPORTED_COMMAND_TYPES,
            "count": CommandPayload::SUPPORTED_COMMAND_TYPES.len(),
            "payloadFormat": {
                "commandType": "PascalCase backend command type",
                "payload": "camelCase JSON object matching the command payload"
            }
        })),
    }
}

fn read_payload(
    payload: Option<String>,
    payload_file: Option<PathBuf>,
) -> anyhow::Result<serde_json::Value> {
    let content = match (payload, payload_file) {
        (Some(inline), None) => inline,
        (None, Some(file)) => std::fs::read_to_string(&file).map_err(|error| {
            anyhow::anyhow!(
                "Failed to read payload file '{}': {}",
                file.display(),
                error
            )
        })?,
        (None, None) => "{}".to_string(),
        (Some(_), Some(_)) => unreachable!("clap enforces payload conflicts"),
    };

    let value: serde_json::Value =
        serde_json::from_str(&content).map_err(|error| anyhow::anyhow!("Invalid JSON: {error}"))?;
    if !value.is_object() {
        return Err(anyhow::anyhow!("Command payload must be a JSON object"));
    }

    Ok(value)
}

/// Reads the sequence a payload names, if it names one as a plain string.
///
/// Most backend commands carry `sequenceId`; the ones that do not act on the
/// active sequence, which is what the caller falls back to.
fn payload_sequence_id(payload: &serde_json::Value) -> Option<String> {
    payload
        .get("sequenceId")
        .and_then(|value| value.as_str())
        .map(str::to_string)
}

/// Writes the where-to-look hand-off for the next inspection step.
///
/// Best effort by design: the edit is already durable in the ops log, so a
/// failed write costs a later sampler its shortcut and nothing else. It is
/// reported on stderr rather than turned into a command failure, which would
/// wrongly suggest the edit did not apply.
pub(crate) fn record_affected_ranges(
    project_dir: &Path,
    sequence_id: &str,
    op_ids: Vec<String>,
    affected_ranges: &[TimeRange],
) {
    let record = LastAffectedRanges::new(sequence_id.to_string(), op_ids, affected_ranges.to_vec());
    if let Err(error) = save_last_affected_ranges(project_dir, &record) {
        eprintln!("warning: could not record the affected ranges: {error}");
    }
}

/// Re-keys serialized [`StateChange`] entries into the CLI's camelCase convention.
///
/// `StateChange` camel-cases its variant *names* but not the fields they carry,
/// so a raw serialization prints `markerCreated` next to `marker_id`. Every
/// other key the CLI emits is camelCase, and the type is also the GUI's IPC
/// event payload — so the re-keying happens here rather than by changing a
/// shape another surface already depends on. Each variant is a flat object of
/// string fields, which is why a shallow pass over the keys is enough.
fn camel_cased_changes(changes: &[StateChange]) -> anyhow::Result<Vec<serde_json::Value>> {
    changes
        .iter()
        .map(|change| {
            let value = serde_json::to_value(change)?;
            let serde_json::Value::Object(fields) = value else {
                return Ok(value);
            };
            Ok(serde_json::Value::Object(
                fields
                    .into_iter()
                    .map(|(key, value)| (to_camel_case(&key), value))
                    .collect(),
            ))
        })
        .collect()
}

/// Converts a `snake_case` key to `camelCase`.
fn to_camel_case(key: &str) -> String {
    let mut camel = String::with_capacity(key.len());
    let mut capitalize_next = false;
    for character in key.chars() {
        if character == '_' {
            capitalize_next = true;
            continue;
        }
        if capitalize_next {
            camel.extend(character.to_uppercase());
            capitalize_next = false;
        } else {
            camel.push(character);
        }
    }
    camel
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn should_report_change_fields_in_the_camel_case_the_cli_promises() {
        let changes = vec![
            StateChange::MarkerCreated {
                marker_id: "marker-1".to_string(),
            },
            StateChange::EffectAdded {
                effect_id: "fx-1".to_string(),
                clip_id: "clip-1".to_string(),
            },
        ];

        let serialized = camel_cased_changes(&changes).expect("changes");

        assert_eq!(serialized[0]["type"], "markerCreated");
        assert_eq!(serialized[0]["markerId"], "marker-1");
        assert_eq!(serialized[1]["type"], "effectAdded");
        assert_eq!(serialized[1]["effectId"], "fx-1");
        assert_eq!(serialized[1]["clipId"], "clip-1");
    }
}
