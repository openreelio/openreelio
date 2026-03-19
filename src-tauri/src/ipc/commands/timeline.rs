//! Timeline/sequence/command operations
//!
//! Tauri IPC commands for managing sequences, executing edit commands,
//! and performing undo/redo operations.

use specta::Type;
use tauri::State;

use crate::core::{commands::CreateSequenceCommand, timeline::Sequence, CoreError};
use crate::ipc::payloads::CommandPayload;
use crate::AppState;

// =============================================================================
// DTOs
// =============================================================================

/// Result of executing an edit command.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CommandResultDto {
    /// Operation ID for tracking in undo/redo history
    pub op_id: String,
    /// IDs of entities created by this command
    pub created_ids: Vec<String>,
    /// IDs of entities deleted by this command
    pub deleted_ids: Vec<String>,
}

/// Result of an undo or redo operation.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UndoRedoResult {
    /// Whether the operation was successful
    pub success: bool,
    /// Whether more undo operations are available
    pub can_undo: bool,
    /// Whether more redo operations are available
    pub can_redo: bool,
}

// =============================================================================
// Commands
// =============================================================================

/// Gets all sequences in the project
#[tauri::command]
#[specta::specta]
pub async fn get_sequences(state: State<'_, AppState>) -> Result<Vec<Sequence>, String> {
    let guard = state.project.lock().await;

    let project = guard
        .as_ref()
        .ok_or_else(|| CoreError::NoProjectOpen.to_ipc_error())?;

    Ok(project.state.sequences.values().cloned().collect())
}

/// Creates a new sequence
#[tauri::command]
#[specta::specta]
pub async fn create_sequence(
    name: String,
    format: String,
    state: State<'_, AppState>,
) -> Result<Sequence, String> {
    let mut guard = state.project.lock().await;

    let project = guard
        .as_mut()
        .ok_or_else(|| CoreError::NoProjectOpen.to_ipc_error())?;

    // Use CreateSequenceCommand for proper undo/redo support and ops logging
    let command = CreateSequenceCommand::new(&name, &format);

    let result = project
        .executor
        .execute(Box::new(command), &mut project.state)
        .map_err(|e| e.to_ipc_error())?;

    // Get the created sequence to return
    let seq_id = result.created_ids.first().ok_or("No sequence created")?;
    let sequence = project
        .state
        .sequences
        .get(seq_id)
        .ok_or("Sequence not found after creation")?;

    Ok(sequence.clone())
}

/// Gets a specific sequence by ID
#[tauri::command]
#[specta::specta]
pub async fn get_sequence(
    sequence_id: String,
    state: State<'_, AppState>,
) -> Result<Sequence, String> {
    let guard = state.project.lock().await;

    let project = guard
        .as_ref()
        .ok_or_else(|| CoreError::NoProjectOpen.to_ipc_error())?;

    let sequence = project
        .state
        .sequences
        .get(&sequence_id)
        .ok_or_else(|| CoreError::SequenceNotFound(sequence_id).to_ipc_error())?;

    Ok(sequence.clone())
}

/// Executes an edit command
#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip(state, payload), fields(command_type = %command_type))]
pub async fn execute_command(
    command_type: String,
    payload: serde_json::Value,
    state: State<'_, AppState>,
) -> Result<CommandResultDto, String> {
    let started_at = std::time::Instant::now();
    let command_type_for_log = command_type.clone();
    let mut guard = state.project.lock().await;

    let project = guard
        .as_mut()
        .ok_or_else(|| CoreError::NoProjectOpen.to_ipc_error())?;

    // Strict validation via CommandPayload::parse
    let typed_command = CommandPayload::parse(command_type, payload)?;

    // Build the Command trait object from the validated payload
    let command = typed_command.build_command(&project.path);

    let result = project
        .executor
        .execute(command, &mut project.state)
        .map_err(|e| e.to_ipc_error())?;

    tracing::debug!(
        command_type = %command_type_for_log,
        op_id = %result.op_id,
        elapsed_ms = started_at.elapsed().as_millis(),
        "execute_command completed"
    );

    Ok(CommandResultDto {
        op_id: result.op_id,
        created_ids: result.created_ids,
        deleted_ids: result.deleted_ids,
    })
}

/// Undoes the last command
#[tauri::command]
#[specta::specta]
pub async fn undo(state: State<'_, AppState>) -> Result<UndoRedoResult, String> {
    let mut guard = state.project.lock().await;

    let project = guard
        .as_mut()
        .ok_or_else(|| CoreError::NoProjectOpen.to_ipc_error())?;

    project
        .executor
        .undo(&mut project.state)
        .map_err(|e| e.to_ipc_error())?;

    Ok(UndoRedoResult {
        success: true,
        can_undo: project.executor.can_undo(),
        can_redo: project.executor.can_redo(),
    })
}

/// Redoes the last undone command
#[tauri::command]
#[specta::specta]
pub async fn redo(state: State<'_, AppState>) -> Result<UndoRedoResult, String> {
    let mut guard = state.project.lock().await;

    let project = guard
        .as_mut()
        .ok_or_else(|| CoreError::NoProjectOpen.to_ipc_error())?;

    project
        .executor
        .redo(&mut project.state)
        .map_err(|e| e.to_ipc_error())?;

    Ok(UndoRedoResult {
        success: true,
        can_undo: project.executor.can_undo(),
        can_redo: project.executor.can_redo(),
    })
}

/// Checks if undo is available
#[tauri::command]
#[specta::specta]
pub async fn can_undo(state: State<'_, AppState>) -> Result<bool, String> {
    let guard = state.project.lock().await;

    Ok(guard
        .as_ref()
        .map(|p| p.executor.can_undo())
        .unwrap_or(false))
}

/// Finds all gaps between clips on a specific track.
///
/// Returns an ordered list of gaps (empty regions) between clips.
/// This is a read-only query — no state mutation occurs.
#[tauri::command]
#[specta::specta]
pub async fn find_gaps(
    sequence_id: String,
    track_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<crate::core::commands::GapInfo>, String> {
    let guard = state.project.lock().await;

    let project = guard
        .as_ref()
        .ok_or_else(|| CoreError::NoProjectOpen.to_ipc_error())?;

    let sequence = project
        .state
        .sequences
        .get(&sequence_id)
        .ok_or_else(|| CoreError::SequenceNotFound(sequence_id).to_ipc_error())?;

    let track = sequence
        .tracks
        .iter()
        .find(|t| t.id == track_id)
        .ok_or_else(|| CoreError::TrackNotFound(track_id).to_ipc_error())?;

    Ok(crate::core::commands::find_gaps(track))
}

/// Checks if redo is available
#[tauri::command]
#[specta::specta]
pub async fn can_redo(state: State<'_, AppState>) -> Result<bool, String> {
    let guard = state.project.lock().await;

    Ok(guard
        .as_ref()
        .map(|p| p.executor.can_redo())
        .unwrap_or(false))
}

// =============================================================================
// Edit Point & Marker Navigation (S27-002)
// =============================================================================

/// Helper: look up a sequence and apply a read-only navigation function.
async fn with_sequence_nav(
    sequence_id: String,
    current_time: f64,
    state: &State<'_, AppState>,
    nav_fn: fn(&Sequence, f64) -> Option<f64>,
) -> Result<Option<f64>, String> {
    let guard = state.project.lock().await;

    let project = guard
        .as_ref()
        .ok_or_else(|| CoreError::NoProjectOpen.to_ipc_error())?;

    let sequence = project
        .state
        .sequences
        .get(&sequence_id)
        .ok_or_else(|| CoreError::SequenceNotFound(sequence_id).to_ipc_error())?;

    Ok(nav_fn(sequence, current_time))
}

/// Finds the next edit point (clip boundary) after current_time across all tracks.
#[tauri::command]
#[specta::specta]
pub async fn get_next_edit_point(
    sequence_id: String,
    current_time: f64,
    state: State<'_, AppState>,
) -> Result<Option<f64>, String> {
    with_sequence_nav(sequence_id, current_time, &state, Sequence::next_edit_point).await
}

/// Finds the previous edit point (clip boundary) before current_time across all tracks.
#[tauri::command]
#[specta::specta]
pub async fn get_prev_edit_point(
    sequence_id: String,
    current_time: f64,
    state: State<'_, AppState>,
) -> Result<Option<f64>, String> {
    with_sequence_nav(sequence_id, current_time, &state, Sequence::prev_edit_point).await
}

/// Finds the next marker position after current_time in the sequence.
#[tauri::command]
#[specta::specta]
pub async fn get_next_marker(
    sequence_id: String,
    current_time: f64,
    state: State<'_, AppState>,
) -> Result<Option<f64>, String> {
    with_sequence_nav(sequence_id, current_time, &state, Sequence::next_marker).await
}

/// Finds the previous marker position before current_time in the sequence.
#[tauri::command]
#[specta::specta]
pub async fn get_prev_marker(
    sequence_id: String,
    current_time: f64,
    state: State<'_, AppState>,
) -> Result<Option<f64>, String> {
    with_sequence_nav(sequence_id, current_time, &state, Sequence::prev_marker).await
}
