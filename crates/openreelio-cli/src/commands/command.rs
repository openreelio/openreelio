//! Generic backend command execution for agent-native CLI clients.
//!
//! This exposes the same strict `CommandPayload` parser used by the GUI IPC and
//! backend agent plan executor, so headless agents are not limited to the
//! hand-written convenience subcommands.

use crate::output;
use clap::Subcommand;
use openreelio_core::commands::{payload_string, StateChange};
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
    Schema {
        /// Backend command type to describe, e.g. UpdateCaption (repeatable)
        #[arg(long = "type", conflicts_with = "all")]
        command_type: Vec<String>,

        /// Describe every supported command instead of one
        #[arg(long, conflicts_with = "command_type")]
        all: bool,
    },
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
            let named_sequence_id = payload_string(&payload, "sequenceId");
            let named_effect_id = payload_string(&payload, "effectId");
            let named_clip_id = payload_string(&payload, "clipId");
            let typed_payload = CommandPayload::parse(command_type.clone(), payload)
                .map_err(|error| anyhow::anyhow!("{error}"))?;

            let mut project = super::load_project(&path)?;
            // Which timeline the edit is measured against has to be settled
            // before it runs: the ranges are a diff across the mutation, and a
            // ripple move shifts clips no `StateChange` entry names.
            let sequence_id = named_sequence_id
                .or_else(|| {
                    openreelio_core::commands::infer_sequence_id(
                        &project.state,
                        named_effect_id.as_deref(),
                        named_clip_id.as_deref(),
                    )
                })
                // A payload whose command resolves the active sequence itself —
                // `SetSequenceFormat` with no `sequenceId` — has to resolve it
                // the same way here, or the edit would run but report no
                // sequence, no ranges and write no `--affected` hand-off.
                .or_else(|| {
                    if typed_payload.targets_active_sequence() {
                        project.state.active_sequence_id.clone()
                    } else {
                        None
                    }
                });

            let command = typed_payload.build_command(&project.path);
            // Through the same recorder every other mutating verb uses, so this
            // one cannot drift from them about what `--affected` will point at.
            // A payload naming no timeline — an asset import, a `CreateSequence`
            // — has nothing to diff and nothing to hand off, and says so by
            // reporting no sequence rather than guessing at the active one.
            // The exception is a command that targets the active sequence by
            // design, resolved above.
            let (result, affected_ranges) = match sequence_id.as_deref() {
                Some(sequence_id) => {
                    let mut recorder = super::EditRecorder::begin(&project, sequence_id);
                    let result = recorder.execute(&mut project, command).map_err(|error| {
                        anyhow::anyhow!("Command '{}' failed: {}", command_type, error)
                    })?;
                    let affected_ranges = recorder.finish(&mut project)?;
                    (result, affected_ranges)
                }
                None => {
                    let result = project
                        .executor
                        .execute(command, &mut project.state)
                        .map_err(|error| {
                            anyhow::anyhow!("Command '{}' failed: {}", command_type, error)
                        })?;
                    super::save_project(&mut project)?;
                    (result, Vec::new())
                }
            };

            output::print_json(&serde_json::json!({
                "status": "ok",
                "commandType": command_type,
                "opId": result.op_id,
                "createdIds": result.created_ids,
                "deletedIds": result.deleted_ids,
                "sequenceId": sequence_id,
                "affectedRanges": affected_ranges,
                "changes": camel_cased_changes(&result.changes),
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

        CommandAction::Schema { command_type, all } => {
            // The bare listing is what an agent reads to discover the surface,
            // so it stays exactly as it was. A payload shape is a second,
            // heavier question and is only answered when it is asked.
            let mut report = if all {
                openreelio_core::ipc::all_command_payload_schemas()
            } else if command_type.is_empty() {
                serde_json::json!({
                    "commands": CommandPayload::SUPPORTED_COMMAND_TYPES,
                    "count": CommandPayload::SUPPORTED_COMMAND_TYPES.len(),
                })
            } else {
                openreelio_core::ipc::command_payload_schemas(&command_type)
                    .map_err(|error| anyhow::anyhow!("{error}"))?
            };

            if let Some(object) = report.as_object_mut() {
                object.insert(
                    "payloadFormat".to_string(),
                    serde_json::json!({
                        "commandType": "PascalCase backend command type",
                        "payload": "camelCase JSON object matching the command payload",
                        "schemaLookup": "Run 'command schema --type <CommandType>' for one payload's \
                                         JSON Schema, or '--all' for every one."
                    }),
                );
            }

            output::print_json_pretty(&report)
        }
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

/// Writes the where-to-look hand-off for the next inspection step.
///
/// Best effort by design: the edit is already durable in the ops log, so a
/// failed write costs a later sampler its shortcut and nothing else. It is
/// reported on stderr rather than turned into a command failure, which would
/// wrongly suggest the edit did not apply.
///
/// A record with no sequence or no ranges is not written at all. The file is a
/// single hand-off slot, so writing an empty one over a real one loses the
/// answer to "where did the last edit land" for a command that never had one —
/// an asset import, a sequence created empty.
pub(crate) fn record_affected_ranges(
    project_dir: &Path,
    sequence_id: &str,
    op_ids: Vec<String>,
    affected_ranges: &[TimeRange],
) {
    if let Err(error) = openreelio_core::commands::record_affected_ranges(
        project_dir,
        sequence_id,
        op_ids,
        affected_ranges,
        // Everything this binary applies is headless, the MCP server included.
        openreelio_core::commands::RecordSource::Cli,
    ) {
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
///
/// An entry that will not serialize is reported as JSON `null` rather than
/// failing the command: by the time this runs the edit is applied *and saved*,
/// so returning an error would print no result at all for work that is already
/// durable, and invite the caller to run it a second time.
fn camel_cased_changes(changes: &[StateChange]) -> Vec<serde_json::Value> {
    changes
        .iter()
        .map(|change| match serde_json::to_value(change) {
            Ok(serde_json::Value::Object(fields)) => serde_json::Value::Object(
                fields
                    .into_iter()
                    .map(|(key, value)| (to_camel_case(&key), value))
                    .collect(),
            ),
            Ok(value) => value,
            Err(_) => serde_json::Value::Null,
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

        let serialized = camel_cased_changes(&changes);

        assert_eq!(serialized[0]["type"], "markerCreated");
        assert_eq!(serialized[0]["markerId"], "marker-1");
        assert_eq!(serialized[1]["type"], "effectAdded");
        assert_eq!(serialized[1]["effectId"], "fx-1");
        assert_eq!(serialized[1]["clipId"], "clip-1");
    }
}
