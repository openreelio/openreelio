//! Annotation Store
//!
//! Manages per-asset annotation files.
//! Storage: `{project}/.openreelio/annotations/{asset_id}.json`

use std::fs;
use std::path::{Path, PathBuf};

use crate::core::{CoreError, CoreResult};

use super::{AnalysisResult, AnalysisType, AssetAnnotation};

// =============================================================================
// Constants
// =============================================================================

/// Directory name for annotations within project folder
pub const ANNOTATIONS_DIR_NAME: &str = "annotations";

/// OpenReelio project metadata directory
pub const PROJECT_META_DIR: &str = ".openreelio";

// =============================================================================
// Annotation Store
// =============================================================================

/// Manages per-asset annotation files
pub struct AnnotationStore {
    /// Base directory for annotations
    annotations_dir: PathBuf,
}

impl AnnotationStore {
    /// Creates a new annotation store for a project
    pub fn new(project_dir: &Path) -> Self {
        let annotations_dir = project_dir
            .join(PROJECT_META_DIR)
            .join(ANNOTATIONS_DIR_NAME);
        Self { annotations_dir }
    }

    /// Creates the annotation store from an existing annotations directory
    pub fn from_dir(annotations_dir: PathBuf) -> Self {
        Self { annotations_dir }
    }

    /// Returns the annotations directory path
    pub fn annotations_dir(&self) -> &Path {
        &self.annotations_dir
    }

    /// Ensures the annotations directory exists
    pub fn ensure_dir(&self) -> CoreResult<()> {
        if !self.annotations_dir.exists() {
            fs::create_dir_all(&self.annotations_dir).map_err(|e| {
                CoreError::Internal(format!(
                    "Failed to create annotations directory {}: {}",
                    self.annotations_dir.display(),
                    e
                ))
            })?;
        }
        Ok(())
    }

    /// Returns the file path for an asset's annotation
    pub fn annotation_path(&self, asset_id: &str) -> PathBuf {
        self.annotations_dir.join(format!("{}.json", asset_id))
    }

    /// Loads annotation for an asset
    pub fn load(&self, asset_id: &str) -> CoreResult<Option<AssetAnnotation>> {
        let path = self.annotation_path(asset_id);

        if !path.exists() {
            return Ok(None);
        }

        let content = fs::read_to_string(&path).map_err(|e| {
            CoreError::Internal(format!(
                "Failed to read annotation file {}: {}",
                path.display(),
                e
            ))
        })?;

        let annotation: AssetAnnotation = serde_json::from_str(&content).map_err(|e| {
            CoreError::Internal(format!(
                "Failed to parse annotation file {}: {}",
                path.display(),
                e
            ))
        })?;

        Ok(Some(annotation))
    }

    /// Saves annotation for an asset (atomic write via temp file + rename)
    pub fn save(&self, annotation: &AssetAnnotation) -> CoreResult<()> {
        self.ensure_dir()?;

        let path = self.annotation_path(&annotation.asset_id);
        let temp_path = self.annotations_dir.join(format!(
            ".{}.json.tmp.{}",
            annotation.asset_id,
            std::process::id()
        ));

        // Serialize to JSON with pretty formatting
        let content = serde_json::to_string_pretty(annotation)
            .map_err(|e| CoreError::Internal(format!("Failed to serialize annotation: {}", e)))?;

        // Write to temp file
        fs::write(&temp_path, &content).map_err(|e| {
            CoreError::Internal(format!(
                "Failed to write temp annotation file {}: {}",
                temp_path.display(),
                e
            ))
        })?;

        // Atomic rename
        fs::rename(&temp_path, &path).map_err(|e| {
            // Clean up temp file if rename fails
            let _ = fs::remove_file(&temp_path);
            CoreError::Internal(format!(
                "Failed to rename annotation file {} to {}: {}",
                temp_path.display(),
                path.display(),
                e
            ))
        })?;

        Ok(())
    }

    /// Deletes annotation for an asset
    pub fn delete(&self, asset_id: &str) -> CoreResult<()> {
        let path = self.annotation_path(asset_id);

        if path.exists() {
            fs::remove_file(&path).map_err(|e| {
                CoreError::Internal(format!(
                    "Failed to delete annotation file {}: {}",
                    path.display(),
                    e
                ))
            })?;
        }

        Ok(())
    }

    /// Checks if annotation exists for an asset
    pub fn exists(&self, asset_id: &str) -> bool {
        self.annotation_path(asset_id).exists()
    }

    /// Checks if annotation is stale (asset hash changed)
    pub fn is_stale(&self, asset_id: &str, current_hash: &str) -> CoreResult<bool> {
        match self.load(asset_id)? {
            Some(annotation) => Ok(annotation.is_stale(current_hash)),
            None => Ok(false), // No annotation = not stale (just doesn't exist)
        }
    }

    /// Updates a specific analysis type in an existing annotation
    /// Creates new annotation if none exists
    pub fn update_shots(
        &self,
        asset_id: &str,
        asset_hash: &str,
        result: AnalysisResult<super::ShotResult>,
    ) -> CoreResult<AssetAnnotation> {
        let mut annotation = self
            .load(asset_id)?
            .unwrap_or_else(|| AssetAnnotation::new(asset_id, asset_hash));

        // Update hash if changed
        if annotation.asset_hash != asset_hash {
            annotation.asset_hash = asset_hash.to_string();
        }

        annotation.set_shots(result);
        self.save(&annotation)?;
        Ok(annotation)
    }

    /// Updates transcript in an existing annotation
    pub fn update_transcript(
        &self,
        asset_id: &str,
        asset_hash: &str,
        result: AnalysisResult<super::TranscriptSegment>,
    ) -> CoreResult<AssetAnnotation> {
        let mut annotation = self
            .load(asset_id)?
            .unwrap_or_else(|| AssetAnnotation::new(asset_id, asset_hash));

        if annotation.asset_hash != asset_hash {
            annotation.asset_hash = asset_hash.to_string();
        }

        annotation.set_transcript(result);
        self.save(&annotation)?;
        Ok(annotation)
    }

    /// Updates objects in an existing annotation
    pub fn update_objects(
        &self,
        asset_id: &str,
        asset_hash: &str,
        result: AnalysisResult<super::ObjectDetection>,
    ) -> CoreResult<AssetAnnotation> {
        let mut annotation = self
            .load(asset_id)?
            .unwrap_or_else(|| AssetAnnotation::new(asset_id, asset_hash));

        if annotation.asset_hash != asset_hash {
            annotation.asset_hash = asset_hash.to_string();
        }

        annotation.set_objects(result);
        self.save(&annotation)?;
        Ok(annotation)
    }

    /// Updates faces in an existing annotation
    pub fn update_faces(
        &self,
        asset_id: &str,
        asset_hash: &str,
        result: AnalysisResult<super::FaceDetection>,
    ) -> CoreResult<AssetAnnotation> {
        let mut annotation = self
            .load(asset_id)?
            .unwrap_or_else(|| AssetAnnotation::new(asset_id, asset_hash));

        if annotation.asset_hash != asset_hash {
            annotation.asset_hash = asset_hash.to_string();
        }

        annotation.set_faces(result);
        self.save(&annotation)?;
        Ok(annotation)
    }

    /// Updates text OCR in an existing annotation
    pub fn update_text_ocr(
        &self,
        asset_id: &str,
        asset_hash: &str,
        result: AnalysisResult<super::TextDetection>,
    ) -> CoreResult<AssetAnnotation> {
        let mut annotation = self
            .load(asset_id)?
            .unwrap_or_else(|| AssetAnnotation::new(asset_id, asset_hash));

        if annotation.asset_hash != asset_hash {
            annotation.asset_hash = asset_hash.to_string();
        }

        annotation.set_text_ocr(result);
        self.save(&annotation)?;
        Ok(annotation)
    }

    /// Lists all annotated asset IDs
    pub fn list_annotated(&self) -> CoreResult<Vec<String>> {
        if !self.annotations_dir.exists() {
            return Ok(Vec::new());
        }

        let mut asset_ids = Vec::new();

        let entries = fs::read_dir(&self.annotations_dir).map_err(|e| {
            CoreError::Internal(format!(
                "Failed to read annotations directory {}: {}",
                self.annotations_dir.display(),
                e
            ))
        })?;

        for entry in entries {
            let entry = entry.map_err(|e| {
                CoreError::Internal(format!("Failed to read directory entry: {}", e))
            })?;

            let path = entry.path();
            if path.extension().is_some_and(|ext| ext == "json") {
                if let Some(stem) = path.file_stem() {
                    if let Some(name) = stem.to_str() {
                        // Skip temp files
                        if !name.starts_with('.') {
                            asset_ids.push(name.to_string());
                        }
                    }
                }
            }
        }

        asset_ids.sort();
        Ok(asset_ids)
    }

    /// Returns analysis status for an asset
    pub fn get_status(
        &self,
        asset_id: &str,
        current_hash: &str,
    ) -> CoreResult<super::AnalysisStatus> {
        match self.load(asset_id)? {
            None => Ok(super::AnalysisStatus::NotAnalyzed),
            Some(annotation) => {
                if annotation.is_stale(current_hash) {
                    Ok(super::AnalysisStatus::Stale)
                } else if annotation.analysis.has_any() {
                    Ok(super::AnalysisStatus::Completed)
                } else {
                    Ok(super::AnalysisStatus::NotAnalyzed)
                }
            }
        }
    }

    /// Returns available analysis types for an asset
    pub fn get_available_types(&self, asset_id: &str) -> CoreResult<Vec<AnalysisType>> {
        match self.load(asset_id)? {
            None => Ok(Vec::new()),
            Some(annotation) => Ok(annotation.analysis.available_types()),
        }
    }

    /// Clears all annotations (useful for tests or project reset)
    pub fn clear_all(&self) -> CoreResult<()> {
        if !self.annotations_dir.exists() {
            return Ok(());
        }

        let entries = fs::read_dir(&self.annotations_dir).map_err(|e| {
            CoreError::Internal(format!("Failed to read annotations directory: {}", e))
        })?;

        for entry in entries {
            let entry = entry.map_err(|e| {
                CoreError::Internal(format!("Failed to read directory entry: {}", e))
            })?;

            let path = entry.path();
            if path.is_file() && path.extension().is_some_and(|ext| ext == "json") {
                fs::remove_file(&path).map_err(|e| {
                    CoreError::Internal(format!(
                        "Failed to delete annotation file {}: {}",
                        path.display(),
                        e
                    ))
                })?;
            }
        }

        Ok(())
    }
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::annotations::{AnalysisProvider, ShotResult, TranscriptSegment};
    use tempfile::TempDir;

    fn create_test_store() -> (TempDir, AnnotationStore) {
        let temp_dir = TempDir::new().unwrap();
        let store = AnnotationStore::new(temp_dir.path());
        (temp_dir, store)
    }

    // -------------------------------------------------------------------------
    // Basic Operations
    // -------------------------------------------------------------------------

    #[test]
    fn test_store_creation() {
        let (_temp_dir, store) = create_test_store();
        assert!(store.annotations_dir().ends_with("annotations"));
    }

    #[test]
    fn test_annotation_path() {
        let (_temp_dir, store) = create_test_store();
        let path = store.annotation_path("asset_001");
        assert!(path.ends_with("asset_001.json"));
    }

    #[test]
    fn test_ensure_dir() {
        let (_temp_dir, store) = create_test_store();
        assert!(!store.annotations_dir().exists());

        store.ensure_dir().unwrap();
        assert!(store.annotations_dir().exists());
    }

    #[test]
    fn test_load_nonexistent() {
        let (_temp_dir, store) = create_test_store();
        store.ensure_dir().unwrap();

        let result = store.load("nonexistent").unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn test_exists_nonexistent() {
        let (_temp_dir, store) = create_test_store();
        store.ensure_dir().unwrap();

        assert!(!store.exists("nonexistent"));
    }

    // -------------------------------------------------------------------------
    // Save and Load
    // -------------------------------------------------------------------------

    #[test]
    fn test_save_and_load() {
        let (_temp_dir, store) = create_test_store();

        let annotation = AssetAnnotation::new("asset_001", "sha256:abc123");
        store.save(&annotation).unwrap();

        assert!(store.exists("asset_001"));

        let loaded = store.load("asset_001").unwrap().unwrap();
        assert_eq!(loaded.asset_id, "asset_001");
        assert_eq!(loaded.asset_hash, "sha256:abc123");
    }

    #[test]
    fn test_save_creates_directory() {
        let (_temp_dir, store) = create_test_store();
        assert!(!store.annotations_dir().exists());

        let annotation = AssetAnnotation::new("asset_001", "sha256:abc123");
        store.save(&annotation).unwrap();

        assert!(store.annotations_dir().exists());
    }

    #[test]
    fn test_save_overwrites() {
        let (_temp_dir, store) = create_test_store();

        let mut annotation = AssetAnnotation::new("asset_001", "sha256:abc123");
        store.save(&annotation).unwrap();

        // Modify and save again
        annotation.asset_hash = "sha256:def456".to_string();
        annotation.touch();
        store.save(&annotation).unwrap();

        let loaded = store.load("asset_001").unwrap().unwrap();
        assert_eq!(loaded.asset_hash, "sha256:def456");
    }

    #[test]
    fn test_save_with_analysis() {
        let (_temp_dir, store) = create_test_store();

        let mut annotation = AssetAnnotation::new("asset_001", "sha256:abc123");
        annotation.set_shots(AnalysisResult::new(
            AnalysisProvider::Ffmpeg,
            vec![
                ShotResult::new(0.0, 5.0, 0.9),
                ShotResult::new(5.0, 10.0, 0.85),
            ],
        ));
        store.save(&annotation).unwrap();

        let loaded = store.load("asset_001").unwrap().unwrap();
        assert!(loaded.analysis.shots.is_some());
        assert_eq!(loaded.analysis.shots.unwrap().results.len(), 2);
    }

    // -------------------------------------------------------------------------
    // Delete
    // -------------------------------------------------------------------------

    #[test]
    fn test_delete() {
        let (_temp_dir, store) = create_test_store();

        let annotation = AssetAnnotation::new("asset_001", "sha256:abc123");
        store.save(&annotation).unwrap();
        assert!(store.exists("asset_001"));

        store.delete("asset_001").unwrap();
        assert!(!store.exists("asset_001"));
    }

    #[test]
    fn test_delete_nonexistent() {
        let (_temp_dir, store) = create_test_store();
        store.ensure_dir().unwrap();

        // Should not error
        store.delete("nonexistent").unwrap();
    }

    // -------------------------------------------------------------------------
    // Staleness
    // -------------------------------------------------------------------------

    #[test]
    fn test_is_stale_no_annotation() {
        let (_temp_dir, store) = create_test_store();
        store.ensure_dir().unwrap();

        let is_stale = store.is_stale("nonexistent", "sha256:abc123").unwrap();
        assert!(!is_stale);
    }

    #[test]
    fn test_is_stale_same_hash() {
        let (_temp_dir, store) = create_test_store();

        let annotation = AssetAnnotation::new("asset_001", "sha256:abc123");
        store.save(&annotation).unwrap();

        let is_stale = store.is_stale("asset_001", "sha256:abc123").unwrap();
        assert!(!is_stale);
    }

    #[test]
    fn test_is_stale_different_hash() {
        let (_temp_dir, store) = create_test_store();

        let annotation = AssetAnnotation::new("asset_001", "sha256:abc123");
        store.save(&annotation).unwrap();

        let is_stale = store.is_stale("asset_001", "sha256:def456").unwrap();
        assert!(is_stale);
    }

    // -------------------------------------------------------------------------
    // Update Operations
    // -------------------------------------------------------------------------

    #[test]
    fn test_update_shots_new() {
        let (_temp_dir, store) = create_test_store();

        let result = AnalysisResult::new(
            AnalysisProvider::Ffmpeg,
            vec![ShotResult::new(0.0, 5.0, 0.9)],
        );

        let annotation = store
            .update_shots("asset_001", "sha256:abc123", result)
            .unwrap();

        assert_eq!(annotation.asset_id, "asset_001");
        assert!(annotation.analysis.shots.is_some());

        // Verify persisted
        let loaded = store.load("asset_001").unwrap().unwrap();
        assert!(loaded.analysis.shots.is_some());
    }

    #[test]
    fn test_update_shots_existing() {
        let (_temp_dir, store) = create_test_store();

        // Create initial annotation with transcript
        let transcript_result = AnalysisResult::new(
            AnalysisProvider::Whisper,
            vec![TranscriptSegment::new(0.0, 2.5, "Hello", 0.95)],
        );
        store
            .update_transcript("asset_001", "sha256:abc123", transcript_result)
            .unwrap();

        // Update with shots
        let shots_result = AnalysisResult::new(
            AnalysisProvider::Ffmpeg,
            vec![ShotResult::new(0.0, 5.0, 0.9)],
        );
        let annotation = store
            .update_shots("asset_001", "sha256:abc123", shots_result)
            .unwrap();

        // Both should exist
        assert!(annotation.analysis.shots.is_some());
        assert!(annotation.analysis.transcript.is_some());
    }

    #[test]
    fn test_update_with_hash_change() {
        let (_temp_dir, store) = create_test_store();

        // Create with old hash
        let annotation = AssetAnnotation::new("asset_001", "sha256:old");
        store.save(&annotation).unwrap();

        // Update with new hash
        let result = AnalysisResult::new(
            AnalysisProvider::Ffmpeg,
            vec![ShotResult::new(0.0, 5.0, 0.9)],
        );
        let updated = store
            .update_shots("asset_001", "sha256:new", result)
            .unwrap();

        assert_eq!(updated.asset_hash, "sha256:new");
    }

    // -------------------------------------------------------------------------
    // List Operations
    // -------------------------------------------------------------------------

    #[test]
    fn test_list_annotated_empty() {
        let (_temp_dir, store) = create_test_store();
        store.ensure_dir().unwrap();

        let list = store.list_annotated().unwrap();
        assert!(list.is_empty());
    }

    #[test]
    fn test_list_annotated() {
        let (_temp_dir, store) = create_test_store();

        store
            .save(&AssetAnnotation::new("asset_001", "hash1"))
            .unwrap();
        store
            .save(&AssetAnnotation::new("asset_002", "hash2"))
            .unwrap();
        store
            .save(&AssetAnnotation::new("asset_003", "hash3"))
            .unwrap();

        let list = store.list_annotated().unwrap();
        assert_eq!(list.len(), 3);
        assert!(list.contains(&"asset_001".to_string()));
        assert!(list.contains(&"asset_002".to_string()));
        assert!(list.contains(&"asset_003".to_string()));
    }

    #[test]
    fn test_list_annotated_sorted() {
        let (_temp_dir, store) = create_test_store();

        store.save(&AssetAnnotation::new("zebra", "hash")).unwrap();
        store.save(&AssetAnnotation::new("alpha", "hash")).unwrap();
        store.save(&AssetAnnotation::new("middle", "hash")).unwrap();

        let list = store.list_annotated().unwrap();
        assert_eq!(list, vec!["alpha", "middle", "zebra"]);
    }

    #[test]
    fn test_list_annotated_no_directory() {
        let (_temp_dir, store) = create_test_store();
        // Don't create directory

        let list = store.list_annotated().unwrap();
        assert!(list.is_empty());
    }

    // -------------------------------------------------------------------------
    // Status Operations
    // -------------------------------------------------------------------------

    #[test]
    fn test_get_status_not_analyzed() {
        let (_temp_dir, store) = create_test_store();
        store.ensure_dir().unwrap();

        let status = store.get_status("nonexistent", "sha256:abc").unwrap();
        assert_eq!(status, super::super::AnalysisStatus::NotAnalyzed);
    }

    #[test]
    fn test_get_status_completed() {
        let (_temp_dir, store) = create_test_store();

        let mut annotation = AssetAnnotation::new("asset_001", "sha256:abc123");
        annotation.set_shots(AnalysisResult::new(AnalysisProvider::Ffmpeg, vec![]));
        store.save(&annotation).unwrap();

        let status = store.get_status("asset_001", "sha256:abc123").unwrap();
        assert_eq!(status, super::super::AnalysisStatus::Completed);
    }

    #[test]
    fn test_get_status_stale() {
        let (_temp_dir, store) = create_test_store();

        let mut annotation = AssetAnnotation::new("asset_001", "sha256:old");
        annotation.set_shots(AnalysisResult::new(AnalysisProvider::Ffmpeg, vec![]));
        store.save(&annotation).unwrap();

        let status = store.get_status("asset_001", "sha256:new").unwrap();
        assert_eq!(status, super::super::AnalysisStatus::Stale);
    }

    // -------------------------------------------------------------------------
    // Available Types
    // -------------------------------------------------------------------------

    #[test]
    fn test_get_available_types_none() {
        let (_temp_dir, store) = create_test_store();
        store.ensure_dir().unwrap();

        let types = store.get_available_types("nonexistent").unwrap();
        assert!(types.is_empty());
    }

    #[test]
    fn test_get_available_types() {
        let (_temp_dir, store) = create_test_store();

        let mut annotation = AssetAnnotation::new("asset_001", "sha256:abc");
        annotation.set_shots(AnalysisResult::new(AnalysisProvider::Ffmpeg, vec![]));
        annotation.set_transcript(AnalysisResult::new(AnalysisProvider::Whisper, vec![]));
        store.save(&annotation).unwrap();

        let types = store.get_available_types("asset_001").unwrap();
        assert_eq!(types.len(), 2);
        assert!(types.contains(&AnalysisType::Shots));
        assert!(types.contains(&AnalysisType::Transcript));
    }

    // -------------------------------------------------------------------------
    // Clear All
    // -------------------------------------------------------------------------

    #[test]
    fn test_clear_all() {
        let (_temp_dir, store) = create_test_store();

        store
            .save(&AssetAnnotation::new("asset_001", "hash1"))
            .unwrap();
        store
            .save(&AssetAnnotation::new("asset_002", "hash2"))
            .unwrap();

        assert_eq!(store.list_annotated().unwrap().len(), 2);

        store.clear_all().unwrap();

        assert_eq!(store.list_annotated().unwrap().len(), 0);
    }

    #[test]
    fn test_clear_all_no_directory() {
        let (_temp_dir, store) = create_test_store();
        // Don't create directory

        // Should not error
        store.clear_all().unwrap();
    }

    // -------------------------------------------------------------------------
    // Concurrent Safety (basic)
    // -------------------------------------------------------------------------

    #[test]
    fn test_atomic_write_no_corruption() {
        let (_temp_dir, store) = create_test_store();

        // Simulate multiple saves - atomic writes should prevent corruption
        for i in 0..10 {
            let mut annotation = AssetAnnotation::new("asset_001", &format!("hash_{}", i));
            annotation.set_shots(AnalysisResult::new(
                AnalysisProvider::Ffmpeg,
                vec![ShotResult::new(0.0, i as f64, 0.9)],
            ));
            store.save(&annotation).unwrap();
        }

        // Final load should succeed
        let loaded = store.load("asset_001").unwrap().unwrap();
        assert!(loaded.analysis.shots.is_some());
    }
}
