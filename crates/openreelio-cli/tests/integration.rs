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

/// The FFmpeg the CLI under test would actually use.
///
/// Resolving PATH alone made every render test skip itself on any machine — CI
/// included — where FFmpeg is bundled next to the binary or installed through
/// the in-app manager rather than being on PATH. Those runs reported green
/// while executing nothing. This mirrors `ffmpeg_env::resolve_options`: the
/// executable's own directory is the only resource root, then the managed
/// install, then dev-mode binaries, then PATH.
fn available_ffmpeg_path() -> Option<PathBuf> {
    let resolved = available_ffmpeg_info().map(|info| info.ffmpeg_path);

    if resolved.is_none() {
        skip_without_ffmpeg("no FFmpeg could be resolved for the CLI under test");
    }

    resolved
}

/// The same resolution, keeping both binaries.
///
/// Tests that drive the render engine in-process rather than through the CLI
/// build an `FFmpegRunner`, which needs ffprobe as well as ffmpeg.
fn available_ffmpeg_info() -> Option<openreelio_core::ffmpeg::FFmpegInfo> {
    let resource_roots = cli_bin()
        .parent()
        .map(std::path::Path::to_path_buf)
        .into_iter()
        .collect();

    openreelio_core::ffmpeg::resolve_ffmpeg(&openreelio_core::ffmpeg::FFmpegResolveOptions {
        resource_roots,
        // The CLI is launched with the overrides cleared, so the tests resolve
        // without them too.
        use_env: false,
        ..Default::default()
    })
    .ok()
}

/// Whether a missing FFmpeg must fail the run rather than quietly skip it.
///
/// A render test that skips itself still reports green, which is how the CLI
/// e2e suite could sit unexercised in CI. The workflow sets
/// `REQUIRE_FFMPEG_TESTS=1` on the job that installs FFmpeg, so a broken
/// install shows up as a failure there while a developer without FFmpeg on
/// their machine keeps the quiet skip.
fn ffmpeg_tests_are_required() -> bool {
    std::env::var("REQUIRE_FFMPEG_TESTS").is_ok_and(|value| {
        !value.is_empty() && value != "0" && !value.eq_ignore_ascii_case("false")
    })
}

/// Records a skip, or fails when FFmpeg was supposed to be available.
#[track_caller]
fn skip_without_ffmpeg(reason: &str) {
    assert!(
        !ffmpeg_tests_are_required(),
        "REQUIRE_FFMPEG_TESTS is set, so this test must run, but {reason}"
    );
    eprintln!("Skipping test: {reason}");
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
    let Some(ffmpeg_path) = available_ffmpeg_path() else {
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
    let Some(ffmpeg_path) = available_ffmpeg_path() else {
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
    let Some(ffmpeg_path) = available_ffmpeg_path() else {
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
    let Some(ffmpeg_path) = available_ffmpeg_path() else {
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
    let Some(ffmpeg_path) = available_ffmpeg_path() else {
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

/// Generates a solid-colour clip with a constant tone, long enough to have
/// handles either side of the range an edit uses.
///
/// A real transition needs unused source media on both sides of the cut, so a
/// transition fixture cannot be trimmed to its own length the way the other
/// render fixtures are. The colour is flat so a blended frame is unmistakably
/// neither source, and the tone is a single frequency at a quarter of full
/// scale so two of them can sum through a crossfade without clipping.
fn create_solid_tone_source(
    path: &std::path::Path,
    colour: &str,
    frequency: u32,
    duration_secs: u32,
) -> bool {
    let Some(ffmpeg_path) = available_ffmpeg_path() else {
        skip_without_ffmpeg("no FFmpeg could be resolved to build the transition fixture");
        return false;
    };
    let Some(video_encoder) = preferred_video_encoder(&ffmpeg_path) else {
        skip_without_ffmpeg("ffmpeg lacks a supported video encoder for the transition fixture");
        return false;
    };
    if !ffmpeg_supports_encoder(&ffmpeg_path, "aac") {
        skip_without_ffmpeg("ffmpeg lacks the aac encoder needed by the transition fixture");
        return false;
    }

    let mut command = Command::new(ffmpeg_path);
    command.args([
        "-y",
        "-f",
        "lavfi",
        "-i",
        &format!("color=c={colour}:s=320x240:r=25:d={duration_secs}"),
        "-f",
        "lavfi",
        "-i",
        &format!("sine=frequency={frequency}:sample_rate=44100:duration={duration_secs}"),
        "-filter_complex",
        "[1:a]volume=0.25[a]",
        "-map",
        "0:v",
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
        .expect("Failed to generate transition fixture with ffmpeg");
    if !status.success() {
        skip_without_ffmpeg("ffmpeg could not generate the transition fixture");
    }
    status.success()
}

/// Averages the middle of one rendered frame down to a single brightness value.
///
/// A single pixel cannot see an `xfade`: FFmpeg's `dissolve` switches pixels
/// over at random rather than mixing them, so any one pixel is fully one shot or
/// fully the other all the way through. The *average* is what moves smoothly,
/// and it moves the same way for every `xfade` shape. Only the middle of the
/// frame is measured, so the letterbox bars a source of a different aspect ratio
/// leaves on the canvas cannot drag the reading toward black.
fn sample_rendered_mean_brightness(path: &std::path::Path, at_sec: f64) -> Option<u8> {
    let ffmpeg_path = available_ffmpeg_path()?;
    let output = Command::new(ffmpeg_path)
        .args(["-v", "error", "-ss", &at_sec.to_string(), "-i"])
        .arg(path)
        .args([
            "-vf",
            "crop=w=iw/2:h=ih/2,scale=1:1:flags=area,format=rgb24",
            "-frames:v",
            "1",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgb24",
            "-",
        ])
        .output()
        .ok()?;
    if !output.status.success() || output.stdout.len() < 3 {
        return None;
    }
    let sum: u32 = output.stdout[..3]
        .iter()
        .map(|channel| *channel as u32)
        .sum();
    Some((sum / 3) as u8)
}

/// Measures the mean volume, in dBFS, of one window of a rendered file's audio.
///
/// This is what proves a crossfade is constant power: `qsin` squares sum to one,
/// so summing the two branches through the master mix has to leave the level
/// where it was rather than dipping or doubling at the boundary.
fn measure_audio_mean_volume_db(
    path: &std::path::Path,
    start_sec: f64,
    duration_sec: f64,
) -> Option<f64> {
    let ffmpeg_path = available_ffmpeg_path()?;
    let output = Command::new(ffmpeg_path)
        .args([
            "-hide_banner",
            "-ss",
            &start_sec.to_string(),
            "-t",
            &duration_sec.to_string(),
            "-i",
        ])
        .arg(path)
        .args(["-map", "0:a", "-af", "volumedetect", "-f", "null", "-"])
        .output()
        .ok()?;

    let stderr = String::from_utf8_lossy(&output.stderr);

    // A failed measurement is not a quiet one. Without this, an ffmpeg that
    // could not open the file returns `None`, every caller `expect`s it, and the
    // panic blames a missing reading rather than the run that never happened.
    assert!(
        output.status.success(),
        "measuring {} at {start_sec}s failed: {stderr}",
        path.display()
    );

    // `volumedetect` reports on stderr, and prints once per instance - including
    // an empty one when the filter is torn down without frames. The last
    // reading with samples behind it is the measurement.
    stderr
        .lines()
        .filter_map(|line| line.split("mean_volume:").nth(1))
        .map(|value| value.trim().trim_end_matches(" dB").trim().to_string())
        .filter_map(|value| parse_volume_db(&value))
        .next_back()
}

/// Reads one `volumedetect` level, including the silence it reports as `-inf`.
///
/// `-inf dB` is a real measurement - it means the window held nothing at all -
/// and parsing it as "no reading" hides exactly the failure an audio assertion
/// is looking for. It is mapped onto a floor far below anything a fixture
/// produces so a caller can compare it numerically like any other level.
fn parse_volume_db(raw: &str) -> Option<f64> {
    const SILENCE_FLOOR_DB: f64 = -120.0;

    if raw.contains("inf") {
        return Some(if raw.starts_with('-') {
            SILENCE_FLOOR_DB
        } else {
            0.0
        });
    }
    raw.parse().ok()
}

/// One end of the spectrum, isolated far enough to measure a single tone.
///
/// The transition fixtures carry a 440Hz tone on one shot and 880Hz on the
/// other. A single octave is not much separation, so each filter is a cascade:
/// four two-pole stages put the far tone around 30dB down, which is deep enough
/// that it cannot move a reading taken to within a decibel. Whatever the cascade
/// costs *inside* the passband is a constant, and every assertion using this
/// compares a level against the same band's own steady state, so it cancels.
enum ToneBand {
    /// Keeps the 440Hz tone, rejects the 880Hz one.
    Low,
    /// Keeps the 880Hz tone, rejects the 440Hz one.
    High,
}

impl ToneBand {
    fn filter(&self) -> &'static str {
        match self {
            Self::Low => {
                "lowpass=f=550:poles=2,lowpass=f=550:poles=2,lowpass=f=550:poles=2,lowpass=f=550:poles=2"
            }
            Self::High => {
                "highpass=f=700:poles=2,highpass=f=700:poles=2,highpass=f=700:poles=2,highpass=f=700:poles=2"
            }
        }
    }
}

/// Measures one tone's own level over one window of a rendered file.
///
/// Measuring the *mix* cannot see a crossfade at all: two tones fading through
/// each other at constant power sum to the level they started at, which is the
/// same reading a hard cut produces and the same reading a fade with the wrong
/// curve produces. Only each tone's own envelope tells them apart.
///
/// The window is cut inside the filtergraph rather than by seeking the input, so
/// it is sample-exact - the windows this is used with are a tenth of a second
/// wide, and a keyframe-accurate input seek would miss them.
fn measure_tone_band_db(
    path: &std::path::Path,
    start_sec: f64,
    end_sec: f64,
    band: ToneBand,
) -> Option<f64> {
    let ffmpeg_path = available_ffmpeg_path()?;
    let output = Command::new(ffmpeg_path)
        .args(["-hide_banner", "-i"])
        .arg(path)
        .args([
            "-map",
            "0:a",
            "-af",
            &format!(
                "atrim=start={start_sec}:end={end_sec},{},volumedetect",
                band.filter()
            ),
            "-f",
            "null",
            "-",
        ])
        .output()
        .ok()?;

    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        output.status.success(),
        "measuring {} over {start_sec}..{end_sec}s failed: {stderr}",
        path.display()
    );

    stderr
        .lines()
        .filter_map(|line| line.split("mean_volume:").nth(1))
        .map(|value| value.trim().trim_end_matches(" dB").trim().to_string())
        .filter_map(|value| parse_volume_db(&value))
        .next_back()
}

/// The spread between the darkest and brightest luma in the middle of a frame.
///
/// A blend between two *flat* sources must itself be flat: every output pixel is
/// the same mix of the same two colours. This is what separates a real blend
/// from FFmpeg's `transition=dissolve`, which is not a blend at all - it picks
/// one source or the other per pixel by a random threshold, so a half-way
/// "dissolve" between flat black and flat white is full-range noise whose
/// *average* is mid-grey. An average-brightness assertion passes on both; only
/// the spread tells them apart.
fn sample_rendered_luma_spread(path: &std::path::Path, at_sec: f64) -> Option<u16> {
    let ffmpeg_path = available_ffmpeg_path()?;
    let output = Command::new(ffmpeg_path)
        .args(["-hide_banner", "-i"])
        .arg(path)
        .args([
            "-vf",
            &format!(
                "trim=start={at_sec}:end={},crop=w=iw/2:h=ih/2,signalstats,metadata=print",
                at_sec + 0.02
            ),
            "-f",
            "null",
            "-",
        ])
        .output()
        .ok()?;

    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        output.status.success(),
        "measuring the luma spread of {} at {at_sec}s failed: {stderr}",
        path.display()
    );

    let read = |key: &str| -> Option<u16> {
        stderr
            .lines()
            .filter_map(|line| line.split(key).nth(1))
            .filter_map(|value| value.trim().parse::<f64>().ok())
            .next()
            .map(|value| value.round() as u16)
    };

    Some(read("lavfi.signalstats.YMAX=")?.saturating_sub(read("lavfi.signalstats.YMIN=")?))
}

/// The FFprobe that ships with the FFmpeg the CLI under test would use.
///
/// Resolved the same way as [`available_ffmpeg_path`] so the measurement tools
/// are available wherever the CLI itself can render.
fn available_ffprobe_path() -> Option<PathBuf> {
    let resource_roots = cli_bin()
        .parent()
        .map(std::path::Path::to_path_buf)
        .into_iter()
        .collect();

    openreelio_core::ffmpeg::resolve_ffmpeg(&openreelio_core::ffmpeg::FFmpegResolveOptions {
        resource_roots,
        use_env: false,
        ..Default::default()
    })
    .ok()
    .map(|info| info.ffprobe_path)
}

/// Reads the nominal frame rate of a rendered file's video stream.
fn ffprobe_video_fps(path: &std::path::Path) -> Option<f64> {
    let ffprobe_path = available_ffprobe_path()?;
    let output = Command::new(ffprobe_path)
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=r_frame_rate",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
        ])
        .arg(path)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let text = text.trim();
    match text.split_once('/') {
        Some((numerator, denominator)) => {
            let numerator: f64 = numerator.trim().parse().ok()?;
            let denominator: f64 = denominator.trim().parse().ok()?;
            (denominator > 0.0).then_some(numerator / denominator)
        }
        None => text.parse().ok(),
    }
}

/// Counts the video frames a rendered file actually contains.
///
/// Decoded frame-by-frame rather than derived from the container duration: a
/// composite that silently dropped its tail still reports a plausible duration,
/// and only the frame count catches it.
fn ffprobe_video_frame_count(path: &std::path::Path) -> Option<u64> {
    let ffprobe_path = available_ffprobe_path()?;
    let output = Command::new(ffprobe_path)
        .args([
            "-v",
            "error",
            "-count_frames",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=nb_read_frames",
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

/// Probe the total duration (in seconds) of a media file via ffprobe.
/// Returns `None` if ffprobe is unavailable or the output cannot be parsed.
fn ffprobe_duration_secs(path: &std::path::Path) -> Option<f64> {
    let ffprobe_path = available_ffprobe_path()?;
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
    let ffprobe_path = available_ffprobe_path()?;
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
    let ffprobe_path = available_ffprobe_path()?;
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
    let ffprobe_path = available_ffprobe_path()?;
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
    if available_ffmpeg_path().is_none() {
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
    if available_ffmpeg_path().is_none() {
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

/// Generates a flat clip of one colour at an explicit frame size.
///
/// The size is a parameter because a transformed clip's placement depends on the
/// source's aspect ratio: a 16:9 source in a 16:9 canvas needs no letterbox
/// arithmetic, while a 4:3 one does, and only the second shape can tell a
/// correctly measured source from a wrongly assumed one.
fn create_solid_colour_video(
    path: &std::path::Path,
    colour: &str,
    size: &str,
    duration_secs: u32,
) -> bool {
    let Some(ffmpeg_path) = available_ffmpeg_path() else {
        return false;
    };
    let Some(video_encoder) = preferred_video_encoder(&ffmpeg_path) else {
        eprintln!("Skipping transform render test: ffmpeg lacks a supported video encoder");
        return false;
    };

    let mut command = Command::new(ffmpeg_path);
    command.args([
        "-y",
        "-f",
        "lavfi",
        "-i",
        &format!("color=c={colour}:s={size}:r=25:d={duration_secs}"),
        "-c:v",
        video_encoder,
    ]);
    if video_encoder == "libx264" {
        command.args(["-pix_fmt", "yuv420p"]);
    }

    let status = command
        .arg(path)
        .status()
        .expect("Failed to generate solid colour fixture with ffmpeg");
    if !status.success() {
        eprintln!("Skipping transform render test: ffmpeg could not generate the fixture");
    }
    status.success()
}

/// Reads one RGB pixel out of a rendered file.
///
/// Returns `None` when ffmpeg is unavailable or produced no pixel, so callers
/// can skip rather than fail on a machine without a usable ffmpeg.
fn sample_rendered_pixel(
    path: &std::path::Path,
    at_sec: f64,
    x: u32,
    y: u32,
) -> Option<(u8, u8, u8)> {
    let ffmpeg_path = available_ffmpeg_path()?;
    let output = Command::new(ffmpeg_path)
        .args(["-v", "error", "-ss", &at_sec.to_string(), "-i"])
        .arg(path)
        .args([
            // The conversion has to come first: cropping a single pixel out of a
            // subsampled plane asks for a zero-width chroma plane and fails.
            "-vf",
            &format!("format=rgb24,crop=w=1:h=1:x={x}:y={y}"),
            "-frames:v",
            "1",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgb24",
            "-",
        ])
        .output()
        .ok()?;
    if !output.status.success() || output.stdout.len() < 3 {
        return None;
    }
    Some((output.stdout[0], output.stdout[1], output.stdout[2]))
}

/// Imports a fixture, places it on the first video track and trims it to the
/// fixture's real length, returning `(sequence_id, track_id, clip_id)`.
///
/// `asset import` records no probed duration, so the timeline hands the clip its
/// 10s default; trimming keeps the rendered length a statement about the edit
/// rather than about a clip that outruns its source.
fn place_trimmed_clip(path: &str, source_path: &std::path::Path, duration_sec: f64) -> String {
    let import = run_cli_ok(&[
        "asset",
        "import",
        "--path",
        path,
        "--file",
        source_path.to_str().unwrap(),
    ]);
    let asset_id = import["createdIds"][0].as_str().unwrap().to_string();

    let tracks = run_cli_ok(&["timeline", "tracks", "--path", path]);
    let track_id = tracks["tracks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|track| track["kind"] == "Video")
        .and_then(|track| track["id"].as_str())
        .unwrap()
        .to_string();

    let inserted = run_cli_ok(&[
        "timeline", "insert", "--path", path, "--asset", &asset_id, "--track", &track_id, "--at",
        "0.0",
    ]);
    let clip_id = inserted["createdIds"][0].as_str().unwrap().to_string();

    run_cli_ok(&[
        "timeline",
        "trim",
        "--path",
        path,
        "--track",
        &track_id,
        "--clip",
        &clip_id,
        "--source-in",
        "0",
        "--source-out",
        &duration_sec.to_string(),
    ]);

    track_id + "|" + &clip_id
}

/// Feature: Transformed clips in the final render
/// Scenario: a scaled, repositioned clip lands where the preview puts it
///
/// Half scale with the anchor pinned at a quarter of the canvas both ways puts
/// the picture in the top-left quadrant exactly. Export used to refuse this
/// clip outright, so the assertions here are about pixels, not exit codes:
/// source colour inside the quadrant, black outside it, and a file exactly as
/// long as the timeline.
#[test]
fn test_render_transform_places_a_scaled_clip_in_the_top_left_quadrant() {
    if available_ffmpeg_path().is_none() {
        return;
    }

    let dir = create_temp_project("render_transform_place");
    let path = project_path(&dir, "render_transform_place");

    const FIXTURE_SEC: f64 = 2.0;
    let source_path = dir.path().join("transform_source.mp4");
    if !create_solid_colour_video(&source_path, "red", "640x360", FIXTURE_SEC as u32) {
        return;
    }

    let ids = place_trimmed_clip(&path, &source_path, FIXTURE_SEC);
    let (track_id, clip_id) = ids.split_once('|').unwrap();
    let sequence_id = run_cli_ok(&["timeline", "info", "--path", &path])["sequenceId"]
        .as_str()
        .unwrap()
        .to_string();

    run_cli_ok(&[
        "command",
        "execute",
        "--path",
        &path,
        "--type",
        "SetClipTransform",
        "--payload",
        &serde_json::json!({
            "sequenceId": sequence_id,
            "trackId": track_id,
            "clipId": clip_id,
            "transform": {
                "position": { "x": 0.25, "y": 0.25 },
                "scale": { "x": 0.5, "y": 0.5 },
                "rotationDeg": 0.0,
                "anchor": { "x": 0.5, "y": 0.5 },
            },
        })
        .to_string(),
    ]);

    let output_path = dir.path().join("transform-render.mp4");
    let (stdout, stderr, success) = run_cli(&[
        "render",
        "start",
        "--path",
        &path,
        "--output",
        output_path.to_str().unwrap(),
    ]);
    assert!(
        success,
        "a transformed clip must render.\nstdout: {stdout}\nstderr: {stderr}"
    );

    let Some((width, height)) = ffprobe_image_size(&output_path) else {
        return;
    };
    assert_eq!(
        width * 9,
        height * 16,
        "the fixture and the canvas must share an aspect ratio for this placement to be exact"
    );

    // The clip spans the top-left quadrant, so the quadrant boundary runs
    // through the canvas centre. Sampling at an eighth and seven-eighths keeps
    // both probes three-quarters of a quadrant away from that edge, where a
    // one-pixel placement error cannot flip the answer.
    let inside = sample_rendered_pixel(&output_path, 1.0, width / 8, height / 8)
        .expect("a pixel inside the placed quadrant");
    assert!(
        inside.0 > 150 && inside.1 < 80 && inside.2 < 80,
        "the placed quadrant must show the source colour, got {inside:?}"
    );

    let outside = sample_rendered_pixel(&output_path, 1.0, width * 7 / 8, height * 7 / 8)
        .expect("a pixel outside the placed quadrant");
    assert!(
        outside.0 < 40 && outside.1 < 40 && outside.2 < 40,
        "the canvas outside the placed clip must stay black, got {outside:?}"
    );

    // Frame count, not duration: the composite used to end at whichever input
    // ran out first, which drops tail frames while leaving the container
    // duration looking right.
    if let (Some(frames), Some(fps)) = (
        ffprobe_video_frame_count(&output_path),
        ffprobe_video_fps(&output_path),
    ) {
        let expected = (FIXTURE_SEC * fps).round() as u64;
        assert_eq!(
            frames, expected,
            "the composite must emit every frame of the clip's slot at {fps} fps"
        );
    }
}

/// Feature: Transformed clips in the final render
/// Scenario: a half-opacity clip renders at half brightness
///
/// White at 50% over the black canvas is mid grey. Anything else means the
/// alpha stage was dropped or applied twice.
#[test]
fn test_render_transform_renders_clip_opacity_over_black() {
    if available_ffmpeg_path().is_none() {
        return;
    }

    let dir = create_temp_project("render_transform_opacity");
    let path = project_path(&dir, "render_transform_opacity");

    const FIXTURE_SEC: f64 = 2.0;
    let source_path = dir.path().join("opacity_source.mp4");
    if !create_solid_colour_video(&source_path, "white", "640x360", FIXTURE_SEC as u32) {
        return;
    }

    let ids = place_trimmed_clip(&path, &source_path, FIXTURE_SEC);
    let (track_id, clip_id) = ids.split_once('|').unwrap();
    let sequence_id = run_cli_ok(&["timeline", "info", "--path", &path])["sequenceId"]
        .as_str()
        .unwrap()
        .to_string();

    run_cli_ok(&[
        "command",
        "execute",
        "--path",
        &path,
        "--type",
        "SetClipOpacity",
        "--payload",
        &serde_json::json!({
            "sequenceId": sequence_id,
            "trackId": track_id,
            "clipId": clip_id,
            "opacity": 0.5,
        })
        .to_string(),
    ]);

    let output_path = dir.path().join("opacity-render.mp4");
    let (stdout, stderr, success) = run_cli(&[
        "render",
        "start",
        "--path",
        &path,
        "--output",
        output_path.to_str().unwrap(),
    ]);
    assert!(
        success,
        "a translucent clip must render.\nstdout: {stdout}\nstderr: {stderr}"
    );

    let Some((width, height)) = ffprobe_image_size(&output_path) else {
        return;
    };
    let centre = sample_rendered_pixel(&output_path, 1.0, width / 2, height / 2)
        .expect("a pixel at the canvas centre");
    for channel in [centre.0, centre.1, centre.2] {
        assert!(
            (118..=138).contains(&channel),
            "white at half opacity over black must render 128 +/- 10, got {centre:?}"
        );
    }
}

/// Feature: Transformed clips in the final render
/// Scenario: placement follows the source's measured shape, not its stored one
///
/// `asset import` files every video away as a placeholder 1920x1080, so a 4:3
/// source that is only trusted rather than measured would be placed as if it
/// were 16:9 — 960x540 spanning x 480..1440 instead of 720x540 spanning
/// x 600..1320. The two sample points below sit inside exactly one of those.
#[test]
fn test_render_transform_places_a_clip_by_its_measured_aspect_ratio() {
    if available_ffmpeg_path().is_none() {
        return;
    }

    let dir = create_temp_project("render_transform_aspect");
    let path = project_path(&dir, "render_transform_aspect");

    const FIXTURE_SEC: f64 = 2.0;
    let source_path = dir.path().join("aspect_source.mp4");
    if !create_solid_colour_video(&source_path, "green", "480x360", FIXTURE_SEC as u32) {
        return;
    }

    let ids = place_trimmed_clip(&path, &source_path, FIXTURE_SEC);
    let (track_id, clip_id) = ids.split_once('|').unwrap();
    let sequence_id = run_cli_ok(&["timeline", "info", "--path", &path])["sequenceId"]
        .as_str()
        .unwrap()
        .to_string();

    run_cli_ok(&[
        "command",
        "execute",
        "--path",
        &path,
        "--type",
        "SetClipTransform",
        "--payload",
        &serde_json::json!({
            "sequenceId": sequence_id,
            "trackId": track_id,
            "clipId": clip_id,
            "transform": {
                "position": { "x": 0.5, "y": 0.5 },
                "scale": { "x": 0.5, "y": 0.5 },
                "rotationDeg": 0.0,
                "anchor": { "x": 0.5, "y": 0.5 },
            },
        })
        .to_string(),
    ]);

    let output_path = dir.path().join("aspect-render.mp4");
    let (stdout, stderr, success) = run_cli(&[
        "render",
        "start",
        "--path",
        &path,
        "--output",
        output_path.to_str().unwrap(),
    ]);
    assert!(
        success,
        "a transformed 4:3 clip must render.\nstdout: {stdout}\nstderr: {stderr}"
    );

    let Some((width, height)) = ffprobe_image_size(&output_path) else {
        return;
    };
    if (width, height) != (1920, 1080) {
        // The sample points below are hand-computed against a 1080p canvas.
        return;
    }

    let centre =
        sample_rendered_pixel(&output_path, 1.0, 960, 540).expect("a pixel at the canvas centre");
    assert!(
        centre.1 > 100 && centre.0 < 90,
        "the clip must cover the canvas centre, got {centre:?}"
    );

    for (x, y) in [(520_u32, 540_u32), (1380, 540)] {
        let pixel = sample_rendered_pixel(&output_path, 1.0, x, y)
            .unwrap_or_else(|| panic!("a pixel at ({x}, {y})"));
        assert!(
            pixel.0 < 40 && pixel.1 < 40 && pixel.2 < 40,
            "a 4:3 source scaled by half spans x 600..1320, so ({x}, {y}) must be black, \
             got {pixel:?}"
        );
    }
}

/// Creates a single-frame PNG still of one colour.
///
/// Stills are the shape that broke hardest: a one-frame overlay input ended the
/// composite immediately, so a transformed still produced a file with no video
/// stream at all.
fn create_solid_colour_still(path: &std::path::Path, colour: &str, size: &str) -> bool {
    let Some(ffmpeg_path) = available_ffmpeg_path() else {
        return false;
    };

    let status = Command::new(ffmpeg_path)
        .args([
            "-y",
            "-f",
            "lavfi",
            "-i",
            &format!("color=c={colour}:s={size}"),
            "-frames:v",
            "1",
        ])
        .arg(path)
        .status()
        .expect("Failed to generate still fixture with ffmpeg");
    if !status.success() {
        eprintln!("Skipping transform render test: ffmpeg could not generate the still fixture");
    }
    status.success()
}

/// Feature: Transformed clips in the final render
/// Scenario: a one-frame source fills its whole slot
///
/// The composite used to end with whichever input ran out first. A still has
/// exactly one frame, so a transformed still rendered a file with no video
/// stream at all, and a 25 fps clip in a 30 fps canvas lost its tail frames.
/// Holding the last frame for the length of the slot is what both cases need.
#[test]
fn test_render_transform_fills_the_slot_from_a_single_frame_source() {
    if available_ffmpeg_path().is_none() {
        return;
    }

    let dir = create_temp_project("render_transform_still");
    let path = project_path(&dir, "render_transform_still");

    const SLOT_SEC: f64 = 2.0;
    let source_path = dir.path().join("still_source.png");
    if !create_solid_colour_still(&source_path, "blue", "640x360") {
        return;
    }

    let ids = place_trimmed_clip(&path, &source_path, SLOT_SEC);
    let (track_id, clip_id) = ids.split_once('|').unwrap();
    let sequence_id = run_cli_ok(&["timeline", "info", "--path", &path])["sequenceId"]
        .as_str()
        .unwrap()
        .to_string();

    run_cli_ok(&[
        "command",
        "execute",
        "--path",
        &path,
        "--type",
        "SetClipTransform",
        "--payload",
        &serde_json::json!({
            "sequenceId": sequence_id,
            "trackId": track_id,
            "clipId": clip_id,
            "transform": {
                "position": { "x": 0.5, "y": 0.5 },
                "scale": { "x": 0.5, "y": 0.5 },
                "rotationDeg": 0.0,
                "anchor": { "x": 0.5, "y": 0.5 },
            },
        })
        .to_string(),
    ]);

    let output_path = dir.path().join("still-render.mp4");
    let (stdout, stderr, success) = run_cli(&[
        "render",
        "start",
        "--path",
        &path,
        "--output",
        output_path.to_str().unwrap(),
    ]);
    assert!(
        success,
        "a transformed still must render.\nstdout: {stdout}\nstderr: {stderr}"
    );

    let size = ffprobe_image_size(&output_path);
    assert!(
        size.is_some(),
        "a transformed still must still produce a video stream"
    );

    let (Some(frames), Some(fps)) = (
        ffprobe_video_frame_count(&output_path),
        ffprobe_video_fps(&output_path),
    ) else {
        return;
    };
    let expected = (SLOT_SEC * fps).round() as u64;
    assert_eq!(
        frames, expected,
        "a one-frame source must be held for its whole {SLOT_SEC}s slot at {fps} fps"
    );

    // And what it holds is the picture, not black.
    if let Some((width, height)) = size {
        let centre = sample_rendered_pixel(&output_path, SLOT_SEC * 0.75, width / 2, height / 2)
            .expect("a pixel near the end of the slot");
        assert!(
            centre.2 > 120 && centre.0 < 90,
            "the held frame must still show the source, got {centre:?}"
        );
    }
}

/// Renders a clip carrying two motion keyframes and returns the render warnings.
///
/// `rotation_deg` is applied to the second keyframe: zero gives a pure pan, which
/// the export animates, and anything else gives a move that turns the picture,
/// which it still cannot. `None` means the fixture could not be built.
fn render_warnings_for_motion(name: &str, rotation_deg: f64) -> Option<Vec<String>> {
    const FIXTURE_SEC: f64 = 2.0;

    let dir = create_temp_project(name);
    let path = project_path(&dir, name);

    let source_path = dir.path().join("motion_source.mp4");
    if !create_solid_colour_video(&source_path, "red", "640x360", FIXTURE_SEC as u32) {
        return None;
    }

    let ids = place_trimmed_clip(&path, &source_path, FIXTURE_SEC);
    let (track_id, clip_id) = ids.split_once('|').unwrap();
    let sequence_id = run_cli_ok(&["timeline", "info", "--path", &path])["sequenceId"]
        .as_str()
        .unwrap()
        .to_string();

    // Two keyframes that actually move the clip. A lone keyframe equal to the
    // base transform describes exactly the picture the export already produces
    // and must not warn either way.
    run_cli_ok(&[
        "command",
        "execute",
        "--path",
        &path,
        "--type",
        "SetClipMotionKeyframes",
        "--payload",
        &serde_json::json!({
            "sequenceId": sequence_id,
            "trackId": track_id,
            "clipId": clip_id,
            "keyframes": [
                {
                    "timeOffset": 0.0,
                    "transform": {
                        "position": { "x": 0.25, "y": 0.5 },
                        "scale": { "x": 1.0, "y": 1.0 },
                        "rotationDeg": 0.0,
                        "anchor": { "x": 0.5, "y": 0.5 },
                    },
                },
                {
                    "timeOffset": 1.0,
                    "transform": {
                        "position": { "x": 0.75, "y": 0.5 },
                        "scale": { "x": 1.0, "y": 1.0 },
                        "rotationDeg": rotation_deg,
                        "anchor": { "x": 0.5, "y": 0.5 },
                    },
                },
            ],
        })
        .to_string(),
    ]);

    let output_path = dir.path().join("motion-render.mp4");
    let (stdout, stderr, success) = run_cli(&[
        "render",
        "start",
        "--path",
        &path,
        "--output",
        output_path.to_str().unwrap(),
    ]);
    assert!(
        success,
        "a clip with motion keyframes must still render.\nstdout: {stdout}\nstderr: {stderr}"
    );

    let rendered: serde_json::Value = serde_json::from_str(&stdout).unwrap();
    Some(
        rendered["warnings"]
            .as_array()
            .expect("warnings")
            .iter()
            .filter_map(|warning| warning.as_str())
            .map(str::to_string)
            .collect(),
    )
}

/// Feature: Truthful degradation
/// Scenario: only the motion that really does not render is reported
///
/// Pan, zoom and anchor moves now animate in the export, so warning about them
/// would train users to ignore the warning that still matters. A move that turns
/// the picture is the one the export still cannot follow, and it has to keep
/// saying so — a known limitation beats a silent one.
#[test]
fn test_render_reports_only_unrenderable_motion_as_unrendered() {
    if available_ffmpeg_path().is_none() {
        return;
    }

    fn is_motion_warning(warning: &str) -> bool {
        warning.contains("Motion keyframes") && warning.contains("not yet rendered")
    }

    let Some(panning) = render_warnings_for_motion("render_motion_pan", 0.0) else {
        return;
    };
    assert!(
        !panning.iter().any(|warning| is_motion_warning(warning)),
        "a pan renders, so it must not be reported as unrendered: {panning:?}"
    );

    let Some(rotating) = render_warnings_for_motion("render_motion_rotate", 30.0) else {
        return;
    };
    assert!(
        rotating.iter().any(|warning| is_motion_warning(warning)),
        "motion that turns the picture is still unrendered and must be reported: {rotating:?}"
    );
}

/// Feature: Perception matches the render
/// Scenario: fast frame extraction composites a transformed clip
///
/// Fast mode reads the topmost clip's source file straight off disk. For a
/// transformed clip that shows the untransformed picture, so an agent checking
/// its own transform edit would see no change at all.
#[test]
fn test_frame_extract_fast_falls_back_to_composite_for_a_transformed_clip() {
    if available_ffmpeg_path().is_none() {
        return;
    }

    let dir = create_temp_project("frame_fast_transform");
    let path = project_path(&dir, "frame_fast_transform");

    const FIXTURE_SEC: f64 = 2.0;
    let source_path = dir.path().join("fast_transform_source.mp4");
    if !create_solid_colour_video(&source_path, "red", "640x360", FIXTURE_SEC as u32) {
        return;
    }

    let ids = place_trimmed_clip(&path, &source_path, FIXTURE_SEC);
    let (track_id, clip_id) = ids.split_once('|').unwrap();
    let sequence_id = run_cli_ok(&["timeline", "info", "--path", &path])["sequenceId"]
        .as_str()
        .unwrap()
        .to_string();

    run_cli_ok(&[
        "command",
        "execute",
        "--path",
        &path,
        "--type",
        "SetClipTransform",
        "--payload",
        &serde_json::json!({
            "sequenceId": sequence_id,
            "trackId": track_id,
            "clipId": clip_id,
            "transform": {
                "position": { "x": 0.25, "y": 0.25 },
                "scale": { "x": 0.5, "y": 0.5 },
                "rotationDeg": 0.0,
                "anchor": { "x": 0.5, "y": 0.5 },
            },
        })
        .to_string(),
    ]);

    let still_path = dir.path().join("fast-frame.png");
    let extracted = run_cli_ok(&[
        "frame",
        "extract",
        "--path",
        &path,
        "--time",
        "1.0",
        "--mode",
        "fast",
        "--out",
        still_path.to_str().unwrap(),
    ]);

    let frame = &extracted["frames"][0];
    assert_eq!(
        frame["fellBackToComposite"], true,
        "fast mode must report that it composited instead: {extracted}"
    );

    let Some((width, height)) = ffprobe_image_size(&still_path) else {
        return;
    };
    let outside = sample_rendered_pixel(&still_path, 0.0, width * 7 / 8, height * 7 / 8)
        .expect("a pixel outside the placed quadrant");
    assert!(
        outside.0 < 40 && outside.1 < 40 && outside.2 < 40,
        "the extracted still must show the transform, not the raw source, got {outside:?}"
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
    if available_ffmpeg_path().is_none() {
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
    available_ffmpeg_path()?;

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
        // Explicit: the default is the composited edit, and only the fast path
        // reports the clip and asset this asserts on.
        "--mode",
        "fast",
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
        // The fallback under test is fast mode's, so it has to be asked for.
        "--mode",
        "fast",
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
        // The fallback under test is fast mode's, so it has to be asked for.
        "--mode",
        "fast",
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
    let Some(ffmpeg_path) = available_ffmpeg_path() else {
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
    if available_ffmpeg_path().is_none() {
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
// Pacing Profile Plans
// =============================================================================

/// Writes a cached analysis bundle by hand.
///
/// Deliberately FFmpeg-free: a pacing plan needs the source duration and the
/// shot boundaries, not the toolchain that measured them, so the whole
/// from-profile loop stays runnable on a machine with no media stack.
fn write_analysis_bundle(project_path: &str, asset_id: &str, shot_boundaries: &[(f64, f64)]) {
    let bundle_dir = std::path::Path::new(project_path)
        .join(".openreelio")
        .join("analysis")
        .join(asset_id);
    std::fs::create_dir_all(&bundle_dir).unwrap();

    let duration_sec = shot_boundaries
        .last()
        .map(|(_, end)| *end)
        .unwrap_or_default();
    let shots: Vec<serde_json::Value> = shot_boundaries
        .iter()
        .map(|(start, end)| {
            serde_json::json!({ "startSec": start, "endSec": end, "confidence": 0.9 })
        })
        .collect();

    let bundle = serde_json::json!({
        "schemaVersion": 2,
        "assetId": asset_id,
        "shots": shots,
        "transcript": null,
        "audioProfile": null,
        "segments": null,
        "frameAnalysis": null,
        "metadata": { "durationSec": duration_sec, "hasAudio": false },
        "analyzedAt": "2026-01-01T00:00:00Z",
    });

    std::fs::write(bundle_dir.join("bundle.json"), bundle.to_string()).unwrap();
}

/// A project holding one imported (but unplaced) dummy asset with a bundle.
///
/// The dummy asset has no probeable duration, so the timeline gives it the
/// 10s default — which is what the bundle declares too, so the plan's cuts
/// land inside the clip the plan itself inserts.
fn create_project_with_analysis(name: &str) -> (tempfile::TempDir, String, String) {
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

    write_analysis_bundle(
        &path,
        &asset_id,
        &[(0.0, 2.0), (2.0, 5.0), (5.0, 7.0), (7.0, 10.0)],
    );

    (dir, path, asset_id)
}

#[test]
fn test_plan_from_profile_builds_a_plan_that_validates_executes_and_verifies() {
    let (dir, path, asset_id) = create_project_with_analysis("pacing_roundtrip");

    let plan_file = dir.path().join("pacing.json");
    let built = run_cli_ok(&[
        "plan",
        "from-profile",
        "--path",
        &path,
        "--profile",
        "dynamic-social",
        "--asset",
        &asset_id,
        "--out",
        plan_file.to_str().unwrap(),
    ]);

    assert_eq!(built["status"], "ok", "{built}");
    assert_eq!(built["profile"], "dynamic-social");
    assert!(
        built["cutCount"].as_u64().unwrap() > 0,
        "a 10s source at a 2.5s target must be cut: {built}"
    );
    assert_eq!(
        built["transitionCount"], 0,
        "shipped profiles cut hard: {built}"
    );
    assert!(built["transitionRecipe"].is_null(), "{built}");
    assert!(
        plan_file.exists(),
        "--out must write the plan file it advertises"
    );

    // With `--out` the plan is on disk; a second inline copy would only spend
    // the caller's context. The summary plus the path is the contract.
    assert!(
        built["plan"].is_null(),
        "--out must not inline the plan as well: {built}"
    );
    assert_eq!(
        built["outputPath"],
        plan_file.to_str().unwrap(),
        "the summary has to say where the plan went: {built}"
    );

    // The plan is a spec first: nothing has been mutated yet.
    let tracks_before = run_cli_ok(&["timeline", "tracks", "--path", &path]);
    assert_eq!(tracks_before["count"], 2, "from-profile must not execute");

    let validated = run_cli_ok(&[
        "plan",
        "validate",
        "--path",
        &path,
        "--file",
        plan_file.to_str().unwrap(),
    ]);
    assert_eq!(validated["status"], "ok", "{validated}");

    let (stdout, stderr, code) = run_cli_exit(&[
        "plan",
        "execute",
        "--path",
        &path,
        "--file",
        plan_file.to_str().unwrap(),
    ]);
    assert_eq!(code, 0, "plan must execute: {stdout} {stderr}");
    let executed: serde_json::Value = serde_json::from_str(&stdout).unwrap();
    assert_eq!(executed["status"], "ok", "{executed}");
    assert_eq!(
        executed["stepsExecuted"].as_u64().unwrap(),
        built["stepCount"].as_u64().unwrap()
    );

    let verified = run_cli_ok(&["verify", "--path", &path, "--structural-only"]);
    assert_eq!(
        verified["passed"], true,
        "a generated cut must leave no gaps or orphans: {verified}"
    );
}

/// Feature: transition recipes on a generated cut
/// Scenario: an AddEffect step lands the named recipe on the clip it names,
/// at a boundary past the first
///
/// No shipped profile plans a transition — every boundary a profile makes is a
/// razor split, and a blend across one is invisible — so the plan gets the
/// `AddEffect` step appended by hand, which is what an agent editing a generated
/// plan would do. What is under test is the handoff: a `$fromStep` reference
/// resolving to the *right* clip, carrying the *right* effect type, at a
/// boundary that is not the trivial first one.
#[test]
fn test_a_plan_places_a_transition_recipe_on_the_clip_it_names() {
    let (dir, path, asset_id) = create_project_with_analysis("pacing_transition");

    let plan_file = dir.path().join("pacing.json");
    run_cli_ok(&[
        "plan",
        "from-profile",
        "--path",
        &path,
        "--profile",
        "dynamic-social",
        "--asset",
        &asset_id,
        "--out",
        plan_file.to_str().unwrap(),
    ]);

    let mut plan: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&plan_file).unwrap()).unwrap();
    let cut_times: Vec<f64> = plan["steps"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|step| step["commandType"] == "SplitClip")
        .map(|step| step["payload"]["splitTime"].as_f64().unwrap())
        .collect();
    assert!(
        cut_times.len() >= 2,
        "the fixture needs a boundary past the first: {cut_times:?}"
    );

    // Boundary 1's outgoing clip is what the split closing boundary 0 left
    // behind — step-2's created id — and the effect must wait for the split
    // that closes boundary 1, step-3.
    let sequence_id = plan["steps"][0]["payload"]["sequenceId"].clone();
    plan["steps"]
        .as_array_mut()
        .unwrap()
        .push(serde_json::json!({
            "id": "step-transition",
            "commandType": "AddEffect",
            "payload": {
                "sequenceId": sequence_id,
                "trackId": { "$fromStep": "step-0", "$path": "createdIds.0" },
                "clipId": { "$fromStep": "step-2", "$path": "createdIds.0" },
                "recipe": "dissolve-standard",
            },
            "dependsOn": ["step-3"],
        }));
    std::fs::write(&plan_file, plan.to_string()).unwrap();

    let validated = run_cli_ok(&[
        "plan",
        "validate",
        "--path",
        &path,
        "--file",
        plan_file.to_str().unwrap(),
    ]);
    assert_eq!(validated["status"], "ok", "{validated}");
    let deferred: Vec<&str> = validated["stepsWithReferences"]
        .as_array()
        .expect("stepsWithReferences")
        .iter()
        .filter_map(|id| id.as_str())
        .collect();
    assert!(
        deferred.contains(&"step-transition"),
        "a step whose payload defers to execute must say so: {validated}"
    );

    run_cli_ok(&[
        "plan",
        "execute",
        "--path",
        &path,
        "--file",
        plan_file.to_str().unwrap(),
    ]);

    // The clip the effect was aimed at is the one spanning cut 0 to cut 1.
    let clips = run_cli_ok(&["timeline", "clips", "--path", &path]);
    let expected_clip = clips["clips"]
        .as_array()
        .unwrap()
        .iter()
        .find(|clip| (clip["timelineInSec"].as_f64().unwrap() - cut_times[0]).abs() < 0.01)
        .and_then(|clip| clip["id"].as_str())
        .unwrap_or_else(|| panic!("no clip starts at the first cut {}: {clips}", cut_times[0]))
        .to_string();

    let graph = run_cli_ok(&["render", "graph", "--path", &path]);
    let effect_ids: Vec<String> = graph["visualLayers"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|layer| layer["clipId"].as_str() == Some(expected_clip.as_str()))
        .flat_map(|layer| layer["effects"].as_array().cloned().unwrap_or_default())
        .filter_map(|id| id.as_str().map(str::to_string))
        .collect();
    assert_eq!(
        effect_ids.len(),
        1,
        "the recipe belongs on the clip the step named, and only there: {graph}"
    );

    // The recipe has to resolve to the effect type it advertises, not merely to
    // *some* effect: the ops log is where that is recorded.
    let ops = run_cli_ok(&["state", "ops", "--path", &path, "--last", "1"]);
    let effect = &ops["ops"][0]["payload"]["effect"];
    assert_eq!(effect["effectType"], "cross_dissolve", "{ops}");
    assert_eq!(effect["id"], effect_ids[0], "{ops}");
    assert_eq!(
        ops["ops"][0]["payload"]["clipId"], expected_clip,
        "the effect must land on the outgoing clip of the second boundary: {ops}"
    );
}

#[test]
fn test_plan_from_profile_never_plans_a_transition() {
    let (dir, path, asset_id) = create_project_with_analysis("pacing_hard_cuts");
    let plan_file = dir.path().join("pacing.json");

    // The whole catalogue, so a profile cannot start advertising a transition
    // the renderer would silently turn back into a cut.
    let profiles = run_cli_ok(&["packs", "list", "--kind", "pacing"]);
    let profile_ids: Vec<String> = profiles["packs"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|pack| pack["id"].as_str().map(str::to_string))
        .collect();
    assert!(!profile_ids.is_empty());

    for profile_id in profile_ids {
        let built = run_cli_ok(&[
            "plan",
            "from-profile",
            "--path",
            &path,
            "--profile",
            &profile_id,
            "--asset",
            &asset_id,
            "--out",
            plan_file.to_str().unwrap(),
        ]);

        assert_eq!(built["transitionCount"], 0, "{profile_id}: {built}");
        assert!(built["transitionRecipe"].is_null(), "{profile_id}: {built}");
    }
}

/// Feature: pacing plans that cannot cut
/// Scenario: a source between 1x and 1.5x the target shot says why it did not
#[test]
fn test_plan_from_profile_explains_a_plan_that_makes_no_cuts() {
    let dir = create_temp_project("pacing_no_cuts");
    let path = project_path(&dir, "pacing_no_cuts");

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

    // 5.4s against calm-longform's 7s target: long enough to place, too short
    // to round to two shots.
    write_analysis_bundle(&path, &asset_id, &[(0.0, 5.4)]);

    let built = run_cli_ok(&[
        "plan",
        "from-profile",
        "--path",
        &path,
        "--profile",
        "calm-longform",
        "--asset",
        &asset_id,
    ]);

    assert_eq!(built["status"], "ok", "{built}");
    assert_eq!(built["cutCount"], 0, "{built}");
    assert_eq!(
        built["stepCount"], 2,
        "an uncut plan still places the footage: {built}"
    );
    let warnings = built["warnings"].as_array().expect("warnings");
    assert!(
        warnings
            .iter()
            .filter_map(|warning| warning.as_str())
            .any(|warning| warning.contains("1.5x") && warning.contains("no cuts planned")),
        "a zero-cut plan must explain itself rather than look broken: {built}"
    );
}

#[test]
fn test_plan_from_profile_requires_a_cached_analysis_bundle() {
    let dir = create_temp_project("pacing_no_bundle");
    let path = project_path(&dir, "pacing_no_bundle");
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

    let (_stdout, stderr) = run_cli_err(&[
        "plan",
        "from-profile",
        "--path",
        &path,
        "--profile",
        "dynamic-social",
        "--asset",
        &asset_id,
    ]);

    assert!(
        stderr.contains("analysis run"),
        "the error must name the command that fixes it: {stderr}"
    );
}

#[test]
fn test_plan_from_profile_rejects_an_unknown_profile() {
    let (_dir, path, asset_id) = create_project_with_analysis("pacing_unknown");

    let (_stdout, stderr) = run_cli_err(&[
        "plan",
        "from-profile",
        "--path",
        &path,
        "--profile",
        "no-such-profile",
        "--asset",
        &asset_id,
    ]);

    assert!(
        stderr.contains("dynamic-social") && stderr.contains("calm-longform"),
        "the error must list the valid profiles: {stderr}"
    );
}

#[test]
fn test_plan_from_profile_rejects_an_asset_that_is_not_in_the_project() {
    let (_dir, path, _asset_id) = create_project_with_analysis("pacing_missing_asset");

    let (_stdout, stderr) = run_cli_err(&[
        "plan",
        "from-profile",
        "--path",
        &path,
        "--profile",
        "dynamic-social",
        "--asset",
        "not-an-asset",
    ]);

    assert!(stderr.contains("not in this project"), "{stderr}");
}

// =============================================================================
// Transition Rendering
// =============================================================================

/// Length of each shot in the transition fixtures, in seconds.
const TRANSITION_SHOT_SEC: f64 = 4.0;
/// Length of the `dissolve-standard` recipe, in seconds.
const TRANSITION_DISSOLVE_SEC: f64 = 1.0;

/// Builds a two-shot timeline from two sources and returns the ids needed to
/// hang a transition on the cut.
///
/// `source_in` decides whether the clips have handles: a clip that starts at
/// source time 0 and runs to the end of its media has no unused frames to blend
/// with, which is the difference between a rendered dissolve and a warned cut.
///
/// Returns `(sequence_id, track_id, outgoing_clip_id)`.
fn place_two_shot_timeline(
    path: &str,
    sources: [&std::path::Path; 2],
    source_in_sec: f64,
) -> (String, String, String) {
    let info = run_cli_ok(&["timeline", "info", "--path", path]);
    let sequence_id = info["sequenceId"].as_str().unwrap().to_string();
    let tracks = run_cli_ok(&["timeline", "tracks", "--path", path]);
    let track_id = tracks["tracks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|track| track["kind"] == "Video")
        .and_then(|track| track["id"].as_str())
        .unwrap()
        .to_string();

    let mut outgoing_clip = String::new();
    for (index, source) in sources.into_iter().enumerate() {
        let import = run_cli_ok(&[
            "asset",
            "import",
            "--path",
            path,
            "--file",
            source.to_str().unwrap(),
        ]);
        let asset_id = import["createdIds"][0].as_str().unwrap().to_string();

        let inserted = run_cli_ok(&[
            "timeline",
            "insert",
            "--path",
            path,
            "--asset",
            &asset_id,
            "--track",
            &track_id,
            "--at",
            &(index as f64 * TRANSITION_SHOT_SEC).to_string(),
        ]);
        let clip_id = inserted["createdIds"][0].as_str().unwrap().to_string();

        // `asset import` records no probed duration, so the timeline hands every
        // clip its 10s default; trimming is what states the edit.
        run_cli_ok(&[
            "timeline",
            "trim",
            "--path",
            path,
            "--track",
            &track_id,
            "--clip",
            &clip_id,
            "--source-in",
            &source_in_sec.to_string(),
            "--source-out",
            &(source_in_sec + TRANSITION_SHOT_SEC).to_string(),
        ]);

        if index == 0 {
            outgoing_clip = clip_id;
        }
    }

    (sequence_id, track_id, outgoing_clip)
}

/// Hangs `dissolve-standard` on the clip that ends at the cut.
fn add_dissolve(path: &str, sequence_id: &str, track_id: &str, clip_id: &str) {
    run_cli_ok(&[
        "command",
        "execute",
        "--path",
        path,
        "--type",
        "AddEffect",
        "--payload",
        &serde_json::json!({
            "sequenceId": sequence_id,
            "trackId": track_id,
            "clipId": clip_id,
            "recipe": "dissolve-standard",
        })
        .to_string(),
    ]);
}

/// The warnings a `render start` result reported.
fn render_warnings(rendered: &serde_json::Value) -> Vec<String> {
    rendered["warnings"]
        .as_array()
        .expect("warnings")
        .iter()
        .filter_map(|warning| warning.as_str().map(str::to_string))
        .collect()
}

/// Feature: rendering a two-input transition between adjacent clips
/// Scenario: the boundary really blends, and costs the timeline nothing
///
/// The A/V case specifically, and with real handles. Both halves of the
/// invariant are checked here because a transition engine can break either one:
/// the picture must blend *and* the file must stay exactly as long as
/// `Sequence::output_duration()`, with the sound crossfading over the same
/// stretch at a steady level rather than dipping or doubling at the cut. A
/// silent fixture, or one whose clips are already using every frame of their
/// source, cannot see any of that.
#[test]
fn test_render_blends_an_adjacent_transition_without_spending_timeline_time() {
    if available_ffmpeg_path().is_none() {
        return;
    }

    let dir = create_temp_project("render_transition_blend");
    let path = project_path(&dir, "render_transition_blend");

    // Eight seconds of source for a four-second shot: two seconds of unused
    // media either side of the range, which is what the blend is paid for with.
    let dark = dir.path().join("dark.mp4");
    let light = dir.path().join("light.mp4");
    if !create_solid_tone_source(&dark, "black", 440, 8) {
        return;
    }
    if !create_solid_tone_source(&light, "white", 880, 8) {
        return;
    }

    let (sequence_id, track_id, outgoing_clip) =
        place_two_shot_timeline(&path, [&dark, &light], 2.0);
    add_dissolve(&path, &sequence_id, &track_id, &outgoing_clip);

    let timeline_end_sec = TRANSITION_SHOT_SEC * 2.0;
    let cut_sec = TRANSITION_SHOT_SEC;

    let output_path = dir.path().join("blended-render.mp4");
    let (stdout, stderr, success) = run_cli(&[
        "render",
        "start",
        "--path",
        &path,
        "--output",
        output_path.to_str().unwrap(),
    ]);
    assert!(
        success,
        "a blended transition must render.\nstdout: {stdout}\nstderr: {stderr}"
    );
    let rendered: serde_json::Value = serde_json::from_str(&stdout).unwrap();

    // Nothing degraded, so nothing to apologise for.
    let warnings = render_warnings(&rendered);
    assert!(
        !warnings
            .iter()
            .any(|warning| warning.contains("renders as a cut")),
        "a transition the engine blended must not be reported as a cut: {warnings:?}"
    );

    // The invariant the handles exist to protect: the picture is exactly as
    // long as the timeline, counted in decoded frames rather than trusted from
    // the container.
    let fps = ffprobe_video_fps(&output_path).expect("rendered fps");
    let frames = ffprobe_video_frame_count(&output_path).expect("rendered frame count");
    assert_eq!(
        frames,
        (timeline_end_sec * fps).round() as u64,
        "an {timeline_end_sec}s timeline at {fps}fps must render exactly that many frames"
    );

    // The blend itself. The shots are black and white, so the frame average
    // reads the blend directly: half way at the cut, and each shot untouched a
    // whole transition either side of it. Half a transition either side is what
    // the handles bought, so a full one is comfortably clear of the blend.
    let at_cut = sample_rendered_mean_brightness(&output_path, cut_sec).expect("frame at the cut");
    assert!(
        (90..=170).contains(&at_cut),
        "the cut must be half way between the two shots, measured {at_cut}"
    );

    // ...and it has to be a *blend*, not merely something whose average lands in
    // the middle. Both shots are flat, so a real blend is flat too: every pixel
    // is the same mix of the same two colours. FFmpeg's `transition=dissolve`
    // instead picks one source or the other per pixel at random, which averages
    // to exactly the same mid-grey while looking like static - the engine
    // shipped that for a while precisely because the average could not see it.
    //
    // Measured: `transition=fade` gives YMIN=YMAX=121 (spread 0) on this
    // fixture; `transition=dissolve` gives YMIN=0, YMAX=255 (spread 255) with
    // the same YAVG of 121. The bound is generous enough for codec ringing
    // around the flat field and nowhere near a noise mode.
    let spread = sample_rendered_luma_spread(&output_path, cut_sec).expect("spread at the cut");
    assert!(
        spread < 40,
        "the blend must mix the two shots rather than choosing between them per pixel; \
         luma spread across the middle of the frame measured {spread}"
    );

    let before = sample_rendered_mean_brightness(&output_path, cut_sec - TRANSITION_DISSOLVE_SEC)
        .expect("frame before the blend");
    assert!(
        before < 25,
        "a full transition before the cut must still be the outgoing shot, measured {before}"
    );
    let after = sample_rendered_mean_brightness(&output_path, cut_sec + TRANSITION_DISSOLVE_SEC)
        .expect("frame after the blend");
    assert!(
        after > 230,
        "a full transition after the cut must already be the incoming shot, measured {after}"
    );

    // The sound crossfades over the same stretch. Constant-power fades sum to a
    // flat level, so the blend window must measure like the steady state either
    // side of it. The tolerance is generous because these are separate lossy
    // windows, not because the shape is approximate.
    let steady_before =
        measure_audio_mean_volume_db(&output_path, 1.0, 1.0).expect("level before the blend");
    let steady_after =
        measure_audio_mean_volume_db(&output_path, 6.0, 1.0).expect("level after the blend");
    let across_blend = measure_audio_mean_volume_db(
        &output_path,
        cut_sec - TRANSITION_DISSOLVE_SEC / 2.0,
        TRANSITION_DISSOLVE_SEC,
    )
    .expect("level across the blend");
    assert!(
        (across_blend - steady_before).abs() < 3.0 && (across_blend - steady_after).abs() < 3.0,
        "a constant-power crossfade must not dip or spike: \
         {steady_before} dB before, {across_blend} dB across, {steady_after} dB after"
    );

    // The flat-level check above is necessary and nowhere near sufficient: two
    // tones fading through each other at constant power sum to the level they
    // started at, and so does a hard cut, and so does a fade on the wrong curve.
    // Every one of those passes it. Each tone's *own* envelope is what
    // distinguishes them, so the two shots carry different frequencies and are
    // measured apart.
    //
    // `qsin` gain is sin(x * pi/2) over the blend, so at a quarter of the way
    // through, relative to that tone's own steady state:
    //
    //   outgoing  20*log10(cos(pi/8)) = -0.69 dB
    //   incoming  20*log10(sin(pi/8)) = -8.34 dB
    //
    // and the two swap at three quarters. The quarter points are deliberate:
    // measured symmetrically about the midpoint every candidate reads -3 dB,
    // which is why the earlier version of this test was blind.
    //
    // Measured on this fixture, deviation of the *incoming* tone at the quarter
    // point: qsin -8.3 dB (correct), linear/tri -12.0 dB, hard cut -27.9 dB,
    // and -28.6 dB when the incoming branch is not pulled back by its head
    // handle. A one-decibel tolerance admits only the first.
    const QUARTER_WINDOW_SEC: f64 = 0.1;
    const FADED_IN_DB: f64 = -0.69;
    const FADED_DOWN_DB: f64 = -8.34;
    const TONE_TOLERANCE_DB: f64 = 1.0;

    let blend_start_sec = cut_sec - TRANSITION_DISSOLVE_SEC / 2.0;
    let quarter_sec = blend_start_sec + TRANSITION_DISSOLVE_SEC / 4.0;
    let three_quarter_sec = blend_start_sec + TRANSITION_DISSOLVE_SEC * 3.0 / 4.0;

    let tone_at = |start: f64, band: ToneBand, what: &str| -> f64 {
        measure_tone_band_db(
            &output_path,
            start - QUARTER_WINDOW_SEC / 2.0,
            start + QUARTER_WINDOW_SEC / 2.0,
            band,
        )
        .unwrap_or_else(|| panic!("{what} must be measurable"))
    };

    let outgoing_steady = tone_at(1.5, ToneBand::Low, "the outgoing tone's steady state");
    let incoming_steady = tone_at(6.5, ToneBand::High, "the incoming tone's steady state");

    let checks = [
        (
            "the outgoing tone a quarter into the blend",
            tone_at(quarter_sec, ToneBand::Low, "the outgoing tone") - outgoing_steady,
            FADED_IN_DB,
        ),
        (
            "the incoming tone a quarter into the blend",
            tone_at(quarter_sec, ToneBand::High, "the incoming tone") - incoming_steady,
            FADED_DOWN_DB,
        ),
        (
            "the outgoing tone three quarters into the blend",
            tone_at(three_quarter_sec, ToneBand::Low, "the outgoing tone") - outgoing_steady,
            FADED_DOWN_DB,
        ),
        (
            "the incoming tone three quarters into the blend",
            tone_at(three_quarter_sec, ToneBand::High, "the incoming tone") - incoming_steady,
            FADED_IN_DB,
        ),
    ];

    for (what, measured, expected) in checks {
        assert!(
            (measured - expected).abs() < TONE_TOLERANCE_DB,
            "{what} must follow the constant-power curve: expected {expected:.2} dB \
             below its own steady state, measured {measured:.2} dB"
        );
    }

    let (verify_stdout, verify_stderr, verify_code) = run_cli_exit(&[
        "verify",
        "--path",
        &path,
        "--file",
        output_path.to_str().unwrap(),
    ]);
    assert_ne!(
        verify_code, 2,
        "verify itself must run.\nstdout: {verify_stdout}\nstderr: {verify_stderr}"
    );
    let report: serde_json::Value = serde_json::from_str(&verify_stdout).unwrap();
    let duration_check = find_check(&report, "render.duration_mismatch");
    assert_eq!(
        duration_check["status"], "passed",
        "the render must not disagree with the timeline it came from: {duration_check}"
    );
}

/// Feature: rendering a transition whose clips have no source media to spare
/// Scenario: the boundary renders as a cut, the file is still exactly as long
/// as the timeline, and the render says why it could not blend
///
/// A blend is paid for out of unused source media. Clips that already run to
/// the end of their source have none, and the honest answer is a cut plus a
/// warning naming the side that ran out — not a file that is shorter than the
/// timeline it came from.
#[test]
fn test_render_without_handles_degrades_a_transition_to_a_cut_and_says_so() {
    if available_ffmpeg_path().is_none() {
        return;
    }

    let dir = create_temp_project("render_transition_av");
    let path = project_path(&dir, "render_transition_av");

    // Four seconds of source for a four-second shot: nothing left over.
    let source_path = dir.path().join("av_source.mp4");
    if !create_sample_video_with_scene_change_and_audio(&source_path) {
        return;
    }

    let (sequence_id, track_id, outgoing_clip) =
        place_two_shot_timeline(&path, [&source_path, &source_path], 0.0);
    add_dissolve(&path, &sequence_id, &track_id, &outgoing_clip);

    let clips = run_cli_ok(&["timeline", "clips", "--path", &path]);
    let clips = clips["clips"].as_array().unwrap();
    assert_eq!(clips.len(), 2, "two back-to-back clips: {clips:?}");
    let timeline_end_sec: f64 = clips
        .iter()
        .map(|clip| clip["timelineInSec"].as_f64().unwrap() + clip["durationSec"].as_f64().unwrap())
        .fold(0.0, f64::max);

    let output_path = dir.path().join("transition-render.mp4");
    let (stdout, stderr, success) = run_cli(&[
        "render",
        "start",
        "--path",
        &path,
        "--output",
        output_path.to_str().unwrap(),
    ]);
    assert!(
        success,
        "a transition-carrying render must still succeed.\nstdout: {stdout}\nstderr: {stderr}"
    );
    let rendered: serde_json::Value = serde_json::from_str(&stdout).unwrap();

    // Truthful degradation: the export says what it did instead, and why.
    let warnings = render_warnings(&rendered);
    assert!(
        warnings
            .iter()
            .any(|warning| warning.contains("renders as a cut") && warning.contains("handle")),
        "a transition with no handle to blend with must be reported: {warnings:?}"
    );

    // The invariant an unpaid-for overlap would break: the file is exactly as
    // long as the timeline says it is.
    let rendered_duration = rendered["durationSec"].as_f64().unwrap();
    assert!(
        (rendered_duration - timeline_end_sec).abs() < 0.2,
        "rendered {rendered_duration}s must match the {timeline_end_sec}s timeline: {rendered}"
    );

    // The warning has to describe the file, not merely accompany it. Both shots
    // are the same source here, so the frame on the cut must be that source
    // untouched rather than any mixture: a cut is what was promised, so a cut is
    // what has to be there.
    let spread = sample_rendered_luma_spread(&output_path, TRANSITION_SHOT_SEC)
        .expect("spread at the refused boundary");
    assert!(
        spread < 40,
        "a boundary reported as a cut must not be blended or dithered; luma spread \
         across the middle of the frame measured {spread}"
    );

    let (verify_stdout, verify_stderr, verify_code) = run_cli_exit(&[
        "verify",
        "--path",
        &path,
        "--file",
        output_path.to_str().unwrap(),
    ]);
    assert_ne!(
        verify_code, 2,
        "verify itself must run.\nstdout: {verify_stdout}\nstderr: {verify_stderr}"
    );
    let report: serde_json::Value = serde_json::from_str(&verify_stdout).unwrap();
    let duration_check = find_check(&report, "render.duration_mismatch");
    assert_eq!(
        duration_check["status"], "passed",
        "the render must not disagree with the timeline it came from: {duration_check}"
    );
}

/// Feature: rendering part of a sequence that crosses a blended boundary
/// Scenario: the range is exactly as long as asked for and still shows the blend
///
/// A range render trims the finished stream, so a transition whose offset was
/// measured against the whole timeline rather than against its own group would
/// show up here as a range that is the wrong length or misses the blend.
///
/// A smoke test, deliberately: `--start`/`--end` become output-side `-ss`/`-t`,
/// so the whole graph - transitions and all - is built and run exactly as it is
/// for a full render and only the tail of the encode is discarded. What this
/// covers is that the range plumbing does not disturb the blend, not that the
/// blend is computed differently inside a range.
#[test]
fn test_render_range_across_a_transition_keeps_its_length_and_shows_the_blend() {
    if available_ffmpeg_path().is_none() {
        return;
    }

    let dir = create_temp_project("render_transition_range");
    let path = project_path(&dir, "render_transition_range");

    let dark = dir.path().join("dark.mp4");
    let light = dir.path().join("light.mp4");
    if !create_solid_tone_source(&dark, "black", 440, 8) {
        return;
    }
    if !create_solid_tone_source(&light, "white", 880, 8) {
        return;
    }

    let (sequence_id, track_id, outgoing_clip) =
        place_two_shot_timeline(&path, [&dark, &light], 2.0);
    add_dissolve(&path, &sequence_id, &track_id, &outgoing_clip);

    // Two seconds straddling the cut at 4s.
    const RANGE_START_SEC: f64 = 3.0;
    const RANGE_END_SEC: f64 = 5.0;

    let output_path = dir.path().join("range-render.mp4");
    let (stdout, stderr, success) = run_cli(&[
        "render",
        "start",
        "--path",
        &path,
        "--output",
        output_path.to_str().unwrap(),
        "--start",
        &RANGE_START_SEC.to_string(),
        "--end",
        &RANGE_END_SEC.to_string(),
    ]);
    assert!(
        success,
        "a range across a transition must render.\nstdout: {stdout}\nstderr: {stderr}"
    );

    // Counted in decoded frames, not trusted from the container: a container
    // duration is written by the muxer from timestamps and can round its way
    // past a missing frame, which is exactly the error a range render makes.
    let fps = ffprobe_video_fps(&output_path).expect("range fps");
    let frames = ffprobe_video_frame_count(&output_path).expect("range frame count");
    assert_eq!(
        frames,
        ((RANGE_END_SEC - RANGE_START_SEC) * fps).round() as u64,
        "a {}s range at {fps}fps must render exactly that many frames",
        RANGE_END_SEC - RANGE_START_SEC
    );

    // The cut sits one second into the range.
    let at_cut = sample_rendered_mean_brightness(&output_path, 1.0)
        .expect("frame at the cut inside the range");
    assert!(
        (90..=170).contains(&at_cut),
        "the blend must survive a range render, measured {at_cut}"
    );
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
    if available_ffmpeg_path().is_none() {
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
    available_ffmpeg_path()?;

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

/// Rewrites every occurrence of an asset id in a project's persisted state.
///
/// Stands in for the threat this guards against: an operation log or snapshot
/// that reached the machine from somewhere other than this CLI. Nothing on the
/// load path validates the ids inside one, so a project file is free to name an
/// asset `../../../secret`.
fn rewrite_persisted_asset_id(project_path: &str, from: &str, to: &str) {
    let state_dir = PathBuf::from(project_path)
        .join(".openreelio")
        .join("state");
    for file in ["ops.jsonl", "snapshot.json"] {
        let path = state_dir.join(file);
        if let Ok(content) = std::fs::read_to_string(&path) {
            std::fs::write(&path, content.replace(from, to)).unwrap();
        }
    }
}

#[test]
fn test_analysis_report_refuses_an_asset_id_that_names_a_path() {
    // The report opens two files named after the asset id — the cached bundle
    // at `.openreelio/analysis/<id>/bundle.json` and the annotation at
    // `.openreelio/annotations/<id>.json` — so the id decides which file the
    // process opens. An id that walks out of those directories reads an
    // arbitrary JSON file and prints its contents straight back to the caller.
    let (dir, path, asset_id) = create_project_with_analysis("analysis_report_traversal");

    // A file outside the project, at exactly the place the annotation lookup
    // lands for `../../../secret`, and shaped so its text would be echoed
    // verbatim into the report's `annotations.ocrPreview`.
    std::fs::write(
        dir.path().join("secret.json"),
        serde_json::json!({
            "analysis": {
                "textOcr": {
                    "provider": "outside",
                    "results": [{ "text": "OUTSIDE-THE-PROJECT-SECRET" }],
                }
            }
        })
        .to_string(),
    )
    .unwrap();

    // The exploit needs the hostile id to survive the state lookup, which is
    // what a project file that was not written by this CLI provides.
    rewrite_persisted_asset_id(&path, &asset_id, "../../../secret");

    for hostile in [
        "../../../secret",
        r"..\..\..\secret",
        "..",
        "nested/secret",
        r"nested\secret",
        "C:",
    ] {
        let (stdout, stderr) =
            run_cli_err(&["analysis", "report", "--path", &path, "--id", hostile]);

        assert!(
            stderr.contains("path traversal") || stderr.contains("assetId"),
            "'{hostile}' must be refused as an unusable id, not attempted.\n\
             stdout: {stdout}\nstderr: {stderr}"
        );
        assert!(
            !stdout.contains("OUTSIDE-THE-PROJECT-SECRET")
                && !stderr.contains("OUTSIDE-THE-PROJECT-SECRET"),
            "'{hostile}' must never disclose a file outside the project.\n\
             stdout: {stdout}\nstderr: {stderr}"
        );
    }

    // The same guard covers the search verb, which builds the very same report.
    let (stdout, stderr) = run_cli_err(&[
        "analysis",
        "search",
        "--path",
        &path,
        "--id",
        "../../../secret",
        "--query",
        "secret",
    ]);
    assert!(
        !stdout.contains("OUTSIDE-THE-PROJECT-SECRET")
            && !stderr.contains("OUTSIDE-THE-PROJECT-SECRET"),
        "search must not disclose a file outside the project.\n\
         stdout: {stdout}\nstderr: {stderr}"
    );
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
    let Some(ffmpeg_path) = available_ffmpeg_path() else {
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
    // The default still is the composited edit, so it belongs to the whole
    // stack rather than to one source clip - it reports the tier that produced
    // it instead of a clip id.
    assert_eq!(
        still["frames"][0]["source"], "composite",
        "the agent must be looking at the edit, not at footage: {still}"
    );
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
fn test_packs_list_returns_every_registry() {
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
            Some("text") => {
                assert!(pack["category"].is_string(), "{pack}");
                assert!(pack["defaultDurationSec"].is_number(), "{pack}");
                assert!(pack["clip"]["style"].is_object(), "{pack}");
                assert!(pack["clip"]["position"].is_object(), "{pack}");
            }
            Some("pacing") => {
                assert!(pack["tempo"].is_string(), "{pack}");
                assert!(pack["targetShotSec"].is_number(), "{pack}");
                assert!(pack["shotVarianceSec"].is_number(), "{pack}");
                assert!(pack["transitionEveryN"].is_number(), "{pack}");
                assert!(pack["respectShotBoundaries"].is_boolean(), "{pack}");
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

    let texts = run_cli_ok(&["packs", "list", "--kind", "text"]);
    assert_eq!(texts["kind"], "text");
    let text_packs = texts["packs"].as_array().expect("packs");
    assert_eq!(texts["count"].as_u64().unwrap() as usize, text_packs.len());
    assert!(text_packs.iter().all(|pack| pack["kind"] == "text"));

    let text_ids: Vec<&str> = text_packs
        .iter()
        .filter_map(|pack| pack["id"].as_str())
        .collect();
    // Presets the CLI used to reject outright.
    for id in ["quote", "watermark", "countdown", "label", "tech-style"] {
        assert!(text_ids.contains(&id), "{text_ids:?}");
    }

    let quote = text_packs
        .iter()
        .find(|pack| pack["id"] == "quote")
        .expect("quote preset");
    assert_eq!(quote["category"], "creative");
    assert_eq!(quote["defaultDurationSec"], 5.0);
    assert_eq!(quote["clip"]["style"]["fontFamily"], "Georgia");
    assert_eq!(quote["clip"]["style"]["italic"], true);
    assert!(quote["aliases"]
        .as_array()
        .expect("aliases")
        .iter()
        .any(|alias| alias == "pull_quote"));

    let pacing = run_cli_ok(&["packs", "list", "--kind", "pacing"]);
    assert_eq!(pacing["kind"], "pacing");
    let pacing_packs = pacing["packs"].as_array().expect("packs");
    assert_eq!(
        pacing["count"].as_u64().unwrap() as usize,
        pacing_packs.len()
    );
    assert!(pacing_packs.iter().all(|pack| pack["kind"] == "pacing"));

    let pacing_ids: Vec<&str> = pacing_packs
        .iter()
        .filter_map(|pack| pack["id"].as_str())
        .collect();
    for id in ["shorts-hook-fast", "dynamic-social", "calm-longform"] {
        assert!(pacing_ids.contains(&id), "{pacing_ids:?}");
    }

    // Everything an agent needs to pick a profile without running it first.
    let social = pacing_packs
        .iter()
        .find(|pack| pack["id"] == "dynamic-social")
        .expect("dynamic-social profile");
    assert_eq!(social["tempo"], "moderate");
    assert_eq!(social["targetShotSec"], 2.5);

    // Every shipped profile cuts hard. The renderer does place transitions, but
    // a profile cuts one asset, so every boundary it makes is a razor split and
    // a blend across one mixes the same footage into itself — invisible, and
    // paid for in encode time. Listing a recipe here would advertise an effect
    // the file cannot show.
    for pack in pacing_packs {
        assert!(
            pack["transitionRecipe"].is_null(),
            "profile '{}' must not advertise a transition that would render invisibly: {pack}",
            pack["id"]
        );
        assert_eq!(pack["transitionEveryN"], 0, "{pack}");
    }

    let (_stdout, stderr) = run_cli_err(&["packs", "list", "--kind", "nonsense"]);
    assert!(
        stderr.contains("caption")
            && stderr.contains("transition")
            && stderr.contains("text")
            && stderr.contains("pacing"),
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

#[test]
fn test_text_add_accepts_every_curated_preset() {
    // Before the catalog was unified, `--preset quote` answered "Unsupported
    // text preset" while help-json and the MCP hints advertised it. Every id
    // the registry publishes now has to survive an actual add.
    let dir = create_temp_project("text_preset_catalog_test");
    let path = project_path(&dir, "text_preset_catalog_test");

    let listing = run_cli_ok(&["packs", "list", "--kind", "text"]);
    let presets = listing["packs"].as_array().expect("packs").clone();
    assert!(presets.len() >= 22, "{} presets listed", presets.len());

    for (index, preset) in presets.iter().enumerate() {
        let id = preset["id"].as_str().expect("preset id");
        let start = (index as f64) * 20.0;
        let add = run_cli_ok(&[
            "text",
            "add",
            "--path",
            &path,
            "--text",
            "Catalog Probe",
            "--start",
            &start.to_string(),
            "--preset",
            id,
        ]);
        assert_eq!(add["status"], "ok", "preset '{id}' must add");
    }

    let list = run_cli_ok(&["text", "list", "--path", &path]);
    assert_eq!(list["count"].as_u64().unwrap() as usize, presets.len());
}

#[test]
fn test_text_add_preset_supplies_style_and_default_duration() {
    let dir = create_temp_project("text_preset_defaults_test");
    let path = project_path(&dir, "text_preset_defaults_test");

    let add = run_cli_ok(&[
        "text",
        "add",
        "--path",
        &path,
        "--text",
        "\"Cut the noise\"",
        "--start",
        "3",
        "--preset",
        "quote",
    ]);
    assert_eq!(add["status"], "ok");

    let list = run_cli_ok(&["text", "list", "--path", &path]);
    let clip = &list["clips"][0];
    // The preset's own typography, not a generic default.
    assert_eq!(clip["textData"]["style"]["fontFamily"], "Georgia");
    assert_eq!(clip["textData"]["style"]["fontSize"], 42);
    assert_eq!(clip["textData"]["style"]["italic"], true);
    assert_eq!(clip["textData"]["opacity"], 0.95);
    // ...and the preset's suggested duration, since --duration was omitted.
    assert_eq!(clip["durationSec"], 5.0);

    // An explicit flag still wins over the preset value.
    let dir2 = create_temp_project("text_preset_override_test");
    let path2 = project_path(&dir2, "text_preset_override_test");
    run_cli_ok(&[
        "text",
        "add",
        "--path",
        &path2,
        "--text",
        "Override",
        "--start",
        "0",
        "--preset",
        "quote",
        "--font-size",
        "96",
        "--duration",
        "2",
    ]);
    let list2 = run_cli_ok(&["text", "list", "--path", &path2]);
    assert_eq!(list2["clips"][0]["textData"]["style"]["fontSize"], 96);
    assert_eq!(
        list2["clips"][0]["textData"]["style"]["fontFamily"],
        "Georgia"
    );
    assert_eq!(list2["clips"][0]["durationSec"], 2.0);
}

#[test]
fn test_text_add_rejects_an_unknown_preset_with_the_valid_list() {
    let dir = create_temp_project("text_preset_unknown_test");
    let path = project_path(&dir, "text_preset_unknown_test");

    let (_stdout, stderr) = run_cli_err(&[
        "text",
        "add",
        "--path",
        &path,
        "--text",
        "Nope",
        "--start",
        "0",
        "--preset",
        "not-a-preset",
    ]);

    assert!(stderr.contains("Unknown text preset"), "{stderr}");
    for id in ["lower-third", "quote", "watermark", "countdown"] {
        assert!(stderr.contains(id), "error must name '{id}': {stderr}");
    }
    assert!(stderr.contains("default"), "{stderr}");
}

#[test]
fn test_command_execute_resolves_a_text_preset_into_concrete_values() {
    let dir = create_temp_project("text_preset_command_test");
    let path = project_path(&dir, "text_preset_command_test");

    let info = run_cli_ok(&["timeline", "info", "--path", &path]);
    let sequence_id = info["sequenceId"]
        .as_str()
        .expect("sequence id")
        .to_string();

    let track = run_cli_ok(&[
        "timeline",
        "add-track",
        "--path",
        &path,
        "--kind",
        "video",
        "--name",
        "Text",
    ]);
    let track_id = track["createdIds"][0]
        .as_str()
        .expect("track id")
        .to_string();

    let payload = serde_json::json!({
        "sequenceId": sequence_id,
        "trackId": track_id,
        "timelineIn": 2.0,
        "duration": 6.0,
        "preset": "logo-bug",
        "textData": { "content": "OPENREELIO" },
    })
    .to_string();

    let executed = run_cli_ok(&[
        "command",
        "execute",
        "--path",
        &path,
        "--type",
        "AddTextClip",
        "--payload",
        &payload,
    ]);
    assert_eq!(executed["status"], "ok");

    let list = run_cli_ok(&["text", "list", "--path", &path]);
    let clip = &list["clips"][0];
    assert_eq!(clip["textData"]["content"], "OPENREELIO");
    assert_eq!(clip["textData"]["style"]["backgroundColor"], "#0F766ECC");
    assert_eq!(clip["textData"]["position"]["x"], 0.94);
    assert_eq!(clip["textData"]["opacity"], 0.85);

    // The op log records what the preset produced, never the id that produced
    // it, so replay does not depend on the registry.
    let ops = run_cli_ok(&["state", "ops", "--path", &path]);
    let raw = ops.to_string();
    assert!(
        !raw.contains("logo-bug"),
        "the op log must not name a preset"
    );
    assert!(
        raw.contains("#0F766ECC"),
        "the op log must carry the values"
    );
}

// ── MCP server over stdio ───────────────────────────────────────────────────

/// Drives the MCP server over stdio and returns one parsed response per request.
///
/// The transport is newline-delimited JSON-RPC with no framing headers, and the
/// server reads until stdin closes — so the requests go in, stdin is dropped,
/// and the process is left to exit on its own.
fn run_mcp_stdio(project_path: &str, requests: &[serde_json::Value]) -> Vec<serde_json::Value> {
    use std::io::Write;
    use std::process::Stdio;

    let mut child = Command::new(cli_bin())
        .args(["mcp", "--stdio", "--project", project_path])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("Failed to spawn the MCP server");

    {
        let stdin = child.stdin.as_mut().expect("MCP server stdin");
        for request in requests {
            writeln!(
                stdin,
                "{}",
                serde_json::to_string(request).expect("request JSON")
            )
            .expect("Failed to write an MCP request");
        }
    }
    drop(child.stdin.take());

    let output = child.wait_with_output().expect("MCP server output");
    let stdout = String::from_utf8_lossy(&output.stdout);

    stdout
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| {
            serde_json::from_str(line).unwrap_or_else(|error| {
                panic!(
                    "MCP server wrote a non-JSON line: {error}\nline: {line}\nstderr: {}",
                    String::from_utf8_lossy(&output.stderr)
                )
            })
        })
        .collect()
}

fn mcp_request(id: u32, method: &str, params: serde_json::Value) -> serde_json::Value {
    serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": method,
        "params": params,
    })
}

#[test]
fn test_mcp_frame_extract_returns_a_contact_sheet_inline_over_stdio() {
    let Some((dir, path, _asset_id)) = create_project_with_timeline_clip("mcp_frame_sheet_test", 4)
    else {
        return;
    };

    // The judge path reads a rendered file, and the MCP server confines that
    // path to the project — so the render has to land inside it.
    let render_path = dir.path().join("mcp_frame_sheet_test").join("render.mp4");
    let rendered = run_cli_ok(&[
        "render",
        "start",
        "--path",
        &path,
        "--proxy",
        "--output",
        render_path.to_str().unwrap(),
    ]);
    assert_eq!(rendered["status"], "ok");
    if !render_path.exists() {
        return;
    }

    let responses = run_mcp_stdio(
        &path,
        &[
            mcp_request(1, "tools/list", serde_json::json!({})),
            mcp_request(
                2,
                "tools/call",
                serde_json::json!({
                    "name": "openreelio.frame.extract",
                    "arguments": {
                        "file": "render.mp4",
                        "grid": "2x2",
                        "between": [0.0, 3.0],
                        "labelCells": true
                    }
                }),
            ),
        ],
    );
    assert_eq!(responses.len(), 2, "one response per request");

    // The tool is advertised without any write grant.
    let tools = responses[0]["result"]["tools"]
        .as_array()
        .expect("tools array");
    assert!(tools
        .iter()
        .any(|tool| tool["name"] == "openreelio.frame.extract"));

    let content = responses[1]["result"]["content"]
        .as_array()
        .unwrap_or_else(|| panic!("frame extract failed: {}", responses[1]));
    assert_eq!(
        content.len(),
        2,
        "a sheet returns one image block plus its metadata"
    );

    // An MCP-connected vision agent gets the picture itself, not a path it has
    // no tool to read.
    assert_eq!(content[0]["type"], "image");
    assert_eq!(content[0]["mimeType"], "image/jpeg");
    assert!(
        content[0]["data"].as_str().expect("image data").len() > 1000,
        "the sheet must carry real image bytes"
    );

    assert_eq!(content[1]["type"], "text");
    let payload: serde_json::Value =
        serde_json::from_str(content[1]["text"].as_str().expect("text block"))
            .expect("frame extract payload");
    assert_eq!(payload["status"], "ok");
    assert_eq!(payload["mode"], "file");
    assert_eq!(payload["sheet"]["cols"], 2);
    assert_eq!(payload["sheet"]["rows"], 2);
    assert_eq!(
        payload["sheet"]["cells"]
            .as_array()
            .expect("cells array")
            .len(),
        4
    );

    // The sheet is written into the project's own cache, and the path is
    // reported rather than chosen by the caller.
    let sheet_path = PathBuf::from(payload["sheet"]["path"].as_str().expect("sheet path"));
    assert!(sheet_path.exists(), "the reported sheet must exist");
    assert!(
        sheet_path.starts_with(
            dir.path()
                .join("mcp_frame_sheet_test")
                .join(".openreelio")
                .join("cache")
                .join("frames")
        ),
        "the sheet must live in the project frame cache, got {}",
        sheet_path.display()
    );
}

#[test]
fn test_mcp_frame_extract_refuses_a_render_outside_the_project() {
    let dir = create_temp_project("mcp_frame_scope_test");
    let path = project_path(&dir, "mcp_frame_scope_test");
    let outside = dir.path().join("outside_render.mp4");
    std::fs::write(&outside, b"fake render bytes").expect("outside render fixture");

    let responses = run_mcp_stdio(
        &path,
        &[mcp_request(
            1,
            "tools/call",
            serde_json::json!({
                "name": "openreelio.frame.extract",
                "arguments": { "time": 0.5, "file": outside.to_str().unwrap() }
            }),
        )],
    );

    // A path outside the project is refused before FFmpeg is ever spawned, so a
    // read-only server cannot be used to probe the disk.
    assert_eq!(responses.len(), 1);
    assert_eq!(responses[0]["error"]["code"], -32001);
    let message = responses[0]["error"]["message"]
        .as_str()
        .expect("error message");
    assert!(
        message.contains("project directory"),
        "the refusal must say what the scope is: {message}"
    );
}

// ============================================================================
// Burned-in caption typography (libass)
// ============================================================================

/// Builds a single-caption vertical sequence and returns the ASS script for it.
///
/// Goes through the real `build_ass_text_overlay_script`, so what libass reads
/// below is the artifact an export writes, not a fixture shaped to pass.
fn vertical_caption_ass_script(text: &str, font_family: &str, font_size: u32) -> String {
    vertical_caption_ass_script_with_style(
        text,
        serde_json::json!({ "fontFamily": font_family, "fontSize": font_size }),
    )
}

/// Builds the ASS script for a single bottom-preset caption carrying `style`.
fn vertical_caption_ass_script_with_style(text: &str, style: serde_json::Value) -> String {
    use openreelio_core::timeline::{Clip, Sequence, SequenceFormat, Track};

    let mut sequence = Sequence::new("Burn-in", SequenceFormat::shorts_1080());
    let mut track = Track::new_caption("Captions");
    let mut clip = Clip::new("caption-asset")
        .with_source_range(0.0, 2.0)
        .place_at(0.0);
    clip.label = Some(text.to_string());
    clip.caption_style = Some(style);
    clip.caption_position = Some(serde_json::json!({
        "type": "preset",
        "vertical": "bottom",
        "marginPercent": 10
    }));
    track.add_clip(clip);
    sequence.add_track(track);

    openreelio_core::render::build_ass_text_overlay_script(
        &sequence,
        &std::collections::HashMap::new(),
    )
    .expect("script builds")
    .expect("a caption produces a script")
}

/// Renders `script` over black and returns the frame as 8-bit grayscale.
///
/// The script is written into the directory FFmpeg runs in so the filtergraph
/// can name it without escaping a Windows drive letter.
fn render_ass_over_black(
    ffmpeg_path: &std::path::Path,
    script: &str,
    width: u32,
    height: u32,
) -> Option<Vec<u8>> {
    let dir = tempfile::tempdir().expect("temp dir");
    std::fs::write(dir.path().join("overlay.ass"), script).expect("write script");

    let output = Command::new(ffmpeg_path)
        .current_dir(dir.path())
        .args([
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            &format!("color=c=black:s={width}x{height}:d=2"),
            "-vf",
            "subtitles=overlay.ass",
            "-ss",
            "1",
            "-frames:v",
            "1",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "gray",
            "-",
        ])
        .output()
        .ok()?;

    if !output.status.success() {
        eprintln!(
            "ffmpeg could not burn in the ASS script: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        return None;
    }

    let expected = (width * height) as usize;
    if output.stdout.len() < expected {
        return None;
    }
    Some(output.stdout[..expected].to_vec())
}

/// Threshold above which a grayscale sample counts as text rather than backing.
const CAPTION_INK_THRESHOLD: u8 = 96;

/// Row ranges carrying text, grouped into the bands they form.
///
/// A wrapped caption produces one band per line with a gap of empty rows
/// between them; an unwrapped one produces a single band.
fn text_row_bands(frame: &[u8], width: u32, height: u32) -> Vec<(u32, u32)> {
    let mut bands: Vec<(u32, u32)> = Vec::new();

    for row in 0..height {
        let start = (row * width) as usize;
        let has_ink = frame[start..start + width as usize]
            .iter()
            .any(|value| *value > CAPTION_INK_THRESHOLD);

        match (has_ink, bands.last_mut()) {
            (true, Some(band)) if band.1 + 1 == row => band.1 = row,
            (true, _) => bands.push((row, row)),
            (false, _) => {}
        }
    }

    bands
}

/// Horizontal extent of every inked pixel, as (leftmost, rightmost) column.
fn text_column_extent(frame: &[u8], width: u32, height: u32) -> Option<(u32, u32)> {
    let mut extent: Option<(u32, u32)> = None;

    for row in 0..height {
        for column in 0..width {
            if frame[(row * width + column) as usize] > CAPTION_INK_THRESHOLD {
                extent = Some(match extent {
                    Some((left, right)) => (left.min(column), right.max(column)),
                    None => (column, column),
                });
            }
        }
    }

    extent
}

/// Feature: Caption burn-in
/// Scenario: a caption too long for one line wraps inside the safe box
///
/// Given a vertical sequence and a caption far wider than the canvas
/// When the export's ASS script is burned in by libass
/// Then the text occupies several lines and none of it leaves the wrap box
///
/// This is the assertion the unit tests cannot make: `WrapStyle: 0` and event
/// margins are only worth writing if the renderer that reads them wraps.
#[test]
fn test_burned_in_caption_wraps_inside_the_safe_box() {
    let Some(ffmpeg_path) = available_ffmpeg_path() else {
        return;
    };

    let (width, height) = (1080u32, 1920u32);
    let script = vertical_caption_ass_script(
        "This caption is much too long to fit on one line of a vertical video",
        "Bebas Neue",
        64,
    );
    assert!(script.contains("WrapStyle: 0"));
    assert!(
        !script.contains("\\pos("),
        "a wrapped caption must not be positioned"
    );

    let Some(frame) = render_ass_over_black(&ffmpeg_path, &script, width, height) else {
        skip_without_ffmpeg("ffmpeg could not burn the ASS overlay in");
        return;
    };

    let bands = text_row_bands(&frame, width, height);
    assert!(
        bands.len() >= 2,
        "an over-long caption must wrap into several lines, got bands {bands:?}"
    );

    let (left, right) = text_column_extent(&frame, width, height).expect("text renders");
    // The wrap box is 80% of the canvas. Outline and antialiasing bleed a few
    // pixels, so the bound is checked generously rather than exactly.
    assert!(
        left >= 80 && right <= width - 80,
        "wrapped text must stay inside the safe box, got columns {left}..{right}"
    );

    // Bottom preset at a 10% margin: the block sits low in the frame, clear of
    // the very edge.
    let (first_band_top, last_band_bottom) = (bands[0].0, bands[bands.len() - 1].1);
    assert!(
        first_band_top > height / 2 && last_band_bottom < height - 80,
        "a bottom caption must sit above the bottom margin, got rows {first_band_top}..{last_band_bottom}"
    );
}

/// Feature: Caption burn-in
/// Scenario: a bundled font renders without being installed on the host
///
/// Given a caption in a family the script carries in its `[Fonts]` section
/// When the same caption is burned in with that section removed and the family
///      renamed to one no host can have
/// Then the two frames differ, because the first used the embedded face
///
/// A script that embeds a font it cannot actually deliver would still render -
/// libass substitutes silently - so the only honest check is against a render
/// guaranteed to have no font of its own.
#[test]
fn test_bundled_font_is_delivered_through_the_ass_fonts_section() {
    let Some(ffmpeg_path) = available_ffmpeg_path() else {
        return;
    };

    let (width, height) = (1080u32, 1920u32);
    // Luckiest Guy carries unmistakably heavy glyphs, so using it rather than a
    // fallback sans shows up in the pixels instead of merely being plausible.
    let embedded = vertical_caption_ass_script("HANDLED", "Luckiest Guy", 120);
    assert!(
        embedded.contains("[Fonts]\nfontname: LuckiestGuy-Regular_0.ttf"),
        "the script must carry the font it names"
    );

    let fonts_section_start = embedded.find("[Fonts]\n").expect("fonts section");
    let fonts_section_end = embedded.find("[Events]\n").expect("events section");
    let without_font = format!(
        "{}{}",
        &embedded[..fonts_section_start],
        &embedded[fonts_section_end..]
    )
    .replace("Luckiest Guy", "OpenReelio Absent Family");

    let Some(with_embed) = render_ass_over_black(&ffmpeg_path, &embedded, width, height) else {
        skip_without_ffmpeg("ffmpeg could not burn the ASS overlay in");
        return;
    };
    let without_embed = render_ass_over_black(&ffmpeg_path, &without_font, width, height)
        .expect("the control render must succeed once the first one did");

    assert!(
        !text_row_bands(&with_embed, width, height).is_empty(),
        "the embedded font must actually draw glyphs"
    );

    let differing = with_embed
        .iter()
        .zip(&without_embed)
        .filter(|(embedded, fallback)| embedded.abs_diff(**fallback) > 32)
        .count();
    assert!(
        differing > 1000,
        "the embedded face must render differently from a host fallback, only {differing} pixels differed"
    );
}

/// Strips the `[Fonts]` section and renames the family to one no host can have.
///
/// The control this produces is guaranteed to render in whatever fallback the
/// host font provider offers, which is the only way to prove the first render
/// used the embedded face rather than merely looking plausible.
fn ass_script_without_embedded_font(script: &str, family: &str) -> String {
    let fonts_section_start = script.find("[Fonts]\n").expect("fonts section");
    let fonts_section_end = script.find("[Events]\n").expect("events section");

    format!(
        "{}{}",
        &script[..fonts_section_start],
        &script[fonts_section_end..]
    )
    .replace(family, "OpenReelio Absent Family")
}

/// Counts samples that differ by more than antialiasing noise between two frames.
fn differing_sample_count(left: &[u8], right: &[u8]) -> usize {
    left.iter()
        .zip(right)
        .filter(|(left, right)| left.abs_diff(**right) > 32)
        .count()
}

/// Feature: Caption burn-in
/// Scenario: a bundled family is reachable at both weights by the name the exporter writes
///
/// Given a caption in a bundled family, once regular and once bold
/// When each is burned in with its `[Fonts]` section intact, and again with
///      that section stripped and the family renamed to one no host can have
/// Then both weights differ from their control, and from each other
///
/// This is the check no structural assertion can make. The bundled TikTok Sans
/// statics carried their family in `name` ID 16, which libass never reads, so
/// every caption in that family silently rendered in the host's fallback while
/// the registry, the embed and the emitted script all looked correct. The bold
/// half covers the other end of the same failure: an event that emits `\b400`
/// overrides the style's `Bold` column, and a bold face whose `OS/2`/`head`
/// bold bits are unset can never be selected even once the weight is right.
#[test]
fn test_bundled_family_renders_at_both_weights_through_the_embedded_faces() {
    let Some(ffmpeg_path) = available_ffmpeg_path() else {
        return;
    };

    let (width, height) = (1080u32, 1920u32);
    let family = "TikTok Sans";

    let regular = vertical_caption_ass_script_with_style(
        "WEIGHT",
        serde_json::json!({ "fontFamily": family, "fontSize": 140 }),
    );
    let bold = vertical_caption_ass_script_with_style(
        "WEIGHT",
        serde_json::json!({ "fontFamily": family, "fontSize": 140, "bold": true }),
    );

    // The emitter has to name the weight, or libass reads the default `\b400`
    // as an absolute weight and the style's `Bold` column never takes effect.
    assert!(regular.contains(r"\b400"), "got: {regular}");
    assert!(bold.contains(r"\b700"), "got: {bold}");
    assert!(!bold.contains(r"\b400"), "got: {bold}");
    for script in [&regular, &bold] {
        assert!(
            script.contains("[Fonts]\nfontname: TikTokSans-Regular_0.ttf"),
            "the script must carry the faces it names, got: {script}"
        );
        assert!(
            script.contains("fontname: TikTokSans-Bold_0.ttf"),
            "the script must carry every weight of the family, got: {script}"
        );
    }

    let renders: Vec<Option<Vec<u8>>> = [&regular, &bold]
        .iter()
        .map(|script| render_ass_over_black(&ffmpeg_path, script, width, height))
        .collect();
    let [Some(regular_frame), Some(bold_frame)] = renders.as_slice() else {
        skip_without_ffmpeg("ffmpeg could not burn the ASS overlay in");
        return;
    };

    let regular_control = render_ass_over_black(
        &ffmpeg_path,
        &ass_script_without_embedded_font(&regular, family),
        width,
        height,
    )
    .expect("the control render must succeed once the first one did");
    let bold_control = render_ass_over_black(
        &ffmpeg_path,
        &ass_script_without_embedded_font(&bold, family),
        width,
        height,
    )
    .expect("the control render must succeed once the first one did");

    for (label, frame) in [("regular", regular_frame), ("bold", bold_frame)] {
        assert!(
            !text_row_bands(frame, width, height).is_empty(),
            "the {label} weight must draw glyphs at all"
        );
    }

    for (label, frame, control) in [
        ("regular", regular_frame, &regular_control),
        ("bold", bold_frame, &bold_control),
    ] {
        let differing = differing_sample_count(frame, control);
        assert!(
            differing > 1000,
            "the embedded {label} face must render differently from a host fallback, only {differing} samples differed"
        );
    }

    let weights_differ = differing_sample_count(regular_frame, bold_frame);
    assert!(
        weights_differ > 1000,
        "the bold weight must render differently from the regular one, only {weights_differ} samples differed"
    );
}

// =============================================================================
// OpenTimelineIO interchange
// =============================================================================
//
// These tests never touch FFmpeg: OTIO is JSON, and the assets are stub files
// whose unknown duration falls back to the engine's 10s default, which is
// enough to build and compare a cut.
//
// The round trip a user actually cares about — OpenReelio to DaVinci Resolve —
// cannot run in CI. Validating it is a manual step: export a sequence, then in
// Resolve use File > Import > Timeline > Import AAF, EDL, XML... and pick the
// .otio file.

/// Builds a project with a two-track cut: a video track holding two adjacent
/// shots, a 5s hole and a tail shot, plus an audio track; the first cut carries
/// a one-second cross dissolve. Returns (project path, sequence id).
fn seed_otio_fixture(dir: &tempfile::TempDir, name: &str) -> (String, String) {
    let path = project_path(dir, name);

    let video_file = dir.path().join("otio_video.mp4");
    std::fs::write(&video_file, b"dummy video").expect("write video fixture");
    let audio_file = dir.path().join("otio_audio.wav");
    std::fs::write(&audio_file, b"dummy audio").expect("write audio fixture");

    let video_asset = run_cli_ok(&[
        "asset",
        "import",
        "--path",
        &path,
        "--file",
        video_file.to_str().unwrap(),
    ])["createdIds"][0]
        .as_str()
        .unwrap()
        .to_string();
    let audio_asset = run_cli_ok(&[
        "asset",
        "import",
        "--path",
        &path,
        "--file",
        audio_file.to_str().unwrap(),
    ])["createdIds"][0]
        .as_str()
        .unwrap()
        .to_string();

    let tracks = run_cli_ok(&["timeline", "tracks", "--path", &path]);
    let video_track = tracks["tracks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|track| track["kind"] == "Video")
        .and_then(|track| track["id"].as_str())
        .expect("the default project should have a video track")
        .to_string();
    let audio_track = tracks["tracks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|track| track["kind"] == "Audio")
        .and_then(|track| track["id"].as_str())
        .expect("the default project should have an audio track")
        .to_string();

    // Two adjacent shots, then a hole from 20s to 25s, then a tail shot.
    for at in ["0.0", "10.0", "25.0"] {
        run_cli_ok(&[
            "timeline",
            "insert",
            "--path",
            &path,
            "--asset",
            &video_asset,
            "--track",
            &video_track,
            "--at",
            at,
        ]);
    }
    run_cli_ok(&[
        "timeline",
        "insert",
        "--path",
        &path,
        "--asset",
        &audio_asset,
        "--track",
        &audio_track,
        "--at",
        "0.0",
    ]);

    let sequence_id = run_cli_ok(&["timeline", "info", "--path", &path])["sequenceId"]
        .as_str()
        .unwrap()
        .to_string();

    // The dissolve goes on the outgoing clip of the first cut.
    let clips = run_cli_ok(&["timeline", "clips", "--path", &path]);
    let first_clip = clips["clips"]
        .as_array()
        .unwrap()
        .iter()
        .find(|clip| clip["trackId"] == video_track.as_str() && clip["timelineInSec"] == 0.0)
        .and_then(|clip| clip["id"].as_str())
        .expect("the first video clip should exist")
        .to_string();

    run_cli_ok(&[
        "command",
        "execute",
        "--path",
        &path,
        "--type",
        "AddEffect",
        "--payload",
        &serde_json::json!({
            "sequenceId": sequence_id,
            "trackId": video_track,
            "clipId": first_clip,
            "effectType": "cross_dissolve",
            "params": { "duration": 1.0 },
        })
        .to_string(),
    ]);

    (path, sequence_id)
}

/// Reduces an OTIO document to the cut it describes: track kinds, and each
/// child's schema and frame extent. Names, ids, metadata and media URLs are
/// dropped, because a re-import regenerates every one of them.
fn otio_cut_shape(document: &serde_json::Value) -> Vec<serde_json::Value> {
    document["tracks"]["children"]
        .as_array()
        .expect("stack children must be an array")
        .iter()
        .filter(|track| {
            !track["children"]
                .as_array()
                .map(|children| children.is_empty())
                .unwrap_or(true)
        })
        .map(|track| {
            let children: Vec<serde_json::Value> = track["children"]
                .as_array()
                .unwrap()
                .iter()
                .map(|child| match child["OTIO_SCHEMA"].as_str() {
                    Some("Transition.1") => serde_json::json!({
                        "schema": "Transition.1",
                        "in": child["in_offset"]["value"],
                        "out": child["out_offset"]["value"],
                    }),
                    _ => serde_json::json!({
                        "schema": child["OTIO_SCHEMA"],
                        "start": child["source_range"]["start_time"]["value"],
                        "duration": child["source_range"]["duration"]["value"],
                        "rate": child["source_range"]["duration"]["rate"],
                    }),
                })
                .collect();
            serde_json::json!({ "kind": track["kind"], "children": children })
        })
        .collect()
}

fn read_otio(path: &std::path::Path) -> serde_json::Value {
    let raw = std::fs::read_to_string(path).expect("the exported OTIO file should be readable");
    serde_json::from_str(&raw).expect("the exported OTIO file should be valid JSON")
}

#[test]
fn test_otio_export_writes_a_cut_interchange_document() {
    let dir = create_temp_project("otio_export_test");
    let (path, _sequence_id) = seed_otio_fixture(&dir, "otio_export_test");
    let out = dir.path().join("cut.otio");

    let result = run_cli_ok(&[
        "otio",
        "export",
        "--path",
        &path,
        "--out",
        out.to_str().unwrap(),
    ]);

    assert_eq!(result["status"], "ok");
    assert_eq!(result["clipCount"], 4);
    assert_eq!(result["trackCount"], 2);
    // The loss report is always present, so a caller can tell "checked and
    // clean" from "not reported".
    assert!(result["warnings"].is_array());
    assert!(result["unsupported"].is_array());

    let document = read_otio(&out);
    assert_eq!(document["OTIO_SCHEMA"], "Timeline.1");
    assert_eq!(document["tracks"]["OTIO_SCHEMA"], "Stack.1");

    let shape = otio_cut_shape(&document);
    assert_eq!(shape.len(), 2);
    // Video: clip, dissolve, clip, gap, clip — and nothing after the last clip.
    let video_children = shape[0]["children"].as_array().unwrap();
    let schemas: Vec<&str> = video_children
        .iter()
        .map(|child| child["schema"].as_str().unwrap())
        .collect();
    assert_eq!(
        schemas,
        vec!["Clip.2", "Transition.1", "Clip.2", "Gap.1", "Clip.2"]
    );
}

#[test]
fn test_otio_round_trip_preserves_the_cut_structure() {
    // Given: a project exported to OTIO
    let source_dir = create_temp_project("otio_source");
    let (source_path, _) = seed_otio_fixture(&source_dir, "otio_source");
    let interchange = source_dir.path().join("round_trip.otio");
    run_cli_ok(&[
        "otio",
        "export",
        "--path",
        &source_path,
        "--out",
        interchange.to_str().unwrap(),
    ]);
    let first = read_otio(&interchange);

    // When: the file is imported into a fresh project and exported again
    let target_dir = create_temp_project("otio_target");
    let target_path = project_path(&target_dir, "otio_target");

    let import = run_cli_ok(&[
        "otio",
        "import",
        "--path",
        &target_path,
        "--file",
        interchange.to_str().unwrap(),
        // The fixture's media sits beside the projects rather than inside
        // either of them, which is exactly the case import refuses by default.
        // Relinking a foreign edit to media held elsewhere is the workflow the
        // flag exists for; the refusal itself is covered below.
        "--allow-external-media",
    ]);
    assert_eq!(import["status"], "ok", "import report: {import}");
    // The fresh project has none of the media, so the plan imports it first.
    assert_eq!(import["assetImports"].as_array().unwrap().len(), 2);

    let round_tripped = target_dir.path().join("round_trip_2.otio");
    run_cli_ok(&[
        "otio",
        "export",
        "--path",
        &target_path,
        "--out",
        round_tripped.to_str().unwrap(),
    ]);
    let second = read_otio(&round_tripped);

    // Then: the same cut comes back — every clip on the same frame, the gap the
    // same length, the dissolve the same split. Ids and names regenerate, so
    // the comparison is structural.
    assert_eq!(
        otio_cut_shape(&first),
        otio_cut_shape(&second),
        "the round trip changed the cut:\nfirst:  {}\nsecond: {}",
        serde_json::to_string_pretty(&otio_cut_shape(&first)).unwrap(),
        serde_json::to_string_pretty(&otio_cut_shape(&second)).unwrap()
    );
}

#[test]
fn test_otio_import_dry_run_leaves_the_project_untouched() {
    // Given: an OTIO file and a fresh project
    let source_dir = create_temp_project("otio_dry_source");
    let (source_path, _) = seed_otio_fixture(&source_dir, "otio_dry_source");
    let interchange = source_dir.path().join("dry.otio");
    run_cli_ok(&[
        "otio",
        "export",
        "--path",
        &source_path,
        "--out",
        interchange.to_str().unwrap(),
    ]);

    let target_dir = create_temp_project("otio_dry_target");
    let target_path = project_path(&target_dir, "otio_dry_target");
    let before = run_cli_ok(&["timeline", "clips", "--path", &target_path]);
    let before_tracks = run_cli_ok(&["timeline", "tracks", "--path", &target_path]);

    // When: importing with --dry-run
    let result = run_cli_ok(&[
        "otio",
        "import",
        "--path",
        &target_path,
        "--file",
        interchange.to_str().unwrap(),
        "--dry-run",
    ]);

    // Then: the plan is printed and nothing is applied
    assert_eq!(result["status"], "ok");
    assert_eq!(result["dryRun"], true);
    assert!(result["stepCount"].as_u64().unwrap() > 0);
    assert!(result["plan"]["steps"].is_array());
    assert!(result["warnings"].is_array());

    let after = run_cli_ok(&["timeline", "clips", "--path", &target_path]);
    let after_tracks = run_cli_ok(&["timeline", "tracks", "--path", &target_path]);
    assert_eq!(after["count"], before["count"]);
    assert_eq!(after_tracks["count"], before_tracks["count"]);
}

/// Every file under `root`, as (relative path, bytes).
///
/// Content rather than mtime: a copy-then-delete migration can preserve a
/// timestamp, and what a caller cares about is that its bytes are where it left
/// them.
fn snapshot_tree(root: &std::path::Path) -> std::collections::BTreeMap<String, Vec<u8>> {
    fn walk(
        dir: &std::path::Path,
        root: &std::path::Path,
        out: &mut std::collections::BTreeMap<String, Vec<u8>>,
    ) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk(&path, root, out);
            } else if let Ok(bytes) = std::fs::read(&path) {
                let key = path
                    .strip_prefix(root)
                    .unwrap_or(&path)
                    .to_string_lossy()
                    .replace('\\', "/");
                out.insert(key, bytes);
            }
        }
    }

    let mut out = std::collections::BTreeMap::new();
    walk(root, root, &mut out);
    out
}

#[test]
fn test_otio_import_dry_run_writes_nothing_to_a_legacy_project_layout() {
    // Given: an OTIO file, and a project whose state still sits in the legacy
    // root files. Opening an editing session migrates those into the hidden
    // state directory — renaming, copying and deleting — before anything the
    // caller asked for happens, so a dry run that opens a session rewrites the
    // project it promised not to touch.
    let source_dir = create_temp_project("otio_legacy_source");
    let (source_path, _) = seed_otio_fixture(&source_dir, "otio_legacy_source");
    let interchange = source_dir.path().join("legacy.otio");
    run_cli_ok(&[
        "otio",
        "export",
        "--path",
        &source_path,
        "--out",
        interchange.to_str().unwrap(),
    ]);

    let target_dir = create_temp_project("otio_legacy_target");
    let target_root = target_dir.path().join("otio_legacy_target");
    let target_path = target_root.to_string_lossy().to_string();

    // Move the state back to the legacy layout this project once used.
    let state_dir = target_root.join(".openreelio").join("state");
    for name in ["ops.jsonl", "snapshot.json", "project.json"] {
        let hidden = state_dir.join(name);
        if hidden.exists() {
            std::fs::rename(&hidden, target_root.join(name)).expect("move state file");
        }
    }
    std::fs::remove_dir_all(target_root.join(".openreelio")).expect("drop the hidden state dir");

    let before = snapshot_tree(&target_root);

    // When: importing with --dry-run
    let result = run_cli_ok(&[
        "otio",
        "import",
        "--path",
        &target_path,
        "--file",
        interchange.to_str().unwrap(),
        "--dry-run",
    ]);

    // Then: the plan is printed, and every byte under the project is where it
    // was — no migrated state files, no created directory, no lock file.
    assert_eq!(result["dryRun"], true);
    assert!(result["stepCount"].as_u64().unwrap() > 0);

    let after = snapshot_tree(&target_root);
    let before_names: Vec<&String> = before.keys().collect();
    let after_names: Vec<&String> = after.keys().collect();
    assert_eq!(
        after_names, before_names,
        "a dry run must not add, move or remove a file"
    );
    assert!(
        before == after,
        "a dry run must not rewrite any file under the project"
    );
}

#[test]
fn test_otio_import_resolves_project_relative_media_against_the_real_project_root() {
    // Given: media inside the project, named once relatively (what our own
    // export writes for media the project holds) and once absolutely. The
    // project root the importer is handed is canonicalised, which on Windows
    // carries a `\\?\` prefix — joined onto a relative reference it turns into
    // `//?/C:/…`, which reads as a network authority and opens nothing.
    let dir = create_temp_project("otio_relative");
    let project_root = dir.path().join("otio_relative");
    let path = project_root.to_string_lossy().to_string();
    std::fs::create_dir_all(project_root.join("media")).expect("create media dir");
    let media = project_root.join("media").join("inside.mp4");
    std::fs::write(&media, b"dummy video").expect("write media");

    let absolute = format!(
        "file:///{}",
        media
            .to_string_lossy()
            .replace('\\', "/")
            .replace(' ', "%20")
    );
    let document = serde_json::json!({
        "OTIO_SCHEMA": "Timeline.1",
        "name": "Relative",
        "tracks": {
            "OTIO_SCHEMA": "Stack.1",
            "name": "Relative",
            "children": [{
                "OTIO_SCHEMA": "Track.1",
                "name": "V1",
                "kind": "Video",
                "children": [
                    otio_clip_node("relative", "media/inside.mp4"),
                    otio_clip_node("absolute", &absolute),
                ]
            }],
            "markers": []
        }
    });
    let file = dir.path().join("relative.otio");
    std::fs::write(&file, document.to_string()).expect("write fixture");

    // When: importing without --allow-external-media
    let result = run_cli_ok(&[
        "otio",
        "import",
        "--path",
        &path,
        "--file",
        file.to_str().unwrap(),
        "--dry-run",
    ]);

    // Then: both spellings name the same openable file, so it imports once
    let imports = result["assetImports"].as_array().unwrap();
    assert_eq!(
        imports.len(),
        1,
        "the two spellings name one file: {result}"
    );
    let uri = imports[0]["uri"].as_str().unwrap();
    assert!(
        !uri.starts_with("//"),
        "a project-relative reference must not resolve to an authority path, got: {uri}"
    );
    assert!(
        std::path::Path::new(uri).exists(),
        "the resolved uri must name the media on disk, got: {uri}"
    );
}

/// A one-media OTIO clip node at 30fps, one second long.
fn otio_clip_node(name: &str, target_url: &str) -> serde_json::Value {
    serde_json::json!({
        "OTIO_SCHEMA": "Clip.2",
        "name": name,
        "source_range": {
            "OTIO_SCHEMA": "TimeRange.1",
            "start_time": { "OTIO_SCHEMA": "RationalTime.1", "value": 0.0, "rate": 30.0 },
            "duration": { "OTIO_SCHEMA": "RationalTime.1", "value": 30.0, "rate": 30.0 }
        },
        "media_reference": {
            "OTIO_SCHEMA": "ExternalReference.1",
            "target_url": target_url
        }
    })
}

#[test]
fn test_otio_import_refuses_media_outside_the_project_by_default() {
    // Given: an OTIO file whose media sits outside the project it is imported
    // into. ImportAsset stats — and for some kinds ffprobes — whatever path it
    // is handed, so an unscoped import is a filesystem probe the file's author
    // gets to aim.
    let source_dir = create_temp_project("otio_scope_source");
    let (source_path, _) = seed_otio_fixture(&source_dir, "otio_scope_source");
    let interchange = source_dir.path().join("scope.otio");
    run_cli_ok(&[
        "otio",
        "export",
        "--path",
        &source_path,
        "--out",
        interchange.to_str().unwrap(),
    ]);

    let target_dir = create_temp_project("otio_scope_target");
    let target_path = project_path(&target_dir, "otio_scope_target");

    // When: importing without the flag
    let result = run_cli_ok(&[
        "otio",
        "import",
        "--path",
        &target_path,
        "--file",
        interchange.to_str().unwrap(),
        "--dry-run",
    ]);

    // Then: no media is imported, and the refusal says why
    assert!(
        result["assetImports"].as_array().unwrap().is_empty(),
        "media outside the project must not be imported: {result}"
    );
    let warnings = result["warnings"].as_array().unwrap();
    assert!(
        warnings.iter().any(|warning| warning
            .as_str()
            .unwrap_or_default()
            .contains("outside the project directory")),
        "the refusal must be reported: {warnings:?}"
    );

    // And with the flag, the same file imports its media.
    let allowed = run_cli_ok(&[
        "otio",
        "import",
        "--path",
        &target_path,
        "--file",
        interchange.to_str().unwrap(),
        "--dry-run",
        "--allow-external-media",
    ]);
    assert_eq!(allowed["assetImports"].as_array().unwrap().len(), 2);
}

#[test]
fn test_otio_import_rejects_an_unknown_schema_version_by_name() {
    let dir = create_temp_project("otio_bad_schema");
    let path = project_path(&dir, "otio_bad_schema");
    let bad = dir.path().join("bad.otio");
    std::fs::write(
        &bad,
        r#"{"OTIO_SCHEMA":"Timeline.9","name":"x","tracks":{"OTIO_SCHEMA":"Stack.1"}}"#,
    )
    .expect("write bad fixture");

    let (_stdout, stderr) = run_cli_err(&[
        "otio",
        "import",
        "--path",
        &path,
        "--file",
        bad.to_str().unwrap(),
    ]);

    assert!(
        stderr.contains("Timeline.9"),
        "the refusal must name the schema it could not read, got: {stderr}"
    );
}

#[test]
fn test_otio_verbs_are_documented_in_help_json() {
    let schema = run_cli_ok(&["help-json"]);
    let commands = schema["commands"].as_object().unwrap();

    assert!(commands.contains_key("otio.export"));
    assert!(commands.contains_key("otio.import"));
    assert!(commands["otio.import"]["params"]["dry-run"].is_object());
}

// =============================================================================
// Result perception: what a frame probe actually shows
// =============================================================================

/// Generates a static SMPTE colour-bar clip.
///
/// Flat colour cannot tell a lossless still from a lossy one — every codec gets
/// a single colour right. Colour bars are static in time, so a still is not
/// hostage to a one-frame seek error, and they carry the hard chroma edges where
/// a 4:2:0 draft encode diverges hardest from the composite.
fn create_colour_bar_video(path: &std::path::Path, size: &str, duration_secs: u32) -> bool {
    let Some(ffmpeg_path) = available_ffmpeg_path() else {
        return false;
    };
    let Some(video_encoder) = preferred_video_encoder(&ffmpeg_path) else {
        eprintln!("Skipping frame probe test: ffmpeg lacks a supported video encoder");
        return false;
    };

    let mut command = Command::new(ffmpeg_path);
    command.args([
        "-y",
        "-f",
        "lavfi",
        "-i",
        &format!("smptebars=s={size}:r=25:d={duration_secs}"),
        "-c:v",
        video_encoder,
    ]);
    if video_encoder == "libx264" {
        command.args(["-pix_fmt", "yuv420p", "-crf", "0"]);
    }

    let status = command
        .arg(path)
        .status()
        .expect("Failed to generate colour bar fixture with ffmpeg");
    if !status.success() {
        eprintln!("Skipping frame probe test: ffmpeg could not generate the fixture");
    }
    status.success()
}

/// Decodes an image to raw RGB24 bytes.
///
/// Comparing the encoded files would compare PNG encoders; comparing decoded
/// pixels compares the pictures, which is the actual claim.
fn decode_image_rgb24(path: &std::path::Path) -> Option<Vec<u8>> {
    let ffmpeg_path = available_ffmpeg_path()?;
    let output = Command::new(ffmpeg_path)
        .args(["-v", "error", "-i"])
        .arg(path)
        .args(["-f", "rawvideo", "-pix_fmt", "rgb24", "-"])
        .output()
        .ok()?;
    if !output.status.success() || output.stdout.is_empty() {
        return None;
    }
    Some(output.stdout)
}

/// What the render engine needs to draw a sequence, read without a session.
struct RenderInputs {
    project_dir: PathBuf,
    state: openreelio_core::project::ProjectState,
    sequence_id: String,
    sequence: openreelio_core::timeline::Sequence,
    graph: openreelio_core::render::RenderGraph,
    ffmpeg: openreelio_core::ffmpeg::FFmpegInfo,
}

/// Reads a project's active sequence and builds its render graph.
///
/// Read-only and session-free, so it can run between CLI invocations without
/// contending for the ops-log lock.
fn render_inputs(project_path: &str) -> Option<RenderInputs> {
    let ffmpeg = available_ffmpeg_info()?;
    let project_dir = std::fs::canonicalize(project_path).ok()?;
    let state = openreelio_core::ActiveProject::read_state_without_session(&project_dir).ok()?;
    let sequence_id = state.active_sequence_id.clone()?;
    let sequence = state.sequences.get(&sequence_id)?.clone();
    let graph = openreelio_core::render::build_render_graph(&state, &sequence_id).ok()?;

    Some(RenderInputs {
        project_dir,
        state,
        sequence_id,
        sequence,
        graph,
        ffmpeg,
    })
}

/// Renders `[start_sec, end_sec)` of the sequence with the preview-cache
/// profile — lossless Ut Video at the sequence canvas — and returns its size.
///
/// This is the profile the composite frame probe and the render cache both use,
/// so a file produced here is the reference the probe's stills are measured
/// against.
fn render_preview_cache_window(
    inputs: &RenderInputs,
    output: &std::path::Path,
    start_sec: Option<f64>,
    end_sec: Option<f64>,
) -> Option<u64> {
    use openreelio_core::ffmpeg::FFmpegRunner;
    use openreelio_core::render::{build_render_plan, ExportEngine, ExportSettings};

    let settings = ExportSettings::preview_cache(
        output.to_path_buf(),
        &inputs.sequence.format.canvas,
        start_sec,
        end_sec,
    );
    let plan = build_render_plan(
        &inputs.graph,
        &inputs.state.assets,
        &inputs.state.effects,
        &settings,
    );
    assert!(
        plan.validation.is_valid,
        "The preview-cache profile must plan cleanly: {:?}",
        plan.validation.errors
    );

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .ok()?;
    let engine = ExportEngine::new(FFmpegRunner::new(inputs.ffmpeg.clone()));
    let result = runtime
        .block_on(engine.export_sequence_with_effects_for_plan(
            &inputs.sequence,
            &inputs.state.assets,
            &inputs.state.effects,
            &settings,
            &plan,
            None,
            None,
        ))
        .ok()?;

    Some(result.file_size)
}

/// Fills the project's preview render cache with the segment covering `time_sec`.
///
/// Mirrors the GUI's cache fill rather than calling it: there is no CLI verb for
/// filling the cache, and the probe's cache tier has to be tested against a
/// manifest written exactly the way the app writes one. The order is
/// load-bearing — fingerprints are refreshed *before* the render, because
/// `refresh_manifest_plan_fingerprints` demotes an already-`Cached` segment to
/// `Stale` the first time it computes a fingerprint for it.
fn fill_preview_cache_segment(project_path: &str, time_sec: f64) -> Option<u32> {
    use openreelio_core::render::{
        preview_profile_hash, refresh_manifest_plan_fingerprints, save_manifest,
        segment_cache_file, RenderCacheConfig, RenderCacheManifest,
    };

    let inputs = render_inputs(project_path)?;
    let profile_hash = preview_profile_hash(&inputs.sequence.format.canvas);
    let mut manifest = RenderCacheManifest::new(
        &inputs.sequence_id,
        &profile_hash,
        inputs.sequence.duration(),
        RenderCacheConfig::default().segment_duration_sec,
    );
    refresh_manifest_plan_fingerprints(
        &mut manifest,
        &inputs.project_dir,
        &inputs.sequence,
        &inputs.graph,
        &inputs.state.assets,
        &inputs.state.effects,
    )
    .expect("The cache manifest must fingerprint against the current plan");

    let segment = manifest
        .segments
        .iter()
        .find(|segment| time_sec >= segment.start_sec && time_sec < segment.end_sec)?
        .clone();

    let output = segment_cache_file(
        &inputs.project_dir,
        &inputs.sequence_id,
        &profile_hash,
        segment.index,
    )
    .ok()?;
    std::fs::create_dir_all(output.parent()?).ok()?;

    let file_size = render_preview_cache_window(
        &inputs,
        &output,
        Some(segment.start_sec),
        Some(segment.end_sec),
    )?;

    let cached_name = output.file_name()?.to_string_lossy().to_string();
    manifest.mark_segment_cached(segment.index, cached_name, file_size);
    save_manifest(&inputs.project_dir, &manifest).ok()?;

    Some(segment.index)
}

/// Builds a one-second project holding a single colour-bar clip.
///
/// Kept short on purpose: the composite path renders losslessly at the canvas,
/// so every extra second of fixture is tens of megabytes of temporary file.
fn create_colour_bar_project(name: &str) -> Option<(tempfile::TempDir, String, String)> {
    available_ffmpeg_path()?;

    let dir = create_temp_project(name);
    let path = project_path(&dir, name);

    let source_path = dir.path().join("bars.mp4");
    if !create_colour_bar_video(&source_path, "1920x1080", 2) {
        return None;
    }

    let ids = place_trimmed_clip(&path, &source_path, 1.0);

    Some((dir, path, ids))
}

/// Feature: the frame probe shows the composited edit
/// Scenario: a text clip is in the default still and missing from a fast one
///
/// This is the whole point of the default flip. `fast` reads the topmost
/// file-backed clip's own media, so a title burned over that clip is simply not
/// in the picture — an agent judging its own caption edit would see nothing.
#[test]
fn test_frame_extract_default_mode_renders_text_that_fast_mode_omits() {
    if available_ffmpeg_path().is_none() {
        return;
    }

    let dir = create_temp_project("frame_default_text");
    let path = project_path(&dir, "frame_default_text");

    let source_path = dir.path().join("text_bed.mp4");
    if !create_solid_colour_video(&source_path, "black", "1920x1080", 2) {
        return;
    }
    place_trimmed_clip(&path, &source_path, 1.0);

    run_cli_ok(&[
        "text",
        "add",
        "--path",
        &path,
        "--text",
        "THE END",
        "--start",
        "0",
        "--duration",
        "1",
        "--preset",
        "title",
    ]);

    let composited_path = dir.path().join("composited.png");
    let composited = run_cli_ok(&[
        "frame",
        "extract",
        "--path",
        &path,
        "--time",
        "0.5",
        "--out",
        composited_path.to_str().unwrap(),
    ]);
    assert_eq!(
        composited["mode"], "composite",
        "the default must be the composited edit: {composited}"
    );
    assert_eq!(
        composited["frames"][0]["source"], "composite",
        "with no render cache the default has to render the window: {composited}"
    );

    let fast_path = dir.path().join("fast.png");
    let fast = run_cli_ok(&[
        "frame",
        "extract",
        "--path",
        &path,
        "--time",
        "0.5",
        "--mode",
        "fast",
        "--out",
        fast_path.to_str().unwrap(),
    ]);
    assert_eq!(
        fast["frames"][0]["source"], "source",
        "fast mode reads the clip's own media: {fast}"
    );
    assert!(
        fast["warnings"]
            .as_array()
            .map(|warnings| warnings.iter().any(|warning| {
                warning
                    .as_str()
                    .unwrap_or_default()
                    .contains("fast mode shows the source clip only")
            }))
            .unwrap_or(false),
        "fast mode must say what it is not showing: {fast}"
    );

    let composited_pixels =
        decode_image_rgb24(&composited_path).expect("the composited still must decode");
    let fast_pixels = decode_image_rgb24(&fast_path).expect("the fast still must decode");
    assert_ne!(
        composited_pixels, fast_pixels,
        "the default still must carry the title the fast still drops"
    );
}

/// Feature: the frame probe is lossless
/// Scenario: a composited still equals the same frame of a full lossless render
///
/// The composite path renders a window with `ExportSettings::preview_cache`, the
/// profile the render cache stores, so its still has to be the same picture the
/// whole-sequence render holds at that instant — not a re-encode of it. Colour
/// bars are the fixture because their hard chroma edges are where the old H.264
/// CRF 28 draft profile diverged worst.
///
/// The fixture deliberately carries no temporal filter: a filter that consumes
/// several source frames per output frame would see different context in a
/// windowed render than in a full one, which is a documented limit of the
/// windowed-render contract rather than a property of this path.
#[test]
fn test_frame_extract_composite_matches_a_full_lossless_render() {
    let Some((dir, path, _ids)) = create_colour_bar_project("frame_lossless_identity") else {
        return;
    };
    // Past the fixture guard FFmpeg is known to be present, so anything below
    // failing is a real failure rather than an unrunnable machine.
    let inputs = render_inputs(&path).expect("the fixture project must be readable");

    let reference = dir.path().join("reference.mov");
    render_preview_cache_window(&inputs, &reference, None, None)
        .expect("the lossless reference render must succeed");

    let from_file_path = dir.path().join("from_file.png");
    let from_file = run_cli_ok(&[
        "frame",
        "extract",
        "--path",
        &path,
        "--file",
        reference.to_str().unwrap(),
        "--time",
        "0.5",
        "--out",
        from_file_path.to_str().unwrap(),
    ]);
    assert_eq!(from_file["mode"], "file");

    let from_timeline_path = dir.path().join("from_timeline.png");
    let from_timeline = run_cli_ok(&[
        "frame",
        "extract",
        "--path",
        &path,
        "--time",
        "0.5",
        "--out",
        from_timeline_path.to_str().unwrap(),
    ]);
    assert_eq!(
        from_timeline["frames"][0]["source"], "composite",
        "no cache exists yet, so the window must be rendered: {from_timeline}"
    );

    let reference_pixels =
        decode_image_rgb24(&from_file_path).expect("the reference still must decode");
    let composited_pixels =
        decode_image_rgb24(&from_timeline_path).expect("the composited still must decode");
    assert_eq!(
        reference_pixels.len(),
        composited_pixels.len(),
        "both stills must describe the same frame size"
    );
    assert_eq!(
        reference_pixels, composited_pixels,
        "a composited still must be the render's own pixels, not a re-encode of them"
    );
}

/// Feature: the frame probe reads the render cache first
/// Scenario: a cached segment serves the still, with the composite's pixels
///
/// A cached segment is written by the export pipeline in a lossless intra codec,
/// so serving a frame out of one costs a seek and gives back exactly what a
/// fresh composite render would have produced.
#[test]
fn test_frame_extract_serves_a_composited_still_from_the_render_cache() {
    let Some((dir, path, _ids)) = create_colour_bar_project("frame_cache_hit") else {
        return;
    };

    // Before the cache exists there is nothing to serve, so this still is the
    // reference the cached one is compared against.
    let rendered_path = dir.path().join("rendered.png");
    let rendered = run_cli_ok(&[
        "frame",
        "extract",
        "--path",
        &path,
        "--time",
        "0.5",
        "--out",
        rendered_path.to_str().unwrap(),
    ]);
    assert_eq!(
        rendered["frames"][0]["source"], "composite",
        "an empty cache is a miss, not an error: {rendered}"
    );

    fill_preview_cache_segment(&path, 0.5).expect("the cache segment must render");

    // A file already at the output path is what makes a silent cache miss
    // dangerous: FFmpeg writes nothing when a seek lands past the last decodable
    // frame, so whatever was there before would be probed and reported as this
    // still. The probe must replace it, never inherit it.
    let cached_path = dir.path().join("cached.png");
    let bogus = b"not an image at all".to_vec();
    std::fs::write(&cached_path, &bogus).expect("the bogus output must be written");

    let cached = run_cli_ok(&[
        "frame",
        "extract",
        "--path",
        &path,
        "--time",
        "0.5",
        "--out",
        cached_path.to_str().unwrap(),
    ]);
    assert_eq!(
        cached["frames"][0]["source"], "cache",
        "a current cached segment must serve the still: {cached}"
    );
    assert_ne!(
        std::fs::read(&cached_path).expect("the cached still must be readable"),
        bogus,
        "a cache hit must be the frame this run extracted, not the file it found"
    );

    let rendered_pixels =
        decode_image_rgb24(&rendered_path).expect("the rendered still must decode");
    let cached_pixels = decode_image_rgb24(&cached_path).expect("the cached still must decode");
    assert_eq!(
        rendered_pixels, cached_pixels,
        "the cache must hand back the composite's pixels, not an approximation"
    );
}

/// Feature: the frame probe answers anywhere inside the sequence
/// Scenario: a time in the sequence's last frame is composited, not refused
///
/// The renderer addresses its output range by frame, so a window that starts at
/// the requested instant and ends a moment later has both bounds on the same
/// frame once the request is inside the final frame — `[4.99, 5.0]` at 25fps is
/// frame 125 twice over. That used to come back as an empty render plan, which
/// is a refusal for a time the probe had already accepted as in range.
#[test]
fn test_frame_extract_composites_a_time_inside_the_last_frame_of_the_sequence() {
    if available_ffmpeg_path().is_none() {
        return;
    }

    let dir = create_temp_project("frame_last_frame");
    let path = project_path(&dir, "frame_last_frame");

    let source_path = dir.path().join("tail.mp4");
    if !create_solid_colour_video(&source_path, "blue", "1920x1080", 6) {
        return;
    }
    // A 5s sequence at 25fps: the last frame is 124, which starts at 4.96s.
    place_trimmed_clip(&path, &source_path, 5.0);

    let still_path = dir.path().join("last_frame.png");
    let still = run_cli_ok(&[
        "frame",
        "extract",
        "--path",
        &path,
        "--time",
        "4.99",
        "--out",
        still_path.to_str().unwrap(),
    ]);

    assert_eq!(
        still["frames"][0]["source"], "composite",
        "a time inside the last frame must still be composited: {still}"
    );
    assert!(
        decode_image_rgb24(&still_path).is_some(),
        "the still must be a decodable picture: {still}"
    );
}

/// Feature: the frame probe reads the render cache first
/// Scenario: an edit retires the cached segment and the still is re-rendered
///
/// Serving pre-edit pixels under a post-edit request is the one failure a cache
/// tier must never have: the agent would grade the edit it just replaced.
#[test]
fn test_frame_extract_ignores_a_cached_segment_the_edit_moved_past() {
    let Some((dir, path, ids)) = create_colour_bar_project("frame_cache_stale") else {
        return;
    };
    let (track_id, clip_id) = ids.split_once('|').unwrap();

    fill_preview_cache_segment(&path, 0.5).expect("the cache segment must render");

    let cached_path = dir.path().join("cached.png");
    let cached = run_cli_ok(&[
        "frame",
        "extract",
        "--path",
        &path,
        "--time",
        "0.5",
        "--out",
        cached_path.to_str().unwrap(),
    ]);
    assert_eq!(
        cached["frames"][0]["source"], "cache",
        "the fixture must start from a cache hit: {cached}"
    );

    run_cli_ok(&[
        "timeline", "move", "--path", &path, "--track", track_id, "--clip", clip_id, "--to", "0.2",
    ]);

    let stale_path = dir.path().join("after_move.png");
    let after_move = run_cli_ok(&[
        "frame",
        "extract",
        "--path",
        &path,
        "--time",
        "0.5",
        "--out",
        stale_path.to_str().unwrap(),
    ]);
    assert_eq!(
        after_move["frames"][0]["source"], "composite",
        "a segment whose plan moved must be re-rendered, not served: {after_move}"
    );
}

// =============================================================================
// Where-to-look signals (timeline info + affected ranges)
// =============================================================================

/// Reads an `affectedRanges` array as `(startSec, endSec)` pairs.
fn affected_pairs(value: &serde_json::Value) -> Vec<(f64, f64)> {
    value
        .as_array()
        .unwrap_or_else(|| panic!("expected an affectedRanges array, got: {value}"))
        .iter()
        .map(|range| {
            (
                range["startSec"].as_f64().expect("startSec"),
                range["endSec"].as_f64().expect("endSec"),
            )
        })
        .collect()
}

/// Reads the last-apply hand-off record a mutating verb writes.
fn last_affected_record(path: &str) -> serde_json::Value {
    let record_path = std::path::Path::new(path)
        .join(".openreelio")
        .join("cache")
        .join("agent")
        .join("last_affected_ranges.json");
    let contents = std::fs::read_to_string(&record_path)
        .unwrap_or_else(|error| panic!("{}: {error}", record_path.display()));
    serde_json::from_str(&contents).unwrap()
}

/// Adds a caption track and returns its id.
fn add_caption_track(path: &str) -> String {
    let track = run_cli_ok(&[
        "timeline",
        "add-track",
        "--path",
        path,
        "--kind",
        "caption",
        "--name",
        "Captions",
    ]);
    track["createdIds"][0].as_str().unwrap().to_string()
}

/// Feature: where-to-look signals on timeline reads
/// Scenario: an agent asks the timeline where the interesting times are
///
/// Every signal here used to have to be reconstructed by hand from
/// `timeline clips`: the length, the frame rate the times are quantised to,
/// the cut times, the marker times and the caption spans. Reconstructing them
/// is exactly the step that goes wrong, so they are asserted as one contract.
#[test]
fn test_timeline_info_reports_duration_fps_markers_and_spans() {
    let (_dir, path, _asset_id, _track_id) =
        create_project_with_placed_dummy("timeline_info_signals");
    let sequence_id = active_sequence(&path);
    let caption_track_id = add_caption_track(&path);

    run_cli_ok(&[
        "command",
        "execute",
        "--path",
        &path,
        "--type",
        "CreateCaption",
        "--payload",
        &serde_json::json!({
            "sequenceId": sequence_id,
            "trackId": caption_track_id,
            "text": "Watch this",
            "startSec": 1.0,
            "endSec": 3.0,
        })
        .to_string(),
    ]);

    let marker = run_cli_ok(&[
        "command",
        "execute",
        "--path",
        &path,
        "--type",
        "AddMarker",
        "--payload",
        &serde_json::json!({
            "sequenceId": sequence_id,
            "time": 1.5,
            "label": "Hook",
        })
        .to_string(),
    ]);
    // A marker moves no picture, so it is reported as the instant it names.
    assert_eq!(affected_pairs(&marker["affectedRanges"]), vec![(1.5, 1.5)]);

    let info = run_cli_ok(&["timeline", "info", "--path", &path]);

    // The dummy asset carries no probed duration, so the clip takes the
    // timeline's default length; what matters is that both durations agree
    // with the clip that is actually there.
    let duration = info["durationSec"].as_f64().expect("durationSec");
    assert!(duration > 3.0, "{info}");
    assert_eq!(info["outputDurationSec"].as_f64(), Some(duration));

    assert_eq!(info["fps"].as_f64(), Some(30.0));
    assert_eq!(info["fpsRatio"]["num"], 30);
    assert_eq!(info["fpsRatio"]["den"], 1);
    assert_eq!(info["canvas"]["width"], 1920);
    assert_eq!(info["canvas"]["height"], 1080);

    let edit_points: Vec<f64> = info["editPoints"]
        .as_array()
        .expect("editPoints")
        .iter()
        .map(|point| point.as_f64().expect("edit point"))
        .collect();
    assert_eq!(edit_points.first(), Some(&0.0));
    assert!(edit_points.contains(&1.0), "{edit_points:?}");
    assert!(edit_points.contains(&3.0), "{edit_points:?}");
    assert!(edit_points.contains(&duration), "{edit_points:?}");

    assert_eq!(info["markers"][0]["timeSec"].as_f64(), Some(1.5));
    assert_eq!(info["markers"][0]["label"], "Hook");

    assert_eq!(info["captionSpans"][0]["startSec"].as_f64(), Some(1.0));
    assert_eq!(info["captionSpans"][0]["endSec"].as_f64(), Some(3.0));
    assert_eq!(info["captionSpans"][0]["text"], "Watch this");
    assert_eq!(
        info["captionSpans"][0]["trackId"],
        caption_track_id.as_str()
    );

    assert_eq!(info["transitions"].as_array().map(Vec::len), Some(0));
    assert_eq!(info["inspectionHints"]["markerCount"], 1);
    assert_eq!(info["inspectionHints"]["captionCount"], 1);
    assert_eq!(info["inspectionHints"]["transitionCount"], 0);
    assert_eq!(info["inspectionHints"]["refusedTransitionCount"], 0);
    // 1.0 and 3.0 are the caption's boundaries and 0 and the tail are the
    // timeline's own, so nowhere does the picture cut: one clip runs the whole
    // sequence. `editPoints` still lists all four.
    assert_eq!(info["cuts"].as_array().map(Vec::len), Some(0));
    assert_eq!(info["inspectionHints"]["cutCount"], 0);

    // Additive: the keys `timeline info` already published are untouched.
    assert_eq!(info["sequenceId"], sequence_id.as_str());
    assert!(info["trackCount"].as_u64().unwrap() >= 2);
}

/// Feature: where-to-look signals on timeline reads
/// Scenario: a dissolve reports the stretch it blends across
///
/// A transition hangs on the outgoing clip and blends *around* the cut, so its
/// span is neither clip's boundary — the one signal a caller genuinely cannot
/// derive from a clip list.
#[test]
fn test_timeline_info_reports_a_transition_span_centred_on_the_cut() {
    if available_ffmpeg_path().is_none() {
        return;
    }

    let dir = create_temp_project("timeline_info_transition");
    let path = project_path(&dir, "timeline_info_transition");

    let dark = dir.path().join("dark.mp4");
    let light = dir.path().join("light.mp4");
    if !create_solid_tone_source(&dark, "black", 440, 8) {
        return;
    }
    if !create_solid_tone_source(&light, "white", 880, 8) {
        return;
    }

    let (sequence_id, track_id, outgoing_clip) =
        place_two_shot_timeline(&path, [&dark, &light], 2.0);
    add_dissolve(&path, &sequence_id, &track_id, &outgoing_clip);

    let info = run_cli_ok(&["timeline", "info", "--path", &path]);
    let transitions = info["transitions"].as_array().expect("transitions");
    assert_eq!(transitions.len(), 1, "{info}");

    let span = &transitions[0];
    let cut_sec = TRANSITION_SHOT_SEC;
    let half = TRANSITION_DISSOLVE_SEC / 2.0;
    assert_eq!(span["clipId"], outgoing_clip.as_str());
    assert_eq!(span["trackId"], track_id.as_str());
    assert_eq!(span["effectType"], "cross_dissolve");
    assert_eq!(span["cutSec"].as_f64(), Some(cut_sec));
    assert_eq!(span["startSec"].as_f64(), Some(cut_sec - half));
    assert_eq!(span["endSec"].as_f64(), Some(cut_sec + half));
    assert_eq!(span["durationSec"].as_f64(), Some(TRANSITION_DISSOLVE_SEC));
    assert_eq!(info["inspectionHints"]["transitionCount"], 1);
}

/// Feature: affected ranges on mutating verbs
/// Scenario: a move reports where the clip was and where it now is
///
/// Both halves matter: the old span is where the picture changed by losing the
/// clip, the new span is where it changed by gaining it.
#[test]
fn test_command_execute_reports_the_union_of_the_old_and_new_span() {
    let (_dir, path, _asset_id, track_id) = create_project_with_placed_dummy("affected_move");
    let sequence_id = active_sequence(&path);

    let clips = run_cli_ok(&["timeline", "clips", "--path", &path]);
    let clip = &clips["clips"][0];
    let clip_id = clip["id"].as_str().unwrap().to_string();
    let original_start = clip["timelineInSec"].as_f64().expect("timelineInSec");
    let original_end = original_start + clip["durationSec"].as_f64().expect("durationSec");

    let moved_start = original_end + 10.0;
    let result = run_cli_ok(&[
        "command",
        "execute",
        "--path",
        &path,
        "--type",
        "MoveClip",
        "--payload",
        &serde_json::json!({
            "sequenceId": sequence_id,
            "trackId": track_id,
            "clipId": clip_id,
            "newTimelineIn": moved_start,
        })
        .to_string(),
    ]);

    assert_eq!(result["status"], "ok");
    assert_eq!(result["sequenceId"], sequence_id.as_str());
    assert_eq!(
        affected_pairs(&result["affectedRanges"]),
        vec![
            (original_start, original_end),
            (moved_start, moved_start + (original_end - original_start))
        ]
    );

    // The raw change list rides along, so a caller can see what moved as well
    // as where.
    let change_types: Vec<String> = result["changes"]
        .as_array()
        .expect("changes")
        .iter()
        .map(|change| change["type"].as_str().unwrap_or_default().to_string())
        .collect();
    assert!(
        change_types.iter().any(|kind| kind == "clipModified"),
        "{change_types:?}"
    );
    // camelCase throughout, like every other key the CLI prints.
    assert_eq!(result["changes"][0]["clipId"], clip_id.as_str());

    // The hand-off file part B's sampler reads.
    let record = last_affected_record(&path);
    assert_eq!(record["sequenceId"], sequence_id.as_str());
    assert_eq!(record["opIds"][0], result["opId"]);
    assert_eq!(
        affected_pairs(&record["affectedRanges"]),
        affected_pairs(&result["affectedRanges"])
    );
}

/// Feature: affected ranges on mutating verbs
/// Scenario: a plan reports each step's ranges and their union
#[test]
fn test_plan_execute_reports_step_and_total_affected_ranges() {
    let dir = create_temp_project("plan_affected_ranges");
    let path = project_path(&dir, "plan_affected_ranges");
    let sequence_id = active_sequence(&path);
    let caption_track_id = add_caption_track(&path);

    let plan_file = write_plan(
        &dir,
        "affected.json",
        serde_json::json!({
            "id": "affected_plan",
            "steps": [
                {
                    "id": "caption",
                    "commandType": "CreateCaption",
                    "payload": {
                        "sequenceId": sequence_id,
                        "trackId": caption_track_id,
                        "text": "Look here",
                        "startSec": 1.0,
                        "endSec": 3.0
                    },
                    "dependsOn": []
                },
                {
                    "id": "marker",
                    "commandType": "AddMarker",
                    "payload": {
                        "sequenceId": sequence_id,
                        "time": 5.0,
                        "label": "Beat"
                    },
                    "dependsOn": ["caption"]
                }
            ]
        }),
    );

    let (stdout, stderr, code) =
        run_cli_exit(&["plan", "execute", "--path", &path, "--file", &plan_file]);
    assert_eq!(code, 0, "stdout: {stdout}\nstderr: {stderr}");
    let result: serde_json::Value = serde_json::from_str(&stdout).unwrap();

    assert_eq!(result["status"], "ok");
    assert_eq!(result["sequenceId"], sequence_id.as_str());
    assert_eq!(
        affected_pairs(&result["stepResults"][0]["affectedRanges"]),
        vec![(1.0, 3.0)]
    );
    assert_eq!(
        affected_pairs(&result["stepResults"][1]["affectedRanges"]),
        vec![(5.0, 5.0)]
    );
    assert_eq!(
        affected_pairs(&result["affectedRanges"]),
        vec![(1.0, 3.0), (5.0, 5.0)]
    );

    let record = last_affected_record(&path);
    assert_eq!(record["sequenceId"], sequence_id.as_str());
    assert_eq!(record["opIds"].as_array().map(Vec::len), Some(2));
    assert_eq!(
        affected_pairs(&record["affectedRanges"]),
        vec![(1.0, 3.0), (5.0, 5.0)]
    );
    assert!(record["recordedAt"]
        .as_str()
        .is_some_and(|at| !at.is_empty()));
}

/// Feature: affected ranges on mutating verbs
/// Scenario: a rolled-back plan points nowhere
///
/// A step that applied and was then undone changed nothing in the end, so
/// reporting the range it briefly touched would send an inspector to a frame
/// that never differed.
#[test]
fn test_failed_plan_reports_no_affected_ranges() {
    let dir = create_temp_project("plan_affected_rollback");
    let path = project_path(&dir, "plan_affected_rollback");
    let sequence_id = active_sequence(&path);
    let caption_track_id = add_caption_track(&path);

    let plan_file = write_plan(
        &dir,
        "rollback_affected.json",
        serde_json::json!({
            "id": "rollback_affected_plan",
            "steps": [
                {
                    "id": "caption",
                    "commandType": "CreateCaption",
                    "payload": {
                        "sequenceId": sequence_id,
                        "trackId": caption_track_id,
                        "text": "Gone again",
                        "startSec": 1.0,
                        "endSec": 3.0
                    },
                    "dependsOn": []
                },
                {
                    "id": "doomed",
                    "commandType": "SplitClip",
                    "payload": {
                        "sequenceId": sequence_id,
                        "trackId": "no-such-track",
                        "clipId": "no-such-clip",
                        "splitTime": 1.0
                    },
                    "dependsOn": ["caption"]
                }
            ]
        }),
    );

    let (stdout, stderr, code) =
        run_cli_exit(&["plan", "execute", "--path", &path, "--file", &plan_file]);
    assert_eq!(code, 1, "stdout: {stdout}\nstderr: {stderr}");
    let result: serde_json::Value = serde_json::from_str(&stdout).unwrap();

    assert_eq!(result["status"], "error");
    assert_eq!(result["failedStep"], "doomed");
    assert_eq!(result["rolledBack"], 1);
    assert!(
        affected_pairs(&result["affectedRanges"]).is_empty(),
        "{result}"
    );
    for step in result["stepResults"].as_array().expect("stepResults") {
        assert!(
            affected_pairs(&step["affectedRanges"]).is_empty(),
            "a rolled-back step must point nowhere: {step}"
        );
    }
}

// =============================================================================
// Where-to-look samplers (frame extract)
// =============================================================================

/// Frame rate every CLI-created sequence uses.
const SAMPLER_FPS: f64 = 30.0;

/// Seconds a cut sample is backed off by to land on the outgoing shot.
///
/// Seeks resolve forward, so the frame *before* a cut is only reachable from a
/// time a frame and a half earlier.
const CUT_LEAD_SEC: f64 = 1.5 / SAMPLER_FPS;

/// Builds a two-shot timeline backed by real media, cut at `TRANSITION_SHOT_SEC`.
///
/// Real media rather than a placeholder: every sampler test here extracts a
/// composited still, which needs something FFmpeg can decode. `None` on a
/// machine without FFmpeg, so the tests skip instead of failing there.
///
/// Returns `(dir, project_path, sequence_id, track_id, outgoing_clip_id)`.
fn create_two_shot_project(
    name: &str,
) -> Option<(tempfile::TempDir, String, String, String, String)> {
    available_ffmpeg_path()?;

    let dir = create_temp_project(name);
    let path = project_path(&dir, name);
    let dark = dir.path().join("dark.mp4");
    let light = dir.path().join("light.mp4");
    if !create_solid_tone_source(&dark, "black", 440, 8) {
        return None;
    }
    if !create_solid_tone_source(&light, "white", 880, 8) {
        return None;
    }

    let (sequence_id, track_id, outgoing_clip) =
        place_two_shot_timeline(&path, [&dark, &light], 2.0);

    Some((dir, path, sequence_id, track_id, outgoing_clip))
}

/// The reasons a sampler payload reported for its contact-sheet cells.
fn cell_reasons(sheet: &serde_json::Value) -> Vec<String> {
    sheet["cells"]
        .as_array()
        .unwrap_or_else(|| panic!("expected sheet cells, got: {sheet}"))
        .iter()
        .map(|cell| cell["reason"].as_str().unwrap_or_default().to_string())
        .collect()
}

/// Feature: where-to-look samplers
/// Scenario: one call sheets both sides of every cut
///
/// The arithmetic this replaces was the agent's own: read `timeline info`,
/// subtract 1.5/fps from each cut, assemble a `--times` list, choose a layout.
/// Getting the offset wrong puts both cells on the incoming shot, which looks
/// like a perfectly continuous edit no matter what the cut actually does.
#[test]
fn test_frame_extract_sheets_both_sides_of_every_cut() {
    let Some((dir, path, _sequence_id, _track_id, _clip_id)) =
        create_two_shot_project("frame_at_cuts")
    else {
        return;
    };

    let sheet_path = dir.path().join("cuts.jpg");
    let result = run_cli_ok(&[
        "frame",
        "extract",
        "--path",
        &path,
        "--at-cuts",
        "--grid",
        "auto",
        "--out",
        sheet_path.to_str().unwrap(),
    ]);

    assert_eq!(result["status"], "ok");
    assert_eq!(result["mode"], "grid");
    // Two samples, so `auto` lays them out side by side.
    assert_eq!(result["sheet"]["cols"], 2);
    assert_eq!(result["sheet"]["rows"], 1);

    let cells = result["sheet"]["cells"].as_array().expect("cells");
    assert_eq!(cells.len(), 2, "{result}");
    assert_eq!(
        cell_reasons(&result["sheet"]),
        vec!["cutBefore", "cutAfter"]
    );

    let before = cells[0]["timelineSec"].as_f64().expect("cell time");
    assert!(
        (before - (TRANSITION_SHOT_SEC - CUT_LEAD_SEC)).abs() < 1e-6,
        "the outgoing frame must sit 1.5 frames before the cut, got {before}"
    );
    assert_eq!(
        cells[1]["timelineSec"].as_f64(),
        Some(TRANSITION_SHOT_SEC),
        "the incoming frame is the cut itself"
    );

    assert_eq!(result["sampler"]["kinds"][0], "atCuts");
    assert_eq!(result["sampler"]["candidates"], 2);
    assert_eq!(result["sampler"]["selected"], 2);
    assert_eq!(result["sampler"]["limited"], false);
    assert!(result["sampler"]["affectedRanges"].is_null());

    assert!(sheet_path.exists(), "Expected the sheet at the .jpg path");
}

/// Feature: where-to-look samplers
/// Scenario: a blend is sampled across the stretch it actually covers
///
/// A transition hangs on the outgoing clip and blends *around* the cut, so
/// neither end of the blend is a clip boundary. Sampling it by hand means
/// re-deriving the span from the effect's duration.
#[test]
fn test_frame_extract_samples_a_transition_across_its_blend() {
    let Some((dir, path, sequence_id, track_id, outgoing_clip)) =
        create_two_shot_project("frame_at_transitions")
    else {
        return;
    };
    add_dissolve(&path, &sequence_id, &track_id, &outgoing_clip);

    let out_dir = dir.path().join("transition_stills");
    let result = run_cli_ok(&[
        "frame",
        "extract",
        "--path",
        &path,
        "--at-transitions",
        "--out",
        out_dir.to_str().unwrap(),
    ]);

    assert_eq!(result["status"], "ok");
    assert_eq!(result["count"], 3, "{result}");

    let frames = result["frames"].as_array().expect("frames");
    let reasons: Vec<&str> = frames
        .iter()
        .map(|frame| frame["reason"].as_str().unwrap_or_default())
        .collect();
    assert_eq!(
        reasons,
        vec!["transitionStart", "transitionCut", "transitionEnd"]
    );

    let half = TRANSITION_DISSOLVE_SEC / 2.0;
    let times: Vec<f64> = frames
        .iter()
        .map(|frame| frame["timeSec"].as_f64().expect("timeSec"))
        .collect();
    assert_eq!(
        times,
        vec![
            TRANSITION_SHOT_SEC - half,
            TRANSITION_SHOT_SEC,
            TRANSITION_SHOT_SEC + half
        ]
    );

    for frame in frames {
        let written = std::path::PathBuf::from(frame["path"].as_str().expect("frame path"));
        assert!(written.exists(), "{} was not written", written.display());
    }
}

/// Feature: where-to-look samplers
/// Scenario: a coverage sweep is thinned to the caller's budget
#[test]
fn test_frame_extract_thins_a_per_shot_sweep_to_the_requested_budget() {
    let Some((dir, path, _sequence_id, _track_id, _clip_id)) =
        create_two_shot_project("frame_per_shot")
    else {
        return;
    };

    let out_dir = dir.path().join("shots");
    let result = run_cli_ok(&[
        "frame",
        "extract",
        "--path",
        &path,
        "--per-shot",
        "--limit",
        "1",
        "--out",
        out_dir.to_str().unwrap(),
    ]);

    assert_eq!(result["status"], "ok");
    assert_eq!(result["count"], 1, "{result}");
    assert_eq!(result["frames"][0]["reason"], "shotMid");
    // Both shots were found; the budget is what cut the list down, and the
    // payload has to say so rather than looking like a one-shot timeline.
    assert_eq!(result["sampler"]["candidates"], 2);
    assert_eq!(result["sampler"]["selected"], 1);
    assert_eq!(result["sampler"]["limited"], true);
}

/// Feature: where-to-look samplers
/// Scenario: the post-apply look, without the agent carrying any times
///
/// This is the loop the whole feature exists for: apply an edit, then ask to
/// see exactly the seconds that moved. The ranges come from the hand-off the
/// mutating verb wrote, and are echoed back so the picture can be checked
/// against them.
#[test]
fn test_frame_extract_sheets_the_ranges_the_last_edit_changed() {
    let Some((dir, path, sequence_id, track_id, _outgoing)) =
        create_two_shot_project("frame_affected")
    else {
        return;
    };

    let clips = run_cli_ok(&["timeline", "clips", "--path", &path]);
    let incoming = clips["clips"]
        .as_array()
        .expect("clips")
        .iter()
        .find(|clip| clip["timelineInSec"].as_f64() == Some(TRANSITION_SHOT_SEC))
        .expect("the second shot")
        .clone();
    let incoming_id = incoming["id"].as_str().expect("clip id").to_string();

    let moved = run_cli_ok(&[
        "command",
        "execute",
        "--path",
        &path,
        "--type",
        "MoveClip",
        "--payload",
        &serde_json::json!({
            "sequenceId": sequence_id,
            "trackId": track_id,
            "clipId": incoming_id,
            "newTimelineIn": TRANSITION_SHOT_SEC + 0.5,
        })
        .to_string(),
    ]);
    let expected_ranges = affected_pairs(&moved["affectedRanges"]);
    assert!(!expected_ranges.is_empty(), "{moved}");

    let sheet_path = dir.path().join("affected.jpg");
    let result = run_cli_ok(&[
        "frame",
        "extract",
        "--path",
        &path,
        "--affected",
        "--grid",
        "auto",
        "--out",
        sheet_path.to_str().unwrap(),
    ]);

    assert_eq!(result["status"], "ok");
    assert_eq!(result["mode"], "grid");
    assert_eq!(result["sampler"]["kinds"][0], "affected");
    assert_eq!(
        affected_pairs(&result["sampler"]["affectedRanges"]),
        expected_ranges,
        "the sheet has to name the ranges it was built from: {result}"
    );

    // Every cell lands inside the changed stretch — allowing the 1.5-frame
    // backoff, which is deliberately just outside a boundary it samples.
    let lowest = expected_ranges
        .iter()
        .map(|(start, _)| *start)
        .fold(f64::INFINITY, f64::min);
    let highest = expected_ranges
        .iter()
        .map(|(_, end)| *end)
        .fold(f64::NEG_INFINITY, f64::max);
    for cell in result["sheet"]["cells"].as_array().expect("cells") {
        let time = cell["timelineSec"].as_f64().expect("cell time");
        assert!(
            time >= lowest - CUT_LEAD_SEC && time <= highest,
            "cell at {time}s is outside the changed range {lowest}..{highest}: {result}"
        );
    }

    let reasons = cell_reasons(&result["sheet"]);
    assert!(
        reasons.iter().any(|reason| reason == "affectedStart"),
        "the range boundary has to be one of the cells: {reasons:?}"
    );
    assert!(
        reasons.iter().any(|reason| reason == "affectedMid"),
        "the middle of the change has to be one of the cells: {reasons:?}"
    );
    assert!(sheet_path.exists());
}

/// Feature: where-to-look samplers
/// Scenario: a second edit lands between the apply and the look
///
/// The hand-off is one slot every surface overwrites — the app's own edit path
/// included — so "the last edit" stops meaning "my edit" the moment anything
/// else applies one. This is that race, end to end: the first edit's ranges are
/// no longer what `--affected` would show. `--after-op` turns the assumption
/// into a refusal that names both operations, and `--range` skips the record
/// entirely by naming the seconds the edit itself reported.
#[test]
fn test_frame_extract_refuses_a_hand_off_that_is_not_the_callers_own_edit() {
    let Some((dir, path, sequence_id, track_id, _outgoing)) =
        create_two_shot_project("frame_affected_race")
    else {
        return;
    };

    let clips = run_cli_ok(&["timeline", "clips", "--path", &path]);
    let incoming_id = clips["clips"]
        .as_array()
        .expect("clips")
        .iter()
        .find(|clip| clip["timelineInSec"].as_f64() == Some(TRANSITION_SHOT_SEC))
        .expect("the second shot")["id"]
        .as_str()
        .expect("clip id")
        .to_string();

    let mine = run_cli_ok(&[
        "command",
        "execute",
        "--path",
        &path,
        "--type",
        "MoveClip",
        "--payload",
        &serde_json::json!({
            "sequenceId": sequence_id,
            "trackId": track_id,
            "clipId": incoming_id,
            "newTimelineIn": TRANSITION_SHOT_SEC + 0.5,
        })
        .to_string(),
    ]);
    let my_op = mine["opId"].as_str().expect("op id").to_string();
    let my_ranges = affected_pairs(&mine["affectedRanges"]);
    assert!(!my_ranges.is_empty(), "{mine}");

    // Somebody else's edit, which overwrites the slot.
    let theirs = run_cli_ok(&[
        "command",
        "execute",
        "--path",
        &path,
        "--type",
        "AddMarker",
        "--payload",
        &serde_json::json!({
            "sequenceId": sequence_id,
            "timeSec": 0.25,
            "label": "Somebody else was here",
        })
        .to_string(),
    ]);
    assert_ne!(theirs["opId"].as_str(), Some(my_op.as_str()));

    let sheet_path = dir.path().join("race.jpg");
    let (_stdout, stderr) = run_cli_err(&[
        "frame",
        "extract",
        "--path",
        &path,
        "--affected",
        "--after-op",
        &my_op,
        "--grid",
        "auto",
        "--out",
        sheet_path.to_str().unwrap(),
    ]);
    assert!(
        stderr.contains(&my_op) && stderr.contains(theirs["opId"].as_str().expect("op id")),
        "the refusal must name both the recorded and the expected operation, got: {stderr}"
    );
    assert!(
        !sheet_path.exists(),
        "a refused look must not leave a picture behind"
    );

    // The ranges the edit itself reported need no record at all.
    let mut args = vec![
        "frame".to_string(),
        "extract".to_string(),
        "--path".to_string(),
        path.clone(),
    ];
    for (start, end) in &my_ranges {
        args.push("--range".to_string());
        args.push(start.to_string());
        args.push(end.to_string());
    }
    args.extend([
        "--grid".to_string(),
        "auto".to_string(),
        "--out".to_string(),
        sheet_path.to_string_lossy().to_string(),
    ]);
    let borrowed: Vec<&str> = args.iter().map(String::as_str).collect();
    let result = run_cli_ok(&borrowed);

    assert_eq!(result["sampler"]["kinds"][0], "ranges");
    assert_eq!(
        affected_pairs(&result["sampler"]["affectedRanges"]),
        my_ranges,
        "the sheet has to name the ranges it was built from: {result}"
    );
    let reasons = cell_reasons(&result["sheet"]);
    assert!(
        reasons.iter().any(|reason| reason == "affectedMid"),
        "named ranges produce the same reasons the recorded ones do: {reasons:?}"
    );
    assert!(sheet_path.exists());
}

/// Feature: where-to-look samplers
/// Scenario: --affected on a project nothing has been applied to
///
/// The shortcut is only available after a mutating verb has recorded where it
/// landed, and "no record" is a different problem from "the edit changed
/// nothing" — so the message has to name the step that produces one.
#[test]
fn test_frame_extract_affected_names_the_missing_hand_off() {
    if available_ffmpeg_path().is_none() {
        return;
    }

    let dir = create_temp_project("frame_affected_missing");
    let path = project_path(&dir, "frame_affected_missing");

    let out_dir = dir.path().join("nothing");
    let (_stdout, stderr) = run_cli_err(&[
        "frame",
        "extract",
        "--path",
        &path,
        "--affected",
        "--out",
        out_dir.to_str().unwrap(),
    ]);

    assert!(
        stderr.contains("command execute")
            && stderr.contains("--range")
            && stderr.contains("--between"),
        "Expected the error to name the verb that records a hand-off and both fallbacks, got: {stderr}"
    );
}

/// Feature: where-to-look samplers
/// Scenario: words on screen are judged on the frame they are settled in
#[test]
fn test_frame_extract_samples_the_middle_of_a_title_card() {
    let Some((dir, path, _gap_time, _title_time)) =
        create_project_with_trailing_title_card("frame_at_captions")
    else {
        return;
    };

    let out_dir = dir.path().join("captions");
    let result = run_cli_ok(&[
        "frame",
        "extract",
        "--path",
        &path,
        "--at-captions",
        "--out",
        out_dir.to_str().unwrap(),
    ]);

    assert_eq!(result["status"], "ok");
    assert_eq!(result["count"], 1, "{result}");
    // The card runs 6-8s, so its settled frame is 7.0s.
    assert_eq!(result["frames"][0]["timeSec"].as_f64(), Some(7.0));
    assert_eq!(result["frames"][0]["reason"], "textMid");
    assert_eq!(result["sampler"]["kinds"][0], "atCaptions");
}

/// Feature: where-to-look samplers
/// Scenario: a sampler and a hand-written time list are refused together
#[test]
fn test_frame_extract_rejects_a_sampler_combined_with_explicit_times() {
    let dir = create_temp_project("frame_sampler_conflict");
    let path = project_path(&dir, "frame_sampler_conflict");

    let out_dir = dir.path().join("stills");
    let (_stdout, stderr) = run_cli_err(&[
        "frame",
        "extract",
        "--path",
        &path,
        "--at-cuts",
        "--times",
        "1.0,2.0",
        "--out",
        out_dir.to_str().unwrap(),
    ]);

    assert!(
        stderr.contains("--times") && stderr.contains("--at-cuts"),
        "Expected the refusal to name both sides of the conflict, got: {stderr}"
    );
}

/// Feature: affected ranges on mutating verbs
/// Scenario: a convenience verb records the hand-off too
///
/// `--affected` reads a single hand-off slot. While only `command execute` and
/// `plan execute` wrote it, a `timeline move` left the file describing an older
/// edit, and the next `--affected` sheet silently showed the wrong seconds —
/// the exact failure the sampler exists to remove.
#[test]
fn test_timeline_move_reports_and_records_its_affected_ranges() {
    let (_dir, path, _asset_id, track_id) =
        create_project_with_placed_dummy("timeline_move_affected");
    let sequence_id = active_sequence(&path);

    let clips = run_cli_ok(&["timeline", "clips", "--path", &path]);
    let clip = &clips["clips"][0];
    let clip_id = clip["id"].as_str().unwrap().to_string();
    let original_start = clip["timelineInSec"].as_f64().expect("timelineInSec");
    let length = clip["durationSec"].as_f64().expect("durationSec");
    let moved_start = original_start + length + 10.0;

    let result = run_cli_ok(&[
        "timeline",
        "move",
        "--path",
        &path,
        "--clip",
        &clip_id,
        "--track",
        &track_id,
        "--to",
        &moved_start.to_string(),
    ]);

    assert_eq!(result["status"], "ok");
    assert_eq!(result["sequenceId"], sequence_id.as_str());
    assert_eq!(
        affected_pairs(&result["affectedRanges"]),
        vec![
            (original_start, original_start + length),
            (moved_start, moved_start + length)
        ],
        "a convenience verb must report where it landed too: {result}"
    );

    let record = last_affected_record(&path);
    assert_eq!(record["sequenceId"], sequence_id.as_str());
    assert_eq!(
        record["opIds"].as_array().and_then(|ids| ids.last()),
        Some(&result["opId"])
    );
    assert_eq!(
        affected_pairs(&record["affectedRanges"]),
        affected_pairs(&result["affectedRanges"])
    );
}

/// Feature: where-to-look samplers
/// Scenario: `--affected` follows a convenience verb, not just `command execute`
#[test]
fn test_frame_extract_samples_the_range_a_timeline_move_changed() {
    let Some((dir, path, _sequence_id, track_id, _outgoing)) =
        create_two_shot_project("frame_affected_timeline_move")
    else {
        return;
    };

    let clips = run_cli_ok(&["timeline", "clips", "--path", &path]);
    let incoming = clips["clips"]
        .as_array()
        .expect("clips")
        .iter()
        .find(|clip| clip["timelineInSec"].as_f64() == Some(TRANSITION_SHOT_SEC))
        .expect("the second shot")
        .clone();
    let incoming_id = incoming["id"].as_str().expect("clip id").to_string();

    let moved = run_cli_ok(&[
        "timeline",
        "move",
        "--path",
        &path,
        "--clip",
        &incoming_id,
        "--track",
        &track_id,
        "--to",
        &(TRANSITION_SHOT_SEC + 0.5).to_string(),
    ]);
    let expected_ranges = affected_pairs(&moved["affectedRanges"]);
    assert!(!expected_ranges.is_empty(), "{moved}");

    let sheet_path = dir.path().join("moved.jpg");
    let result = run_cli_ok(&[
        "frame",
        "extract",
        "--path",
        &path,
        "--affected",
        "--grid",
        "auto",
        "--out",
        sheet_path.to_str().unwrap(),
    ]);

    assert_eq!(result["status"], "ok");
    assert_eq!(
        affected_pairs(&result["sampler"]["affectedRanges"]),
        expected_ranges,
        "the sheet has to be built from the ranges the move reported: {result}"
    );
    assert!(sheet_path.exists());
}

/// Feature: where-to-look samplers
/// Scenario: a hand-off the project has moved past is refused, not used
///
/// An undo leaves the record describing an edit the project no longer has.
/// Sampling it anyway is the one thing worse than not sampling at all: the
/// sheet looks right and points at seconds nothing changed at.
#[test]
fn test_frame_extract_affected_refuses_a_stale_hand_off() {
    let Some((dir, path, sequence_id, track_id, _outgoing)) =
        create_two_shot_project("frame_affected_stale")
    else {
        return;
    };

    let clips = run_cli_ok(&["timeline", "clips", "--path", &path]);
    let incoming_id = clips["clips"]
        .as_array()
        .expect("clips")
        .iter()
        .find(|clip| clip["timelineInSec"].as_f64() == Some(TRANSITION_SHOT_SEC))
        .and_then(|clip| clip["id"].as_str())
        .expect("the second shot")
        .to_string();

    run_cli_ok(&[
        "command",
        "execute",
        "--path",
        &path,
        "--type",
        "MoveClip",
        "--payload",
        &serde_json::json!({
            "sequenceId": sequence_id,
            "trackId": track_id,
            "clipId": incoming_id,
            "newTimelineIn": TRANSITION_SHOT_SEC + 0.5,
        })
        .to_string(),
    ]);

    // Undo does not record a hand-off, so the file now describes an edit the
    // project has rolled off its history.
    run_cli_ok(&["timeline", "undo", "--path", &path]);

    let out_dir = dir.path().join("stale");
    let (_stdout, stderr) = run_cli_err(&[
        "frame",
        "extract",
        "--path",
        &path,
        "--affected",
        "--out",
        out_dir.to_str().unwrap(),
    ]);

    assert!(
        stderr.contains("was not recorded") && stderr.contains("--between"),
        "Expected the refusal to say the hand-off is stale and name the fallback, got: {stderr}"
    );
}

// =============================================================================
// Sequence format (SetSequenceFormat)
// =============================================================================

/// Reads the frame rate and canvas a sequence currently declares.
fn sequence_format(path: &str) -> (f64, u64, u64) {
    let info = run_cli_ok(&["timeline", "info", "--path", path]);
    (
        info["fps"].as_f64().expect("timeline info reports fps"),
        info["canvas"]["width"]
            .as_u64()
            .expect("timeline info reports canvas width"),
        info["canvas"]["height"]
            .as_u64()
            .expect("timeline info reports canvas height"),
    )
}

#[test]
fn test_set_sequence_format_round_trips_through_undo_redo_and_reopen() {
    let dir = create_temp_project("fmt");
    let path = project_path(&dir, "fmt");

    assert_eq!(sequence_format(&path), (30.0, 1920, 1080));

    let result = run_cli_ok(&[
        "command",
        "execute",
        "--path",
        &path,
        "--type",
        "SetSequenceFormat",
        "--payload",
        r#"{"fps":25,"width":1080,"height":1920}"#,
    ]);
    assert_eq!(result["status"], "ok");
    assert_eq!(sequence_format(&path), (25.0, 1080, 1920));

    run_cli_ok(&["timeline", "undo", "--path", &path]);
    assert_eq!(sequence_format(&path), (30.0, 1920, 1080));

    run_cli_ok(&["timeline", "redo", "--path", &path]);
    assert_eq!(sequence_format(&path), (25.0, 1080, 1920));

    // Reopening replays the ops log from scratch, so the format has to survive
    // as an operation rather than as a live in-memory edit.
    let opened = run_cli_ok(&["project", "open", "--path", &path]);
    assert_eq!(opened["status"], "ok");
    assert_eq!(sequence_format(&path), (25.0, 1080, 1920));
}

#[test]
fn test_timeline_set_format_reports_the_affected_timeline() {
    let dir = create_temp_project("setfmt");
    let path = project_path(&dir, "setfmt");

    // A format change moves no clip, so there has to be something on the
    // timeline to prove the reported range is the whole sequence rather than
    // the empty diff an unchanged clip list would give.
    let dummy_file = dir.path().join("setfmt.mp4");
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
    let track_id = tracks["tracks"][0]["id"].as_str().unwrap().to_string();
    run_cli_ok(&[
        "timeline", "insert", "--path", &path, "--asset", &asset_id, "--track", &track_id, "--at",
        "0.0",
    ]);

    let result = run_cli_ok(&[
        "timeline",
        "set-format",
        "--path",
        &path,
        "--fps",
        "29.97",
        "--width",
        "1280",
        "--height",
        "720",
    ]);

    assert_eq!(result["status"], "ok");
    // A decimal snaps to the exact broadcast rational rather than 2997/100.
    assert_eq!(result["fpsRatio"]["num"], 30000);
    assert_eq!(result["fpsRatio"]["den"], 1001);
    assert_eq!(result["canvas"]["width"], 1280);
    assert_eq!(result["canvas"]["height"], 720);
    let ranges = result["affectedRanges"]
        .as_array()
        .expect("set-format must report affectedRanges like every other mutating verb");
    assert_eq!(
        ranges.len(),
        1,
        "a format change reaches every frame, so it is one range: {ranges:?}"
    );
    assert_eq!(ranges[0]["startSec"], 0.0);
    let info = run_cli_ok(&["timeline", "info", "--path", &path]);
    assert_eq!(
        ranges[0]["endSec"], info["durationSec"],
        "the reported range must span the whole timeline"
    );

    let (fps, width, height) = sequence_format(&path);
    assert!(
        (fps - 30000.0 / 1001.0).abs() < 1e-9,
        "unexpected fps: {fps}"
    );
    assert_eq!((width, height), (1280, 720));
}

#[test]
fn test_project_create_applies_the_requested_format_as_a_logged_operation() {
    let dir = tempfile::tempdir().expect("temp dir");
    let project_dir = dir.path().join("vertical");
    std::fs::create_dir_all(&project_dir).expect("project dir");
    let path = project_dir.to_string_lossy().to_string();

    let created = run_cli_ok(&[
        "project", "create", "--name", "Vertical", "--path", &path, "--fps", "25", "--width",
        "1080", "--height", "1920",
    ]);
    assert_eq!(created["sequenceFormat"]["canvas"]["width"], 1080);
    assert_eq!(sequence_format(&path), (25.0, 1080, 1920));

    // Applied through a command, so it is in the log and can be undone.
    run_cli_ok(&["timeline", "undo", "--path", &path]);
    assert_eq!(sequence_format(&path), (30.0, 1920, 1080));
}

#[test]
fn test_set_sequence_format_refuses_an_unusable_format() {
    let dir = create_temp_project("badfmt");
    let path = project_path(&dir, "badfmt");

    for payload in [
        r#"{}"#,
        r#"{"width":1081}"#,
        r#"{"height":8}"#,
        r#"{"fps":0}"#,
        r#"{"fps":{"num":30,"den":0}}"#,
        r#"{"audioSampleRate":47000}"#,
        r#"{"audioChannels":6}"#,
    ] {
        let (_stdout, stderr) = run_cli_err(&[
            "command",
            "execute",
            "--path",
            &path,
            "--type",
            "SetSequenceFormat",
            "--payload",
            payload,
        ]);
        assert!(
            !stderr.is_empty(),
            "payload {payload} should be refused with a reason"
        );
    }

    assert_eq!(sequence_format(&path), (30.0, 1920, 1080));
}

/// A `SetSequenceFormat` payload names no sequence, and the command resolves the
/// active one. `command execute` has to resolve it the same way, or the edit
/// applies while the result reports no sequence, no ranges, and writes no
/// `--affected` hand-off — leaving the agent with nothing to look at.
#[test]
fn test_command_execute_resolves_the_active_sequence_for_a_format_change() {
    let Some((dir, path, sequence_id, _track_id, _outgoing)) =
        create_two_shot_project("cmd_active_seq")
    else {
        return;
    };

    let result = run_cli_ok(&[
        "command",
        "execute",
        "--path",
        &path,
        "--type",
        "SetSequenceFormat",
        "--payload",
        r#"{"fps":25}"#,
    ]);

    assert_eq!(result["status"], "ok");
    assert_eq!(
        result["sequenceId"], sequence_id,
        "an omitted sequenceId must resolve to the active sequence: {result}"
    );

    let info = run_cli_ok(&["timeline", "info", "--path", &path]);
    assert_eq!(info["fps"], 25.0);
    let ranges = affected_pairs(&result["affectedRanges"]);
    assert_eq!(
        ranges.len(),
        1,
        "a format change reaches every frame, so it is one range: {result}"
    );
    assert_eq!(ranges[0].0, 0.0);
    assert_eq!(
        ranges[0].1,
        info["durationSec"].as_f64().expect("durationSec"),
        "the reported range must span the whole timeline: {result}"
    );

    // The hand-off is what `frame extract --affected` reads; without it the
    // sampler refuses rather than showing the change.
    let record = last_affected_record(&path);
    assert_eq!(record["sequenceId"], sequence_id);
    assert_eq!(record["opIds"][0], result["opId"]);
    assert_eq!(affected_pairs(&record["affectedRanges"]), ranges);

    let sheet_path = dir.path().join("format_affected.jpg");
    let sheet = run_cli_ok(&[
        "frame",
        "extract",
        "--path",
        &path,
        "--affected",
        "--grid",
        "auto",
        "--out",
        sheet_path.to_str().unwrap(),
    ]);
    assert_eq!(sheet["status"], "ok");
    assert_eq!(sheet["sampler"]["kinds"][0], "affected");
    assert!(sheet_path.exists());
}
