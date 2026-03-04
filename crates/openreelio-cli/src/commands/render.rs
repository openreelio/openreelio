//! Render and export commands.

use crate::output;
use clap::Subcommand;
use std::path::PathBuf;

/// Canonical list of render presets. Single source of truth for both
/// `render presets` output and `render start` validation.
const RENDER_PRESETS: &[(&str, &str, &str)] = &[
    ("mp4_h264_1080p", "MP4 H.264 1080p", "mp4"),
    ("mp4_h264_4k", "MP4 H.264 4K", "mp4"),
    ("mp4_h265_1080p", "MP4 H.265 1080p", "mp4"),
    ("webm_vp9_1080p", "WebM VP9 1080p", "webm"),
    ("prores_422", "ProRes 422", "mov"),
    ("prores_4444", "ProRes 4444", "mov"),
    ("gif", "GIF Animation", "gif"),
];

#[derive(Subcommand)]
pub enum RenderAction {
    /// List available render presets
    Presets,

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

        RenderAction::Start {
            path,
            output: output_path,
            preset,
            sequence,
        } => {
            let project = super::load_project(&path)?;
            let seq_id = super::resolve_sequence_id(&project, sequence)?;

            // Validate the preset name against the canonical list
            if !RENDER_PRESETS
                .iter()
                .any(|(id, _, _)| *id == preset.as_str())
            {
                return Err(anyhow::anyhow!(
                    "Unknown preset '{}'. Use 'render presets' to list available presets.",
                    preset
                ));
            }

            // Validate sequence exists
            if !project.state.sequences.contains_key(&seq_id) {
                return Err(anyhow::anyhow!("Sequence '{}' not found", seq_id));
            }

            Err(anyhow::anyhow!(
                "Render is not yet implemented in CLI mode. \
                 Sequence '{}' with preset '{}' to '{}' validated successfully, \
                 but FFmpeg render pipeline requires runtime initialization. \
                 This feature is planned for a future release.",
                seq_id,
                preset,
                output_path.display()
            ))
        }
    }
}
