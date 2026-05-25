# Render Contract Hardening Plan

## Current Result

The immediate render-contract guardrails are implemented:

- Rust effect capabilities define preview/export/cache support.
- Final export validation blocks missing effects, unsupported effects, and keyframed effects that would export as static midpoint samples.
- Preview cache uses preview export settings and the same export validation.
- `TimelineClock` centralizes rational frame/time conversion for render-facing checks.
- `RenderGraph` now carries graph version, duration frames, and per-layer timeline/source frame spans.
- `RenderPlan` is built only from `RenderGraph`, assets, effects, and settings.
- Export, range export, batch render, audio export, and preview cache now run `RenderPlan` shadow validation before starting work.
- GUI export, range export, batch export items, audio export, preview cache segments, worker render jobs, and CLI render now route execution through `RenderGraph -> RenderPlan -> FfmpegInvocation`.
- `ffmpeg_plan.rs` now owns the plan-aware FFmpeg arg/filter builder boundary. During the parity migration it still consumes the legacy sequence payload, but `export.rs` no longer contains the complex filter construction body.
- `FfmpegInvocation` wraps executable FFmpeg arguments before process execution, and `executor.rs` owns FFmpeg spawning, stderr draining, progress parsing, cancellation, simple output runs, and terminal result collection.
- Executor completion progress is now emitted only after the child process exits successfully, so failed FFmpeg runs cannot report a terminal "complete" progress update.
- A typed `render-lifecycle` event now correlates export, batch item, audio export, and preview cache jobs by job ID and plan hash.
- Preview cache segment fingerprints now derive from per-segment `RenderPlan` hashes, so asset, effect, graph layer payload, source range, and render setting changes invalidate cached segments through the same planning boundary used by export.
- Export validation warns when clip render spans are not aligned to sequence frame boundaries.
- Effects Browser loads backend-provided capability data and shows support badges so users can see whether an effect is full, export-only, or setup-only.
- Proxy and timeline preview active-layer selection now prefer graph-derived layer utilities.

Focused Rust tests, full `core::render::export::tests`, focused TypeScript tests, and TypeScript type checking pass.

## Current Risks Still Present

### RenderGraph Is Not Yet the Sole FFmpeg Construction Input

`RenderPlan` is now built and validated on export/cache entry points, and FFmpeg construction is behind `ffmpeg_plan.rs`. The builder still consumes the legacy sequence payload internally until a pure graph/plan implementation reaches snapshot parity. This is now isolated structural debt instead of being mixed into `ExportEngine`.

### Frame Alignment Is Warning-Only

Existing projects still store seconds. Frame boundary issues are visible now, but they should not become blocking until command boundaries normalize clip placement and source ranges.

### `export.rs` Is Still Too Broad

The file still mixes validation, timeline helper utilities, and text rendering helpers. FFmpeg process execution is centralized in `executor.rs`, and complex FFmpeg filter construction is behind `ffmpeg_plan.rs`; the next large step is converting that builder from legacy sequence traversal to pure `RenderGraph`/`RenderPlan` inputs.

### Preview Migration Needs Final Parity Tests

Proxy and timeline preview active-layer selection now use graph utilities first, but parity smoke tests still need to cover hidden tracks, muted tracks, text-over-video, and fractional fps as end-to-end user flows.

## Final Target Pipeline

```text
Command log / ProjectState
        |
        v
RenderGraph
        |
        v
RenderPlan
        |
        +--> Preview adapter
        +--> Preview cache segment planner
        +--> FFmpeg invocation builder
        +--> Future GPU/software renderer
```

After the migration, no preview/cache/export path should independently reinterpret timeline clips below the graph boundary.

## Implementation Phases

### Phase 1: Freeze Contract Behavior

- Add graph snapshot tests for media, gaps, text overlays, captions, audio companions, and fractional fps.
- Add validation tests for unsupported/setup-only effects and keyframed effect rejection.
- Add tests for graph-derived active layer selection before changing preview components.
- Add cache lifecycle tests for validation failure, cancellation, and partial segment failure.

### Phase 2: Share Capability Data

- Expose backend effect capabilities through generated bindings or IPC. Done.
- Replace `src/utils/effectCapabilities.ts` hardcoded lists with backend-provided data. Done.
- Surface export-blocking warnings in inspector/export dialog.
- Let AI tooling report unsupported effect choices before applying edit commands.

### Phase 3: Add RenderPlan

- Add `src-tauri/src/core/render/plan.rs`. Done.
- Build `RenderPlan` only from `RenderGraph`, assets, effects, and settings. Done.
- Include frame spans, second spans, source identity, layer order, capability status, and render hash inputs. Done.
- Run in shadow mode against the current export builder until parity is proven. In progress: entry points now shadow-validate.

### Phase 4: Extract Pure FFmpeg Builder

- Add `src-tauri/src/core/render/ffmpeg_graph.rs`. Done.
- Define `FfmpegInvocation` as pure builder output. Done.
- Move FFmpeg arg/filter construction out of `export.rs`. Done.
- Keep legacy sequence export active behind the builder boundary until snapshot parity passes. Done.

### Phase 5: Separate Export Execution

- Add `src-tauri/src/core/render/executor.rs`. Done.
- Move process spawning, stderr draining, progress parsing, cancellation, and terminal result handling out of plan-aware sequence/audio export execution. Done.
- Keep `ExportEngine` as orchestration only for plan-aware sequence/audio export. Done.
- Move single-asset transcode execution behind the shared executor boundary. Done.
- Move frame export one-off process execution behind a simple-runner boundary. Done.

### Phase 6: Unify Cache and Job Lifecycle

- Define one job state model for export and preview cache. Done.
- Emit typed lifecycle events for queued, running, completed, failed, cancelled, and already-cached jobs. Done.
- Add explicit validating, planning, and completed-with-errors states after executor separation.
- Make cache segment hashes derive from `RenderPlan`. Done.
- Treat per-segment cache failures as explicit failed states. Done.

### Phase 7: Migrate Export Entry Points

- Route `start_render`, range render, batch render, audio export, and preview cache through `RenderGraph -> RenderPlan` shadow validation. Done.
- Route GUI FFmpeg execution through `RenderGraph -> RenderPlan -> FfmpegInvocation`. Done.
- Route worker render and CLI render through the same path. Done.
- Remove final export direct timeline traversal after parity tests pass.

### Phase 8: Migrate Preview

- Add graph layer utilities in TypeScript. Done.
- Move proxy preview active clip/text overlay selection to graph-derived layers. Done.
- Move canvas preview active clip selection to graph-derived layers. Done.
- Add parity smoke tests for text over video, hidden tracks, muted tracks, and fractional fps.

### Phase 9: Cleanup and Documentation

- Update architecture docs so render graph documentation matches implementation.
- Update stale work-plan claims about keyframe export support.
- Document unsupported effect behavior and export validation policy.
- Remove duplicate legacy FFmpeg builder helpers.

## Definition of Done

- No final export path builds executable render work directly from `Sequence`.
- No preview component independently computes active render layers from `Sequence`.
- No unsupported effect silently passes through final export.
- No cache segment is generated outside the shared `RenderGraph -> RenderPlan` validation/fingerprint boundary.
- All renderer-facing time spans have frame-based representation.
- Rust render tests, TypeScript preview/effects tests, and type checking pass.

The full OpenSpec-style artifacts are also available under `openspec/changes/render-contract-hardening/`, but that directory is locally ignored by Git in this workspace.
