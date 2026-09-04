//! Render and export commands.

use crate::ffmpeg_env::ensure_ffmpeg;
use crate::output;
use crate::validate;
use clap::Subcommand;
use openreelio_core::ffmpeg::FFmpegRunner;
use openreelio_core::render::{
    build_render_graph, build_render_plan, validate_export_settings, AudioCodec, ExportEngine,
    ExportPreset, ExportProgress, ExportSettings, HdrMode, VideoCodec,
};
use openreelio_core::timeline::Canvas;
use std::path::PathBuf;

/// Canonical list of render presets. Single source of truth for both
/// `render presets` output and `render start` validation.
const RENDER_PRESETS: &[(&str, &str, &str)] = &[
    ("mp4_h264_1080p", "MP4 H.264 1080p", "mp4"),
    ("mp4_h264_4k", "MP4 H.264 4K", "mp4"),
    ("mp4_h265_1080p", "MP4 H.265 1080p", "mp4"),
    ("mp4_draft", "MP4 H.264 720p Draft", "mp4"),
    ("proxy_480p", "Proxy 480p (fast, agent inspection)", "mp4"),
    ("webm_vp9_1080p", "WebM VP9 1080p", "webm"),
    ("prores_422", "ProRes 422", "mov"),
];

/// Preset identifier selected by the `--proxy` shorthand.
///
/// Public so the MCP render tool can default to the same draft preset by name
/// rather than by a second copy of the string.
pub const PROXY_PRESET_ID: &str = "proxy_480p";

/// Draft preset the MCP render tool accepts alongside [`PROXY_PRESET_ID`].
///
/// A 720p draft is the one step up worth offering an agent: enough resolution
/// to judge legibility of burned-in text, still fast enough to be a look rather
/// than a deliverable. Everything above it is an export, which is the user's
/// decision and not a tool call.
pub const DRAFT_PRESET_ID: &str = "mp4_draft";

/// Progress channel depth. Bounded so a slow stderr consumer applies
/// backpressure to the progress reader instead of growing without limit.
const PROGRESS_CHANNEL_CAPACITY: usize = 32;

#[derive(Subcommand)]
pub enum RenderAction {
    /// List available render presets
    Presets,

    /// Output the renderer-agnostic graph for preview/export tooling
    Graph {
        /// Project directory path
        #[arg(long)]
        path: PathBuf,

        /// Sequence ID (defaults to active)
        #[arg(long)]
        sequence: Option<String>,
    },

    /// Start a render job (requires FFmpeg)
    Start {
        /// Project directory path
        #[arg(long)]
        path: PathBuf,

        /// Output file path
        #[arg(long)]
        output: PathBuf,

        /// Render preset name
        #[arg(long, default_value = "mp4_h264_1080p")]
        preset: String,

        /// Render a fast 480p proxy for inspection (shorthand for --preset proxy_480p)
        #[arg(long, conflicts_with = "preset")]
        proxy: bool,

        /// Sequence ID (defaults to active)
        #[arg(long)]
        sequence: Option<String>,

        /// Start of the rendered range in timeline seconds
        #[arg(long)]
        start: Option<f64>,

        /// End of the rendered range in timeline seconds
        #[arg(long)]
        end: Option<f64>,

        /// Stream NDJSON encode progress to stderr
        #[arg(long)]
        progress: bool,
    },
}

pub fn execute(action: RenderAction) -> anyhow::Result<()> {
    match action {
        RenderAction::Presets => {
            let presets: Vec<serde_json::Value> = RENDER_PRESETS
                .iter()
                .map(|(id, label, ext)| {
                    serde_json::json!({ "id": id, "label": label, "extension": ext })
                })
                .collect();
            output::print_json_pretty(&serde_json::json!({ "presets": presets }))
        }

        RenderAction::Graph { path, sequence } => {
            let project = super::load_project(&path)?;
            let seq_id = super::resolve_sequence_id(&project, sequence)?;
            let graph = build_render_graph(&project.state, &seq_id)
                .map_err(|error| anyhow::anyhow!("Failed to build render graph: {}", error))?;

            output::print_json_pretty(&graph)
        }

        RenderAction::Start {
            path,
            output: output_path,
            preset,
            proxy,
            sequence,
            start,
            end,
            progress,
        } => start_render(StartArgs {
            path,
            output_path,
            preset,
            proxy,
            sequence,
            start,
            end,
            progress,
        }),
    }
}

/// Parsed `render start` inputs.
///
/// Kept as a struct so the `Commands` enum stays small (see the crate-level
/// `large_enum_variant` allowance) and the handler signature stays readable.
///
/// Public because the MCP server renders through this same path: one preset
/// table, one validation pass, one result shape, so a draft an agent asks for
/// over MCP is the file `render start` would have produced.
pub struct StartArgs {
    /// Project directory path.
    pub path: PathBuf,
    /// Output file the render is written to.
    pub output_path: PathBuf,
    /// Render preset id; ignored when `proxy` is set.
    pub preset: String,
    /// Use the draft proxy preset regardless of `preset`.
    pub proxy: bool,
    /// Sequence to render; the project's active sequence when absent.
    pub sequence: Option<String>,
    /// First timeline second to render.
    pub start: Option<f64>,
    /// Last timeline second to render.
    pub end: Option<f64>,
    /// Stream NDJSON progress records to stderr.
    pub progress: bool,
}

fn start_render(args: StartArgs) -> anyhow::Result<()> {
    output::print_json_pretty(&run_start_render(args)?)
}

/// Runs one render and returns the report `render start` would have printed.
///
/// Split from [`start_render`] so the MCP server can serve the same render —
/// same preset table, same validation, same result shape — without going
/// through stdout.
pub fn run_start_render(args: StartArgs) -> anyhow::Result<serde_json::Value> {
    let StartArgs {
        path,
        output_path,
        preset,
        proxy,
        sequence,
        start,
        end,
        progress,
    } = args;

    validate_render_range(start, end)?;

    let preset_id = if proxy {
        PROXY_PRESET_ID.to_string()
    } else {
        preset
    };
    let output_path = if proxy {
        default_extension(output_path, "mp4")
    } else {
        output_path
    };

    let project = super::load_project(&path)?;
    let seq_id = super::resolve_sequence_id(&project, sequence)?;
    let sequence = project
        .state
        .sequences
        .get(&seq_id)
        .ok_or_else(|| anyhow::anyhow!("Sequence '{}' not found", seq_id))?
        .clone();
    let assets = project.state.assets.clone();
    let effects = project.state.effects.clone();
    let settings =
        build_export_settings(&preset_id, output_path, &sequence.format.canvas, start, end)?;
    let graph = build_render_graph(&project.state, &seq_id)
        .map_err(|error| anyhow::anyhow!("Failed to build render graph: {}", error))?;

    // Validation measures transformed clips with FFprobe, so the resolved
    // binaries have to be registered before it runs — see `ffmpeg_env`.
    let ffmpeg_info = ensure_ffmpeg()?;

    let validation = validate_export_settings(&sequence, &assets, &effects, &settings);
    if !validation.is_valid {
        return Err(anyhow::anyhow!(
            "Render validation failed: {}",
            validation.errors.join("; ")
        ));
    }
    let render_plan = build_render_plan(&graph, &assets, &effects, &settings);
    if !render_plan.validation.is_valid {
        return Err(anyhow::anyhow!(
            "Render plan validation failed: {}",
            render_plan.validation.errors.join("; ")
        ));
    }
    let plan_hash = render_plan.plan_hash.clone();

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|error| anyhow::anyhow!("Failed to create Tokio runtime: {error}"))?;
    let result = runtime.block_on(async move {
        let (cancel_tx, cancel_rx) = tokio::sync::oneshot::channel::<()>();
        // Ctrl-C must reach FFmpeg: without this the CLI would exit while the
        // child keeps encoding into a half-written output file.
        let signal_task = tokio::spawn(async move {
            if tokio::signal::ctrl_c().await.is_ok() {
                let _ = cancel_tx.send(());
            }
        });

        let (progress_tx, progress_task) = if progress {
            let (tx, mut rx) =
                tokio::sync::mpsc::channel::<ExportProgress>(PROGRESS_CHANNEL_CAPACITY);
            let task = tokio::spawn(async move {
                while let Some(update) = rx.recv().await {
                    emit_progress_line(&update);
                }
            });
            (Some(tx), Some(task))
        } else {
            (None, None)
        };

        let engine = ExportEngine::new(FFmpegRunner::new(ffmpeg_info));
        let export = engine
            .export_sequence_with_effects_for_plan(
                &sequence,
                &assets,
                &effects,
                &settings,
                &render_plan,
                progress_tx,
                Some(cancel_rx),
            )
            .await;

        signal_task.abort();
        if let Some(task) = progress_task {
            let _ = task.await;
        }

        export
    });

    let result = result.map_err(|error| match error {
        openreelio_core::render::ExportError::Cancelled => {
            anyhow::anyhow!("Render cancelled; the partial output file was removed")
        }
        other => anyhow::anyhow!(other),
    })?;

    Ok(serde_json::json!({
        "status": "ok",
        "sequenceId": seq_id,
        "preset": preset_id,
        "outputPath": result.output_path.display().to_string(),
        "durationSec": result.duration_sec,
        "fileSize": result.file_size,
        "encodingTimeSec": result.encoding_time_sec,
        "planHash": plan_hash,
        "warnings": validation.warnings,
    }))
}

/// Write one NDJSON progress record to stderr.
///
/// stdout stays reserved for the single result object, so progress goes to
/// stderr where a supervising agent can read it line by line.
fn emit_progress_line(update: &ExportProgress) {
    let line = serde_json::json!({
        "type": "progress",
        "percent": update.percent,
        "frame": update.frame,
        "totalFrames": update.total_frames,
        "fps": update.fps,
        "etaSeconds": update.eta_seconds,
        "message": update.message,
    });
    eprintln!("{}", line);
}

/// Validates the optional `--start` / `--end` render range.
fn validate_render_range(start: Option<f64>, end: Option<f64>) -> anyhow::Result<()> {
    if let Some(start) = start {
        validate::time_non_negative(start, "start")?;
    }
    if let Some(end) = end {
        validate::time_non_negative(end, "end")?;
    }
    if let (Some(start), Some(end)) = (start, end) {
        validate::time_range_ordered(start, end, "start", "end")?;
    }
    Ok(())
}

/// Appends `extension` when the path has none, leaving explicit extensions alone.
fn default_extension(path: PathBuf, extension: &str) -> PathBuf {
    if path.extension().is_some() {
        return path;
    }
    path.with_extension(extension)
}

/// Builds export settings for a named preset.
///
/// `canvas` is the sequence canvas: the proxy preset fits its frame to it so a
/// vertical or square edit is not pillarboxed into a 16:9 proxy.
fn build_export_settings(
    preset: &str,
    output_path: PathBuf,
    canvas: &Canvas,
    start_time: Option<f64>,
    end_time: Option<f64>,
) -> anyhow::Result<ExportSettings> {
    let normalized = preset.trim().to_lowercase();
    let mut settings = match normalized.as_str() {
        "mp4_h264_1080p" | "youtube_1080p" | "youtube1080p" => {
            ExportSettings::from_preset(ExportPreset::Youtube1080p, output_path)
        }
        "mp4_h264_4k" | "youtube_4k" | "youtube4k" => {
            ExportSettings::from_preset(ExportPreset::Youtube4k, output_path)
        }
        "mp4_h265_1080p" => ExportSettings {
            preset: ExportPreset::Custom,
            output_path,
            video_codec: VideoCodec::H265,
            audio_codec: AudioCodec::Aac,
            width: Some(1920),
            height: Some(1080),
            video_bitrate: Some("6M".to_string()),
            audio_bitrate: Some("192k".to_string()),
            fps: Some(30.0),
            crf: Some(28),
            two_pass: false,
            start_time: None,
            end_time: None,
            hdr_mode: HdrMode::Sdr,
            max_cll: None,
            max_fall: None,
            bit_depth: None,
            tonemap_mode: None,
            hardware_accel: Default::default(),
            resolved_encoder_name: None,
            encoder_speed: None,
        },
        "mp4_draft" | "mp4_h264_720p" | "draft" => {
            ExportSettings::from_preset(ExportPreset::Mp4Draft, output_path)
        }
        // Which ids mean "proxy" is core's answer, so the CLI and the desktop
        // render commands cannot accept different spellings.
        id if openreelio_core::render::is_proxy_preset_id(id) => {
            ExportSettings::proxy(output_path, canvas, start_time, end_time)
        }
        "webm_vp9_1080p" | "webm_vp9" | "webm" => {
            ExportSettings::from_preset(ExportPreset::WebmVp9, output_path)
        }
        "prores_422" | "prores" => ExportSettings::from_preset(ExportPreset::ProRes, output_path),
        "prores_4444" => {
            return Err(anyhow::anyhow!(
                "Preset 'prores_4444' is not currently supported in CLI mode. Use 'prores_422' instead."
            ));
        }
        other => {
            return Err(anyhow::anyhow!(
                "Unknown preset '{}'. Use 'render presets' to list available presets.",
                other
            ));
        }
    };

    settings.start_time = start_time;
    settings.end_time = end_time;

    Ok(settings)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn render_presets_should_expose_the_proxy_preset() {
        assert!(RENDER_PRESETS
            .iter()
            .any(|(id, _, ext)| *id == PROXY_PRESET_ID && *ext == "mp4"));
    }

    #[test]
    fn build_export_settings_should_apply_proxy_dimensions_and_speed() {
        let settings = build_export_settings(
            PROXY_PRESET_ID,
            PathBuf::from("proxy.mp4"),
            &Canvas::new(1920, 1080),
            None,
            None,
        )
        .unwrap();

        assert_eq!(settings.width, Some(854));
        assert_eq!(settings.height, Some(480));
        assert_eq!(settings.encoder_speed.as_deref(), Some("ultrafast"));
    }

    #[test]
    fn build_export_settings_should_fit_the_proxy_to_a_vertical_canvas() {
        let settings = build_export_settings(
            PROXY_PRESET_ID,
            PathBuf::from("proxy.mp4"),
            &Canvas::new(1080, 1920),
            None,
            None,
        )
        .unwrap();

        assert_eq!(settings.width, Some(480));
        assert_eq!(settings.height, Some(854));
    }

    #[test]
    fn build_export_settings_should_carry_the_requested_range() {
        let settings = build_export_settings(
            "mp4_h264_1080p",
            PathBuf::from("out.mp4"),
            &Canvas::new(1920, 1080),
            Some(1.5),
            Some(4.0),
        )
        .unwrap();

        assert_eq!(settings.start_time, Some(1.5));
        assert_eq!(settings.end_time, Some(4.0));
    }

    #[test]
    fn validate_render_range_should_reject_inverted_ranges() {
        assert!(validate_render_range(Some(5.0), Some(1.0)).is_err());
        assert!(validate_render_range(Some(-1.0), None).is_err());
        assert!(validate_render_range(Some(0.0), Some(1.0)).is_ok());
        assert!(validate_render_range(None, None).is_ok());
    }

    #[test]
    fn default_extension_should_only_fill_missing_extensions() {
        assert_eq!(
            default_extension(PathBuf::from("out"), "mp4"),
            PathBuf::from("out.mp4")
        );
        assert_eq!(
            default_extension(PathBuf::from("out.mov"), "mp4"),
            PathBuf::from("out.mov")
        );
    }
}
