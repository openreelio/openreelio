/**
 * Port Interfaces Index
 *
 * Exports all port interfaces for the Agentic Engine.
 * These define the contracts between the application and infrastructure layers.
 */

// LLM Client
export {
  type ILLMClient,
  type LLMMessage,
  type MessageRole,
  type GenerateOptions,
  type LLMToolDefinition,
  type LLMStreamEvent,
  type LLMTextEvent,
  type LLMToolCallEvent,
  type LLMToolResultEvent,
  type LLMDoneEvent,
  type LLMErrorEvent,
  type LLMCompletionResult,
  type LLMClientConfig,
  type LLMClientFactory,
} from './ILLMClient';

// Tool Executor
export {
  type IToolExecutor,
  type ExecutionContext,
  type ToolExecutionResult,
  type UndoOperation,
  type ToolInfo,
  type ToolDefinition,
  type BatchExecutionRequest,
  type BatchExecutionResult,
  createSuccessResult,
  createFailureResult,
  createUndoableResult,
} from './IToolExecutor';

// Memory Store
export {
  type IMemoryStore,
  type ConversationMemory,
  type ConversationMessage,
  type UserPreferences,
  type ProjectMemory,
  type MemoryQueryOptions,
  DEFAULT_PREFERENCES,
  createEmptyProjectMemory,
} from './IMemoryStore';

// Checkpoint Store
export {
  type ICheckpointStore,
  type AgentCheckpoint,
  type CheckpointOptions,
  type CheckpointQueryOptions,
  type CheckpointDiff,
  type RestoreResult,
  createCheckpointFromState,
  deepCloneState,
  calculateCheckpointDiff,
} from './ICheckpointStore';
