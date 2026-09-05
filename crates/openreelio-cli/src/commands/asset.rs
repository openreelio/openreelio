//! Asset management commands: import, list, info, remove.

use crate::media_probe;
use crate::output;
use clap::Subcommand;
use openreelio_core::assets::Asset;
use openreelio_core::commands::{import_command_from_probe, ImportAssetCommand};
use std::path::PathBuf;

#[derive(Subcommand)]
pub enum AssetAction {
    /// Import a media file as a project asset
    Import {
        /// Project directory path
        #[arg(long)]
        path: PathBuf,

        /// Path to the media file to import
        #[arg(long)]
        file: PathBuf,

        /// Display name for the asset (defaults to filename)
        #[arg(long)]
        name: Option<String>,

        /// Skip the FFprobe metadata read (faster, but the asset records no
        /// duration, dimensions or frame rate)
        #[arg(long)]
        no_probe: bool,
    },

    /// List all assets in the project
    List {
        /// Project directory path
        #[arg(long)]
        path: PathBuf,

        /// Output format
        #[arg(long, default_value = "json")]
        format: String,
    },

    /// Display asset information
    Info {
        /// Project directory path
        #[arg(long)]
        path: PathBuf,

        /// Asset ID
        #[arg(long)]
        id: String,
    },

    /// Remove an asset from the project
    Remove {
        /// Project directory path
        #[arg(long)]
        path: PathBuf,

        /// Asset ID to remove
        #[arg(long)]
        id: String,
    },
}

/// The probed metadata of an asset, shaped for `asset info` and `asset list`.
///
/// `durationSec` is what an agent reads before placing a clip, so it is
/// reported by both verbs rather than only by the detailed one: a null there is
/// the signal that an insert will fall back to the default length.
pub(crate) fn asset_media_json(asset: &Asset) -> serde_json::Value {
    let video = asset.video.as_ref().map(|video| {
        serde_json::json!({
            "width": video.width,
            "height": video.height,
            "fps": video.fps.as_f64(),
            "fpsNum": video.fps.num,
            "fpsDen": video.fps.den,
            "codec": video.codec,
        })
    });
    let audio = asset.audio.as_ref().map(|audio| {
        serde_json::json!({
            "sampleRate": audio.sample_rate,
            "channels": audio.channels,
            "codec": audio.codec,
        })
    });

    serde_json::json!({
        "durationSec": asset.duration_sec,
        "video": video,
        "audio": audio,
    })
}

pub fn execute(action: AssetAction) -> anyhow::Result<()> {
    match action {
        AssetAction::Import {
            path,
            file,
            name,
            no_probe,
        } => {
            let mut project = super::load_project(&path)?;
            let file_path = std::fs::canonicalize(&file)
                .map_err(|e| anyhow::anyhow!("File '{}' not found: {}", file.display(), e))?;

            let asset_name = name.unwrap_or_else(|| {
                file_path
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_else(|| "Untitled".to_string())
            });

            let uri = file_path.display().to_string();

            // Probe by default, exactly as the GUI's import does: an asset with
            // no duration makes every later insert fall back to a ten-second
            // default, which overruns short media and collides with the next
            // clip. `--no-probe` is the opt-out for callers importing in bulk.
            let mut warnings: Vec<String> = Vec::new();
            let media_info = if no_probe {
                None
            } else {
                match media_probe::probe_media(&file_path) {
                    Ok(info) => Some(info),
                    Err(reason) => {
                        warnings.push(format!(
                            "{reason}; the asset records no duration, so a clip inserted from it takes the default length"
                        ));
                        None
                    }
                }
            };

            let cmd: ImportAssetCommand =
                import_command_from_probe(&asset_name, &uri, media_info.as_ref());
            let asset_id = cmd.asset_id().to_string();
            let result = project
                .executor
                .execute(Box::new(cmd), &mut project.state)
                .map_err(|e| anyhow::anyhow!("Import failed: {}", e))?;

            super::save_project(&mut project)?;

            let media = project
                .state
                .assets
                .get(&asset_id)
                .map(asset_media_json)
                .unwrap_or_else(|| serde_json::json!({}));

            output::print_json(&serde_json::json!({
                "status": "ok",
                "opId": result.op_id,
                "createdIds": result.created_ids,
                "assetId": asset_id,
                "assetName": asset_name,
                "uri": uri,
                "probed": media_info.is_some(),
                "durationSec": media["durationSec"],
                "video": media["video"],
                "audio": media["audio"],
                "warnings": warnings,
            }))
        }

        AssetAction::List { path, format } => {
            if !format.eq_ignore_ascii_case("json") {
                return Err(anyhow::anyhow!(
                    "Unsupported format '{}'. Only 'json' is currently supported.",
                    format
                ));
            }
            let project = super::load_project(&path)?;

            let assets: Vec<serde_json::Value> = project
                .state
                .assets
                .iter()
                .map(|(id, asset)| {
                    let media = asset_media_json(asset);
                    serde_json::json!({
                        "id": id,
                        "name": asset.name,
                        "kind": format!("{:?}", asset.kind),
                        "uri": asset.uri,
                        "durationSec": media["durationSec"],
                        "video": media["video"],
                        "audio": media["audio"],
                    })
                })
                .collect();

            output::print_json_pretty(&serde_json::json!({
                "assets": assets,
                "count": assets.len(),
            }))
        }

        AssetAction::Info { path, id } => {
            let project = super::load_project(&path)?;
            let asset = project
                .state
                .assets
                .get(&id)
                .ok_or_else(|| anyhow::anyhow!("Asset '{}' not found", id))?;

            let (width, height) = asset
                .video
                .as_ref()
                .map(|v| (Some(v.width), Some(v.height)))
                .unwrap_or((None, None));
            let media = asset_media_json(asset);

            output::print_json_pretty(&serde_json::json!({
                "id": id,
                "name": asset.name,
                "kind": format!("{:?}", asset.kind),
                "uri": asset.uri,
                "durationSec": media["durationSec"],
                "width": width,
                "height": height,
                "video": media["video"],
                "audio": media["audio"],
            }))
        }

        AssetAction::Remove { path, id } => {
            let mut project = super::load_project(&path)?;
            let cmd = openreelio_core::commands::RemoveAssetCommand::new(&id);
            let result = project
                .executor
                .execute(Box::new(cmd), &mut project.state)
                .map_err(|e| anyhow::anyhow!("Remove failed: {}", e))?;

            super::save_project(&mut project)?;

            output::print_json(&serde_json::json!({
                "status": "ok",
                "opId": result.op_id,
                "deletedIds": result.deleted_ids,
            }))
        }
    }
}
