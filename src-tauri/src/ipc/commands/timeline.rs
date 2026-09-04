//! Timeline/sequence/command operations
//!
//! Tauri IPC commands for managing sequences, executing edit commands,
//! and performing undo/redo operations.

use specta::Type;
use tauri::State;

use crate::core::{
    analysis::ducking::{generate_duck_keyframes, AudioDuckingParams, SpeechRegion},
    commands::{
        infer_sequence_id, payload_string, ApplyAudioDuckingCommand, CommandResult,
        CreateAdjustmentLayerCommand, CreateCompoundClipCommand, CreateSequenceCommand,
        EditRecording, RecordSource, UnnestCompoundClipCommand,
    },
    timeline::Sequence,
    CoreError, TimeRange,
};
use crate::ipc::payloads::{validate_command_payload_against_project_state, CommandPayload};
use crate::{ActiveProject, AppState};

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
    /// Sequence the affected ranges are measured against, when one is known.
    ///
    /// `None` for a command that identifies no timeline — a `CreateSequence`,
    /// an asset import — where reporting the active sequence would send an
    /// inspection step to a timeline the command never touched.
    pub sequence_id: Option<String>,
    /// Stretches of that sequence's timeline this command changed.
    ///
    /// Sorted, disjoint, and measured as a diff across the apply, so a ripple
    /// move is reported in full rather than as the one clip that was named.
    /// Empty when nothing on the timeline moved.
    pub affected_ranges: Vec<TimeRange>,
}

/// Applies one command and records where on the timeline it landed.
///
/// The before-image has to be taken while the state still holds it — the ranges
/// are a diff across the mutation, and a ripple move shifts clips no reported
/// change names — so every mutating command in this module goes through here
/// rather than calling the executor directly. Recording the hand-off is what
/// makes a later `extract_timeline_frames { affected: true }` mean "the last
/// edit" instead of failing outright, which is what it did while nothing in the
/// app wrote the file.
fn execute_recorded(
    project: &mut ActiveProject,
    sequence_id: Option<&str>,
    command: Box<dyn crate::core::commands::Command>,
) -> Result<(CommandResult, Vec<TimeRange>), CoreError> {
    let Some(sequence_id) = sequence_id else {
        // Nothing identifies a timeline, so there is nowhere to look and
        // nothing to hand off.
        return project
            .executor
            .execute(command, &mut project.state)
            .map(|result| (result, Vec::new()));
    };

    // Tagged as the app's own edit path: the hand-off record is a single slot,
    // and a later `affected: true` has to be able to tell an interactive edit
    // from the asking agent's own apply.
    let mut recording = EditRecording::begin(&project.state, sequence_id, RecordSource::Gui);
    let result = project.executor.execute(command, &mut project.state)?;
    recording.observe(&result);
    let ranges = recording.finish(&project.path, &project.state);

    Ok((result, ranges))
}

impl CommandResultDto {
    /// Builds the result an executed command reports.
    fn new(result: CommandResult, sequence_id: Option<String>, ranges: Vec<TimeRange>) -> Self {
        Self {
            op_id: result.op_id,
            created_ids: result.created_ids,
            deleted_ids: result.deleted_ids,
            sequence_id,
            affected_ranges: ranges,
        }
    }
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

/// Validates an edit command payload without mutating project state.
#[tauri::command]
#[specta::specta]
pub async fn validate_command_payload(
    command_type: String,
    payload: serde_json::Value,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let typed_payload = CommandPayload::parse(command_type.clone(), payload)?;
    let guard = state.project.lock().await;
    if let Some(project) = guard.as_ref() {
        validate_command_payload_against_project_state(
            &command_type,
            &typed_payload,
            &project.state,
        )?;
    }
    Ok(())
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

    // Refuse to append on top of edits made by another process (openreelio-cli,
    // a second window, an agent). The frontend maps this error to a reload
    // prompt; merging is never attempted automatically.
    project
        .ensure_no_external_changes()
        .map_err(|e| e.to_ipc_error())?;

    // Read off the raw payload before it is consumed: the typed command does
    // not carry the ids back out, and the sequence has to be known before the
    // before-image is taken.
    let named_sequence_id = payload_string(&payload, "sequenceId");
    let named_effect_id = payload_string(&payload, "effectId");
    let named_clip_id = payload_string(&payload, "clipId");

    // Strict validation via CommandPayload::parse
    let typed_command = CommandPayload::parse(command_type, payload)?;

    // A command that resolves the active sequence itself — `SetSequenceFormat`
    // with no `sequenceId` — has to be resolved the same way here, or the edit
    // would run but report no sequence and no affected ranges. Read before
    // `build_command` consumes the payload.
    let targets_active_sequence = typed_command.targets_active_sequence();

    // Build the Command trait object from the validated payload
    let command = typed_command.build_command(&project.path);

    let sequence_id = named_sequence_id
        .or_else(|| {
            infer_sequence_id(
                &project.state,
                named_effect_id.as_deref(),
                named_clip_id.as_deref(),
            )
        })
        .or_else(|| {
            if targets_active_sequence {
                project.state.active_sequence_id.clone()
            } else {
                None
            }
        });
    let (result, affected_ranges) =
        execute_recorded(project, sequence_id.as_deref(), command).map_err(|e| e.to_ipc_error())?;

    tracing::debug!(
        command_type = %command_type_for_log,
        op_id = %result.op_id,
        affected_ranges = affected_ranges.len(),
        elapsed_ms = started_at.elapsed().as_millis(),
        "execute_command completed"
    );

    Ok(CommandResultDto::new(result, sequence_id, affected_ranges))
}

/// Undoes the last command
#[tauri::command]
#[specta::specta]
pub async fn undo(state: State<'_, AppState>) -> Result<UndoRedoResult, String> {
    let mut guard = state.project.lock().await;

    let project = guard
        .as_mut()
        .ok_or_else(|| CoreError::NoProjectOpen.to_ipc_error())?;

    project.undo_persisted().map_err(|e| e.to_ipc_error())?;

    Ok(UndoRedoResult {
        success: true,
        can_undo: project.can_undo_persisted().map_err(|e| e.to_ipc_error())?,
        can_redo: project.can_redo_persisted().map_err(|e| e.to_ipc_error())?,
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

    project.redo_persisted().map_err(|e| e.to_ipc_error())?;

    Ok(UndoRedoResult {
        success: true,
        can_undo: project.can_undo_persisted().map_err(|e| e.to_ipc_error())?,
        can_redo: project.can_redo_persisted().map_err(|e| e.to_ipc_error())?,
    })
}

/// Checks if undo is available
#[tauri::command]
#[specta::specta]
pub async fn can_undo(state: State<'_, AppState>) -> Result<bool, String> {
    let mut guard = state.project.lock().await;

    match guard.as_mut() {
        Some(project) => project.can_undo_persisted().map_err(|e| e.to_ipc_error()),
        None => Ok(false),
    }
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
    let mut guard = state.project.lock().await;

    match guard.as_mut() {
        Some(project) => project.can_redo_persisted().map_err(|e| e.to_ipc_error()),
        None => Ok(false),
    }
}

// =============================================================================
// Undo History (S32-002)
// =============================================================================

/// Summary of the full undo/redo history for the Undo History Panel.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UndoHistoryInfo {
    /// Entries in the undo stack (already applied, oldest first)
    pub undo_entries: Vec<UndoHistoryEntry>,
    /// Entries in the redo stack (undone, next-to-redo first)
    pub redo_entries: Vec<UndoHistoryEntry>,
    /// Index of the current state in the combined list (-1 = initial state)
    pub current_index: i32,
}

/// Lightweight history entry for IPC transport.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UndoHistoryEntry {
    /// Operation ID
    pub op_id: String,
    /// Command type name (e.g., "InsertClip", "SplitClip")
    pub command_type: String,
    /// RFC3339 timestamp
    pub timestamp: String,
    /// Index in the combined history list
    pub index: usize,
}

/// Returns the full undo/redo history for display in the Undo History Panel.
#[tauri::command]
#[specta::specta]
pub async fn get_undo_history(state: State<'_, AppState>) -> Result<UndoHistoryInfo, String> {
    let mut guard = state.project.lock().await;

    let project = guard
        .as_mut()
        .ok_or_else(|| CoreError::NoProjectOpen.to_ipc_error())?;

    let (undo_history_entries, redo_history_entries, current_index) = project
        .persisted_history_entries()
        .map_err(|e| e.to_ipc_error())?;

    let undo_entries: Vec<UndoHistoryEntry> = undo_history_entries
        .into_iter()
        .map(|e| UndoHistoryEntry {
            op_id: e.op_id,
            command_type: e.command_type,
            timestamp: e.timestamp,
            index: e.index,
        })
        .collect();

    let redo_entries: Vec<UndoHistoryEntry> = redo_history_entries
        .into_iter()
        .map(|e| UndoHistoryEntry {
            op_id: e.op_id,
            command_type: e.command_type,
            timestamp: e.timestamp,
            index: e.index,
        })
        .collect();

    Ok(UndoHistoryInfo {
        undo_entries,
        redo_entries,
        current_index,
    })
}

/// Jumps to a specific point in the undo history.
/// Target index -1 means "initial state" (undo everything).
#[tauri::command]
#[specta::specta]
pub async fn jump_to_history_state(
    target_index: i32,
    state: State<'_, AppState>,
) -> Result<UndoRedoResult, String> {
    let mut guard = state.project.lock().await;

    let project = guard
        .as_mut()
        .ok_or_else(|| CoreError::NoProjectOpen.to_ipc_error())?;

    project
        .jump_to_history_index_persisted(target_index)
        .map_err(|e| e.to_ipc_error())?;

    Ok(UndoRedoResult {
        success: true,
        can_undo: project.can_undo_persisted().map_err(|e| e.to_ipc_error())?,
        can_redo: project.can_redo_persisted().map_err(|e| e.to_ipc_error())?,
    })
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

// =============================================================================
// Audio Ducking
// =============================================================================

/// Payload for the audio ducking IPC command.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ApplyAudioDuckingArgs {
    pub sequence_id: String,
    pub speech_track_id: String,
    pub music_track_id: String,
    pub music_clip_id: String,
    pub params: AudioDuckingParams,
}

/// Analyzes a speech track for clip positions and generates volume-ducking
/// keyframes on a music clip.
///
/// Speech regions are derived from enabled clip positions on the speech track.
/// The generated keyframes smoothly duck the music volume during speech
/// segments using the specified attack and release ramps.
#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip(state))]
pub async fn apply_audio_ducking(
    args: ApplyAudioDuckingArgs,
    state: State<'_, AppState>,
) -> Result<CommandResultDto, String> {
    let mut guard = state.project.lock().await;
    let project = guard
        .as_mut()
        .ok_or_else(|| CoreError::NoProjectOpen.to_ipc_error())?;

    let sequence_id = args.sequence_id;
    let speech_track_id = args.speech_track_id;
    let music_track_id = args.music_track_id;
    let music_clip_id = args.music_clip_id;
    let params = args.params;

    // 1. Collect speech regions from enabled clips on the speech track
    let (speech_regions, clip_start, clip_duration, original_volume) = {
        let sequence = project
            .state
            .sequences
            .get(&sequence_id)
            .ok_or_else(|| CoreError::SequenceNotFound(sequence_id.clone()).to_ipc_error())?;

        let speech_track = sequence
            .get_track(&speech_track_id)
            .ok_or_else(|| CoreError::TrackNotFound(speech_track_id.clone()).to_ipc_error())?;

        let regions: Vec<SpeechRegion> = speech_track
            .clips
            .iter()
            .filter(|c| c.enabled)
            .map(|c| {
                SpeechRegion::new(
                    c.place.timeline_in_sec,
                    c.place.timeline_in_sec + c.place.duration_sec,
                )
            })
            .collect();

        let music_track = sequence
            .get_track(&music_track_id)
            .ok_or_else(|| CoreError::TrackNotFound(music_track_id.clone()).to_ipc_error())?;

        let music_clip = music_track
            .get_clip(&music_clip_id)
            .ok_or_else(|| CoreError::ClipNotFound(music_clip_id.clone()).to_ipc_error())?;

        (
            regions,
            music_clip.place.timeline_in_sec,
            music_clip.place.duration_sec,
            music_clip.audio.volume_db as f64,
        )
    };

    if speech_regions.is_empty() {
        return Err("No enabled clips found on speech track".to_string());
    }

    // 2. Generate duck keyframes
    let keyframes = generate_duck_keyframes(
        &speech_regions,
        &params,
        clip_start,
        clip_duration,
        original_volume,
    );

    // 3. Execute command (atomic, undoable)
    let command: Box<dyn crate::core::commands::Command> = Box::new(ApplyAudioDuckingCommand::new(
        &sequence_id,
        &music_track_id,
        &music_clip_id,
        keyframes,
    ));

    let (result, affected_ranges) =
        execute_recorded(project, Some(&sequence_id), command).map_err(|e| e.to_ipc_error())?;

    Ok(CommandResultDto::new(
        result,
        Some(sequence_id),
        affected_ranges,
    ))
}

// =============================================================================
// Compound Clip Commands
// =============================================================================

/// Arguments for creating a compound clip from selected clips.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CreateCompoundClipArgs {
    pub sequence_id: String,
    pub track_id: String,
    pub clip_ids: Vec<String>,
    pub name: Option<String>,
}

/// Creates a compound clip by nesting selected clips into a new inner sequence.
#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip(state))]
pub async fn create_compound_clip(
    args: CreateCompoundClipArgs,
    state: State<'_, AppState>,
) -> Result<CommandResultDto, String> {
    let mut guard = state.project.lock().await;
    let project = guard
        .as_mut()
        .ok_or_else(|| CoreError::NoProjectOpen.to_ipc_error())?;

    let mut command =
        CreateCompoundClipCommand::new(&args.sequence_id, &args.track_id, args.clip_ids);
    if let Some(name) = args.name {
        command = command.with_name(&name);
    }

    let (result, affected_ranges) =
        execute_recorded(project, Some(&args.sequence_id), Box::new(command))
            .map_err(|e| e.to_ipc_error())?;

    Ok(CommandResultDto::new(
        result,
        Some(args.sequence_id),
        affected_ranges,
    ))
}

/// Arguments for unnesting a compound clip.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UnnestCompoundClipArgs {
    pub sequence_id: String,
    pub track_id: String,
    pub clip_id: String,
}

/// Unnests a compound clip, restoring its inner clips to the parent timeline.
#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip(state))]
pub async fn unnest_compound_clip(
    args: UnnestCompoundClipArgs,
    state: State<'_, AppState>,
) -> Result<CommandResultDto, String> {
    let mut guard = state.project.lock().await;
    let project = guard
        .as_mut()
        .ok_or_else(|| CoreError::NoProjectOpen.to_ipc_error())?;

    let command = UnnestCompoundClipCommand::new(&args.sequence_id, &args.track_id, &args.clip_id);

    let (result, affected_ranges) =
        execute_recorded(project, Some(&args.sequence_id), Box::new(command))
            .map_err(|e| e.to_ipc_error())?;

    Ok(CommandResultDto::new(
        result,
        Some(args.sequence_id),
        affected_ranges,
    ))
}

/// Arguments for creating an adjustment layer.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CreateAdjustmentLayerArgs {
    pub sequence_id: String,
    pub track_id: String,
    pub position: f64,
    pub duration: f64,
    pub name: Option<String>,
}

/// Creates an adjustment layer clip on a video/overlay track.
/// Adjustment layers are transparent clips whose effects apply to all clips below.
#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip(state))]
pub async fn create_adjustment_layer(
    args: CreateAdjustmentLayerArgs,
    state: State<'_, AppState>,
) -> Result<CommandResultDto, String> {
    let mut guard = state.project.lock().await;
    let project = guard
        .as_mut()
        .ok_or_else(|| CoreError::NoProjectOpen.to_ipc_error())?;

    let mut command = CreateAdjustmentLayerCommand::new(
        &args.sequence_id,
        &args.track_id,
        args.position,
        args.duration,
    );
    if let Some(name) = args.name {
        command = command.with_name(&name);
    }

    let (result, affected_ranges) =
        execute_recorded(project, Some(&args.sequence_id), Box::new(command))
            .map_err(|e| e.to_ipc_error())?;

    Ok(CommandResultDto::new(
        result,
        Some(args.sequence_id),
        affected_ranges,
    ))
}

// =============================================================================
// Effect Copy/Paste Operations
// =============================================================================

/// Copies all effects and pasteable attributes from a clip.
///
/// Returns a JSON blob containing the clip's effects (deep clones) and
/// pasteable attributes (transform, opacity, blend mode, speed, audio).
/// This is a read-only operation; the frontend stores the result in its clipboard.
#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip(state))]
pub async fn copy_clip_effects(
    sequence_id: String,
    track_id: String,
    clip_id: String,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let guard = state.project.lock().await;

    let project = guard
        .as_ref()
        .ok_or_else(|| CoreError::NoProjectOpen.to_ipc_error())?;

    let sequence = project
        .state
        .sequences
        .get(&sequence_id)
        .ok_or_else(|| CoreError::SequenceNotFound(sequence_id.clone()).to_ipc_error())?;

    let track = sequence
        .tracks
        .iter()
        .find(|t| t.id == track_id)
        .ok_or_else(|| CoreError::TrackNotFound(track_id.clone()).to_ipc_error())?;

    let clip = track
        .clips
        .iter()
        .find(|c| c.id == clip_id)
        .ok_or_else(|| CoreError::ClipNotFound(clip_id.clone()).to_ipc_error())?;

    // Deep-clone all effects referenced by this clip
    let effects: Vec<serde_json::Value> = clip
        .effects
        .iter()
        .filter_map(|eid| {
            project
                .state
                .effects
                .get(eid)
                .and_then(|e| serde_json::to_value(e).ok())
        })
        .collect();

    Ok(serde_json::json!({
        "sourceClipId": clip.id,
        "effects": effects,
        "transform": serde_json::to_value(&clip.transform).map_err(|e| e.to_string())?,
        "opacity": clip.opacity,
        "blendMode": serde_json::to_value(&clip.blend_mode).map_err(|e| e.to_string())?,
        "speed": clip.speed,
        "reverse": clip.reverse,
        "audio": serde_json::to_value(&clip.audio).map_err(|e| e.to_string())?,
    }))
}
