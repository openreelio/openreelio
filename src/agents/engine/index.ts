/**
 * Agentic Engine - AI-Driven Video Editing
 *
 * A complete agentic loop implementation for AI-driven
 * video editing operations using the Think-Plan-Act-Observe cycle.
 *
 * @example
 * ```typescript
 * import {
 *   createAgenticEngine,
 *   type AgentEvent,
 *   type AgentRunResult,
 * } from '@/agents/engine';
 *
 * const engine = createAgenticEngine(llmClient, toolExecutor);
 *
 * const result = await engine.run(
 *   'Split the clip at 5 seconds',
 *   agentContext,
 *   executionContext,
 *   (event) => console.log(event.type)
 * );
 * ```
 */

// =============================================================================
// Main Engine
// =============================================================================
export { AgenticEngine, createAgenticEngine, type AgentRunResult } from './AgenticEngine';

// =============================================================================
// Core Types
// =============================================================================
export {
  // Agent state types
  type AgentPhase,
  type RiskLevel,
  type AgentState,
  type AgentEvent,

  // Thought/Plan/Observation types
  type Thought,
  type Plan,
  type PlanStep,
  type Observation,
  type StateChange,
  type RollbackFailure,
  type RollbackReport,
  type SessionSummary,

  // Context types
  type AgentContext,
  type LanguagePolicy,
  type TimelineInfo,
  type ClipInfo,
  type AssetInfo,
  type TrackInfo,

  // New event types
  type ToolPermissionRequestEvent,
  type ToolPermissionResponseEvent,
  type DoomLoopDetectedEvent,

  // Configuration
  type AgenticEngineConfig,
  DEFAULT_ENGINE_CONFIG,

  // Factory functions
  createInitialState,
  createEmptyContext,
  createLanguagePolicy,
  normalizeLanguageCode,
  mergeConfig,
  requiresApproval,
  generateId,
} from './core/types';

export {
  type StepValueReference,
  type StepReferenceOccurrence,
  type StepReferenceResolutionError,
  type StepReferenceResolutionResult,
  isStepValueReference,
  collectStepValueReferences,
  normalizeReferencesForValidation,
  resolveStepValueReferences,
  getValueAtReferencePath,
} from './core/stepReferences';

export {
  type OrchestrationPlaybookId,
  type OrchestrationPlaybookMatch,
  buildOrchestrationPlaybook,
} from './core/orchestrationPlaybooks';

// =============================================================================
// Errors
// =============================================================================
export {
  // Base error
  AgentError,

  // Configuration errors
  ConfigurationError,
  SessionActiveError,

  // Phase-specific errors
  ThinkingTimeoutError,
  UnderstandingError,
  PlanningTimeoutError,
  PlanGenerationError,
  PlanValidationError,
  ToolNotFoundError,
  ApprovalRejectedError,
  ApprovalTimeoutError,
  ExecutionTimeoutError,
  ToolExecutionError,
  InvalidArgumentsError,
  DependencyError,
  StepBudgetExceededError,
  ToolBudgetExceededError,
  ObservationTimeoutError,
  ObservationError,
  MaxIterationsError,

  // Doom loop
  DoomLoopError,

  // LLM errors
  LLMError,
  RateLimitError,
  AuthenticationError,
  ContextError,

  // Helper functions
  isAgentError,
  isRecoverable,
  wrapError,
  createTimeoutError,
} from './core/errors';

// =============================================================================
// Port Interfaces
// =============================================================================
export {
  type ILLMClient,
  type LLMMessage,
  type LLMToolDefinition,
  type GenerateOptions,
  type LLMStreamEvent,
  type LLMCompletionResult,
} from './ports/ILLMClient';

export {
  type IToolExecutor,
  type ExecutionContext,
  type ToolExecutionResult,
  type UndoOperation,
  type ToolInfo,
  type ToolDefinition,
  type BatchExecutionRequest,
  type BatchExecutionResult,
} from './ports/IToolExecutor';

export {
  type IMemoryStore,
  type ConversationMemory,
  type MemoryConversationMessage,
  type UserPreferences,
  type ProjectMemory,
  type MemoryQueryOptions,
  DEFAULT_PREFERENCES,
  createEmptyProjectMemory,
} from './ports/IMemoryStore';

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
} from './ports/ICheckpointStore';

// =============================================================================
// Conversation Model
// =============================================================================
export {
  // Types
  type MessagePart,
  type TextPart,
  type ThinkingPart,
  type PlanPart,
  type ToolCallPart,
  type ToolResultPart,
  type ErrorPart,
  type ApprovalPart,
  type ToolApprovalPart,
  type ConversationRole,
  type TokenUsage,
  type ConversationMessage,
  type Conversation,

  // Factories
  createConversation,
  createUserMessage,
  createAssistantMessage,
  createSystemMessage,
  createTextPart,
  createThinkingPart,
  createPlanPart,
  createToolCallPart,
  createToolResultPart,
  createErrorPart,
  createApprovalPart,

  // Conversion
  toSimpleLLMMessage,
  toSimpleLLMMessages,

  // Validation
  isValidMessagePart,
  isValidConversationMessage,
} from './core/conversation';

// =============================================================================
// Phase Implementations
// =============================================================================
export { Thinker, createThinker, type ThinkerConfig } from './phases/Thinker';

export { Planner, createPlanner, type PlannerConfig } from './phases/Planner';

export {
  Executor,
  createExecutor,
  type ExecutorConfig,
  type ExecutionProgress,
  type ExecutionPhase,
  type StepExecutionRecord,
  type ExecutionLimits,
  type ExecutionResult,
} from './phases/Executor';

export { Observer, createObserver, type ObserverConfig } from './phases/Observer';

// =============================================================================
// Adapters
// =============================================================================

// Mock adapters for testing
export {
  MockLLMAdapter,
  createMockLLMAdapter,
  createMockLLMAdapterWithResponses,
  type MockResponse,
  type CapturedRequest,
} from './adapters/llm/MockLLMAdapter';

export {
  MockToolExecutor,
  createMockToolExecutor,
  createMockToolExecutorWithVideoTools,
  type MockToolConfig,
  type CapturedExecution,
} from './adapters/tools/MockToolExecutor';

// Production adapters
export {
  TauriLLMAdapter,
  createTauriLLMAdapter,
  type TauriLLMAdapterConfig,
} from './adapters/llm/TauriLLMAdapter';

export {
  ToolRegistryAdapter,
  createToolRegistryAdapter,
} from './adapters/tools/ToolRegistryAdapter';

export {
  MemoryManagerAdapter,
  createMemoryManagerAdapter,
} from './adapters/memory/MemoryManagerAdapter';
