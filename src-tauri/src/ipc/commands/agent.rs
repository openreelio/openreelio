//! Agent IPC Commands
//!
//! Tauri commands for agent-related operations:
//! trace file writing, plan execution, and memory persistence.

use std::path::PathBuf;
use std::sync::OnceLock;

use tauri::State;
use tokio::sync::Mutex;

use std::collections::HashMap;

use tauri::Emitter;

use crate::core::ai::agent_plan::{AgentPlan, AgentPlanResult, StepResult};
use crate::core::ai::memory::{AgentMemoryDb, MemoryEntry};
use crate::core::ai::plan_executor::{resolve_step_references, PlanExecutor};
use crate::core::CoreError;
use crate::ipc::payloads::CommandPayload;
use crate::AppState;

// =============================================================================
// Trace Writing
// =============================================================================

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

    let traces_dir = project_path.join(".openreelio").join("traces");

    // Ensure traces directory exists
    tokio::fs::create_dir_all(&traces_dir)
        .await
        .map_err(|e| format!("Failed to create traces directory: {}", e))?;

    // Rotate old traces if needed
    rotate_traces(&traces_dir, max_files).await;

    // Sanitize trace_id to prevent path traversal
    if trace_id.contains('/') || trace_id.contains('\\') || trace_id.contains("..") {
        return Err("Invalid trace_id: contains path separators or '..'".to_string());
    }

    // Write the trace file
    let file_path = traces_dir.join(format!("{}.json", trace_id));
    tokio::fs::write(&file_path, trace_json.as_bytes())
        .await
        .map_err(|e| format!("Failed to write trace file: {}", e))?;

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
static MEMORY_DB: OnceLock<Result<Mutex<AgentMemoryDb>, String>> = OnceLock::new();

/// Returns a reference to the lazily-initialized agent memory database.
///
/// On first call the database file (`agent_memory.db`) is created inside the
/// platform-specific application data directory. Subsequent calls return the
/// same instance without re-opening the file.
fn get_or_init_memory_db(app: &tauri::AppHandle) -> Result<&'static Mutex<AgentMemoryDb>, String> {
    let result = MEMORY_DB.get_or_init(|| {
        let init = || -> Result<Mutex<AgentMemoryDb>, String> {
            let app_data = crate::core::ai::get_app_data_dir(app)?;
            std::fs::create_dir_all(&app_data)
                .map_err(|e| format!("Failed to create app data dir: {e}"))?;
            let db_path = app_data.join("agent_memory.db");
            let db = AgentMemoryDb::create(&db_path)
                .map_err(|e| format!("Failed to open agent memory database: {e}"))?;
            Ok(Mutex::new(db))
        };
        init()
    });

    match result {
        Ok(mutex) => Ok(mutex),
        Err(e) => Err(e.clone()),
    }
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
