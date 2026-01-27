//! TypeScript bindings exporter (tauri-specta).
//!
//! This binary generates `src/bindings.ts` from the Rust command/type surface.
//! It is intentionally kept out of the main app runtime path.

use std::path::PathBuf;

use specta_typescript::{BigIntExportBehavior, Typescript};
use tauri_specta::Builder;

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
        .typ::<openreelio_lib::ipc::JobFailedEvent>();

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

    println!("Exported TypeScript bindings to {}", out_path.display());
}
