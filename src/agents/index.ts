/**
 * Agent Framework
 *
 * Exports the tool registry and tool registration functions.
 * Legacy agent classes (Agent, VideoEditingAgent, MockAgent) have been removed.
 * Use the Agentic Engine (src/agents/engine/) for all agent operations.
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

// Context builder
export {
  ContextBuilder,
  buildAgentContext,
  type AgentContextOptions,
  type ProjectStateShape,
  type TimelineStateShape,
} from './ContextBuilder';

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
