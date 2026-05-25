//! Render and export commands.

use crate::output;
use clap::Subcommand;
use openreelio_core::ffmpeg::{detect_bundled_at_path, detect_system_ffmpeg, FFmpegRunner};
use openreelio_core::render::{
    build_render_graph, build_render_plan, validate_export_settings, AudioCodec, ExportEngine,
    ExportPreset, ExportSettings, HdrMode, VideoCodec,
};
use std::path::PathBuf;

/// Canonical list of render presets. Single source of truth for both
/// `render presets` output and `render start` validation.
const RENDER_PRESETS: &[(&str, &str, &str)] = &[
    ("mp4_h264_1080p", "MP4 H.264 1080p", "mp4"),
    ("mp4_h264_4k", "MP4 H.264 4K", "mp4"),
    ("mp4_h265_1080p", "MP4 H.265 1080p", "mp4"),
    ("webm_vp9_1080p", "WebM VP9 1080p", "webm"),
    ("prores_422", "ProRes 422", "mov"),
];

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

        /// Sequence ID (defaults to active)
        #[arg(long)]
        sequence: Option<String>,
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
            sequence,
        } => {
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
            let settings = build_export_settings(&preset, output_path.clone())?;
            let graph = build_render_graph(&project.state, &seq_id)
                .map_err(|error| anyhow::anyhow!("Failed to build render graph: {}", error))?;

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

            let ffmpeg_info = detect_cli_ffmpeg()?;
            let runtime = tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
                .map_err(|error| anyhow::anyhow!("Failed to create Tokio runtime: {error}"))?;
            let result = runtime.block_on(async move {
                let engine = ExportEngine::new(FFmpegRunner::new(ffmpeg_info));
                engine
                    .export_sequence_with_effects_for_plan(
                        &sequence,
                        &assets,
                        &effects,
                        &settings,
                        &render_plan,
                        None,
                        None,
                    )
                    .await
            })?;

            output::print_json_pretty(&serde_json::json!({
                "status": "ok",
                "sequenceId": seq_id,
                "preset": preset,
                "outputPath": result.output_path.display().to_string(),
                "durationSec": result.duration_sec,
                "fileSize": result.file_size,
                "encodingTimeSec": result.encoding_time_sec,
                "planHash": plan_hash,
                "warnings": validation.warnings,
            }))
        }
    }
}

fn build_export_settings(preset: &str, output_path: PathBuf) -> anyhow::Result<ExportSettings> {
    let normalized = preset.trim().to_lowercase();
    let settings = match normalized.as_str() {
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
        },
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

    Ok(settings)
}

fn detect_cli_ffmpeg() -> anyhow::Result<openreelio_core::ffmpeg::FFmpegInfo> {
    let candidate_roots = [
        std::env::current_dir()
            .ok()
            .map(|path| path.join("src-tauri")),
        std::env::current_dir().ok(),
        std::env::current_exe()
            .ok()
            .and_then(|path| path.parent().map(|parent| parent.to_path_buf())),
    ];

    for root in candidate_roots.into_iter().flatten() {
        if let Ok(info) = detect_bundled_at_path(&root) {
            return Ok(info);
        }
    }

    detect_system_ffmpeg()
        .map_err(|error| anyhow::anyhow!("FFmpeg initialization failed: {}", error))
}
