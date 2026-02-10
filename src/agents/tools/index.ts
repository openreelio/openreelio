/**
 * Agent Tools Index
 *
 * Exports all tool modules for the agent system.
 */

import { registerEditingTools, unregisterEditingTools } from './editingTools';
import { registerAnalysisTools, unregisterAnalysisTools } from './analysisTools';
import { registerAudioTools, unregisterAudioTools } from './audioTools';
import { registerCaptionTools, unregisterCaptionTools } from './captionTools';
import { registerEffectTools, unregisterEffectTools } from './effectTools';
import { registerTransitionTools, unregisterTransitionTools } from './transitionTools';

// Re-export individual module functions
export {
  registerEditingTools,
  unregisterEditingTools,
  getEditingToolNames,
} from './editingTools';

export {
  registerAnalysisTools,
  unregisterAnalysisTools,
  getAnalysisToolNames,
} from './analysisTools';

export {
  registerAudioTools,
  unregisterAudioTools,
  getAudioToolNames,
} from './audioTools';

export {
  registerCaptionTools,
  unregisterCaptionTools,
  getCaptionToolNames,
} from './captionTools';

export {
  registerEffectTools,
  unregisterEffectTools,
  getEffectToolNames,
} from './effectTools';

export {
  registerTransitionTools,
  unregisterTransitionTools,
  getTransitionToolNames,
} from './transitionTools';

/**
 * Register all agent tools with the global registry.
 */
export function registerAllTools(): void {
  registerEditingTools();
  registerAnalysisTools();
  registerAudioTools();
  registerCaptionTools();
  registerEffectTools();
  registerTransitionTools();
}

/**
 * Unregister all agent tools from the global registry.
 */
export function unregisterAllTools(): void {
  unregisterEditingTools();
  unregisterAnalysisTools();
  unregisterAudioTools();
  unregisterCaptionTools();
  unregisterEffectTools();
  unregisterTransitionTools();
}
