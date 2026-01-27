/**
 * Agent Framework
 *
 * Exports the agent system for AI-driven video editing operations.
 */

// Base agent
export {
  Agent,
  type AgentConfig,
  type AgentContext,
  type AgentMessage,
  type AgentResponse,
  type AgentStatus,
  type AgentTool,
  type AgentToolCall,
  type AgentToolResult,
  type AgentEventType,
  type AgentEventListener,
  type MessageRole,
  type JsonSchema,
} from './Agent';

// Tool registry
export {
  ToolRegistry,
  globalToolRegistry,
  type ToolDefinition,
  type ToolHandler,
  type ToolCategory,
  type ToolExecutionResult,
  type AIFunctionSchema,
} from './ToolRegistry';

// Context builder
export {
  ContextBuilder,
  buildAgentContext,
  type AgentContextOptions,
  type ProjectStateShape,
  type TimelineStateShape,
} from './ContextBuilder';

// Mock agent for testing
export { MockAgent, type MockLLMResponse } from './MockAgent';

// Video editing agent
export { VideoEditingAgent, createVideoEditingAgent } from './VideoEditingAgent';

// Tools
export {
  registerEditingTools,
  unregisterEditingTools,
  getEditingToolNames,
} from './tools';
