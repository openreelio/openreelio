//! Render and export commands.

use crate::output;
use clap::Subcommand;
use std::path::PathBuf;

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
        RenderAction::Presets => output::print_json_pretty(&serde_json::json!({
            "presets": [
                { "id": "mp4_h264_1080p", "label": "MP4 H.264 1080p", "extension": "mp4" },
                { "id": "mp4_h264_4k", "label": "MP4 H.264 4K", "extension": "mp4" },
                { "id": "mp4_h265_1080p", "label": "MP4 H.265 1080p", "extension": "mp4" },
                { "id": "webm_vp9_1080p", "label": "WebM VP9 1080p", "extension": "webm" },
                { "id": "prores_422", "label": "ProRes 422", "extension": "mov" },
                { "id": "prores_4444", "label": "ProRes 4444", "extension": "mov" },
                { "id": "gif", "label": "GIF Animation", "extension": "gif" },
            ]
        })),

        RenderAction::Start {
            path,
            output: output_path,
            preset,
            sequence,
        } => {
            let project = super::load_project(&path)?;

            // Render requires FFmpeg which is initialized at runtime.
            // For now, output the render command that would be executed.
            let seq_id = sequence
                .or_else(|| project.state.active_sequence_id.clone())
                .ok_or_else(|| {
                    anyhow::anyhow!("No sequence specified and no active sequence set")
                })?;

            output::print_json(&serde_json::json!({
                "status": "pending",
                "message": "Render job queued",
                "sequenceId": seq_id,
                "preset": preset,
                "output": output_path.display().to_string(),
                "note": "Full render pipeline requires FFmpeg runtime initialization. Use the GUI for interactive rendering.",
            }))
        }
    }
}
