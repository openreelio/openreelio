/**
 * Agent Core Module
 *
 * Exports the memory system (still used by MemoryManagerAdapter).
 * Hook system and HookableAgent have been removed with the legacy agent.
 */

// Memory system
export {
  MemoryManager,
  createMemoryManager,
  type AgentMessage,
  type ShortTermMemory,
  type LongTermMemory,
  type OperationFrequency,
  type UserCorrection,
  type ProjectMemory,
  type MemoryConfig,
} from './AgentMemory';
