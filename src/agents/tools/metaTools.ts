/**
 * Meta-Tools: Consolidated tool set (56+ tools -> 6 meta-tools)
 *
 * Reduces LLM context overhead from ~15K tokens to ~2K tokens while
 * maintaining full editing capability. Each meta-tool dispatches to
 * the underlying individual tool via the global tool registry.
 *
 * Meta-tool mapping:
 * 1. query    - analysis + media analysis tools (22 tools)
 * 2. edit     - editing tools (20 tools)
 * 3. audio    - audio tools (6 tools)
 * 4. effects  - effect + transition tools (8 tools)
 * 5. text     - caption tools (4 tools)
 * 6. execute_plan - batch execution of multiple steps sequentially
 */

import { globalToolRegistry, type ToolDefinition } from '../ToolRegistry';
import { createLogger } from '@/services/logger';
import { getAnalysisToolNames } from './analysisTools';
import { getMediaAnalysisToolNames } from './mediaAnalysisTools';
import { getEditingToolNames } from './editingTools';
import { getAudioToolNames } from './audioTools';
import { getEffectToolNames } from './effectTools';
import { getTransitionToolNames } from './transitionTools';
import { getCaptionToolNames } from './captionTools';

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
  const action = args.action as string | undefined;
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

  const toolDef = globalToolRegistry.get(action);
  if (!toolDef) {
    return {
      success: false,
      error: `Tool '${action}' is not registered. It may require a feature flag to be enabled.`,
    };
  }

  try {
    return await globalToolRegistry.execute(action, toolArgs, {});
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`Meta-tool ${metaToolName} dispatch failed`, { action, error: msg });
    return { success: false, error: `${action} failed: ${msg}` };
  }
}

// =============================================================================
// 1. Query Meta-Tool (analysis + media analysis)
// =============================================================================

// Derive action lists from the individual tool modules (single source of truth).
// These are computed once at module load time; the arrays never change after init.
const QUERY_ACTIONS = [...getAnalysisToolNames(), ...getMediaAnalysisToolNames()];
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
    description: `Query timeline, assets, clips, tracks, and media analysis. Actions: ${QUERY_ACTIONS.join(', ')}`,
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
        shots: { type: 'boolean', description: 'Run shot detection' },
        transcript: { type: 'boolean', description: 'Run transcript analysis' },
        audio: { type: 'boolean', description: 'Run audio profiling' },
        segments: { type: 'boolean', description: 'Run content segmentation' },
        visual: { type: 'boolean', description: 'Run visual analysis' },
        localOnly: { type: 'boolean', description: 'Use local-only analysis where supported' },
        time: { type: 'number', description: 'Timeline position in seconds' },
        path: { type: 'string', description: 'File path or search pattern' },
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
    description: `Perform timeline editing operations. Actions: ${EDIT_ACTIONS.join(', ')}`,
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
        newTimelineIn: { type: 'number', description: 'New timeline position in seconds' },
        newSourceIn: { type: 'number', description: 'New source in point in seconds' },
        newSourceOut: { type: 'number', description: 'New source out point in seconds' },
        splitTime: { type: 'number', description: 'Split position in seconds' },
        speed: { type: 'number', description: 'Speed multiplier (e.g. 2.0)' },
        reverse: { type: 'boolean', description: 'Reverse playback' },
        newTrackId: { type: 'string', description: 'Target track for cross-track moves' },
        kind: { type: 'string', description: 'Track type: video, audio, caption, overlay' },
        name: { type: 'string', description: 'Track or marker name' },
        esdId: { type: 'string', description: 'Editing Style Document ID' },
        sourceAssetId: { type: 'string', description: 'Source asset ID for style transfer' },
        time: { type: 'number', description: 'Timeline position in seconds' },
        color: { type: 'string', description: 'Marker color' },
        filePath: { type: 'string', description: 'File path for insert_clip_from_file' },
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
    description: `Audio operations: volume, fades, mute, normalize. Actions: ${AUDIO_ACTIONS.join(', ')}`,
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
        targetLufs: { type: 'number', description: 'Target loudness in LUFS' },
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
    description: `Manage effects and transitions. Actions: ${EFFECTS_ACTIONS.join(', ')}`,
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
        paramName: { type: 'string', description: 'Effect parameter name' },
        paramValue: { type: 'number', description: 'Effect parameter value' },
        sourceClipId: { type: 'string', description: 'Source clip for copy_effects' },
        targetClipId: { type: 'string', description: 'Target clip for copy_effects' },
        transitionType: { type: 'string', description: 'Transition type (e.g. dissolve, wipe)' },
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
    description: `Caption and text operations. Actions: ${TEXT_ACTIONS.join(', ')}. Note: auto_transcribe requires the whisper feature; if unavailable, use the query meta-tool with analyze_asset action and analysisTypes ["transcript"] or ["textOcr"] instead.`,
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
        text: { type: 'string', description: 'Caption text content' },
        startTime: { type: 'number', description: 'Start time in seconds' },
        endTime: { type: 'number', description: 'End time in seconds' },
        fontSize: { type: 'number', description: 'Font size' },
        fontFamily: { type: 'string', description: 'Font family' },
        color: { type: 'string', description: 'Text color (hex)' },
        position: { type: 'string', description: 'Position: top, center, bottom' },
      },
      required: ['action', 'sequenceId'],
    },
    handler: async (args) => dispatchToTool('text', args, TEXT_ACTIONS),
  },

  // ---------------------------------------------------------------------------
  // 6. execute_plan
  // ---------------------------------------------------------------------------
  {
    name: 'execute_plan',
    description:
      'Execute a batch of editing operations sequentially. Stops on first failure; already-executed steps are NOT rolled back. ' +
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

/**
 * Get the names of all meta-tools.
 */
export function getMetaToolNames(): readonly string[] {
  return META_TOOL_NAMES;
}
