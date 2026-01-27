# OpenReelio Technical Assessment Report

Date: 2026-01-27
Focus: Tauri runtime behavior, IPC correctness, cross-platform filesystem safety, and update pipeline readiness

---

## Architecture Notes (Relevant to Assessment)

OpenReelio is a Tauri 2 desktop app:
- Frontend (WebView): React + TypeScript
- Backend: Rust core engine with IPC commands (`#[tauri::command]`)
- Media pipeline: FFmpeg (bundled sidecar or system installation)

Security posture depends heavily on:
- IPC argument validation (especially filesystem paths)
- Asset protocol allowlisting
- Capability minimization (principle of least privilege)

---

## Key Assessment Areas

### A) Filesystem Exposure (Asset Protocol)

Risk:
- `convertFileSrc` + broad `assetProtocol.scope` can expose arbitrary local files if the renderer is compromised.

Controls implemented:
- Minimal static scope in `src-tauri/tauri.conf.json`.
- Runtime allowlisting for:
  - per-project `.openreelio` directories
  - imported asset source files
- Explicit forbid of WebView local data directory as defense-in-depth.

### B) IPC Hardening (Input/Output Path Validation)

Risk:
- IPC commands that accept `outputPath` are effectively a file-write primitive.

Controls implemented:
- `validate_local_input_path` rejects URLs and requires local absolute paths.
- `validate_scoped_output_path` restricts output paths to approved roots:
  - app cache directory
  - project `.openreelio` directory (compatibility)

### C) Capabilities and Plugin Surface

Risk:
- Enabling unused plugins expands the attack surface and increases permission drift.

Controls implemented:
- Removed unused shell/fs plugins and their capability declarations.

### D) Updater Pipeline Readiness

Risk:
- CI can produce updater manifests, but the app must be configured with endpoints + pubkey to actually verify/install updates.

Controls implemented:
- Added `plugins.updater` configuration.
- CI sets `OPENREELIO_ENABLE_UPDATER=1` for release builds to enable the plugin.

### E) FFmpeg Bundling / Build Determinism

Risk:
- Implicit build-time downloads can cause non-deterministic builds and supply-chain risk.

Controls implemented:
- Build-time FFmpeg download is now explicit opt-in (`OPENREELIO_DOWNLOAD_FFMPEG=1`).

Residual risk:
- Download authenticity is not cryptographically pinned to a known checksum.

---

## Recent Changes (2026-01-27)

### 1) IPC payload DoS hardening (command execution)

Change:
- `src-tauri/src/ipc/payloads.rs`: strict `commandType` validation (empty/control chars/length) and a 512 KiB payload size cap.

Why:
- `execute_command` is a trust boundary (UI/AI/plugins). Without bounds, a malicious or buggy caller can trigger excessive allocations and CPU time during JSON deserialization.

Verification:
- Unit tests in `src-tauri/src/ipc/payloads.rs` cover oversized payload rejection and invalid `commandType` strings.

### 2) Async runtime safety for IO-heavy IPC commands

Change:
- `src-tauri/src/ipc/commands_legacy.rs`: `create_project`, `open_project`, and `save_project` move filesystem-heavy work into `tokio::task::spawn_blocking`.

Why:
- Tauri commands run on async executors; blocking filesystem operations on runtime threads can stall unrelated IPC calls and degrade UX under slow disks/AV scanning.

Verification:
- Rust unit tests remain green; runtime paths are exercised by the app and additional logging was added to `save_project` for timing visibility.

### 3) Cross-layer type stability via tauri-specta bindings

Change:
- Added a developer utility binary `src-tauri/src/bin/export_bindings.rs` and `src/bindings.ts` generation.
- Annotated all IPC entry points with `#[specta::specta]` to enable signature/type export.

Why:
- Prevent silent drift between Rust DTOs and TypeScript usage by generating bindings from the source of truth.

Notes:
- The exporter is configured with `BigIntExportBehavior::Number` to match current JSON serialization; values above JS safe integer range can lose precision (see Risks below).

---

## Recommendations (Next Hardening Iteration)

1) Pin FFmpeg artifacts
- Use versioned URLs + SHA-256 stored in repo, or host signed artifacts under the project’s release infrastructure.

2) Scope lifecycle control
- Add a mechanism to reset/rebuild asset protocol scope on project switch to avoid scope accumulation.

3) Add Tauri runtime E2E coverage
- Extend CI to run a minimal smoke test in a real Tauri runtime (not only WebView/Vite mode) for:
  - asset protocol allowlisting behavior
  - update check DTO correctness

## Risks / Limitations (Post-Fix)

1) `u64`/`i64` values across JSON
- Some DTO fields (e.g. `fileSize`) use Rust `u64` which serializes as JSON number.
- JavaScript numbers can lose precision above `2^53 - 1`.
- Mitigation options: migrate wire format to string for large integers, or clamp/document invariants (file sizes remain well below the safe range for expected workloads).

