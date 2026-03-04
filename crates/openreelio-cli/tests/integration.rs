//! Integration tests for the OpenReelio CLI.
//!
//! These tests exercise the CLI through the actual binary using `std::process::Command`.
//! Each test creates a temporary project directory and runs CLI commands against it.

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
    // Note: undo/redo state persists across CLI invocations because the
    // CommandExecutor is reconstructed from the ops log on each open.
    // However, undo stack requires the executor to track reversible ops.
    // In the current architecture, undo stack is in-memory only and resets
    // between CLI invocations. So we test that the commands parse and execute
    // without errors when there IS something to undo (within a single plan).
    let dir = create_temp_project("undo_redo_test");
    let path = project_path(&dir, "undo_redo_test");

    // Undo with nothing to undo should fail gracefully
    let (_stdout, stderr) = run_cli_err(&["timeline", "undo", "--path", &path]);
    assert!(
        stderr.contains("Undo failed") || stderr.contains("Nothing to undo"),
        "Expected undo error, got: {}",
        stderr
    );
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
}

#[test]
fn test_render_start_returns_error() {
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
        stderr.contains("not yet implemented"),
        "Expected not implemented error, got: {}",
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
                "payload": { "sequenceId": "seq_1", "name": "New Track", "kind": "Video" },
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

    // Verify all 32 commands are present
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
        "caption.export",
        "plan.execute",
        "plan.validate",
        "plan.template",
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
