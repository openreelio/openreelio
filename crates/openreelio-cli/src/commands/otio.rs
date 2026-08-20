//! OpenTimelineIO interchange: `otio export` and `otio import`.
//!
//! OTIO is the Academy Software Foundation's editorial interchange format.
//! DaVinci Resolve imports it natively, including on the free tier, so this is
//! the verb pair behind **assemble headless, finish in Resolve**.
//!
//! Both directions are a **cut interchange**. Tracks, clips, gaps, two-input
//! transitions and markers cross the boundary; effects, transforms, captions,
//! text, speed changes, opacity and blend modes do not. Neither verb drops any
//! of that quietly — every loss is named in the `warnings` and `unsupported`
//! arrays of the JSON these commands print.
//!
//! `otio import` builds a plan and runs it through the ordinary plan machinery,
//! so an import is one atomic, undoable unit that rolls back on failure and
//! reports through the same `0` / `1` / `2` exit codes as `plan execute`.
//! `--dry-run` prints the plan and stops without touching the project.

use clap::Subcommand;
use std::path::PathBuf;

use openreelio_core::fs::{validate_output_path, write_bytes_atomic_no_symlink};
use openreelio_core::interchange::otio;
use openreelio_core::interchange::otio_import::otio_to_plan_steps;

use super::plan::{EditPlan, PlanStep, EXIT_TOOL_FAILURE};
use crate::output;

#[derive(Subcommand)]
pub enum OtioAction {
    /// Export a sequence to an OpenTimelineIO file
    Export {
        /// Project directory path
        #[arg(long)]
        path: PathBuf,

        /// Output .otio file path
        #[arg(long)]
        out: PathBuf,

        /// Sequence ID (defaults to active)
        #[arg(long)]
        sequence: Option<String>,
    },

    /// Import an OpenTimelineIO file into a sequence
    Import {
        /// Project directory path
        #[arg(long)]
        path: PathBuf,

        /// OpenTimelineIO file to read
        #[arg(long)]
        file: PathBuf,

        /// Sequence ID to import into (defaults to active)
        #[arg(long)]
        sequence: Option<String>,

        /// Print the plan the file proposes and stop without applying it
        #[arg(long)]
        dry_run: bool,
    },
}

pub fn execute(action: OtioAction) -> anyhow::Result<()> {
    match action {
        OtioAction::Export {
            path,
            out,
            sequence,
        } => run_export(&path, &out, sequence),

        // Only `import` mutates, so only `import` carries the exit-code
        // contract; `export` reports through JSON alone.
        OtioAction::Import {
            path,
            file,
            sequence,
            dry_run,
        } => match run_import(&path, &file, sequence, dry_run) {
            Ok(0) => Ok(()),
            Ok(exit_code) => {
                super::plan::flush_stdout();
                std::process::exit(exit_code)
            }
            Err(error) => {
                super::plan::flush_stdout();
                eprintln!("error: {error}");
                std::process::exit(EXIT_TOOL_FAILURE)
            }
        },
    }
}

// =============================================================================
// Export
// =============================================================================

fn run_export(
    path: &PathBuf,
    out: &std::path::Path,
    sequence: Option<String>,
) -> anyhow::Result<()> {
    let project = super::load_project(path)?;
    let sequence_id = super::resolve_sequence_id(&project, sequence)?;
    let seq = project
        .state
        .sequences
        .get(&sequence_id)
        .ok_or_else(|| anyhow::anyhow!("Sequence not found: {}", sequence_id))?;

    let export = otio::export_otio(seq, &project.state.assets, &project.state.effects)
        .map_err(|error| anyhow::anyhow!("OTIO export failed: {}", error))?;

    let out_display = out.to_string_lossy().to_string();
    let validated = validate_output_path(&out_display, "OTIO output path")
        .map_err(|error| anyhow::anyhow!(error))?;
    write_bytes_atomic_no_symlink(&validated, export.json.as_bytes(), "OTIO output path")
        .map_err(|error| anyhow::anyhow!("Failed to write OTIO file: {}", error))?;

    output::print_json(&serde_json::json!({
        "status": "ok",
        "message": "Sequence exported to OpenTimelineIO",
        "output": validated.to_string_lossy(),
        "sequenceId": sequence_id,
        "trackCount": export.track_count,
        "clipCount": export.clip_count,
        "warnings": export.warnings,
        "unsupported": export.unsupported,
    }))
}

// =============================================================================
// Import
// =============================================================================

fn run_import(
    path: &PathBuf,
    file: &std::path::Path,
    sequence: Option<String>,
    dry_run: bool,
) -> anyhow::Result<i32> {
    let document = std::fs::read_to_string(file).map_err(|error| {
        anyhow::anyhow!("Failed to read OTIO file '{}': {}", file.display(), error)
    })?;
    let timeline = otio::parse_otio(&document).map_err(|error| anyhow::anyhow!(error))?;

    let mut project = super::load_project(path)?;
    let sequence_id = super::resolve_sequence_id(&project, sequence)?;

    let import = otio_to_plan_steps(&timeline, &sequence_id, &project.state.assets)
        .map_err(|error| anyhow::anyhow!(error))?;

    let steps: Vec<PlanStep> = import
        .steps
        .iter()
        .map(|step| serde_json::from_value(step.clone()))
        .collect::<Result<_, _>>()
        .map_err(|error| anyhow::anyhow!("OTIO import produced an unreadable step: {}", error))?;

    let plan = EditPlan {
        id: plan_id(file),
        steps,
    };

    let asset_imports: Vec<serde_json::Value> = import
        .asset_imports
        .iter()
        .map(|asset| serde_json::json!({ "name": asset.name, "uri": asset.uri }))
        .collect();

    if dry_run {
        // Nothing above this point mutates, and nothing below it runs: the whole
        // point of a dry run is that the caller can read the plan before any of
        // it is real.
        output::print_json(&serde_json::json!({
            "status": "ok",
            "message": "Dry run: no changes were applied",
            "dryRun": true,
            "sequenceId": sequence_id,
            "stepCount": plan.steps.len(),
            "plan": plan,
            "assetImports": asset_imports,
            "warnings": import.warnings,
            "unsupported": import.unsupported,
        }))?;
        return Ok(0);
    }

    let (mut result, exit_code) = super::plan::execute_plan_on_project(&mut project, &plan)?;

    // The plan report says what ran; the import report has to also say what the
    // file could not bring with it, or the loss is invisible at the surface the
    // caller actually reads.
    if let Some(map) = result.as_object_mut() {
        map.insert("sequenceId".to_string(), serde_json::json!(sequence_id));
        map.insert("assetImports".to_string(), serde_json::json!(asset_imports));
        map.insert("warnings".to_string(), serde_json::json!(import.warnings));
        map.insert(
            "unsupported".to_string(),
            serde_json::json!(import.unsupported),
        );
    }

    output::print_json(&result)?;
    Ok(exit_code)
}

/// Derives a stable plan id from the file being imported.
fn plan_id(file: &std::path::Path) -> String {
    let stem = file
        .file_stem()
        .map(|stem| stem.to_string_lossy().to_string())
        .filter(|stem| !stem.trim().is_empty())
        .unwrap_or_else(|| "timeline".to_string());
    format!("otio_import_{stem}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plan_id_is_derived_from_the_file_name() {
        assert_eq!(
            plan_id(std::path::Path::new("/tmp/My Cut.otio")),
            "otio_import_My Cut"
        );
    }

    #[test]
    fn plan_id_falls_back_when_the_file_has_no_stem() {
        assert_eq!(plan_id(std::path::Path::new("/")), "otio_import_timeline");
    }
}
