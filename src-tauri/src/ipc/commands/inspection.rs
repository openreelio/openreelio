//! Sequence inspection IPC command — where an in-app agent should look.
//!
//! A thin entry point. The signals come from
//! [`crate::core::timeline::inspection`], shared verbatim with the CLI and the
//! MCP, and the sequence resolution lives in
//! [`crate::ipc::dto::inspection`], which is Tauri-free and therefore unit
//! tested. What is here is what only a command can do: take the project
//! snapshot and hand the summary back.

use tauri::State;

use crate::core::timeline::InspectionSummary;
use crate::ipc::commands::analysis::resolve_project_snapshot;
use crate::ipc::dto::inspection::{resolve_inspection_summaries, resolve_inspection_summary};
use crate::AppState;

/// Returns the where-to-look signals for one or more sequences.
///
/// Cuts, edit points, transition spans (refused ones included), caption and
/// text spans, markers, the sequence's timebase and canvas, and the counts
/// derived from all of it. The same summary `openreelio-cli timeline info`
/// prints, so an agent working inside the app and one driving the CLI reason
/// over identical numbers.
///
/// `sequence_id` names one sequence; absent, it means the active one. Answering
/// with a list is what lets `sequence_ids` name several: the snapshot behind
/// these signals is a whole clone of the project state, so a bridge building a
/// timeline overview used to pay for one clone per sequence in the project.
/// Summaries come back in the order the ids were given — a summary carries no
/// id of its own — and the two arguments are mutually exclusive.
#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip(state))]
pub async fn sequence_inspection_summary(
    sequence_id: Option<String>,
    sequence_ids: Option<Vec<String>>,
    state: State<'_, AppState>,
) -> Result<Vec<InspectionSummary>, String> {
    if sequence_id.is_some() && sequence_ids.is_some() {
        return Err(
            "Pass either sequenceId or sequenceIds, not both: they name different requests"
                .to_string(),
        );
    }

    let (_, project_state) = resolve_project_snapshot(&state).await?;
    match sequence_ids {
        Some(ids) => resolve_inspection_summaries(&project_state, &ids),
        None => resolve_inspection_summary(&project_state, sequence_id.as_deref())
            .map(|summary| vec![summary]),
    }
}
