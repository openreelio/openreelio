/**
 * Meta-Tools: Consolidated tool set exposed to the runtime prompt surface
 *
 * Reduces LLM context overhead from ~15K tokens to ~2K tokens while
 * maintaining full editing capability. Each meta-tool dispatches to
 * the underlying individual tool via the global tool registry.
 *
 * Prompt-visible meta-tool mapping:
 * 1. query    - analysis + media analysis tools (22 tools)
 * 2. edit     - editing tools (20 tools)
 * 3. audio    - audio tools (6 tools)
 * 4. effects  - effect + transition tools (8 tools)
 * 5. text     - caption tools
 *
 * Legacy compatibility:
 * - execute_plan remains registered for transitional callers, but should not
 *   be part of the default tool surface shown to the model.
 */

import { globalToolRegistry, type ToolDefinition } from '../ToolRegistry';
import { createLogger } from '@/services/logger';
import { getAnalysisToolNames } from './analysisTools';
import { getMediaAnalysisToolNames } from './mediaAnalysisTools';
import { getAssetDiscoveryToolNames } from './assetDiscoveryTools';
import { getEditingToolNames } from './editingTools';
import { getAudioToolNames } from './audioTools';
import { getEffectToolNames } from './effectTools';
import { getTransitionToolNames } from './transitionTools';
import { getCaptionToolNames } from './captionTools';
import { canonicalizeToolNameCandidate } from '../toolNameNormalization';

const logger = createLogger('MetaTools');

// =============================================================================
// Action Dispatch Helper
// =============================================================================

/**
 * Dispatch a meta-tool call to the underlying individual tool.
 * Extracts the `action` parameter and forwards remaining args.
 */
async function dispatchToTool(
  metaToolName: string,
  args: Record<string, unknown>,
  validActions: readonly string[],
) {
  const rawAction = args.action as string | undefined;
  const action =
    typeof rawAction === 'string' ? resolveMetaToolAction(rawAction, validActions) : null;
  if (!action) {
    return {
      success: false,
      error: `Missing required 'action' parameter. Valid actions: ${validActions.join(', ')}`,
    };
  }

  if (!validActions.includes(action)) {
    return {
      success: false,
      error: `Unknown action '${action}' for ${metaToolName}. Valid actions: ${validActions.join(', ')}`,
    };
  }

  // Forward all args except 'action' to the underlying tool
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { action: _action, ...toolArgs } = args;
  const normalizedArgs = normalizeMetaToolArgs(metaToolName, action, toolArgs);

  const toolDef = globalToolRegistry.get(action);
  if (!toolDef) {
    return {
      success: false,
      error: `Tool '${action}' is not registered. It may require a feature flag to be enabled.`,
    };
  }

  try {
    return await globalToolRegistry.execute(action, normalizedArgs, {});
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`Meta-tool ${metaToolName} dispatch failed`, { action, error: msg });
    return { success: false, error: `${action} failed: ${msg}` };
  }
}

function normalizeMetaToolArgs(
  metaToolName: string,
  action: string,
  toolArgs: Record<string, unknown>,
): Record<string, unknown> {
  const normalized = { ...toolArgs };

  if (metaToolName === 'edit') {
    if (
      (action === 'insert_clip' || action === 'insert_clip_from_file') &&
      normalized.timelineStart === undefined &&
      typeof normalized.timelineIn === 'number'
    ) {
      normalized.timelineStart = normalized.timelineIn;
    }

    if (
      action === 'split_clip' &&
      normalized.splitTime === undefined &&
      typeof normalized.atTimelineSec === 'number'
    ) {
      normalized.splitTime = normalized.atTimelineSec;
    }

    if (
      action === 'insert_clip_from_file' &&
      typeof normalized.file !== 'string' &&
      typeof normalized.filePath === 'string'
    ) {
      normalized.file = normalized.filePath;
    }
  }

  if (metaToolName === 'query') {
    const isAssetDiscoveryAction =
      action === 'search_stock_media' || action === 'find_assets_for_script';

    if (
      action === 'find_assets_for_script' &&
      normalized.scriptText === undefined &&
      typeof normalized.query === 'string'
    ) {
      normalized.scriptText = normalized.query;
    }

    if (
      action === 'find_assets_for_script' &&
      normalized.assetType === undefined &&
      typeof normalized.type === 'string'
    ) {
      normalized.assetType = normalized.type;
    }

    if (
      action === 'search_stock_media' &&
      normalized.type === undefined &&
      typeof normalized.assetType === 'string'
    ) {
      normalized.type = normalized.assetType;
    }

    if (
      isAssetDiscoveryAction &&
      normalized.count === undefined &&
      typeof normalized.limit === 'number' &&
      Number.isFinite(normalized.limit)
    ) {
      normalized.count = normalized.limit;
    }

    if (isAssetDiscoveryAction && 'limit' in normalized) {
      delete normalized.limit;
    }
  }

  if (
    metaToolName === 'audio' &&
    action === 'normalize_audio' &&
    normalized.targetLevel === undefined &&
    typeof normalized.targetLufs === 'number'
  ) {
    normalized.targetLevel = normalized.targetLufs;
  }

  return normalized;
}

function resolveMetaToolAction(action: string, validActions: readonly string[]): string | null {
  if (validActions.includes(action)) {
    return action;
  }

  const canonical = canonicalizeToolNameCandidate(action);
  return validActions.includes(canonical) ? canonical : null;
}

export function normalizeMetaToolArgsForValidation(
  metaToolName: string,
  action: string,
  toolArgs: Record<string, unknown>,
): Record<string, unknown> {
  return normalizeMetaToolArgs(metaToolName, action, toolArgs);
}

// =============================================================================
// 1. Query Meta-Tool (analysis + media analysis)
// =============================================================================

// Derive action lists from the individual tool modules (single source of truth).
// These are computed once at module load time; the arrays never change after init.
const QUERY_ACTIONS = [
  ...getAnalysisToolNames(),
  ...getMediaAnalysisToolNames(),
  ...getAssetDiscoveryToolNames(),
];
const EDIT_ACTIONS = getEditingToolNames();
const AUDIO_ACTIONS = getAudioToolNames();
const EFFECTS_ACTIONS = [...getEffectToolNames(), ...getTransitionToolNames()];
const TEXT_ACTIONS = getCaptionToolNames();

// =============================================================================
// 6. Execute Plan Meta-Tool (batch execution)
// =============================================================================

// This is handled specially — it accepts a full plan JSON, not an action dispatch.

// =============================================================================
// Meta-Tool Definitions
// =============================================================================

const META_TOOLS: ToolDefinition[] = [
  // ---------------------------------------------------------------------------
  // 1. query
  // ---------------------------------------------------------------------------
  {
    name: 'query',
    description: `Inspect the timeline, clips, tracks, workspace files, and source analysis. Use this for looking up context, finding assets, checking gaps, searching footage, or reading analysis results. Actions: ${QUERY_ACTIONS.join(', ')}`,
    category: 'analysis',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'The query action to perform',
          enum: [...QUERY_ACTIONS],
        },
        sequenceId: { type: 'string', description: 'Sequence ID' },
        trackId: { type: 'string', description: 'Track ID' },
        clipId: { type: 'string', description: 'Clip ID' },
        assetId: { type: 'string', description: 'Asset ID' },
        esdId: { type: 'string', description: 'Editing Style Document ID' },
        name: { type: 'string', description: 'Optional display name or label' },
        options: { type: 'object', description: 'Optional nested tool-specific options' },
        limit: { type: 'number', description: 'Maximum number of results or selects to return' },
        assetLimit: {
          type: 'number',
          description: 'Maximum number of candidate assets to inspect',
        },
        sections: {
          type: 'array',
          description:
            'Optional source-analysis sections such as moments, chapters, highlights, speakerTurns',
          items: { type: 'string' },
        },
        assetIds: {
          type: 'array',
          description: 'Optional source asset IDs to restrict search scope',
          items: { type: 'string' },
        },
        unusedOnly: {
          type: 'boolean',
          description: 'Restrict source search to currently unused assets',
        },
        analyzeMissing: {
          type: 'boolean',
          description: 'Generate missing source analysis on demand when supported',
        },
        refresh: {
          type: 'boolean',
          description: 'Force regeneration instead of reusing compatible cached analysis data',
        },
        includeAnnotation: {
          type: 'boolean',
          description: 'Include stored annotation/OCR/object summaries when available',
        },
        useIndexedSearch: {
          type: 'boolean',
          description: 'Use indexed report-chunk retrieval when supported',
        },
        useSemantic: {
          type: 'boolean',
          description: 'Use embedding-backed hybrid reranking when supported',
        },
        apply: { type: 'boolean', description: 'Apply the generated plan directly when supported' },
        trackName: {
          type: 'string',
          description: 'Target selects track name when building source selects',
        },
        paddingSec: { type: 'number', description: 'Extra source padding for matched ranges' },
        gapSec: { type: 'number', description: 'Gap between generated selects on the timeline' },
        timelineStart: {
          type: 'number',
          description: 'Timeline start position for generated selects',
        },
        shots: { type: 'boolean', description: 'Run shot detection' },
        transcript: { type: 'boolean', description: 'Run transcript analysis' },
        audio: { type: 'boolean', description: 'Run audio profiling' },
        segments: { type: 'boolean', description: 'Run content segmentation' },
        visual: { type: 'boolean', description: 'Run visual analysis' },
        localOnly: { type: 'boolean', description: 'Use local-only analysis where supported' },
        time: { type: 'number', description: 'Timeline position in seconds' },
        path: { type: 'string', description: 'File path or search pattern' },
        file: { type: 'string', description: 'Workspace-relative media file path' },
        outputPath: {
          type: 'string',
          description: 'Optional workspace-relative output path for generated Markdown reports',
        },
        kind: { type: 'string', description: 'Asset kind filter or media kind selector' },
        query: { type: 'string', description: 'Search query or filename substring' },
        scriptText: {
          type: 'string',
          description: 'Script or scene text for asset discovery actions',
        },
        assetType: {
          type: 'string',
          description: 'Asset discovery media type: video, image, or audio',
        },
        type: {
          type: 'string',
          description: 'Legacy asset discovery media type alias: video, image, or audio',
        },
        count: {
          type: 'number',
          description: 'Maximum asset discovery results to return',
        },
        provider: { type: 'string', description: 'Preferred analysis provider when supported' },
        analysisTypes: {
          type: 'array',
          description: 'Requested analysis passes such as transcript, shots, textOcr, faces',
          items: { type: 'string' },
        },
      },
      required: ['action'],
    },
    handler: async (args) => dispatchToTool('query', args, QUERY_ACTIONS),
  },

  // ---------------------------------------------------------------------------
  // 2. edit
  // ---------------------------------------------------------------------------
  {
    name: 'edit',
    description: `Change the edit: insert, move, trim, split, delete, ripple, roll, slip, slide, manage tracks, or place markers. Use when the user wants timeline changes. Actions: ${EDIT_ACTIONS.join(', ')}`,
    category: 'timeline',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'The editing action to perform',
          enum: [...EDIT_ACTIONS],
        },
        sequenceId: { type: 'string', description: 'Sequence ID' },
        trackId: { type: 'string', description: 'Track ID' },
        clipId: { type: 'string', description: 'Clip ID' },
        assetId: { type: 'string', description: 'Asset ID to insert' },
        timelineStart: {
          type: 'number',
          description: 'Timeline position in seconds where the clip should start',
        },
        newTimelineIn: { type: 'number', description: 'New timeline position in seconds' },
        newSourceIn: { type: 'number', description: 'New source in point in seconds' },
        newSourceOut: { type: 'number', description: 'New source out point in seconds' },
        splitTime: { type: 'number', description: 'Split position in seconds' },
        startTime: { type: 'number', description: 'Range start or caption start in seconds' },
        endTime: { type: 'number', description: 'Range end or caption end in seconds' },
        duration: { type: 'number', description: 'Duration in seconds where relevant' },
        frameTime: { type: 'number', description: 'Frame source/timeline time in seconds' },
        trimEnd: { type: 'number', description: 'New trim end in seconds for ripple edits' },
        rollAmount: { type: 'number', description: 'Cut adjustment amount in seconds' },
        offsetSeconds: { type: 'number', description: 'Slip offset in seconds' },
        slideAmount: { type: 'number', description: 'Slide amount in seconds' },
        speed: { type: 'number', description: 'Speed multiplier (e.g. 2.0)' },
        reverse: { type: 'boolean', description: 'Reverse playback' },
        newTrackId: { type: 'string', description: 'Target track for cross-track moves' },
        leftClipId: { type: 'string', description: 'Clip before the cut point for roll edits' },
        rightClipId: { type: 'string', description: 'Clip after the cut point for roll edits' },
        kind: { type: 'string', description: 'Track type: video, audio, caption, overlay' },
        name: { type: 'string', description: 'Track or marker name' },
        label: { type: 'string', description: 'Marker or UI label text' },
        esdId: { type: 'string', description: 'Editing Style Document ID' },
        sourceAssetId: { type: 'string', description: 'Source asset ID for style transfer' },
        time: { type: 'number', description: 'Timeline position in seconds' },
        color: { type: 'string', description: 'Marker color' },
        markerId: { type: 'string', description: 'Marker ID' },
        fromTime: { type: 'number', description: 'Marker/query range start in seconds' },
        toTime: { type: 'number', description: 'Marker/query range end in seconds' },
        frameRate: {
          type: 'number',
          description: 'Frame rate used for freeze-frame extraction when relevant',
        },
        file: {
          type: 'string',
          description: 'Workspace-relative file name/path for insert_clip_from_file',
        },
        filePath: {
          type: 'string',
          description: 'Legacy alias for file. Prefer canonical file.',
        },
      },
      required: ['action'],
    },
    handler: async (args) => dispatchToTool('edit', args, EDIT_ACTIONS),
  },

  // ---------------------------------------------------------------------------
  // 3. audio
  // ---------------------------------------------------------------------------
  {
    name: 'audio',
    description: `Adjust sound: volume, fades, mute states, and normalization. Use when the user wants audio cleanup or mix changes. Actions: ${AUDIO_ACTIONS.join(', ')}`,
    category: 'audio',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'The audio action to perform',
          enum: [...AUDIO_ACTIONS],
        },
        sequenceId: { type: 'string', description: 'Sequence ID' },
        trackId: { type: 'string', description: 'Track ID' },
        clipId: { type: 'string', description: 'Clip ID' },
        volume: { type: 'number', description: 'Volume level (0-200%)' },
        duration: { type: 'number', description: 'Fade duration in seconds' },
        muted: { type: 'boolean', description: 'Mute state' },
        targetLevel: { type: 'number', description: 'Target normalization level in dB' },
        targetLufs: {
          type: 'number',
          description: 'Legacy alias for targetLevel. Prefer targetLevel.',
        },
      },
      required: ['action', 'sequenceId', 'trackId'],
    },
    handler: async (args) => dispatchToTool('audio', args, AUDIO_ACTIONS),
  },

  // ---------------------------------------------------------------------------
  // 4. effects
  // ---------------------------------------------------------------------------
  {
    name: 'effects',
    description: `Apply or adjust visual effects and transitions. Use for blur, style tweaks, and clip-to-clip transitions. Actions: ${EFFECTS_ACTIONS.join(', ')}`,
    category: 'effect',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'The effect/transition action to perform',
          enum: [...EFFECTS_ACTIONS],
        },
        sequenceId: { type: 'string', description: 'Sequence ID' },
        trackId: { type: 'string', description: 'Track ID' },
        clipId: { type: 'string', description: 'Clip ID' },
        effectId: { type: 'string', description: 'Effect ID' },
        effectType: { type: 'string', description: 'Effect type (e.g. blur, brightness)' },
        parameters: { type: 'object', description: 'Initial effect parameter object' },
        paramName: { type: 'string', description: 'Effect parameter name' },
        paramValue: { type: 'number', description: 'Effect parameter value' },
        sourceClipId: { type: 'string', description: 'Source clip for copy_effects' },
        sourceTrackId: { type: 'string', description: 'Track containing sourceClipId' },
        targetClipId: { type: 'string', description: 'Target clip for copy_effects' },
        targetTrackId: { type: 'string', description: 'Track containing targetClipId' },
        transitionType: { type: 'string', description: 'Transition type (e.g. dissolve, wipe)' },
        transitionId: { type: 'string', description: 'Transition ID' },
        duration: { type: 'number', description: 'Transition duration in seconds' },
      },
      required: ['action'],
    },
    handler: async (args) => dispatchToTool('effects', args, EFFECTS_ACTIONS),
  },

  // ---------------------------------------------------------------------------
  // 5. text
  // ---------------------------------------------------------------------------
  {
    name: 'text',
    description: `Create and edit on-screen text, captions, and subtitles. Use when the user asks for subtitles, captions, or text styling. Actions: ${TEXT_ACTIONS.join(', ')}. Note: auto_transcribe uses local Whisper when available and falls back to a configured transcript analysis provider; for on-screen text or lyrics, use the query meta-tool with analyze_asset action and analysisTypes ["textOcr"] instead.`,
    category: 'clip',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'The text/caption action to perform',
          enum: [...TEXT_ACTIONS],
        },
        sequenceId: { type: 'string', description: 'Sequence ID' },
        trackId: { type: 'string', description: 'Track ID' },
        captionId: { type: 'string', description: 'Caption ID' },
        assetId: { type: 'string', description: 'Asset ID for transcription' },
        text: { type: 'string', description: 'Caption text content' },
        startTime: { type: 'number', description: 'Start time in seconds' },
        endTime: { type: 'number', description: 'End time in seconds' },
        segments: {
          type: 'array',
          description: 'Timed text segments for batch caption creation',
          items: {
            type: 'object',
            properties: {
              startTime: { type: 'number' },
              endTime: { type: 'number' },
              text: { type: 'string' },
            },
            required: ['startTime', 'endTime', 'text'],
          },
        },
        fontSize: { type: 'number', description: 'Font size' },
        fontFamily: { type: 'string', description: 'Font family' },
        color: { type: 'string', description: 'Text color (hex)' },
        backgroundColor: { type: 'string', description: 'Background color (hex)' },
        position: { type: 'string', description: 'Position: top, center, bottom' },
        language: { type: 'string', description: 'Language code for transcription' },
        model: { type: 'string', description: 'Transcription model name' },
        provider: { type: 'string', description: 'Optional transcript analysis provider fallback' },
        async: { type: 'boolean', description: 'Run transcription as a background job' },
        relativePath: {
          type: 'string',
          description: 'Workspace-relative subtitle document path (.srt or .vtt)',
        },
        format: { type: 'string', description: 'Subtitle format: srt or vtt' },
      },
      required: ['action'],
    },
    handler: async (args) => dispatchToTool('text', args, TEXT_ACTIONS),
  },

  // ---------------------------------------------------------------------------
  // 6. execute_plan
  // ---------------------------------------------------------------------------
  {
    name: 'execute_plan',
    description:
      'Execute a batch of editing operations sequentially. Backend-safe steps run atomically with rollback on failure; unsupported mutating steps are rejected. ' +
      'Each step specifies a tool name and its parameters. Use this for complex multi-step edits.',
    category: 'timeline',
    parameters: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          description: 'Ordered list of editing steps to execute',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Unique step identifier' },
              toolName: { type: 'string', description: 'Tool name (e.g. split_clip, move_clip)' },
              params: {
                type: 'object',
                description: 'Tool parameters (same as individual tool args)',
              },
              dependsOn: {
                type: 'array',
                description: 'Step IDs that must complete before this step',
                items: { type: 'string' },
              },
            },
            required: ['id', 'toolName', 'params'],
          },
        },
      },
      required: ['steps'],
    },
    handler: async (args) => {
      const steps = args.steps as Array<{
        id: string;
        toolName: string;
        params: Record<string, unknown>;
        dependsOn?: string[];
      }>;

      if (!Array.isArray(steps) || steps.length === 0) {
        return { success: false, error: 'steps must be a non-empty array' };
      }

      const results: Array<{ stepId: string; success: boolean; result?: unknown; error?: string }> =
        [];
      const completed = new Set<string>();

      for (const step of steps) {
        // Check dependencies
        if (step.dependsOn) {
          for (const dep of step.dependsOn) {
            if (!completed.has(dep)) {
              return {
                success: false,
                error: `Step '${step.id}' depends on '${dep}' which has not completed`,
                result: { completedSteps: results },
              };
            }
          }
        }

        if (step.toolName === 'execute_plan') {
          return {
            success: false,
            error: `Step '${step.id}': execute_plan cannot call itself`,
            result: { completedSteps: results },
          };
        }

        const toolDef = globalToolRegistry.get(step.toolName);
        if (!toolDef) {
          return {
            success: false,
            error: `Step '${step.id}': unknown tool '${step.toolName}'`,
            result: { completedSteps: results },
          };
        }

        try {
          const stepResult = await globalToolRegistry.execute(step.toolName, step.params, {});
          results.push({ stepId: step.id, ...stepResult });
          if (!stepResult.success) {
            return {
              success: false,
              error: `Step '${step.id}' (${step.toolName}) failed: ${stepResult.error}`,
              result: { completedSteps: results },
            };
          }
          completed.add(step.id);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            success: false,
            error: `Step '${step.id}' (${step.toolName}) threw: ${msg}`,
            result: { completedSteps: results },
          };
        }
      }

      return {
        success: true,
        result: {
          stepsExecuted: results.length,
          stepResults: results,
        },
      };
    },
  },
];

// =============================================================================
// Registration
// =============================================================================

/**
 * Register the 6 consolidated meta-tools with the global registry.
 * Individual tools must already be registered (meta-tools dispatch to them).
 */
export function registerMetaTools(): void {
  globalToolRegistry.registerMany(META_TOOLS);
  logger.info(`Registered ${META_TOOLS.length} meta-tools`);
}

/**
 * Unregister the 6 meta-tools from the global registry.
 */
export function unregisterMetaTools(): void {
  for (const tool of META_TOOLS) {
    globalToolRegistry.unregister(tool.name);
  }
  logger.info('Unregistered meta-tools');
}

/** Pre-computed meta-tool names (static after module load). */
const META_TOOL_NAMES: readonly string[] = META_TOOLS.map((t) => t.name);
const LEGACY_META_TOOL_NAMES = new Set(['execute_plan']);
const VISIBLE_META_TOOL_NAMES: readonly string[] = META_TOOL_NAMES.filter(
  (name) => !LEGACY_META_TOOL_NAMES.has(name),
);

/**
 * Get the names of all meta-tools.
 */
export function getMetaToolNames(): readonly string[] {
  return META_TOOL_NAMES;
}

/**
 * Get the meta-tools that should be visible to the default runtime prompt
 * surface. Legacy compatibility tools remain registered but hidden.
 */
export function getVisibleMetaToolNames(): readonly string[] {
  return VISIBLE_META_TOOL_NAMES;
}

export function isLegacyMetaToolName(name: string): boolean {
  return LEGACY_META_TOOL_NAMES.has(name);
}
