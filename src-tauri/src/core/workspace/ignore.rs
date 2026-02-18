//! `.openreelignore` Parser
//!
//! Parses `.openreelignore` files using gitignore-compatible syntax via `globset`.
//! Provides built-in default rules and supports user-defined ignore patterns.

use std::path::Path;

use globset::{Glob, GlobSet, GlobSetBuilder};

/// Default ignore patterns applied to all projects
const DEFAULT_IGNORE_PATTERNS: &[&str] = &[
    ".openreelio/**",
    ".git/**",
    "node_modules/**",
    "exports/**",
    "**/*.tmp",
    "**/*.part",
    "**/Thumbs.db",
    "**/.DS_Store",
    "**/*.lnk",
];

/// Ignore rules for workspace scanning
///
/// Determines which files and directories should be excluded from workspace
/// scanning. Combines built-in defaults with user-defined rules from
/// `.openreelignore` files.
#[derive(Debug, Clone)]
pub struct IgnoreRules {
    /// Compiled glob matcher for ignored patterns
    globset: GlobSet,
    /// Original pattern strings (for debugging/serialization)
    patterns: Vec<String>,
}

impl IgnoreRules {
    /// Load ignore rules from the project root
    ///
    /// Reads `.openreelignore` from the project root directory and combines
    /// it with built-in default patterns. If the file doesn't exist, only
    /// default patterns are used.
    pub fn load(project_root: &Path) -> Self {
        let ignore_path = project_root.join(".openreelignore");
        let mut patterns: Vec<String> = DEFAULT_IGNORE_PATTERNS
            .iter()
            .map(|s| s.to_string())
            .collect();

        if ignore_path.exists() {
            if let Ok(content) = std::fs::read_to_string(&ignore_path) {
                for line in content.lines() {
                    let trimmed = line.trim();
                    // Skip empty lines and comments
                    if trimmed.is_empty() || trimmed.starts_with('#') {
                        continue;
                    }
                    patterns.push(trimmed.to_string());
                }
            }
        }

        Self::from_patterns(&patterns)
    }

    /// Create ignore rules from a list of patterns
    pub fn from_patterns(patterns: &[String]) -> Self {
        let mut builder = GlobSetBuilder::new();
        let mut valid_patterns = Vec::new();

        for pattern in patterns {
            let trimmed = pattern.trim();
            if trimmed.is_empty() || trimmed.starts_with('#') {
                continue;
            }

            match Glob::new(trimmed) {
                Ok(glob) => {
                    builder.add(glob);
                    valid_patterns.push(trimmed.to_string());
                }
                Err(e) => {
                    tracing::warn!(
                        pattern = trimmed,
                        error = %e,
                        "Skipping invalid ignore pattern"
                    );
                }
            }
        }

        let globset = builder.build().unwrap_or_else(|e| {
            tracing::error!(error = %e, "Failed to build ignore globset, using empty set");
            GlobSetBuilder::new().build().unwrap()
        });

        Self {
            globset,
            patterns: valid_patterns,
        }
    }

    /// Returns the default content for a new `.openreelignore` file
    pub fn default_ignore_content() -> &'static str {
        "# OpenReelio workspace ignore\n\
         # Files and directories matching these patterns are excluded from workspace scanning.\n\
         # Syntax: gitignore-compatible glob patterns\n\
         \n\
         # Internal project data\n\
         .openreelio/**\n\
         \n\
         # Version control\n\
         .git/**\n\
         \n\
         # Dependencies\n\
         node_modules/**\n\
         \n\
         # Exports (rendered output)\n\
         exports/**\n\
         \n\
         # Temporary files\n\
         **/*.tmp\n\
         **/*.part\n\
         **/Thumbs.db\n\
         **/.DS_Store\n\
         **/*.lnk\n"
    }

    /// Create ignore rules with only the built-in defaults
    pub fn defaults() -> Self {
        let patterns: Vec<String> = DEFAULT_IGNORE_PATTERNS
            .iter()
            .map(|s| s.to_string())
            .collect();
        Self::from_patterns(&patterns)
    }

    /// Check if a relative path should be ignored
    ///
    /// The path should be relative to the project root, using forward slashes.
    pub fn is_ignored(&self, relative_path: &Path) -> bool {
        // Normalize to forward slashes for consistent matching
        let path_str = relative_path.to_string_lossy().replace('\\', "/");

        // Check both the path and the path with trailing slash (for directory matching)
        if self.globset.is_match(&path_str) {
            return true;
        }

        // Check each path component to catch directory-level ignores
        let mut accumulated = String::new();
        for component in path_str.split('/') {
            if !accumulated.is_empty() {
                accumulated.push('/');
            }
            accumulated.push_str(component);

            if self.globset.is_match(&accumulated) {
                return true;
            }
        }

        false
    }

    /// Get the list of active patterns
    pub fn patterns(&self) -> &[String] {
        &self.patterns
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn test_default_rules_ignore_openreelio_dir() {
        let rules = IgnoreRules::defaults();
        assert!(rules.is_ignored(Path::new(".openreelio/index.db")));
        assert!(rules.is_ignored(Path::new(".openreelio/snapshots/latest.json")));
    }

    #[test]
    fn test_default_rules_ignore_git_dir() {
        let rules = IgnoreRules::defaults();
        assert!(rules.is_ignored(Path::new(".git/HEAD")));
        assert!(rules.is_ignored(Path::new(".git/objects/abc123")));
    }

    #[test]
    fn test_default_rules_ignore_node_modules() {
        let rules = IgnoreRules::defaults();
        assert!(rules.is_ignored(Path::new("node_modules/package/index.js")));
    }

    #[test]
    fn test_default_rules_ignore_exports() {
        let rules = IgnoreRules::defaults();
        assert!(rules.is_ignored(Path::new("exports/final.mp4")));
    }

    #[test]
    fn test_default_rules_ignore_tmp_files() {
        let rules = IgnoreRules::defaults();
        assert!(rules.is_ignored(Path::new("render.tmp")));
        assert!(rules.is_ignored(Path::new("subdir/work.tmp")));
    }

    #[test]
    fn test_default_rules_ignore_part_files() {
        let rules = IgnoreRules::defaults();
        assert!(rules.is_ignored(Path::new("download.part")));
    }

    #[test]
    fn test_default_rules_ignore_thumbs_db() {
        let rules = IgnoreRules::defaults();
        assert!(rules.is_ignored(Path::new("Thumbs.db")));
        assert!(rules.is_ignored(Path::new("subdir/Thumbs.db")));
    }

    #[test]
    fn test_default_rules_ignore_ds_store() {
        let rules = IgnoreRules::defaults();
        assert!(rules.is_ignored(Path::new(".DS_Store")));
    }

    #[test]
    fn test_media_files_not_ignored() {
        let rules = IgnoreRules::defaults();
        assert!(!rules.is_ignored(Path::new("footage/interview.mp4")));
        assert!(!rules.is_ignored(Path::new("audio/bgm.wav")));
        assert!(!rules.is_ignored(Path::new("images/poster.jpg")));
        assert!(!rules.is_ignored(Path::new("clip.mov")));
    }

    #[test]
    fn test_custom_patterns() {
        let patterns = vec![
            "*.log".to_string(),
            "temp/**".to_string(),
            "drafts/**".to_string(),
        ];
        let rules = IgnoreRules::from_patterns(&patterns);

        assert!(rules.is_ignored(Path::new("app.log")));
        assert!(rules.is_ignored(Path::new("temp/work.mp4")));
        assert!(rules.is_ignored(Path::new("drafts/v1.mp4")));
        assert!(!rules.is_ignored(Path::new("footage/final.mp4")));
    }

    #[test]
    fn test_empty_and_comment_lines_skipped() {
        let patterns = vec![
            "".to_string(),
            "# This is a comment".to_string(),
            "  # Indented comment".to_string(),
            "  ".to_string(),
            "*.log".to_string(),
        ];
        let rules = IgnoreRules::from_patterns(&patterns);

        // Only *.log should be an active pattern
        assert_eq!(rules.patterns().len(), 1);
        assert!(rules.is_ignored(Path::new("app.log")));
    }

    #[test]
    fn test_invalid_pattern_skipped() {
        let patterns = vec![
            "[invalid".to_string(), // Unclosed bracket
            "*.mp4".to_string(),
        ];
        let rules = IgnoreRules::from_patterns(&patterns);

        // Should still work with valid patterns
        assert!(rules.is_ignored(Path::new("video.mp4")));
    }

    #[test]
    fn test_load_from_nonexistent_file() {
        let rules = IgnoreRules::load(Path::new("/nonexistent/path"));
        // Should still have default patterns
        assert!(rules.is_ignored(Path::new(".openreelio/index.db")));
        assert!(!rules.is_ignored(Path::new("footage/clip.mp4")));
    }

    #[test]
    fn test_load_from_tempdir_with_ignore_file() {
        let dir = tempfile::tempdir().unwrap();
        let ignore_content = "# Custom rules\n*.bak\ntemp/**\n";
        std::fs::write(dir.path().join(".openreelignore"), ignore_content).unwrap();

        let rules = IgnoreRules::load(dir.path());

        // Default rules still apply
        assert!(rules.is_ignored(Path::new(".git/HEAD")));
        // Custom rules also apply
        assert!(rules.is_ignored(Path::new("backup.bak")));
        assert!(rules.is_ignored(Path::new("temp/work.mp4")));
        // Normal media files not ignored
        assert!(!rules.is_ignored(Path::new("footage/clip.mp4")));
    }

    #[test]
    fn test_windows_path_separators() {
        let rules = IgnoreRules::defaults();
        // Should work with backslash paths (Windows)
        assert!(rules.is_ignored(Path::new(".openreelio\\index.db")));
        assert!(rules.is_ignored(Path::new(".git\\objects\\abc")));
    }

    #[test]
    fn test_deeply_nested_paths() {
        let rules = IgnoreRules::defaults();
        assert!(rules.is_ignored(Path::new("node_modules/deep/nested/package/file.js")));
        assert!(!rules.is_ignored(Path::new("footage/deep/nested/folder/clip.mp4")));
    }
}
