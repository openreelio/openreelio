/**
 * Agent Core Module
 *
 * Exports core agent functionality including hooks and hookable agents.
 */

// Hook system
export {
  HookManager,
  createHookManager,
  type PreToolUseHook,
  type PostToolUseHook,
  type PreMessageHook,
  type PostMessageHook,
  type PreToolUseHookResult,
  type PostToolUseHookResult,
  type PreMessageHookResult,
  type PostMessageHookResult,
  type PreToolUseContext,
  type PostToolUseContext,
  type PreMessageContext,
  type PostMessageContext,
  type HookPriority,
  type HookRegistrationOptions,
  type UnsubscribeHook,
} from './AgentHooks';

// Hookable agent
export {
  HookableAgent,
  type HookableAgentConfig,
  type HookExecutionResult,
} from './HookableAgent';

// Memory system
export {
  MemoryManager,
  createMemoryManager,
  type ShortTermMemory,
  type LongTermMemory,
  type OperationFrequency,
  type UserCorrection,
  type ProjectMemory,
  type MemoryConfig,
} from './AgentMemory';
