//! Agent IPC Commands
//!
//! Tauri commands for agent-related operations:
//! trace file writing, plan execution, and memory persistence.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use tauri::State;
use tokio::sync::Mutex;

use std::collections::HashMap;

use tauri::Emitter;

use crate::core::ai::agent_plan::{AgentPlan, AgentPlanResult, StepResult};
use crate::core::ai::memory::{AgentMemoryDb, MemoryEntry};
use crate::core::ai::plan_executor::{resolve_step_references, PlanExecutor};
use crate::core::assets::{
    evaluate_license_policy, LicenseInfo, LicensePolicyContext, LicensePolicyDecision,
    LicensePolicyStatus,
};
use crate::core::commands::ImportAssetCommand;
use crate::core::credentials::{CredentialType, CredentialVault};
use crate::core::plugin::api::{
    AssetProviderPlugin, PluginAssetRef, PluginAssetType, PluginSearchQuery,
};
use crate::core::plugin::providers::freesound::{FreesoundConfig, FreesoundProvider};
use crate::core::plugin::providers::stock::{StockMediaConfig, StockMediaProvider, StockSource};
use crate::core::{
    fs::{validate_path_id_component, write_bytes_atomic_no_symlink},
    CoreError,
};
use crate::ipc::payloads::CommandPayload;
use crate::AppState;

// =============================================================================
// Trace Writing
// =============================================================================

fn validate_trace_id(trace_id: &str) -> Result<(), String> {
    if trace_id.is_empty() {
        return Err("Invalid trace_id: empty".to_string());
    }
    if trace_id.len() > 128 {
        return Err("Invalid trace_id: must be 128 characters or fewer".to_string());
    }
    if !trace_id
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
    {
        return Err(
            "Invalid trace_id: only ASCII letters, digits, '-' and '_' are allowed".to_string(),
        );
    }
    Ok(())
}

fn ensure_plain_directory(path: &Path, label: &str) -> Result<(), String> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() {
                return Err(format!("{label} must not be a symlink: {}", path.display()));
            }
            if !metadata.is_dir() {
                return Err(format!("{label} is not a directory: {}", path.display()));
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            std::fs::create_dir(path)
                .map_err(|e| format!("Failed to create {label} {}: {}", path.display(), e))?;
            let metadata = std::fs::symlink_metadata(path)
                .map_err(|e| format!("Failed to inspect {label} {}: {}", path.display(), e))?;
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err(format!(
                    "{label} is not a plain directory: {}",
                    path.display()
                ));
            }
        }
        Err(error) => {
            return Err(format!(
                "Failed to inspect {label} {}: {}",
                path.display(),
                error
            ));
        }
    }
    Ok(())
}

fn ensure_traces_dir(project_path: &Path) -> Result<PathBuf, String> {
    let openreelio_dir = project_path.join(".openreelio");
    ensure_plain_directory(&openreelio_dir, ".openreelio directory")?;

    let traces_dir = openreelio_dir.join("traces");
    ensure_plain_directory(&traces_dir, "traces directory")?;
    Ok(traces_dir)
}

fn write_trace_file_no_symlink(file_path: &Path, trace_json: &str) -> Result<(), String> {
    if let Ok(metadata) = std::fs::symlink_metadata(file_path) {
        if metadata.file_type().is_symlink() {
            return Err(format!(
                "Trace file destination must not be a symlink: {}",
                file_path.display()
            ));
        }
        if !metadata.is_file() {
            return Err(format!(
                "Trace file destination is not a file: {}",
                file_path.display()
            ));
        }
    }

    write_bytes_atomic_no_symlink(file_path, trace_json.as_bytes(), "trace file")
}

/// Write an agent trace JSON file to the project's trace directory.
///
/// Traces are stored at `{project_path}/.openreelio/traces/{trace_id}.json`.
/// Implements rotation: deletes the oldest files when count exceeds `max_files`.
#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip(state), fields(trace_id = %trace_id))]
pub async fn write_agent_trace(
    trace_json: String,
    trace_id: String,
    max_files: usize,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let project_path = {
        let guard = state.project.lock().await;
        let project = guard
            .as_ref()
            .ok_or_else(|| CoreError::NoProjectOpen.to_ipc_error())?;
        project.path.clone()
    };

    validate_trace_id(&trace_id)?;
    let traces_dir = ensure_traces_dir(&project_path)?;

    // Rotate old traces if needed
    rotate_traces(&traces_dir, max_files).await;
    let file_path = traces_dir.join(format!("{}.json", trace_id));

    let file_path_for_write = file_path.clone();
    tokio::task::spawn_blocking(move || {
        write_trace_file_no_symlink(&file_path_for_write, &trace_json)
    })
    .await
    .map_err(|e| format!("Trace write task failed: {}", e))??;

    tracing::debug!("Agent trace written: {}", file_path.display());
    Ok(())
}

/// Delete the oldest trace files when count exceeds the limit.
async fn rotate_traces(traces_dir: &PathBuf, max_files: usize) {
    if max_files == 0 {
        return;
    }

    let entries = match tokio::fs::read_dir(traces_dir).await {
        Ok(entries) => entries,
        Err(_) => return,
    };

    let mut files: Vec<(String, std::time::SystemTime)> = Vec::new();
    let mut entries = entries;
    while let Ok(Some(entry)) = entries.next_entry().await {
        let path = entry.path();
        if path.extension().is_some_and(|ext| ext == "json") {
            if let Ok(meta) = entry.metadata().await {
                let modified = meta.modified().unwrap_or(std::time::UNIX_EPOCH);
                if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                    files.push((name.to_string(), modified));
                }
            }
        }
    }

    if files.len() < max_files {
        return;
    }

    // Sort by modification time (oldest first)
    files.sort_by(|a, b| a.1.cmp(&b.1));

    let delete_count = files.len() - (max_files - 1);
    for (file_name, _) in files.into_iter().take(delete_count) {
        let file_path = traces_dir.join(&file_name);
        let _ = tokio::fs::remove_file(&file_path).await;
        tracing::debug!("Rotated old trace: {}", file_name);
    }
}

// =============================================================================
// Trace Reading
// =============================================================================

/// Summary information about a single agent trace file.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TraceSummary {
    /// Trace identifier (filename without `.json` extension).
    pub trace_id: String,
    /// Full filename including extension.
    pub file_name: String,
    /// File size in bytes.
    pub size_bytes: u64,
    /// Last modification time in ISO 8601 format.
    pub modified_at: String,
}

/// List agent trace files from the project's trace directory.
///
/// Returns up to `limit` entries sorted by modification time (newest first).
/// Traces are read from `{project_path}/.openreelio/traces/`.
#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip(state), fields(limit = ?limit))]
pub async fn list_agent_traces(
    limit: Option<usize>,
    state: State<'_, AppState>,
) -> Result<Vec<TraceSummary>, String> {
    let max_entries = limit.unwrap_or(20);

    let project_path = {
        let guard = state.project.lock().await;
        let project = guard
            .as_ref()
            .ok_or_else(|| CoreError::NoProjectOpen.to_ipc_error())?;
        project.path.clone()
    };

    let traces_dir = project_path.join(".openreelio").join("traces");

    // If the directory doesn't exist yet, return an empty list
    if !traces_dir.exists() {
        return Ok(Vec::new());
    }

    let mut entries = tokio::fs::read_dir(&traces_dir)
        .await
        .map_err(|e| format!("Failed to read traces directory: {}", e))?;

    let mut summaries: Vec<TraceSummary> = Vec::new();

    while let Some(entry) = entries
        .next_entry()
        .await
        .map_err(|e| format!("Failed to read directory entry: {}", e))?
    {
        let path = entry.path();

        // Only consider .json files
        if path.extension().is_some_and(|ext| ext == "json") {
            let meta = entry
                .metadata()
                .await
                .map_err(|e| format!("Failed to read file metadata: {}", e))?;

            let file_name = match path.file_name().and_then(|n| n.to_str()) {
                Some(name) => name.to_string(),
                None => continue,
            };

            let trace_id = file_name.trim_end_matches(".json").to_string();

            let modified = meta.modified().unwrap_or(std::time::UNIX_EPOCH);
            let modified_at = {
                let datetime: chrono::DateTime<chrono::Utc> = modified.into();
                datetime.to_rfc3339()
            };

            summaries.push(TraceSummary {
                trace_id,
                file_name,
                size_bytes: meta.len(),
                modified_at,
            });
        }
    }

    // Sort by modification time (newest first)
    summaries.sort_by(|a, b| b.modified_at.cmp(&a.modified_at));

    // Truncate to the requested limit
    summaries.truncate(max_entries);

    tracing::debug!("Listed {} agent traces", summaries.len());
    Ok(summaries)
}

/// Read a single agent trace file by its trace ID.
///
/// Returns the raw JSON content of the trace file at
/// `{project_path}/.openreelio/traces/{trace_id}.json`.
/// The `trace_id` is sanitized to prevent path traversal.
#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip(state), fields(trace_id = %trace_id))]
pub async fn read_agent_trace(
    trace_id: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let project_path = {
        let guard = state.project.lock().await;
        let project = guard
            .as_ref()
            .ok_or_else(|| CoreError::NoProjectOpen.to_ipc_error())?;
        project.path.clone()
    };

    // Sanitize trace_id to prevent path traversal
    if trace_id.contains('/') || trace_id.contains('\\') || trace_id.contains("..") {
        return Err("Invalid trace_id: contains path separators or '..'".to_string());
    }

    let file_path = project_path
        .join(".openreelio")
        .join("traces")
        .join(format!("{}.json", trace_id));

    if !file_path.exists() {
        return Err(format!(
            "Trace file not found: '{}.json' does not exist in the project traces directory",
            trace_id
        ));
    }

    let content = tokio::fs::read_to_string(&file_path)
        .await
        .map_err(|e| format!("Failed to read trace file '{}': {}", trace_id, e))?;

    tracing::debug!("Read agent trace: {}", file_path.display());
    Ok(content)
}

// =============================================================================
// Plan Execution
// =============================================================================

/// Tauri event payload for plan step progress.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PlanStepEvent {
    plan_id: String,
    step_id: String,
    step_index: usize,
    total_steps: usize,
}

/// Tauri event payload for plan step completion.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PlanStepCompleteEvent {
    plan_id: String,
    step_id: String,
    step_index: usize,
    total_steps: usize,
    operation_id: Option<String>,
    duration_ms: u64,
}

/// Tauri event payload for plan step failure.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PlanStepFailedEvent {
    plan_id: String,
    step_id: String,
    step_index: usize,
    total_steps: usize,
    error: String,
}

/// Execute an agent plan atomically against the active project.
///
/// Runs each plan step as a command through the CommandExecutor,
/// respecting step dependencies via topological sort and resolving
/// `$fromStep`/`$path` references between steps.
///
/// On failure, attempts to rollback completed steps in reverse order
/// using the CommandExecutor's undo stack. Emits Tauri events for
/// each step's lifecycle (`agent:plan_step_start`, `agent:plan_step_complete`,
/// `agent:plan_step_failed`).
#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip(app, state), fields(plan_id = %plan.id))]
pub async fn execute_agent_plan(
    app: tauri::AppHandle,
    plan: AgentPlan,
    state: State<'_, AppState>,
) -> Result<AgentPlanResult, String> {
    let start = std::time::Instant::now();
    let plan_id = plan.id.clone();
    let total_steps = plan.steps.len();

    // Validate plan is non-empty
    if plan.steps.is_empty() {
        return Ok(AgentPlanResult {
            plan_id,
            success: false,
            total_steps: 0,
            steps_completed: 0,
            step_results: vec![],
            operation_ids: vec![],
            rollback_report: None,
            error_message: Some("Plan has no steps to execute".to_string()),
            execution_time_ms: start.elapsed().as_millis() as u64,
        });
    }

    // Validate plan structure and compute execution order
    let executor = PlanExecutor::new(plan.clone());
    let execution_order = executor
        .validate_and_prepare()
        .map_err(|e| format!("Plan validation failed: {e}"))?;

    // Lock the project for the duration of plan execution
    let mut guard = state.project.lock().await;
    let project = guard
        .as_mut()
        .ok_or_else(|| CoreError::NoProjectOpen.to_ipc_error())?;
    let project_path = project.path.clone();

    let mut step_results: Vec<StepResult> = Vec::with_capacity(total_steps);
    let mut results_by_id: HashMap<String, StepResult> = HashMap::new();
    let mut operation_ids: Vec<String> = Vec::new();
    let mut steps_completed: usize = 0;

    tracing::info!(
        plan_id = %plan_id,
        total_steps = total_steps,
        "Executing agent plan"
    );

    for &step_idx in &execution_order {
        let step = &plan.steps[step_idx];
        let step_start = std::time::Instant::now();

        // Emit step start event
        let _ = app.emit(
            "agent:plan_step_start",
            PlanStepEvent {
                plan_id: plan_id.clone(),
                step_id: step.id.clone(),
                step_index: step_idx,
                total_steps,
            },
        );

        // Resolve $fromStep/$path references in step params
        let resolved_params = match resolve_step_references(&step.params, &results_by_id) {
            Ok(params) => params,
            Err(e) => {
                let duration_ms = step_start.elapsed().as_millis() as u64;
                let error_msg = format!("Reference resolution failed: {e}");

                let _ = app.emit(
                    "agent:plan_step_failed",
                    PlanStepFailedEvent {
                        plan_id: plan_id.clone(),
                        step_id: step.id.clone(),
                        step_index: step_idx,
                        total_steps,
                        error: error_msg.clone(),
                    },
                );

                let result = StepResult {
                    step_id: step.id.clone(),
                    success: false,
                    data: None,
                    error: Some(error_msg),
                    duration_ms,
                    operation_id: None,
                };
                step_results.push(result);

                // Rollback completed steps
                let rollback_report = rollback_steps(project, &executor, step_idx, &step_results);

                return Ok(AgentPlanResult {
                    plan_id,
                    success: false,
                    total_steps,
                    steps_completed,
                    step_results,
                    operation_ids,
                    rollback_report: Some(rollback_report),
                    error_message: Some(format!(
                        "Step '{}' failed: reference resolution error",
                        step.id
                    )),
                    execution_time_ms: start.elapsed().as_millis() as u64,
                });
            }
        };

        // Parse tool_name + resolved_params into a CommandPayload
        let typed_payload = match CommandPayload::parse(step.tool_name.clone(), resolved_params) {
            Ok(payload) => payload,
            Err(e) => {
                let duration_ms = step_start.elapsed().as_millis() as u64;
                let error_msg = format!("Invalid command '{}': {e}", step.tool_name);

                let _ = app.emit(
                    "agent:plan_step_failed",
                    PlanStepFailedEvent {
                        plan_id: plan_id.clone(),
                        step_id: step.id.clone(),
                        step_index: step_idx,
                        total_steps,
                        error: error_msg.clone(),
                    },
                );

                let result = StepResult {
                    step_id: step.id.clone(),
                    success: false,
                    data: None,
                    error: Some(error_msg),
                    duration_ms,
                    operation_id: None,
                };
                step_results.push(result);

                let rollback_report = rollback_steps(project, &executor, step_idx, &step_results);

                return Ok(AgentPlanResult {
                    plan_id,
                    success: false,
                    total_steps,
                    steps_completed,
                    step_results,
                    operation_ids,
                    rollback_report: Some(rollback_report),
                    error_message: Some(format!("Step '{}' failed: invalid command", step.id)),
                    execution_time_ms: start.elapsed().as_millis() as u64,
                });
            }
        };

        // Build and execute the command
        let command = typed_payload.build_command(&project_path);
        match project.executor.execute(command, &mut project.state) {
            Ok(cmd_result) => {
                let duration_ms = step_start.elapsed().as_millis() as u64;
                let op_id = cmd_result.op_id.clone();

                let step_data = serde_json::json!({
                    "operationId": op_id,
                    "createdIds": cmd_result.created_ids,
                    "deletedIds": cmd_result.deleted_ids,
                });

                let result = StepResult {
                    step_id: step.id.clone(),
                    success: true,
                    data: Some(step_data),
                    error: None,
                    duration_ms,
                    operation_id: Some(op_id.clone()),
                };

                let _ = app.emit(
                    "agent:plan_step_complete",
                    PlanStepCompleteEvent {
                        plan_id: plan_id.clone(),
                        step_id: step.id.clone(),
                        step_index: step_idx,
                        total_steps,
                        operation_id: Some(op_id.clone()),
                        duration_ms,
                    },
                );

                operation_ids.push(op_id);
                results_by_id.insert(step.id.clone(), result.clone());
                step_results.push(result);
                steps_completed += 1;

                tracing::debug!(
                    step_id = %step.id,
                    step_index = step_idx,
                    duration_ms = duration_ms,
                    "Plan step completed successfully"
                );
            }
            Err(e) => {
                let duration_ms = step_start.elapsed().as_millis() as u64;
                let error_msg = format!("Command execution failed: {e}");

                let _ = app.emit(
                    "agent:plan_step_failed",
                    PlanStepFailedEvent {
                        plan_id: plan_id.clone(),
                        step_id: step.id.clone(),
                        step_index: step_idx,
                        total_steps,
                        error: error_msg.clone(),
                    },
                );

                let result = StepResult {
                    step_id: step.id.clone(),
                    success: false,
                    data: None,
                    error: Some(error_msg),
                    duration_ms,
                    operation_id: None,
                };
                step_results.push(result);

                tracing::warn!(
                    step_id = %step.id,
                    step_index = step_idx,
                    error = %e,
                    "Plan step failed, initiating rollback"
                );

                // Rollback completed steps
                let rollback_report = rollback_steps(project, &executor, step_idx, &step_results);

                return Ok(AgentPlanResult {
                    plan_id,
                    success: false,
                    total_steps,
                    steps_completed,
                    step_results,
                    operation_ids,
                    rollback_report: Some(rollback_report),
                    error_message: Some(format!("Step '{}' failed during execution", step.id)),
                    execution_time_ms: start.elapsed().as_millis() as u64,
                });
            }
        }
    }

    tracing::info!(
        plan_id = %plan_id,
        steps_completed = steps_completed,
        elapsed_ms = start.elapsed().as_millis(),
        "Agent plan executed successfully"
    );

    Ok(AgentPlanResult {
        plan_id,
        success: true,
        total_steps,
        steps_completed,
        step_results,
        operation_ids,
        rollback_report: None,
        error_message: None,
        execution_time_ms: start.elapsed().as_millis() as u64,
    })
}

/// Rollback completed steps in reverse order using the CommandExecutor's undo stack.
fn rollback_steps(
    project: &mut crate::ActiveProject,
    executor: &PlanExecutor,
    failed_index: usize,
    step_results: &[StepResult],
) -> crate::core::ai::agent_plan::RollbackReport {
    // Build the initial report (with candidate steps identified)
    let mut report = executor.build_rollback_report(failed_index, step_results);

    if !report.attempted {
        return report;
    }

    // Undo completed operations in reverse order via the CommandExecutor's undo stack
    let mut succeeded = 0usize;
    let mut failed = 0usize;
    let mut rollback_errors = Vec::new();

    for step_id in &report.rolled_back_steps.clone() {
        match project.executor.undo(&mut project.state) {
            Ok(()) => {
                succeeded += 1;
                tracing::debug!(step_id = %step_id, "Rolled back step successfully");
            }
            Err(e) => {
                failed += 1;
                let error_msg = format!("Failed to undo step '{}': {}", step_id, e);
                tracing::error!("{}", error_msg);
                rollback_errors.push(error_msg);
                // Stop rollback on first undo failure to avoid inconsistent state
                break;
            }
        }
    }

    report.succeeded_count = succeeded;
    report.failed_count = failed;
    report.rollback_errors = rollback_errors;

    report
}

// =============================================================================
// Agent Memory Persistence
// =============================================================================

/// Global agent memory database instance.
/// Initialized when the first memory command is called.
static MEMORY_DB: OnceLock<Mutex<AgentMemoryDb>> = OnceLock::new();
static MEMORY_DB_INIT_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Returns a reference to the lazily-initialized agent memory database.
///
/// On first call the database file (`agent_memory.db`) is created inside the
/// platform-specific application data directory. Subsequent calls return the
/// same instance without re-opening the file.
fn get_or_init_memory_db(app: &tauri::AppHandle) -> Result<&'static Mutex<AgentMemoryDb>, String> {
    if let Some(db) = MEMORY_DB.get() {
        return Ok(db);
    }

    let _guard = MEMORY_DB_INIT_LOCK
        .lock()
        .map_err(|_| "Failed to lock agent memory database initializer".to_string())?;

    if let Some(db) = MEMORY_DB.get() {
        return Ok(db);
    }

    let app_data = crate::core::ai::get_app_data_dir(app)?;
    std::fs::create_dir_all(&app_data)
        .map_err(|e| format!("Failed to create app data dir: {e}"))?;
    let db_path = app_data.join("agent_memory.db");
    let db = AgentMemoryDb::create(&db_path)
        .map_err(|e| format!("Failed to open agent memory database: {e}"))?;

    let _ = MEMORY_DB.set(Mutex::new(db));

    MEMORY_DB
        .get()
        .ok_or_else(|| "Failed to initialize agent memory database".to_string())
}

/// Save (upsert) an agent memory entry.
///
/// If an entry with the same ID already exists, its value, updated_at, and
/// ttl_seconds are updated. Otherwise a new entry is created.
#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip(app), fields(id = %id, category = %category))]
pub async fn save_agent_memory(
    app: tauri::AppHandle,
    id: String,
    project_id: String,
    category: String,
    key: String,
    value: String,
    ttl_seconds: Option<i64>,
) -> Result<(), String> {
    let db_mutex = get_or_init_memory_db(&app)?;
    let db = db_mutex.lock().await;

    db.save(&id, &project_id, &category, &key, &value, ttl_seconds)
        .map_err(|e| format!("Failed to save agent memory: {e}"))?;

    tracing::debug!(
        "Agent memory saved: {} / {} / {}",
        project_id,
        category,
        key
    );
    Ok(())
}

/// Retrieve agent memory entries by project ID and category.
///
/// Excludes entries whose TTL has expired. Results are ordered by most
/// recently updated first.
#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip(app), fields(project_id = %project_id, category = %category))]
pub async fn get_agent_memory(
    app: tauri::AppHandle,
    project_id: String,
    category: String,
) -> Result<Vec<MemoryEntry>, String> {
    let db_mutex = get_or_init_memory_db(&app)?;
    let db = db_mutex.lock().await;

    let entries = db
        .get_by_category(&project_id, &category)
        .map_err(|e| format!("Failed to get agent memory: {e}"))?;

    Ok(entries)
}

/// Delete a single agent memory entry by its ID.
#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip(app), fields(id = %id))]
pub async fn delete_agent_memory(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let db_mutex = get_or_init_memory_db(&app)?;
    let db = db_mutex.lock().await;

    db.delete(&id)
        .map_err(|e| format!("Failed to delete agent memory: {e}"))?;

    tracing::debug!("Agent memory deleted: {}", id);
    Ok(())
}

/// Clear agent memory entries for a project.
///
/// When `category` is provided, only entries matching that category are
/// deleted. When omitted, all entries for the project are removed.
/// Returns the number of entries deleted.
#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip(app), fields(project_id = %project_id))]
pub async fn clear_agent_memory(
    app: tauri::AppHandle,
    project_id: String,
    category: Option<String>,
) -> Result<usize, String> {
    let db_mutex = get_or_init_memory_db(&app)?;
    let db = db_mutex.lock().await;

    let cleared = db
        .clear(&project_id, category.as_deref())
        .map_err(|e| format!("Failed to clear agent memory: {e}"))?;

    tracing::debug!(
        "Agent memory cleared: {} entries for project {}",
        cleared,
        project_id
    );
    Ok(cleared)
}

// =============================================================================
// Stock Media Search
// =============================================================================

/// A single stock media search result (IPC-safe DTO).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct StockMediaSearchResult {
    /// Unique identifier within the provider.
    pub id: String,
    /// Display name.
    pub name: String,
    /// Asset type: "image", "video", or "audio".
    pub asset_type: String,
    /// Thumbnail URL (if available).
    pub thumbnail: Option<String>,
    /// Duration in seconds (for video/audio).
    pub duration_sec: Option<f64>,
    /// File size in bytes (if known).
    pub size_bytes: Option<u64>,
    /// Tags for categorization.
    pub tags: Vec<String>,
    /// Provider that returned the asset.
    pub provider: String,
    /// Normalized license information.
    pub license: LicenseInfo,
    /// Policy decision for the current default asset discovery context.
    pub license_policy: LicensePolicyDecision,
    /// Additional provider-specific metadata such as preview URLs and license.
    pub metadata: serde_json::Value,
}

/// Result of downloading and importing a stock media candidate.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct StockMediaImportResult {
    /// Generated OpenReelio asset ID.
    pub asset_id: String,
    /// Imported asset display name.
    pub name: String,
    /// Local project file path that was downloaded.
    pub local_path: String,
    /// Operation ID for the import command.
    pub op_id: String,
    /// License snapshot path persisted with the import.
    pub license_snapshot_path: String,
}

async fn get_stock_provider_api_key(
    app: &tauri::AppHandle,
    credential_type: CredentialType,
    provider_label: &str,
    env_names: &[&str],
) -> Result<Option<String>, String> {
    let app_data_dir = super::system::get_app_data_dir(app)?;
    let vault_path = app_data_dir.join("credentials.vault");

    if vault_path.exists() {
        match CredentialVault::new(vault_path) {
            Ok(vault) => {
                if vault.exists(credential_type).await {
                    if let Ok(key) = vault.retrieve(credential_type).await {
                        let trimmed = key.trim();
                        if !trimmed.is_empty() {
                            return Ok(Some(trimmed.to_string()));
                        }
                    }
                }
            }
            Err(e) => {
                tracing::warn!(
                    "Failed to open credential vault for {}: {}",
                    provider_label,
                    e
                );
            }
        }
    }

    Ok(env_names
        .iter()
        .find_map(|name| std::env::var(name).ok())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty()))
}

async fn get_freesound_api_key(app: &tauri::AppHandle) -> Result<Option<String>, String> {
    get_stock_provider_api_key(
        app,
        CredentialType::FreesoundApiKey,
        "Freesound",
        &["OPENREELIO_FREESOUND_API_KEY", "FREESOUND_API_KEY"],
    )
    .await
}

async fn get_pexels_api_key(app: &tauri::AppHandle) -> Result<Option<String>, String> {
    get_stock_provider_api_key(
        app,
        CredentialType::PexelsApiKey,
        "Pexels",
        &["OPENREELIO_PEXELS_API_KEY", "PEXELS_API_KEY"],
    )
    .await
}

async fn get_pixabay_api_key(app: &tauri::AppHandle) -> Result<Option<String>, String> {
    get_stock_provider_api_key(
        app,
        CredentialType::PixabayApiKey,
        "Pixabay",
        &["OPENREELIO_PIXABAY_API_KEY", "PIXABAY_API_KEY"],
    )
    .await
}

fn license_info_from_asset_ref(asset_ref: &PluginAssetRef) -> LicenseInfo {
    asset_ref
        .metadata
        .get("license")
        .and_then(|license| license.get("licenseInfo"))
        .and_then(|value| serde_json::from_value::<LicenseInfo>(value.clone()).ok())
        .unwrap_or_else(|| {
            match asset_ref
                .metadata
                .get("provider")
                .and_then(|value| value.as_str())
            {
                Some("pexels") => StockMediaProvider::pexels_license(),
                Some("pixabay") => StockMediaProvider::pixabay_license(),
                Some("freesound") => FreesoundProvider::license_for_raw(
                    asset_ref
                        .metadata
                        .get("license")
                        .and_then(|license| license.get("licenseName"))
                        .and_then(|value| value.as_str()),
                ),
                _ => LicenseInfo::default(),
            }
        })
}

fn sanitize_stock_filename_component(value: &str, fallback: &str) -> String {
    let normalized = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' || ch == '.' {
                ch
            } else if ch.is_whitespace() {
                '-'
            } else {
                '_'
            }
        })
        .collect::<String>();
    let trimmed = normalized
        .trim_matches(|ch| ch == '-' || ch == '_' || ch == '.')
        .chars()
        .take(80)
        .collect::<String>();

    if trimmed.is_empty() {
        fallback.to_string()
    } else {
        trimmed
    }
}

#[cfg(feature = "ai-providers")]
const STOCK_DOWNLOAD_MAX_REDIRECTS: usize = 5;

#[cfg(feature = "ai-providers")]
fn stock_extension_from_url(source_url: &str, asset_type: &str) -> Option<String> {
    reqwest::Url::parse(source_url)
        .ok()
        .and_then(|url| {
            std::path::Path::new(url.path())
                .extension()
                .and_then(|ext| ext.to_str())
                .map(|ext| ext.to_ascii_lowercase())
        })
        .filter(|ext| is_allowed_stock_extension(asset_type, ext))
}

fn stock_default_extension(asset_type: &str) -> String {
    match asset_type {
        "audio" => "mp3".to_string(),
        "image" => "jpg".to_string(),
        "video" => "mp4".to_string(),
        _ => "bin".to_string(),
    }
}

fn stock_extension_from_content_type(
    content_type: Option<&str>,
    asset_type: &str,
) -> Option<String> {
    let content_type = content_type?.split(';').next()?.trim().to_ascii_lowercase();
    let ext = match content_type.as_str() {
        "audio/mpeg" | "audio/mp3" => "mp3",
        "audio/wav" | "audio/x-wav" => "wav",
        "audio/ogg" => "ogg",
        "audio/aac" => "aac",
        "audio/flac" => "flac",
        "image/jpeg" => "jpg",
        "image/png" => "png",
        "image/webp" => "webp",
        "image/gif" => "gif",
        "video/mp4" => "mp4",
        "video/quicktime" => "mov",
        "video/webm" => "webm",
        _ => return None,
    };

    if is_allowed_stock_extension(asset_type, ext) {
        Some(ext.to_string())
    } else {
        None
    }
}

fn is_allowed_stock_extension(asset_type: &str, extension: &str) -> bool {
    match asset_type {
        "audio" => matches!(
            extension,
            "mp3" | "wav" | "ogg" | "m4a" | "aac" | "flac" | "opus" | "webm"
        ),
        "image" => matches!(extension, "jpg" | "jpeg" | "png" | "webp" | "gif" | "bmp"),
        "video" => matches!(extension, "mp4" | "mov" | "webm" | "mkv"),
        _ => false,
    }
}

fn stock_download_size_limit(asset_type: &str) -> u64 {
    match asset_type {
        "audio" => 50 * 1024 * 1024,
        "image" => 50 * 1024 * 1024,
        "video" => 500 * 1024 * 1024,
        _ => 25 * 1024 * 1024,
    }
}

#[cfg(feature = "ai-providers")]
fn validate_stock_download_url(source_url: &str) -> Result<reqwest::Url, String> {
    let parsed = reqwest::Url::parse(source_url)
        .map_err(|e| format!("Invalid stock media download URL: {e}"))?;
    if parsed.scheme() != "https" {
        return Err("Stock media downloads must use HTTPS URLs.".to_string());
    }

    let host = parsed
        .host_str()
        .ok_or_else(|| "Stock media download URL must include a host.".to_string())?
        .trim_matches(|ch| ch == '[' || ch == ']')
        .to_ascii_lowercase();

    if let Ok(ip) = host.parse::<std::net::IpAddr>() {
        let private_host = match ip {
            std::net::IpAddr::V4(ip) => {
                let octets = ip.octets();
                ip.is_private()
                    || ip.is_loopback()
                    || ip.is_link_local()
                    || ip.is_unspecified()
                    || ip.is_broadcast()
                    || octets[0] == 0
                    || (octets[0] == 100 && (64..=127).contains(&octets[1]))
            }
            std::net::IpAddr::V6(ip) => {
                ip.is_loopback()
                    || ip.is_unspecified()
                    || ip.is_unique_local()
                    || ip.is_unicast_link_local()
            }
        };
        if private_host {
            return Err(
                "Stock media download URL must not target local/private hosts.".to_string(),
            );
        }
    } else if host == "localhost"
        || host.ends_with(".localhost")
        || host.ends_with(".local")
        || host == "0.0.0.0"
        || host.starts_with("0.")
        || host.starts_with("127.")
        || host.starts_with("10.")
        || host.starts_with("100.64.")
        || host.starts_with("169.254.")
        || host.starts_with("192.168.")
        || host == "::1"
    {
        return Err("Stock media download URL must not target local/private hosts.".to_string());
    }

    if let Some(second_octet) = host
        .strip_prefix("172.")
        .and_then(|rest| rest.split('.').next())
        .and_then(|octet| octet.parse::<u8>().ok())
    {
        if (16..=31).contains(&second_octet) {
            return Err(
                "Stock media download URL must not target local/private hosts.".to_string(),
            );
        }
    }

    Ok(parsed)
}

#[cfg(feature = "ai-providers")]
async fn send_validated_stock_download_request(
    client: &reqwest::Client,
    initial_url: reqwest::Url,
) -> Result<(reqwest::Response, reqwest::Url), String> {
    let mut current_url = initial_url;

    for redirect_count in 0..=STOCK_DOWNLOAD_MAX_REDIRECTS {
        let response = client
            .get(current_url.clone())
            .send()
            .await
            .map_err(|e| format!("Stock media download failed: {e}"))?;

        if !response.status().is_redirection() {
            return Ok((response, current_url));
        }
        if redirect_count >= STOCK_DOWNLOAD_MAX_REDIRECTS {
            return Err("Stock media download redirected too many times.".to_string());
        }

        let location = response
            .headers()
            .get(reqwest::header::LOCATION)
            .ok_or_else(|| "Stock media redirect response did not include Location.".to_string())?
            .to_str()
            .map_err(|_| "Stock media redirect Location was not valid UTF-8.".to_string())?;
        let next_url = current_url
            .join(location)
            .map_err(|e| format!("Invalid stock media redirect URL: {e}"))?;
        current_url = validate_stock_download_url(next_url.as_str())?;
    }

    Err("Stock media download redirected too many times.".to_string())
}

#[cfg(feature = "ai-providers")]
fn cleanup_stock_import_files(paths: &[&Path]) {
    for path in paths {
        match std::fs::remove_file(path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                tracing::warn!(
                    path = %path.display(),
                    error = %error,
                    "Failed to remove staged stock media import file"
                );
            }
        }
    }
}

fn normalize_stock_asset_type(asset_type: &str) -> Result<String, String> {
    match asset_type {
        "audio" | "image" | "video" => Ok(asset_type.to_string()),
        other => Err(format!(
            "Unsupported stock media import asset type: {other}"
        )),
    }
}

async fn search_visual_stock_media(
    app: &tauri::AppHandle,
    search_query: &PluginSearchQuery,
) -> Result<Vec<PluginAssetRef>, String> {
    let pexels_key = get_pexels_api_key(app).await?;
    let pixabay_key = get_pixabay_api_key(app).await?;

    let mut providers = Vec::new();
    if let Some(api_key) = pexels_key {
        providers.push((
            "Pexels",
            StockMediaProvider::new(
                "pexels",
                StockMediaConfig {
                    api_key: Some(api_key),
                    source: StockSource::Pexels,
                    ..Default::default()
                },
            ),
        ));
    }
    if let Some(api_key) = pixabay_key {
        providers.push((
            "Pixabay",
            StockMediaProvider::new(
                "pixabay",
                StockMediaConfig {
                    api_key: Some(api_key),
                    source: StockSource::Pixabay,
                    ..Default::default()
                },
            ),
        ));
    }

    if matches!(search_query.asset_type, Some(PluginAssetType::Video)) && providers.is_empty() {
        return Err(
            "Video stock search requires a Pexels or Pixabay API key because the built-in no-key provider only supports image and audio search. Store credentials with provider 'pexels' or 'pixabay', set OPENREELIO_PEXELS_API_KEY / OPENREELIO_PIXABAY_API_KEY, or configure a hosted/provider plugin."
                .to_string(),
        );
    }

    providers.push((
        "Openverse",
        StockMediaProvider::new(
            "openverse",
            StockMediaConfig {
                api_key: None,
                source: StockSource::Openverse,
                ..Default::default()
            },
        ),
    ));

    let mut refs = Vec::new();
    let mut errors = Vec::new();

    for (provider_label, provider) in providers {
        match provider.search(search_query).await {
            Ok(mut results) => refs.append(&mut results),
            Err(error) => errors.push(format!("{provider_label}: {error}")),
        }
    }

    if refs.is_empty() && !errors.is_empty() {
        return Err(format!("Stock media search failed: {}", errors.join("; ")));
    }

    if !errors.is_empty() {
        tracing::warn!(
            "Some stock media providers failed while others returned results: {}",
            errors.join("; ")
        );
    }

    refs.truncate(search_query.limit);
    Ok(refs)
}

/// Search stock media providers for assets matching a query.
///
/// Uses configured built-in providers. Image/audio search has an Openverse
/// fallback. Video search still requires Pexels and/or Pixabay credentials.
#[tauri::command]
#[specta::specta]
#[tracing::instrument(fields(query = %query, asset_type = ?asset_type, limit = ?limit))]
pub async fn search_stock_media(
    app: tauri::AppHandle,
    query: String,
    asset_type: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<StockMediaSearchResult>, String> {
    let requested_asset_type = asset_type.as_deref().unwrap_or("video");
    let plugin_asset_type = match requested_asset_type {
        "video" => Some(PluginAssetType::Video),
        "image" => Some(PluginAssetType::Image),
        "audio" => Some(PluginAssetType::Audio),
        other => return Err(format!("Unsupported stock media asset type: {other}")),
    };

    let search_query = PluginSearchQuery {
        text: Some(query),
        asset_type: plugin_asset_type,
        limit: limit.unwrap_or(10).clamp(1, 50),
        ..Default::default()
    };

    let refs: Vec<PluginAssetRef> = if plugin_asset_type == Some(PluginAssetType::Audio) {
        let mut refs = Vec::new();
        let mut errors = Vec::new();

        let api_key = get_freesound_api_key(&app).await?;
        if api_key.is_some() {
            let provider = FreesoundProvider::new(
                "freesound",
                FreesoundConfig {
                    api_key,
                    ..Default::default()
                },
            );
            match provider.search(&search_query).await {
                Ok(mut results) => refs.append(&mut results),
                Err(error) => errors.push(format!("Freesound: {error}")),
            }
        }

        let openverse_provider = StockMediaProvider::new(
            "openverse",
            StockMediaConfig {
                api_key: None,
                source: StockSource::Openverse,
                ..Default::default()
            },
        );
        match openverse_provider.search(&search_query).await {
            Ok(mut results) => refs.append(&mut results),
            Err(error) => errors.push(format!("Openverse: {error}")),
        }

        if refs.is_empty() && !errors.is_empty() {
            return Err(format!("Audio stock search failed: {}", errors.join("; ")));
        }
        refs.truncate(search_query.limit);
        refs
    } else {
        search_visual_stock_media(&app, &search_query).await?
    };

    let results: Vec<StockMediaSearchResult> = refs
        .into_iter()
        .map(|r| {
            let license = license_info_from_asset_ref(&r);
            let license_policy =
                evaluate_license_policy(&license, &LicensePolicyContext::default());
            let provider = r
                .metadata
                .get("provider")
                .and_then(|value| value.as_str())
                .unwrap_or(match r.asset_type {
                    PluginAssetType::Audio => "freesound",
                    _ => "stock-media",
                })
                .to_string();

            StockMediaSearchResult {
                id: r.id,
                name: r.name,
                asset_type: format!("{:?}", r.asset_type).to_lowercase(),
                thumbnail: r.thumbnail,
                duration_sec: r.duration_sec,
                size_bytes: r.size_bytes,
                tags: r.tags,
                provider,
                license,
                license_policy,
                metadata: r.metadata,
            }
        })
        .collect();

    tracing::info!("Stock media search returned {} results", results.len());
    Ok(results)
}

/// Download a stock media candidate into the project and import it as an asset.
///
/// This command is intentionally separate from search. Callers must pass a
/// license snapshot acknowledgement so external assets do not bypass policy.
#[cfg(feature = "ai-providers")]
#[tauri::command]
#[specta::specta]
#[allow(clippy::too_many_arguments)]
#[tracing::instrument(skip(state, license), fields(provider = %provider, asset_type = %asset_type))]
pub async fn import_stock_media_asset(
    source_url: String,
    name: String,
    asset_type: String,
    provider: String,
    license: LicenseInfo,
    license_ack: bool,
    duration_sec: Option<f64>,
    tags: Option<Vec<String>>,
    provider_url: Option<String>,
    state: State<'_, AppState>,
) -> Result<StockMediaImportResult, String> {
    let normalized_asset_type = normalize_stock_asset_type(asset_type.trim())?;
    let source_url = source_url.trim();
    let parsed_url = validate_stock_download_url(source_url)?;
    let provider = provider.trim();
    validate_path_id_component(provider, "provider")?;

    let decision = evaluate_license_policy(&license, &LicensePolicyContext::default());
    if decision.status == LicensePolicyStatus::Blocked {
        return Err(format!(
            "Stock media import blocked by license policy: {}",
            decision.reasons.join("; ")
        ));
    }
    if !license_ack && !decision.required_actions.is_empty() {
        return Err(
            "Stock media import requires licenseAck=true because provider terms and license snapshot actions are required."
                .to_string(),
        );
    }

    let project_root = {
        let guard = state.project.lock().await;
        let project = guard
            .as_ref()
            .ok_or_else(|| CoreError::NoProjectOpen.to_ipc_error())?;
        project.path.clone()
    };
    let canonical_project_root = project_root
        .canonicalize()
        .map_err(|e| format!("Failed to resolve active project path: {e}"))?;

    let imports_dir = project_root
        .join(".openreelio")
        .join("imports")
        .join("stock");
    let licenses_dir = project_root.join(".openreelio").join("licenses");
    ensure_plain_directory(&project_root.join(".openreelio"), ".openreelio directory")?;
    ensure_plain_directory(
        &project_root.join(".openreelio").join("imports"),
        "imports directory",
    )?;
    ensure_plain_directory(&imports_dir, "stock imports directory")?;
    ensure_plain_directory(&licenses_dir, "licenses directory")?;

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(90))
        .user_agent("OpenReelio/asset-import")
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| format!("Failed to build stock media HTTP client: {e}"))?;

    let (response, final_url) = send_validated_stock_download_request(&client, parsed_url).await?;
    if !response.status().is_success() {
        return Err(format!(
            "Stock media download failed with status {}",
            response.status()
        ));
    }

    let size_limit = stock_download_size_limit(&normalized_asset_type);
    if let Some(content_length) = response.content_length() {
        if content_length > size_limit {
            return Err(format!(
                "Stock media download is too large: {} bytes exceeds {} bytes",
                content_length, size_limit
            ));
        }
    }

    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let extension = stock_extension_from_url(final_url.as_str(), &normalized_asset_type)
        .or_else(|| {
            stock_extension_from_content_type(content_type.as_deref(), &normalized_asset_type)
        })
        .or_else(|| stock_extension_from_url(source_url, &normalized_asset_type))
        .unwrap_or_else(|| stock_default_extension(&normalized_asset_type));

    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("Failed to read stock media download: {e}"))?;
    if bytes.len() as u64 > size_limit {
        return Err(format!(
            "Stock media download is too large: {} bytes exceeds {} bytes",
            bytes.len(),
            size_limit
        ));
    }

    let safe_name = sanitize_stock_filename_component(&name, "stock-media");
    let unique_id = ulid::Ulid::new().to_string().to_ascii_lowercase();
    let filename = format!("{safe_name}-{unique_id}.{extension}");
    validate_path_id_component(&filename, "download filename")?;
    let output_path = imports_dir.join(filename);
    write_bytes_atomic_no_symlink(&output_path, &bytes, "stock media download")?;

    let mut imported_license = license.clone();
    let license_filename = format!("{safe_name}-{unique_id}.license.json");
    validate_path_id_component(&license_filename, "license snapshot filename")?;
    let license_snapshot_path = licenses_dir.join(license_filename);
    let snapshot = serde_json::json!({
        "provider": provider,
        "sourceUrl": source_url,
        "providerUrl": provider_url,
        "license": license,
        "policy": decision,
        "importedAt": chrono::Utc::now().to_rfc3339(),
    });
    write_bytes_atomic_no_symlink(
        &license_snapshot_path,
        serde_json::to_string_pretty(&snapshot)
            .map_err(|e| format!("Failed to serialize license snapshot: {e}"))?
            .as_bytes(),
        "stock media license snapshot",
    )?;
    imported_license.proof_path = Some(license_snapshot_path.to_string_lossy().to_string());

    let output_path_string = output_path.to_string_lossy().to_string();
    let mut command =
        ImportAssetCommand::new(&safe_name, &output_path_string).with_license(imported_license);
    command = command.with_project_root(project_root.clone());
    if let Some(relative_path) =
        crate::core::workspace::path_resolver::to_relative(&project_root, &output_path)
    {
        command.asset.relative_path = Some(relative_path);
        command.asset.workspace_managed = true;
    }
    if let Some(duration) = duration_sec.filter(|value| value.is_finite() && *value > 0.0) {
        command = command.with_duration(duration);
    }
    if let Some(tags) = tags {
        for tag in tags
            .into_iter()
            .map(|tag| tag.trim().to_string())
            .filter(|tag| !tag.is_empty())
            .take(12)
        {
            command = command.with_tag(&tag);
        }
    }
    command = command.with_tag("stock");
    command = command.with_tag(provider);

    let asset_id = command.asset_id().to_string();
    let op_id = {
        let mut guard = state.project.lock().await;
        let Some(project) = guard.as_mut() else {
            cleanup_stock_import_files(&[&output_path, &license_snapshot_path]);
            return Err(CoreError::NoProjectOpen.to_ipc_error());
        };
        let active_project_root = match project.path.canonicalize() {
            Ok(path) => path,
            Err(error) => {
                cleanup_stock_import_files(&[&output_path, &license_snapshot_path]);
                return Err(format!("Failed to resolve active project path: {error}"));
            }
        };
        if active_project_root != canonical_project_root {
            cleanup_stock_import_files(&[&output_path, &license_snapshot_path]);
            return Err(
                "Active project changed during stock media import; staged files were discarded."
                    .to_string(),
            );
        }
        let result = project
            .executor
            .execute(Box::new(command), &mut project.state)
            .map_err(|e| e.to_ipc_error())?;
        result.op_id
    };

    state.allow_asset_protocol_file(&output_path);

    Ok(StockMediaImportResult {
        asset_id,
        name: safe_name,
        local_path: output_path_string,
        op_id,
        license_snapshot_path: license_snapshot_path.to_string_lossy().to_string(),
    })
}

/// No-op stock import command for builds without network provider support.
#[cfg(not(feature = "ai-providers"))]
#[tauri::command]
#[specta::specta]
#[allow(clippy::too_many_arguments)]
pub async fn import_stock_media_asset(
    _source_url: String,
    _name: String,
    _asset_type: String,
    _provider: String,
    _license: LicenseInfo,
    _license_ack: bool,
    _duration_sec: Option<f64>,
    _tags: Option<Vec<String>>,
    _provider_url: Option<String>,
    _state: State<'_, AppState>,
) -> Result<StockMediaImportResult, String> {
    Err("Stock media import requires the ai-providers feature.".to_string())
}
