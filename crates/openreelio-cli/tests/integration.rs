//! Integration tests for the OpenReelio CLI.
//!
//! These tests exercise the CLI through the actual binary using `std::process::Command`.
//! Each test creates a temporary project directory and runs CLI commands against it.

use std::collections::HashSet;
use std::path::PathBuf;
use std::process::Command;

/// Get the path to the built CLI binary.
fn cli_bin() -> PathBuf {
    // cargo test builds the binary in the same target directory
    let mut path = std::env::current_exe()
        .expect("Failed to get current exe path")
        .parent()
        .expect("Failed to get parent dir")
        .parent()
        .expect("Failed to get grandparent dir")
        .to_path_buf();
    #[cfg(target_os = "windows")]
    path.push("openreelio-cli.exe");
    #[cfg(not(target_os = "windows"))]
    path.push("openreelio-cli");
    path
}

/// Run a CLI command and return (stdout, stderr, success).
fn run_cli(args: &[&str]) -> (String, String, bool) {
    let output = Command::new(cli_bin())
        .args(args)
        .output()
        .expect("Failed to execute CLI binary");
    (
        String::from_utf8_lossy(&output.stdout).to_string(),
        String::from_utf8_lossy(&output.stderr).to_string(),
        output.status.success(),
    )
}

/// Run CLI and assert success, returning parsed JSON stdout.
fn run_cli_ok(args: &[&str]) -> serde_json::Value {
    let (stdout, stderr, success) = run_cli(args);
    assert!(
        success,
        "CLI command {:?} failed.\nstdout: {}\nstderr: {}",
        args, stdout, stderr
    );
    serde_json::from_str(&stdout).unwrap_or_else(|e| {
        panic!(
            "Failed to parse JSON output for {:?}: {}\nstdout: {}",
            args, e, stdout
        )
    })
}

/// Run CLI and assert failure (non-zero exit code).
fn run_cli_err(args: &[&str]) -> (String, String) {
    let (stdout, stderr, success) = run_cli(args);
    assert!(
        !success,
        "CLI command {:?} should have failed but succeeded.\nstdout: {}\nstderr: {}",
        args, stdout, stderr
    );
    (stdout, stderr)
}

/// Create a temporary project directory and return its path.
fn create_temp_project(name: &str) -> tempfile::TempDir {
    let dir = tempfile::tempdir().expect("Failed to create temp dir");
    let project_path = dir.path().join(name);
    std::fs::create_dir_all(&project_path).expect("Failed to create project dir");
    let result = run_cli_ok(&[
        "project",
        "create",
        "--name",
        name,
        "--path",
        project_path.to_str().unwrap(),
    ]);
    assert_eq!(result["status"], "ok");
    dir
}

fn project_path(dir: &tempfile::TempDir, name: &str) -> String {
    dir.path().join(name).to_string_lossy().to_string()
}

fn system_ffmpeg_path() -> Option<PathBuf> {
    openreelio_core::ffmpeg::detect_system_ffmpeg()
        .ok()
        .map(|info| info.ffmpeg_path)
}

/// Run a CLI command from `cwd` with extra environment variables applied.
///
/// The FFmpeg path overrides are always cleared so a developer's shell cannot
/// change what the resolver picks during the test.
fn run_cli_from(
    cwd: &std::path::Path,
    env: &[(&str, &str)],
    args: &[&str],
) -> (String, String, bool) {
    let mut command = Command::new(cli_bin());
    command
        .current_dir(cwd)
        .env_remove("OPENREELIO_FFMPEG_PATH")
        .env_remove("OPENREELIO_FFPROBE_PATH")
        .env_remove("OPENREELIO_DEV")
        .args(args);
    for (key, value) in env {
        command.env(key, value);
    }

    let output = command.output().expect("Failed to execute CLI binary");
    (
        String::from_utf8_lossy(&output.stdout).to_string(),
        String::from_utf8_lossy(&output.stderr).to_string(),
        output.status.success(),
    )
}

/// Hard-link (or copy, across volumes) a binary to a new location.
fn link_or_copy(source: &std::path::Path, target: &std::path::Path) -> bool {
    std::fs::hard_link(source, target).is_ok() || std::fs::copy(source, target).is_ok()
}

/// Plant a working ffmpeg/ffprobe pair under `<dir>/binaries`.
///
/// Returns the planted ffmpeg path, or `None` when no installation is
/// available to clone. The plant must be genuinely runnable: a resolver that
/// consults the directory would otherwise reject it for the wrong reason and
/// the test would prove nothing.
fn plant_bundled_ffmpeg(dir: &std::path::Path) -> Option<PathBuf> {
    // Any resolvable installation will do as the clone source (bundled, dev,
    // managed, or system), so the test still runs where FFmpeg is not on PATH.
    let info = openreelio_core::ffmpeg::resolve_ffmpeg(&Default::default()).ok()?;
    let (ffmpeg_name, ffprobe_name) = openreelio_core::ffmpeg::get_bundled_binary_names();

    let binaries = dir.join("binaries");
    std::fs::create_dir_all(&binaries).ok()?;

    let planted_ffmpeg = binaries.join(ffmpeg_name);
    if !link_or_copy(&info.ffmpeg_path, &planted_ffmpeg)
        || !link_or_copy(&info.ffprobe_path, &binaries.join(ffprobe_name))
    {
        return None;
    }

    Some(planted_ffmpeg)
}

/// Resolve the ffmpeg path reported by `ffmpeg info`, canonicalized.
fn resolved_ffmpeg_from(cwd: &std::path::Path, env: &[(&str, &str)]) -> Option<PathBuf> {
    let (stdout, stderr, success) = run_cli_from(cwd, env, &["ffmpeg", "info"]);
    if !success {
        eprintln!("ffmpeg info failed.\nstdout: {stdout}\nstderr: {stderr}");
        return None;
    }

    let value: serde_json::Value = serde_json::from_str(&stdout).ok()?;
    let path = PathBuf::from(value["ffmpegPath"].as_str()?);
    std::fs::canonicalize(path).ok()
}

/// The CLI runs as an MCP server with an agent's project directory as its
/// working directory, so that directory is untrusted input. A repository that
/// happens to carry `binaries/ffmpeg` must never be executed.
#[test]
fn should_not_execute_ffmpeg_planted_in_the_working_directory() {
    let dir = tempfile::tempdir().expect("Failed to create temp dir");
    let Some(planted) = plant_bundled_ffmpeg(dir.path()) else {
        eprintln!("Skipping CWD hijack test: no FFmpeg installation available to plant");
        return;
    };
    let planted = std::fs::canonicalize(&planted).expect("Failed to canonicalize planted ffmpeg");

    let Some(default_resolved) = resolved_ffmpeg_from(dir.path(), &[]) else {
        eprintln!("Skipping CWD hijack test: no FFmpeg resolved in the default configuration");
        return;
    };
    assert_ne!(
        default_resolved, planted,
        "the working directory must not be a bundled-binary root by default"
    );

    // The opt-in run proves the plant would have been selected, so the
    // assertion above is not passing for an unrelated reason.
    let dev_resolved = resolved_ffmpeg_from(dir.path(), &[("OPENREELIO_DEV", "1")])
        .expect("ffmpeg info should resolve with the developer opt-in");
    assert_eq!(
        dev_resolved, planted,
        "OPENREELIO_DEV must restore working-directory discovery for developers"
    );
}

fn ffmpeg_supports_encoder(ffmpeg_path: &std::path::Path, encoder: &str) -> bool {
    let Ok(output) = Command::new(ffmpeg_path)
        .args(["-hide_banner", "-encoders"])
        .output()
    else {
        return false;
    };

    if !output.status.success() {
        return false;
    }

    String::from_utf8_lossy(&output.stdout)
        .lines()
        .any(|line| line.split_whitespace().any(|token| token == encoder))
}

fn create_sample_video(path: &std::path::Path) -> bool {
    create_sample_video_with_duration(path, 1)
}

fn create_sample_video_with_duration(path: &std::path::Path, duration_secs: u32) -> bool {
    let Some(ffmpeg_path) = system_ffmpeg_path() else {
        return false;
    };

    let video_encoder = if ffmpeg_supports_encoder(&ffmpeg_path, "libx264") {
        "libx264"
    } else if ffmpeg_supports_encoder(&ffmpeg_path, "mpeg4") {
        "mpeg4"
    } else {
        eprintln!("Skipping render export test: ffmpeg lacks a supported video encoder");
        return false;
    };

    let mut command = Command::new(ffmpeg_path);
    command.args([
        "-y",
        "-f",
        "lavfi",
        "-i",
        &format!("color=c=black:s=320x240:d={duration_secs}"),
        "-c:v",
        video_encoder,
    ]);
    if video_encoder == "libx264" {
        command.args(["-pix_fmt", "yuv420p"]);
    }

    let status = command
        .arg(path)
        .status()
        .expect("Failed to generate sample video with ffmpeg");

    if !status.success() {
        eprintln!("Skipping render export test: ffmpeg could not generate the sample video");
    }

    status.success()
}

/// Picks the best available H.264-ish encoder, or `None` when ffmpeg has none.
fn preferred_video_encoder(ffmpeg_path: &std::path::Path) -> Option<&'static str> {
    if ffmpeg_supports_encoder(ffmpeg_path, "libx264") {
        Some("libx264")
    } else if ffmpeg_supports_encoder(ffmpeg_path, "mpeg4") {
        Some("mpeg4")
    } else {
        None
    }
}

/// Generates a 4-second video with a hard black-to-white cut at 2s.
///
/// Shot detection needs an unambiguous scene change; a single flat colour
/// source produces none.
fn create_sample_video_with_scene_change(path: &std::path::Path) -> bool {
    let Some(ffmpeg_path) = system_ffmpeg_path() else {
        return false;
    };
    let Some(video_encoder) = preferred_video_encoder(&ffmpeg_path) else {
        eprintln!("Skipping perception test: ffmpeg lacks a supported video encoder");
        return false;
    };

    let mut command = Command::new(ffmpeg_path);
    command.args([
        "-y",
        "-f",
        "lavfi",
        "-i",
        "color=c=black:s=320x240:r=25:d=2",
        "-f",
        "lavfi",
        "-i",
        "color=c=white:s=320x240:r=25:d=2",
        "-filter_complex",
        "[0:v][1:v]concat=n=2:v=1:a=0[v]",
        "-map",
        "[v]",
        "-c:v",
        video_encoder,
    ]);
    if video_encoder == "libx264" {
        command.args(["-pix_fmt", "yuv420p"]);
    }

    let status = command
        .arg(path)
        .status()
        .expect("Failed to generate scene-change sample with ffmpeg");
    if !status.success() {
        eprintln!("Skipping perception test: ffmpeg could not generate the scene-change sample");
    }
    status.success()
}

/// Generates a 4-second video whose audio is a tone with a silent 1s–3s gap.
///
/// Silence detection and audio profiling need a real audio stream; the plain
/// colour fixture is video-only.
fn create_sample_video_with_audio(path: &std::path::Path) -> bool {
    let Some(ffmpeg_path) = system_ffmpeg_path() else {
        return false;
    };
    let Some(video_encoder) = preferred_video_encoder(&ffmpeg_path) else {
        eprintln!("Skipping perception test: ffmpeg lacks a supported video encoder");
        return false;
    };
    if !ffmpeg_supports_encoder(&ffmpeg_path, "aac") {
        eprintln!("Skipping perception test: ffmpeg lacks the aac encoder");
        return false;
    }

    let mut command = Command::new(ffmpeg_path);
    command.args([
        "-y",
        "-f",
        "lavfi",
        "-i",
        "color=c=black:s=320x240:r=25:d=4",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:sample_rate=44100:duration=4",
        "-af",
        "volume=enable='between(t,1,3)':volume=0",
        "-c:v",
        video_encoder,
    ]);
    if video_encoder == "libx264" {
        command.args(["-pix_fmt", "yuv420p"]);
    }
    command.args(["-c:a", "aac", "-shortest"]);

    let status = command
        .arg(path)
        .status()
        .expect("Failed to generate audio sample with ffmpeg");
    if !status.success() {
        eprintln!("Skipping perception test: ffmpeg could not generate the audio sample");
    }
    status.success()
}

/// Generates a 4-second audio-only WAV fixture, for tests that need a clip an
/// audio track will accept.
fn create_sample_audio(path: &std::path::Path) -> bool {
    let Some(ffmpeg_path) = system_ffmpeg_path() else {
        return false;
    };

    let status = Command::new(ffmpeg_path)
        .args([
            "-y",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:sample_rate=44100:duration=4",
            "-af",
            "volume=0.25",
        ])
        .arg(path)
        .status()
        .expect("Failed to generate audio fixture with ffmpeg");
    if !status.success() {
        eprintln!("Skipping test: ffmpeg could not generate the audio fixture");
    }
    status.success()
}

/// Generates a 4-second fixture with a hard black-to-white cut at 2s and an
/// attenuated tone whose 1s–3s window is muted.
///
/// The agent loop needs one asset that both shot detection and silence
/// detection can find something in. The tone is deliberately attenuated so the
/// rendered proxy stays well under the true-peak ceiling `verify` enforces;
/// a full-scale sine would be a clipped, not a healthy, render.
fn create_sample_video_with_scene_change_and_audio(path: &std::path::Path) -> bool {
    let Some(ffmpeg_path) = system_ffmpeg_path() else {
        return false;
    };
    let Some(video_encoder) = preferred_video_encoder(&ffmpeg_path) else {
        eprintln!("Skipping agent-loop test: ffmpeg lacks a supported video encoder");
        return false;
    };
    if !ffmpeg_supports_encoder(&ffmpeg_path, "aac") {
        eprintln!("Skipping agent-loop test: ffmpeg lacks the aac encoder");
        return false;
    }

    let mut command = Command::new(ffmpeg_path);
    command.args([
        "-y",
        "-f",
        "lavfi",
        "-i",
        "color=c=black:s=320x240:r=25:d=2",
        "-f",
        "lavfi",
        "-i",
        "color=c=white:s=320x240:r=25:d=2",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:sample_rate=44100:duration=4",
        "-filter_complex",
        "[0:v][1:v]concat=n=2:v=1:a=0[v];\
         [2:a]volume=0.25,volume=enable='between(t,1,3)':volume=0[a]",
        "-map",
        "[v]",
        "-map",
        "[a]",
        "-c:v",
        video_encoder,
    ]);
    if video_encoder == "libx264" {
        command.args(["-pix_fmt", "yuv420p"]);
    }
    command.args(["-c:a", "aac", "-shortest"]);

    let status = command
        .arg(path)
        .status()
        .expect("Failed to generate agent-loop sample with ffmpeg");
    if !status.success() {
        eprintln!("Skipping agent-loop test: ffmpeg could not generate the agent-loop sample");
    }
    status.success()
}

fn system_ffprobe_path() -> Option<PathBuf> {
    openreelio_core::ffmpeg::detect_system_ffmpeg()
        .ok()
        .map(|info| info.ffprobe_path)
}

/// Probe the total duration (in seconds) of a media file via ffprobe.
/// Returns `None` if ffprobe is unavailable or the output cannot be parsed.
fn ffprobe_duration_secs(path: &std::path::Path) -> Option<f64> {
    let ffprobe_path = system_ffprobe_path()?;
    let output = Command::new(ffprobe_path)
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
        ])
        .arg(path)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout).trim().parse().ok()
}

/// Probe the duration of the first video stream via ffprobe.
///
/// This is deliberately not `format=duration`: the container duration is the
/// maximum across all streams, so it says nothing about where the pictures stop.
fn ffprobe_video_duration_secs(path: &std::path::Path) -> Option<f64> {
    let ffprobe_path = system_ffprobe_path()?;
    let output = Command::new(ffprobe_path)
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
        ])
        .arg(path)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout).trim().parse().ok()
}

/// Probe the height (in pixels) of the first video stream via ffprobe.
/// Returns `None` if ffprobe is unavailable or the output cannot be parsed.
fn ffprobe_video_height(path: &std::path::Path) -> Option<u32> {
    let ffprobe_path = system_ffprobe_path()?;
    let output = Command::new(ffprobe_path)
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=height",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
        ])
        .arg(path)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout).trim().parse().ok()
}

/// Probe the pixel dimensions of the first video stream via ffprobe.
///
/// Works for still images too — ffprobe reports them as a single-frame video
/// stream. Returns `None` if ffprobe is unavailable or the output cannot be
/// parsed.
fn ffprobe_image_size(path: &std::path::Path) -> Option<(u32, u32)> {
    let ffprobe_path = system_ffprobe_path()?;
    let output = Command::new(ffprobe_path)
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height",
            "-of",
            "csv=p=0:s=x",
        ])
        .arg(path)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let (width, height) = text.trim().split_once('x')?;
    Some((width.trim().parse().ok()?, height.trim().parse().ok()?))
}

// =============================================================================
// Project Commands
// =============================================================================

#[test]
fn test_project_create() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("test_proj");
    std::fs::create_dir_all(&path).unwrap();
    let result = run_cli_ok(&[
        "project",
        "create",
        "--name",
        "Test Project",
        "--path",
        path.to_str().unwrap(),
    ]);
    assert_eq!(result["status"], "ok");
    assert_eq!(result["name"], "Test Project");
}

#[test]
fn test_project_open() {
    let dir = create_temp_project("open_test");
    let path = project_path(&dir, "open_test");
    let result = run_cli_ok(&["project", "open", "--path", &path]);
    assert_eq!(result["status"], "ok");
    assert_eq!(result["name"], "open_test");
}

#[test]
fn test_project_info() {
    let dir = create_temp_project("info_test");
    let path = project_path(&dir, "info_test");
    let result = run_cli_ok(&["project", "info", "--path", &path]);
    assert_eq!(result["name"], "info_test");
    assert!(result["sequences"].is_array());
    assert!(result["assets"].is_array());
}

#[test]
fn test_project_save() {
    let dir = create_temp_project("save_test");
    let path = project_path(&dir, "save_test");
    let result = run_cli_ok(&["project", "save", "--path", &path]);
    assert_eq!(result["status"], "ok");
}

#[test]
fn test_project_open_nonexistent() {
    let (_stdout, stderr) = run_cli_err(&["project", "open", "--path", "/nonexistent/path"]);
    assert!(
        stderr.contains("not found") || stderr.contains("No such file"),
        "Expected path not found error, got: {}",
        stderr
    );
}

// =============================================================================
// Asset Commands
// =============================================================================

#[test]
fn test_asset_list_empty() {
    let dir = create_temp_project("asset_list_test");
    let path = project_path(&dir, "asset_list_test");
    let result = run_cli_ok(&["asset", "list", "--path", &path]);
    assert_eq!(result["count"], 0);
    assert!(result["assets"].as_array().unwrap().is_empty());
}

#[test]
fn test_asset_import_and_list() {
    let dir = create_temp_project("asset_import_test");
    let path = project_path(&dir, "asset_import_test");

    // Create a dummy file to import
    let dummy_file = dir.path().join("test_video.mp4");
    std::fs::write(&dummy_file, b"dummy video content").unwrap();

    let result = run_cli_ok(&[
        "asset",
        "import",
        "--path",
        &path,
        "--file",
        dummy_file.to_str().unwrap(),
    ]);
    assert_eq!(result["status"], "ok");
    assert!(!result["createdIds"].as_array().unwrap().is_empty());

    // Verify it appears in list
    let list = run_cli_ok(&["asset", "list", "--path", &path]);
    assert_eq!(list["count"], 1);
}

#[test]
fn test_asset_import_nonexistent_file() {
    let dir = create_temp_project("asset_import_err_test");
    let path = project_path(&dir, "asset_import_err_test");
    let (_stdout, stderr) = run_cli_err(&[
        "asset",
        "import",
        "--path",
        &path,
        "--file",
        "/nonexistent/file.mp4",
    ]);
    assert!(
        stderr.contains("not found") || stderr.contains("No such file"),
        "Expected file not found error, got: {}",
        stderr
    );
}

#[test]
fn test_asset_info_nonexistent() {
    let dir = create_temp_project("asset_info_err_test");
    let path = project_path(&dir, "asset_info_err_test");
    let (_stdout, stderr) =
        run_cli_err(&["asset", "info", "--path", &path, "--id", "nonexistent_id"]);
    assert!(
        stderr.contains("not found"),
        "Expected asset not found error, got: {}",
        stderr
    );
}

#[test]
fn test_asset_remove() {
    let dir = create_temp_project("asset_remove_test");
    let path = project_path(&dir, "asset_remove_test");

    // Import an asset
    let dummy_file = dir.path().join("remove_test.mp4");
    std::fs::write(&dummy_file, b"dummy").unwrap();
    let import_result = run_cli_ok(&[
        "asset",
        "import",
        "--path",
        &path,
        "--file",
        dummy_file.to_str().unwrap(),
    ]);
    let asset_id = import_result["createdIds"][0].as_str().unwrap().to_string();

    // Remove it
    let result = run_cli_ok(&["asset", "remove", "--path", &path, "--id", &asset_id]);
    assert_eq!(result["status"], "ok");

    // Verify it's gone
    let list = run_cli_ok(&["asset", "list", "--path", &path]);
    assert_eq!(list["count"], 0);
}

// =============================================================================
// Timeline Commands
// =============================================================================

#[test]
fn test_timeline_info() {
    let dir = create_temp_project("timeline_info_test");
    let path = project_path(&dir, "timeline_info_test");
    let result = run_cli_ok(&["timeline", "info", "--path", &path]);
    assert!(result["sequenceId"].is_string());
    assert!(result["tracks"].is_array());
}

#[test]
fn test_timeline_clips_empty() {
    let dir = create_temp_project("timeline_clips_test");
    let path = project_path(&dir, "timeline_clips_test");
    let result = run_cli_ok(&["timeline", "clips", "--path", &path]);
    assert_eq!(result["count"], 0);
}

#[test]
fn test_timeline_tracks() {
    let dir = create_temp_project("timeline_tracks_test");
    let path = project_path(&dir, "timeline_tracks_test");
    let result = run_cli_ok(&["timeline", "tracks", "--path", &path]);
    // Default project should have at least some tracks
    assert!(result["tracks"].is_array());
}

#[test]
fn test_timeline_add_track() {
    let dir = create_temp_project("add_track_test");
    let path = project_path(&dir, "add_track_test");

    let before = run_cli_ok(&["timeline", "tracks", "--path", &path]);
    let before_count = before["count"].as_u64().unwrap();

    let result = run_cli_ok(&[
        "timeline",
        "add-track",
        "--path",
        &path,
        "--kind",
        "video",
        "--name",
        "Video 2",
    ]);
    assert_eq!(result["status"], "ok");

    let after = run_cli_ok(&["timeline", "tracks", "--path", &path]);
    assert_eq!(after["count"].as_u64().unwrap(), before_count + 1);
}

#[test]
fn test_timeline_add_track_invalid_kind() {
    let dir = create_temp_project("add_track_invalid_test");
    let path = project_path(&dir, "add_track_invalid_test");
    let (_stdout, stderr) = run_cli_err(&[
        "timeline",
        "add-track",
        "--path",
        &path,
        "--kind",
        "invalid",
        "--name",
        "Bad Track",
    ]);
    assert!(
        stderr.contains("Unknown track kind"),
        "Expected track kind error, got: {}",
        stderr
    );
}

#[test]
fn test_timeline_insert_clip() {
    let dir = create_temp_project("insert_clip_test");
    let path = project_path(&dir, "insert_clip_test");

    // Import an asset first
    let dummy_file = dir.path().join("clip.mp4");
    std::fs::write(&dummy_file, b"dummy video").unwrap();
    let import = run_cli_ok(&[
        "asset",
        "import",
        "--path",
        &path,
        "--file",
        dummy_file.to_str().unwrap(),
    ]);
    let asset_id = import["createdIds"][0].as_str().unwrap().to_string();

    // Get a track ID
    let tracks = run_cli_ok(&["timeline", "tracks", "--path", &path]);
    let track_id = tracks["tracks"][0]["id"].as_str().unwrap().to_string();

    // Insert clip
    let result = run_cli_ok(&[
        "timeline", "insert", "--path", &path, "--asset", &asset_id, "--track", &track_id, "--at",
        "0.0",
    ]);
    assert_eq!(result["status"], "ok");
    assert!(!result["createdIds"].as_array().unwrap().is_empty());
}

#[test]
fn test_timeline_undo_redo() {
    let dir = create_temp_project("undo_redo_test");
    let path = project_path(&dir, "undo_redo_test");

    let dummy_file = dir.path().join("undo_redo_clip.mp4");
    std::fs::write(&dummy_file, b"dummy video").unwrap();
    let import = run_cli_ok(&[
        "asset",
        "import",
        "--path",
        &path,
        "--file",
        dummy_file.to_str().unwrap(),
    ]);
    let asset_id = import["createdIds"][0].as_str().unwrap().to_string();

    let tracks = run_cli_ok(&["timeline", "tracks", "--path", &path]);
    let track_id = tracks["tracks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|track| track["kind"] == "Video")
        .and_then(|track| track["id"].as_str())
        .unwrap()
        .to_string();

    run_cli_ok(&[
        "timeline", "insert", "--path", &path, "--asset", &asset_id, "--track", &track_id, "--at",
        "0.0",
    ]);

    let clips_after_insert = run_cli_ok(&["timeline", "clips", "--path", &path]);
    assert_eq!(clips_after_insert["count"], 1);

    run_cli_ok(&["timeline", "undo", "--path", &path]);
    let clips_after_undo = run_cli_ok(&["timeline", "clips", "--path", &path]);
    assert_eq!(clips_after_undo["count"], 0);

    run_cli_ok(&["timeline", "redo", "--path", &path]);
    let clips_after_redo = run_cli_ok(&["timeline", "clips", "--path", &path]);
    assert_eq!(clips_after_redo["count"], 1);
}

#[test]
fn test_timeline_new_edit_clears_redo_branch() {
    let dir = create_temp_project("undo_branch_test");
    let path = project_path(&dir, "undo_branch_test");

    let dummy_file = dir.path().join("undo_branch_clip.mp4");
    std::fs::write(&dummy_file, b"dummy video").unwrap();
    let import = run_cli_ok(&[
        "asset",
        "import",
        "--path",
        &path,
        "--file",
        dummy_file.to_str().unwrap(),
    ]);
    let asset_id = import["createdIds"][0].as_str().unwrap().to_string();

    let tracks = run_cli_ok(&["timeline", "tracks", "--path", &path]);
    let track_id = tracks["tracks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|track| track["kind"] == "Video")
        .and_then(|track| track["id"].as_str())
        .unwrap()
        .to_string();

    run_cli_ok(&[
        "timeline", "insert", "--path", &path, "--asset", &asset_id, "--track", &track_id, "--at",
        "0.0",
    ]);
    run_cli_ok(&["timeline", "undo", "--path", &path]);
    run_cli_ok(&[
        "timeline", "insert", "--path", &path, "--asset", &asset_id, "--track", &track_id, "--at",
        "1.0",
    ]);

    let (_stdout, stderr) = run_cli_err(&["timeline", "redo", "--path", &path]);
    assert!(
        stderr.contains("Redo failed") || stderr.contains("Nothing to redo"),
        "Expected redo branch to be cleared, got: {}",
        stderr
    );

    let clips = run_cli_ok(&["timeline", "clips", "--path", &path]);
    assert_eq!(clips["count"], 1);
    assert_eq!(clips["clips"][0]["timelineInSec"], 1.0);
}

#[test]
fn test_timeline_undo_without_history_should_fail() {
    let dir = create_temp_project("undo_empty_test");
    let path = project_path(&dir, "undo_empty_test");

    let (_stdout, stderr) = run_cli_err(&["timeline", "undo", "--path", &path]);
    assert!(
        stderr.contains("Undo failed") || stderr.contains("Nothing to undo"),
        "Expected undo error, got: {}",
        stderr
    );
}

// =============================================================================
// Text Commands
// =============================================================================

#[test]
fn test_text_add_update_transform_remove_roundtrip() {
    let dir = create_temp_project("text_roundtrip_test");
    let path = project_path(&dir, "text_roundtrip_test");

    let add = run_cli_ok(&[
        "text",
        "add",
        "--path",
        &path,
        "--text",
        "CLI Title",
        "--start",
        "0.5",
        "--duration",
        "2.5",
        "--preset",
        "title",
        "--font-family",
        "Inter",
        "--font-size",
        "64",
        "--font-weight",
        "700",
        "--color",
        "#FFEE00",
        "--x",
        "0.4",
        "--y",
        "0.25",
        "--shadow-json",
        r##"{"color":"#000000AA","offsetX":4,"offsetY":5,"blur":6}"##,
        "--outline-json",
        r##"{"color":"#111111","width":3}"##,
    ]);
    assert_eq!(add["status"], "ok");
    let text_clip_id = add["createdIds"][0].as_str().unwrap().to_string();

    let list = run_cli_ok(&["text", "list", "--path", &path]);
    assert_eq!(list["count"], 1);
    assert_eq!(list["clips"][0]["id"], text_clip_id);
    assert_eq!(list["clips"][0]["textData"]["content"], "CLI Title");
    assert_eq!(list["clips"][0]["textData"]["style"]["fontFamily"], "Inter");
    assert_eq!(list["clips"][0]["textData"]["style"]["fontWeight"], 700);
    assert_eq!(list["clips"][0]["textData"]["position"]["x"], 0.4);
    assert_eq!(list["clips"][0]["textData"]["outline"]["width"], 3);

    let update = run_cli_ok(&[
        "text",
        "update",
        "--path",
        &path,
        "--id",
        &text_clip_id,
        "--text",
        "Updated CLI Title",
        "--start",
        "1.25",
        "--duration",
        "4.5",
        "--font-weight",
        "600",
        "--background-color",
        "#000000CC",
        "--clear-shadow",
    ]);
    assert_eq!(update["status"], "ok");

    let transform = run_cli_ok(&[
        "text",
        "transform",
        "--path",
        &path,
        "--id",
        &text_clip_id,
        "--x",
        "0.65",
        "--y",
        "0.7",
        "--scale-x",
        "1.25",
        "--scale-y",
        "1.1",
        "--rotation",
        "12",
    ]);
    assert_eq!(transform["status"], "ok");

    let updated = run_cli_ok(&["text", "list", "--path", &path]);
    let clip = &updated["clips"][0];
    assert_eq!(clip["textData"]["content"], "Updated CLI Title");
    assert_eq!(clip["startSec"], 1.25);
    assert_eq!(clip["durationSec"], 4.5);
    assert_eq!(clip["textData"]["style"]["fontWeight"], 600);
    assert!(clip["textData"].get("shadow").is_none());
    assert_eq!(clip["transform"]["position"]["x"], 0.65);
    assert_eq!(clip["textData"]["position"]["x"], 0.65);
    assert_eq!(clip["textData"]["position"]["y"], 0.7);
    assert_eq!(clip["transform"]["scale"]["x"], 1.25);
    assert_eq!(clip["transform"]["rotationDeg"], 12.0);

    let restyle = run_cli_ok(&[
        "text",
        "update",
        "--path",
        &path,
        "--id",
        &text_clip_id,
        "--font-size",
        "72",
    ]);
    assert_eq!(restyle["status"], "ok");

    let restyled = run_cli_ok(&["text", "list", "--path", &path]);
    let clip = &restyled["clips"][0];
    assert_eq!(clip["textData"]["style"]["fontSize"], 72);
    assert_eq!(clip["textData"]["position"]["x"], 0.65);
    assert_eq!(clip["textData"]["position"]["y"], 0.7);
    assert_eq!(clip["transform"]["position"]["x"], 0.65);
    assert_eq!(clip["transform"]["position"]["y"], 0.7);
    assert_eq!(clip["transform"]["scale"]["x"], 1.25);
    assert_eq!(clip["transform"]["rotationDeg"], 12.0);

    let remove = run_cli_ok(&["text", "remove", "--path", &path, "--id", &text_clip_id]);
    assert_eq!(remove["status"], "ok");

    let empty = run_cli_ok(&["text", "list", "--path", &path]);
    assert_eq!(empty["count"], 0);
}

// =============================================================================
// Input Validation
// =============================================================================

#[test]
fn test_validation_negative_time() {
    let dir = create_temp_project("val_neg_time");
    let path = project_path(&dir, "val_neg_time");
    // Use --at=-5.0 syntax to pass negative values through clap
    let (_stdout, stderr) = run_cli_err(&[
        "timeline",
        "insert",
        "--path",
        &path,
        "--asset",
        "test",
        "--track",
        "test",
        "--at=-5.0",
    ]);
    assert!(
        stderr.contains("cannot be negative"),
        "Expected negative time error, got: {}",
        stderr
    );
}

#[test]
fn test_validation_zero_speed() {
    let dir = create_temp_project("val_zero_speed");
    let path = project_path(&dir, "val_zero_speed");
    let (_stdout, stderr) = run_cli_err(&[
        "timeline", "speed", "--path", &path, "--clip", "test", "--track", "test", "--speed", "0.0",
    ]);
    assert!(
        stderr.contains("must be positive"),
        "Expected positive speed error, got: {}",
        stderr
    );
}

#[test]
fn test_validation_negative_speed() {
    let dir = create_temp_project("val_neg_speed");
    let path = project_path(&dir, "val_neg_speed");
    let (_stdout, stderr) = run_cli_err(&[
        "timeline",
        "speed",
        "--path",
        &path,
        "--clip",
        "test",
        "--track",
        "test",
        "--speed=-2.0",
    ]);
    assert!(
        stderr.contains("must be positive"),
        "Expected positive speed error, got: {}",
        stderr
    );
}

#[test]
fn test_validation_empty_clip_id() {
    let dir = create_temp_project("val_empty_clip");
    let path = project_path(&dir, "val_empty_clip");
    let (_stdout, stderr) = run_cli_err(&[
        "timeline", "remove", "--path", &path, "--clip", "", "--track", "test",
    ]);
    assert!(
        stderr.contains("cannot be empty"),
        "Expected empty string error, got: {}",
        stderr
    );
}

#[test]
fn test_validation_trim_inverted_range() {
    let dir = create_temp_project("val_trim_range");
    let path = project_path(&dir, "val_trim_range");
    // --in is the clap arg name (name = "in"), invoked as --in=10.0
    let (_stdout, stderr) = run_cli_err(&[
        "timeline",
        "trim",
        "--path",
        &path,
        "--clip",
        "test",
        "--track",
        "test",
        "--source-in",
        "10.0",
        "--source-out",
        "5.0",
    ]);
    assert!(
        stderr.contains("must be less than"),
        "Expected inverted range error, got: {}",
        stderr
    );
}

#[test]
fn test_validation_caption_inverted_range() {
    let dir = create_temp_project("val_caption_range");
    let path = project_path(&dir, "val_caption_range");
    let (_stdout, stderr) = run_cli_err(&[
        "caption", "add", "--path", &path, "--track", "test", "--text", "Hello", "--start", "10.0",
        "--end", "5.0",
    ]);
    assert!(
        stderr.contains("must be less than"),
        "Expected inverted range error, got: {}",
        stderr
    );
}

// =============================================================================
// Render Commands
// =============================================================================

#[test]
fn test_render_presets() {
    let result = run_cli_ok(&["render", "presets"]);
    let presets = result["presets"].as_array().unwrap();
    assert_eq!(presets.len(), 7);
    // Verify first preset structure
    assert_eq!(presets[0]["id"], "mp4_h264_1080p");
    let ids: Vec<&str> = presets
        .iter()
        .filter_map(|preset| preset["id"].as_str())
        .collect();
    assert!(
        ids.contains(&"proxy_480p") && ids.contains(&"mp4_draft"),
        "expected proxy and draft presets, got: {ids:?}"
    );
}

#[test]
fn test_render_start_validates_sequence_before_initializing_ffmpeg() {
    let dir = create_temp_project("render_test");
    let path = project_path(&dir, "render_test");
    let (_stdout, stderr) = run_cli_err(&[
        "render",
        "start",
        "--path",
        &path,
        "--output",
        "/tmp/output.mp4",
    ]);
    assert!(
        stderr.contains("Render validation failed")
            && stderr.contains("Sequence has no clips to export"),
        "Expected render validation error, got: {}",
        stderr
    );
}

#[test]
fn test_render_start_invalid_preset() {
    let dir = create_temp_project("render_preset_err");
    let path = project_path(&dir, "render_preset_err");
    let (_stdout, stderr) = run_cli_err(&[
        "render",
        "start",
        "--path",
        &path,
        "--output",
        "/tmp/output.mp4",
        "--preset",
        "invalid_preset",
    ]);
    assert!(
        stderr.contains("Unknown preset"),
        "Expected unknown preset error, got: {}",
        stderr
    );
}

#[test]
fn test_ffmpeg_info_reports_resolved_binaries() {
    if system_ffmpeg_path().is_none() {
        return;
    }

    let result = run_cli_ok(&["ffmpeg", "info"]);

    assert_eq!(result["status"], "ok");
    assert!(
        !result["ffmpegPath"].as_str().unwrap_or_default().is_empty(),
        "Expected a resolved ffmpeg path, got: {}",
        result
    );
    assert!(
        !result["ffprobePath"]
            .as_str()
            .unwrap_or_default()
            .is_empty(),
        "Expected a resolved ffprobe path, got: {}",
        result
    );
    let source = result["source"].as_str().unwrap_or_default();
    assert!(
        ["explicit", "env", "bundled", "managed", "dev", "system"].contains(&source),
        "Unexpected ffmpeg source: {}",
        source
    );
}

#[test]
fn test_render_start_exports_video_when_ffmpeg_is_available() {
    if system_ffmpeg_path().is_none() {
        return;
    }

    let dir = create_temp_project("render_export_test");
    let path = project_path(&dir, "render_export_test");

    let source_path = dir.path().join("render_source.mp4");
    if !create_sample_video(&source_path) {
        return;
    }

    let import = run_cli_ok(&[
        "asset",
        "import",
        "--path",
        &path,
        "--file",
        source_path.to_str().unwrap(),
    ]);
    let asset_id = import["createdIds"][0].as_str().unwrap().to_string();

    let tracks = run_cli_ok(&["timeline", "tracks", "--path", &path]);
    let track_id = tracks["tracks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|track| track["kind"] == "Video")
        .and_then(|track| track["id"].as_str())
        .unwrap()
        .to_string();

    run_cli_ok(&[
        "timeline", "insert", "--path", &path, "--asset", &asset_id, "--track", &track_id, "--at",
        "0.0",
    ]);

    let output_path = dir.path().join("rendered-output.mp4");
    let result = run_cli_ok(&[
        "render",
        "start",
        "--path",
        &path,
        "--output",
        output_path.to_str().unwrap(),
    ]);

    assert_eq!(result["status"], "ok");
    assert_eq!(
        result["sequenceId"],
        run_cli_ok(&["project", "info", "--path", &path])["activeSequenceId"]
    );
    assert!(output_path.exists(), "Expected rendered output to exist");
    assert!(
        output_path.metadata().unwrap().len() > 0,
        "Expected rendered output to be non-empty"
    );
}

#[test]
fn test_render_start_rejects_proxy_combined_with_preset() {
    let dir = create_temp_project("render_proxy_conflict");
    let path = project_path(&dir, "render_proxy_conflict");
    let (_stdout, stderr) = run_cli_err(&[
        "render",
        "start",
        "--path",
        &path,
        "--output",
        "proxy.mp4",
        "--proxy",
        "--preset",
        "mp4_h264_1080p",
    ]);
    assert!(
        stderr.contains("cannot be used with"),
        "Expected a clap conflict error, got: {}",
        stderr
    );
}

#[test]
fn test_render_start_rejects_inverted_range() {
    let dir = create_temp_project("render_range_err");
    let path = project_path(&dir, "render_range_err");
    let (_stdout, stderr) = run_cli_err(&[
        "render", "start", "--path", &path, "--output", "out.mp4", "--start", "5", "--end", "1",
    ]);
    assert!(
        stderr.contains("Invalid time range"),
        "Expected a range validation error, got: {}",
        stderr
    );
}

#[test]
fn test_render_start_proxy_renders_480p_range_with_progress() {
    if system_ffmpeg_path().is_none() {
        return;
    }

    let dir = create_temp_project("render_proxy_test");
    let path = project_path(&dir, "render_proxy_test");

    let source_path = dir.path().join("proxy_source.mp4");
    if !create_sample_video_with_duration(&source_path, 2) {
        return;
    }

    let import = run_cli_ok(&[
        "asset",
        "import",
        "--path",
        &path,
        "--file",
        source_path.to_str().unwrap(),
    ]);
    let asset_id = import["createdIds"][0].as_str().unwrap().to_string();

    let tracks = run_cli_ok(&["timeline", "tracks", "--path", &path]);
    let track_id = tracks["tracks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|track| track["kind"] == "Video")
        .and_then(|track| track["id"].as_str())
        .unwrap()
        .to_string();

    run_cli_ok(&[
        "timeline", "insert", "--path", &path, "--asset", &asset_id, "--track", &track_id, "--at",
        "0.0",
    ]);

    let output_path = dir.path().join("proxy-output.mp4");
    let (stdout, stderr, success) = run_cli(&[
        "render",
        "start",
        "--path",
        &path,
        "--proxy",
        "--start",
        "0",
        "--end",
        "1",
        "--progress",
        "--output",
        output_path.to_str().unwrap(),
    ]);
    assert!(
        success,
        "Proxy render failed.\nstdout: {stdout}\nstderr: {stderr}"
    );

    let result: serde_json::Value = serde_json::from_str(&stdout)
        .unwrap_or_else(|error| panic!("Failed to parse proxy render output: {error}\n{stdout}"));
    assert_eq!(result["status"], "ok");
    assert_eq!(result["preset"], "proxy_480p");

    assert!(output_path.exists(), "Expected proxy output to exist");
    assert!(
        output_path.metadata().unwrap().len() > 0,
        "Expected proxy output to be non-empty"
    );

    // Progress must be NDJSON on stderr so stdout stays a single JSON object.
    let progress_lines: Vec<serde_json::Value> = stderr
        .lines()
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line.trim()).ok())
        .filter(|value| value["type"] == "progress")
        .collect();
    assert!(
        !progress_lines.is_empty(),
        "Expected NDJSON progress on stderr, got: {stderr}"
    );
    assert!(
        progress_lines
            .iter()
            .all(|line| line["percent"].is_number() && line["totalFrames"].is_number()),
        "Expected progress lines to carry percent and totalFrames, got: {progress_lines:?}"
    );

    if let Some(height) = ffprobe_video_height(&output_path) {
        assert_eq!(height, 480, "Expected a 480p proxy, got height {height}");
    }

    if let Some(duration) = ffprobe_duration_secs(&output_path) {
        assert!(
            (duration - 1.0).abs() < 0.35,
            "Expected proxy output duration near 1s, got {duration}"
        );
    }
}

// =============================================================================
// Frame Commands
// =============================================================================

/// Creates a project with `sample.mp4` imported and inserted on a video track.
///
/// Returns `None` when FFmpeg cannot produce the sample so callers can skip.
fn create_project_with_timeline_clip(
    name: &str,
    duration_secs: u32,
) -> Option<(tempfile::TempDir, String, String)> {
    system_ffmpeg_path()?;

    let dir = create_temp_project(name);
    let path = project_path(&dir, name);

    let source_path = dir.path().join("frame_source.mp4");
    if !create_sample_video_with_duration(&source_path, duration_secs) {
        return None;
    }

    let import = run_cli_ok(&[
        "asset",
        "import",
        "--path",
        &path,
        "--file",
        source_path.to_str().unwrap(),
    ]);
    let asset_id = import["createdIds"][0].as_str().unwrap().to_string();

    let tracks = run_cli_ok(&["timeline", "tracks", "--path", &path]);
    let track_id = tracks["tracks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|track| track["kind"] == "Video")
        .and_then(|track| track["id"].as_str())
        .unwrap()
        .to_string();

    run_cli_ok(&[
        "timeline", "insert", "--path", &path, "--asset", &asset_id, "--track", &track_id, "--at",
        "0.0",
    ]);

    Some((dir, path, asset_id))
}

#[test]
fn test_frame_extract_writes_still_from_asset_source_time() {
    let Some((dir, path, asset_id)) = create_project_with_timeline_clip("frame_asset_test", 4)
    else {
        return;
    };

    let output_path = dir.path().join("asset_frame.png");
    let result = run_cli_ok(&[
        "frame",
        "extract",
        "--path",
        &path,
        "--asset",
        &asset_id,
        "--source-time",
        "1.0",
        "--out",
        output_path.to_str().unwrap(),
    ]);

    assert_eq!(result["status"], "ok");
    assert_eq!(result["mode"], "asset");
    assert_eq!(result["count"], 1);
    assert_eq!(result["frames"][0]["assetId"], asset_id.as_str());
    assert_eq!(result["frames"][0]["sourceTimeSec"], 1.0);
    assert!(output_path.exists(), "Expected extracted frame to exist");
    assert!(
        output_path.metadata().unwrap().len() > 0,
        "Expected extracted frame to be non-empty"
    );
}

#[test]
fn test_frame_extract_writes_still_from_timeline_time() {
    let Some((dir, path, asset_id)) = create_project_with_timeline_clip("frame_timeline_test", 4)
    else {
        return;
    };

    let output_path = dir.path().join("timeline_frame.png");
    let result = run_cli_ok(&[
        "frame",
        "extract",
        "--path",
        &path,
        "--time",
        "1.5",
        "--out",
        output_path.to_str().unwrap(),
    ]);

    assert_eq!(result["status"], "ok");
    assert_eq!(result["mode"], "fast");
    assert_eq!(result["count"], 1);
    assert_eq!(result["frames"][0]["timeSec"], 1.5);
    assert_eq!(result["frames"][0]["assetId"], asset_id.as_str());
    assert!(result["frames"][0]["clipId"].is_string());
    assert!(result["frames"][0]["width"].as_u64().unwrap() > 0);
    assert!(output_path.exists(), "Expected extracted frame to exist");
    assert!(
        output_path.metadata().unwrap().len() > 0,
        "Expected extracted frame to be non-empty"
    );
}

#[test]
fn test_frame_extract_writes_one_file_per_requested_time() {
    let Some((dir, path, _)) = create_project_with_timeline_clip("frame_batch_test", 4) else {
        return;
    };

    let output_dir = dir.path().join("stills");
    let result = run_cli_ok(&[
        "frame",
        "extract",
        "--path",
        &path,
        "--times",
        "0.5,1.5,2.5",
        "--out",
        output_dir.to_str().unwrap(),
    ]);

    assert_eq!(result["status"], "ok");
    assert_eq!(result["count"], 3);

    let frames = result["frames"].as_array().unwrap();
    assert_eq!(frames.len(), 3);
    for frame in frames {
        let frame_path = std::path::Path::new(frame["path"].as_str().unwrap());
        assert!(
            frame_path.exists(),
            "Expected batch frame {} to exist",
            frame_path.display()
        );
        assert!(
            frame_path.metadata().unwrap().len() > 0,
            "Expected batch frame {} to be non-empty",
            frame_path.display()
        );
    }
}

/// Builds a sequence whose only file-backed clip ends well before the
/// timeline does, followed by a gap and then a title card.
///
/// This is the layout that used to make `frame extract` hard-error: the render
/// stopped at the last file-backed clip, so nothing existed to sample at the
/// gap or the title card.
///
/// Returns `(dir, project_path, gap_time, title_time)`.
fn create_project_with_trailing_title_card(
    name: &str,
) -> Option<(tempfile::TempDir, String, f64, f64)> {
    let (dir, path, _asset_id) = create_project_with_timeline_clip(name, 4)?;

    let tracks = run_cli_ok(&["timeline", "tracks", "--path", &path]);
    let track_id = tracks["tracks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|track| track["kind"] == "Video")
        .and_then(|track| track["id"].as_str())
        .unwrap()
        .to_string();

    let clips = run_cli_ok(&["timeline", "clips", "--path", &path]);
    let clip_id = clips["clips"][0]["id"].as_str().unwrap().to_string();

    // Keep the clip inside the fixture's real media length so the render has
    // decodable frames for the whole file-backed span.
    run_cli_ok(&[
        "timeline",
        "trim",
        "--path",
        &path,
        "--clip",
        &clip_id,
        "--track",
        &track_id,
        "--source-in",
        "0",
        "--source-out",
        "3",
    ]);

    // Timeline becomes: clip 0-3, gap 3-6, title card 6-8.
    run_cli_ok(&[
        "text",
        "add",
        "--path",
        &path,
        "--text",
        "The End",
        "--start",
        "6",
        "--duration",
        "2",
        "--preset",
        "title",
    ]);

    Some((dir, path, 4.5, 7.0))
}

#[test]
fn test_frame_extract_renders_a_title_card_that_outlives_the_last_file_backed_clip() {
    let Some((dir, path, _gap_time, title_time)) =
        create_project_with_trailing_title_card("frame_title_card_test")
    else {
        return;
    };

    let output_path = dir.path().join("title_frame.png");
    let result = run_cli_ok(&[
        "frame",
        "extract",
        "--path",
        &path,
        "--time",
        &title_time.to_string(),
        "--out",
        output_path.to_str().unwrap(),
    ]);

    assert_eq!(result["status"], "ok");
    assert_eq!(
        result["frames"][0]["fellBackToComposite"], true,
        "No file-backed clip covers a title card, so fast mode must fall back"
    );
    assert!(output_path.exists(), "Expected a frame at the title card");
    assert!(output_path.metadata().unwrap().len() > 0);
}

#[test]
fn test_frame_extract_renders_a_gap_after_the_last_file_backed_clip() {
    let Some((dir, path, gap_time, _title_time)) =
        create_project_with_trailing_title_card("frame_trailing_gap_test")
    else {
        return;
    };

    let output_path = dir.path().join("gap_frame.png");
    let result = run_cli_ok(&[
        "frame",
        "extract",
        "--path",
        &path,
        "--time",
        &gap_time.to_string(),
        "--out",
        output_path.to_str().unwrap(),
    ]);

    // A gap has no picture of its own; a black frame is the correct answer.
    assert_eq!(result["status"], "ok");
    assert_eq!(result["frames"][0]["fellBackToComposite"], true);
    assert!(output_path.exists(), "Expected a frame over the gap");
    assert!(output_path.metadata().unwrap().len() > 0);
}

#[test]
fn test_frame_extract_composite_mode_renders_a_title_card_directly() {
    let Some((dir, path, _gap_time, title_time)) =
        create_project_with_trailing_title_card("frame_composite_title_test")
    else {
        return;
    };

    let output_path = dir.path().join("composite_title.png");
    let result = run_cli_ok(&[
        "frame",
        "extract",
        "--path",
        &path,
        "--time",
        &title_time.to_string(),
        "--mode",
        "composite",
        "--out",
        output_path.to_str().unwrap(),
    ]);

    assert_eq!(result["status"], "ok");
    assert_eq!(result["mode"], "composite");
    assert!(output_path.exists(), "Expected a composited title frame");
    assert!(output_path.metadata().unwrap().len() > 0);
}

#[test]
fn test_render_covers_a_title_card_that_outlives_the_last_file_backed_clip() {
    let Some((dir, path, _gap_time, _title_time)) =
        create_project_with_trailing_title_card("render_title_card_test")
    else {
        return;
    };

    let output_path = dir.path().join("full.mp4");
    let result = run_cli_ok(&[
        "render",
        "start",
        "--path",
        &path,
        "--proxy",
        "--output",
        output_path.to_str().unwrap(),
    ]);

    assert_eq!(result["status"], "ok");
    // The timeline runs to 8s even though the last file-backed clip ends at 3s.
    assert_eq!(result["durationSec"], 8.0);
    assert!(output_path.exists(), "Expected a rendered file");
    assert!(output_path.metadata().unwrap().len() > 0);
}

#[test]
fn test_frame_extract_names_the_sequence_end_when_asked_past_it() {
    let Some((dir, path, _)) = create_project_with_timeline_clip("frame_past_end_test", 4) else {
        return;
    };

    let output_path = dir.path().join("past_end.png");
    let (_stdout, stderr) = run_cli_err(&[
        "frame",
        "extract",
        "--path",
        &path,
        "--time",
        "600",
        "--out",
        output_path.to_str().unwrap(),
    ]);

    assert!(
        stderr.contains("past the end"),
        "Expected an out-of-range message naming the sequence end, got: {stderr}"
    );
    assert!(!output_path.exists());
}

#[test]
fn test_frame_extract_rejects_a_grid_range_wider_than_the_sequence() {
    let Some((dir, path, _)) = create_project_with_timeline_clip("frame_grid_past_end_test", 4)
    else {
        return;
    };

    let sheet_path = dir.path().join("wide_sheet.jpg");
    let (_stdout, stderr) = run_cli_err(&[
        "frame",
        "extract",
        "--path",
        &path,
        "--grid",
        "3x2",
        "--between",
        "0",
        "600",
        "--out",
        sheet_path.to_str().unwrap(),
    ]);

    assert!(
        stderr.contains("--between"),
        "Expected the error to point at the range flag, got: {stderr}"
    );
    assert!(!sheet_path.exists());
}

/// Reads the first bytes of a file so tests can tell PNG from JPEG.
fn file_signature(path: &std::path::Path) -> Vec<u8> {
    let bytes = std::fs::read(path).expect("Failed to read output image");
    bytes.into_iter().take(3).collect()
}

const JPEG_SIGNATURE: [u8; 3] = [0xFF, 0xD8, 0xFF];
const PNG_SIGNATURE: [u8; 3] = [0x89, 0x50, 0x4E];

#[test]
fn test_frame_extract_writes_jpeg_when_the_out_path_names_one() {
    let Some((dir, path, _)) = create_project_with_timeline_clip("frame_jpg_infer_test", 4) else {
        return;
    };

    let output_path = dir.path().join("still.jpg");
    let result = run_cli_ok(&[
        "frame",
        "extract",
        "--path",
        &path,
        "--time",
        "1.0",
        "--out",
        output_path.to_str().unwrap(),
    ]);

    // The requested path is the written path: no silent rewrite to .png.
    assert_eq!(
        result["frames"][0]["path"].as_str().unwrap(),
        output_path.to_string_lossy()
    );
    assert!(output_path.exists(), "Expected the .jpg path to be written");
    assert_eq!(
        file_signature(&output_path),
        JPEG_SIGNATURE,
        "Expected JPEG data behind a .jpg extension"
    );
}

#[test]
fn test_frame_extract_defaults_to_png_without_a_recognised_extension() {
    let Some((dir, path, _)) = create_project_with_timeline_clip("frame_png_default_test", 4)
    else {
        return;
    };

    let requested = dir.path().join("still");
    let result = run_cli_ok(&[
        "frame",
        "extract",
        "--path",
        &path,
        "--time",
        "1.0",
        "--out",
        requested.to_str().unwrap(),
    ]);

    let written = std::path::PathBuf::from(result["frames"][0]["path"].as_str().unwrap());
    assert_eq!(written.extension().unwrap(), "png");
    assert_eq!(file_signature(&written), PNG_SIGNATURE);
}

#[test]
fn test_frame_extract_rejects_a_format_that_contradicts_the_out_extension() {
    let Some((dir, path, _)) = create_project_with_timeline_clip("frame_format_conflict_test", 4)
    else {
        return;
    };

    let output_path = dir.path().join("still.png");
    let (_stdout, stderr) = run_cli_err(&[
        "frame",
        "extract",
        "--path",
        &path,
        "--time",
        "1.0",
        "--out",
        output_path.to_str().unwrap(),
        "--format",
        "jpeg",
    ]);

    assert!(
        stderr.contains("--format"),
        "Expected the error to name the conflicting flag, got: {stderr}"
    );
    assert!(
        !output_path.exists(),
        "A rejected request must not write anything"
    );
}

#[test]
fn test_frame_extract_builds_a_jpeg_contact_sheet_at_the_requested_path() {
    let Some((dir, path, _)) = create_project_with_timeline_clip("frame_sheet_jpg_test", 4) else {
        return;
    };

    // This is the documented contact-sheet form: a .jpg path and no --format.
    let sheet_path = dir.path().join("sheet.jpg");
    let result = run_cli_ok(&[
        "frame",
        "extract",
        "--path",
        &path,
        "--grid",
        "2x2",
        "--between",
        "0",
        "4",
        "--out",
        sheet_path.to_str().unwrap(),
    ]);

    assert_eq!(result["status"], "ok");
    assert_eq!(
        result["sheet"]["path"].as_str().unwrap(),
        sheet_path.to_string_lossy()
    );
    assert!(sheet_path.exists(), "Expected the sheet at the .jpg path");
    assert_eq!(file_signature(&sheet_path), JPEG_SIGNATURE);
}

#[test]
fn test_frame_extract_builds_contact_sheet_for_grid() {
    let Some((dir, path, _)) = create_project_with_timeline_clip("frame_grid_test", 4) else {
        return;
    };

    let sheet_path = dir.path().join("sheet.jpg");
    let result = run_cli_ok(&[
        "frame",
        "extract",
        "--path",
        &path,
        "--grid",
        "2x2",
        "--between",
        "0",
        "4",
        "--format",
        "jpeg",
        "--out",
        sheet_path.to_str().unwrap(),
    ]);

    assert_eq!(result["status"], "ok");
    assert_eq!(result["sheet"]["cols"], 2);
    assert_eq!(result["sheet"]["rows"], 2);

    let cells = result["sheet"]["cells"].as_array().unwrap();
    assert_eq!(cells.len(), 4);
    let times: Vec<f64> = cells
        .iter()
        .map(|cell| cell["timelineSec"].as_f64().unwrap())
        .collect();
    assert!(
        times.windows(2).all(|pair| pair[0] < pair[1]),
        "Expected ascending cell times, got {:?}",
        times
    );
    assert!(times.iter().all(|time| *time > 0.0 && *time < 4.0));

    assert!(sheet_path.exists(), "Expected contact sheet to exist");
    assert!(
        sheet_path.metadata().unwrap().len() > 0,
        "Expected contact sheet to be non-empty"
    );
}

/// Build a project with one clip and render it to a proxy file.
///
/// Returns the project fixture plus the rendered file, which is what the
/// `--file` judging path reads. `None` when FFmpeg is unavailable.
fn create_project_with_rendered_proxy(
    name: &str,
    duration_secs: u32,
) -> Option<(tempfile::TempDir, String, PathBuf)> {
    let (dir, path, _asset_id) = create_project_with_timeline_clip(name, duration_secs)?;

    let proxy_path = dir.path().join("proxy.mp4");
    let result = run_cli_ok(&[
        "render",
        "start",
        "--path",
        &path,
        "--proxy",
        "--output",
        proxy_path.to_str().unwrap(),
    ]);
    assert_eq!(result["status"], "ok");
    if !proxy_path.exists() {
        return None;
    }

    Some((dir, path, proxy_path))
}

#[test]
fn test_frame_extract_reads_a_rendered_file_in_its_own_timebase() {
    let Some((dir, path, proxy_path)) = create_project_with_rendered_proxy("frame_file_test", 4)
    else {
        return;
    };

    let still_path = dir.path().join("judge.png");
    let result = run_cli_ok(&[
        "frame",
        "extract",
        "--path",
        &path,
        "--file",
        proxy_path.to_str().unwrap(),
        "--time",
        "1.0",
        "--out",
        still_path.to_str().unwrap(),
    ]);

    assert_eq!(result["status"], "ok");
    assert_eq!(result["mode"], "file");
    assert_eq!(
        result["source"]["path"].as_str().unwrap(),
        proxy_path.to_string_lossy()
    );
    assert!(result["source"]["durationSec"].as_f64().unwrap() > 0.0);
    assert_eq!(result["frames"][0]["fileSec"], 1.0);
    assert!(
        result["frames"][0]["timeSec"].is_null(),
        "File-mode frames must not claim a timeline time"
    );
    assert!(still_path.exists(), "Expected the still to be written");
    assert_eq!(file_signature(&still_path), PNG_SIGNATURE);
}

#[test]
fn test_frame_extract_sheets_a_rendered_file_without_touching_the_timeline() {
    let Some((dir, path, proxy_path)) =
        create_project_with_rendered_proxy("frame_file_sheet_test", 4)
    else {
        return;
    };

    let sheet_path = dir.path().join("judge_sheet.jpg");
    let result = run_cli_ok(&[
        "frame",
        "extract",
        "--path",
        &path,
        "--file",
        proxy_path.to_str().unwrap(),
        "--grid",
        "3x2",
        "--between",
        "0",
        "3",
        "--label-cells",
        "--out",
        sheet_path.to_str().unwrap(),
    ]);

    assert_eq!(result["status"], "ok");
    assert_eq!(result["mode"], "file");
    assert_eq!(result["sheet"]["cols"], 3);
    assert_eq!(result["sheet"]["rows"], 2);
    assert_eq!(result["sheet"]["labeled"], true);

    let cells = result["sheet"]["cells"].as_array().unwrap();
    assert_eq!(cells.len(), 6);
    assert!(
        cells.iter().all(|cell| cell["fileSec"].is_number()),
        "Sheet cells must map back to file times, got: {cells:?}"
    );
    assert!(
        cells.iter().all(|cell| cell["timelineSec"].is_null()),
        "File-mode cells must not claim a timeline time"
    );
    assert!(sheet_path.exists(), "Expected the sheet to be written");
}

#[test]
fn test_frame_extract_names_the_file_duration_when_asked_past_its_end() {
    let Some((dir, path, proxy_path)) =
        create_project_with_rendered_proxy("frame_file_range_test", 4)
    else {
        return;
    };

    let still_path = dir.path().join("past_end.png");
    let (_stdout, stderr) = run_cli_err(&[
        "frame",
        "extract",
        "--path",
        &path,
        "--file",
        proxy_path.to_str().unwrap(),
        "--time",
        "600",
        "--out",
        still_path.to_str().unwrap(),
    ]);

    assert!(
        stderr.contains("past the end of the video") && stderr.contains("proxy.mp4"),
        "Expected the error to name the file and where its video ends, got: {stderr}"
    );
    let video_end =
        ffprobe_video_duration_secs(&proxy_path).or_else(|| ffprobe_duration_secs(&proxy_path));
    if let Some(video_end) = video_end {
        assert!(
            stderr.contains(&format!("{:.3}s", video_end)),
            "Expected the error to quote the video's end {video_end:.3}s, got: {stderr}"
        );
    }
    assert!(!still_path.exists());
}

/// Builds a file whose audio outlasts its video, the case that makes the
/// container duration a lie about where frames can be found.
fn create_video_with_longer_audio(
    path: &std::path::Path,
    video_secs: u32,
    audio_secs: u32,
) -> bool {
    let Some(ffmpeg_path) = system_ffmpeg_path() else {
        return false;
    };
    let Some(video_encoder) = preferred_video_encoder(&ffmpeg_path) else {
        return false;
    };
    if !ffmpeg_supports_encoder(&ffmpeg_path, "aac") {
        return false;
    }

    let mut command = Command::new(ffmpeg_path);
    command.args([
        "-y",
        "-f",
        "lavfi",
        "-i",
        &format!("color=c=black:s=320x240:r=25:d={video_secs}"),
        "-f",
        "lavfi",
        "-i",
        &format!("sine=frequency=440:sample_rate=44100:duration={audio_secs}"),
        "-c:v",
        video_encoder,
    ]);
    if video_encoder == "libx264" {
        command.args(["-pix_fmt", "yuv420p"]);
    }
    // Deliberately no -shortest: the audio tail is the point of the fixture.
    command.args(["-c:a", "aac"]);

    command
        .arg(path)
        .status()
        .expect("Failed to generate the mixed-duration fixture")
        .success()
}

#[test]
fn test_frame_extract_bounds_a_file_by_its_video_stream_not_its_container() {
    let dir = create_temp_project("frame_file_video_end_test");
    let path = project_path(&dir, "frame_file_video_end_test");

    let mixed_path = dir.path().join("audio_tail.mp4");
    if !create_video_with_longer_audio(&mixed_path, 2, 6) {
        return;
    }
    let Some(container_duration) = ffprobe_duration_secs(&mixed_path) else {
        return;
    };
    let Some(video_duration) = ffprobe_video_duration_secs(&mixed_path) else {
        return;
    };
    if container_duration - video_duration < 1.0 {
        // FFmpeg trimmed the audio tail, so there is nothing to test here.
        return;
    }

    // A time inside the container but past the picture must be refused, and the
    // message must name where the video ends rather than where the file does.
    let still_path = dir.path().join("past_video.png");
    let (_stdout, stderr) = run_cli_err(&[
        "frame",
        "extract",
        "--path",
        &path,
        "--file",
        mixed_path.to_str().unwrap(),
        "--time",
        "4.0",
        "--out",
        still_path.to_str().unwrap(),
    ]);
    assert!(
        stderr.contains("past the end of the video")
            && stderr.contains(&format!("{:.3}s", video_duration)),
        "Expected the error to name the video's end {video_duration:.3}s, got: {stderr}"
    );
    assert!(
        !still_path.exists(),
        "A refused request must not write an image"
    );

    // A sheet sampled across the whole container is refused the same way,
    // rather than tiling black cells the JSON claims timecodes for.
    let sheet_path = dir.path().join("past_video_sheet.jpg");
    let (_stdout, stderr) = run_cli_err(&[
        "frame",
        "extract",
        "--path",
        &path,
        "--file",
        mixed_path.to_str().unwrap(),
        "--grid",
        "2x2",
        "--between",
        "0",
        &format!("{container_duration}"),
        "--out",
        sheet_path.to_str().unwrap(),
    ]);
    assert!(
        stderr.contains("past the end of the video"),
        "Expected the sheet to be refused for the same reason, got: {stderr}"
    );
    assert!(!sheet_path.exists());

    // Inside the picture it still works.
    let good_path = dir.path().join("inside.png");
    let result = run_cli_ok(&[
        "frame",
        "extract",
        "--path",
        &path,
        "--file",
        mixed_path.to_str().unwrap(),
        "--time",
        "1.0",
        "--out",
        good_path.to_str().unwrap(),
    ]);
    assert_eq!(result["status"], "ok");
    assert!(
        (result["source"]["videoDurationSec"].as_f64().unwrap() - video_duration).abs() < 0.2,
        "The payload should report where the picture ends, got: {result}"
    );
    assert!(good_path.exists());
}

#[test]
fn test_frame_extract_from_a_file_ignores_the_project_path() {
    // `--file` is documented as needing no project state. A directory that is
    // not a project at all is the only way to prove the project is never opened.
    let Some((dir, _path, proxy_path)) =
        create_project_with_rendered_proxy("frame_file_no_project_test", 4)
    else {
        return;
    };

    let bare = tempfile::tempdir().expect("bare dir");
    let still_path = dir.path().join("no_project.png");
    let result = run_cli_ok(&[
        "frame",
        "extract",
        "--path",
        bare.path().to_str().unwrap(),
        "--file",
        proxy_path.to_str().unwrap(),
        "--time",
        "1.0",
        "--out",
        still_path.to_str().unwrap(),
    ]);

    assert_eq!(result["mode"], "file");
    assert!(still_path.exists(), "Expected the still to be written");
}

#[test]
fn test_frame_extract_rejects_contact_sheet_flags_without_a_grid() {
    let dir = create_temp_project("frame_cell_flags_without_grid_test");
    let path = project_path(&dir, "frame_cell_flags_without_grid_test");
    let still_path = dir.path().join("still.png");

    // clap waives `requires = "grid"` whenever a present argument conflicts with
    // --grid, which both --time and --asset do, so the rejection has to be ours.
    for selector in [
        vec!["--time", "1.0"],
        vec!["--asset", "A", "--source-time", "1.0"],
    ] {
        let mut args = vec![
            "frame",
            "extract",
            "--path",
            &path,
            "--out",
            still_path.to_str().unwrap(),
        ];
        args.extend(selector);
        args.extend(["--cell-width", "640", "--label-cells"]);

        let (_stdout, stderr) = run_cli_err(&args);
        assert!(
            stderr.contains("--cell-width")
                && stderr.contains("--label-cells")
                && stderr.contains("--grid"),
            "Expected the error to name the ignored flags, got: {stderr}"
        );
        assert!(
            !still_path.exists(),
            "A rejected request must not write anything"
        );
    }
}

#[test]
fn test_frame_extract_rejects_a_file_without_a_video_stream() {
    let dir = create_temp_project("frame_file_no_video_test");
    let path = project_path(&dir, "frame_file_no_video_test");
    if system_ffmpeg_path().is_none() {
        return;
    }

    let audio_path = dir.path().join("audio_only.wav");
    if !create_sample_audio(&audio_path) {
        return;
    }

    let still_path = dir.path().join("still.png");
    let (_stdout, stderr) = run_cli_err(&[
        "frame",
        "extract",
        "--path",
        &path,
        "--file",
        audio_path.to_str().unwrap(),
        "--time",
        "0.5",
        "--out",
        still_path.to_str().unwrap(),
    ]);

    assert!(
        stderr.contains("no video stream"),
        "Expected the error to explain the missing video stream, got: {stderr}"
    );
}

#[test]
fn test_frame_extract_rejects_a_file_combined_with_timeline_sources() {
    let dir = create_temp_project("frame_file_conflict_test");
    let path = project_path(&dir, "frame_file_conflict_test");

    let (_stdout, stderr) = run_cli_err(&[
        "frame",
        "extract",
        "--path",
        &path,
        "--file",
        "render.mp4",
        "--time",
        "1.0",
        "--mode",
        "composite",
        "--out",
        "still.png",
    ]);

    assert!(
        stderr.contains("cannot be used with"),
        "Expected a clap conflict error, got: {stderr}"
    );
}

#[test]
fn test_frame_extract_builds_a_contact_sheet_from_an_explicit_time_list() {
    let Some((dir, path, _)) = create_project_with_timeline_clip("frame_grid_times_test", 4) else {
        return;
    };

    let sheet_path = dir.path().join("cuts.jpg");
    let result = run_cli_ok(&[
        "frame",
        "extract",
        "--path",
        &path,
        "--grid",
        "2x2",
        "--times",
        "3.0,0.5,1.75",
        "--out",
        sheet_path.to_str().unwrap(),
    ]);

    assert_eq!(result["status"], "ok");
    assert_eq!(result["sheet"]["cols"], 2);
    assert_eq!(
        result["sheet"]["rows"], 2,
        "Three cells over two columns fill two rows"
    );

    let cells = result["sheet"]["cells"].as_array().unwrap();
    let placed: Vec<(u64, u64, u64, f64)> = cells
        .iter()
        .map(|cell| {
            (
                cell["index"].as_u64().unwrap(),
                cell["row"].as_u64().unwrap(),
                cell["col"].as_u64().unwrap(),
                cell["timelineSec"].as_f64().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        placed,
        vec![(0, 0, 0, 3.0), (1, 0, 1, 0.5), (2, 1, 0, 1.75)],
        "Listed times must fill the grid in the order given"
    );

    assert!(sheet_path.exists(), "Expected the contact sheet to exist");
}

#[test]
fn test_frame_extract_rejects_a_grid_without_a_time_source() {
    let Some((dir, path, _)) = create_project_with_timeline_clip("frame_grid_source_test", 4)
    else {
        return;
    };

    let sheet_path = dir.path().join("sheet.jpg");
    let (_stdout, stderr) = run_cli_err(&[
        "frame",
        "extract",
        "--path",
        &path,
        "--grid",
        "2x2",
        "--out",
        sheet_path.to_str().unwrap(),
    ]);

    assert!(
        stderr.contains("--between") && stderr.contains("--times"),
        "Expected the error to name both accepted time sources, got: {stderr}"
    );
    assert!(!sheet_path.exists());
}

#[test]
fn test_frame_extract_sizes_contact_sheet_cells_from_the_requested_geometry() {
    let Some((dir, path, _)) = create_project_with_timeline_clip("frame_cell_size_test", 4) else {
        return;
    };

    let default_sheet = dir.path().join("default.jpg");
    let default_result = run_cli_ok(&[
        "frame",
        "extract",
        "--path",
        &path,
        "--grid",
        "2x1",
        "--between",
        "0",
        "4",
        "--out",
        default_sheet.to_str().unwrap(),
    ]);
    assert_eq!(default_result["sheet"]["cellWidth"], 320);
    assert_eq!(default_result["sheet"]["cellHeight"], 180);

    let large_sheet = dir.path().join("large.jpg");
    let large_result = run_cli_ok(&[
        "frame",
        "extract",
        "--path",
        &path,
        "--grid",
        "2x1",
        "--between",
        "0",
        "4",
        "--cell-width",
        "640",
        "--cell-height",
        "360",
        "--out",
        large_sheet.to_str().unwrap(),
    ]);
    assert_eq!(large_result["sheet"]["cellWidth"], 640);
    assert_eq!(large_result["sheet"]["cellHeight"], 360);

    let Some((default_width, default_height)) = ffprobe_image_size(&default_sheet) else {
        return;
    };
    let (large_width, large_height) =
        ffprobe_image_size(&large_sheet).expect("Large sheet must be probeable");

    // The tiler's gutters are a fixed cost, so only the cells themselves grow:
    // two columns gain 320px each and the single row gains 180px.
    assert_eq!(
        (large_width - default_width, large_height - default_height),
        (640, 180),
        "Cell geometry should drive the sheet size, got ({large_width}, {large_height}) against ({default_width}, {default_height})"
    );
}

#[test]
fn test_frame_extract_rejects_a_cell_size_outside_the_supported_range() {
    let Some((dir, path, _)) = create_project_with_timeline_clip("frame_cell_range_test", 4) else {
        return;
    };

    let sheet_path = dir.path().join("sheet.jpg");
    let (_stdout, stderr) = run_cli_err(&[
        "frame",
        "extract",
        "--path",
        &path,
        "--grid",
        "2x1",
        "--between",
        "0",
        "4",
        "--cell-width",
        "32",
        "--out",
        sheet_path.to_str().unwrap(),
    ]);

    assert!(
        stderr.contains("cell-width"),
        "Expected the error to name the rejected flag, got: {stderr}"
    );
    assert!(
        !sheet_path.exists(),
        "A rejected request must not write anything"
    );
}

#[test]
fn test_frame_extract_labels_contact_sheet_cells_on_request() {
    let Some((dir, path, _)) = create_project_with_timeline_clip("frame_label_cells_test", 4)
    else {
        return;
    };

    let sheet_path = dir.path().join("labeled.jpg");
    let result = run_cli_ok(&[
        "frame",
        "extract",
        "--path",
        &path,
        "--grid",
        "2x2",
        "--between",
        "0",
        "4",
        "--label-cells",
        "--out",
        sheet_path.to_str().unwrap(),
    ]);

    assert_eq!(result["status"], "ok");
    assert_eq!(result["sheet"]["labeled"], true);
    assert_eq!(result["sheet"]["cells"].as_array().unwrap().len(), 4);
    assert!(sheet_path.exists(), "Expected the labelled sheet to exist");
    assert_eq!(file_signature(&sheet_path), JPEG_SIGNATURE);

    // Labelling pre-fits every cell, so the sheet keeps the unlabelled layout.
    let plain_path = dir.path().join("plain.jpg");
    run_cli_ok(&[
        "frame",
        "extract",
        "--path",
        &path,
        "--grid",
        "2x2",
        "--between",
        "0",
        "4",
        "--out",
        plain_path.to_str().unwrap(),
    ]);

    // The pixels must actually differ. Both sheets are tiled from the same
    // times through the same encoder, so identical bytes mean nothing was burnt
    // in — which is exactly what every other assertion here survives.
    assert_ne!(
        std::fs::read(&sheet_path).unwrap(),
        std::fs::read(&plain_path).unwrap(),
        "--label-cells must change the pixels, not just the reported flag"
    );

    let (Some(labeled), Some(plain)) = (
        ffprobe_image_size(&sheet_path),
        ffprobe_image_size(&plain_path),
    ) else {
        return;
    };
    assert_eq!(labeled, plain);
}

#[test]
fn test_frame_extract_derives_the_other_cell_dimension_at_sixteen_by_nine() {
    let Some((dir, path, _)) = create_project_with_timeline_clip("frame_cell_aspect_test", 4)
    else {
        return;
    };

    // A 640x180 cell would fit a 16:9 frame by height and pad the rest black,
    // so one dimension on its own has to bring the other with it.
    let sheet_path = dir.path().join("wide_cells.jpg");
    let result = run_cli_ok(&[
        "frame",
        "extract",
        "--path",
        &path,
        "--grid",
        "2x1",
        "--between",
        "0",
        "4",
        "--cell-width",
        "640",
        "--out",
        sheet_path.to_str().unwrap(),
    ]);

    assert_eq!(result["sheet"]["cellWidth"], 640);
    assert_eq!(
        result["sheet"]["cellHeight"], 360,
        "A width on its own must derive a 16:9 height, got: {result}"
    );

    // Both flags together stay exactly as asked, including a non-16:9 cell.
    let explicit_path = dir.path().join("explicit_cells.jpg");
    let explicit = run_cli_ok(&[
        "frame",
        "extract",
        "--path",
        &path,
        "--grid",
        "2x1",
        "--between",
        "0",
        "4",
        "--cell-width",
        "640",
        "--cell-height",
        "180",
        "--out",
        explicit_path.to_str().unwrap(),
    ]);
    assert_eq!(explicit["sheet"]["cellWidth"], 640);
    assert_eq!(explicit["sheet"]["cellHeight"], 180);
}

// =============================================================================
// Plan Commands
// =============================================================================

/// Both spellings of the template flag must work.
///
/// `--type` is what the docs and `help-json` have always advertised;
/// `--template-type` is what the binary actually accepted, so it stays a hidden
/// alias rather than breaking callers that learned the real flag.
#[test]
fn test_plan_template_split_and_move() {
    for flag in ["--type", "--template-type"] {
        let result = run_cli_ok(&["plan", "template", flag, "split-and-move"]);
        assert_eq!(result["id"], "plan_001", "flag {flag}");
        let steps = result["steps"].as_array().unwrap();
        assert_eq!(steps.len(), 2);
        assert_eq!(steps[0]["commandType"], "SplitClip");
        assert_eq!(steps[1]["commandType"], "MoveClip");
    }
}

#[test]
fn test_plan_template_multi_trim() {
    for flag in ["--type", "--template-type"] {
        let result = run_cli_ok(&["plan", "template", flag, "multi-trim"]);
        assert_eq!(result["id"], "plan_002", "flag {flag}");
    }
}

#[test]
fn test_plan_template_invalid() {
    for flag in ["--type", "--template-type"] {
        let (_stdout, stderr) = run_cli_err(&["plan", "template", flag, "nonexistent"]);
        assert!(
            stderr.contains("Unknown template type"),
            "Expected template type error for {flag}, got: {stderr}"
        );
    }
}

#[test]
fn test_plan_validate_valid() {
    let dir = create_temp_project("plan_validate_test");
    let path = project_path(&dir, "plan_validate_test");

    // Write a valid plan file
    let plan = serde_json::json!({
        "id": "test_plan",
        "steps": [
            {
                "id": "step_1",
                "commandType": "AddTrack",
                "payload": { "sequenceId": "seq_1", "name": "New Track", "kind": "video" },
                "dependsOn": []
            }
        ]
    });
    let plan_file = dir.path().join("plan.json");
    std::fs::write(&plan_file, serde_json::to_string(&plan).unwrap()).unwrap();

    let result = run_cli_ok(&[
        "plan",
        "validate",
        "--path",
        &path,
        "--file",
        plan_file.to_str().unwrap(),
    ]);
    assert_eq!(result["status"], "ok");
    assert_eq!(result["stepCount"], 1);
}

#[test]
fn test_plan_validate_cycle() {
    let dir = create_temp_project("plan_cycle_test");
    let path = project_path(&dir, "plan_cycle_test");

    // Write a plan with a cycle
    let plan = serde_json::json!({
        "id": "cycle_plan",
        "steps": [
            {
                "id": "step_a",
                "commandType": "AddTrack",
                "payload": {},
                "dependsOn": ["step_b"]
            },
            {
                "id": "step_b",
                "commandType": "AddTrack",
                "payload": {},
                "dependsOn": ["step_a"]
            }
        ]
    });
    let plan_file = dir.path().join("cycle_plan.json");
    std::fs::write(&plan_file, serde_json::to_string(&plan).unwrap()).unwrap();

    let result = run_cli_ok(&[
        "plan",
        "validate",
        "--path",
        &path,
        "--file",
        plan_file.to_str().unwrap(),
    ]);
    assert_eq!(result["status"], "error");
    assert!(result["errors"]
        .as_array()
        .unwrap()
        .iter()
        .any(|e| e.as_str().unwrap().contains("Cycle")));
}

/// Writes a plan file and returns its path.
fn write_plan(dir: &tempfile::TempDir, name: &str, plan: serde_json::Value) -> String {
    let plan_file = dir.path().join(name);
    std::fs::write(&plan_file, plan.to_string()).unwrap();
    plan_file.to_string_lossy().to_string()
}

/// One `AddTrack` step, the cheapest step that actually mutates the project.
fn add_track_step(id: &str, sequence_id: &str, name: &str) -> serde_json::Value {
    serde_json::json!({
        "id": id,
        "commandType": "AddTrack",
        "payload": { "sequenceId": sequence_id, "name": name, "kind": "video" },
        "dependsOn": []
    })
}

fn track_names(path: &str) -> Vec<String> {
    run_cli_ok(&["timeline", "tracks", "--path", path])["tracks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|track| track["name"].as_str().unwrap().to_string())
        .collect()
}

fn active_sequence(path: &str) -> String {
    run_cli_ok(&["project", "info", "--path", path])["activeSequenceId"]
        .as_str()
        .unwrap()
        .to_string()
}

/// Reads the persisted snapshot, the cache only a completed save advances.
///
/// A reopen alone cannot tell a saved plan from an unsaved one — replaying the
/// append-only ops log rebuilds the same state either way, which is exactly the
/// trap `appliedNotSaved` exists to report. The snapshot is where the two
/// outcomes differ.
fn persisted_snapshot(path: &str) -> serde_json::Value {
    let snapshot_path = std::path::Path::new(path)
        .join(".openreelio")
        .join("state")
        .join("snapshot.json");
    serde_json::from_str(&std::fs::read_to_string(&snapshot_path).unwrap()).unwrap()
}

/// A plan that applies cleanly exits 0, reaches the snapshot, and survives a reopen.
#[test]
fn test_plan_execute_applies_and_persists() {
    let dir = create_temp_project("plan_execute_ok");
    let path = project_path(&dir, "plan_execute_ok");
    let sequence_id = active_sequence(&path);

    let plan_file = write_plan(
        &dir,
        "ok.json",
        serde_json::json!({
            "id": "ok_plan",
            "steps": [add_track_step("step_1", &sequence_id, "KEPT")]
        }),
    );

    let (stdout, stderr, code) =
        run_cli_exit(&["plan", "execute", "--path", &path, "--file", &plan_file]);
    assert_eq!(code, 0, "a clean plan must exit 0.\nstderr: {stderr}");
    let result: serde_json::Value = serde_json::from_str(&stdout).unwrap();
    assert_eq!(result["status"], "ok");
    assert_eq!(result["stepsExecuted"], 1);

    // Exit 0 promises applied *and saved*. Without this, an
    // applied-but-not-saved run would satisfy the reopen assertion below just
    // as well, and the exit code would be asserting nothing.
    let applied_op_id = result["stepResults"][0]["opId"].as_str().unwrap();
    assert_eq!(
        persisted_snapshot(&path)["lastOpId"],
        applied_op_id,
        "exit 0 must mean the plan reached the snapshot, not only the ops log"
    );

    // A separate process, so this reads the project back off disk.
    assert!(track_names(&path).contains(&"KEPT".to_string()));
}

/// A step that only fails once it runs must leave nothing behind.
///
/// This is the regression that mattered: `CommandExecutor::execute` fsyncs an
/// op before it returns and `undo` only unwinds memory, so skipping the save
/// was not enough — the next open folded the applied ops back in as new user
/// edits and the rollback reverted itself.
///
/// The contract asserted here is the reopened state, not the bytes on disk:
/// the ops log is append-only by design, so a rolled-back plan necessarily
/// leaves its ops in the file and records them as discarded in the manifest.
#[test]
fn test_plan_execute_rolls_back_a_failed_step_durably() {
    let dir = create_temp_project("plan_execute_rollback");
    let path = project_path(&dir, "plan_execute_rollback");
    let sequence_id = active_sequence(&path);
    let before = track_names(&path);

    // Step 2 parses fine and only fails against real project state, so the
    // failure lands mid-execution — after step 1 is already durable.
    let plan_file = write_plan(
        &dir,
        "rollback.json",
        serde_json::json!({
            "id": "rollback_plan",
            "steps": [
                add_track_step("step_1", &sequence_id, "SHOULD NOT SURVIVE"),
                {
                    "id": "step_2",
                    "commandType": "SplitClip",
                    "payload": {
                        "sequenceId": sequence_id,
                        "trackId": "no-such-track",
                        "clipId": "no-such-clip",
                        "splitTime": 1.0
                    },
                    "dependsOn": ["step_1"]
                }
            ]
        }),
    );

    let (stdout, stderr, code) =
        run_cli_exit(&["plan", "execute", "--path", &path, "--file", &plan_file]);
    assert_eq!(
        code, 1,
        "a failed step that rolled back cleanly is exit 1.\nstdout: {stdout}\nstderr: {stderr}"
    );

    let result: serde_json::Value = serde_json::from_str(&stdout).unwrap();
    assert_eq!(result["status"], "error");
    assert_eq!(result["failedStep"], "step_2");
    assert_eq!(result["rolledBack"], 1);
    assert_eq!(result["rollbackIncomplete"], false);
    assert!(result["error"].as_str().unwrap().contains("SplitClip"));

    assert_eq!(
        track_names(&path),
        before,
        "the rolled-back track must not come back when the project is reopened"
    );
}

/// A cycle is caught before anything is applied, not by the sort mid-flight.
#[test]
fn test_plan_execute_rejects_a_cycle_without_mutating() {
    let dir = create_temp_project("plan_execute_cycle");
    let path = project_path(&dir, "plan_execute_cycle");
    let sequence_id = active_sequence(&path);
    let before = track_names(&path);

    let plan_file = write_plan(
        &dir,
        "cycle.json",
        serde_json::json!({
            "id": "cycle_plan",
            "steps": [
                {
                    "id": "step_a",
                    "commandType": "AddTrack",
                    "payload": { "sequenceId": sequence_id, "name": "A", "kind": "video" },
                    "dependsOn": ["step_b"]
                },
                {
                    "id": "step_b",
                    "commandType": "AddTrack",
                    "payload": { "sequenceId": sequence_id, "name": "B", "kind": "video" },
                    "dependsOn": ["step_a"]
                }
            ]
        }),
    );

    let (stdout, _stderr, code) =
        run_cli_exit(&["plan", "execute", "--path", &path, "--file", &plan_file]);
    assert_eq!(code, 1, "an invalid plan is exit 1: {stdout}");

    let result: serde_json::Value = serde_json::from_str(&stdout).unwrap();
    assert_eq!(result["status"], "error");
    assert!(result["errors"]
        .as_array()
        .unwrap()
        .iter()
        .any(|error| error.as_str().unwrap().contains("Cycle detected")));

    assert_eq!(track_names(&path), before);
}

/// An unparseable payload is caught up front, so the earlier steps never run.
#[test]
fn test_plan_execute_validates_every_payload_before_mutating() {
    let dir = create_temp_project("plan_execute_prevalidate");
    let path = project_path(&dir, "plan_execute_prevalidate");
    let sequence_id = active_sequence(&path);
    let before = track_names(&path);

    let plan_file = write_plan(
        &dir,
        "bad-payload.json",
        serde_json::json!({
            "id": "bad_payload_plan",
            "steps": [
                add_track_step("step_1", &sequence_id, "MUST NEVER BE CREATED"),
                {
                    "id": "step_2",
                    "commandType": "AddTrack",
                    "payload": { "sequenceId": sequence_id, "name": "X", "kind": "not-a-kind" },
                    "dependsOn": ["step_1"]
                }
            ]
        }),
    );

    let (stdout, _stderr, code) =
        run_cli_exit(&["plan", "execute", "--path", &path, "--file", &plan_file]);
    assert_eq!(code, 1, "{stdout}");

    let result: serde_json::Value = serde_json::from_str(&stdout).unwrap();
    assert_eq!(result["message"], "Plan validation failed");
    assert!(result["errors"]
        .as_array()
        .unwrap()
        .iter()
        .any(|error| error.as_str().unwrap().contains("step_2")));

    assert_eq!(
        track_names(&path),
        before,
        "step_1 must never run when a later step cannot parse"
    );
}

/// The step cap is a backstop against runaway generation.
#[test]
fn test_plan_execute_and_validate_reject_an_over_cap_plan() {
    let dir = create_temp_project("plan_step_cap");
    let path = project_path(&dir, "plan_step_cap");
    let sequence_id = active_sequence(&path);
    let before = track_names(&path);

    let steps: Vec<serde_json::Value> = (0..1001)
        .map(|index| add_track_step(&format!("step_{index}"), &sequence_id, "T"))
        .collect();
    let plan_file = write_plan(
        &dir,
        "over-cap.json",
        serde_json::json!({ "id": "over_cap_plan", "steps": steps }),
    );

    let cap_error = |result: &serde_json::Value| {
        result["errors"].as_array().unwrap().iter().any(|error| {
            let error = error.as_str().unwrap();
            error.contains("1001 steps") && error.contains("1000")
        })
    };

    let validated = run_cli_ok(&["plan", "validate", "--path", &path, "--file", &plan_file]);
    assert_eq!(validated["status"], "error");
    assert!(cap_error(&validated), "{validated}");

    let (stdout, _stderr, code) =
        run_cli_exit(&["plan", "execute", "--path", &path, "--file", &plan_file]);
    assert_eq!(code, 1, "{stdout}");
    assert!(cap_error(&serde_json::from_str(&stdout).unwrap()));

    assert_eq!(track_names(&path), before);
}

/// A plan file the tool cannot even read is a tool failure, not a bad plan.
#[test]
fn test_plan_execute_reports_an_unreadable_plan_as_a_tool_failure() {
    let dir = create_temp_project("plan_missing_file");
    let path = project_path(&dir, "plan_missing_file");
    let missing = dir.path().join("does-not-exist.json");

    let (_stdout, stderr, code) = run_cli_exit(&[
        "plan",
        "execute",
        "--path",
        &path,
        "--file",
        missing.to_str().unwrap(),
    ]);

    assert_eq!(code, 2, "the tool could not run: {stderr}");
    assert!(stderr.contains("Failed to read plan file"), "{stderr}");
}

// =============================================================================
// State Commands
// =============================================================================

#[test]
fn test_state_dump() {
    let dir = create_temp_project("state_dump_test");
    let path = project_path(&dir, "state_dump_test");
    let result = run_cli_ok(&["state", "dump", "--path", &path]);
    assert!(result["project"]["name"].is_string());
    assert!(result["sequences"].is_array());
}

#[test]
fn test_state_ops() {
    let dir = create_temp_project("state_ops_test");
    let path = project_path(&dir, "state_ops_test");
    let result = run_cli_ok(&["state", "ops", "--path", &path]);
    assert!(result["ops"].is_array());
    assert!(result["totalOps"].is_number());
}

#[test]
fn test_state_snapshot() {
    let dir = create_temp_project("state_snapshot_test");
    let path = project_path(&dir, "state_snapshot_test");
    let result = run_cli_ok(&["state", "snapshot", "--path", &path]);
    assert_eq!(result["status"], "ok");
}

/// Build a project with `clip_count` clips inserted at one-second spacing.
///
/// Needs no FFmpeg: the asset never gets decoded, only referenced.
fn create_project_with_edit_history(name: &str, clip_count: usize) -> (tempfile::TempDir, String) {
    let dir = create_temp_project(name);
    let path = project_path(&dir, name);

    let dummy_file = dir.path().join("history_clip.mp4");
    std::fs::write(&dummy_file, b"dummy video").unwrap();
    let import = run_cli_ok(&[
        "asset",
        "import",
        "--path",
        &path,
        "--file",
        dummy_file.to_str().unwrap(),
    ]);
    let asset_id = import["createdIds"][0].as_str().unwrap().to_string();

    let tracks = run_cli_ok(&["timeline", "tracks", "--path", &path]);
    let track_id = tracks["tracks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|track| track["kind"] == "Video")
        .and_then(|track| track["id"].as_str())
        .unwrap()
        .to_string();

    for index in 0..clip_count {
        run_cli_ok(&[
            "timeline",
            "insert",
            "--path",
            &path,
            "--asset",
            &asset_id,
            "--track",
            &track_id,
            "--at",
            &format!("{}.0", index * 10),
        ]);
    }

    (dir, path)
}

#[test]
fn test_state_history_lists_operations_with_the_current_position() {
    let (_dir, path) = create_project_with_edit_history("state_history_test", 3);

    let result = run_cli_ok(&["state", "history", "--path", &path]);

    assert_eq!(result["status"], "ok");
    let applied_count = result["appliedCount"].as_u64().unwrap();
    assert!(
        applied_count >= 4,
        "Expected the import plus three inserts, got {applied_count}"
    );
    assert_eq!(result["redoCount"], 0);
    assert_eq!(result["discardedCount"], 0);
    assert_eq!(
        result["currentIndex"].as_i64().unwrap(),
        applied_count as i64 - 1,
        "A project with nothing undone sits at its last applied entry"
    );

    let entries = result["entries"].as_array().unwrap();
    assert_eq!(entries.len() as u64, applied_count);
    assert!(
        entries.iter().enumerate().all(|(position, entry)| {
            entry["index"] == position
                && entry["opId"].as_str().is_some_and(|id| !id.is_empty())
                && entry["commandType"]
                    .as_str()
                    .is_some_and(|kind| !kind.is_empty())
                && entry["timestamp"]
                    .as_str()
                    .is_some_and(|stamp| !stamp.is_empty())
        }),
        "Entries should be indexed and describe their op, got: {entries:?}"
    );
    assert_eq!(
        entries[0]["commandType"], "ImportAsset",
        "History should start at the first undoable edit, got: {entries:?}"
    );

    // --last trims the window without changing the reported totals, and it
    // keeps the *most recent* entries: a window that kept the oldest N would
    // have the same length and point an agent at the start of the project.
    let trimmed = run_cli_ok(&["state", "history", "--path", &path, "--last", "2"]);
    let trimmed_entries = trimmed["entries"].as_array().unwrap();
    assert_eq!(trimmed_entries.len(), 2);
    assert_eq!(trimmed["appliedCount"], result["appliedCount"]);
    assert_eq!(
        trimmed_entries[0]["index"].as_i64().unwrap(),
        entries.len() as i64 - 2,
        "--last must keep the newest window, got: {trimmed}"
    );
    assert_eq!(
        trimmed_entries[1]["index"],
        entries[entries.len() - 1]["index"],
        "--last must end on the newest entry, got: {trimmed}"
    );
}

#[test]
fn test_state_jump_moves_between_history_positions() {
    let (_dir, path) = create_project_with_edit_history("state_jump_test", 3);

    let before = run_cli_ok(&["state", "history", "--path", &path]);
    let head_index = before["currentIndex"].as_i64().unwrap();
    assert_eq!(
        run_cli_ok(&["timeline", "clips", "--path", &path])["count"],
        3
    );

    // Rewind past the last two inserts.
    let target = head_index - 2;
    let jumped = run_cli_ok(&[
        "state",
        "jump",
        "--path",
        &path,
        "--index",
        &target.to_string(),
    ]);
    assert_eq!(jumped["status"], "ok");
    assert_eq!(jumped["previousIndex"].as_i64().unwrap(), head_index);
    assert_eq!(jumped["currentIndex"].as_i64().unwrap(), target);
    assert_eq!(jumped["redoCount"], 2);
    assert_eq!(
        run_cli_ok(&["timeline", "clips", "--path", &path])["count"],
        1
    );

    // And forward again: the rewind is a position, not a deletion.
    let restored = run_cli_ok(&[
        "state",
        "jump",
        "--path",
        &path,
        "--index",
        &head_index.to_string(),
    ]);
    assert_eq!(restored["currentIndex"].as_i64().unwrap(), head_index);
    assert_eq!(restored["redoCount"], 0);
    assert_eq!(
        run_cli_ok(&["timeline", "clips", "--path", &path])["count"],
        3
    );
}

#[test]
fn test_state_jump_reports_the_entries_it_unwound() {
    let (_dir, path) = create_project_with_edit_history("state_jump_unwound_test", 3);

    let before = run_cli_ok(&["state", "history", "--path", &path]);
    let entries = before["entries"].as_array().unwrap().clone();
    let head_index = before["currentIndex"].as_i64().unwrap();

    // History carries no author, so the only way a caller can tell that a
    // rewind reached work it did not write is to be told what came off.
    let jumped = run_cli_ok(&[
        "state",
        "jump",
        "--path",
        &path,
        "--index",
        &(head_index - 2).to_string(),
    ]);

    let unwound = jumped["unwound"].as_array().unwrap();
    assert_eq!(unwound.len(), 2, "Two entries came off, got: {jumped}");
    let expected: Vec<&serde_json::Value> = entries[entries.len() - 2..]
        .iter()
        .map(|entry| &entry["opId"])
        .collect();
    let reported: Vec<&serde_json::Value> = unwound.iter().map(|entry| &entry["opId"]).collect();
    assert_eq!(
        reported, expected,
        "unwound must name the removed ops in order, got: {jumped}"
    );
    assert!(
        unwound
            .iter()
            .all(|entry| entry["commandType"].as_str().is_some_and(|k| !k.is_empty())),
        "unwound entries must describe their command, got: {jumped}"
    );
    assert_eq!(
        jumped["adopted"], 0,
        "Nothing was written behind this invocation's back, got: {jumped}"
    );

    // A jump that removes nothing says so rather than omitting the field.
    let forward = run_cli_ok(&[
        "state",
        "jump",
        "--path",
        &path,
        "--index",
        &head_index.to_string(),
    ]);
    assert_eq!(forward["unwound"].as_array().unwrap().len(), 0);
}

#[test]
fn test_state_jump_reports_a_durable_move_when_the_save_fails() {
    let (dir, path) = create_project_with_edit_history("state_jump_save_failure_test", 2);

    let before = run_cli_ok(&["state", "history", "--path", &path]);
    let head_index = before["currentIndex"].as_i64().unwrap();

    // The history manifest is rewritten before the snapshot is written, so a
    // snapshot that cannot be replaced leaves the move durable. A directory in
    // the snapshot's place is a portable way to make that write fail.
    let snapshot_path = dir
        .path()
        .join("state_jump_save_failure_test")
        .join(".openreelio")
        .join("state")
        .join("snapshot.json");
    assert!(snapshot_path.exists(), "expected a snapshot to replace");
    std::fs::remove_file(&snapshot_path).expect("remove snapshot");
    std::fs::create_dir(&snapshot_path).expect("block the snapshot path");

    let output = Command::new(cli_bin())
        .args([
            "state",
            "jump",
            "--path",
            &path,
            "--index",
            &(head_index - 1).to_string(),
        ])
        .output()
        .expect("Failed to execute CLI binary");
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();

    if output.status.success() {
        // The platform let the snapshot write through anyway; nothing to assert.
        return;
    }

    let report: serde_json::Value = serde_json::from_str(&stdout).unwrap_or_else(|error| {
        panic!("A jump that moved history must still report on stdout: {error}\nstdout: {stdout}")
    });
    assert_eq!(report["status"], "error");
    assert_eq!(
        report["historyMoved"], true,
        "The move is durable and must be reported as such, got: {report}"
    );
    assert_eq!(report["currentIndex"].as_i64().unwrap(), head_index - 1);
    assert_eq!(output.status.code(), Some(2), "stdout: {stdout}");
    assert!(
        report["message"].as_str().unwrap().contains("do NOT retry"),
        "The report must warn against a blind retry, got: {report}"
    );

    // And the move really did survive: the next open reads the new position.
    std::fs::remove_dir(&snapshot_path).expect("unblock the snapshot path");
    let after = run_cli_ok(&["state", "history", "--path", &path]);
    assert_eq!(after["currentIndex"].as_i64().unwrap(), head_index - 1);
}

#[test]
fn test_state_jump_to_minus_one_undoes_everything() {
    let (_dir, path) = create_project_with_edit_history("state_jump_zero_test", 2);

    let result = run_cli_ok(&["state", "jump", "--path", &path, "--index=-1"]);

    assert_eq!(result["currentIndex"], -1);
    assert_eq!(result["appliedCount"], 0);
    assert_eq!(
        run_cli_ok(&["timeline", "clips", "--path", &path])["count"],
        0
    );
}

#[test]
fn test_state_jump_rejects_an_index_outside_the_history() {
    let (_dir, path) = create_project_with_edit_history("state_jump_range_test", 2);

    let (_stdout, stderr) = run_cli_err(&["state", "jump", "--path", &path, "--index", "99"]);

    assert!(
        stderr.contains("--index") && stderr.contains("history range"),
        "Expected the error to name the valid range, got: {stderr}"
    );

    // The rejected jump left the project alone.
    assert_eq!(
        run_cli_ok(&["timeline", "clips", "--path", &path])["count"],
        2
    );
}

#[test]
fn test_state_jump_then_new_edit_clears_the_redo_branch() {
    let (dir, path) = create_project_with_edit_history("state_jump_branch_test", 3);

    let head_index = run_cli_ok(&["state", "history", "--path", &path])["currentIndex"]
        .as_i64()
        .unwrap();
    run_cli_ok(&[
        "state",
        "jump",
        "--path",
        &path,
        "--index",
        &(head_index - 2).to_string(),
    ]);
    let rewound = run_cli_ok(&["state", "history", "--path", &path]);
    assert_eq!(rewound["redoCount"], 2);
    assert_eq!(
        rewound["entries"].as_array().unwrap().len() as u64,
        rewound["appliedCount"].as_u64().unwrap() + 2,
        "Redoable entries stay listed after the applied ones, got: {rewound}"
    );
    assert_eq!(
        rewound["currentIndex"].as_i64().unwrap(),
        rewound["appliedCount"].as_i64().unwrap() - 1,
        "currentIndex is the last applied index, got: {rewound}"
    );

    // A new edit from the rewound position abandons the branch it left behind:
    // the judge loop must re-apply a winning plan, not rely on redo.
    let tracks = run_cli_ok(&["timeline", "tracks", "--path", &path]);
    let track_id = tracks["tracks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|track| track["kind"] == "Video")
        .and_then(|track| track["id"].as_str())
        .unwrap()
        .to_string();
    let asset_id = run_cli_ok(&["asset", "list", "--path", &path])["assets"][0]["id"]
        .as_str()
        .unwrap()
        .to_string();
    run_cli_ok(&[
        "timeline", "insert", "--path", &path, "--asset", &asset_id, "--track", &track_id, "--at",
        "50.0",
    ]);

    let after = run_cli_ok(&["state", "history", "--path", &path]);
    assert_eq!(
        after["redoCount"], 0,
        "A new edit must clear the redo branch, got: {after}"
    );
    run_cli_err(&["timeline", "redo", "--path", &path]);

    let clips = run_cli_ok(&["timeline", "clips", "--path", &path]);
    assert_eq!(clips["count"], 2);
    drop(dir);
}

#[test]
fn test_state_jump_adopts_operations_written_since_the_last_command() {
    let (dir, path) = create_project_with_edit_history("state_jump_adopt_test", 2);

    // Each CLI invocation opens fresh, so work another writer finished before
    // this one started is history to build on, not a conflict. (The
    // external-edit guard covers the overlapping case, where a second writer
    // moves while a session is open — see the ActiveProject unit tests.)
    let tracks = run_cli_ok(&["timeline", "tracks", "--path", &path]);
    let track_id = tracks["tracks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|track| track["kind"] == "Video")
        .and_then(|track| track["id"].as_str())
        .unwrap()
        .to_string();
    let asset_id = run_cli_ok(&["asset", "list", "--path", &path])["assets"][0]["id"]
        .as_str()
        .unwrap()
        .to_string();
    run_cli_ok(&[
        "timeline", "insert", "--path", &path, "--asset", &asset_id, "--track", &track_id, "--at",
        "80.0",
    ]);

    let history = run_cli_ok(&["state", "history", "--path", &path]);
    let head_index = history["currentIndex"].as_i64().unwrap();
    let jumped = run_cli_ok(&[
        "state",
        "jump",
        "--path",
        &path,
        "--index",
        &(head_index - 1).to_string(),
    ]);

    assert_eq!(jumped["currentIndex"].as_i64().unwrap(), head_index - 1);
    assert_eq!(
        run_cli_ok(&["timeline", "clips", "--path", &path])["count"],
        2
    );
    drop(dir);
}

// =============================================================================
// Help-JSON Command
// =============================================================================

#[test]
fn test_help_json_contains_all_commands() {
    let result = run_cli_ok(&["help-json"]);
    let commands = result["commands"].as_object().unwrap();

    // Verify all leaf commands are present
    let expected_commands = vec![
        "project.create",
        "project.open",
        "project.info",
        "project.save",
        "asset.import",
        "asset.list",
        "asset.info",
        "asset.remove",
        "timeline.info",
        "timeline.clips",
        "timeline.tracks",
        "timeline.insert",
        "timeline.remove",
        "timeline.move",
        "timeline.trim",
        "timeline.split",
        "timeline.speed",
        "timeline.add-track",
        "timeline.remove-track",
        "timeline.undo",
        "timeline.redo",
        "caption.add",
        "caption.update",
        "caption.remove",
        "caption.list",
        "caption.import",
        "caption.export",
        "text.add",
        "text.update",
        "text.transform",
        "text.remove",
        "text.list",
        "plan.execute",
        "plan.validate",
        "plan.template",
        "command.execute",
        "command.validate",
        "command.schema",
        "state.dump",
        "state.ops",
        "state.history",
        "state.jump",
        "state.snapshot",
        "render.presets",
        "render.start",
        "frame.extract",
        "help-json",
    ];

    for cmd in &expected_commands {
        assert!(
            commands.contains_key(*cmd),
            "help-json missing command: {}",
            cmd
        );
    }
}

#[test]
fn test_command_schema_exposes_backend_payload_surface() {
    let result = run_cli_ok(&["command", "schema"]);
    let commands = result["commands"].as_array().unwrap();
    assert!(
        commands.len() >= 3,
        "expected command schema to expose backend commands"
    );
    assert_eq!(result["count"].as_u64().unwrap(), commands.len() as u64);

    let mut unique_commands = HashSet::new();
    for command in commands {
        let command = command
            .as_str()
            .expect("command schema entries should be strings");
        assert!(
            unique_commands.insert(command),
            "command schema should not contain duplicate entry: {command}"
        );
    }

    assert!(commands.iter().any(|value| value == "AddMask"));
    assert!(commands.iter().any(|value| value == "CreateCompoundClip"));
    assert!(commands.iter().any(|value| value == "RenameTrack"));
}

/// Drift guard: the `command schema` output is the only agent-facing surface for
/// the canonical backend command list, and it must be derived from
/// `CommandPayload::SUPPORTED_COMMAND_TYPES` rather than a hand-written copy.
///
/// This asserts exact parity in both directions so a new `CommandPayload`
/// variant (or a removed one) can never silently diverge from the schema agents
/// bootstrap against.
#[test]
fn test_command_schema_matches_canonical_supported_command_types() {
    use openreelio_core::ipc::CommandPayload;

    let result = run_cli_ok(&["command", "schema"]);
    let schema_commands: Vec<&str> = result["commands"]
        .as_array()
        .expect("command schema must expose a commands array")
        .iter()
        .map(|value| {
            value
                .as_str()
                .expect("command schema entries should be strings")
        })
        .collect();

    let canonical: Vec<&str> = CommandPayload::SUPPORTED_COMMAND_TYPES.to_vec();

    let schema_set: HashSet<&str> = schema_commands.iter().copied().collect();
    let canonical_set: HashSet<&str> = canonical.iter().copied().collect();

    let missing_from_schema: Vec<&str> = canonical
        .iter()
        .filter(|c| !schema_set.contains(*c))
        .copied()
        .collect();
    let unexpected_in_schema: Vec<&str> = schema_commands
        .iter()
        .filter(|c| !canonical_set.contains(*c))
        .copied()
        .collect();

    assert!(
        missing_from_schema.is_empty(),
        "command schema is missing canonical command types: {missing_from_schema:?}"
    );
    assert!(
        unexpected_in_schema.is_empty(),
        "command schema exposes command types absent from SUPPORTED_COMMAND_TYPES: {unexpected_in_schema:?}"
    );
    assert_eq!(
        schema_commands, canonical,
        "command schema order must match SUPPORTED_COMMAND_TYPES"
    );
    assert_eq!(
        result["count"].as_u64().unwrap() as usize,
        canonical.len(),
        "command schema count must equal SUPPORTED_COMMAND_TYPES length"
    );
}

#[test]
fn test_command_validate_uses_shared_payload_aliases() {
    let result = run_cli_ok(&[
        "command",
        "validate",
        "--type",
        "RenameTrack",
        "--payload",
        r#"{"sequenceId":"seq_1","trackId":"track_v1","name":"Main Video"}"#,
    ]);
    assert_eq!(result["status"], "ok");
    assert_eq!(result["commandType"], "RenameTrack");
}

#[test]
fn test_command_execute_runs_generic_backend_command() {
    let dir = create_temp_project("command_execute_test");
    let path = project_path(&dir, "command_execute_test");
    let info = run_cli_ok(&["project", "info", "--path", &path]);
    let sequence_id = info["activeSequenceId"].as_str().unwrap();

    let result = run_cli_ok(&[
        "command",
        "execute",
        "--path",
        &path,
        "--type",
        "AddMarker",
        "--payload",
        &format!(
            r#"{{"sequenceId":"{}","time":1.5,"label":"Hook"}}"#,
            sequence_id
        ),
    ]);
    assert_eq!(result["status"], "ok");
    assert_eq!(result["commandType"], "AddMarker");
    assert!(!result["opId"].as_str().unwrap().is_empty());
}

#[test]
fn test_plan_validate_rejects_invalid_command_payload() {
    let dir = create_temp_project("plan_payload_invalid_test");
    let path = project_path(&dir, "plan_payload_invalid_test");

    let plan = serde_json::json!({
        "id": "invalid_payload_plan",
        "steps": [
            {
                "id": "step_1",
                "commandType": "AddTrack",
                "payload": { "sequenceId": "seq_1", "name": "New Track", "kind": "invalid-kind" },
                "dependsOn": []
            }
        ]
    });
    let plan_file = dir.path().join("invalid_payload_plan.json");
    std::fs::write(&plan_file, serde_json::to_string(&plan).unwrap()).unwrap();

    let result = run_cli_ok(&[
        "plan",
        "validate",
        "--path",
        &path,
        "--file",
        plan_file.to_str().unwrap(),
    ]);
    assert_eq!(result["status"], "error");
    assert!(result["errors"][0]
        .as_str()
        .unwrap()
        .contains("invalid command payload"));
}

// =============================================================================
// Caption Commands
// =============================================================================

#[test]
fn test_caption_list_empty() {
    let dir = create_temp_project("caption_list_test");
    let path = project_path(&dir, "caption_list_test");
    let result = run_cli_ok(&["caption", "list", "--path", &path]);
    assert_eq!(result["count"], 0);
}

#[test]
fn test_caption_add_auto_creates_track() {
    let dir = create_temp_project("caption_add_test");
    let path = project_path(&dir, "caption_add_test");

    let result = run_cli_ok(&[
        "caption",
        "add",
        "--path",
        &path,
        "--text",
        "Hello world",
        "--start",
        "0",
        "--end",
        "2",
    ]);

    assert_eq!(result["status"], "ok");
    assert!(result["trackId"].is_string());

    let list = run_cli_ok(&["caption", "list", "--path", &path]);
    assert_eq!(list["count"], 1);
}

#[test]
fn test_caption_style_and_position_roundtrip() {
    let dir = create_temp_project("caption_style_roundtrip_test");
    let path = project_path(&dir, "caption_style_roundtrip_test");

    let result = run_cli_ok(&[
        "caption",
        "add",
        "--path",
        &path,
        "--text",
        "Styled caption",
        "--start",
        "0",
        "--end",
        "2",
        "--style-json",
        r##"{"fontFamily":"Inter","fontSize":42,"fontWeight":700,"color":"#112233CC","backgroundColor":{"r":0,"g":0,"b":0,"a":128},"backgroundPadding":18,"outlineColor":"#445566","outlineWidth":3,"shadowColor":"#00000099","shadowOffsetX":4,"shadowOffsetY":6,"shadowBlur":8,"alignment":"center","lineHeight":1.4,"letterSpacing":2}"##,
        "--position-json",
        r##"{"type":"custom","xPercent":42,"yPercent":84}"##,
    ]);
    assert_eq!(result["status"], "ok");

    let list = run_cli_ok(&["caption", "list", "--path", &path]);
    let caption_id = list["captions"][0]["id"].as_str().unwrap().to_string();
    let caption = &list["captions"][0];
    assert_eq!(caption["style"]["fontFamily"], "Inter");
    assert_eq!(caption["style"]["fontSize"], 42);
    assert_eq!(caption["style"]["fontWeight"], 700);
    assert_eq!(caption["style"]["color"], "#112233CC");
    assert_eq!(caption["style"]["backgroundColor"]["a"], 128);
    assert_eq!(caption["style"]["outlineWidth"], 3);
    assert_eq!(caption["style"]["shadowOffsetX"], 4);
    assert_eq!(caption["style"]["lineHeight"], 1.4);
    assert_eq!(caption["style"]["letterSpacing"], 2);
    assert_eq!(caption["position"]["type"], "custom");
    assert_eq!(caption["position"]["xPercent"], 42);
    assert_eq!(caption["position"]["yPercent"], 84);

    let clear = run_cli_ok(&[
        "caption",
        "update",
        "--path",
        &path,
        "--id",
        &caption_id,
        "--style-json",
        "null",
        "--position-json",
        "null",
    ]);
    assert_eq!(clear["status"], "ok");

    let cleared = run_cli_ok(&["caption", "list", "--path", &path]);
    assert!(cleared["captions"][0]["style"].is_null());
    assert!(cleared["captions"][0]["position"].is_null());
}

#[test]
fn test_caption_style_json_validation() {
    let dir = create_temp_project("caption_style_validation_test");
    let path = project_path(&dir, "caption_style_validation_test");

    let (_stdout, stderr) = run_cli_err(&[
        "caption",
        "add",
        "--path",
        &path,
        "--text",
        "Invalid style",
        "--start",
        "0",
        "--end",
        "2",
        "--style-json",
        r##"{"fontSize":0,"color":"not-a-color"}"##,
    ]);
    assert!(
        stderr.contains("fontSize") || stderr.contains("color"),
        "Expected caption style validation error, got: {}",
        stderr
    );
}

#[test]
fn test_caption_update_resolves_track_and_updates_timing() {
    let dir = create_temp_project("caption_update_test");
    let path = project_path(&dir, "caption_update_test");

    run_cli_ok(&[
        "caption", "add", "--path", &path, "--text", "Original", "--start", "0", "--end", "2",
    ]);
    let list_after_add = run_cli_ok(&["caption", "list", "--path", &path]);
    let caption_id = list_after_add["captions"][0]["id"]
        .as_str()
        .unwrap()
        .to_string();

    let result = run_cli_ok(&[
        "caption",
        "update",
        "--path",
        &path,
        "--id",
        &caption_id,
        "--text",
        "Updated",
        "--start",
        "1",
        "--end",
        "3",
        "--position",
        "top",
    ]);

    assert_eq!(result["status"], "ok");

    let list = run_cli_ok(&["caption", "list", "--path", &path]);
    let caption = list["captions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|caption| caption["id"].as_str() == Some(&caption_id))
        .expect("updated caption should exist");

    assert_eq!(caption["startSec"], 1.0);
    assert_eq!(caption["durationSec"], 2.0);
}

#[test]
fn test_caption_import_srt_file() {
    let dir = create_temp_project("caption_import_test");
    let path = project_path(&dir, "caption_import_test");

    let subtitle_file = dir.path().join("captions.srt");
    std::fs::write(
        &subtitle_file,
        "1\n00:00:00,000 --> 00:00:01,500\nFirst line\n\n2\n00:00:02,000 --> 00:00:03,000\nSecond line\n",
    )
    .unwrap();

    let result = run_cli_ok(&[
        "caption",
        "import",
        "--path",
        &path,
        "--file",
        subtitle_file.to_str().unwrap(),
    ]);

    assert_eq!(result["status"], "ok");
    assert_eq!(result["importedCount"], 2);

    let list = run_cli_ok(&["caption", "list", "--path", &path]);
    assert_eq!(list["count"], 2);
}

// =============================================================================
// Global Flags
// =============================================================================

#[test]
fn test_verbose_flag_accepted() {
    let (stdout, _stderr, success) = run_cli(&["--verbose", "render", "presets"]);
    assert!(success, "CLI should accept --verbose flag");
    let result: serde_json::Value = serde_json::from_str(&stdout).unwrap();
    assert!(result["presets"].is_array());
}

#[test]
fn test_quiet_flag_accepted() {
    let (stdout, _stderr, success) = run_cli(&["--quiet", "render", "presets"]);
    assert!(success, "CLI should accept --quiet flag");
    let result: serde_json::Value = serde_json::from_str(&stdout).unwrap();
    assert!(result["presets"].is_array());
}

#[test]
fn test_version_flag() {
    let (stdout, _stderr, success) = run_cli(&["--version"]);
    assert!(success);
    assert!(stdout.contains("openreelio-cli"));
}

// =============================================================================
// Core User-Flow Regression Guard
// =============================================================================

// ponytail: This is THE single end-to-end guard for the core user flow that
// ships the product: create project -> import video -> split + trim clip ->
// add caption -> render to a real video file. It drives the real CLI binary
// (real command pipeline, real event-sourced ops, real FFmpeg render) and
// asserts a genuine non-empty output file with a valid probed duration.
//
// It deliberately does NOT cover: GUI/Tauri paths, codec/quality correctness,
// caption pixel-burn-in correctness, multi-track compositing, audio mixing, or
// render presets beyond the default. Those have their own focused tests. This
// guard exists only to catch a SILENT break of the whole pipeline before
// shipping. It skips cleanly (returns, does not fail) when FFmpeg is absent so
// it never red-flags CI on machines without ffmpeg installed.
#[test]
fn test_core_flow_create_import_edit_caption_render_end_to_end() {
    // Skip cleanly if FFmpeg is genuinely unavailable in this environment.
    if system_ffmpeg_path().is_none() {
        eprintln!("Skipping core-flow E2E test: ffmpeg not found");
        return;
    }

    // 1. Create project.
    let dir = create_temp_project("core_flow_e2e");
    let path = project_path(&dir, "core_flow_e2e");

    // 2. Import a real 2s video (long enough to split/trim within range).
    let source_path = dir.path().join("core_flow_source.mp4");
    if !create_sample_video_with_duration(&source_path, 2) {
        // Encoder/generation unavailable -> skip cleanly.
        return;
    }
    let import = run_cli_ok(&[
        "asset",
        "import",
        "--path",
        &path,
        "--file",
        source_path.to_str().unwrap(),
    ]);
    let asset_id = import["createdIds"][0].as_str().unwrap().to_string();

    // 3. Insert the clip onto the Video track.
    let tracks = run_cli_ok(&["timeline", "tracks", "--path", &path]);
    let track_id = tracks["tracks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|track| track["kind"] == "Video")
        .and_then(|track| track["id"].as_str())
        .unwrap()
        .to_string();
    run_cli_ok(&[
        "timeline", "insert", "--path", &path, "--asset", &asset_id, "--track", &track_id, "--at",
        "0.0",
    ]);

    // Resolve the inserted clip id from the timeline.
    let clips = run_cli_ok(&["timeline", "clips", "--path", &path]);
    let clip_id = clips["clips"][0]["id"].as_str().unwrap().to_string();

    // 4. Split the clip at 1.0s -> yields two clips.
    let split = run_cli_ok(&[
        "timeline", "split", "--path", &path, "--clip", &clip_id, "--track", &track_id, "--at",
        "1.0",
    ]);
    assert_eq!(split["status"], "ok");

    // 5. Trim the first (original) clip's source range.
    let trim = run_cli_ok(&[
        "timeline",
        "trim",
        "--path",
        &path,
        "--clip",
        &clip_id,
        "--track",
        &track_id,
        "--source-in",
        "0.0",
        "--source-out",
        "0.8",
    ]);
    assert_eq!(trim["status"], "ok");

    // 6. Add a caption/text overlay.
    let caption = run_cli_ok(&[
        "caption",
        "add",
        "--path",
        &path,
        "--text",
        "Hello OpenReelio",
        "--start",
        "0.0",
        "--end",
        "0.8",
    ]);
    assert_eq!(caption["status"], "ok");

    // 7. Render the sequence to a real output file.
    let output_path = dir.path().join("core_flow_output.mp4");
    let result = run_cli_ok(&[
        "render",
        "start",
        "--path",
        &path,
        "--output",
        output_path.to_str().unwrap(),
    ]);
    assert_eq!(result["status"], "ok");

    // 8. Assert the render produced a real, non-trivial video file.
    assert!(
        output_path.exists(),
        "Expected rendered output file to exist"
    );
    assert!(
        output_path.metadata().unwrap().len() > 0,
        "Expected rendered output file to be non-empty"
    );

    // If ffprobe is available, assert the output is a valid video with a
    // plausible, non-zero duration. If ffprobe is unavailable we still have
    // the existence + size guard above.
    if let Some(duration) = ffprobe_duration_secs(&output_path) {
        assert!(
            duration > 0.0,
            "Expected rendered output to have a positive duration, got {duration}"
        );
    }
}

// =============================================================================
// Perception Commands
// =============================================================================

/// Creates a project and imports media produced by `build_media`.
///
/// Returns `None` when FFmpeg cannot produce the fixture so callers can skip.
fn create_project_with_media(
    name: &str,
    file_name: &str,
    build_media: impl Fn(&std::path::Path) -> bool,
) -> Option<(tempfile::TempDir, String, String)> {
    system_ffmpeg_path()?;

    let dir = create_temp_project(name);
    let path = project_path(&dir, name);

    let source_path = dir.path().join(file_name);
    if !build_media(&source_path) {
        return None;
    }

    let import = run_cli_ok(&[
        "asset",
        "import",
        "--path",
        &path,
        "--file",
        source_path.to_str().unwrap(),
    ]);
    let asset_id = import["createdIds"][0].as_str().unwrap().to_string();

    Some((dir, path, asset_id))
}

/// Path of the cached analysis bundle written by the perception verbs.
fn bundle_path(project_path: &str, asset_id: &str) -> PathBuf {
    PathBuf::from(project_path)
        .join(".openreelio")
        .join("analysis")
        .join(asset_id)
        .join("bundle.json")
}

#[test]
fn test_analysis_shots_detects_and_persists_scene_change() {
    let Some((_dir, path, asset_id)) = create_project_with_media(
        "shots_persist_test",
        "scene_change.mp4",
        create_sample_video_with_scene_change,
    ) else {
        return;
    };

    let result = run_cli_ok(&["analysis", "shots", "--path", &path, "--id", &asset_id]);

    assert_eq!(result["status"], "ok");
    assert_eq!(result["assetId"], asset_id.as_str());
    assert!(
        result["shotCount"].as_u64().unwrap() >= 1,
        "Expected at least one detected shot, got {}",
        result["shotCount"]
    );
    assert!(result["totalDurationSec"].as_f64().unwrap() > 0.0);

    let persisted: Vec<&str> = result["persisted"]
        .as_array()
        .unwrap()
        .iter()
        .map(|value| value.as_str().unwrap())
        .collect();
    assert!(persisted.contains(&"bundle"), "persisted: {:?}", persisted);
    assert!(
        persisted.contains(&"annotations"),
        "persisted: {:?}",
        persisted
    );
    assert!(persisted.contains(&"indexDb"), "persisted: {:?}", persisted);

    assert!(
        bundle_path(&path, &asset_id).exists(),
        "Expected the analysis bundle to be written"
    );
    assert!(
        PathBuf::from(&path).join("index.db").exists(),
        "Expected the shot index database to be written"
    );

    // The cached artifacts must be visible to the reporting verbs.
    let report = run_cli_ok(&["analysis", "report", "--path", &path, "--id", &asset_id]);
    assert_eq!(report["coverage"]["shots"], true);
    assert_eq!(report["shots"]["count"], result["shotCount"]);
}

#[test]
fn test_analysis_shots_writes_nothing_with_no_persist() {
    let Some((_dir, path, asset_id)) = create_project_with_media(
        "shots_no_persist_test",
        "scene_change.mp4",
        create_sample_video_with_scene_change,
    ) else {
        return;
    };

    let result = run_cli_ok(&[
        "analysis",
        "shots",
        "--path",
        &path,
        "--id",
        &asset_id,
        "--no-persist",
    ]);

    assert_eq!(result["status"], "ok");
    assert!(result["shotCount"].as_u64().unwrap() >= 1);
    assert_eq!(result["persisted"].as_array().unwrap().len(), 0);
    assert!(
        !bundle_path(&path, &asset_id).exists(),
        "Expected --no-persist to leave the analysis bundle untouched"
    );

    let report = run_cli_ok(&["analysis", "report", "--path", &path, "--id", &asset_id]);
    assert_eq!(report["coverage"]["shots"], false);
}

#[test]
fn test_analysis_shots_rejects_out_of_range_threshold() {
    let dir = create_temp_project("shots_threshold_test");
    let path = project_path(&dir, "shots_threshold_test");

    let (_stdout, stderr) = run_cli_err(&[
        "analysis",
        "shots",
        "--path",
        &path,
        "--id",
        "asset_missing",
        "--threshold",
        "1.5",
    ]);
    assert!(
        stderr.contains("threshold"),
        "Expected a threshold validation error, got: {stderr}"
    );
}

#[test]
fn test_analysis_silence_caches_regions_at_default_thresholds() {
    let Some((_dir, path, asset_id)) = create_project_with_media(
        "silence_default_test",
        "with_audio.mp4",
        create_sample_video_with_audio,
    ) else {
        return;
    };

    // Silence lives inside the audio profile, so the profile has to exist
    // before there is anything to merge into.
    run_cli_ok(&["analysis", "audio", "--path", &path, "--id", &asset_id]);

    let result = run_cli_ok(&["analysis", "silence", "--path", &path, "--id", &asset_id]);

    assert_eq!(result["status"], "ok");
    assert_eq!(result["persisted"], true);
    assert!(result.get("reason").is_none() || result["reason"].is_null());
    assert!(
        result["regionCount"].as_u64().unwrap() >= 1,
        "Expected the muted 1s-3s window to be detected"
    );
    assert!(result["totalSilenceSec"].as_f64().unwrap() > 0.0);
    assert!(
        bundle_path(&path, &asset_id).exists(),
        "Expected default-threshold silence to be cached"
    );

    let report = run_cli_ok(&["analysis", "report", "--path", &path, "--id", &asset_id]);
    assert_eq!(report["coverage"]["audio"], true);
}

#[test]
fn test_analysis_silence_is_output_only_without_an_audio_profile() {
    let Some((_dir, path, asset_id)) = create_project_with_media(
        "silence_no_profile_test",
        "with_audio.mp4",
        create_sample_video_with_audio,
    ) else {
        return;
    };

    let result = run_cli_ok(&["analysis", "silence", "--path", &path, "--id", &asset_id]);

    assert_eq!(result["status"], "ok");
    assert_eq!(result["persisted"], false);
    assert_eq!(
        result["reason"],
        "no audio profile in bundle; run `analysis audio` first"
    );
    assert!(
        result["regionCount"].as_u64().unwrap() >= 1,
        "detection still runs and reports its regions"
    );
    assert!(
        !bundle_path(&path, &asset_id).exists(),
        "a fabricated audio profile must never reach the bundle"
    );
}

#[test]
fn test_analysis_silence_is_output_only_for_non_default_threshold() {
    let Some((_dir, path, asset_id)) = create_project_with_media(
        "silence_custom_test",
        "with_audio.mp4",
        create_sample_video_with_audio,
    ) else {
        return;
    };

    let result = run_cli_ok(&[
        "analysis",
        "silence",
        "--path",
        &path,
        "--id",
        &asset_id,
        "--threshold-db",
        "-30",
    ]);

    assert_eq!(result["status"], "ok");
    assert_eq!(result["persisted"], false);
    assert_eq!(result["reason"], "non-default threshold");
    assert!(
        !bundle_path(&path, &asset_id).exists(),
        "Non-default silence parameters must not poison the shared cache"
    );
}

#[test]
fn test_analysis_audio_profiles_and_caches_the_bundle() {
    let Some((_dir, path, asset_id)) = create_project_with_media(
        "audio_profile_test",
        "with_audio.mp4",
        create_sample_video_with_audio,
    ) else {
        return;
    };

    let result = run_cli_ok(&["analysis", "audio", "--path", &path, "--id", &asset_id]);

    assert_eq!(result["status"], "ok");
    assert_eq!(result["persisted"], true);
    assert!(result["durationSec"].as_f64().unwrap() > 0.0);
    assert!(result["silenceRegionCount"].as_u64().unwrap() >= 1);
    assert!(result["peakDb"].is_number());
    assert!(
        bundle_path(&path, &asset_id).exists(),
        "Expected the audio profile to be cached"
    );

    let report = run_cli_ok(&["analysis", "report", "--path", &path, "--id", &asset_id]);
    assert_eq!(report["coverage"]["audio"], true);
}

#[test]
fn test_analysis_run_streams_progress_and_caches_the_bundle() {
    let Some((_dir, path, asset_id)) = create_project_with_media(
        "analysis_run_test",
        "with_audio.mp4",
        create_sample_video_with_audio,
    ) else {
        return;
    };

    let (stdout, stderr, success) = run_cli(&[
        "analysis",
        "run",
        "--path",
        &path,
        "--id",
        &asset_id,
        "--progress",
    ]);
    assert!(
        success,
        "analysis run failed.\nstdout: {stdout}\nstderr: {stderr}"
    );

    let result: serde_json::Value =
        serde_json::from_str(&stdout).expect("analysis run must print one JSON object to stdout");
    assert_eq!(result["status"], "ok");
    assert_eq!(result["options"]["localOnly"], true);
    assert_eq!(result["options"]["transcript"], false);
    assert_eq!(result["hasAudioProfile"], true);
    assert!(result["shotCount"].as_u64().unwrap() >= 1);
    assert!(result["segmentCount"].as_u64().unwrap() >= 1);
    assert!(result["errors"].as_object().unwrap().is_empty());
    assert!(bundle_path(&path, &asset_id).exists());

    // Progress must be NDJSON on stderr so stdout stays a single JSON object.
    let progress_lines: Vec<serde_json::Value> = stderr
        .lines()
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line.trim()).ok())
        .filter(|value| value["type"] == "progress")
        .collect();
    assert!(
        !progress_lines.is_empty(),
        "Expected NDJSON progress on stderr, got: {stderr}"
    );
    assert!(progress_lines
        .iter()
        .any(|line| line["job"] == "shots" && line["status"] == "started"));
    assert!(progress_lines
        .iter()
        .any(|line| line["job"] == "bundle" && line["status"] == "saved"));

    let report = run_cli_ok(&["analysis", "report", "--path", &path, "--id", &asset_id]);
    assert_eq!(report["coverage"]["shots"], true);
    assert_eq!(report["coverage"]["audio"], true);
    assert_eq!(report["coverage"]["segments"], true);
}

#[test]
fn test_analysis_run_preserves_results_from_earlier_partial_runs() {
    let Some((_dir, path, asset_id)) = create_project_with_media(
        "analysis_run_merge_test",
        "with_audio.mp4",
        create_sample_video_with_audio,
    ) else {
        return;
    };

    let audio = run_cli_ok(&["analysis", "audio", "--path", &path, "--id", &asset_id]);
    assert_eq!(audio["status"], "ok");

    // A shots-only run must not drop the audio profile the previous run cached.
    let result = run_cli_ok(&[
        "analysis", "run", "--path", &path, "--id", &asset_id, "--shots",
    ]);
    assert_eq!(result["status"], "ok");
    assert_eq!(result["options"]["audio"], false);
    assert_eq!(result["hasAudioProfile"], true);

    let report = run_cli_ok(&["analysis", "report", "--path", &path, "--id", &asset_id]);
    assert_eq!(report["coverage"]["shots"], true);
    assert_eq!(report["coverage"]["audio"], true);
}

#[test]
fn test_analysis_shots_keeps_keyframes_a_previous_run_extracted() {
    let Some((_dir, path, asset_id)) = create_project_with_media(
        "analysis_shots_keyframe_test",
        "scene_change.mp4",
        create_sample_video_with_scene_change,
    ) else {
        return;
    };

    // A full run detects shots and extracts a keyframe per shot.
    run_cli_ok(&[
        "analysis", "run", "--path", &path, "--id", &asset_id, "--shots",
    ]);

    let cached: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(bundle_path(&path, &asset_id)).unwrap())
            .unwrap();
    let cached_shots = cached["shots"].as_array().unwrap().clone();
    assert!(
        cached_shots
            .iter()
            .any(|shot| shot["keyframePath"].is_string()),
        "the full run must extract keyframes for this test to mean anything: {cached}"
    );

    // `analysis shots` re-detects boundaries and deliberately extracts nothing.
    run_cli_ok(&["analysis", "shots", "--path", &path, "--id", &asset_id]);

    let after: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(bundle_path(&path, &asset_id)).unwrap())
            .unwrap();
    let after_shots = after["shots"].as_array().unwrap();
    assert_eq!(after_shots.len(), cached_shots.len());
    for (before, after) in cached_shots.iter().zip(after_shots) {
        assert_eq!(
            before["keyframePath"], after["keyframePath"],
            "re-detecting the same cuts must not blank the keyframe thumbnails"
        );
    }
}

// =============================================================================
// verify
// =============================================================================

/// Runs the CLI and returns (stdout, stderr, exit code).
///
/// `verify` distinguishes "found problems" (1) from "could not run" (2), so its
/// tests need the code itself rather than a success flag.
fn run_cli_exit(args: &[&str]) -> (String, String, i32) {
    let output = Command::new(cli_bin())
        .args(args)
        .output()
        .expect("Failed to execute CLI binary");
    (
        String::from_utf8_lossy(&output.stdout).to_string(),
        String::from_utf8_lossy(&output.stderr).to_string(),
        output.status.code().unwrap_or(-1),
    )
}

/// Creates a project holding one dummy asset placed on the first video track.
///
/// Deliberately FFmpeg-free: structural verification must work on a machine
/// without a media toolchain.
fn create_project_with_placed_dummy(name: &str) -> (tempfile::TempDir, String, String, String) {
    let dir = create_temp_project(name);
    let path = project_path(&dir, name);

    let dummy_file = dir.path().join("clip.mp4");
    std::fs::write(&dummy_file, b"dummy video").unwrap();
    let import = run_cli_ok(&[
        "asset",
        "import",
        "--path",
        &path,
        "--file",
        dummy_file.to_str().unwrap(),
    ]);
    let asset_id = import["createdIds"][0].as_str().unwrap().to_string();

    let tracks = run_cli_ok(&["timeline", "tracks", "--path", &path]);
    let track_id = tracks["tracks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|track| track["kind"] == "Video")
        .and_then(|track| track["id"].as_str())
        .unwrap()
        .to_string();

    run_cli_ok(&[
        "timeline", "insert", "--path", &path, "--asset", &asset_id, "--track", &track_id, "--at",
        "0.0",
    ]);

    (dir, path, asset_id, track_id)
}

/// Finds a check entry by its stable ID.
fn find_check<'a>(report: &'a serde_json::Value, check_id: &str) -> &'a serde_json::Value {
    report["checks"]
        .as_array()
        .expect("checks array")
        .iter()
        .find(|check| check["id"] == check_id)
        .unwrap_or_else(|| panic!("check '{check_id}' missing from report: {report}"))
}

#[test]
fn test_verify_structural_only_passes_on_a_healthy_project() {
    let (_dir, path, _asset_id, _track_id) =
        create_project_with_placed_dummy("verify_structural_ok");

    let (stdout, stderr, code) = run_cli_exit(&["verify", "--path", &path, "--structural-only"]);
    assert_eq!(
        code, 0,
        "expected a clean structural run.\nstderr: {stderr}"
    );

    let report: serde_json::Value =
        serde_json::from_str(&stdout).unwrap_or_else(|error| panic!("{error}\n{stdout}"));

    assert_eq!(report["status"], "ok");
    assert_eq!(report["passed"], true);
    assert_eq!(report["summary"]["error"], 0);
    assert_eq!(report["summary"]["critical"], 0);

    // Structural runs must never reach for FFmpeg.
    assert_eq!(report["target"]["measured"], false);
    assert_eq!(report["measurements"]["measured"], false);

    // The stats check always reports its metrics as an informational finding,
    // which is a finding all the same: "warned", never "passed".
    let stats = find_check(&report, "shot.length_stats");
    assert_eq!(stats["status"], "warned");
    assert_eq!(stats["passed"], false);
    assert_eq!(stats["severity"], "info");
    assert_eq!(stats["metrics"]["count"], 1);
    assert!(stats["metrics"]["medianSec"].as_f64().unwrap() > 0.0);

    // A passing check still has to appear, or an agent cannot tell it ran.
    let gap = find_check(&report, "timeline.gap");
    assert_eq!(gap["status"], "passed");
    assert_eq!(gap["passed"], true);
    assert_eq!(gap["violationCount"], 0);

    // A project with clips must not trip the empty-sequence floor.
    let empty = find_check(&report, "sequence.empty");
    assert_eq!(empty["status"], "passed");

    // Rendered checks are skipped with a reason rather than silently passed.
    let black = find_check(&report, "render.black_frames");
    assert_eq!(black["status"], "skipped");
    assert_eq!(black["passed"], false);
    assert!(black["skipReason"]
        .as_str()
        .unwrap()
        .contains("measurements"));

    // Nothing may be measured against a file that was never supplied.
    let duration = find_check(&report, "render.duration_mismatch");
    assert_eq!(duration["status"], "skipped");
    assert_eq!(duration["passed"], false);
}

/// Feature: Verify
/// Scenario: should not report a project it never looked at as clean
#[test]
fn test_verify_warns_that_an_empty_sequence_was_never_edited() {
    let dir = create_temp_project("verify_empty_sequence");
    let path = project_path(&dir, "verify_empty_sequence");

    let (stdout, stderr, code) = run_cli_exit(&["verify", "--path", &path, "--structural-only"]);
    let report: serde_json::Value =
        serde_json::from_str(&stdout).unwrap_or_else(|error| panic!("{error}\n{stdout}"));

    let empty = find_check(&report, "sequence.empty");
    assert_eq!(
        empty["status"], "warned",
        "an empty timeline must never verify silently.\nstderr: {stderr}"
    );
    assert_eq!(empty["passed"], false);
    assert_eq!(empty["severity"], "warning");
    assert_eq!(empty["violationCount"], 1);
    assert_eq!(empty["metrics"]["clipCount"], 0);
    assert!(
        empty["suggestedFix"].is_null(),
        "what belongs on an empty timeline is not a QC decision"
    );

    // A warning is a finding to read, not a failing verdict: the default
    // threshold is `error`, so the run still exits zero.
    assert_eq!(report["status"], "warning");
    assert_eq!(code, 0);

    // Raising the threshold turns the same finding into a failure.
    let (_stdout, _stderr, code) = run_cli_exit(&[
        "verify",
        "--path",
        &path,
        "--structural-only",
        "--fail-on",
        "warning",
    ]);
    assert_eq!(code, 1, "--fail-on warning must catch an empty sequence");
}

#[test]
fn test_verify_reports_a_timeline_gap_as_an_error_and_exits_one() {
    let (dir, path, asset_id, track_id) = create_project_with_placed_dummy("verify_gap_error");

    // The dummy asset yields a 10s clip; placing the next one at 11s leaves a
    // deliberate one-second hole in the picture.
    run_cli_ok(&[
        "timeline", "insert", "--path", &path, "--asset", &asset_id, "--track", &track_id, "--at",
        "11.0",
    ]);

    let (stdout, stderr, code) = run_cli_exit(&[
        "verify",
        "--path",
        &path,
        "--structural-only",
        "--fail-on",
        "error",
    ]);
    assert_eq!(
        code, 1,
        "a gap must breach the error threshold.\nstdout: {stdout}\nstderr: {stderr}"
    );

    let report: serde_json::Value =
        serde_json::from_str(&stdout).unwrap_or_else(|error| panic!("{error}\n{stdout}"));

    assert_eq!(report["status"], "failed");
    assert_eq!(report["passed"], false);
    assert_eq!(report["summary"]["error"], 1);

    let gap = find_check(&report, "timeline.gap");
    assert_eq!(gap["status"], "failed");
    assert_eq!(gap["severity"], "error");
    assert_eq!(gap["violationCount"], 1);
    assert!((gap["timeRanges"][0]["startSec"].as_f64().unwrap() - 10.0).abs() < 1e-6);
    assert!((gap["timeRanges"][0]["endSec"].as_f64().unwrap() - 11.0).abs() < 1e-6);

    // The suggested fix has to be executable, not merely descriptive.
    let step = &gap["suggestedFix"]["steps"][0];
    assert_eq!(step["commandType"], "CloseGap");
    assert_eq!(step["payload"]["trackId"], track_id.as_str());

    let plan_file = dir.path().join("fix-plan.json");
    std::fs::write(
        &plan_file,
        serde_json::json!({
            "id": "plan_verify_fix",
            "steps": gap["suggestedFix"]["steps"],
        })
        .to_string(),
    )
    .unwrap();

    let applied = run_cli_ok(&[
        "plan",
        "execute",
        "--path",
        &path,
        "--file",
        plan_file.to_str().unwrap(),
    ]);
    assert_eq!(applied["status"], "ok");

    let (stdout, _stderr, code) = run_cli_exit(&["verify", "--path", &path, "--structural-only"]);
    assert_eq!(code, 0, "the suggested fix must close the gap: {stdout}");
}

#[test]
fn test_verify_rejects_an_unknown_check_id_with_the_tool_failure_code() {
    let (_dir, path, _asset_id, _track_id) = create_project_with_placed_dummy("verify_bad_check");

    let (_stdout, stderr, code) = run_cli_exit(&[
        "verify",
        "--path",
        &path,
        "--structural-only",
        "--checks",
        "not.a.real.check",
    ]);

    assert_eq!(code, 2, "bad arguments are a tool failure, not a finding");
    assert!(
        stderr.contains("Unknown check"),
        "expected the error to list the known checks, got: {stderr}"
    );
}

#[test]
fn test_verify_measures_a_rendered_file() {
    let Some((dir, path, asset_id)) = create_project_with_media(
        "verify_rendered_test",
        "verify_source.mp4",
        create_sample_video_with_audio,
    ) else {
        return;
    };

    let tracks = run_cli_ok(&["timeline", "tracks", "--path", &path]);
    let track_id = tracks["tracks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|track| track["kind"] == "Video")
        .and_then(|track| track["id"].as_str())
        .unwrap()
        .to_string();

    run_cli_ok(&[
        "timeline", "insert", "--path", &path, "--asset", &asset_id, "--track", &track_id, "--at",
        "0.0",
    ]);

    let render_path = dir.path().join("verify-proxy.mp4");
    let (stdout, stderr, success) = run_cli(&[
        "render",
        "start",
        "--path",
        &path,
        "--proxy",
        "--start",
        "0",
        "--end",
        "2",
        "--output",
        render_path.to_str().unwrap(),
    ]);
    if !success {
        eprintln!("Skipping verify render test: proxy render failed.\n{stdout}\n{stderr}");
        return;
    }

    // A two-second slice of a longer sequence is not the deliverable, and
    // `render.duration_mismatch` says so. That is asserted on its own below;
    // here it is skipped so the measurement assertions stand alone.
    //
    // The fixture is a bare test tone, so its absolute loudness says nothing
    // about the edit; the measurement itself is still asserted below.
    let (stdout, stderr, code) = run_cli_exit(&[
        "verify",
        "--path",
        &path,
        "--file",
        render_path.to_str().unwrap(),
        "--skip",
        "audio.loudness,render.duration_mismatch",
    ]);
    assert_eq!(
        code, 0,
        "rendered verification should run cleanly.\nstdout: {stdout}\nstderr: {stderr}"
    );

    let report: serde_json::Value =
        serde_json::from_str(&stdout).unwrap_or_else(|error| panic!("{error}\n{stdout}"));

    assert_eq!(report["target"]["measured"], true);
    assert_eq!(report["measurements"]["measured"], true);
    assert_eq!(report["measurements"]["videoMeasured"], true);
    assert_eq!(report["measurements"]["audioMeasured"], true);
    assert!(report["measurements"]["durationSec"].as_f64().unwrap() > 0.0);

    // Loudness is measured even though the check itself was skipped.
    assert!(
        report["measurements"]["integratedLufs"].is_number(),
        "expected an EBU R128 reading: {}",
        report["measurements"]
    );

    let black = find_check(&report, "render.black_frames");
    assert_ne!(
        black["status"], "skipped",
        "rendered checks must run once a file was measured: {black}"
    );

    let peak = find_check(&report, "audio.peak");
    assert_ne!(
        peak["status"], "skipped",
        "peak check should have run: {peak}"
    );

    let loudness = find_check(&report, "audio.loudness");
    assert_eq!(loudness["status"], "skipped");

    // Feature: Verify against a rendered file
    // Scenario: should refuse to grade a file that is not the sequence
    //
    // The same render, now with the duration check left on. Two seconds of a
    // ten-second timeline measures perfectly well and is still the wrong file;
    // without this check every measurement above would describe a program
    // nobody asked for.
    let (stdout, stderr, code) = run_cli_exit(&[
        "verify",
        "--path",
        &path,
        "--file",
        render_path.to_str().unwrap(),
        "--skip",
        "audio.loudness",
    ]);
    assert_eq!(
        code, 1,
        "a truncated render must not be graded as the deliverable.\nstdout: {stdout}\nstderr: {stderr}"
    );

    let report: serde_json::Value =
        serde_json::from_str(&stdout).unwrap_or_else(|error| panic!("{error}\n{stdout}"));

    let duration = find_check(&report, "render.duration_mismatch");
    assert_eq!(duration["status"], "failed");
    assert_eq!(duration["severity"], "error");
    assert!(duration["metrics"]["deltaSec"].as_f64().unwrap() < 0.0);
    assert!(
        duration["metrics"]["fileDurationSec"].as_f64().unwrap()
            < duration["metrics"]["sequenceDurationSec"].as_f64().unwrap()
    );
    assert_eq!(report["status"], "failed");
    assert_eq!(report["passed"], false);
}

/// Builds a project with a single 3s file-backed clip at 0s on the first video
/// track, ready for a tail clip to be added after it.
///
/// Returns `(dir, project_path, sequence_id, video_track_id, asset_id)`.
fn create_project_with_three_second_body(
    name: &str,
) -> Option<(tempfile::TempDir, String, String, String, String)> {
    let (dir, path, asset_id) =
        create_project_with_media(name, "duration_source.mp4", create_sample_video_with_audio)?;

    let track_id = run_cli_ok(&["timeline", "tracks", "--path", &path])["tracks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|track| track["kind"] == "Video")
        .and_then(|track| track["id"].as_str())
        .unwrap()
        .to_string();

    run_cli_ok(&[
        "timeline", "insert", "--path", &path, "--asset", &asset_id, "--track", &track_id, "--at",
        "0.0",
    ]);

    let clip_id = run_cli_ok(&["timeline", "clips", "--path", &path])["clips"][0]["id"]
        .as_str()
        .unwrap()
        .to_string();

    // Keep the clip inside the fixture's real media length so the render has
    // decodable frames for the whole file-backed span.
    run_cli_ok(&[
        "timeline",
        "trim",
        "--path",
        &path,
        "--clip",
        &clip_id,
        "--track",
        &track_id,
        "--source-in",
        "0",
        "--source-out",
        "3",
    ]);

    let sequence_id = run_cli_ok(&["project", "info", "--path", &path])["activeSequenceId"]
        .as_str()
        .unwrap()
        .to_string();

    Some((dir, path, sequence_id, track_id, asset_id))
}

/// Reads the `render.duration_mismatch` check out of a `verify --file` run.
fn verify_duration_check(path: &str, render_path: &std::path::Path) -> serde_json::Value {
    // The fixture is a bare test tone, so its absolute loudness says nothing
    // about the edit and that check is skipped; the duration check is the whole
    // point of the run.
    let (stdout, stderr, code) = run_cli_exit(&[
        "verify",
        "--path",
        path,
        "--file",
        render_path.to_str().unwrap(),
        "--skip",
        "audio.loudness",
    ]);
    assert_ne!(
        code, 2,
        "verify itself must run.\nstdout: {stdout}\nstderr: {stderr}"
    );

    let report: serde_json::Value =
        serde_json::from_str(&stdout).unwrap_or_else(|error| panic!("{error}\n{stdout}"));
    find_check(&report, "render.duration_mismatch").clone()
}

fn render_proxy_to(path: &str, output: &std::path::Path) -> serde_json::Value {
    run_cli_ok(&[
        "render",
        "start",
        "--path",
        path,
        "--proxy",
        "--output",
        output.to_str().unwrap(),
    ])
}

// Feature: Render and verify agree on the output length
//
// The length the export writes and the length verify grades against are the
// same function (`Sequence::output_duration`), so a correct render can never
// be reported as a duration mismatch. These two tests cover the two ways the
// two sides used to disagree: a tail clip that emits no stream of its own (the
// render stopped short of it) and a tail clip the export drops (verify counted
// it anyway).

/// Scenario: the timeline ends on an adjustment layer, which emits no stream
#[test]
fn test_render_and_verify_agree_when_the_timeline_ends_on_an_adjustment_layer() {
    let Some((dir, path, sequence_id, track_id, _asset_id)) =
        create_project_with_three_second_body("render_verify_adjustment_tail")
    else {
        return;
    };

    // Timeline becomes: clip 0-3, adjustment layer 3-6.
    run_cli_ok(&[
        "command",
        "execute",
        "--path",
        &path,
        "--type",
        "CreateAdjustmentLayer",
        "--payload",
        &format!(
            r#"{{"sequenceId":"{sequence_id}","trackId":"{track_id}","position":3.0,"duration":3.0,"name":"Grade"}}"#
        ),
    ]);

    let render_path = dir.path().join("adjustment-tail.mp4");
    let result = render_proxy_to(&path, &render_path);

    // The last file-backed clip ends at 3s; the adjustment layer holds the
    // output open to 6s.
    assert_eq!(result["durationSec"], 6.0);
    if let Some(measured) = ffprobe_duration_secs(&render_path) {
        assert!(
            (measured - 6.0).abs() < 0.5,
            "the render must reach the adjustment layer's out point, measured {measured}s"
        );
    }

    let duration = verify_duration_check(&path, &render_path);
    assert_eq!(
        duration["status"], "passed",
        "a render covering the whole timeline is the deliverable: {duration}"
    );
}

/// Scenario: the timeline ends on a muted track, which the export drops
#[test]
fn test_render_and_verify_agree_when_the_timeline_ends_on_a_muted_track() {
    let Some((dir, path, sequence_id, _track_id, _asset_id)) =
        create_project_with_three_second_body("render_verify_muted_tail")
    else {
        return;
    };

    let audio_source = dir.path().join("tail_tone.wav");
    if !create_sample_audio(&audio_source) {
        return;
    }
    let audio_asset_id = run_cli_ok(&[
        "asset",
        "import",
        "--path",
        &path,
        "--file",
        audio_source.to_str().unwrap(),
    ])["createdIds"][0]
        .as_str()
        .unwrap()
        .to_string();

    let added = run_cli_ok(&[
        "timeline",
        "add-track",
        "--path",
        &path,
        "--kind",
        "audio",
        "--name",
        "Audio 2",
    ]);
    let audio_track_id = added["createdIds"][0].as_str().unwrap().to_string();

    run_cli_ok(&[
        "timeline",
        "insert",
        "--path",
        &path,
        "--asset",
        &audio_asset_id,
        "--track",
        &audio_track_id,
        "--at",
        "3.0",
    ]);

    // Muting the track takes it out of the render. The clip stays on the
    // timeline, so the editing extent still runs past 3s while nothing the
    // export writes does.
    run_cli_ok(&[
        "command",
        "execute",
        "--path",
        &path,
        "--type",
        "ToggleTrackMute",
        "--payload",
        &format!(r#"{{"sequenceId":"{sequence_id}","trackId":"{audio_track_id}","muted":true}}"#),
    ]);

    assert!(
        timeline_program_end_sec(&path) > 3.5,
        "the muted clip must still be on the timeline for this to mean anything"
    );

    let render_path = dir.path().join("muted-tail.mp4");
    let result = render_proxy_to(&path, &render_path);

    assert_eq!(result["durationSec"], 3.0);
    if let Some(measured) = ffprobe_duration_secs(&render_path) {
        assert!(
            (measured - 3.0).abs() < 0.5,
            "a muted track is not in the output, measured {measured}s"
        );
    }

    let duration = verify_duration_check(&path, &render_path);
    assert_eq!(
        duration["status"], "passed",
        "the render stops where the export does, so nothing is missing: {duration}"
    );
}

// =============================================================================
// verify: objectively broken renders
// =============================================================================
//
// Every fixture below is a deliverable that measures perfectly and is still
// wrong: no picture at all, the wrong frame shape, a picture that never moves,
// a program that is mostly black. Our own export pipeline cannot produce them,
// so they are synthesised with FFmpeg and handed to the real `verify` binary.
// Each one used to come back `"status": "ok", "passed": true`, exit 0.
//
// The project side stays FFmpeg-free: the dummy asset yields a 10s clip, so
// every fixture is 10s and the render-length check has nothing to say.

/// Length of every broken-render fixture, matching the dummy clip on the
/// timeline so `render.duration_mismatch` stays out of the way.
const BROKEN_RENDER_SECONDS: u32 = 10;

/// Writes a media file with FFmpeg, returning `false` when it cannot be made.
///
/// Returning rather than failing keeps these guards skippable on a machine
/// without a media toolchain, exactly like the render tests above.
fn synthesize_media(path: &std::path::Path, args: &[&str], encode_video: bool) -> bool {
    let Some(ffmpeg_path) = system_ffmpeg_path() else {
        eprintln!("Skipping broken-render test: ffmpeg unavailable");
        return false;
    };

    let mut command = Command::new(&ffmpeg_path);
    command.arg("-y").args(args);

    if encode_video {
        let Some(encoder) = preferred_video_encoder(&ffmpeg_path) else {
            eprintln!("Skipping broken-render test: ffmpeg lacks a supported video encoder");
            return false;
        };
        command.args(["-c:v", encoder]);
        if encoder == "libx264" {
            command.args(["-pix_fmt", "yuv420p"]);
        }
    }

    let status = command
        .arg(path)
        .status()
        .expect("Failed to run ffmpeg for a broken-render fixture");
    if !status.success() {
        eprintln!("Skipping broken-render test: ffmpeg could not write {path:?}");
    }
    status.success()
}

/// A render that dropped the video stream: an attenuated tone and nothing else.
fn create_audio_only_render(path: &std::path::Path) -> bool {
    synthesize_media(
        path,
        &[
            "-f",
            "lavfi",
            "-i",
            &format!("sine=frequency=440:sample_rate=44100:duration={BROKEN_RENDER_SECONDS}"),
            "-af",
            "volume=0.25",
        ],
        false,
    )
}

/// A render in the wrong frame shape: a vertical picture for a 16:9 canvas.
fn create_vertical_render(path: &std::path::Path) -> bool {
    synthesize_media(
        path,
        &[
            "-f",
            "lavfi",
            "-i",
            &format!("testsrc=size=480x854:rate=30:duration={BROKEN_RENDER_SECONDS}"),
        ],
        true,
    )
}

/// A render that stalled: one grey frame held for the whole program.
///
/// Grey rather than black so the finding under test is the frozen picture and
/// not the black one.
fn create_frozen_render(path: &std::path::Path) -> bool {
    synthesize_media(
        path,
        &[
            "-f",
            "lavfi",
            "-i",
            &format!("color=c=gray:s=320x180:r=30:d={BROKEN_RENDER_SECONDS}"),
        ],
        true,
    )
}

/// A render that is black for three separate fifths of its length.
///
/// Sixty per cent of the program is missing picture while no single stretch
/// covers half of it — the shape that used to be graded as three harmless
/// fades.
fn create_intermittently_black_render(path: &std::path::Path) -> bool {
    const BLACK: &str = "color=c=black:s=320x180:r=30:d=2";
    const WHITE: &str = "color=c=white:s=320x180:r=30:d=2";

    synthesize_media(
        path,
        &[
            "-f",
            "lavfi",
            "-i",
            BLACK,
            "-f",
            "lavfi",
            "-i",
            WHITE,
            "-f",
            "lavfi",
            "-i",
            BLACK,
            "-f",
            "lavfi",
            "-i",
            WHITE,
            "-f",
            "lavfi",
            "-i",
            BLACK,
            "-filter_complex",
            "[0:v][1:v][2:v][3:v][4:v]concat=n=5:v=1:a=0[v]",
            "-map",
            "[v]",
        ],
        true,
    )
}

/// Runs `verify --file` over a broken render and returns the parsed report.
fn verify_broken_render(path: &str, render: &std::path::Path) -> (serde_json::Value, i32) {
    let (stdout, stderr, code) =
        run_cli_exit(&["verify", "--path", path, "--file", render.to_str().unwrap()]);
    assert_ne!(
        code, 2,
        "verify itself must run.\nstdout: {stdout}\nstderr: {stderr}"
    );

    let report: serde_json::Value =
        serde_json::from_str(&stdout).unwrap_or_else(|error| panic!("{error}\n{stdout}"));
    (report, code)
}

/// Feature: Verify against a rendered file
/// Scenario: should fail a render that carries no picture at all
#[test]
fn test_verify_fails_a_render_with_no_video_stream() {
    let (dir, path, _asset_id, _track_id) =
        create_project_with_placed_dummy("verify_missing_video");

    let render_path = dir.path().join("audio-only.wav");
    if !create_audio_only_render(&render_path) {
        return;
    }

    let (report, code) = verify_broken_render(&path, &render_path);
    assert_eq!(
        code, 1,
        "a video sequence rendered without video is not the deliverable: {report}"
    );
    assert_eq!(report["passed"], false);

    let missing = find_check(&report, "render.missing_video");
    assert_eq!(missing["status"], "failed");
    assert_eq!(missing["severity"], "error");
    assert_eq!(missing["metrics"]["pictureClipCount"], 1);
    assert_eq!(missing["metrics"]["hasAudioStream"], true);

    // The picture checks must say they had nothing to look at rather than
    // report the picture they never saw as clean.
    for picture_check in ["render.black_frames", "render.frozen"] {
        let check = find_check(&report, picture_check);
        assert_eq!(
            check["status"], "skipped",
            "{picture_check} must not pass over a file with no picture: {check}"
        );
        assert_eq!(check["passed"], false);
    }

    assert!(
        report["measurements"]["videoStream"].is_null(),
        "the stream table must show the missing picture: {}",
        report["measurements"]
    );
}

/// Feature: Verify against a rendered file
/// Scenario: should fail a render delivered in the wrong frame shape
#[test]
fn test_verify_fails_a_render_in_the_wrong_aspect_ratio() {
    let (dir, path, _asset_id, _track_id) = create_project_with_placed_dummy("verify_wrong_aspect");

    let render_path = dir.path().join("vertical.mp4");
    if !create_vertical_render(&render_path) {
        return;
    }

    let (report, code) = verify_broken_render(&path, &render_path);
    assert_eq!(
        code, 1,
        "a vertical render of a 16:9 sequence is cropped or barred, not the edit: {report}"
    );

    let resolution = find_check(&report, "render.resolution_mismatch");
    assert_eq!(resolution["status"], "failed");
    assert_eq!(resolution["severity"], "error");

    let shape = &resolution["violations"][0];
    assert_eq!(shape["severity"], "error");
    assert_eq!(shape["metrics"]["fileWidth"], 480);
    assert_eq!(shape["metrics"]["fileHeight"], 854);
    assert_eq!(shape["metrics"]["canvasWidth"], 1920);

    assert_eq!(report["measurements"]["videoStream"]["width"], 480);
}

/// Feature: Verify against a rendered file
/// Scenario: should fail a render whose picture never moves
#[test]
fn test_verify_fails_a_frozen_render() {
    let (dir, path, _asset_id, _track_id) = create_project_with_placed_dummy("verify_frozen");

    let render_path = dir.path().join("frozen.mp4");
    if !create_frozen_render(&render_path) {
        return;
    }

    let (report, code) = verify_broken_render(&path, &render_path);
    assert_eq!(
        code, 1,
        "a program that never moves is a stalled render: {report}"
    );

    let frozen = find_check(&report, "render.frozen");
    assert_eq!(frozen["status"], "failed");
    assert_eq!(frozen["severity"], "error");

    let finding = &frozen["violations"][0];
    assert!(
        finding["metrics"]["programFraction"].as_f64().unwrap() >= 0.5,
        "expected most of the program to be frozen: {finding}"
    );
}

/// Feature: Verify against a rendered file
/// Scenario: should fail a render that is black in several separate stretches
///
/// Regression: the "black covers half the program" rule was applied to one
/// range at a time, so three dark fifths — sixty per cent of the deliverable —
/// were graded as three harmless fades and the run exited zero.
#[test]
fn test_verify_fails_a_render_black_across_several_ranges() {
    let (dir, path, _asset_id, _track_id) =
        create_project_with_placed_dummy("verify_scattered_black");

    let render_path = dir.path().join("intermittent-black.mp4");
    if !create_intermittently_black_render(&render_path) {
        return;
    }

    let (report, code) = verify_broken_render(&path, &render_path);
    assert_eq!(
        code, 1,
        "sixty per cent of the program is black, however it is split up: {report}"
    );

    let black = find_check(&report, "render.black_frames");
    assert_eq!(black["status"], "failed");
    assert_eq!(black["severity"], "error");

    let findings = black["violations"].as_array().expect("black findings");
    assert!(
        findings.len() >= 2,
        "the fixture must produce several separate black ranges, got: {black}"
    );

    for finding in findings {
        assert!(
            finding["metrics"]["programFraction"].as_f64().unwrap() < 0.5,
            "no single range may cross the threshold on its own, or this proves nothing: {finding}"
        );
        assert!(
            finding["metrics"]["programFractionTotal"].as_f64().unwrap() >= 0.5,
            "the total is what makes the render broken: {finding}"
        );
        assert_eq!(finding["severity"], "error");
    }
}

#[test]
fn test_verify_reports_a_missing_render_file_as_a_tool_failure() {
    let (_dir, path, _asset_id, _track_id) =
        create_project_with_placed_dummy("verify_missing_file");

    let (_stdout, stderr, code) = run_cli_exit(&[
        "verify",
        "--path",
        &path,
        "--file",
        "definitely-not-here.mp4",
    ]);

    assert_eq!(code, 2);
    assert!(
        stderr.contains("does not exist"),
        "expected a missing-file error, got: {stderr}"
    );
}

// =============================================================================
// Agent Perception Loop Regression Guard
// =============================================================================

/// Returns the first shot boundary strictly inside `(0, program_end)`.
///
/// A single-shot result has no interior cut, so callers get `None` and decide
/// their own fallback rather than splitting at 0 or at the very end.
fn first_interior_shot_boundary(shots: &serde_json::Value, program_end: f64) -> Option<f64> {
    const EDGE_MARGIN_SEC: f64 = 0.1;

    shots["shots"]
        .as_array()?
        .iter()
        .filter_map(|shot| shot["startSec"].as_f64())
        .find(|start| *start > EDGE_MARGIN_SEC && *start < program_end - EDGE_MARGIN_SEC)
}

/// Total program length of the active sequence, from the CLI's own clip listing.
fn timeline_program_end_sec(project_path: &str) -> f64 {
    let clips = run_cli_ok(&["timeline", "clips", "--path", project_path]);
    clips["clips"]
        .as_array()
        .expect("clips array")
        .iter()
        .map(|clip| {
            clip["timelineInSec"].as_f64().unwrap_or(0.0)
                + clip["durationSec"].as_f64().unwrap_or(0.0)
        })
        .fold(0.0_f64, f64::max)
}

// This is THE single end-to-end guard for the headless perception
// loop an external agent drives: perceive (shots + silence) -> edit informed by
// what was perceived -> render a proxy -> look at the result (still + contact
// sheet) -> verify the render. It drives the real CLI binary and asserts only
// on CLI-observable JSON and on files the CLI claims to have written, so it
// stays valid as the internals move.
//
// It deliberately does NOT cover: detector accuracy, codec quality, or the
// per-verb argument surface. Those have their own focused tests above. This
// guard exists only to catch a SILENT break of the whole agent loop. It skips
// cleanly (returns, does not fail) when FFmpeg is absent.
#[test]
fn test_agent_perception_loop_end_to_end() {
    // 1. Create the project and import a fixture that has both a hard cut and
    //    a silent window.
    let Some((dir, path, asset_id)) = create_project_with_media(
        "agent_loop_e2e",
        "agent_loop_source.mp4",
        create_sample_video_with_scene_change_and_audio,
    ) else {
        eprintln!("Skipping agent-loop E2E test: ffmpeg fixture unavailable");
        return;
    };

    // 2. Perceive: shot detection.
    let shots = run_cli_ok(&["analysis", "shots", "--path", &path, "--id", &asset_id]);
    assert_eq!(shots["status"], "ok");
    assert!(
        shots["shotCount"].as_u64().unwrap() >= 1,
        "Expected at least one detected shot, got {}",
        shots["shotCount"]
    );
    assert!(shots["totalDurationSec"].as_f64().unwrap() > 0.0);

    // 3. Perceive: silence detection over the same asset.
    let silence = run_cli_ok(&["analysis", "silence", "--path", &path, "--id", &asset_id]);
    assert_eq!(silence["status"], "ok");
    let regions = silence["regions"].as_array().unwrap();
    assert!(
        !regions.is_empty(),
        "Expected the muted 1s-3s window to be reported, got {silence}"
    );
    assert!(
        regions.iter().any(|region| {
            region["startSec"].as_f64().unwrap() >= 0.5 && region["endSec"].as_f64().unwrap() <= 3.5
        }),
        "Expected a silent region inside the muted window, got {regions:?}"
    );

    // 4. Edit: place the asset, then cut it where perception said the shot
    //    changes.
    let tracks = run_cli_ok(&["timeline", "tracks", "--path", &path]);
    let track_id = tracks["tracks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|track| track["kind"] == "Video")
        .and_then(|track| track["id"].as_str())
        .unwrap()
        .to_string();
    run_cli_ok(&[
        "timeline", "insert", "--path", &path, "--asset", &asset_id, "--track", &track_id, "--at",
        "0.0",
    ]);

    let clips = run_cli_ok(&["timeline", "clips", "--path", &path]);
    assert_eq!(clips["count"], 1);
    let clip_id = clips["clips"][0]["id"].as_str().unwrap().to_string();

    // `asset import` does not probe duration, so the placed clip carries the
    // default length. Perception is what tells the agent how long the media
    // actually is; trim to it before cutting so the edit stays inside the media.
    let media_end = shots["totalDurationSec"].as_f64().unwrap();
    run_cli_ok(&[
        "timeline",
        "trim",
        "--path",
        &path,
        "--clip",
        &clip_id,
        "--track",
        &track_id,
        "--source-in",
        "0.0",
        "--source-out",
        &media_end.to_string(),
    ]);

    let program_end = timeline_program_end_sec(&path);
    assert!(
        (program_end - media_end).abs() < 1e-6,
        "Expected the trim to shrink the program to the perceived media length, got {program_end}"
    );

    // The fixture cuts at 2s; fall back to it when the detector merged the two
    // shots so the loop still exercises a real split.
    let split_at = first_interior_shot_boundary(&shots, program_end).unwrap_or(2.0);
    let split = run_cli_ok(&[
        "timeline",
        "split",
        "--path",
        &path,
        "--clip",
        &clip_id,
        "--track",
        &track_id,
        "--at",
        &split_at.to_string(),
    ]);
    assert_eq!(split["status"], "ok");

    let clips = run_cli_ok(&["timeline", "clips", "--path", &path]);
    assert_eq!(
        clips["count"], 2,
        "Expected the shot-informed split to yield two clips: {clips}"
    );

    // 5. Render a proxy of the edit, streaming progress to stderr.
    let proxy_path = dir.path().join("agent_loop_proxy.mp4");
    let (stdout, stderr, success) = run_cli(&[
        "render",
        "start",
        "--path",
        &path,
        "--proxy",
        "--progress",
        "--output",
        proxy_path.to_str().unwrap(),
    ]);
    assert!(
        success,
        "Proxy render failed.\nstdout: {stdout}\nstderr: {stderr}"
    );
    let render: serde_json::Value = serde_json::from_str(&stdout)
        .unwrap_or_else(|error| panic!("Failed to parse proxy render output: {error}\n{stdout}"));
    assert_eq!(render["status"], "ok");
    assert_eq!(render["preset"], "proxy_480p");
    assert!(proxy_path.exists(), "Expected the proxy render to exist");
    assert!(
        proxy_path.metadata().unwrap().len() > 0,
        "Expected the proxy render to be non-empty"
    );
    assert!(
        stderr
            .lines()
            .filter_map(|line| serde_json::from_str::<serde_json::Value>(line.trim()).ok())
            .any(|value| value["type"] == "progress"),
        "Expected NDJSON render progress on stderr, got: {stderr}"
    );

    // 6. Look: a single still from the second half of the edit.
    let still_path = dir.path().join("agent_loop_still.png");
    let mid_second_clip = (split_at + program_end) / 2.0;
    let still = run_cli_ok(&[
        "frame",
        "extract",
        "--path",
        &path,
        "--time",
        &mid_second_clip.to_string(),
        "--out",
        still_path.to_str().unwrap(),
    ]);
    assert_eq!(still["status"], "ok");
    assert_eq!(still["count"], 1);
    assert!(still["frames"][0]["clipId"].is_string());
    assert!(still_path.exists(), "Expected the extracted still to exist");
    assert!(
        still_path.metadata().unwrap().len() > 0,
        "Expected the extracted still to be non-empty"
    );

    // 7. Look: a contact sheet spanning the whole program, so a VLM can map
    //    cells back to timecodes.
    let sheet_path = dir.path().join("agent_loop_sheet.jpg");
    let sheet = run_cli_ok(&[
        "frame",
        "extract",
        "--path",
        &path,
        "--grid",
        "2x2",
        "--between",
        "0",
        &program_end.to_string(),
        "--format",
        "jpeg",
        "--out",
        sheet_path.to_str().unwrap(),
    ]);
    assert_eq!(sheet["status"], "ok");
    assert_eq!(sheet["sheet"]["cols"], 2);
    assert_eq!(sheet["sheet"]["rows"], 2);
    assert_eq!(sheet["sheet"]["cells"].as_array().unwrap().len(), 4);
    assert!(sheet_path.exists(), "Expected the contact sheet to exist");
    assert!(
        sheet_path.metadata().unwrap().len() > 0,
        "Expected the contact sheet to be non-empty"
    );

    // 8. Verify the rendered proxy. A healthy project must clear the critical
    //    threshold, and both halves of the report have to be present.
    let (stdout, stderr, code) = run_cli_exit(&[
        "verify",
        "--path",
        &path,
        "--file",
        proxy_path.to_str().unwrap(),
        "--fail-on",
        "critical",
    ]);
    assert_eq!(
        code, 0,
        "A healthy project must clear --fail-on critical.\nstdout: {stdout}\nstderr: {stderr}"
    );

    let report: serde_json::Value = serde_json::from_str(&stdout)
        .unwrap_or_else(|error| panic!("Failed to parse verify report: {error}\n{stdout}"));
    assert_eq!(report["summary"]["critical"], 0);
    assert_eq!(report["target"]["measured"], true);
    assert_eq!(report["measurements"]["measured"], true);
    assert!(report["measurements"]["durationSec"].as_f64().unwrap() > 0.0);

    let checks = report["checks"].as_array().expect("checks array");
    assert!(
        checks
            .iter()
            .any(|check| check["category"] == "structural" && check["status"] != "skipped"),
        "Expected at least one structural check to have run: {report}"
    );
    assert!(
        checks
            .iter()
            .any(|check| check["category"] == "rendered" && check["status"] != "skipped"),
        "Expected at least one rendered check to have run once a file was measured: {report}"
    );

    // The split closed onto the following clip, so the edit must be gapless.
    let gap = find_check(&report, "timeline.gap");
    assert_eq!(gap["status"], "passed");
    assert_eq!(gap["violationCount"], 0);
}

// ============================================================================
// Curated style packs
// ============================================================================

#[test]
fn test_packs_list_returns_both_registries() {
    let all = run_cli_ok(&["packs", "list"]);
    assert_eq!(all["status"], "ok");
    assert_eq!(all["kind"], "all");

    let packs = all["packs"].as_array().expect("packs array");
    assert_eq!(all["count"].as_u64().unwrap() as usize, packs.len());

    let caption_ids: Vec<&str> = packs
        .iter()
        .filter(|pack| pack["kind"] == "caption")
        .filter_map(|pack| pack["id"].as_str())
        .collect();
    let transition_ids: Vec<&str> = packs
        .iter()
        .filter(|pack| pack["kind"] == "transition")
        .filter_map(|pack| pack["id"].as_str())
        .collect();

    assert!(caption_ids.contains(&"clean-minimal"), "{caption_ids:?}");
    assert!(caption_ids.contains(&"boxed-contrast"), "{caption_ids:?}");
    assert!(
        transition_ids.contains(&"dissolve-standard"),
        "{transition_ids:?}"
    );
    assert!(transition_ids.contains(&"wipe-left"), "{transition_ids:?}");

    // Every entry carries the fields an agent needs to choose without guessing.
    for pack in packs {
        assert!(pack["id"].as_str().is_some_and(|id| !id.is_empty()));
        assert!(pack["description"]
            .as_str()
            .is_some_and(|desc| !desc.is_empty()));
        match pack["kind"].as_str() {
            Some("caption") => {
                assert!(pack["style"].is_object(), "{pack}");
                assert!(pack["position"].is_object(), "{pack}");
            }
            Some("transition") => {
                assert!(pack["effectType"].is_string(), "{pack}");
                assert!(pack["params"].is_object(), "{pack}");
            }
            other => panic!("unexpected pack kind {other:?}"),
        }
    }
}

#[test]
fn test_packs_list_filters_by_kind() {
    let captions = run_cli_ok(&["packs", "list", "--kind", "caption"]);
    assert_eq!(captions["kind"], "caption");
    assert!(captions["packs"]
        .as_array()
        .expect("packs")
        .iter()
        .all(|pack| pack["kind"] == "caption"));

    let transitions = run_cli_ok(&["packs", "list", "--kind", "transition"]);
    assert_eq!(transitions["kind"], "transition");
    assert!(transitions["packs"]
        .as_array()
        .expect("packs")
        .iter()
        .all(|pack| pack["kind"] == "transition"));

    let (_stdout, stderr) = run_cli_err(&["packs", "list", "--kind", "nonsense"]);
    assert!(
        stderr.contains("caption") && stderr.contains("transition"),
        "clap must list the valid kinds, got: {stderr}"
    );
}

#[test]
fn test_caption_style_pack_applies_and_is_overridable() {
    let dir = create_temp_project("caption_style_pack_test");
    let path = project_path(&dir, "caption_style_pack_test");

    run_cli_ok(&[
        "caption",
        "add",
        "--path",
        &path,
        "--text",
        "Packed caption",
        "--start",
        "0",
        "--end",
        "2",
        "--style-pack",
        "boxed-contrast",
    ]);

    let list = run_cli_ok(&["caption", "list", "--path", &path]);
    let caption = &list["captions"][0];
    let caption_id = caption["id"].as_str().unwrap().to_string();
    assert_eq!(caption["style"]["fontFamily"], "Arial");
    assert_eq!(caption["style"]["fontSize"], 48);
    assert_eq!(caption["style"]["backgroundColor"]["a"], 180);
    assert_eq!(caption["position"]["type"], "preset");
    assert_eq!(caption["position"]["vertical"], "bottom");
    assert_eq!(caption["position"]["marginPercent"], 10.0);

    // A pack is a base layer, not a lock: the explicit size wins and everything
    // else stays packed.
    run_cli_ok(&[
        "caption",
        "update",
        "--path",
        &path,
        "--id",
        &caption_id,
        "--style-pack",
        "boxed-contrast",
        "--style-json",
        r##"{"fontSize":96}"##,
    ]);

    let restyled = run_cli_ok(&["caption", "list", "--path", &path]);
    assert_eq!(restyled["captions"][0]["style"]["fontSize"], 96);
    assert_eq!(
        restyled["captions"][0]["style"]["backgroundColor"]["a"],
        180
    );
}

#[test]
fn test_caption_style_pack_rejects_unknown_id_with_the_valid_list() {
    let dir = create_temp_project("caption_style_pack_error_test");
    let path = project_path(&dir, "caption_style_pack_error_test");

    let (_stdout, stderr) = run_cli_err(&[
        "caption",
        "add",
        "--path",
        &path,
        "--text",
        "Bad pack",
        "--start",
        "0",
        "--end",
        "2",
        "--style-pack",
        "not-a-pack",
    ]);

    assert!(stderr.contains("not-a-pack"), "{stderr}");
    assert!(stderr.contains("clean-minimal"), "{stderr}");
    assert!(stderr.contains("boxed-contrast"), "{stderr}");
}

#[test]
fn test_command_execute_accepts_style_pack_and_recipe() {
    let dir = create_temp_project("pack_command_execute_test");
    let path = project_path(&dir, "pack_command_execute_test");

    let info = run_cli_ok(&["timeline", "info", "--path", &path]);
    let sequence_id = info["sequenceId"].as_str().unwrap().to_string();

    let track = run_cli_ok(&[
        "timeline",
        "add-track",
        "--path",
        &path,
        "--kind",
        "caption",
        "--name",
        "Captions",
    ]);
    let caption_track_id = track["createdIds"][0].as_str().unwrap().to_string();

    let payload = serde_json::json!({
        "sequenceId": sequence_id,
        "trackId": caption_track_id,
        "text": "From command execute",
        "startSec": 0.0,
        "endSec": 2.0,
        "stylePack": "yellow-classic",
    })
    .to_string();

    run_cli_ok(&[
        "command",
        "execute",
        "--path",
        &path,
        "--type",
        "CreateCaption",
        "--payload",
        &payload,
    ]);

    let list = run_cli_ok(&["caption", "list", "--path", &path]);
    assert_eq!(list["captions"][0]["style"]["color"]["r"], 255);
    assert_eq!(list["captions"][0]["style"]["color"]["b"], 0);

    // The recipe half of the same chokepoint: validate without a project write.
    let effect_payload = serde_json::json!({
        "sequenceId": sequence_id,
        "trackId": caption_track_id,
        "clipId": "clip_placeholder",
        "recipe": "dissolve-soft",
    })
    .to_string();
    let validated = run_cli_ok(&[
        "command",
        "validate",
        "--type",
        "AddEffect",
        "--payload",
        &effect_payload,
    ]);
    assert_eq!(validated["status"], "ok");
    assert_eq!(validated["commandType"], "AddEffect");

    let bad_payload = serde_json::json!({
        "sequenceId": sequence_id,
        "trackId": caption_track_id,
        "clipId": "clip_placeholder",
        "recipe": "not-a-recipe",
    })
    .to_string();
    let (stdout, stderr, _success) = run_cli(&[
        "command",
        "validate",
        "--type",
        "AddEffect",
        "--payload",
        &bad_payload,
    ]);
    let combined = format!("{stdout}{stderr}");
    assert!(combined.contains("dissolve-standard"), "{combined}");
}

#[test]
fn test_caption_style_pack_never_overrides_an_explicit_placement() {
    let dir = create_temp_project("caption_pack_placement_test");
    let path = project_path(&dir, "caption_pack_placement_test");

    // A --position-json without a `type` is a custom anchor (the validator
    // itself reads it that way), so the pack styles the caption while the
    // caller places it.
    let placed = run_cli_ok(&[
        "caption",
        "add",
        "--path",
        &path,
        "--text",
        "Custom placed",
        "--start",
        "0",
        "--end",
        "2",
        "--style-pack",
        "clean-minimal",
        "--position-json",
        r##"{"xPercent":25,"yPercent":80}"##,
    ]);
    let placed_id = placed["createdIds"][0].as_str().unwrap().to_string();

    // --position names a vertical anchor only, so a pack lifted clear of
    // platform UI keeps its own margin instead of dropping to a synthesized
    // default.
    let anchored = run_cli_ok(&[
        "caption",
        "add",
        "--path",
        &path,
        "--text",
        "Anchored",
        "--start",
        "3",
        "--end",
        "5",
        "--style-pack",
        "shorts-bold-outline",
        "--position",
        "bottom",
    ]);
    let anchored_id = anchored["createdIds"][0].as_str().unwrap().to_string();

    let find = |list: &serde_json::Value, id: &str| -> serde_json::Value {
        list["captions"]
            .as_array()
            .expect("captions")
            .iter()
            .find(|caption| caption["id"] == id)
            .expect("caption present")
            .clone()
    };

    let list = run_cli_ok(&["caption", "list", "--path", &path]);

    let placed_caption = find(&list, &placed_id);
    assert_eq!(placed_caption["position"]["xPercent"], 25.0);
    assert_eq!(placed_caption["position"]["yPercent"], 80.0);
    assert!(
        placed_caption["position"].get("marginPercent").is_none(),
        "a custom anchor must not carry the pack's preset keys: {}",
        placed_caption["position"]
    );
    assert_eq!(placed_caption["style"]["fontSize"], 48);

    let anchored_caption = find(&list, &anchored_id);
    assert_eq!(anchored_caption["position"]["vertical"], "bottom");
    assert_eq!(anchored_caption["position"]["marginPercent"], 18.0);

    // Restyling is not a move.
    run_cli_ok(&[
        "caption",
        "update",
        "--path",
        &path,
        "--id",
        &placed_id,
        "--style-pack",
        "boxed-contrast",
    ]);

    let restyled = find(
        &run_cli_ok(&["caption", "list", "--path", &path]),
        &placed_id,
    );
    assert_eq!(restyled["position"]["xPercent"], 25.0);
    assert_eq!(restyled["position"]["yPercent"], 80.0);
    assert_eq!(restyled["style"]["backgroundColor"]["a"], 180);
}
