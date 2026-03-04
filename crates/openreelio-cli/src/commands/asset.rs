//! Asset management commands: import, list, info, remove.

use std::path::PathBuf;
use clap::Subcommand;
use openreelio_core::commands::ImportAssetCommand;
use crate::output;

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

pub async fn execute(action: AssetAction) -> anyhow::Result<()> {
    match action {
        AssetAction::Import { path, file, name } => {
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
            let cmd = ImportAssetCommand::new(&asset_name, &uri);
            let result = project
                .executor
                .execute(Box::new(cmd), &mut project.state)
                .map_err(|e| anyhow::anyhow!("Import failed: {}", e))?;

            super::save_project(&mut project)?;

            output::print_json(&serde_json::json!({
                "status": "ok",
                "opId": result.op_id,
                "createdIds": result.created_ids,
                "assetName": asset_name,
                "uri": uri,
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
                    serde_json::json!({
                        "id": id,
                        "name": asset.name,
                        "kind": format!("{:?}", asset.kind),
                        "uri": asset.uri,
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

            output::print_json_pretty(&serde_json::json!({
                "id": id,
                "name": asset.name,
                "kind": format!("{:?}", asset.kind),
                "uri": asset.uri,
                "durationSec": asset.duration_sec,
                "width": width,
                "height": height,
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
