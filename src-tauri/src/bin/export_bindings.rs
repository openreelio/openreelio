//! TypeScript bindings exporter (tauri-specta).
//!
//! This binary generates `src/bindings.ts` from the Rust command/type surface.
//! It is intentionally kept out of the main app runtime path.

use std::fs;
use std::path::PathBuf;

use specta_typescript::{BigIntExportBehavior, Typescript};
use tauri_specta::Builder;

fn normalize_bindings(path: &std::path::Path) {
    let Ok(contents) = fs::read_to_string(path) else {
        return;
    };

    // tauri-specta's generated command wrappers currently re-throw `Error` instances, which
    // breaks the `Promise<Result<...>>` contract. Normalize the wrappers to always return a
    // `{ status: "error" }` payload.
    //
    // Note: use a simple textual normalization to avoid introducing dependencies in this binary.
    let normalized = contents
        .replace(
            "if(e instanceof Error) throw e;\r\n    else return { status: \"error\", error: e  as any };\r\n",
            "return { status: \"error\", error: e  as any };\r\n",
        )
        .replace(
            "if(e instanceof Error) throw e;\n    else return { status: \"error\", error: e  as any };\n",
            "return { status: \"error\", error: e  as any };\n",
        );
    let normalized = normalize_unstable_type_line_spacing(&normalized);

    if normalized != contents {
        let _ = fs::write(path, normalized);
    }
}

fn normalize_unstable_type_line_spacing(input: &str) -> String {
    let mut in_app_cleanup_doc = false;
    let mut in_get_render_graph_doc = false;
    let mut in_agent_plan_approval_proof = false;
    let mut in_batch_render_item = false;
    let mut in_cancel_render_result = false;
    let mut in_render_cache_job_result = false;
    let mut in_render_graph = false;
    let mut in_import_stock_media_doc = false;
    let mut in_text_style = false;
    let mut in_stock_media_import_result = false;
    let mut normalized = input
        .lines()
        .map(|line| {
            // Keep the generated output stable for newly documented union and DTO lines without
            // rewriting the legacy trailing-space style across the entire bindings file.
            if line == " * Performs best-effort cleanup when the user closes the window." {
                in_app_cleanup_doc = true;
            }
            if line == " * Returns the renderer-agnostic graph for a sequence." {
                in_get_render_graph_doc = true;
            }
            if line.starts_with("export type AgentPlanApprovalProof =") {
                in_agent_plan_approval_proof = true;
            }
            if line.starts_with("export type BatchRenderItemDto =") {
                in_batch_render_item = true;
            }
            if line.starts_with("export type CancelRenderResult =") {
                in_cancel_render_result = true;
            }
            if line.starts_with("export type RenderCacheJobResult =") {
                in_render_cache_job_result = true;
            }
            if line.starts_with("export type RenderGraph =") {
                in_render_graph = true;
            }
            if line
                == " * Download a stock media candidate into the project and import it as an asset."
            {
                in_import_stock_media_doc = true;
            }
            if line.starts_with("export type TextStyle =") {
                in_text_style = true;
            }
            if line.starts_with("export type StockMediaImportResult =") {
                in_stock_media_import_result = true;
            }

            let normalized_line = if in_batch_render_item && line == "outPoint: number | null; " {
                "outPoint: number | null;"
            } else if (in_app_cleanup_doc || in_get_render_graph_doc || in_import_stock_media_doc)
                && line == " * "
            {
                " *"
            } else if line == "approvalProof?: AgentPlanApprovalProof | null; " {
                "approvalProof?: AgentPlanApprovalProof | null;"
            } else if in_agent_plan_approval_proof {
                line.trim_end()
            } else if in_cancel_render_result && line == "jobId: string; " {
                "jobId: string;"
            } else if in_render_cache_job_result && line == "export type RenderCacheJobResult = { "
            {
                "export type RenderCacheJobResult = {"
            } else if in_render_cache_job_result && line == "jobId: string; " {
                "jobId: string;"
            } else if in_render_graph && line.starts_with("export type RenderGraph =") {
                line.trim_end()
            } else if in_render_graph && line == "visualLayers: VisualRenderLayer[]; " {
                "visualLayers: VisualRenderLayer[];"
            } else if in_text_style && line == "fontWeight?: number; " {
                "fontWeight?: number;"
            } else if in_stock_media_import_result {
                line.trim_end()
            } else {
                line
            };

            if in_app_cleanup_doc && line.starts_with("async appCleanup") {
                in_app_cleanup_doc = false;
            }
            if in_get_render_graph_doc && line.starts_with("async getSequenceRenderGraph") {
                in_get_render_graph_doc = false;
            }
            if in_agent_plan_approval_proof && line.starts_with("requiredScope?:") {
                in_agent_plan_approval_proof = false;
            }
            if in_batch_render_item && line.starts_with("settings?: VideoExportRequest") {
                in_batch_render_item = false;
            }
            if in_cancel_render_result && line.starts_with("cancelled: boolean") {
                in_cancel_render_result = false;
            }
            if in_render_cache_job_result && line.starts_with("status: RenderCacheJobStatus") {
                in_render_cache_job_result = false;
            }
            if in_render_graph && line.starts_with("audioLayers: AudioRenderLayer") {
                in_render_graph = false;
            }
            if in_import_stock_media_doc && line.starts_with("async importStockMediaAsset") {
                in_import_stock_media_doc = false;
            }
            if in_text_style && line.starts_with("backgroundColor?:") {
                in_text_style = false;
            }
            if in_stock_media_import_result && line.starts_with("licenseSnapshotPath:") {
                in_stock_media_import_result = false;
            }

            match line {
                "export type ContainerFormat = " => "export type ContainerFormat =",
                "\"mp4\" | " => "\"mp4\" |",
                "\"mov\" | " => "\"mov\" |",
                "export type ExportQualityTier = " => "export type ExportQualityTier =",
                "\"draft\" | " => "\"draft\" |",
                "\"standard\" | " => "\"standard\" |",
                "\"high\" | " => "\"high\" |",
                "\"master\" | " => "\"master\" |",
                _ => normalized_line,
            }
        })
        .collect::<Vec<_>>()
        .join("\n");

    if input.ends_with('\n') {
        normalized.push('\n');
    }

    normalized
}

fn main() {
    // Collect all commands exposed to the frontend.
    let mut builder = Builder::<tauri::Wry>::new().commands(openreelio_lib::collect_commands!());

    // Ensure event payloads are also available to the frontend type system even
    // though we currently emit them via stringly-typed event names.
    builder = builder
        .typ::<openreelio_lib::ipc::StateChangedEvent>()
        .typ::<openreelio_lib::ipc::ProjectOpenedEvent>()
        .typ::<openreelio_lib::ipc::ProjectSavedEvent>()
        .typ::<openreelio_lib::ipc::AssetEvent>()
        .typ::<openreelio_lib::ipc::ClipEvent>()
        .typ::<openreelio_lib::ipc::TrackEvent>()
        .typ::<openreelio_lib::ipc::HistoryChangedEvent>()
        .typ::<openreelio_lib::ipc::JobProgressEvent>()
        .typ::<openreelio_lib::ipc::JobCompletedEvent>()
        .typ::<openreelio_lib::ipc::JobFailedEvent>()
        .typ::<openreelio_lib::ipc::RenderLifecycleEvent>()
        .typ::<openreelio_lib::core::analysis::dtw::DtwResult>();

    let out_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("src")
        .join("bindings.ts");

    builder
        .export(
            Typescript::new()
                .header(
                    "/* eslint-disable @typescript-eslint/ban-ts-comment, @typescript-eslint/no-unused-vars, @typescript-eslint/no-explicit-any */\n// @ts-nocheck\n",
                )
                .bigint(BigIntExportBehavior::Number),
            &out_path,
        )
        .unwrap_or_else(|e| panic!("Failed to export TypeScript bindings: {e}"));

    normalize_bindings(&out_path);

    println!("Exported TypeScript bindings to {}", out_path.display());
}
