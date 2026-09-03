# Agent Perception CLI — Design & Implementation Plan

**Branch**: `feature/agent-headless-perception`
**Status**: **COMPLETE** — T1–T7 all landed on the branch.
**Goal**: Give the headless CLI the primitives an external coding agent (Claude Code / Codex) needs to *see* media and *verify* its own edits: frame extraction, proxy renders, perception generation (shots/silence/audio/full analysis), and a deterministic QC `verify` tool. This is the shared foundation for both the in-app agent quality roadmap and the agent-native external surface.

## Status summary

| Task | Status | Commit |
|------|--------|--------|
| T1 — Unified FFmpeg resolution | DONE | `9abe13c8` |
| T2 — QC bring-up refactor | DONE | `3433d95b` |
| T3 — Frame extraction | DONE | `6100a72c` |
| T4 — Proxy render | DONE | `310b86c9` |
| T5 — Headless perception | DONE | `1bf586ba` |
| T6 — `verify` | DONE | `b6568eba` |
| T7 — Integration & polish | DONE | (this commit) |

### Accepted deviations from the plan

These were decided during implementation and are deliberate; do not "fix" them back.

- ~~**`ebur128` uses `framelog=quiet`, not `framelog=summary`** (T6).~~ **Reverted.** FFmpeg 4.4
  and 6.1 only accept `info`/`verbose` for `framelog`, so `quiet` failed option parsing and made
  `verify --file` exit 2 on every system FFmpeg. The option is now omitted entirely: per-frame
  lines carry the `[Parsed_ebur128` marker so the bounded filter buffer absorbs them, and the
  summary parser keys off labels, not position.
- **`caption.reading_rate` is warning-only** (T6). The plan reserved `error` for >25 CPS on
  Latin script, but reading rate is taste-adjacent and script detection is heuristic, so every
  finding stays a warning. `error` remains reserved for objectively broken output.
- **`analysis silence`'s write gate is stricter than `can_reuse_cached_silence_regions`** (T5).
  The plan reused the read gate for writes, but that gate accepts a *longer* `min-duration`
  (a reader may filter a cached set down). A run detecting at that duration would populate the
  cache with fewer regions than the contract promises, so writing requires both parameters to
  equal the defaults exactly; anything else is output-only with `"persisted": false` and a
  `reason` of `"non-default threshold"` or `"non-default min-duration"`.
- **Proxy is an `ExportSettings` constructor, not an enum variant** (T4). `--proxy` is an alias
  that selects the `proxy_480p` preset rather than a new render-mode variant, so the existing
  preset plumbing and `plan_hash` behaviour are untouched. The constructor takes the sequence
  canvas: a fixed 854x480 frame pillarboxed every non-16:9 edit, so the frame is fitted to the
  canvas within a 480p budget (long edge ≤ 854, short edge ≤ 480).

- **`analysis silence` only persists into an existing audio profile** (T5). The regions live
  inside `bundle.audioProfile`, whose other fields are measurements; with no profile to merge
  into, the run is output-only with `"persisted": false` and a `reason` of
  `"no audio profile in bundle; run \`analysis audio\` first"`.

## Design principles

1. **Core once, three surfaces.** All logic lives in Tauri-free `src-tauri/src/core/*` (auto-exposed to CLI via `openreelio-core`'s glob re-export). CLI verbs are thin wrappers. The in-app agent and MCP server pick these up later at wrapper cost.
2. **Resurrect, don't duplicate.** `core/qc/` (engine + rules + violations, currently dead code), `ExportEngine::export_frame`, `VisualAnalyzer::generate_contact_sheet`, `AudioProfiler`, `ShotDetector`, `AnalysisJobRunner` all exist. This branch wires and completes them.
3. **stdout is one JSON object; progress/diagnostics go to stderr.** Existing CLI contract (see `caption.rs:715` comment). Long-running verbs stream NDJSON progress to stderr under `--progress`.
4. **Every new clap leaf gets a `help_json.rs` entry** — the parity test `build_schema_covers_all_clap_leaf_commands` enforces this.
5. **Integration tests skip cleanly without FFmpeg** (`if system_ffmpeg_path().is_none() { return; }` pattern).

## Task breakdown (sequential; one commit each unless noted)

### T1 — Unified FFmpeg resolution (`fix(core)` + `feat(api)`) — DONE (`9abe13c8`)

Problem: three divergent resolution paths; CLI never checks the managed install (PR #784), so in-app FFmpeg installs are invisible to every CLI verb; non-render CLI verbs never register paths at all and silently fall back to bare `ffmpeg`.

- Add to `core/ffmpeg/resolver.rs`:
  - `pub struct FFmpegResolveOptions { pub explicit_ffmpeg: Option<PathBuf>, pub explicit_ffprobe: Option<PathBuf>, pub resource_roots: Vec<PathBuf>, pub use_env: bool }` — `use_env` decides whether the `OPENREELIO_FFMPEG_PATH` / `OPENREELIO_FFPROBE_PATH` overrides participate; it defaults to `false` so a GUI process never inherits a stray variable, and the CLI sets it to `true` (`crates/openreelio-cli/src/ffmpeg_env.rs`).
  - `pub fn resolve_ffmpeg(&FFmpegResolveOptions) -> FFmpegResult<FFmpegInfo>` — order: explicit → `OPENREELIO_FFMPEG_PATH`/`OPENREELIO_FFPROBE_PATH` env → `resource_roots` via `detect_bundled_at_path` → `detect_managed_ffmpeg()` → `detect_dev_mode_binaries()` → `detect_system_ffmpeg()`. Validate candidates with `get_ffmpeg_version`.
  - `pub fn resolve_and_register(...)` — same + `set_resolved_paths`.
- GUI `state.rs detect_ffmpeg` delegates with `resource_roots = [resource_dir]` (bundled-resources-first order preserved; env override intentionally CLI-only — pass a flag or skip env in the GUI call).
- CLI: delete private `detect_cli_ffmpeg`; call `resolve_and_register` once in `commands::execute` for media-touching commands (render, frame, analysis, transcription, verify, asset import). Fix transcription's `PathBuf::from(&asset.uri)` → `asset.resolved_path(&project.path)` while touching it.
- New verb `ffmpeg info` → `{status, ffmpegPath, ffprobePath, version, source}` for agent self-diagnosis.
- Unit tests for resolution order; keep `dev_mode` visibility inside the module.

### T2 — QC bring-up refactor (`refactor(core)`) — DONE (`3433d95b`)

Per "Refactor Before Feature". `core/qc/` is dead code with three simulated rule bodies.

- Add `QCContext { fps: f64, canvas: Canvas, measurements: Option<RenderMeasurements> }` as 4th arg to `QCRule::check` (trait + 7 rules + engine + tests).
- Replace simulated bodies with real structural logic where possible now (BlackFrame → defer to measurements, mark `skipped` when `measurements: None`; AudioPeak → same; CaptionSafeArea → real structural check from `clip.caption_position`/`caption_style` JSON, defensively deserialized).
- `QCEngine::check`: record `errored_rules` in `QCReport` instead of log-and-continue masquerading as pass.
- No CLI exposure yet; module unit tests only.

### T3 — Frame extraction (`feat(api)`) — DONE (`6100a72c`)

`openreelio-cli frame extract --path P --out F [--asset ID --source-time T | --time T] [--sequence S] [--mode fast|composite] [--max-width N] [--format png|jpeg] [--grid CxR --between A B [--count N]]`

- Asset source-time: `FFmpegRunner::extract_frame` + scale filter. Fix its stale-output short-circuit (force overwrite).
- Timeline-time `--mode fast` (opt-in): `ExportEngine::export_frame`; extend `FrameExportSettings` with `width`/`height` (default max-width 1280 for VLM-friendly size). Document limitation: topmost video clip only, no effects/text/compositing; when `find_topmost_clip_at_time` returns None (e.g. title card), auto-fall back to composite mode.
- `--mode composite` (default): reuse a current preview-cache segment when one covers `t`, else render `[t, t + max(2/fps, 0.05)]` via `ExportSettings::preview_cache` → temp `.mov` → extract frame 0. (A windowed render's cost tracks the in-clip offset, not the timeline position; `normalize_output_time_range` rejects zero-length ranges.)
- `--grid`: sample N evenly over `[a,b]` into `%d.jpg` sequence dir → `VisualAnalyzer::generate_contact_sheet`; JSON returns `cells:[{index,row,col,timelineSec}]` for VLM cell→timecode mapping.
- Output: `{status, frames:[{index, timeSec, sourceTimeSec, clipId, assetId, path, width, height}], count}` (or `{sheet: {...}}` for grid).

### T4 — Proxy render (`feat(render)`) — DONE (`310b86c9`)

- `ExportSettings`: add `encoder_speed: Option<String>` threaded into quality args (check `plan_hash` includes it deliberately).
- New preset `proxy_480p` (480p-class frame fitted to the sequence canvas — short edge ≤480, long edge ≤854, so 854x480 for 16:9 and 480x854 for vertical — CRF 30, H264/AAC 96k, `ultrafast`) + expose `mp4_draft` in CLI `RENDER_PRESETS`.
- `render start --proxy` (alias for proxy_480p) + `--start/--end` args (ExportSettings already supports).
- `--progress`: pass `mpsc::Sender<ExportProgress>`, stream NDJSON to stderr. Add tokio `sync`+`signal` features to CLI Cargo.toml; wire Ctrl-C to the existing oneshot cancel.

### T5 — Headless perception (`feat(api)`) — DONE (`1bf586ba`)

- src-tauri visibility: promote `AnalysisJobRunner::save_bundle` + `asset_analysis_dir` to `pub`; or add public load-merge-save helpers (`merge_bundle_shots`, `merge_bundle_audio_profile`) — prefer merge helpers to prevent partial-bundle clobbering.
- `analysis shots [--threshold 0.3] [--min-shot-duration 0.5] [--timeout-sec 600]` → `ShotDetector`; **triple-write**: (1) sqlite `index.db` `shots` table via `save_to_db` with the 3-attempt SQLITE_BUSY retry (GUI markers read only this), (2) merge into `bundle.json`, (3) `AnnotationStore.set_shots` (provider Ffmpeg, config recorded; use asset's stored hash, tolerate empty).
- `analysis silence [--threshold-db -40] [--min-duration 0.5]` → `detect_silence_custom`. Persist into `bundle.audioProfile.silence_regions` **only when** `cleanup::can_reuse_cached_silence_regions(t,d)` holds; otherwise output-only with `"persisted": false, "reason": "non-default threshold"` (protects the GUI cleanup cache contract).
- `analysis audio` → full `AudioProfiler::analyze` (silence+loudness+BPM+VAD) → `bundle.audioProfile`.
- `analysis run [--shots|--audio|--segments|--transcript|--visual|--all]` → `analyze_full_with_metadata` with `local_only: true` forced; transcript off by default, fail fast with `transcription install` hint when the whisper model is missing; surface `bundle.errors`, non-zero exit only if every enabled sub-job failed. NDJSON progress on stderr.
- All media paths via `asset.resolved_path(&project.path)`.

### T6 — `verify` (`feat(core)` then `feat(api)`; may be two commits) — DONE (`b6568eba`)

- `core/qc/measure.rs`: `FFmpegRunner::run_filter_capture_stderr(input, filter_complex, maps, timeout)` (public, `tokio::time::timeout`, `configure_tokio_command`, pinned `-loglevel info`); refactor `AudioProfiler::run_ffmpeg_filter` onto it (closes the no-timeout gap everywhere). Single-pass invocation:
  `-filter_complex "[0:v]blackdetect=d=0.1:pic_th=0.98:pix_th=0.10,freezedetect=n=-60dB:d=2[v];[0:a]ebur128=peak=true:framelog=summary,silencedetect=n=-50dB:d=1.5,astats=metadata=0:measure_perchannel=none:measure_overall=Peak_level+Flat_factor[a]" -map "[v]" -map "[a]" -f null -`
  New parsers (pure fns + fixture tests): blackdetect ranges, freezedetect ranges, ebur128 Summary (`I:`, `LRA:`, True peak — degrade to sample peak if absent), astats peak/flat. Reuse `parse_silence_regions`. If `has_no_audio_indicator` → audio checks `skipped`, never `failed`. Assert ≥1 filter line seen, else check = `skipped` (guards against a future `-loglevel` regression silently passing everything).
- `core/qc/structural.rs` checks: `timeline.gap` (error; `find_gaps`, autofix `CloseGapCommand`), `clip.orphan` (<2/fps, warning), `clip.missing_asset` (critical), `audio.silent_clip` (warning), `caption.overlap` (error), `caption.reading_rate` (CPS from `clip.label` — **script-aware: default off/adjusted for CJK**; warn >20, error >25 Latin only), `caption.out_of_bounds` (error), `caption.safe_area` (structural from position JSON, warning), `shot.length_stats` (info, always emits metrics).
- Cross-reference: rendered black ranges overlapping structural gaps ⇒ error; non-overlapping ⇒ info (title cards/fades are legitimate).
- `crates/openreelio-cli/src/commands/verify.rs`: `verify --path P [--sequence S] [--file RENDER] [--structural-only] [--checks a,b] [--skip a,b] [--target-lufs=-14] [--max-true-peak=-1] [--fail-on error] [--timeout-sec 600]` (the two negative-valued options require the `=` form; the space form is parsed as a flag). No `--file` ⇒ structural only. Exit codes: 0 ran+passed threshold, 1 threshold breached, 2 tool error. Output schema mirrors `build_diagnostics` top-level (`status/warnings/errors`) plus `checks[]`, `measurements{}`, per-check `timeRanges`, `suggestedFix` (EditScript) so violations stay agent-actionable. Keep taste-adjacent checks at warning/info; `error` reserved for objectively broken output.

### T7 — Integration & polish — DONE

- Extend `integration.rs` e2e: perceive (shots+silence) → edit → proxy render → frame extract → verify (structural + rendered) in one flow; plus targeted tests per verb.
- help-json entries for every new leaf; update `docs/COMMAND_REFERENCE.md` CLI tree in CLAUDE.md if needed.
- Workspace-wide `cargo fmt --check`, `cargo clippy -D warnings` (gui lib AND cli AND core), full `cargo test`, `npm run type-check` (bindings untouched but verify).

Outcome:

- `test_agent_perception_loop_end_to_end` drives the whole loop through the real binary
  (create → import → `analysis shots` → `analysis silence` → insert + shot-informed split →
  `render start --proxy --progress` → `frame extract --time` → `frame extract --grid` →
  `verify --file`), asserting only on CLI-observable JSON. Runs in ~3 s; skips without FFmpeg.
- The loop needs a `timeline trim` step before the split: `asset import` does not probe media
  duration, so the placed clip carries the default length and perception's `totalDurationSec`
  is what tells the agent how long the media actually is.
- `docs/COMMAND_REFERENCE.md` documents edit Commands and analysis IPC only — no CLI verb tree,
  so it was left untouched. The CLI tree in `CLAUDE.md` carries the new verbs.

## Known risks (from investigation — do not rediscover)

- Resolution must be registered **before** constructing `AnalysisJobRunner`/`ThumbnailService`/`AudioProfiler` (they read resolver globals at construction/use).
- `plan_hash` sensitivity when adding `encoder_speed` — decide cache invalidation deliberately.
- `ShotDetector` hard limits: 20k cuts (`ResourceExhausted`), 600s timeout — surface `--timeout-sec` and guidance in errors.
- Concurrent GUI+CLI `index.db` writes → SQLITE_BUSY retry loop required.
- `Commands` enum carries `#[allow(clippy::large_enum_variant)]` — keep args in structs.
- Windows: every spawn through `configure_tokio_command`; no `kill_on_drop` today — wire cancel to signal handler for long renders.
