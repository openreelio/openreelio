# Professional Editor Implementation Sequence

> Created: 2026-06-07
> Purpose: Convert OpenReelio from a broad prototype surface into a cohesive professional NLE.

## Executive Direction

OpenReelio already has many professional subsystems: event-sourced commands, timeline editing,
preview, export, effects, captions, transcription, render cache, audio mixer foundations,
color panels, scopes, masks, tracking, multicam prototypes, interchange, and agent tools.

The next phase is not about adding random features. It is about finishing vertical workflows:
every feature must connect UI, command validation, undo/redo, render/export behavior, agent tools,
tests, and user feedback.

## Product Baseline

The professional editor baseline is drawn from current NLE expectations across Premiere Pro,
DaVinci Resolve, and Final Cut Pro:

- Timeline assembly: insert, overwrite, append, lift, extract, ripple/roll/slip/slide, trim mode,
  snapping, linked selection, grouping, nesting, adjustment layers, markers, gaps, and track control.
- Media workflow: bins/folders, search, metadata, missing media, relink, proxy/optimized media,
  thumbnails, waveforms, and workspace discovery.
- Preview workflow: source/program monitor, JKL shuttle, loop playback, cache/proxy indicators,
  full-screen review, safe overlays, and reliable audio sync.
- Effects and motion: fixed transform/opacity/time remap, transitions, keyframes, masks, tracking,
  stabilization, speed ramps, mosaic/privacy blur, and reusable presets.
- Audio post: clip gain, fades, rubber bands, mixer, meters, pan, EQ/dynamics/noise reduction,
  ducking, loudness, audio-only export, and eventual routing/buses.
- Color and finishing: color wheels, curves, LUTs, scopes, qualifiers, power windows, color match,
  HDR/color management, export presets, QC, and interchange.
- Advanced editorial: multicam, synchronized clips, compound clips, text-based editing,
  caption translation/export, batch export, and style/reference comparison.
- Agent workflow: all AI edits must produce command plans, never direct state writes.

## Sequencing Principles

1. Finish the spine before ornamentation: timeline, preview, export, media, and undo must stay solid.
2. Prefer vertical slices: a feature is not done until UI, command, render, agent, and tests agree.
3. Reuse existing primitives first: avoid creating duplicate state for features already modeled.
4. Keep expensive work off the UI thread: analysis, proxying, render cache, and tracking are jobs.
5. Make capability status honest: preview-only, export-only, and unsupported states must be visible.
6. Every shipped edit path must be reversible through the command log.

## Phase 1 — Timeline Workbench Hardening

Goal: Make the main timeline feel like a professional editor, not a collection of commands.

Tasks:

- [x] Track header drag reorder for same-kind tracks using existing `ReorderTracks`.
- [x] Track targeting and patching: explicit video/audio/caption target buttons for insert/overwrite.
- [x] Trim mode panel: ripple, roll, slip, slide, rate stretch, razor, selection, hand/pan.
- [x] Keyboard parity pass: JKL, I/O, insert, overwrite, lift, extract, ripple delete, add edit,
      next/previous edit, next/previous marker.
- [x] Multi-clip operations: apply transitions, enable/disable, group/ungroup, link/unlink,
      copy/paste attributes, and remove attributes consistently across selected clips.
  - [x] Command palette and keyboard actions for selected clip enable, link/unlink,
        group/ungroup, paste attributes, and paste effects.
  - [x] Default transition command path for selected visual clips using `AddEffect`.
  - [x] Transition picker UX for selected clips and transition zones.
  - [x] Multi-clip remove attributes UX that resolves clip-local effect IDs safely.
- [x] Timeline index: searchable clips, markers, captions, effects, missing assets, and disabled
      clips.

Definition of done:

- All controls dispatch event-sourced commands.
- Undo history names are readable.
- Agent tool docs reflect the same workflows.
- Critical interactions have integration tests.

## Phase 2 — Media, Bins, Relink, And Proxy Workflow

Goal: Make source media management robust enough for real projects.

Tasks:

- [x] Bin/folder UI over workspace and project asset models.
- [x] Asset metadata inspector: codec, resolution, fps, duration, audio channels, proxy status.
- [x] Missing media detection, relink, replace footage, reveal in workspace.
- Proxy/optimized media queue management with progress, cancel, regenerate, and use-original toggle.
  - [x] Proxy queue visibility in the media explorer with job progress, cancel, regenerate, and
        use-original controls.
  - [x] Bulk proxy generation entry point for all eligible media in the proxy queue.
- [x] Thumbnail/waveform cache status and invalidation controls.
  - [x] Asset inspector media-cache status for thumbnails, waveform peaks, audio previews, and
        frontend waveform image cache entries.
  - [x] Inspector controls for thumbnail regeneration, waveform generation, audio preview
        generation, and frontend waveform cache clearing.
- [x] Bulk import and bulk proxy generation.
  - [x] Multi-file picker import and external drop import use the workspace batch-import backend.
  - [x] Explorer shows bulk import progress and success/partial-failure/error summaries.
  - [x] Bulk proxy generation entry point from the proxy queue.

Definition of done:

- Media operations are safe with missing files and hardcoded paths are avoided.
- Proxy state is visible in media library, timeline, and preview.
- Bulk operations run through jobs.

## Phase 3 — Preview And Source/Program Monitor Completion

Goal: Make review and three-point editing fast and predictable.

Tasks:

- [x] Source monitor clip loading, in/out marks, insert/overwrite to targeted tracks.
  - [x] Explorer asset selection loads previewable media into the source monitor.
  - [x] Source monitor In/Out marking, source-range drag payloads, and JKL transport are covered.
  - [x] Source monitor insert/overwrite buttons and comma/period shortcuts route through the
        existing atomic 3-point edit command path.
- [x] Program monitor overlays: safe margins, guides, transform handles, mask handles, tracking points.
  - [x] Program monitor safe margins and composition-guide toggles shared by proxy/canvas preview.
  - [x] Transform handle overlay is active in proxy and canvas preview for single selected clips.
  - [x] Selected `object_tracking` effect data is visualized as a Program Monitor tracking path.
  - [x] Selected clip effect masks render as Program Monitor mask overlays with shape handles.
- [x] Playback quality menu: full, half, quarter, proxy, render-cache preferred.
  - [x] Program Monitor quality state supports full, half, and quarter canvas render resolution.
  - [x] Program Monitor media preference supports auto, proxy, and render-cache-preferred paths.
  - [x] Quality menu is available from the Program Monitor overlay controls.
- [x] Loop range, play around edit, match frame, reveal source clip.
  - [x] Playback store supports loop ranges and one-shot play ranges.
  - [x] RAF playback loop respects loop range and play-around range endings.
  - [x] Match frame selects the source asset and reveals the Source Monitor.
  - [x] Reveal Source Clip selects the timeline clip's source asset and opens Explorer/Source Monitor.
- [x] Audio sync drift diagnostics and user-visible degraded preview warnings.
  - [x] Canvas preview reports video timeline time to the playback controller.
  - [x] Playback controller emits sync events for moderate and critical drift.
  - [x] Program Monitor shows a visible audio sync drift warning overlay.

Definition of done:

- Source-to-timeline mapping respects speed, reverse, freeze, and time remap.
- Preview controls do not block the UI thread.

## Phase 4 — Fixed Clip Controls: Transform, Opacity, Speed, Zoom

Goal: Treat transform/opacity/time remap as first-class fixed clip controls.

Tasks:

- [x] Video/image transform inspector with position, scale, rotation, anchor, fit/fill/reset.
  - [x] Inspector selection carries clip transform, opacity, source dimensions, and canvas dimensions.
  - [x] Position, scale, rotation, and anchor controls commit through `SetClipTransform`.
  - [x] Fit, fill, and reset presets are available from the clip inspector.
- [x] Preview overlay transform editing for normal video/image clips, not only text.
  - [x] Proxy preview uses the shared `TransformOverlay`.
  - [x] Canvas preview fallback also renders `TransformOverlay` for selected normal clips.
  - [x] Overlay commits one `SetClipTransform` command on mouseup.
- [x] Zoom in/out and Ken Burns presets as editable transform keyframes.
  - [x] Clip model stores `motionKeyframes` as normalized transform snapshots.
  - [x] `SetClipMotionKeyframes` commits motion presets through the command log.
  - [x] Clip inspector creates Zoom In, Zoom Out, and Ken Burns keyframes.
  - [x] Program preview evaluates motion keyframes for canvas, proxy, and transform overlay paths.
- [x] Opacity and blend controls in the clip inspector.
  - [x] Blend controls continue to use `SetClipBlendMode`.
  - [x] Clip opacity commits through undoable `SetClipOpacity`.
  - [x] Inspector opacity input uses editor-facing percent values and normalized command payloads.
- [x] Rate stretch, constant speed, reverse, freeze, and time-remap speed ramp editor.
  - [x] Existing rate-stretch timeline tool resolves stretched duration into `SetClipSpeed`.
  - [x] Clip inspector exposes constant 25%, 50%, 100%, 200%, and 400% speed presets.
  - [x] Reverse and freeze controls stay connected to `ReverseClip` and `CreateFreezeFrame`.
  - [x] Clip inspector creates and edits `SetTimeRemap` speed ramp keyframes.
  - [x] Agent command reference documents speed, reverse, freeze, and time-remap payloads.
- [x] Slow-motion interpolation mode: nearest, frame blend, motion-compensated export.
  - [x] Clip model stores `slowMotionInterpolation` with legacy `nearest` default.
  - [x] `SetClipSlowMotionInterpolation` persists interpolation mode through command log.
  - [x] Clip inspector exposes nearest, frame blend, and motion-compensated modes.
  - [x] Export filter uses `minterpolate` for frame blend and motion-compensated slow motion.
  - [x] Render cache fingerprints include interpolation mode.

Definition of done:

- Export and render graph evaluate the same transform/time model as the UI.
- Agent tools can apply these operations by name.

## Phase 5 — Effects, Transitions, Mosaic, And Motion Presets

Goal: Make practical effects discoverable and reliable.

Tasks:

- [x] Built-in visual preset library: clean-up, look, motion feel, privacy, social.
  - [x] Presets expand into ordinary `AddEffect` commands with editable parameters.
  - [x] Effects workspace opens the Effects browser as a first-class dock panel.
  - [x] Preset data is covered by tests that reject unsupported/no-op visual effects.
- [x] Privacy mosaic and region blur compound workflows using masks.
  - [x] Privacy presets can create `pixelate`/`gaussian_blur` effects with editable default masks.
  - [x] Blur and pixelate effects expose Power Window controls without showing color-only tools.
- [x] Multi-clip transition apply/trim/delete.
  - [x] Selected clips and transition zones apply transitions through ordinary `AddEffect`.
  - [x] Existing transition zones show effect type/duration and delete through `RemoveEffect`.
  - [x] Existing transition zones reopen the picker with current duration and update via `UpdateEffect`.
- [x] Effect capability audit: every effect shown in the browser must be honestly labeled.
  - [x] Browser effect list is tested against the command schema and duplicate detection.
  - [x] Missing runtime capability data falls back to visible `Setup only` badges.
- [x] Effect preset save/load/apply hardening.
  - [x] Saved presets are listed, searched, loaded, applied, and deleted from the Effects browser.
  - [x] Saved preset application uses ordinary `AddEffect` commands and preserves keyframes.
- [x] Tracking-assisted mask workflows for region blur and object highlight.
  - [x] `AddMask`/`UpdateMask` accept mask keyframes and `trackingSourceId`.
  - [x] Motion tracking utilities convert tracked points into animated rectangle/ellipse masks.
  - [x] Agent mask tools can carry tracking-assisted mask animation payloads.

Definition of done:

- Presets expand to ordinary editable effects.
- Unsupported preview/export paths are never silent no-ops.

## Phase 6 — Audio Post Foundation

Goal: Make audio editing viable for dialogue-driven content.

Tasks:

- [x] Mixer integration with timeline tracks and clip audio settings.
  - [x] Mixer track faders commit `SetTrackVolume` through the command log.
  - [x] Agent `adjust_volume` uses track faders when `clipId` is omitted and clip gain when present.
  - [x] Mixer pan and selected-clip audio controls share an explicit persistence policy.
        Single selected clip pan/gain/fades persist through `SetClipAudio`; unselected track pan
        remains session-local until a track-pan model is introduced.
- [x] Audio rubber bands for gain and fades.
  - [x] Volume keyframe rubber bands stay available for automated clip gain.
  - [x] Fade handles remain editable while gain automation is visible.
- [x] EQ/compressor/noise reduction controls with export parity.
  - [x] EQ band width uses Q semantics in UI, Web Audio preview, and FFmpeg export.
  - [x] Compressor threshold uses dB semantics in UI/preview and converts to FFmpeg linear
        threshold at export.
  - [x] Gain effects export from the dB `gain` parameter instead of silently falling back to
        volume defaults.
  - [x] Noise reduction exposes `anlmdn`/`afftdn`/`arnndn` export parameters in the effect editor.
- [x] Loudness analysis and normalization.
  - [x] Existing audio analysis profile keeps loudness/peak data available for inspection.
  - [x] `loudness_normalize` UI params use backend/export names: `target_lufs`,
        `target_lra`, `target_tp`, and `print_format`.
  - [x] Agent `normalize_audio` uses LUFS semantics and adds the export-backed
        `loudness_normalize` effect.
- [x] Ducking UI over existing ducking backend.
  - [x] Mixer Auto-Duck button routes through `resolveAutoDuckTargets` and `useAudioDucking`.
  - [x] Ducking target resolution and backend refresh path are covered by tests.
  - [x] Mixer button state and success/failure user feedback are explicit.
- [x] Audio roles/tags groundwork for future buses.
  - [x] Clip `AudioSettings` stores optional `audioRole` and `audioTags`.
  - [x] `SetClipAudio` persists/undoes role and tag changes through the command log.
  - [x] Inspector audio controls expose role and tags for selected clips.

Definition of done:

- Preview and export audio processing match within documented limits.
- Meters show useful peak/RMS/LUFS state.

## Phase 7 — Captions, Text, And Transcript Editing

Goal: Make text-based editing and delivery captions production-grade.

Tasks:

- [x] Caption track multi-language management.
  - [x] Caption tracks store optional `captionLanguage` metadata in the project model.
  - [x] `SetCaptionTrackLanguage` persists and undoes caption track language changes.
  - [x] Timeline caption track headers expose language selection through the command log.
  - [x] Agent/CLI command schemas expose the same caption language command.
- [x] Caption import/export polish: SRT, VTT, style-safe exports.
  - [x] Export payloads are sorted, timing-validated, and stripped of unsafe inline style tags.
  - [x] Agent SRT/VTT import strips unsafe inline tags and preserves VTT speaker metadata.
  - [x] Agent and CLI caption import accept language metadata and connect it to caption tracks.
- [x] Transcript-driven ripple delete and selects workflows.
  - [x] Agent edit tool exposes transcript word lookup for evidence-based selection.
  - [x] Agent edit tool exposes transcript-range ripple delete through the existing IPC path.
  - [x] Transcript-range deletion requires explicit `evidenceText` before destructive edits.
- [x] Title templates, lower thirds, callouts, credits, and style presets.
  - [x] Text preset library includes production title, lower-third, callout, credit, brand, and
        creative templates with default text and recommended duration metadata.
  - [x] Add Text UI applies preset starter content, duration, category filtering, and command-log
        `AddTextClip` payloads without overwriting user-entered content.
  - [x] Agent text tools resolve the same preset IDs/aliases and preserve credit/brand template
        placement unless auto-placement is explicitly requested.
  - [x] CLI/help-json/MCP/Codex bridge references expose the same production text preset vocabulary.
- [x] Spellcheck/search/replace for captions and transcripts.
  - [x] Caption editor enables browser spellcheck and provides in-caption find, previous/next, replace
        current, and replace-all controls before saving through the existing caption command path.
  - [x] Transcript panel/search workflows expose find, previous/next, match selection, and
        correction-safe replacement preview without mutating cached transcript source data.

Definition of done:

- Text/caption operations remain editable and exportable.
- Agent workflows cite transcript evidence before destructive edits.

## Phase 8 — Color And Finishing

Goal: Move from color controls to a finishing workflow.

Tasks:

- [x] Color wheels, curves, temperature/tint, LUT, color match integration pass.
  - [x] Color wheels, curves, temperature/tint, and LUT route through dedicated finishing panels
        in the effect inspector.
  - [x] LUT editing exposes file selection, interpolation, intensity, clear, and reset controls.
  - [x] Curves frontend defaults use the backend/export-aligned JSON curve parameter names.
  - [x] Power windows and color match remain available for finishing color effects.
- [x] Scopes connected to current preview frame/render graph, not only demo data.
  - [x] Program Monitor canvas registers itself as the source frame for finishing tools.
  - [x] Color workspace exposes a dockable Scopes panel backed by live preview-frame analysis.
  - [x] Scopes display source status, frame dimensions, last analysis time, and manual refresh.
- [x] Qualifier plus power windows as a coherent secondary correction workflow.
  - [x] HSL Qualifier effects route through the dedicated qualifier panel in the effect inspector.
  - [x] Qualifier parameter names and defaults align with backend/export filter parameters.
  - [x] Qualifier value changes propagate through ordinary effect parameter updates.
  - [x] Power windows remain attached to the same effect for combined HSL plus spatial selection.
- [x] HDR settings and color management export validation.
  - [x] Structured video export requests carry sequence HDR mode, bit depth, MaxCLL, and MaxFALL.
  - [x] HDR sequence exports automatically use H.265-compatible request settings.
  - [x] Backend validation rejects HDR exports with incompatible codecs or insufficient bit depth.
  - [x] Export dialog tests cover HDR settings propagation into render requests.
- [x] QC checks for gamut, clipping, loudness, missing media, offline effects, and captions.
  - [x] Export validation blocks assets marked missing/offline even when a stale path still exists.
  - [x] HDR source to SDR export warns when no active tonemap is configured, covering gamut/clipping review.
  - [x] Audio gain QC warns when clip, track, and master gain can create loudness/clipping risk.
  - [x] Caption QC warns for empty text, sub-0.5s captions, and overlapping caption clips.
  - [x] Existing final-export validation remains the gate for missing effect references,
        unsupported offline effects, unsupported blend/composition states, and caption virtual assets.

Definition of done:

- Scopes and export validation are trusted finishing tools.
- Color changes can be copied, pasted, saved as presets, and applied by agent.

## Phase 9 — Multicam And Synchronized Clips

Goal: Support interview, podcast, and event workflows.

Tasks:

- Sync by waveform, timecode, in/out, or manual marker.
  - [x] Multicam sync planner creates groups from selected clip sources using waveform,
        timecode, in/out, marker, or manual timeline placement offsets.
  - [x] Sync planner calculates shared playable duration and warnings for non-overlapping sources.
  - [x] Editor UI command path for creating synchronized multicam groups from selected clips.
  - [x] Timeline toolbar and command palette expose synchronized multicam creation.
  - [x] Program Monitor shows the active multicam angle viewer after group creation.
- Multicam clip creation and angle metadata.
  - [x] Angle viewer displays label, audio availability, and sync offset metadata for created groups.
  - [ ] Event-sourced multicam clip creation model.
- Angle viewer with video-only/audio-only switching.
- Angle-level color/audio adjustments.
- Multicam flattening for interchange/export verification.

Definition of done:

- Multicam edits survive undo/redo, export, and interchange where supported.

## Phase 10 — Export, Interchange, Automation, And Release Hardening

Goal: Make projects portable and output predictable.

Tasks:

- Batch export queue, range export, audio-only export, frame export polish.
- EDL/FCPXML/OTIO coverage for core edit constructs.
- Render cache invalidation and diagnostics.
- Crash recovery and autosave verification.
- Performance benchmarks for large timelines.
- Release checklist for Windows/macOS/Linux bundles.

Definition of done:

- Import -> edit -> finish -> export is reliable on large real projects.

## Immediate Execution Order

1. Track header drag reorder.
2. Track targeting/patching controls.
3. Timeline index MVP.
4. Video/image transform inspector and overlay parity.
5. Speed/rate-stretch/speed-ramp UI.
6. Privacy mosaic compound workflow.
7. Audio mixer export parity.
8. Scopes-to-preview-frame integration.
9. Multicam workflow hardening.
10. Export/interchange validation sweep.

## Non-Negotiable Engineering Checks

- Rust: `cargo fmt`, `cargo clippy -D warnings`, targeted command/render tests.
- TypeScript: `npm run lint`, `npx tsc --noEmit`, targeted integration tests.
- No direct AI state mutation.
- No UI-thread blocking for media analysis, render cache, tracking, proxy generation, or export.
- No silent unsupported renderer fallback.
