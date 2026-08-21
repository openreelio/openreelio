//! Filesystem utilities.
//!
//! This module provides safe primitives for writing files in a crash-tolerant way.
//!
//! Why this exists:
//! - Snapshots and metadata are critical to recoverability.
//! - A partial write (power loss, crash) must not leave the project unrecoverable.
//! - Windows semantics differ from Unix for rename-over-existing; we handle both.

use std::borrow::Cow;
use std::fs::{File, OpenOptions};
use std::io::{BufWriter, Write};
use std::path::{Component, Path, PathBuf};

use crate::core::{CoreError, CoreResult};

// =============================================================================
// Path Validation Utilities
// =============================================================================

/// Validates that an identifier component is safe to use in file paths.
///
/// This prevents path traversal attacks by rejecting identifiers containing:
/// - Empty strings
/// - Path traversal sequences (`..`)
/// - Path separators (`/`, `\`)
/// - Drive letter indicators (`:`)
///
/// # Arguments
/// * `id` - The identifier to validate
/// * `label` - A descriptive label for error messages (e.g., "assetId", "sequenceId")
///
/// # Returns
/// * `Ok(())` if the identifier is safe
/// * `Err(String)` with a descriptive error message if validation fails
///
/// # Security
/// This function is critical for preventing path traversal attacks. Any identifier
/// that will be used as part of a file path MUST be validated through this function.
pub fn validate_path_id_component(id: &str, label: &str) -> Result<(), String> {
    // Check for empty or whitespace-only identifiers
    if id.trim().is_empty() {
        return Err(format!("{label} is empty or contains only whitespace"));
    }
    // Reject surrounding whitespace instead of silently trimming it. Callers validate
    // one string and then interpolate that same string into a path, so validating a
    // trimmed copy would leave the untrimmed original unchecked. No well-formed
    // identifier (ULID, UUID, slug) carries padding, so a padded id is already malformed.
    if id != id.trim() {
        return Err(format!(
            "Invalid {label}: contains leading or trailing whitespace"
        ));
    }
    if id.contains("..") || id.contains('/') || id.contains('\\') || id.contains(':') {
        return Err(format!(
            "Invalid {label}: contains path traversal characters"
        ));
    }
    // Additional validation: reject control characters and null bytes
    if id.chars().any(|c| c.is_control()) {
        return Err(format!("Invalid {label}: contains control characters"));
    }
    Ok(())
}

/// Validates that a path can be embedded faithfully in an FFmpeg filtergraph option.
///
/// FFmpeg's filtergraph parser has no representation for a literal `'` inside an
/// option value. The canonical `'\''` idiom (close quote, escaped quote, reopen quote)
/// is what keeps a hostile value from breaking out of the quoted region and injecting
/// new filter nodes, and that property holds for every input — but the quote itself is
/// consumed by the parser rather than delivered, so the filter receives a path with the
/// apostrophe missing. The filter then silently reads or writes the wrong file, or
/// produces an empty result with no error.
///
/// Escaping cannot fix this; it is a limit of the option-value grammar. So any path the
/// application *generates* for a quoted filter option — a temporary `.ass` subtitle
/// file, a stabilization `.trf` directory, a `fontsdir` — must be rejected up front with
/// an actionable message rather than silently producing a broken render. Such paths are
/// derived from the project directory or the system temp directory, either of which can
/// legitimately sit under a profile like `C:\Users\Ben's PC\`.
///
/// This is a fidelity guard, not a security boundary: the security boundary is the
/// quoting itself, in `core::effects::escape_ffmpeg_filter_value`.
///
/// # Arguments
/// * `path` - The generated path that will be interpolated into a filter option
/// * `label` - A descriptive label for error messages (e.g., "subtitle overlay path")
pub fn validate_filter_safe_path(path: &Path, label: &str) -> Result<(), String> {
    if path.to_string_lossy().contains('\'') {
        return Err(format!(
            "{label} contains an apostrophe, which FFmpeg's filter parser cannot \
             represent in an option value. Move the project to a path without an \
             apostrophe (') and retry."
        ));
    }
    Ok(())
}

/// Removes the Windows verbatim (`\\?\`) prefix from a path string.
///
/// `std::fs::canonicalize` returns verbatim paths on Windows, so a stored
/// asset's URI routinely reads `\\?\C:\media\clip.mp4`. That prefix is
/// meaningful to the Win32 API and meaningless to every NLE that reads a
/// `file://` URL — left in place it percent-encodes to `file:////%3F/C:/…`,
/// which resolves to nothing and shows up as offline media in the other tool.
///
/// `\\?\UNC\server\share` is the verbatim spelling of the share `\\server\share`
/// and is restored to it.
pub fn strip_verbatim_prefix(path: &str) -> Cow<'_, str> {
    if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        return Cow::Owned(format!(r"\\{rest}"));
    }
    if let Some(rest) = path.strip_prefix(r"\\?\") {
        return Cow::Borrowed(rest);
    }
    Cow::Borrowed(path)
}

/// Whether a path points at a UNC / network location.
///
/// A hand-written project file may carry `\\host\share\x`, `//host/share/x`,
/// `/\host\share\x` or the verbatim `\\?\UNC\host\share\x`. Windows resolves
/// every one of them as the same share, so the test cannot be a list of literal
/// prefixes — it strips the verbatim prefix, normalises the separators, and then
/// asks whether the path starts with two of them.
///
/// Naming a share lets whoever wrote the path trigger an outbound connection
/// (and an NTLM handshake leak on Windows) the moment anything stats the path,
/// so the check is deliberately lexical: it must be able to run *before* the
/// filesystem is touched.
pub fn is_network_path(path: &str) -> bool {
    strip_verbatim_prefix(path)
        .replace('\\', "/")
        .starts_with("//")
}

/// Whether a path string names an absolute location, answered without the host.
///
/// Deliberately answered from the string rather than [`Path::is_absolute`]: a
/// project written on Windows is routinely read on Linux and the reverse, and
/// `Path::is_absolute` answers for the *host*, so `C:/Windows/win.ini` reads as
/// a relative path on Linux and would be joined onto the project root — landing
/// inside the scope it was supposed to be measured against.
fn is_absolute_path_string(path: &str) -> bool {
    let bytes = path.as_bytes();
    matches!(bytes.first(), Some(b'/') | Some(b'\\'))
        || matches!(bytes, [drive, b':', ..] if drive.is_ascii_alphabetic())
}

/// Validates a workspace-relative asset path before it is stored on an asset.
///
/// [`Asset::resolved_path`](crate::core::assets::Asset::resolved_path) joins this
/// value onto the project root with no traversal check of its own, so a `..`
/// segment or an absolute/UNC prefix stored here escapes the project exactly like
/// an out-of-tree `uri` would — and the result is handed to FFmpeg by render,
/// analysis, and transcription.
///
/// Rejection is purely lexical: the path is never touched on disk, so validating
/// a hostile value cannot itself probe outside the project or open a network
/// connection.
pub fn validate_asset_relative_path(relative_path: &str, label: &str) -> Result<(), String> {
    let trimmed = relative_path.trim();
    if trimmed.is_empty() {
        return Err(format!("{label} is empty"));
    }
    if trimmed.chars().any(char::is_control) {
        return Err(format!("{label} contains control characters"));
    }
    if trimmed.contains("://") {
        return Err(format!("{label} must be a relative path, not a URL"));
    }
    // Reject backslashes on every platform: on Windows a backslash is a path
    // separator (so `\\host\share` is a UNC path), but on Unix it is an ordinary
    // filename character, so `Path::components` would not flag a UNC-style value
    // as a Prefix. Requiring forward slashes keeps this check platform-agnostic.
    if trimmed.contains('\\') {
        return Err(format!(
            "{label} must use forward slashes and must not be a UNC path"
        ));
    }

    let candidate = Path::new(trimmed);
    if candidate.is_absolute() || is_absolute_path_string(trimmed) {
        return Err(format!("{label} must be relative to the project root"));
    }
    if candidate.components().any(|component| {
        matches!(
            component,
            Component::CurDir | Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    }) {
        return Err(format!(
            "{label} must not contain '.', '..', or a drive/UNC prefix"
        ));
    }

    Ok(())
}

/// Validates a stored asset URI without touching the filesystem.
///
/// This is the `uri` sibling of [`validate_asset_relative_path`]: it enforces
/// what every write path already guarantees — an absolute, local, non-traversing
/// path — but does it *lexically*, so it can run on state that was read off disk
/// rather than produced by a command.
///
/// Not touching the disk is the point, not an optimisation. `\\attacker\share\x`
/// is refused here before anything stats or canonicalises it, because on Windows
/// the stat *is* the outbound SMB connection and the NTLM handshake that leaks
/// with it. For the same reason existence is deliberately **not** checked: an
/// asset whose file is simply gone is offline media the user can relink, not an
/// attack, and asking the filesystem about it is what this guard exists to
/// prevent doing blindly.
pub fn validate_asset_uri(uri: &str, label: &str) -> Result<(), String> {
    let trimmed = uri.trim();
    if trimmed.is_empty() {
        return Err(format!("{label} is empty"));
    }
    if trimmed.chars().any(char::is_control) {
        return Err(format!("{label} contains control characters"));
    }
    if trimmed.contains("://") {
        return Err(format!("{label} must be a local file path, not a URL"));
    }
    if is_network_path(trimmed) {
        return Err(format!("{label} must not be a UNC or network share path"));
    }

    let plain = strip_verbatim_prefix(trimmed);
    if !is_absolute_path_string(&plain) {
        return Err(format!("{label} must be an absolute path"));
    }
    if Path::new(plain.as_ref())
        .components()
        .any(|component| matches!(component, Component::CurDir | Component::ParentDir))
    {
        return Err(format!("{label} must not contain '.' or '..' segments"));
    }
    // `Path::components` only classifies `..` as a `ParentDir` when the host
    // treats the separator as one, so a Windows-style `C:\media\..\..\secrets`
    // read on Linux is a single `Normal` component. Re-check on normalised
    // separators so the answer does not depend on which machine opened the file.
    if plain
        .replace('\\', "/")
        .split('/')
        .any(|segment| matches!(segment, "." | ".."))
    {
        return Err(format!("{label} must not contain '.' or '..' segments"));
    }

    Ok(())
}

/// Validates a project-relative workspace document path.
///
/// Agent-facing workspace document tools must not reach internal project state,
/// dependency caches, build outputs, or VCS metadata. The returned path remains
/// relative and is safe to join under a separately validated project root.
pub fn validate_workspace_relative_path(relative_path: &str) -> Result<PathBuf, String> {
    let trimmed = relative_path.trim();
    if trimmed.is_empty() {
        return Err("relativePath is required".to_string());
    }

    if trimmed.chars().any(|c| c.is_control()) {
        return Err("relativePath contains control characters".to_string());
    }

    let candidate = PathBuf::from(trimmed);
    if candidate.is_absolute() {
        return Err("Path must be relative to project root".to_string());
    }

    if trimmed
        .replace('\\', "/")
        .split('/')
        .any(|segment| matches!(segment, "." | ".."))
    {
        return Err("Path cannot contain current or parent directory traversal".to_string());
    }

    if candidate.components().any(|component| {
        matches!(
            component,
            Component::CurDir | Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    }) {
        return Err("Path cannot contain current or parent directory traversal".to_string());
    }

    if candidate
        .components()
        .enumerate()
        .any(|(index, component)| {
            let Component::Normal(name) = component else {
                return false;
            };
            let name = name.to_string_lossy().to_ascii_lowercase();
            if matches!(
                name.as_str(),
                ".openreelio" | ".git" | "node_modules" | "target"
            ) {
                return true;
            }
            if index == 0 && matches!(name.as_str(), "dist" | "build") {
                return true;
            }
            false
        })
    {
        return Err("Path targets a reserved workspace directory".to_string());
    }

    Ok(candidate)
}

/// Validates and resolves a local file path for input operations.
///
/// This function performs comprehensive validation:
/// - Rejects empty paths
/// - Rejects remote URLs (http://, https://)
/// - Requires absolute paths
/// - Verifies the file exists and is a regular file
///
/// # Arguments
/// * `path` - The path string to validate
/// * `label` - A descriptive label for error messages (e.g., "inputPath", "assetPath")
///
/// # Returns
/// * `Ok(PathBuf)` with the validated path
/// * `Err(String)` with a descriptive error message if validation fails
///
/// # Security
/// This function prevents SSRF attacks by rejecting URLs and ensures the path
/// points to an actual file on the local filesystem.
pub fn validate_local_input_path(path: &str, label: &str) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(format!("{label} is empty"));
    }

    // Prevent SSRF: reject remote URLs
    let lower = trimmed.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") {
        return Err(format!("{label} must be a local file path, not a URL"));
    }

    // Reject other URL schemes that could be dangerous
    if lower.contains("://") {
        return Err(format!("{label} must be a local file path"));
    }

    // Refuse network shares *before* the path is turned into a `PathBuf`.
    // On Windows `\\host\share\x` answers true to `Path::is_absolute`, so it
    // sails past the absolute-path check below and reaches `fs::metadata` —
    // and that stat is itself the outbound SMB connection plus the NTLM
    // handshake that leaks with it. This validator sits on the command
    // boundary reached by plan files (`plan execute`, the agent plan executor,
    // MCP `plan.apply`), which are untrusted input, so the check has to be
    // lexical: it must decide without touching the filesystem.
    if is_network_path(trimmed) {
        return Err(format!("{label} must not be a UNC or network share path"));
    }

    let pb = PathBuf::from(trimmed);
    if !pb.is_absolute() {
        return Err(format!(
            "{label} must be an absolute path: {}",
            pb.display()
        ));
    }

    // Prevent traversal tricks in user-provided absolute paths.
    // This is defense-in-depth for path-based allowlists (e.g. asset protocol scope).
    if pb.components().any(|c| {
        matches!(
            c,
            std::path::Component::CurDir | std::path::Component::ParentDir
        )
    }) {
        return Err(format!("{label} must not contain '.' or '..' segments"));
    }

    // Check file existence and type
    let meta =
        std::fs::metadata(&pb).map_err(|_| format!("{label} file not found: {}", pb.display()))?;
    if !meta.is_file() {
        return Err(format!("{label} is not a file: {}", pb.display()));
    }

    // Best-effort normalization. Canonicalization can fail on special filesystems
    // (network shares, some UNC paths) even when metadata succeeds. We fall back
    // to the validated absolute path, but log the failure so it is visible in
    // traces if it ever causes a downstream scope-check mismatch.
    match std::fs::canonicalize(&pb) {
        Ok(canonical) => Ok(canonical),
        Err(e) => {
            tracing::warn!(
                "Failed to canonicalize '{}' (using validated path as-is): {}",
                pb.display(),
                e
            );
            Ok(pb)
        }
    }
}

/// Validates a caller-supplied input path and confines the read to `allowed_roots`.
///
/// [`validate_local_input_path`] only proves that a path is local, non-traversing and an
/// existing regular file — it accepts *any* absolute location on disk. An IPC command
/// that reads a file named by the renderer must additionally confine the read, otherwise
/// a compromised webview can use the command's success/failure and result counts as an
/// oracle for files anywhere on the machine.
///
/// Callers are expected to map the error to a generic message so the rejected path is not
/// reflected back to the caller.
pub fn validate_scoped_input_path(
    path: &str,
    label: &str,
    allowed_roots: &[&Path],
) -> Result<PathBuf, String> {
    // `validate_local_input_path` canonicalizes (best-effort), so compare against
    // canonicalized roots to avoid symlink and case-normalization surprises.
    let validated = validate_local_input_path(path, label)?;
    let allowed_root_canon = canonical_allowed_roots(allowed_roots, label)?;

    if !is_within_any_scope(&validated, &allowed_root_canon) {
        return Err(format!("{label} must be within an allowed directory"));
    }

    Ok(validated)
}

/// Validates and canonicalizes a project directory path.
///
/// This is used by IPC entry points that open projects to ensure:
/// - The path is non-empty
/// - The path is absolute
/// - The directory exists and looks like an OpenReelio project
///   (legacy root files or hidden `.openreelio/state` files, including snapshot-only recovery)
/// - The returned path is canonicalized to reduce ambiguity and avoid scope mismatches
pub fn validate_existing_project_dir(path: &str, label: &str) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(format!("{label} is empty"));
    }

    let pb = PathBuf::from(trimmed);
    if !pb.is_absolute() {
        return Err(format!(
            "{label} must be an absolute path: {}",
            pb.display()
        ));
    }

    if !pb.exists() {
        return Err(format!("{label} not found: {}", pb.display()));
    }
    if !pb.is_dir() {
        return Err(format!("{label} must be a directory: {}", pb.display()));
    }

    // Require basic project shape to avoid opening an arbitrary directory.
    // Support both legacy root-level files and hidden state layout.
    let has_project_json = pb.join("project.json").exists();
    let has_ops_log = pb.join("ops.jsonl").exists();
    let has_snapshot = pb.join("snapshot.json").exists();
    let hidden_state_dir = pb.join(".openreelio").join("state");
    let has_hidden_project_json = hidden_state_dir.join("project.json").exists();
    let has_hidden_ops_log = hidden_state_dir.join("ops.jsonl").exists();
    let has_hidden_snapshot = hidden_state_dir.join("snapshot.json").exists();
    if !has_project_json
        && !has_ops_log
        && !has_snapshot
        && !has_hidden_project_json
        && !has_hidden_ops_log
        && !has_hidden_snapshot
    {
        return Err(format!(
            "{label} is not a valid OpenReelio project directory: {}",
            pb.display()
        ));
    }

    std::fs::canonicalize(&pb).map_err(|e| format!("Failed to resolve {label}: {e}"))
}

/// Returns a conservative set of directories the app is willing to write exports into.
///
/// Security model:
/// - IPC is a trust boundary; the renderer process (webview) could be compromised.
/// - For output paths coming from the frontend, we restrict writes to a small set of
///   user-owned directories + the current project directory.
pub fn default_export_allowed_roots(project_dir: &Path) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    roots.push(project_dir.to_path_buf());

    // "dirs" is best-effort and may return None in sandboxed environments.
    if let Some(p) = dirs::desktop_dir() {
        roots.push(p);
    }
    if let Some(p) = dirs::download_dir() {
        roots.push(p);
    }
    if let Some(p) = dirs::document_dir() {
        roots.push(p);
    }
    if let Some(p) = dirs::video_dir() {
        roots.push(p);
    }

    roots
}

/// Builds the full set of directories the GUI is willing to write user exports into.
///
/// This combines [`default_export_allowed_roots`] with a session-scoped allow-list of
/// directories the user explicitly confirmed via the native save dialog
/// (`pick_export_destination`). The approved set can only be populated through that
/// user-driven dialog, never from a path argument supplied by the renderer, so a
/// compromised webview cannot widen the allow-list by forging an output path.
///
/// Security note: the returned roots are still subject to the `..`/symlink/directory
/// safety checks inside [`validate_scoped_output_path`]. This helper only widens *where*
/// the user may save, not *how* the path is validated.
pub fn export_allowed_roots(
    project_dir: &Path,
    approved_dirs: &std::collections::HashSet<PathBuf>,
) -> Vec<PathBuf> {
    let mut roots = default_export_allowed_roots(project_dir);
    for dir in approved_dirs {
        roots.push(dir.clone());
    }
    roots
}

/// Async version of `validate_local_input_path`.
///
/// Uses tokio's async filesystem operations to avoid blocking the async runtime.
pub async fn validate_local_input_path_async(path: &str, label: &str) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(format!("{label} is empty"));
    }

    let lower = trimmed.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") {
        return Err(format!("{label} must be a local file path, not a URL"));
    }

    if lower.contains("://") {
        return Err(format!("{label} must be a local file path"));
    }

    // Same reasoning as the sync variant: a UNC path is rejected lexically so
    // the validator never stats a share and leaks an NTLM handshake doing it.
    if is_network_path(trimmed) {
        return Err(format!("{label} must not be a UNC or network share path"));
    }

    let pb = PathBuf::from(trimmed);
    if !pb.is_absolute() {
        return Err(format!(
            "{label} must be an absolute path: {}",
            pb.display()
        ));
    }

    if pb.components().any(|c| {
        matches!(
            c,
            std::path::Component::CurDir | std::path::Component::ParentDir
        )
    }) {
        return Err(format!("{label} must not contain '.' or '..' segments"));
    }

    let meta = tokio::fs::metadata(&pb)
        .await
        .map_err(|_| format!("{label} file not found: {}", pb.display()))?;
    if !meta.is_file() {
        return Err(format!("{label} is not a file: {}", pb.display()));
    }

    // Best-effort normalization — same policy as the sync variant: fall back
    // to the validated absolute path and log when canonicalization fails.
    // The closure always produces a `PathBuf` (never an error), so we avoid
    // any `From<io::Error>` conversion that the outer `Result<_, String>` can't
    // satisfy.
    let pb_clone = pb.clone();
    let canonical = tokio::task::spawn_blocking(move || match std::fs::canonicalize(&pb_clone) {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!(
                "Failed to canonicalize '{}' (using validated path as-is): {}",
                pb_clone.display(),
                e
            );
            pb_clone
        }
    })
    .await
    // spawn_blocking panicked — fall back to original path rather than propagating
    .unwrap_or_else(|_| {
        tracing::warn!(
            "spawn_blocking for canonicalize panicked; using original path '{}'",
            pb.display()
        );
        pb.clone()
    });
    Ok(canonical)
}

/// Validates an output path for write operations.
///
/// This function ensures:
/// - The path is absolute
/// - The parent directory exists or can be created
/// - The path doesn't point to a directory
///
/// # Arguments
/// * `path` - The output path string to validate
/// * `label` - A descriptive label for error messages
///
/// # Returns
/// * `Ok(PathBuf)` with the validated path
/// * `Err(String)` if validation fails
pub fn validate_output_path(path: &str, label: &str) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(format!("{label} is empty"));
    }

    let pb = PathBuf::from(trimmed);
    if !pb.is_absolute() {
        return Err(format!(
            "{label} must be an absolute path: {}",
            pb.display()
        ));
    }

    // Ensure parent directory exists
    if let Some(parent) = pb.parent() {
        if !parent.exists() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create output directory: {}", e))?;
        }
    }

    // Don't allow overwriting a directory
    if pb.exists() && pb.is_dir() {
        return Err(format!("{label} points to a directory: {}", pb.display()));
    }

    if let Ok(metadata) = std::fs::symlink_metadata(&pb) {
        if metadata.file_type().is_symlink() {
            return Err(format!("{label} must not be a symlink: {}", pb.display()));
        }
    }

    Ok(pb)
}

fn validate_output_path_no_create(path: &str, label: &str) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(format!("{label} is empty"));
    }

    let pb = PathBuf::from(trimmed);
    if !pb.is_absolute() {
        return Err(format!(
            "{label} must be an absolute path: {}",
            pb.display()
        ));
    }

    // Prevent traversal tricks in scoped IPC paths. Normalizing absolute paths correctly across
    // platforms is subtle; for security, reject any `.`/`..` segments up front.
    if pb.components().any(|c| {
        matches!(
            c,
            std::path::Component::CurDir | std::path::Component::ParentDir
        )
    }) {
        return Err(format!("{label} must not contain '.' or '..' segments"));
    }

    // Don't allow overwriting a directory
    if pb.exists() && pb.is_dir() {
        return Err(format!("{label} points to a directory: {}", pb.display()));
    }

    if let Ok(metadata) = std::fs::symlink_metadata(&pb) {
        if metadata.file_type().is_symlink() {
            return Err(format!("{label} must not be a symlink: {}", pb.display()));
        }
    }

    Ok(pb)
}

#[cfg(windows)]
fn path_starts_with_scope(path: &Path, base: &Path) -> bool {
    use std::path::Component;

    let mut path_components = path.components();
    for base_component in base.components() {
        let Some(path_component) = path_components.next() else {
            return false;
        };

        let base_str = base_component.as_os_str().to_string_lossy();
        let path_str = path_component.as_os_str().to_string_lossy();

        if base_str.to_ascii_lowercase() != path_str.to_ascii_lowercase() {
            return false;
        }

        if matches!(base_component, Component::CurDir | Component::ParentDir) {
            return false;
        }
    }
    true
}

#[cfg(not(windows))]
fn path_starts_with_scope(path: &Path, base: &Path) -> bool {
    path.starts_with(base)
}

fn ensure_no_existing_symlink_components(path: &Path, label: &str) -> Result<(), String> {
    let mut current = PathBuf::new();
    for component in path.components() {
        current.push(component.as_os_str());
        match std::fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(format!(
                    "{label} must not contain symlink components: {}",
                    current.display()
                ));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
            Err(error) => {
                return Err(format!(
                    "Failed to inspect {label} component {}: {}",
                    current.display(),
                    error
                ));
            }
        }
    }

    Ok(())
}

fn canonical_allowed_roots(allowed_roots: &[&Path], label: &str) -> Result<Vec<PathBuf>, String> {
    let canonicalized: Vec<PathBuf> = allowed_roots
        .iter()
        .filter_map(|root| match std::fs::canonicalize(root) {
            Ok(canonical_root) => Some(canonical_root),
            Err(error) => {
                tracing::warn!(
                    label,
                    root = %root.display(),
                    %error,
                    "Skipping unresolvable allowed root"
                );
                None
            }
        })
        .collect();

    if canonicalized.is_empty() {
        return Err(format!("No allowed roots could be resolved for {label}"));
    }

    Ok(canonicalized)
}

fn is_within_any_scope(path: &Path, roots: &[PathBuf]) -> bool {
    roots.iter().any(|root| path_starts_with_scope(path, root))
}

fn create_scoped_parent_dir_no_symlinks(
    parent: &Path,
    label: &str,
    allowed_root_canon: &[PathBuf],
) -> Result<(), String> {
    ensure_no_existing_symlink_components(parent, label)?;

    let mut nearest_existing = parent;
    while !nearest_existing.exists() {
        nearest_existing = nearest_existing
            .parent()
            .ok_or_else(|| format!("Cannot resolve {label} parent: {}", parent.display()))?;
    }

    let nearest_canon = std::fs::canonicalize(nearest_existing)
        .map_err(|e| format!("Failed to resolve {label} ancestor: {e}"))?;
    if !is_within_any_scope(&nearest_canon, allowed_root_canon) {
        return Err(format!(
            "{label} parent escapes allowed roots through an existing path component: {}",
            nearest_existing.display()
        ));
    }

    let relative_missing = parent.strip_prefix(nearest_existing).map_err(|_| {
        format!(
            "Failed to resolve missing {label} path under {}",
            nearest_existing.display()
        )
    })?;

    let mut current = nearest_existing.to_path_buf();
    for component in relative_missing.components() {
        match component {
            std::path::Component::Normal(segment) => current.push(segment),
            std::path::Component::CurDir => continue,
            std::path::Component::ParentDir
            | std::path::Component::RootDir
            | std::path::Component::Prefix(_) => {
                return Err(format!(
                    "{label} parent contains invalid path component: {}",
                    parent.display()
                ));
            }
        }

        match std::fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(format!(
                    "{label} parent must not contain symlinks: {}",
                    current.display()
                ));
            }
            Ok(metadata) => {
                if !metadata.is_dir() {
                    return Err(format!(
                        "{label} parent component is not a directory: {}",
                        current.display()
                    ));
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                std::fs::create_dir(&current)
                    .map_err(|e| format!("Failed to create output directory: {e}"))?;
                let metadata = std::fs::symlink_metadata(&current)
                    .map_err(|e| format!("Failed to inspect output directory: {e}"))?;
                if metadata.file_type().is_symlink() || !metadata.is_dir() {
                    return Err(format!(
                        "{label} parent component is not a plain directory: {}",
                        current.display()
                    ));
                }
            }
            Err(error) => {
                return Err(format!(
                    "Failed to inspect {label} parent component {}: {}",
                    current.display(),
                    error
                ));
            }
        }
    }

    Ok(())
}

/// Validates an output path and enforces that it is within one of the allowed root directories.
///
/// This is a defense-in-depth control for IPC commands that accept an output path from the
/// frontend. Without this, a compromised renderer could write to arbitrary locations on disk.
pub fn validate_scoped_output_path(
    path: &str,
    label: &str,
    allowed_roots: &[&Path],
) -> Result<PathBuf, String> {
    let pb = validate_output_path_no_create(path, label)?;

    let parent = pb
        .parent()
        .ok_or_else(|| format!("{label} has no parent directory: {}", pb.display()))?;

    // Avoid side-effects outside allowed roots: verify scope *before* creating parent directories.
    let is_allowed_lexical = allowed_roots
        .iter()
        .any(|root| path_starts_with_scope(parent, root));

    if !is_allowed_lexical {
        let roots = allowed_roots
            .iter()
            .map(|p| p.display().to_string())
            .collect::<Vec<_>>()
            .join(", ");
        return Err(format!(
            "{label} must be within an allowed directory. Allowed roots: {roots}. Got: {}",
            pb.display()
        ));
    }

    let allowed_root_canon = canonical_allowed_roots(allowed_roots, label)?;
    create_scoped_parent_dir_no_symlinks(parent, label, &allowed_root_canon)?;

    let parent_canon = std::fs::canonicalize(parent)
        .map_err(|e| format!("Failed to resolve {label} parent directory: {e}"))?;

    // Post-creation canonical check to defend against symlink and case/normalization surprises.
    let is_allowed_canon = is_within_any_scope(&parent_canon, &allowed_root_canon);

    if !is_allowed_canon {
        let roots = allowed_roots
            .iter()
            .map(|p| p.display().to_string())
            .collect::<Vec<_>>()
            .join(", ");
        return Err(format!(
            "{label} must be within an allowed directory. Allowed roots: {roots}. Got: {}",
            pb.display()
        ));
    }

    if let Ok(metadata) = std::fs::symlink_metadata(&pb) {
        if metadata.file_type().is_symlink() {
            return Err(format!("{label} must not be a symlink: {}", pb.display()));
        }
    }

    Ok(pb)
}

/// Atomically writes bytes without following a symlink at the final destination.
///
/// The caller is still responsible for validating scope before calling this
/// helper. This function is the last-mile write guard for renderer-controlled
/// output paths: it rejects symlink destinations, writes to a unique sibling temp
/// file, then renames that temp file into place.
pub fn write_bytes_atomic_no_symlink(path: &Path, bytes: &[u8], label: &str) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("{label} has no parent directory: {}", path.display()))?;
    if !parent.exists() {
        return Err(format!(
            "{label} parent directory does not exist: {}",
            parent.display()
        ));
    }
    ensure_no_existing_symlink_components(parent, label)?;

    if let Ok(metadata) = std::fs::symlink_metadata(path) {
        if metadata.file_type().is_symlink() {
            return Err(format!("{label} must not be a symlink: {}", path.display()));
        }
        if !metadata.is_file() {
            return Err(format!("{label} is not a file: {}", path.display()));
        }
    }

    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "output".to_string());
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let tmp_path = parent.join(format!(".{file_name}.tmp.{}.{}", std::process::id(), nonce));

    {
        let mut tmp_file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp_path)
            .map_err(|e| format!("Failed to create temporary {label}: {e}"))?;
        tmp_file
            .write_all(bytes)
            .map_err(|e| format!("Failed to write temporary {label}: {e}"))?;
        tmp_file
            .sync_all()
            .map_err(|e| format!("Failed to sync temporary {label}: {e}"))?;
    }

    if let Ok(metadata) = std::fs::symlink_metadata(path) {
        if metadata.file_type().is_symlink() {
            let _ = std::fs::remove_file(&tmp_path);
            return Err(format!("{label} must not be a symlink: {}", path.display()));
        }
        if !metadata.is_file() {
            let _ = std::fs::remove_file(&tmp_path);
            return Err(format!("{label} is not a file: {}", path.display()));
        }
    }

    match std::fs::rename(&tmp_path, path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            let backup_path =
                parent.join(format!(".{file_name}.bak.{}.{}", std::process::id(), nonce));

            std::fs::rename(path, &backup_path).map_err(|e| {
                let _ = std::fs::remove_file(&tmp_path);
                format!("Failed to move existing {label} aside: {e}")
            })?;

            if let Err(e) = std::fs::rename(&tmp_path, path) {
                let _ = std::fs::rename(&backup_path, path);
                let _ = std::fs::remove_file(&tmp_path);
                return Err(format!("Failed to finalize {label}: {e}"));
            }

            let _ = std::fs::remove_file(&backup_path);
        }
        Err(error) => {
            let _ = std::fs::remove_file(&tmp_path);
            return Err(format!("Failed to finalize {label}: {error}"));
        }
    }

    Ok(())
}

/// Write bytes to `path` using an atomic replace pattern.
///
/// Implementation notes:
/// - Write to a sibling temporary file.
/// - Flush and sync the temp file.
/// - Swap into place by renaming.
/// - If the destination exists, it is first moved aside as a `.bak` file, then removed.
pub fn atomic_write_bytes(path: &Path, bytes: &[u8]) -> CoreResult<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let tmp_path = tmp_path_for(path);
    {
        let file = File::create(&tmp_path)?;
        let mut writer = BufWriter::new(file);
        writer.write_all(bytes)?;
        writer.flush()?;
        // Best-effort fsync. If it fails, we still surface the error.
        writer.get_ref().sync_all()?;
    }

    atomic_replace(path, &tmp_path)?;
    Ok(())
}

/// Write a JSON file atomically with pretty formatting.
pub fn atomic_write_json_pretty<T: serde::Serialize>(path: &Path, value: &T) -> CoreResult<()> {
    let bytes = serde_json::to_vec_pretty(value)?;
    atomic_write_bytes(path, &bytes)
}

fn tmp_path_for(path: &Path) -> PathBuf {
    let mut tmp = path.to_path_buf();
    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "tmp".to_string());
    tmp.set_file_name(format!("{file_name}.tmp"));
    tmp
}

fn bak_path_for(path: &Path) -> PathBuf {
    let mut bak = path.to_path_buf();
    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "bak".to_string());
    bak.set_file_name(format!("{file_name}.bak"));
    bak
}

fn atomic_replace(dest: &Path, src_tmp: &Path) -> CoreResult<()> {
    // Fast path: dest does not exist.
    if !dest.exists() {
        std::fs::rename(src_tmp, dest)?;
        return Ok(());
    }

    // Windows: rename-over-existing may fail depending on filesystem; use a backup swap.
    let bak = bak_path_for(dest);

    // Best-effort cleanup of stale backup.
    if bak.exists() {
        let _ = std::fs::remove_file(&bak);
    }

    std::fs::rename(dest, &bak)?;
    match std::fs::rename(src_tmp, dest) {
        Ok(()) => {
            let _ = std::fs::remove_file(&bak);
            Ok(())
        }
        Err(e) => {
            // Try to restore the old file.
            let _ = std::fs::rename(&bak, dest);
            let _ = std::fs::remove_file(src_tmp);
            Err(CoreError::IoError(e))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn atomic_write_bytes_creates_and_replaces() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("file.json");

        atomic_write_bytes(&path, b"one").unwrap();
        let first = std::fs::read_to_string(&path).unwrap();
        assert_eq!(first, "one");

        atomic_write_bytes(&path, b"two").unwrap();
        let second = std::fs::read_to_string(&path).unwrap();
        assert_eq!(second, "two");
    }

    #[test]
    fn write_bytes_atomic_no_symlink_creates_and_replaces_plain_file() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("out.txt");

        write_bytes_atomic_no_symlink(&path, b"one", "outputPath").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "one");

        write_bytes_atomic_no_symlink(&path, b"two", "outputPath").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "two");
    }

    #[cfg(unix)]
    #[test]
    fn write_bytes_atomic_no_symlink_rejects_final_symlink() {
        use std::os::unix::fs::symlink;

        let root = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        let outside_file = outside.path().join("target.txt");
        std::fs::write(&outside_file, "external").unwrap();

        let output = root.path().join("out.txt");
        symlink(&outside_file, &output).unwrap();

        let result = write_bytes_atomic_no_symlink(&output, b"updated", "outputPath");
        assert!(result.is_err());
        assert_eq!(std::fs::read_to_string(&outside_file).unwrap(), "external");
    }

    #[test]
    fn test_validate_existing_project_dir_accepts_hidden_state_layout() {
        let dir = TempDir::new().unwrap();
        let state_dir = dir.path().join(".openreelio").join("state");
        std::fs::create_dir_all(&state_dir).unwrap();
        std::fs::write(state_dir.join("project.json"), "{}").unwrap();
        std::fs::write(state_dir.join("ops.jsonl"), "").unwrap();

        let project_path = dir.path().to_string_lossy().to_string();
        let result = validate_existing_project_dir(&project_path, "Project path");

        assert!(result.is_ok());
    }

    #[test]
    fn test_validate_existing_project_dir_accepts_hidden_snapshot_only() {
        let dir = TempDir::new().unwrap();
        let state_dir = dir.path().join(".openreelio").join("state");
        std::fs::create_dir_all(&state_dir).unwrap();
        std::fs::write(state_dir.join("snapshot.json"), "{}").unwrap();

        let project_path = dir.path().to_string_lossy().to_string();
        let result = validate_existing_project_dir(&project_path, "Project path");

        assert!(result.is_ok());
    }

    #[test]
    fn test_validate_existing_project_dir_accepts_legacy_layout() {
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join("project.json"), "{}").unwrap();
        std::fs::write(dir.path().join("ops.jsonl"), "").unwrap();

        let project_path = dir.path().to_string_lossy().to_string();
        let result = validate_existing_project_dir(&project_path, "Project path");

        assert!(result.is_ok());
    }

    #[test]
    fn test_validate_existing_project_dir_rejects_non_project_directory() {
        let dir = TempDir::new().unwrap();
        let project_path = dir.path().to_string_lossy().to_string();

        let result = validate_existing_project_dir(&project_path, "Project path");
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .contains("is not a valid OpenReelio project directory"));
    }

    // =========================================================================
    // Path Validation Tests
    // =========================================================================

    #[test]
    fn test_validate_path_id_component_valid() {
        assert!(validate_path_id_component("asset_001", "assetId").is_ok());
        assert!(validate_path_id_component("01HXYZ123ABC", "assetId").is_ok());
        assert!(validate_path_id_component("my-asset-name", "assetId").is_ok());
        assert!(validate_path_id_component("asset.with.dots", "assetId").is_ok());
    }

    #[test]
    fn test_validate_path_id_component_empty() {
        let result = validate_path_id_component("", "assetId");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("empty"));
    }

    #[test]
    fn test_validate_path_id_component_path_traversal() {
        // Double dot traversal
        let result = validate_path_id_component("..", "assetId");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("path traversal"));

        // Embedded traversal
        let result = validate_path_id_component("foo/../bar", "assetId");
        assert!(result.is_err());

        // Hidden traversal with prefix
        let result = validate_path_id_component("prefix..", "assetId");
        assert!(result.is_err());
    }

    #[test]
    fn test_validate_path_id_component_path_separators() {
        // Forward slash
        let result = validate_path_id_component("foo/bar", "assetId");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("path traversal"));

        // Backslash
        let result = validate_path_id_component("foo\\bar", "assetId");
        assert!(result.is_err());

        // Drive letter (Windows)
        let result = validate_path_id_component("C:", "assetId");
        assert!(result.is_err());
    }

    #[test]
    fn test_validate_path_id_component_control_characters() {
        // Null byte
        let result = validate_path_id_component("foo\0bar", "assetId");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("control characters"));

        // Tab
        let result = validate_path_id_component("foo\tbar", "assetId");
        assert!(result.is_err());

        // Newline
        let result = validate_path_id_component("foo\nbar", "assetId");
        assert!(result.is_err());
    }

    #[test]
    fn should_reject_ids_that_differ_from_their_trimmed_form() {
        // Given ids that only differ from a valid id by surrounding whitespace.
        // The validator used to check a trimmed copy while callers went on to
        // interpolate the original, so the padding was never actually checked.
        for id in [
            " asset_001",
            "asset_001 ",
            "\tasset_001",
            "asset_001\n",
            "asset_001\r\n",
            " asset_001 ",
        ] {
            let result = validate_path_id_component(id, "assetId");
            assert!(result.is_err(), "accepted padded id {id:?}");
        }

        // And the unpadded form still passes
        assert!(validate_path_id_component("asset_001", "assetId").is_ok());
    }

    #[test]
    fn should_reject_generated_filter_paths_containing_an_apostrophe() {
        // Given a project directory under a profile name with an apostrophe.
        // FFmpeg's `'\''` idiom keeps the parse inside the quoted region, so nothing
        // can inject a filter node, but the quote itself never reaches the filter —
        // the path silently becomes one that does not exist.
        let hostile = Path::new(r"C:\Users\Ben's PC\project\.openreelio\overlay.ass");
        let result = validate_filter_safe_path(hostile, "Text overlay path");
        assert!(result.is_err());
        let message = result.unwrap_err();
        assert!(message.contains("apostrophe"));
        assert!(message.contains("Text overlay path"));

        // And an ordinary path is accepted
        assert!(validate_filter_safe_path(
            Path::new(r"C:\Users\Ben\project\.openreelio\overlay.ass"),
            "Text overlay path"
        )
        .is_ok());
        assert!(
            validate_filter_safe_path(Path::new("/home/ben/project/overlay.ass"), "path").is_ok()
        );
    }

    #[test]
    fn test_validate_workspace_relative_path_allows_safe_documents() {
        assert!(validate_workspace_relative_path("docs/readme.md").is_ok());
        assert!(validate_workspace_relative_path("docs/build/notes.md").is_ok());
        assert!(validate_workspace_relative_path("captions/subtitles.srt").is_ok());
        assert!(validate_workspace_relative_path("src/main.ts").is_ok());
    }

    #[test]
    fn test_validate_workspace_relative_path_rejects_escape_and_reserved_dirs() {
        assert!(validate_workspace_relative_path("../secrets.txt").is_err());
        assert!(validate_workspace_relative_path("docs/../../secrets.txt").is_err());
        assert!(validate_workspace_relative_path("./dist/assets/index.js").is_err());
        assert!(validate_workspace_relative_path("docs/./readme.md").is_err());
        assert!(validate_workspace_relative_path(".openreelio/state/snapshot.json").is_err());
        assert!(validate_workspace_relative_path(".git/hooks/pre-commit").is_err());
        assert!(validate_workspace_relative_path("node_modules/pkg/index.js").is_err());
        assert!(validate_workspace_relative_path("dist/assets/index.js").is_err());
        assert!(validate_workspace_relative_path("build/output.log").is_err());
        assert!(validate_workspace_relative_path("target/debug/app.log").is_err());
    }

    #[test]
    fn test_validate_asset_uri_accepts_paths_the_command_layer_produces() {
        // `ImportAsset` canonicalizes, which on Windows yields a verbatim path.
        assert!(validate_asset_uri(r"\\?\C:\Media\clip.mp4", "asset.uri").is_ok());
        assert!(validate_asset_uri(r"C:\Media\clip.mp4", "asset.uri").is_ok());
        assert!(validate_asset_uri("C:/Media/clip.mp4", "asset.uri").is_ok());
        assert!(validate_asset_uri("/home/ben/media/clip.mp4", "asset.uri").is_ok());
        // A file that simply is not there is offline media, not an attack: the
        // check never asks the filesystem, so relink keeps working.
        assert!(validate_asset_uri("/home/ben/media/deleted.mp4", "asset.uri").is_ok());
    }

    #[test]
    fn test_validate_asset_uri_rejects_urls_traversal_and_shares() {
        for hostile in [
            "https://attacker.example/payload.mp4",
            "file:///etc/passwd",
            "data:video/mp4;base64,AAAA",
            "media/clip.mp4",
            "../outside.mp4",
            "/home/ben/../../etc/passwd",
            r"C:\Media\..\..\Windows\win.ini",
            r"\\attacker\share\clip.mp4",
            "//attacker/share/clip.mp4",
            r"/\attacker\share\clip.mp4",
            r"\/attacker/share/clip.mp4",
            r"\\?\UNC\attacker\share\clip.mp4",
            "",
            "   ",
        ] {
            assert!(
                validate_asset_uri(hostile, "asset.uri").is_err(),
                "'{hostile}' must be rejected"
            );
        }
    }

    #[test]
    fn test_is_network_path_sees_through_separator_spellings() {
        assert!(is_network_path(r"\\host\share\x.mp4"));
        assert!(is_network_path("//host/share/x.mp4"));
        assert!(is_network_path(r"/\host\share\x.mp4"));
        assert!(is_network_path(r"\\?\UNC\host\share\x.mp4"));

        assert!(!is_network_path("/media/x.mp4"));
        assert!(!is_network_path(r"C:\media\x.mp4"));
        assert!(!is_network_path(r"\\?\C:\media\x.mp4"));
    }

    #[test]
    fn test_validate_asset_relative_path_rejects_escapes() {
        assert!(validate_asset_relative_path("media/clip.mp4", "asset.relativePath").is_ok());

        for hostile in [
            "../outside.mp4",
            "media/../../outside.mp4",
            "./media/clip.mp4",
            "/etc/passwd",
            "C:/Windows/win.ini",
            r"\\host\share\x.mp4",
            "https://attacker.example/x.mp4",
            "",
        ] {
            assert!(
                validate_asset_relative_path(hostile, "asset.relativePath").is_err(),
                "'{hostile}' must be rejected"
            );
        }
    }

    #[test]
    fn test_validate_local_input_path_empty() {
        let result = validate_local_input_path("", "inputPath");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("empty"));

        // Whitespace only
        let result = validate_local_input_path("   ", "inputPath");
        assert!(result.is_err());
    }

    #[test]
    fn test_validate_local_input_path_rejects_urls() {
        let result = validate_local_input_path("http://example.com/file.mp4", "inputPath");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("local file path"));

        let result = validate_local_input_path("https://example.com/file.mp4", "inputPath");
        assert!(result.is_err());

        // Mixed case URL
        let result = validate_local_input_path("HTTP://example.com/file.mp4", "inputPath");
        assert!(result.is_err());

        // Other URL schemes
        let result = validate_local_input_path("file://localhost/file.mp4", "inputPath");
        assert!(result.is_err());

        let result = validate_local_input_path("ftp://server/file.mp4", "inputPath");
        assert!(result.is_err());
    }

    #[test]
    fn test_validate_local_input_path_requires_absolute() {
        let result = validate_local_input_path("relative/path/file.mp4", "inputPath");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("absolute path"));
    }

    #[test]
    fn test_validate_local_input_path_file_not_found() {
        // Use a path that definitely doesn't exist
        #[cfg(windows)]
        let path = "C:\\nonexistent\\path\\file.mp4";
        #[cfg(not(windows))]
        let path = "/nonexistent/path/file.mp4";

        let result = validate_local_input_path(path, "inputPath");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("not found"));
    }

    #[test]
    fn test_validate_local_input_path_directory_rejected() {
        let dir = TempDir::new().unwrap();
        let dir_path = dir.path().to_string_lossy().to_string();

        let result = validate_local_input_path(&dir_path, "inputPath");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("not a file"));
    }

    /// Every separator spelling of a share must be refused *lexically*.
    ///
    /// The distinguishing assertion is the error text: none of these paths
    /// exists, so if the validator had reached `fs::metadata` the error would
    /// read "file not found". Seeing the network-path message instead is the
    /// proof that the rejection happened before the filesystem was touched —
    /// which is the whole point, because on Windows that stat is the outbound
    /// SMB connection and the NTLM handshake leak.
    #[test]
    fn should_reject_a_unc_input_path_before_stat_ing_it() {
        for path in [
            r"\\host\share\x.mp4",
            "//host/share/x.mp4",
            r"/\host\share\x.mp4",
            r"\\?\UNC\host\share\x.mp4",
        ] {
            let error = validate_local_input_path(path, "inputPath")
                .expect_err(&format!("'{path}' names a share and must be rejected"));
            assert!(
                error.contains("UNC or network share"),
                "'{path}' must be refused by the network-path check, not by a filesystem \
                 probe: {error}"
            );
            assert!(
                !error.contains("not found"),
                "'{path}' reached the filesystem before being rejected: {error}"
            );
        }
    }

    #[tokio::test]
    async fn should_reject_a_unc_input_path_before_stat_ing_it_async() {
        for path in [
            r"\\host\share\x.mp4",
            "//host/share/x.mp4",
            r"/\host\share\x.mp4",
            r"\\?\UNC\host\share\x.mp4",
        ] {
            let error = validate_local_input_path_async(path, "inputPath")
                .await
                .expect_err(&format!("'{path}' names a share and must be rejected"));
            assert!(
                error.contains("UNC or network share"),
                "'{path}' must be refused by the network-path check, not by a filesystem \
                 probe: {error}"
            );
            assert!(
                !error.contains("not found"),
                "'{path}' reached the filesystem before being rejected: {error}"
            );
        }
    }

    #[test]
    fn test_validate_local_input_path_valid_file() {
        let dir = TempDir::new().unwrap();
        let file_path = dir.path().join("test.txt");
        std::fs::write(&file_path, "test content").unwrap();

        let path_str = file_path.to_string_lossy().to_string();
        let result = validate_local_input_path(&path_str, "inputPath");
        assert!(result.is_ok());
        let got = result.unwrap();
        let expected = std::fs::canonicalize(&file_path).unwrap_or(file_path);
        assert_eq!(got, expected);
    }

    #[test]
    fn test_validate_local_input_path_rejects_dot_segments() {
        let dir = TempDir::new().unwrap();
        let sub = dir.path().join("sub");
        std::fs::create_dir_all(&sub).unwrap();
        let file_path = sub.join("file.txt");
        std::fs::write(&file_path, "test").unwrap();

        // Create an absolute path containing a parent-dir segment.
        let dotty = sub.join("..").join("sub").join("file.txt");
        let dotty_str = dotty.to_string_lossy().to_string();
        let result = validate_local_input_path(&dotty_str, "inputPath");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("'.' or '..'"));
    }

    #[test]
    fn test_validate_output_path_empty() {
        let result = validate_output_path("", "outputPath");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("empty"));
    }

    #[test]
    fn test_validate_output_path_requires_absolute() {
        let result = validate_output_path("relative/path/output.mp4", "outputPath");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("absolute path"));
    }

    #[test]
    fn test_validate_output_path_creates_parent_dirs() {
        let dir = TempDir::new().unwrap();
        let nested_path = dir.path().join("a").join("b").join("c").join("output.mp4");
        let path_str = nested_path.to_string_lossy().to_string();

        let result = validate_output_path(&path_str, "outputPath");
        assert!(result.is_ok());

        // Parent directories should have been created
        assert!(nested_path.parent().unwrap().exists());
    }

    #[test]
    fn test_validate_output_path_rejects_directory() {
        let dir = TempDir::new().unwrap();
        let dir_path = dir.path().to_string_lossy().to_string();

        let result = validate_output_path(&dir_path, "outputPath");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("directory"));
    }

    #[test]
    fn test_validate_output_path_allows_existing_file() {
        let dir = TempDir::new().unwrap();
        let file_path = dir.path().join("existing.mp4");
        std::fs::write(&file_path, "existing content").unwrap();

        let path_str = file_path.to_string_lossy().to_string();
        let result = validate_output_path(&path_str, "outputPath");
        assert!(result.is_ok());
    }

    #[test]
    fn test_validate_scoped_input_path_allows_within_root() {
        let root = TempDir::new().unwrap();
        let nested_dir = root.path().join("exports");
        std::fs::create_dir_all(&nested_dir).unwrap();
        let input = nested_dir.join("diarization.json");
        std::fs::write(&input, "{}").unwrap();

        let result = validate_scoped_input_path(
            &input.to_string_lossy(),
            "diarization inputPath",
            &[root.path()],
        );

        assert!(
            result.is_ok(),
            "in-scope input must be accepted: {result:?}"
        );
    }

    #[test]
    fn test_validate_scoped_input_path_rejects_outside_root() {
        // An absolute path to an existing regular file passes
        // `validate_local_input_path` on its own; only the scope check stops the
        // command from being used as a read oracle for the rest of the disk.
        let allowed_root = TempDir::new().unwrap();
        let outside_root = TempDir::new().unwrap();
        let input = outside_root.path().join("secret.json");
        std::fs::write(&input, "{}").unwrap();

        assert!(
            validate_local_input_path(&input.to_string_lossy(), "diarization inputPath").is_ok()
        );

        let result = validate_scoped_input_path(
            &input.to_string_lossy(),
            "diarization inputPath",
            &[allowed_root.path()],
        );

        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .contains("must be within an allowed directory"));
    }

    #[test]
    fn test_validate_scoped_output_path_allows_within_root() {
        let root = TempDir::new().unwrap();
        let nested = root
            .path()
            .join("openreelio")
            .join("frames")
            .join("out.png");
        let nested_str = nested.to_string_lossy().to_string();

        let result = validate_scoped_output_path(&nested_str, "outputPath", &[root.path()]);
        assert!(result.is_ok());
        assert!(nested.parent().unwrap().exists());
    }

    #[test]
    fn test_validate_scoped_output_path_rejects_outside_root() {
        let allowed_root = TempDir::new().unwrap();
        let outside_root = TempDir::new().unwrap();
        let out = outside_root.path().join("out.png");
        let out_str = out.to_string_lossy().to_string();

        let result = validate_scoped_output_path(&out_str, "outputPath", &[allowed_root.path()]);
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .contains("must be within an allowed directory"));
    }

    #[test]
    fn test_validate_scoped_output_path_does_not_create_dirs_outside_root() {
        let allowed_root = TempDir::new().unwrap();
        let outside_root = TempDir::new().unwrap();

        let outside_parent = outside_root.path().join("will_not_be_created");
        let out = outside_parent.join("out.png");
        let out_str = out.to_string_lossy().to_string();

        assert!(!outside_parent.exists());
        let result = validate_scoped_output_path(&out_str, "outputPath", &[allowed_root.path()]);
        assert!(result.is_err());
        assert!(
            !outside_parent.exists(),
            "validate_scoped_output_path must not create directories outside allowed roots"
        );
    }

    #[test]
    fn test_validate_scoped_output_path_allows_multiple_roots() {
        let root_a = TempDir::new().unwrap();
        let root_b = TempDir::new().unwrap();

        let out = root_b.path().join("b").join("out.png");
        let out_str = out.to_string_lossy().to_string();

        let result =
            validate_scoped_output_path(&out_str, "outputPath", &[root_a.path(), root_b.path()]);
        assert!(result.is_ok());
    }

    #[test]
    fn test_validate_scoped_output_path_skips_missing_allowed_roots() {
        let root = TempDir::new().unwrap();
        let missing_root = root.path().join("missing-root");
        let out = root.path().join("exports").join("out.png");
        let out_str = out.to_string_lossy().to_string();

        let result =
            validate_scoped_output_path(&out_str, "outputPath", &[&missing_root, root.path()]);
        assert!(result.is_ok());
        assert!(out.parent().unwrap().exists());
    }

    #[test]
    fn test_validate_scoped_output_path_rejects_dotdot_segments() {
        let root = TempDir::new().unwrap();
        let out = root
            .path()
            .join("frames")
            .join("..")
            .join("evil")
            .join("out.png");
        let out_str = out.to_string_lossy().to_string();

        let result = validate_scoped_output_path(&out_str, "outputPath", &[root.path()]);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("must not contain '.' or '..'"));
    }

    #[test]
    fn test_validate_scoped_output_path_rejects_prefix_sibling_dir() {
        // Regression test: string-prefix checks can incorrectly allow paths like:
        // allowed root:   C:\...\root
        // output parent:  C:\...\root_evil
        // This must be rejected.
        let base = TempDir::new().unwrap();

        let allowed_root = base.path().join("root");
        let sibling = base.path().join("root_evil");
        std::fs::create_dir_all(&allowed_root).unwrap();
        std::fs::create_dir_all(&sibling).unwrap();

        let out = sibling.join("out.png");
        let out_str = out.to_string_lossy().to_string();

        let result = validate_scoped_output_path(&out_str, "outputPath", &[&allowed_root]);
        assert!(
            result.is_err(),
            "expected output in prefix-sibling dir to be rejected"
        );
    }

    #[test]
    fn test_export_allowed_roots_includes_project_and_approved_dirs() {
        let project = TempDir::new().unwrap();
        let approved = TempDir::new().unwrap();

        let mut approved_dirs = std::collections::HashSet::new();
        approved_dirs.insert(approved.path().to_path_buf());

        let roots = export_allowed_roots(project.path(), &approved_dirs);

        assert!(
            roots.iter().any(|r| r == project.path()),
            "project directory must always be an allowed root"
        );
        assert!(
            roots.iter().any(|r| r == approved.path()),
            "user-approved directory must be an allowed root"
        );
    }

    #[test]
    fn test_validate_scoped_output_path_allows_within_approved_dir() {
        // A directory outside the default roots becomes valid once it is approved.
        let project = TempDir::new().unwrap();
        let approved = TempDir::new().unwrap();

        let mut approved_dirs = std::collections::HashSet::new();
        approved_dirs.insert(approved.path().to_path_buf());

        let out = approved.path().join("export.mp4");
        let out_str = out.to_string_lossy().to_string();

        let roots = export_allowed_roots(project.path(), &approved_dirs);
        let root_refs: Vec<&Path> = roots.iter().map(|p| p.as_path()).collect();

        let result = validate_scoped_output_path(&out_str, "Output path", &root_refs);
        assert!(
            result.is_ok(),
            "path under an approved directory must validate: {result:?}"
        );
    }

    #[test]
    fn test_validate_scoped_output_path_rejects_outside_default_and_approved_dirs() {
        // A forged path that is neither under the default roots nor approved must be rejected.
        let project = TempDir::new().unwrap();
        let approved = TempDir::new().unwrap();
        let forged = TempDir::new().unwrap();

        let mut approved_dirs = std::collections::HashSet::new();
        approved_dirs.insert(approved.path().to_path_buf());

        let out = forged.path().join("evil.mp4");
        let out_str = out.to_string_lossy().to_string();

        let roots = export_allowed_roots(project.path(), &approved_dirs);
        let root_refs: Vec<&Path> = roots.iter().map(|p| p.as_path()).collect();

        let result = validate_scoped_output_path(&out_str, "Output path", &root_refs);
        assert!(
            result.is_err(),
            "path outside default roots and approved dirs must be rejected"
        );
        assert!(result
            .unwrap_err()
            .contains("must be within an allowed directory"));
    }

    #[cfg(unix)]
    #[test]
    fn test_validate_scoped_output_path_rejects_final_symlink() {
        use std::os::unix::fs::symlink;

        let root = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        let outside_file = outside.path().join("target.mp4");
        std::fs::write(&outside_file, "external").unwrap();

        let output = root.path().join("out.mp4");
        symlink(&outside_file, &output).unwrap();

        let output_str = output.to_string_lossy().to_string();
        let result = validate_scoped_output_path(&output_str, "outputPath", &[root.path()]);

        assert!(result.is_err());
        assert!(result.unwrap_err().contains("must not be a symlink"));
    }

    #[tokio::test]
    async fn test_validate_local_input_path_async_valid() {
        let dir = TempDir::new().unwrap();
        let file_path = dir.path().join("test.txt");
        tokio::fs::write(&file_path, "test content").await.unwrap();

        let path_str = file_path.to_string_lossy().to_string();
        let result = validate_local_input_path_async(&path_str, "inputPath").await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_validate_local_input_path_async_rejects_urls() {
        let result =
            validate_local_input_path_async("https://evil.com/malware.mp4", "inputPath").await;
        assert!(result.is_err());
    }

    // =========================================================================
    // Security Edge Case Tests
    // =========================================================================

    #[test]
    fn test_path_traversal_unicode_normalization() {
        // Some systems might normalize unicode differently
        // Test that we catch common bypass attempts
        let result = validate_path_id_component("foo\u{002F}bar", "assetId"); // Unicode forward slash
        assert!(result.is_err());
    }

    #[test]
    fn test_path_id_with_unicode() {
        // Valid unicode characters should be allowed
        assert!(validate_path_id_component("资产_001", "assetId").is_ok());
        assert!(validate_path_id_component("アセット", "assetId").is_ok());
        assert!(validate_path_id_component("asset_émoji_🎬", "assetId").is_ok());
    }

    #[test]
    fn test_path_validation_with_spaces() {
        // Spaces should be handled correctly
        let result = validate_local_input_path("  /some/path  ", "inputPath");
        // Should fail because file doesn't exist, not because of spaces
        assert!(result.is_err());
        assert!(!result.unwrap_err().contains("empty"));
    }
}
