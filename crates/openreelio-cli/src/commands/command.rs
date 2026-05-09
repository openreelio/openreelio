//! Generic backend command execution for agent-native CLI clients.
//!
//! This exposes the same strict `CommandPayload` parser used by the GUI IPC and
//! backend agent plan executor, so headless agents are not limited to the
//! hand-written convenience subcommands.

use crate::output;
use clap::Subcommand;
use openreelio_core::ipc::CommandPayload;
use std::path::PathBuf;

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
            let typed_payload = CommandPayload::parse(command_type.clone(), payload)
                .map_err(|error| anyhow::anyhow!("{error}"))?;

            let mut project = super::load_project(&path)?;
            let command = typed_payload.build_command(&project.path);
            let result = project
                .executor
                .execute(command, &mut project.state)
                .map_err(|error| anyhow::anyhow!("Command '{}' failed: {}", command_type, error))?;
            super::save_project(&mut project)?;

            output::print_json(&serde_json::json!({
                "status": "ok",
                "commandType": command_type,
                "opId": result.op_id,
                "createdIds": result.created_ids,
                "deletedIds": result.deleted_ids,
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
