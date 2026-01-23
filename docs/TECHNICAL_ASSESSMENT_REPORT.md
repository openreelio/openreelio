# OpenReelio Technical Assessment Report

Date: 2026-01-23
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

## Recommendations (Next Hardening Iteration)

1) Pin FFmpeg artifacts
- Use versioned URLs + SHA-256 stored in repo, or host signed artifacts under the project’s release infrastructure.

2) Scope lifecycle control
- Add a mechanism to reset/rebuild asset protocol scope on project switch to avoid scope accumulation.

3) Add Tauri runtime E2E coverage
- Extend CI to run a minimal smoke test in a real Tauri runtime (not only WebView/Vite mode) for:
  - asset protocol allowlisting behavior
  - update check DTO correctness

