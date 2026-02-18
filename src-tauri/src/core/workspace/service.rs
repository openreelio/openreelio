//! Workspace Orchestration Service
//!
//! Coordinates scanning, indexing, and watching for the project workspace.
//! This is the main entry point for workspace operations.

use std::path::PathBuf;
use std::sync::Arc;

use tokio::sync::mpsc;

use crate::core::CoreResult;

use super::ignore::IgnoreRules;
use super::index::{AssetIndex, IndexEntry};
use super::scanner::WorkspaceScanner;
use super::watcher::{WorkspaceEvent, WorkspaceWatcher};

/// Result of a workspace scan operation
#[derive(Debug, Clone)]
pub struct ScanResult {
    /// Total number of media files found
    pub total_files: usize,
    /// Number of new files discovered (not previously indexed)
    pub new_files: usize,
    /// Number of files that were removed since last scan
    pub removed_files: usize,
    /// Number of files already registered as assets
    pub registered_files: usize,
}

/// An entry in the file tree hierarchy
#[derive(Debug, Clone)]
pub struct FileTreeEntry {
    /// Relative path within the project folder
    pub relative_path: String,
    /// Display name (file or directory name)
    pub name: String,
    /// Whether this is a directory
    pub is_directory: bool,
    /// Asset kind (None for directories)
    pub kind: Option<crate::core::assets::AssetKind>,
    /// File size in bytes (None for directories)
    pub file_size: Option<u64>,
    /// Asset ID if registered as a project asset
    pub asset_id: Option<String>,
    /// Child entries (for directories)
    pub children: Vec<FileTreeEntry>,
}

/// Workspace orchestration service
///
/// Manages the lifecycle of workspace scanning, indexing, and file watching.
pub struct WorkspaceService {
    project_root: PathBuf,
    scanner: WorkspaceScanner,
    index: AssetIndex,
    watcher: Option<WorkspaceWatcher>,
    event_tx: mpsc::UnboundedSender<WorkspaceEvent>,
    event_rx: Option<mpsc::UnboundedReceiver<WorkspaceEvent>>,
    ignore_rules: Arc<IgnoreRules>,
}

impl WorkspaceService {
    /// Open a workspace service for the given project
    pub fn open(project_root: PathBuf) -> CoreResult<Self> {
        let ignore_rules = Arc::new(IgnoreRules::load(&project_root));
        let scanner =
            WorkspaceScanner::with_ignore_rules(project_root.clone(), (*ignore_rules).clone());
        let index = AssetIndex::open(&project_root)?;
        let (event_tx, event_rx) = mpsc::unbounded_channel();

        Ok(Self {
            project_root,
            scanner,
            index,
            watcher: None,
            event_tx,
            event_rx: Some(event_rx),
            ignore_rules,
        })
    }

    /// Perform an initial scan and populate the index
    ///
    /// Compares discovered files with the current index to determine
    /// new, removed, and existing entries.
    pub fn initial_scan(&self) -> CoreResult<ScanResult> {
        let discovered = self.scanner.scan();
        let existing = self.index.get_all()?;

        // Build a set of existing paths for quick lookup
        let existing_paths: std::collections::HashSet<String> =
            existing.iter().map(|e| e.relative_path.clone()).collect();

        let discovered_paths: std::collections::HashSet<String> =
            discovered.iter().map(|f| f.relative_path.clone()).collect();

        let now = chrono::Utc::now().timestamp();
        let mut new_count = 0;
        let mut registered_count = 0;

        // Upsert discovered files
        for file in &discovered {
            let is_new = !existing_paths.contains(&file.relative_path);
            if is_new {
                new_count += 1;
            }

            let modified_at = file
                .modified_at
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);

            let entry = IndexEntry {
                relative_path: file.relative_path.clone(),
                kind: file.kind.clone(),
                file_size: file.file_size,
                modified_at,
                asset_id: None, // Preserved by upsert if already set
                indexed_at: now,
                metadata_extracted: false,
            };

            self.index.upsert(&entry)?;
        }

        // Remove entries that no longer exist on disk
        let mut removed_count = 0;
        for existing_entry in &existing {
            if !discovered_paths.contains(&existing_entry.relative_path) {
                self.index.remove(&existing_entry.relative_path)?;
                removed_count += 1;
            }
        }

        // Count registered files
        for entry in self.index.get_all()? {
            if entry.asset_id.is_some() {
                registered_count += 1;
            }
        }

        Ok(ScanResult {
            total_files: discovered.len(),
            new_files: new_count,
            removed_files: removed_count,
            registered_files: registered_count,
        })
    }

    /// Start watching the workspace for file changes
    pub fn start_watching(&mut self) -> Result<(), String> {
        if self.watcher.is_some() {
            return Ok(()); // Already watching
        }

        let watcher = WorkspaceWatcher::start(
            self.project_root.clone(),
            Arc::clone(&self.ignore_rules),
            self.event_tx.clone(),
        )?;

        self.watcher = Some(watcher);
        tracing::info!(
            project = %self.project_root.display(),
            "Workspace file watching started"
        );
        Ok(())
    }

    /// Stop watching the workspace
    pub fn stop_watching(&mut self) {
        if let Some(mut watcher) = self.watcher.take() {
            watcher.stop();
            tracing::info!("Workspace file watching stopped");
        }
    }

    /// Take the event receiver (can only be called once)
    pub fn take_event_rx(&mut self) -> Option<mpsc::UnboundedReceiver<WorkspaceEvent>> {
        self.event_rx.take()
    }

    /// Build a hierarchical file tree from the index
    pub fn get_file_tree(&self) -> CoreResult<Vec<FileTreeEntry>> {
        let entries = self.index.get_all()?;
        Ok(build_file_tree(&entries))
    }

    /// Get unregistered files from the index
    pub fn get_unregistered_files(&self) -> CoreResult<Vec<IndexEntry>> {
        self.index.get_unregistered()
    }

    /// Get the asset index for direct access
    pub fn index(&self) -> &AssetIndex {
        &self.index
    }

    /// Get the scanner for direct access
    pub fn scanner(&self) -> &WorkspaceScanner {
        &self.scanner
    }

    /// Get the project root path
    pub fn project_root(&self) -> &PathBuf {
        &self.project_root
    }

    /// Process a single workspace event (update index)
    pub fn handle_event(&self, event: &WorkspaceEvent) -> CoreResult<()> {
        match event {
            WorkspaceEvent::FileAdded(rel_path) | WorkspaceEvent::FileModified(rel_path) => {
                if let Some(discovered) =
                    self.scanner.scan_path(std::path::Path::new(rel_path))
                {
                    let now = chrono::Utc::now().timestamp();
                    let modified_at = discovered
                        .modified_at
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_secs() as i64)
                        .unwrap_or(0);

                    let entry = IndexEntry {
                        relative_path: discovered.relative_path,
                        kind: discovered.kind,
                        file_size: discovered.file_size,
                        modified_at,
                        asset_id: None,
                        indexed_at: now,
                        metadata_extracted: false,
                    };
                    self.index.upsert(&entry)?;
                }
            }
            WorkspaceEvent::FileRemoved(rel_path) => {
                self.index.remove(rel_path)?;
            }
        }
        Ok(())
    }
}

/// Build a hierarchical file tree from flat index entries
fn build_file_tree(entries: &[IndexEntry]) -> Vec<FileTreeEntry> {
    use std::collections::BTreeMap;

    // Group files by their directory components
    let mut dirs: BTreeMap<String, Vec<&IndexEntry>> = BTreeMap::new();

    for entry in entries {
        let parent = std::path::Path::new(&entry.relative_path)
            .parent()
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_default();

        dirs.entry(parent).or_default().push(entry);
    }

    // Build tree recursively from root
    build_tree_level("", &dirs)
}

/// Build a single level of the file tree
fn build_tree_level(
    prefix: &str,
    dirs: &std::collections::BTreeMap<String, Vec<&IndexEntry>>,
) -> Vec<FileTreeEntry> {
    let mut result = Vec::new();

    // Collect all unique directory names at this level
    let mut child_dirs: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for dir_path in dirs.keys() {
        if let Some(child) = get_direct_child_dir(prefix, dir_path) {
            child_dirs.insert(child);
        }
    }

    // Add directory entries
    for dir_name in &child_dirs {
        let full_path = if prefix.is_empty() {
            dir_name.clone()
        } else {
            format!("{}/{}", prefix, dir_name)
        };

        let children = build_tree_level(&full_path, dirs);

        result.push(FileTreeEntry {
            relative_path: full_path,
            name: dir_name.clone(),
            is_directory: true,
            kind: None,
            file_size: None,
            asset_id: None,
            children,
        });
    }

    // Add file entries at this level
    if let Some(files) = dirs.get(prefix) {
        for entry in files {
            let name = std::path::Path::new(&entry.relative_path)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();

            result.push(FileTreeEntry {
                relative_path: entry.relative_path.clone(),
                name,
                is_directory: false,
                kind: Some(entry.kind.clone()),
                file_size: Some(entry.file_size),
                asset_id: entry.asset_id.clone(),
                children: vec![],
            });
        }
    }

    result
}

/// Get the immediate child directory name from a full path relative to a prefix
fn get_direct_child_dir(prefix: &str, full_path: &str) -> Option<String> {
    let suffix = if prefix.is_empty() {
        full_path.to_string()
    } else if let Some(s) = full_path.strip_prefix(prefix) {
        s.trim_start_matches('/').to_string()
    } else {
        return None;
    };

    if suffix.is_empty() {
        return None;
    }

    // Get only the first directory component
    suffix.split('/').next().map(|s| s.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::assets::AssetKind;

    fn create_test_project(dir: &std::path::Path) {
        std::fs::create_dir_all(dir.join("footage")).unwrap();
        std::fs::create_dir_all(dir.join("footage/broll")).unwrap();
        std::fs::create_dir_all(dir.join("audio")).unwrap();
        std::fs::write(dir.join("footage/interview.mp4"), "v").unwrap();
        std::fs::write(dir.join("footage/broll/city.mp4"), "v").unwrap();
        std::fs::write(dir.join("audio/bgm.wav"), "a").unwrap();
    }

    #[test]
    fn test_service_open() {
        let dir = tempfile::tempdir().unwrap();
        create_test_project(dir.path());

        let service = WorkspaceService::open(dir.path().to_path_buf()).unwrap();
        assert_eq!(service.project_root(), dir.path());
    }

    #[test]
    fn test_initial_scan() {
        let dir = tempfile::tempdir().unwrap();
        create_test_project(dir.path());

        let service = WorkspaceService::open(dir.path().to_path_buf()).unwrap();
        let result = service.initial_scan().unwrap();

        assert_eq!(result.total_files, 3);
        assert_eq!(result.new_files, 3);
        assert_eq!(result.removed_files, 0);
        assert_eq!(result.registered_files, 0);
    }

    #[test]
    fn test_rescan_detects_new_files() {
        let dir = tempfile::tempdir().unwrap();
        create_test_project(dir.path());

        let service = WorkspaceService::open(dir.path().to_path_buf()).unwrap();
        service.initial_scan().unwrap();

        // Add a new file
        std::fs::write(dir.path().join("footage/extra.mp4"), "v").unwrap();

        let result = service.initial_scan().unwrap();
        assert_eq!(result.total_files, 4);
        assert_eq!(result.new_files, 1);
    }

    #[test]
    fn test_rescan_detects_removed_files() {
        let dir = tempfile::tempdir().unwrap();
        create_test_project(dir.path());

        let service = WorkspaceService::open(dir.path().to_path_buf()).unwrap();
        service.initial_scan().unwrap();

        // Remove a file
        std::fs::remove_file(dir.path().join("audio/bgm.wav")).unwrap();

        let result = service.initial_scan().unwrap();
        assert_eq!(result.total_files, 2);
        assert_eq!(result.removed_files, 1);
    }

    #[test]
    fn test_get_file_tree() {
        let dir = tempfile::tempdir().unwrap();
        create_test_project(dir.path());

        let service = WorkspaceService::open(dir.path().to_path_buf()).unwrap();
        service.initial_scan().unwrap();

        let tree = service.get_file_tree().unwrap();

        // Root should have 2 directories: audio, footage
        assert_eq!(tree.len(), 2);
        assert!(tree.iter().any(|e| e.name == "audio" && e.is_directory));
        assert!(tree.iter().any(|e| e.name == "footage" && e.is_directory));

        // footage should have broll dir + interview.mp4
        let footage = tree.iter().find(|e| e.name == "footage").unwrap();
        assert_eq!(footage.children.len(), 2);
    }

    #[test]
    fn test_get_unregistered_files() {
        let dir = tempfile::tempdir().unwrap();
        create_test_project(dir.path());

        let service = WorkspaceService::open(dir.path().to_path_buf()).unwrap();
        service.initial_scan().unwrap();

        // All files should be unregistered initially
        let unreg = service.get_unregistered_files().unwrap();
        assert_eq!(unreg.len(), 3);

        // Register one
        service
            .index()
            .mark_registered("audio/bgm.wav", "asset-1")
            .unwrap();

        let unreg = service.get_unregistered_files().unwrap();
        assert_eq!(unreg.len(), 2);
    }

    #[test]
    fn test_handle_event_file_added() {
        let dir = tempfile::tempdir().unwrap();
        create_test_project(dir.path());

        let service = WorkspaceService::open(dir.path().to_path_buf()).unwrap();
        service.initial_scan().unwrap();

        // Simulate adding a new file
        std::fs::write(dir.path().join("footage/new.mp4"), "v").unwrap();
        service
            .handle_event(&WorkspaceEvent::FileAdded("footage/new.mp4".to_string()))
            .unwrap();

        assert!(service.index().get("footage/new.mp4").unwrap().is_some());
    }

    #[test]
    fn test_handle_event_file_removed() {
        let dir = tempfile::tempdir().unwrap();
        create_test_project(dir.path());

        let service = WorkspaceService::open(dir.path().to_path_buf()).unwrap();
        service.initial_scan().unwrap();

        std::fs::remove_file(dir.path().join("audio/bgm.wav")).unwrap();
        service
            .handle_event(&WorkspaceEvent::FileRemoved("audio/bgm.wav".to_string()))
            .unwrap();

        assert!(service.index().get("audio/bgm.wav").unwrap().is_none());
    }

    #[test]
    fn test_build_file_tree_nested() {
        let entries = vec![
            IndexEntry {
                relative_path: "a/b/c.mp4".to_string(),
                kind: AssetKind::Video,
                file_size: 100,
                modified_at: 0,
                asset_id: None,
                indexed_at: 0,
                metadata_extracted: false,
            },
            IndexEntry {
                relative_path: "a/d.mp4".to_string(),
                kind: AssetKind::Video,
                file_size: 200,
                modified_at: 0,
                asset_id: Some("asset-1".to_string()),
                indexed_at: 0,
                metadata_extracted: false,
            },
            IndexEntry {
                relative_path: "e.wav".to_string(),
                kind: AssetKind::Audio,
                file_size: 50,
                modified_at: 0,
                asset_id: None,
                indexed_at: 0,
                metadata_extracted: false,
            },
        ];

        let tree = build_file_tree(&entries);

        // Root: dir "a" + file "e.wav"
        assert_eq!(tree.len(), 2);

        let dir_a = tree.iter().find(|e| e.name == "a").unwrap();
        assert!(dir_a.is_directory);
        // a/: dir "b" + file "d.mp4"
        assert_eq!(dir_a.children.len(), 2);

        let file_d = dir_a.children.iter().find(|e| e.name == "d.mp4").unwrap();
        assert!(!file_d.is_directory);
        assert_eq!(file_d.asset_id, Some("asset-1".to_string()));

        let dir_b = dir_a.children.iter().find(|e| e.name == "b").unwrap();
        assert!(dir_b.is_directory);
        assert_eq!(dir_b.children.len(), 1);
        assert_eq!(dir_b.children[0].name, "c.mp4");
    }
}
