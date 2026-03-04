/**
 * Agent Tools Index
 *
 * Exports all tool modules for the agent system.
 *
 * When USE_META_TOOLS is enabled, the 6 consolidated meta-tools are
 * registered ON TOP of individual tools. The LLM sees only the meta-tools,
 * and each meta-tool dispatches to the underlying individual tool handler.
 */

import { registerEditingTools, unregisterEditingTools } from './editingTools';
import { registerAnalysisTools, unregisterAnalysisTools } from './analysisTools';
import { registerAudioTools, unregisterAudioTools } from './audioTools';
import { registerCaptionTools, unregisterCaptionTools } from './captionTools';
import { registerEffectTools, unregisterEffectTools } from './effectTools';
import { registerTransitionTools, unregisterTransitionTools } from './transitionTools';
import { registerGenerationTools, unregisterGenerationTools } from './generationTools';
import { registerWorkspaceTools, unregisterWorkspaceTools } from './workspaceTools';
import { registerMediaAnalysisTools, unregisterMediaAnalysisTools } from './mediaAnalysisTools';
import { registerMetaTools, unregisterMetaTools } from './metaTools';
import { isVideoGenerationEnabled, isMetaToolsEnabled } from '@/config/featureFlags';
import { createLogger } from '@/services/logger';

const logger = createLogger('AgentTools');

// Re-export individual module functions
export { registerEditingTools, unregisterEditingTools, getEditingToolNames } from './editingTools';

export {
  registerAnalysisTools,
  unregisterAnalysisTools,
  getAnalysisToolNames,
} from './analysisTools';

export { registerAudioTools, unregisterAudioTools, getAudioToolNames } from './audioTools';

export { registerCaptionTools, unregisterCaptionTools, getCaptionToolNames } from './captionTools';

export { registerEffectTools, unregisterEffectTools, getEffectToolNames } from './effectTools';

export {
  registerTransitionTools,
  unregisterTransitionTools,
  getTransitionToolNames,
} from './transitionTools';

export {
  registerGenerationTools,
  unregisterGenerationTools,
  getGenerationToolNames,
} from './generationTools';

export {
  registerWorkspaceTools,
  unregisterWorkspaceTools,
  getWorkspaceToolNames,
} from './workspaceTools';

export {
  registerMediaAnalysisTools,
  unregisterMediaAnalysisTools,
  getMediaAnalysisToolNames,
} from './mediaAnalysisTools';

export { registerMetaTools, unregisterMetaTools, getMetaToolNames } from './metaTools';

/** Track whether generation tools were registered (behind feature flag) */
let generationToolsRegistered = false;

/** Track whether meta-tools were registered */
let metaToolsRegistered = false;

/**
 * Register all agent tools with the global registry.
 *
 * Individual tools are always registered (they serve as the execution layer).
 * When USE_META_TOOLS is enabled, the 6 meta-tools are additionally registered
 * and the Planner will expose only the meta-tools to the LLM.
 *
 * Each registration is isolated so a single module failure
 * does not prevent other tools from being available.
 */
export function registerAllTools(): void {
  // Always register individual tools (they're the execution backend for meta-tools)
  const registrations: Array<[string, () => void]> = [
    ['editing', registerEditingTools],
    ['analysis', registerAnalysisTools],
    ['audio', registerAudioTools],
    ['caption', registerCaptionTools],
    ['effect', registerEffectTools],
    ['transition', registerTransitionTools],
    ['workspace', registerWorkspaceTools],
    ['mediaAnalysis', registerMediaAnalysisTools],
  ];

  for (const [name, register] of registrations) {
    try {
      register();
    } catch (error) {
      logger.error(`Failed to register ${name} tools`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (isVideoGenerationEnabled()) {
    try {
      registerGenerationTools();
      generationToolsRegistered = true;
    } catch (error) {
      logger.error('Failed to register generation tools', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Register meta-tools on top of individual tools
  if (isMetaToolsEnabled()) {
    try {
      registerMetaTools();
      metaToolsRegistered = true;
      logger.info('Meta-tools enabled: LLM will see 6 consolidated tools');
    } catch (error) {
      logger.error('Failed to register meta-tools', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/**
 * Unregister all agent tools from the global registry.
 */
export function unregisterAllTools(): void {
  // Unregister meta-tools first (they depend on individual tools)
  if (metaToolsRegistered) {
    try {
      unregisterMetaTools();
      metaToolsRegistered = false;
    } catch (error) {
      logger.error('Failed to unregister meta-tools', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const unregistrations: Array<[string, () => void]> = [
    ['editing', unregisterEditingTools],
    ['analysis', unregisterAnalysisTools],
    ['audio', unregisterAudioTools],
    ['caption', unregisterCaptionTools],
    ['effect', unregisterEffectTools],
    ['transition', unregisterTransitionTools],
    ['workspace', unregisterWorkspaceTools],
    ['mediaAnalysis', unregisterMediaAnalysisTools],
  ];

  for (const [name, unregister] of unregistrations) {
    try {
      unregister();
    } catch (error) {
      logger.error(`Failed to unregister ${name} tools`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (generationToolsRegistered) {
    try {
      unregisterGenerationTools();
      generationToolsRegistered = false;
    } catch (error) {
      logger.error('Failed to unregister generation tools', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
