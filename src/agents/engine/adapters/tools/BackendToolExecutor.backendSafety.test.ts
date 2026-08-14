/**
 * Cross-surface guards for the atomic batch plan path.
 *
 * `execute_plan` promotes a batch of tool calls into one atomic backend plan,
 * so every mutating tool must carry an explicit decision about whether it can
 * ride that path. This guard fails when a newly registered mutating tool has no
 * decision recorded — the point is to force the choice, not to let a tool
 * silently default to "frontend only" and quietly stay out of every batch.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { globalToolRegistry } from '@/agents/ToolRegistry';
import { registerAllTools, unregisterAllTools } from '@/agents/tools';
import { getMetaToolNames } from '@/agents/tools/metaTools';
import { resetFeatureFlags, setFeatureFlag } from '@/config/featureFlags';
import { isMutatingToolName } from '@/agents/engine/core/toolSemantics';
import {
  getBackendDirectToolNames,
  hasCompoundExpander,
  MAX_PLAN_STEPS,
} from './BackendToolExecutor';
import { registerDefaultCompoundExpanders } from './registerDefaultCompoundExpanders';

/**
 * Mutating tools that deliberately stay on the frontend, with the reason.
 *
 * Each of these does work the backend command does not: it resolves a name,
 * reads the timeline snapshot, or issues more than one command. Moving one here
 * to a backend route means proving the backend command alone is equivalent.
 */
const FRONTEND_ONLY_MUTATING_TOOLS: Readonly<Record<string, string>> = {
  // Fan out over clips read from the timeline snapshot.
  mute_track: 'expands to one SetClipMute per clip on the track',
  delete_clips_in_range: 'selects the overlapping clips from the snapshot',
  split_timeline_by_interval: 'enumerates split boundaries from the snapshot',
  copy_effects: "enumerates the source clip's effects from the snapshot",
  reset_effects: "enumerates the target clip's effect ids from the snapshot",
  freeze_frame: 'derives frame duration from clip speed/frameRate, then 4 commands',
  remove_transition: 'scans the track to find the clip owning the effect',
  adjust_volume: 'branches clip vs track and converts percent to dB',
  normalize_audio: 'synthesizes a loudness_normalize effect with clamped params',

  // Resolve ids or merge against current state before the command.
  add_caption: 'ensures the caption track exists, which may add a track first',
  update_caption: 'resolves the caption track id from the sequence',
  delete_caption: 'resolves the caption track id from the sequence',
  style_caption: 'folds ~20 flat args into one style object',
  add_captions_from_transcription: 'maps source time to timeline time, then sets track language',
  import_captions_from_file: 'reads a workspace file and parses SRT/VTT',
  add_text_clip: 'ensures a text track, auto-places, then sets the transform',
  update_text_clip: "merges flat args onto the clip's existing textData",
  delete_text_clip: 'resolves sequence/track from the clip id',
  set_text_transform: 'composes against the transform currently on the clip',
  insert_clip_from_file: 'resolves the workspace file, then refreshes to learn the assetId',

  // Not a CommandPayload at all.
  delete_transcript_range: 'dedicated IPC, no command payload',
  apply_editing_style: 'generates a plan backend-side and executes it itself',
  write_workspace_document: 'document IPC, no command payload',
  replace_workspace_document_text: 'read-modify-write against document content',
  generate_timeline_media: 'generation job API plus placement intent',
  resolve_generation_job: 'generation job polling API',
  import_asset_candidate: 'license-gated download and import',
  generate_video: 'generation job API',
  cancel_generation: 'generation job API',
};

describe('BackendToolExecutor backend safety', () => {
  beforeAll(() => {
    globalToolRegistry.clear();
    // Audit the full surface, including the flag-gated generation tools.
    setFeatureFlag('USE_VIDEO_GENERATION', true);
    registerAllTools();
    registerDefaultCompoundExpanders();
  });

  afterAll(() => {
    unregisterAllTools();
    globalToolRegistry.clear();
    resetFeatureFlags();
  });

  it('records a backend-safety decision for every registered mutating tool', () => {
    const metaToolNames = new Set(getMetaToolNames());
    const backendDirect = new Set(getBackendDirectToolNames());

    const undecided = globalToolRegistry
      .listAll()
      .filter((tool) => !metaToolNames.has(tool.name))
      .filter((tool) => isMutatingToolName(tool.name, tool.category))
      .map((tool) => tool.name)
      .filter(
        (name) =>
          !backendDirect.has(name) &&
          !hasCompoundExpander(name) &&
          !(name in FRONTEND_ONLY_MUTATING_TOOLS),
      );

    expect(
      undecided,
      `These mutating tools have no backend-safety decision: ${undecided.join(', ')}.\n` +
        'Pick one:\n' +
        '  - args map 1:1 onto a CommandPayload with no frontend orchestration ' +
        '=> add a BACKEND_DIRECT_ROUTES entry in BackendToolExecutor.ts\n' +
        '  - the transform into commands is deterministic and state-free but not 1:1 ' +
        '=> add a route with mapParams, or a compound expander for multi-command cases\n' +
        '  - it resolves names, reads the store, or is not a command at all ' +
        '=> add it to FRONTEND_ONLY_MUTATING_TOOLS in this file with the reason.',
    ).toEqual([]);
  });

  it('keeps every recorded decision pointing at a tool that still exists', () => {
    const registered = new Set(globalToolRegistry.listAll().map((tool) => tool.name));

    const staleFrontendOnly = Object.keys(FRONTEND_ONLY_MUTATING_TOOLS).filter(
      (name) => !registered.has(name),
    );
    const staleBackendDirect = getBackendDirectToolNames().filter((name) => !registered.has(name));

    expect(staleFrontendOnly, 'frontend-only entries for tools that no longer exist').toEqual([]);
    expect(staleBackendDirect, 'backend routes for tools that no longer exist').toEqual([]);
  });

  it('routes exactly the audited tool set to the backend', () => {
    // Pinned explicitly: growing this list is a decision, not a side effect.
    expect([...getBackendDirectToolNames()].sort()).toEqual([
      'add_effect',
      'add_fade_in',
      'add_fade_out',
      'add_marker',
      'add_mask',
      'add_track',
      'add_transition',
      'adjust_effect_param',
      'change_clip_speed',
      'create_workspace_folder',
      'delete_clip',
      'delete_workspace_entry',
      'insert_clip',
      'move_clip',
      'move_workspace_entry',
      'mute_clip',
      'remove_effect',
      'remove_marker',
      'remove_mask',
      'remove_track',
      'rename_track',
      'rename_workspace_entry',
      'set_transition_duration',
      'split_clip',
      'trim_clip',
      'update_mask',
    ]);
  });
});

describe('plan step cap', () => {
  it('pins the same cap the Rust plan surfaces enforce', () => {
    // A cap that disagrees across surfaces is worse than no cap: the same plan
    // would be accepted by one entry point and refused by another.
    const planExecutorSource = readFileSync(
      resolve(__dirname, '../../../../../src-tauri/src/core/ai/plan_executor.rs'),
      'utf-8',
    );

    const match = planExecutorSource.match(/pub const MAX_PLAN_STEPS: usize = (\d+);/);

    expect(match, 'MAX_PLAN_STEPS must stay declared in plan_executor.rs').not.toBeNull();
    expect(Number(match![1])).toBe(MAX_PLAN_STEPS);
    expect(MAX_PLAN_STEPS).toBe(1000);
  });
});
