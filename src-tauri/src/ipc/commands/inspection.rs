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
use crate::ipc::dto::inspection::resolve_inspection_summary;
use crate::AppState;

/// Returns the where-to-look signals for a sequence.
///
/// Cuts, edit points, transition spans (refused ones included), caption and
/// text spans, markers, the sequence's timebase and canvas, and the counts
/// derived from all of it. The same summary `openreelio-cli timeline info`
/// prints, so an agent working inside the app and one driving the CLI reason
/// over identical numbers.
///
/// `sequence_id` names a sequence; absent, it means the active one.
#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip(state))]
pub async fn sequence_inspection_summary(
    sequence_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<InspectionSummary, String> {
    let (_, project_state) = resolve_project_snapshot(&state).await?;
    resolve_inspection_summary(&project_state, sequence_id.as_deref())
}
