//! Interchange export commands
//!
//! Tauri IPC commands for exporting sequences to EDL and FCPXML formats.

use tauri::State;

use crate::core::{
    fs::{default_export_allowed_roots, validate_scoped_output_path},
    interchange::{edl, models::InterchangeExportResult, xml},
    CoreError,
};
use crate::AppState;

// =============================================================================
// Commands
// =============================================================================

/// Exports a sequence to CMX 3600 EDL format.
///
/// Generates an industry-standard EDL file that can be imported into
/// Premiere Pro, DaVinci Resolve, and other NLEs.
#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip(state), fields(sequence_id = %sequence_id, output_path = %output_path))]
pub async fn export_edl(
    sequence_id: String,
    output_path: String,
    state: State<'_, AppState>,
) -> Result<InterchangeExportResult, String> {
    tracing::info!("Exporting sequence to EDL format");

    // Get sequence and assets from project state
    let (sequence, assets, project_path) = {
        let guard = state.project.lock().await;
        let project = guard
            .as_ref()
            .ok_or_else(|| CoreError::NoProjectOpen.to_ipc_error())?;

        let sequence = project
            .state
            .sequences
            .get(&sequence_id)
            .ok_or_else(|| format!("Sequence not found: {}", sequence_id))?
            .clone();

        let assets = project
            .state
            .assets
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();

        (sequence, assets, project.path.clone())
    };

    // Validate output path
    let roots = default_export_allowed_roots(&project_path);
    let root_refs: Vec<&std::path::Path> = roots.iter().map(|p| p.as_path()).collect();
    let validated_path = validate_scoped_output_path(&output_path, "EDL output path", &root_refs)?;

    // Generate EDL content
    let duration_sec = sequence.duration();
    let (edl_content, event_count, track_count) = edl::export_edl(&sequence, &assets)?;

    // Ensure parent directory exists
    if let Some(parent) = validated_path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("Failed to create output directory: {}", e))?;
    }

    // Write file
    tokio::fs::write(&validated_path, edl_content)
        .await
        .map_err(|e| format!("Failed to write EDL file: {}", e))?;

    let result = edl::build_export_result(
        &validated_path.to_string_lossy(),
        event_count,
        track_count,
        duration_sec,
    );

    tracing::info!(
        "EDL export complete: {} events, {} tracks, {:.1}s duration",
        event_count,
        track_count,
        duration_sec
    );

    Ok(result)
}

/// Exports a sequence to Final Cut Pro XML (FCPXML v1.11) format.
///
/// Generates an FCPXML file compatible with Final Cut Pro,
/// DaVinci Resolve, and other NLEs that support FCPXML import.
#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip(state), fields(sequence_id = %sequence_id, output_path = %output_path))]
pub async fn export_fcpxml(
    sequence_id: String,
    output_path: String,
    state: State<'_, AppState>,
) -> Result<InterchangeExportResult, String> {
    tracing::info!("Exporting sequence to FCPXML format");

    // Get sequence and assets from project state
    let (sequence, assets, project_path) = {
        let guard = state.project.lock().await;
        let project = guard
            .as_ref()
            .ok_or_else(|| CoreError::NoProjectOpen.to_ipc_error())?;

        let sequence = project
            .state
            .sequences
            .get(&sequence_id)
            .ok_or_else(|| format!("Sequence not found: {}", sequence_id))?
            .clone();

        let assets = project
            .state
            .assets
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();

        (sequence, assets, project.path.clone())
    };

    // Validate output path
    let roots = default_export_allowed_roots(&project_path);
    let root_refs: Vec<&std::path::Path> = roots.iter().map(|p| p.as_path()).collect();
    let validated_path =
        validate_scoped_output_path(&output_path, "FCPXML output path", &root_refs)?;

    // Generate FCPXML content
    let duration_sec = sequence.duration();
    let (fcpxml_content, event_count, track_count) = xml::export_fcpxml(&sequence, &assets)?;

    // Ensure parent directory exists
    if let Some(parent) = validated_path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("Failed to create output directory: {}", e))?;
    }

    // Write file
    tokio::fs::write(&validated_path, fcpxml_content)
        .await
        .map_err(|e| format!("Failed to write FCPXML file: {}", e))?;

    let result = xml::build_export_result(
        &validated_path.to_string_lossy(),
        event_count,
        track_count,
        duration_sec,
    );

    tracing::info!(
        "FCPXML export complete: {} events, {} tracks, {:.1}s duration",
        event_count,
        track_count,
        duration_sec
    );

    Ok(result)
}
