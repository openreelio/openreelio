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
use openreelio_core::interchange::otio_import::{
    otio_to_plan_steps, OtioImportContext, OtioImportPlan,
};

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

        /// Import media the file references from outside the project directory
        ///
        /// Off by default: an `.otio` chooses its own media paths, and importing
        /// one hands its author a filesystem probe. Pass this only for a file
        /// you trust whose media genuinely lives elsewhere.
        #[arg(long)]
        allow_external_media: bool,
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
            allow_external_media,
        } => match run_import(&path, &file, sequence, dry_run, allow_external_media) {
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
    allow_external_media: bool,
) -> anyhow::Result<i32> {
    let document = read_otio_document(file)?;
    let timeline = otio::parse_otio(&document).map_err(|error| anyhow::anyhow!(error))?;

    if dry_run {
        // A dry run reads the project and stops, so it must not *open* one:
        // opening an editing session creates the hidden state directory,
        // migrates legacy state files into it and takes the ops-log lock, all
        // of which are writes. Nothing here holds an ActiveProject, so nothing
        // here can save.
        let (project_root, state) = super::load_project_state_read_only(path)?;
        let sequence_id = super::resolve_sequence_id_in_state(&state, sequence)?;
        let import = build_import(
            &timeline,
            &sequence_id,
            &state,
            &project_root,
            allow_external_media,
        )?;
        let (plan, asset_imports) = plan_from_import(file, &import)?;

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

    let mut project = super::load_project(path)?;
    let sequence_id = super::resolve_sequence_id(&project, sequence)?;
    let import = build_import(
        &timeline,
        &sequence_id,
        &project.state,
        &project.path,
        allow_external_media,
    )?;
    let (plan, asset_imports) = plan_from_import(file, &import)?;

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

/// Builds the plan an OTIO file proposes for `sequence_id`.
fn build_import(
    timeline: &openreelio_core::interchange::otio_schema::OtioTimeline,
    sequence_id: &str,
    state: &openreelio_core::project::ProjectState,
    project_root: &std::path::Path,
    allow_external_media: bool,
) -> anyhow::Result<OtioImportPlan> {
    let sequence_fps = state
        .sequences
        .get(sequence_id)
        .map(|sequence| sequence.format.fps.clone())
        .ok_or_else(|| anyhow::anyhow!("Sequence not found: {}", sequence_id))?;

    otio_to_plan_steps(
        timeline,
        &OtioImportContext {
            sequence_id,
            assets: &state.assets,
            project_root,
            sequence_fps,
            allow_external_media,
        },
    )
    .map_err(|error| anyhow::anyhow!(error))
}

/// Turns the importer's JSON steps into an [`EditPlan`] plus its asset report.
fn plan_from_import(
    file: &std::path::Path,
    import: &OtioImportPlan,
) -> anyhow::Result<(EditPlan, Vec<serde_json::Value>)> {
    let steps: Vec<PlanStep> = import
        .steps
        .iter()
        .map(|step| serde_json::from_value(step.clone()))
        .collect::<Result<_, _>>()
        .map_err(|error| anyhow::anyhow!("OTIO import produced an unreadable step: {}", error))?;

    let asset_imports = import
        .asset_imports
        .iter()
        .map(|asset| serde_json::json!({ "name": asset.name, "uri": asset.uri }))
        .collect();

    Ok((
        EditPlan {
            id: plan_id(file),
            steps,
        },
        asset_imports,
    ))
}

/// An OTIO document is a cut list, not media; a sane one is well under this.
const MAX_OTIO_BYTES: u64 = 64 * 1024 * 1024;

/// Reads an OTIO document, refusing one larger than [`MAX_OTIO_BYTES`].
fn read_otio_document(file: &std::path::Path) -> anyhow::Result<String> {
    read_capped(file, MAX_OTIO_BYTES)
}

/// Reads a whole file, refusing one larger than `max_bytes`.
///
/// The cap is enforced by the read itself rather than by a `metadata` check
/// beforehand. A stat can be raced, and it silently reports nothing useful for a
/// pipe or a device node, so a `metadata` guard in front of `read_to_string`
/// leaves the unbounded read reachable — which is the only part that matters,
/// because it is the one that allocates.
fn read_capped(file: &std::path::Path, max_bytes: u64) -> anyhow::Result<String> {
    use std::io::Read;

    let handle = std::fs::File::open(file).map_err(|error| {
        anyhow::anyhow!("Failed to read OTIO file '{}': {}", file.display(), error)
    })?;

    let mut buffer = Vec::new();
    handle
        .take(max_bytes.saturating_add(1))
        .read_to_end(&mut buffer)
        .map_err(|error| {
            anyhow::anyhow!("Failed to read OTIO file '{}': {}", file.display(), error)
        })?;

    if buffer.len() as u64 > max_bytes {
        anyhow::bail!(
            "OTIO file '{}' is larger than the {} MiB limit",
            file.display(),
            max_bytes / (1024 * 1024)
        );
    }

    String::from_utf8(buffer).map_err(|_| {
        anyhow::anyhow!(
            "OTIO file '{}' is not valid UTF-8; OTIO documents are JSON text",
            file.display()
        )
    })
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

    fn write_temp(name: &str, bytes: &[u8]) -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().expect("a temp dir");
        let file = dir.path().join(name);
        std::fs::write(&file, bytes).expect("write fixture");
        (dir, file)
    }

    #[test]
    fn should_refuse_a_document_larger_than_the_cap_through_the_read_itself() {
        // The cap has to be enforced by the read, not by a metadata check in
        // front of it: a stat can be raced, and it reports nothing useful for a
        // pipe, so a guard that only consults metadata leaves the unbounded read
        // — the part that allocates — reachable.
        let (_dir, file) = write_temp("big.otio", &[b'x'; 64]);

        let error = read_capped(&file, 16).expect_err("an oversized file must be refused");

        assert!(
            error.to_string().contains("larger than"),
            "the refusal must name the cap, got: {error}"
        );
    }

    #[test]
    fn should_read_a_document_that_exactly_fills_the_cap() {
        let (_dir, file) = write_temp("exact.otio", b"0123456789abcdef");

        let document = read_capped(&file, 16).expect("a file at the cap should read");

        assert_eq!(document, "0123456789abcdef");
    }

    #[test]
    fn should_refuse_a_document_that_is_not_utf8() {
        let (_dir, file) = write_temp("binary.otio", &[0xff, 0xfe, 0x00]);

        let error = read_capped(&file, 16).expect_err("binary is not an OTIO document");

        assert!(error.to_string().contains("UTF-8"), "got: {error}");
    }
}
