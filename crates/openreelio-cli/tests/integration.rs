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

// =============================================================================
// Plan Commands
// =============================================================================

#[test]
fn test_plan_template_split_and_move() {
    let result = run_cli_ok(&["plan", "template", "--template-type", "split-and-move"]);
    assert_eq!(result["id"], "plan_001");
    let steps = result["steps"].as_array().unwrap();
    assert_eq!(steps.len(), 2);
    assert_eq!(steps[0]["commandType"], "SplitClip");
    assert_eq!(steps[1]["commandType"], "MoveClip");
}

#[test]
fn test_plan_template_multi_trim() {
    let result = run_cli_ok(&["plan", "template", "--template-type", "multi-trim"]);
    assert_eq!(result["id"], "plan_002");
}

#[test]
fn test_plan_template_invalid() {
    let (_stdout, stderr) = run_cli_err(&["plan", "template", "--template-type", "nonexistent"]);
    assert!(
        stderr.contains("Unknown template type"),
        "Expected template type error, got: {}",
        stderr
    );
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
        "state.snapshot",
        "render.presets",
        "render.start",
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
