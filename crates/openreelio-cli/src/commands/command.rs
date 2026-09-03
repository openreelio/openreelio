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
            let named_sequence_id = payload_string(&payload, "sequenceId");
            let named_effect_id = payload_string(&payload, "effectId");
            let named_clip_id = payload_string(&payload, "clipId");
            let typed_payload = CommandPayload::parse(command_type.clone(), payload)
                .map_err(|error| anyhow::anyhow!("{error}"))?;

            let mut project = super::load_project(&path)?;
            // The before-image has to be taken while the state still holds it:
            // the ranges an edit changed are the diff across the mutation, and
            // a ripple move shifts clips no `StateChange` entry names.
            let sequence_id = named_sequence_id.or_else(|| {
                infer_sequence_id(
                    &project.state,
                    named_effect_id.as_deref(),
                    named_clip_id.as_deref(),
                )
            });
            let before = SequenceSnapshot::capture(
                &project.state,
                sequence_id.as_deref().unwrap_or_default(),
            );

            let command = typed_payload.build_command(&project.path);
            let result = project
                .executor
                .execute(command, &mut project.state)
                .map_err(|error| anyhow::anyhow!("Command '{}' failed: {}", command_type, error))?;
            let affected_ranges = match sequence_id.as_deref() {
                Some(sequence_id) => {
                    before.affected_ranges(&project.state, sequence_id, &result.changes)
                }
                None => Vec::new(),
            };
            super::save_project(&mut project)?;

            if let Some(sequence_id) = sequence_id.as_deref() {
                record_affected_ranges(
                    &project.path,
                    sequence_id,
                    vec![result.op_id.clone()],
                    &affected_ranges,
                );
            }

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

/// Reads a plain-string field from a payload, if it carries one.
fn payload_string(payload: &serde_json::Value, key: &str) -> Option<String> {
    payload
        .get(key)
        .and_then(|value| value.as_str())
        .map(str::to_string)
}

/// Finds the sequence a payload acts on when it does not name one.
///
/// `UpdateEffect`, `UpdateMask` and `RemoveMask` address an effect and never a
/// sequence, so the sequence is whichever one holds a clip carrying that effect.
/// Falling back to the *active* sequence instead reported the whole timeline of
/// a sequence the command had not touched, which is worse than reporting
/// nothing: an agent cannot tell a confident wrong answer from a right one.
///
/// `None` when the payload names nothing that identifies a sequence — a
/// `CreateSequence`, an asset import — and the caller then reports no sequence
/// and no ranges rather than guessing.
fn infer_sequence_id(
    state: &openreelio_core::project::ProjectState,
    effect_id: Option<&str>,
    clip_id: Option<&str>,
) -> Option<String> {
    if effect_id.is_none() && clip_id.is_none() {
        return None;
    }

    state
        .sequences
        .iter()
        .find(|(_, sequence)| {
            sequence
                .tracks
                .iter()
                .flat_map(|track| track.clips.iter())
                .any(|clip| {
                    clip_id.is_some_and(|clip_id| clip.id == clip_id)
                        || effect_id.is_some_and(|effect_id| {
                            clip.effects.iter().any(|held| held == effect_id)
                        })
                })
        })
        .map(|(sequence_id, _)| sequence_id.clone())
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
    if sequence_id.is_empty() || affected_ranges.is_empty() {
        return;
    }

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
    use openreelio_core::project::ProjectState;
    use openreelio_core::timeline::{Clip, Sequence, SequenceFormat, Track};

    /// A project holding two sequences, the effect living on the second one.
    ///
    /// Returns `(state, active_sequence_id, other_sequence_id)`.
    fn two_sequence_state(effect_id: &str) -> (ProjectState, String, String) {
        let mut state = ProjectState::new("Two sequences");
        let active_id = state
            .sequences
            .keys()
            .next()
            .cloned()
            .expect("the default sequence");
        state.active_sequence_id = Some(active_id.clone());

        let mut other = Sequence::new("Second", SequenceFormat::youtube_1080());
        let mut track = Track::new_video("V1");
        let mut clip = Clip::new("asset-a");
        clip.effects.push(effect_id.to_string());
        let clip_id = clip.id.clone();
        track.clips.push(clip);
        other.tracks.push(track);
        let other_id = other.id.clone();
        state.sequences.insert(other_id.clone(), other);

        assert_ne!(active_id, other_id);
        assert!(!clip_id.is_empty());
        (state, active_id, other_id)
    }

    #[test]
    fn should_measure_an_effect_edit_against_the_sequence_that_holds_the_effect() {
        // `UpdateEffect` names no sequence. Measuring it against the *active*
        // one reported that timeline's every second for an edit on another.
        let (state, active_id, other_id) = two_sequence_state("fx-1");

        let resolved = infer_sequence_id(&state, Some("fx-1"), None);

        assert_eq!(resolved.as_deref(), Some(other_id.as_str()));
        assert_ne!(resolved.as_deref(), Some(active_id.as_str()));
    }

    #[test]
    fn should_measure_a_clip_edit_against_the_sequence_that_holds_the_clip() {
        let (state, _active_id, other_id) = two_sequence_state("fx-1");
        let clip_id = state.sequences[&other_id].tracks[0].clips[0].id.clone();

        assert_eq!(
            infer_sequence_id(&state, None, Some(&clip_id)).as_deref(),
            Some(other_id.as_str())
        );
    }

    #[test]
    fn should_resolve_no_sequence_for_a_payload_that_names_nothing() {
        // A `CreateSequence` payload names no sequence, no effect and no clip.
        // Reporting the active sequence there claimed an edit landed somewhere
        // it did not.
        let (state, _active_id, _other_id) = two_sequence_state("fx-1");

        assert_eq!(infer_sequence_id(&state, None, None), None);
        assert_eq!(infer_sequence_id(&state, Some("fx-unknown"), None), None);
    }

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
