//! Workspace Directory Scanner
//!
//! Recursively scans the project directory for media files,
//! respecting `.openreelignore` rules.

use std::path::{Path, PathBuf};
use std::time::SystemTime;

use walkdir::WalkDir;

use crate::core::assets::AssetKind;

use super::ignore::IgnoreRules;

/// Known media file extensions mapped to their asset kind.
/// Returns `None` for unrecognized extensions (unlike `asset_kind_from_extension`
/// which defaults to Video).
fn media_kind_from_extension(ext: &str) -> Option<AssetKind> {
    match ext.to_lowercase().as_str() {
        // Video
        "mp4" | "mov" | "avi" | "mkv" | "webm" | "m4v" | "wmv" | "flv" => Some(AssetKind::Video),
        // Audio
        "mp3" | "wav" | "aac" | "ogg" | "flac" | "m4a" | "wma" => Some(AssetKind::Audio),
        // Image
        "jpg" | "jpeg" | "png" | "gif" | "bmp" | "webp" | "tiff" | "svg" => Some(AssetKind::Image),
        // Subtitle
        "srt" | "vtt" | "ass" | "ssa" | "sub" => Some(AssetKind::Subtitle),
        // Font
        "ttf" | "otf" | "woff" | "woff2" => Some(AssetKind::Font),
        // Unknown extension — not a media file
        _ => None,
    }
}

/// A file discovered during workspace scanning
#[derive(Debug, Clone)]
pub struct DiscoveredFile {
    /// Relative path within the project folder (forward slashes)
    pub relative_path: String,
    /// Absolute path on disk
    pub absolute_path: PathBuf,
    /// Detected asset kind
    pub kind: AssetKind,
    /// File size in bytes
    pub file_size: u64,
    /// Last modification time
    pub modified_at: SystemTime,
}

/// Recursive directory scanner for workspace media files
pub struct WorkspaceScanner {
    project_root: PathBuf,
    ignore_rules: IgnoreRules,
    max_depth: usize,
}

impl WorkspaceScanner {
    /// Create a new scanner for the given project root
    pub fn new(project_root: PathBuf) -> Self {
        let ignore_rules = IgnoreRules::load(&project_root);
        Self {
            project_root,
            ignore_rules,
            max_depth: 10,
        }
    }

    /// Create a scanner with custom ignore rules
    pub fn with_ignore_rules(project_root: PathBuf, ignore_rules: IgnoreRules) -> Self {
        Self {
            project_root,
            ignore_rules,
            max_depth: 10,
        }
    }

    /// Set the maximum directory depth for scanning
    pub fn with_max_depth(mut self, depth: usize) -> Self {
        self.max_depth = depth;
        self
    }

    /// Perform a full recursive scan of the project directory
    ///
    /// Returns all discovered media files sorted by relative path.
    pub fn scan(&self) -> Vec<DiscoveredFile> {
        let mut files = Vec::new();

        for entry in WalkDir::new(&self.project_root)
            .max_depth(self.max_depth)
            .follow_links(false)
            .into_iter()
            .filter_entry(|e| !self.should_skip_dir(e))
        {
            let entry = match entry {
                Ok(e) => e,
                Err(e) => {
                    tracing::debug!(error = %e, "Skipping unreadable entry during scan");
                    continue;
                }
            };

            if !entry.file_type().is_file() {
                continue;
            }

            if let Some(discovered) = self.process_entry(entry.path()) {
                files.push(discovered);
            }
        }

        // Sort by relative path for deterministic results
        files.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
        files
    }

    /// Scan a single path and return a DiscoveredFile if it's a valid media file
    pub fn scan_path(&self, path: &Path) -> Option<DiscoveredFile> {
        let absolute = if path.is_absolute() {
            path.to_path_buf()
        } else {
            self.project_root.join(path)
        };

        if !absolute.is_file() {
            return None;
        }

        self.process_entry(&absolute)
    }

    /// Check if a directory entry should be skipped entirely
    fn should_skip_dir(&self, entry: &walkdir::DirEntry) -> bool {
        // Always enter the root directory
        if entry.depth() == 0 {
            return false;
        }

        let rel_path = match entry.path().strip_prefix(&self.project_root) {
            Ok(rel) => rel,
            Err(_) => return true,
        };

        self.ignore_rules.is_ignored(rel_path)
    }

    /// Process a file path into a DiscoveredFile if it's a recognized media type
    fn process_entry(&self, absolute_path: &Path) -> Option<DiscoveredFile> {
        // Get relative path
        let rel_path = absolute_path.strip_prefix(&self.project_root).ok()?;

        // Check ignore rules
        if self.ignore_rules.is_ignored(rel_path) {
            return None;
        }

        // Check extension for media type
        let ext = absolute_path.extension()?.to_str()?;
        let kind = media_kind_from_extension(ext)?;

        // Get file metadata
        let metadata = std::fs::metadata(absolute_path).ok()?;
        let file_size = metadata.len();
        let modified_at = metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH);

        let relative_path = rel_path.to_string_lossy().replace('\\', "/");

        Some(DiscoveredFile {
            relative_path,
            absolute_path: absolute_path.to_path_buf(),
            kind,
            file_size,
            modified_at,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    /// Helper to create a file tree for testing
    fn create_test_tree(root: &Path) {
        // Media files
        std::fs::create_dir_all(root.join("footage")).unwrap();
        std::fs::create_dir_all(root.join("footage/broll")).unwrap();
        std::fs::create_dir_all(root.join("audio")).unwrap();
        std::fs::create_dir_all(root.join("images")).unwrap();

        std::fs::write(root.join("footage/interview.mp4"), "video").unwrap();
        std::fs::write(root.join("footage/broll/city.mp4"), "video").unwrap();
        std::fs::write(root.join("footage/broll/sunrise.mov"), "video").unwrap();
        std::fs::write(root.join("audio/bgm.wav"), "audio").unwrap();
        std::fs::write(root.join("audio/narration.mp3"), "audio").unwrap();
        std::fs::write(root.join("images/poster.jpg"), "image").unwrap();
        std::fs::write(root.join("images/logo.png"), "image").unwrap();

        // Non-media files (should be ignored)
        std::fs::write(root.join("notes.txt"), "text").unwrap();
        std::fs::write(root.join("footage/readme.md"), "docs").unwrap();

        // Ignored directories
        std::fs::create_dir_all(root.join(".git/objects")).unwrap();
        std::fs::write(root.join(".git/HEAD"), "ref: refs/heads/main").unwrap();
        std::fs::create_dir_all(root.join(".openreelio")).unwrap();
        std::fs::write(root.join(".openreelio/index.db"), "db").unwrap();
        std::fs::create_dir_all(root.join("exports")).unwrap();
        std::fs::write(root.join("exports/final.mp4"), "export").unwrap();
    }

    #[test]
    fn test_scan_discovers_media_files() {
        let dir = tempdir().unwrap();
        create_test_tree(dir.path());

        let scanner = WorkspaceScanner::new(dir.path().to_path_buf());
        let files = scanner.scan();

        let paths: Vec<&str> = files.iter().map(|f| f.relative_path.as_str()).collect();

        assert!(paths.contains(&"footage/interview.mp4"));
        assert!(paths.contains(&"footage/broll/city.mp4"));
        assert!(paths.contains(&"footage/broll/sunrise.mov"));
        assert!(paths.contains(&"audio/bgm.wav"));
        assert!(paths.contains(&"audio/narration.mp3"));
        assert!(paths.contains(&"images/poster.jpg"));
        assert!(paths.contains(&"images/logo.png"));
    }

    #[test]
    fn test_scan_ignores_non_media_files() {
        let dir = tempdir().unwrap();
        create_test_tree(dir.path());

        let scanner = WorkspaceScanner::new(dir.path().to_path_buf());
        let files = scanner.scan();

        let paths: Vec<&str> = files.iter().map(|f| f.relative_path.as_str()).collect();

        assert!(!paths.contains(&"notes.txt"));
        assert!(!paths.contains(&"footage/readme.md"));
    }

    #[test]
    fn test_scan_respects_ignore_rules() {
        let dir = tempdir().unwrap();
        create_test_tree(dir.path());

        let scanner = WorkspaceScanner::new(dir.path().to_path_buf());
        let files = scanner.scan();

        let paths: Vec<&str> = files.iter().map(|f| f.relative_path.as_str()).collect();

        // Ignored directories should be excluded
        assert!(!paths.iter().any(|p| p.starts_with(".git/")));
        assert!(!paths.iter().any(|p| p.starts_with(".openreelio/")));
        assert!(!paths.iter().any(|p| p.starts_with("exports/")));
    }

    #[test]
    fn test_scan_results_sorted_by_path() {
        let dir = tempdir().unwrap();
        create_test_tree(dir.path());

        let scanner = WorkspaceScanner::new(dir.path().to_path_buf());
        let files = scanner.scan();

        let paths: Vec<&str> = files.iter().map(|f| f.relative_path.as_str()).collect();
        let mut sorted = paths.clone();
        sorted.sort();
        assert_eq!(paths, sorted);
    }

    #[test]
    fn test_scan_detects_correct_asset_kinds() {
        let dir = tempdir().unwrap();
        create_test_tree(dir.path());

        let scanner = WorkspaceScanner::new(dir.path().to_path_buf());
        let files = scanner.scan();

        for file in &files {
            match file.relative_path.as_str() {
                "footage/interview.mp4" => assert_eq!(file.kind, AssetKind::Video),
                "audio/bgm.wav" => assert_eq!(file.kind, AssetKind::Audio),
                "images/poster.jpg" => assert_eq!(file.kind, AssetKind::Image),
                _ => {} // Other files are fine
            }
        }
    }

    #[test]
    fn test_scan_empty_directory() {
        let dir = tempdir().unwrap();
        let scanner = WorkspaceScanner::new(dir.path().to_path_buf());
        let files = scanner.scan();
        assert!(files.is_empty());
    }

    #[test]
    fn test_scan_path_existing_file() {
        let dir = tempdir().unwrap();
        create_test_tree(dir.path());

        let scanner = WorkspaceScanner::new(dir.path().to_path_buf());
        let result = scanner.scan_path(Path::new("footage/interview.mp4"));
        assert!(result.is_some());

        let file = result.unwrap();
        assert_eq!(file.relative_path, "footage/interview.mp4");
        assert_eq!(file.kind, AssetKind::Video);
    }

    #[test]
    fn test_scan_path_nonexistent_file() {
        let dir = tempdir().unwrap();
        let scanner = WorkspaceScanner::new(dir.path().to_path_buf());
        let result = scanner.scan_path(Path::new("missing.mp4"));
        assert!(result.is_none());
    }

    #[test]
    fn test_scan_path_non_media_file() {
        let dir = tempdir().unwrap();
        create_test_tree(dir.path());

        let scanner = WorkspaceScanner::new(dir.path().to_path_buf());
        let result = scanner.scan_path(Path::new("notes.txt"));
        assert!(result.is_none());
    }

    #[test]
    fn test_scan_path_ignored_file() {
        let dir = tempdir().unwrap();
        create_test_tree(dir.path());

        let scanner = WorkspaceScanner::new(dir.path().to_path_buf());
        let result = scanner.scan_path(Path::new("exports/final.mp4"));
        assert!(result.is_none());
    }

    #[test]
    fn test_scan_with_custom_ignore_rules() {
        let dir = tempdir().unwrap();
        create_test_tree(dir.path());

        // Write custom ignore file
        std::fs::write(
            dir.path().join(".openreelignore"),
            "# Ignore broll\nfootage/broll/**\n",
        )
        .unwrap();

        let scanner = WorkspaceScanner::new(dir.path().to_path_buf());
        let files = scanner.scan();

        let paths: Vec<&str> = files.iter().map(|f| f.relative_path.as_str()).collect();
        assert!(paths.contains(&"footage/interview.mp4"));
        assert!(!paths.contains(&"footage/broll/city.mp4"));
        assert!(!paths.contains(&"footage/broll/sunrise.mov"));
    }

    #[test]
    fn test_scan_max_depth() {
        let dir = tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("a/b/c")).unwrap();
        std::fs::write(dir.path().join("a/top.mp4"), "v").unwrap();
        std::fs::write(dir.path().join("a/b/mid.mp4"), "v").unwrap();
        std::fs::write(dir.path().join("a/b/c/deep.mp4"), "v").unwrap();

        // walkdir depth: root(0) -> a(1) -> top.mp4(2), b(2) -> mid.mp4(3), c(3) -> deep.mp4(4)
        let scanner = WorkspaceScanner::new(dir.path().to_path_buf()).with_max_depth(3);
        let files = scanner.scan();

        let paths: Vec<&str> = files.iter().map(|f| f.relative_path.as_str()).collect();
        assert!(paths.contains(&"a/top.mp4"));
        assert!(paths.contains(&"a/b/mid.mp4"));
        // c/ is at depth 3 (max), so files inside c/ at depth 4 are excluded
        assert!(!paths.contains(&"a/b/c/deep.mp4"));
    }

    #[test]
    fn test_scan_file_metadata() {
        let dir = tempdir().unwrap();
        let content = b"fake video data with some content";
        std::fs::write(dir.path().join("test.mp4"), content).unwrap();

        let scanner = WorkspaceScanner::new(dir.path().to_path_buf());
        let files = scanner.scan();

        assert_eq!(files.len(), 1);
        assert_eq!(files[0].file_size, content.len() as u64);
        assert!(files[0].modified_at > SystemTime::UNIX_EPOCH);
    }

    #[test]
    fn test_media_kind_detection() {
        assert_eq!(media_kind_from_extension("mp4"), Some(AssetKind::Video));
        assert_eq!(media_kind_from_extension("MP4"), Some(AssetKind::Video));
        assert_eq!(media_kind_from_extension("wav"), Some(AssetKind::Audio));
        assert_eq!(media_kind_from_extension("jpg"), Some(AssetKind::Image));
        assert_eq!(media_kind_from_extension("srt"), Some(AssetKind::Subtitle));
        assert_eq!(media_kind_from_extension("ttf"), Some(AssetKind::Font));
        assert_eq!(media_kind_from_extension("txt"), None);
        assert_eq!(media_kind_from_extension("exe"), None);
        assert_eq!(media_kind_from_extension("rs"), None);
    }
}
