//! IPC Commands for AI Knowledge Base
//!
//! Provides Tauri commands for managing AI knowledge entries.
//! These commands expose the KnowledgeDb layer to the frontend.

use std::sync::OnceLock;

use tokio::sync::Mutex;
use uuid::Uuid;

use super::knowledge::{KnowledgeDb, KnowledgeRow};

/// Allowed knowledge categories. Must match the CHECK constraint in the schema.
const ALLOWED_CATEGORIES: &[&str] = &["convention", "preference", "correction", "pattern"];

// =============================================================================
// Database Singleton
// =============================================================================

static KNOWLEDGE_DB: OnceLock<Result<Mutex<KnowledgeDb>, String>> = OnceLock::new();

fn get_or_init_knowledge_db(app: &tauri::AppHandle) -> Result<&'static Mutex<KnowledgeDb>, String> {
    let result = KNOWLEDGE_DB.get_or_init(|| {
        let init = || -> Result<Mutex<KnowledgeDb>, String> {
            let app_data = super::get_app_data_dir(app)?;
            std::fs::create_dir_all(&app_data)
                .map_err(|e| format!("Failed to create app data dir: {e}"))?;
            let db_path = app_data.join("ai_knowledge.db");
            let db = KnowledgeDb::create(&db_path)
                .map_err(|e| format!("Failed to open knowledge database: {e}"))?;
            Ok(Mutex::new(db))
        };
        init()
    });
    result.as_ref().map_err(|e| e.clone())
}

// =============================================================================
// IPC Commands
// =============================================================================

/// Saves a new knowledge entry for a project.
#[tauri::command]
#[specta::specta]
pub async fn save_ai_knowledge(
    app: tauri::AppHandle,
    project_id: String,
    category: String,
    content: String,
    source_session_id: Option<String>,
    relevance_score: f64,
) -> Result<KnowledgeRow, String> {
    // S4: Validate category against allowed values
    if !ALLOWED_CATEGORIES.contains(&category.as_str()) {
        return Err(format!(
            "Invalid category '{}'. Allowed values: {}",
            category,
            ALLOWED_CATEGORIES.join(", ")
        ));
    }

    // S3: Clamp relevance_score to [0.0, 1.0]
    let relevance_score = relevance_score.clamp(0.0, 1.0);

    let db_mutex = get_or_init_knowledge_db(&app)?;
    let db = db_mutex.lock().await;

    let entry_id = Uuid::new_v4().to_string();

    db.save_entry(
        &entry_id,
        &project_id,
        &category,
        &content,
        source_session_id.as_deref(),
        relevance_score,
    )
    .map_err(|e| format!("Failed to save knowledge entry: {e}"))?;

    // Retrieve the saved entry directly by ID instead of re-querying with limit=1
    db.get_entry_by_id(&entry_id)
        .map_err(|e| format!("Failed to retrieve saved entry: {e}"))?
        .ok_or_else(|| "Failed to find saved knowledge entry".to_string())
}

/// Queries knowledge entries for a project.
#[tauri::command]
#[specta::specta]
pub async fn query_ai_knowledge(
    app: tauri::AppHandle,
    project_id: String,
    categories: Option<Vec<String>>,
    limit: Option<usize>,
    min_relevance: Option<f64>,
) -> Result<Vec<KnowledgeRow>, String> {
    let db_mutex = get_or_init_knowledge_db(&app)?;
    let db = db_mutex.lock().await;

    db.query_entries(
        &project_id,
        categories.as_deref(),
        limit.unwrap_or(20),
        min_relevance.unwrap_or(0.0),
    )
    .map_err(|e| format!("Failed to query knowledge: {e}"))
}

/// Deletes a knowledge entry by ID.
#[tauri::command]
#[specta::specta]
pub async fn delete_ai_knowledge(app: tauri::AppHandle, entry_id: String) -> Result<(), String> {
    let db_mutex = get_or_init_knowledge_db(&app)?;
    let db = db_mutex.lock().await;

    db.delete_entry(&entry_id)
        .map_err(|e| format!("Failed to delete knowledge entry: {e}"))
}
