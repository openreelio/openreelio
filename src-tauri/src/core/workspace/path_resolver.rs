//! Path Resolution Utilities
//!
//! Handles conversion between relative and absolute paths for workspace files.
//! Ensures consistent path handling for files inside and outside the project.

use std::path::{Path, PathBuf};

/// Resolve a URI to an absolute path
///
/// If the URI is already absolute, returns it as-is.
/// If relative, resolves it against the project root.
pub fn resolve_to_absolute(project_root: &Path, uri: &str) -> PathBuf {
    let path = Path::new(uri);
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        project_root.join(uri)
    }
}

/// Convert an absolute path to a project-relative path
///
/// Returns `Some(relative)` if the path is inside the project folder,
/// `None` if it's an external file.
/// The returned string uses forward slashes for cross-platform consistency.
pub fn to_relative(project_root: &Path, absolute: &Path) -> Option<String> {
    // Canonicalize both paths to resolve symlinks and normalize
    let canonical_root = dunce_canonicalize(project_root);
    let canonical_path = dunce_canonicalize(absolute);

    canonical_path
        .strip_prefix(&canonical_root)
        .ok()
        .map(|rel| rel.to_string_lossy().replace('\\', "/"))
}

/// Check if a path is inside the project directory
///
/// Resolves both paths to prevent path traversal attacks (e.g., `../../etc/passwd`).
pub fn is_inside_project(project_root: &Path, path: &Path) -> bool {
    let canonical_root = dunce_canonicalize(project_root);
    let canonical_path = dunce_canonicalize(path);
    canonical_path.starts_with(&canonical_root)
}

/// Normalize a URI for storage
///
/// If the file is inside the project, returns a relative path.
/// If external, returns the absolute path as-is.
/// This is the canonical form stored in ops.jsonl.
pub fn normalize_uri(project_root: &Path, uri: &str) -> String {
    let path = resolve_to_absolute(project_root, uri);
    to_relative(project_root, &path).unwrap_or_else(|| uri.to_string())
}

/// Canonicalize a path, falling back to the original if canonicalization fails
///
/// On Windows, std::fs::canonicalize returns UNC paths (\\?\C:\...).
/// This function strips the UNC prefix to avoid issues with tools like FFmpeg
/// that don't handle UNC paths.
fn dunce_canonicalize(path: &Path) -> PathBuf {
    match std::fs::canonicalize(path) {
        Ok(canonical) => strip_unc_prefix(canonical),
        Err(_) => {
            // Path doesn't exist — normalize components manually
            let mut result = PathBuf::new();
            for component in path.components() {
                match component {
                    std::path::Component::ParentDir => {
                        result.pop();
                    }
                    std::path::Component::CurDir => {}
                    _ => result.push(component),
                }
            }
            if result.as_os_str().is_empty() {
                path.to_path_buf()
            } else {
                result
            }
        }
    }
}

/// Strip the Windows UNC prefix (\\?\) from a canonicalized path.
/// On non-Windows platforms, this is a no-op.
fn strip_unc_prefix(path: PathBuf) -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        let s = path.to_string_lossy();
        if let Some(stripped) = s.strip_prefix(r"\\?\") {
            return PathBuf::from(stripped);
        }
    }
    path
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn test_resolve_relative_path() {
        let root = Path::new("/projects/my-video");
        let result = resolve_to_absolute(root, "footage/interview.mp4");
        assert_eq!(result, PathBuf::from("/projects/my-video/footage/interview.mp4"));
    }

    #[test]
    fn test_resolve_absolute_path_unchanged() {
        let root = Path::new("/projects/my-video");
        let result = resolve_to_absolute(root, "/other/path/file.mp4");
        assert_eq!(result, PathBuf::from("/other/path/file.mp4"));
    }

    #[test]
    fn test_resolve_dot_relative_path() {
        let root = Path::new("/projects/my-video");
        let result = resolve_to_absolute(root, "./footage/clip.mp4");
        assert_eq!(
            result,
            PathBuf::from("/projects/my-video/./footage/clip.mp4")
        );
    }

    #[test]
    fn test_to_relative_inside_project() {
        let dir = tempdir().unwrap();
        let footage_dir = dir.path().join("footage");
        std::fs::create_dir_all(&footage_dir).unwrap();
        let file_path = footage_dir.join("clip.mp4");
        std::fs::write(&file_path, "").unwrap();

        let result = to_relative(dir.path(), &file_path);
        assert_eq!(result, Some("footage/clip.mp4".to_string()));
    }

    #[test]
    fn test_to_relative_outside_project() {
        let dir1 = tempdir().unwrap();
        let dir2 = tempdir().unwrap();
        let file_path = dir2.path().join("external.mp4");
        std::fs::write(&file_path, "").unwrap();

        let result = to_relative(dir1.path(), &file_path);
        assert!(result.is_none());
    }

    #[test]
    fn test_is_inside_project_true() {
        let dir = tempdir().unwrap();
        let inner = dir.path().join("footage/clip.mp4");
        std::fs::create_dir_all(dir.path().join("footage")).unwrap();
        std::fs::write(&inner, "").unwrap();

        assert!(is_inside_project(dir.path(), &inner));
    }

    #[test]
    fn test_is_inside_project_false() {
        let dir1 = tempdir().unwrap();
        let dir2 = tempdir().unwrap();
        let outer = dir2.path().join("file.mp4");
        std::fs::write(&outer, "").unwrap();

        assert!(!is_inside_project(dir1.path(), &outer));
    }

    #[test]
    fn test_is_inside_project_traversal_prevention() {
        let dir = tempdir().unwrap();
        // Construct a path that tries to escape via ..
        let traversal = dir.path().join("footage").join("..").join("..").join("etc");
        // Should resolve to outside the project
        assert!(!is_inside_project(dir.path(), &traversal));
    }

    #[test]
    fn test_normalize_uri_internal_file() {
        let dir = tempdir().unwrap();
        let footage_dir = dir.path().join("footage");
        std::fs::create_dir_all(&footage_dir).unwrap();
        let file_path = footage_dir.join("clip.mp4");
        std::fs::write(&file_path, "").unwrap();

        let abs_str = file_path.to_string_lossy().to_string();
        let result = normalize_uri(dir.path(), &abs_str);
        assert_eq!(result, "footage/clip.mp4");
    }

    #[test]
    fn test_normalize_uri_external_file() {
        let dir1 = tempdir().unwrap();
        let dir2 = tempdir().unwrap();
        let file_path = dir2.path().join("external.mp4");
        std::fs::write(&file_path, "").unwrap();

        let abs_str = file_path.to_string_lossy().to_string();
        let result = normalize_uri(dir1.path(), &abs_str);
        // External file should keep absolute path
        assert_eq!(result, abs_str);
    }

    #[test]
    fn test_normalize_uri_already_relative() {
        let dir = tempdir().unwrap();
        let footage_dir = dir.path().join("footage");
        std::fs::create_dir_all(&footage_dir).unwrap();
        let file_path = footage_dir.join("clip.mp4");
        std::fs::write(&file_path, "").unwrap();

        let result = normalize_uri(dir.path(), "footage/clip.mp4");
        assert_eq!(result, "footage/clip.mp4");
    }

    #[test]
    fn test_resolve_empty_uri() {
        let root = Path::new("/projects/my-video");
        let result = resolve_to_absolute(root, "");
        assert_eq!(result, PathBuf::from("/projects/my-video"));
    }
}
