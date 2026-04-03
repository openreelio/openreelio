/**
 * Agent Framework
 *
 * Exports only the shipping tool registry surface.
 * Legacy agent classes and experimental context-builder helpers are intentionally
 * not re-exported from this top-level barrel.
 */

// Tool registry
export {
  ToolRegistry,
  globalToolRegistry,
  type ToolDefinition,
  type ToolHandler,
  type ToolCategory,
  type ToolExecutionResult,
  type AIFunctionSchema,
  type JsonSchema,
  type AgentContext,
  type AgentTool,
} from './ToolRegistry';

// Tools
export {
  registerEditingTools,
  unregisterEditingTools,
  getEditingToolNames,
  registerAnalysisTools,
  unregisterAnalysisTools,
  getAnalysisToolNames,
  registerAudioTools,
  unregisterAudioTools,
  getAudioToolNames,
  registerCaptionTools,
  unregisterCaptionTools,
  getCaptionToolNames,
  registerEffectTools,
  unregisterEffectTools,
  getEffectToolNames,
  registerTransitionTools,
  unregisterTransitionTools,
  getTransitionToolNames,
  registerAllTools,
  unregisterAllTools,
} from './tools';
