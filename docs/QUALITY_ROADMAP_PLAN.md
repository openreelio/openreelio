# Edit Quality Roadmap — Design & Implementation Plan

**Status**: DESIGN APPROVED — implementation in progress.
**Goal**: Close the quality gap in agent-driven editing. Research (2026-08) established that the
gap is a missing *taste and verification layer*, not missing perception: quality comes from
(a) constrained, human-curated components the agent selects instead of invents, (b) atomic
batch plans as the unit of edit, and (c) a self-judging loop where the agent inspects its own
rendered output and picks the best of N candidates. This plan lands all three inside the
existing editable, event-sourced engine — CLI/MCP (the flagship agent surface) first.

## Thesis (from research, condensed)

- **The loop is the win, not the LLM.** Coding-agent-style editing works because of
  render → inspect → re-edit iteration, not model taste. Both our in-app engine and the
  external CLI path currently share one bottleneck: the agent cannot systematically judge its
  own rendered output.
- **Quality comes from constraint.** Tool-constrained agents produce ~80% valid specs vs ~0%
  free-form. Agents are measurably worst at numeric parameter choice and aesthetic judgment —
  so bad looks must be *unrepresentable*: enum-valued pack IDs resolved deterministically in
  core, not 21 free-form numbers per caption.
- **Contact-sheet judging is cheap and real.** One grid of keyframes + durations ≈ 1–2k tokens,
  ~80% human agreement (human inter-rater is ~79%). Use it for best-of-N selection over
  candidate plans, with deterministic priors (`verify`, `shot.length_stats`) listed first.

## Root causes addressed

| ID | Root cause | Evidence |
|----|-----------|----------|
| RQ-1 | **Batch plan surface is fragmented and soft.** Three incompatible plan schemas (in-app `execute_plan` steps, CLI/MCP `EditPlan`, backend `AgentPlan`); CLI `plan execute` runs without pre-validation, reports failure with a success exit code, and no surface bounds step count. The in-app `execute_plan` is hidden and its reachable fallback handler has no rollback. | plan.rs:72-261; metaTools.ts:842-950; BackendToolExecutor.ts:57-70; help_json `--type` vs actual `--template-type` |
| RQ-2 | **The agent cannot judge its own output.** Contact-sheet cells are pinned to 320×180 with no labels; sampling is uniform (never cut-aware); `frame extract` cannot read a rendered file; there is no history-jump verb for candidate iteration; no judging rubric or best-of-N guidance exists anywhere in docs or skills. | frame.rs:824-832; visual.rs:43-46; lib.rs:901 (unexposed); skills teach single-candidate convergence only |
| RQ-3 | **Style vocabulary is unconstrained and divergent.** The same design content lives in five hand-maintained catalogs that already disagree (TS 22 text presets / Rust CLI 14 / prose hints 17 — hints advertise presets the CLI rejects). Captions expose 21 free-form numeric params; transitions hide direction/duration so every wipe is `wipeleft@1.0s`; core has zero pack/preset registry reachable by any agent surface. | textPresets.ts:58 vs text.rs:462-728 vs mcp.rs:1370; captionTools.ts:1120-1228; transitionTools.ts:73 + metaTools.ts:596 |

## Design decisions (locked)

- **D1 — Canonical headless plan schema is `EditPlan`** (`{id, steps:[{id, commandType, payload, dependsOn}]}`). It maps 1:1 onto `CommandPayload` (the real 79-command registry) with no tool-name indirection. The in-app engine keeps `AgentPlan` internally; the existing legacy bridge converts. Full in-app schema convergence is deferred, not forced.
- **D2 — Packs resolve in core, at the command chokepoint.** Every surface (UI, CLI, agent tools, MCP) converges on `CommandPayload` → `Command::execute`; a resolver there serves all four at once. Registries are const tables in core following the proven `ExportPreset::from_legacy_id` + `render presets` pattern (normalize → match → hard-error with the valid list). Types are serde-friendly so bundled/user JSON pack files can be added later without schema change.
- **D3 — The judge is the agent, not the CLI.** The CLI never embeds an LLM. It produces judge-ready artifacts (labeled contact sheets, structural stats, verify reports); the skill teaches the rubric and the best-of-N procedure; judgement persistence is a documented JSON convention the agent writes, not a CLI feature.
- **D4 — Candidate iteration = linear rewind + replayable plans.** No branching machinery. The loop is: apply plan A (atomic) → render range → sheet → score → `state jump` back → apply plan B → … → re-apply the winner's plan JSON. Parallel candidates use N project-directory copies (the external-edit guard forbids concurrent writers by design). A branch/checkout model is explicitly out of scope.
- **D5 — Judge the artifact, not a re-render.** `frame extract --file <render>` sheets the actual proxy the agent just rendered (fast seek, no per-cell timeline renders), so the judge sees exactly what `verify --file` measured. Composite-mode grids remain for pre-render inspection.

## Task breakdown (sequential PRs)

### PR 1 — `fix/plan-batch-hardening` (RQ-1, CLI+MCP)

| Task | Deliverable |
|------|-------------|
| Q1.1 | `plan execute` runs full `validate_edit_plan` (payload parse, dupes, deps, cycles) **before** any mutation. |
| Q1.2 | Shared `MAX_PLAN_STEPS` cap (1000, anti-runaway backstop) enforced in validation, CLI and MCP. |
| Q1.3 | Exit-code contract: `0` applied / `1` plan failed + rolled back cleanly / `2` could not run **or rollback incomplete** (`rollbackIncomplete: true` in JSON). No more success-shaped failures. |
| Q1.4 | Audit CLI failure path for persisted-op leakage; add `discard`/no-save parity with `execute_agent_plan` where needed. |
| Q1.5 | Fix `--type` vs `--template-type` drift: `--type` becomes real (keep the old spelling as a hidden alias), help_json matches reality. |
| Q1.6 | Executor coverage parity guard: every `SUPPORTED_COMMAND_TYPES` entry must execute through `CommandExecutor` (closes the SetClipEnabled/SetClipOpacity/ReverseClip registration chips if confirmed). |
| Q1.7 | MCP `plan.validate` delegates to `plan::validate_edit_plan` (delete the duplicated pre-pass); `plan.apply`/`plan.validate` tool schemas describe real steps instead of an opaque object. |
| Q1.8 | Tests: rollback-on-failure, cycle-on-execute, step-cap, exit codes (integration). |

### PR 2 — `feature/judge-loop` (RQ-2, CLI + skills)

| Task | Deliverable |
|------|-------------|
| Q2.1 | `--cell-width/--cell-height` on `--grid` (clamped ~64..1024; default stays 320×180); parametrize the pinned consts in `generate_contact_sheet_with_layout`. |
| Q2.2 | `--label-cells`: burn cell index + timecode into each cell (drawtext at extraction, before tiling) so the mapping is self-evident in the image beyond 3×3. |
| Q2.3 | `--grid` + `--times`: contact sheet from an explicit time list (cut-boundary sheets become possible; the agent computes boundary times from `timeline clips`). |
| Q2.4 | `--file <RENDER>` source mode: extract stills/sheets from a rendered file (file timebase, fast seek) — the cheap, truthful judge path (D5). |
| Q2.5 | `state history` (indexed op list + current position) and `state jump --index N` wrapping the existing core `jump_to_history_index_persisted`; respects the external-edit guard. |
| Q2.6 | help_json entries for every new flag (parity test enforces) + integration tests. |
| Q2.7 | Skills: new `judging/REFERENCE.md` — fixed pointwise rubric (deterministic priors first: verify report + `shot.length_stats`; then hook, pacing, continuity, caption legibility, framing), the best-of-N jump-loop procedure (D4), judgement JSON convention, cost ladder. Router entry in SKILL.md + AGENT_GUIDE.md section. |

### PR 3 — `feature/curated-packs` (RQ-3: caption packs + transition recipes)

| Task | Deliverable |
|------|-------------|
| Q3.1 | `core/style/` pack registries: ~8 caption style packs (typed `CaptionStyle` + position; e.g. `clean-minimal`, `boxed-contrast`, `yellow-classic`, `shorts-bold-outline`, `broadcast-lower`) and ~10 transition recipes (`{effectType, direction, duration, offset}`; e.g. `dissolve-soft`, `wipe-left-fast`, `fade-in`). Resolvers follow `ExportPreset::from_legacy_id`. |
| Q3.2 | `stylePack` field on Create/Update/ImportGeneratedCaptions payloads, resolved inside command execute (explicit style fields override pack values). Transition recipe resolution feeding `AddEffect`. |
| Q3.3 | Surfaces: CLI `packs list [--kind caption\|transition]` + `caption create --style-pack`; agent `style_caption`/`add_transition` gain enum pack params (+ `direction` finally exposed; enum restored at the meta-tool boundary); MCP payload hints; help_json. |
| Q3.4 | Contract tests: every pack round-trips `CommandPayload::parse`, passes `CaptionSafeAreaRule` by construction, and every recipe builds a valid xfade/fade filter. |

### PR 4 — `refactor/text-preset-unification` (RQ-3: one text catalog)

| Task | Deliverable |
|------|-------------|
| Q4.1 | Port all 22 text presets into the core registry (single source, carries `category`, `defaultDurationSec`, placement); CLI `parse_text_preset` (~270 lines) deletes and delegates; `packs list --kind text`. |
| Q4.2 | Divergence closed: prose hints (`mcp.rs`, `help_json.rs`, `toolReference.ts`, Codex adapter) and the meta-tool 4-value enum all reference the full registry; `quote`/`watermark`/`countdown` actually work. TS `textPresets.ts` gains a parity test against the core list. |

### PR 5 — `feature/execute-plan-revival` (RQ-1, in-app TS)

| Task | Deliverable |
|------|-------------|
| Q5.1 | `execute_plan` visible again (out of `LEGACY_META_TOOL_NAMES`); visibility tests + openspec drift updated. |
| Q5.2 | Expand `BACKEND_DIRECT_TOOLS` from 12 toward the full backend-safe catalog; rejection errors name the offending step/tool instead of the opaque blanket message. |
| Q5.3 | Delete the unreachable-when-backend naive handler (no rollback, empty context); `execute_plan` always routes through the atomic backend path. |
| Q5.4 | Shared step cap on `steps[]`; `permissionSubject` META_TOOL_NAMES dedup; prompt guidance ("prefer execute_plan for ≥3-step edits"). |

### PR 6 — `feature/pacing-profiles` (RQ-3, taste layer for auto-cut)

| Task | Deliverable |
|------|-------------|
| Q6.1 | `PacingProfile` pack `{tempo, targetShotSec, variance, transitionRecipe, transitionEveryN}` + registry. |
| Q6.2 | `StylePlanner::plan_from_profile` reusing `compute_scaled_cut_times`/`generate_steps` (profile as alternative input to an ESD). |
| Q6.3 | `generate_steps` emits transition `AddEffect` steps honoring recipes — makes good the "transitions not yet supported" warning at style_planner.rs:188. |
| Q6.4 | CLI exposure (exact verb decided at implementation: extend `analysis build-selects` vs new `plan from-profile`). |

### PR 7 — `feature/mcp-frame-tool` (RQ-2, MCP image path)

| Task | Deliverable |
|------|-------------|
| Q7.1 | MCP server emits `{"type":"image", data, mimeType}` content blocks (protocol already supports it; today everything is hard-coded text). |
| Q7.2 | `openreelio.frame.extract` MCP read tool returning the sheet inline — MCP-connected vision agents get the judge loop without Bash. |

## Explicitly deferred (tracked, not forgotten)

- In-app engine image port (`ILLMClient` is `content: string` throughout) — large; revisit after PR 7 proves the MCP path.
- Beat-times array + cut-on-beat (needs new analysis; BPM is a single scalar today).
- FilmGPT-style learned cut ranker (candidate re-ranker slot exists once best-of-N lands).
- Effect look packs (`BUILT_IN_VISUAL_EFFECT_PRESETS` → core) — mechanical but multi-command recipes belong in a plan-builder.
- Branch/checkout project model (D4 rejects it for now).
- Template engine `template/engine.rs`: do **not** wire up as-is; harvest `SectionConfig` (pack-reference shape) and `TemplateParamType::Choice` (constrained param shape), then decide deletion separately.
- Judgement persistence as a CLI feature (starts as a documented convention per D3).

## Verification protocol (every PR)

1. `cargo fmt` + `cargo clippy -D warnings` + full `cargo test` (lib + CLI) + affected JS/TS suites.
2. Contract tests listed per PR are non-negotiable: they prove the class is closed, not that the new code agrees with itself.
3. help_json parity test must pass for any new clap leaf/flag.
4. CI verified by **per-check conclusion** (`gh pr checks` / `gh run view --json conclusion`), never the watch exit code.
5. Skills/docs updated in the same PR that changes behavior they describe.
