/**
 * ICheckpointStore - Checkpoint Storage Interface
 *
 * Defines the contract for storing and retrieving agent state checkpoints.
 * Enables recovery from failures and rollback capabilities.
 */

import type { AgentState, AgentPhase, ExecutionRecord } from '../core/types';

// =============================================================================
// Types
// =============================================================================

/**
 * A checkpoint of agent state
 */
export interface AgentCheckpoint {
  /** Unique checkpoint identifier */
  id: string;
  /** Session this checkpoint belongs to */
  sessionId: string;
  /** Phase when checkpoint was created */
  phase: AgentPhase;
  /** Iteration number */
  iteration: number;
  /** Complete agent state snapshot */
  state: AgentState;
  /** When checkpoint was created */
  createdAt: number;
  /** Description of checkpoint */
  description: string;
  /** Metadata */
  metadata: Record<string, unknown>;
}

/**
 * Checkpoint creation options
 */
export interface CheckpointOptions {
  /** Description for the checkpoint */
  description?: string;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
  /** Whether to include full execution history */
  includeHistory?: boolean;
}

/**
 * Checkpoint query options
 */
export interface CheckpointQueryOptions {
  /** Filter by session */
  sessionId?: string;
  /** Filter by phase */
  phase?: AgentPhase;
  /** Maximum results */
  limit?: number;
  /** Order by creation time */
  order?: 'asc' | 'desc';
}

/**
 * Diff between two checkpoints
 */
export interface CheckpointDiff {
  /** Phases differ */
  phaseChanged: boolean;
  /** From phase */
  fromPhase?: AgentPhase;
  /** To phase */
  toPhase?: AgentPhase;
  /** Iterations differ */
  iterationChanged: boolean;
  /** Plan changed */
  planChanged: boolean;
  /** Number of new executions */
  newExecutions: number;
  /** Error state changed */
  errorChanged: boolean;
}

/**
 * Restoration result
 */
export interface RestoreResult {
  /** Whether restore succeeded */
  success: boolean;
  /** Restored state */
  state?: AgentState;
  /** Checkpoint that was restored */
  checkpoint?: AgentCheckpoint;
  /** Error if failed */
  error?: string;
}

// =============================================================================
// Interface
// =============================================================================

/**
 * Checkpoint Store interface for state persistence
 *
 * Implementations:
 * - CheckpointManagerAdapter: Uses existing CheckpointManager
 * - InMemoryCheckpointStore: Memory-only storage
 * - LocalStorageCheckpointStore: Browser localStorage
 * - MockCheckpointStore: Testing
 */
export interface ICheckpointStore {
  // ===========================================================================
  // Checkpoint Creation
  // ===========================================================================

  /**
   * Create a checkpoint of current state
   *
   * @param state - Agent state to checkpoint
   * @param options - Checkpoint options
   * @returns Created checkpoint
   */
  createCheckpoint(
    state: AgentState,
    options?: CheckpointOptions
  ): Promise<AgentCheckpoint>;

  /**
   * Create checkpoint before a specific action
   *
   * @param state - Agent state
   * @param stepId - Step about to execute
   * @returns Created checkpoint
   */
  checkpointBeforeStep(
    state: AgentState,
    stepId: string
  ): Promise<AgentCheckpoint>;

  /**
   * Create checkpoint after a specific action
   *
   * @param state - Agent state
   * @param stepId - Step that was executed
   * @param result - Execution result
   * @returns Created checkpoint
   */
  checkpointAfterStep(
    state: AgentState,
    stepId: string,
    result: ExecutionRecord
  ): Promise<AgentCheckpoint>;

  // ===========================================================================
  // Checkpoint Retrieval
  // ===========================================================================

  /**
   * Get a checkpoint by ID
   *
   * @param checkpointId - Checkpoint identifier
   * @returns Checkpoint or null
   */
  getCheckpoint(checkpointId: string): Promise<AgentCheckpoint | null>;

  /**
   * Get the latest checkpoint for a session
   *
   * @param sessionId - Session identifier
   * @returns Latest checkpoint or null
   */
  getLatestCheckpoint(sessionId: string): Promise<AgentCheckpoint | null>;

  /**
   * Get all checkpoints for a session
   *
   * @param sessionId - Session identifier
   * @param options - Query options
   * @returns Array of checkpoints
   */
  getSessionCheckpoints(
    sessionId: string,
    options?: CheckpointQueryOptions
  ): Promise<AgentCheckpoint[]>;

  /**
   * Query checkpoints
   *
   * @param options - Query options
   * @returns Array of checkpoints
   */
  queryCheckpoints(options: CheckpointQueryOptions): Promise<AgentCheckpoint[]>;

  // ===========================================================================
  // State Restoration
  // ===========================================================================

  /**
   * Restore state from a checkpoint
   *
   * @param checkpointId - Checkpoint to restore
   * @returns Restoration result
   */
  restoreFromCheckpoint(checkpointId: string): Promise<RestoreResult>;

  /**
   * Restore to the latest checkpoint
   *
   * @param sessionId - Session identifier
   * @returns Restoration result
   */
  restoreToLatest(sessionId: string): Promise<RestoreResult>;

  /**
   * Restore to checkpoint before a specific step
   *
   * @param sessionId - Session identifier
   * @param stepId - Step to restore before
   * @returns Restoration result
   */
  restoreBeforeStep(sessionId: string, stepId: string): Promise<RestoreResult>;

  // ===========================================================================
  // Checkpoint Comparison
  // ===========================================================================

  /**
   * Get diff between two checkpoints
   *
   * @param fromId - First checkpoint
   * @param toId - Second checkpoint
   * @returns Diff between checkpoints
   */
  getCheckpointDiff(fromId: string, toId: string): Promise<CheckpointDiff | null>;

  // ===========================================================================
  // Checkpoint Management
  // ===========================================================================

  /**
   * Delete a checkpoint
   *
   * @param checkpointId - Checkpoint to delete
   */
  deleteCheckpoint(checkpointId: string): Promise<void>;

  /**
   * Delete all checkpoints for a session
   *
   * @param sessionId - Session identifier
   */
  deleteSessionCheckpoints(sessionId: string): Promise<void>;

  /**
   * Prune old checkpoints
   *
   * @param maxAge - Maximum age in milliseconds
   * @param maxPerSession - Maximum checkpoints per session
   */
  pruneCheckpoints(maxAge?: number, maxPerSession?: number): Promise<number>;

  /**
   * Get checkpoint count
   *
   * @param sessionId - Optional session filter
   * @returns Number of checkpoints
   */
  getCheckpointCount(sessionId?: string): Promise<number>;
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Create a checkpoint from agent state
 */
export function createCheckpointFromState(
  state: AgentState,
  description: string,
  metadata: Record<string, unknown> = {}
): Omit<AgentCheckpoint, 'id' | 'createdAt'> {
  return {
    sessionId: state.sessionId,
    phase: state.phase,
    iteration: state.iteration,
    state: deepCloneState(state),
    description,
    metadata,
  };
}

/**
 * Deep clone agent state
 */
export function deepCloneState(state: AgentState): AgentState {
  return JSON.parse(JSON.stringify(state));
}

function sortObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortObjectKeys);
  }

  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};

    for (const key of Object.keys(record).sort()) {
      sorted[key] = sortObjectKeys(record[key]);
    }

    return sorted;
  }

  return value;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortObjectKeys(value));
}

function getPlanSignature(plan: AgentState['plan']): string | null {
  if (!plan) return null;
  return stableStringify(plan);
}

/**
 * Calculate diff between two checkpoints
 */
export function calculateCheckpointDiff(
  from: AgentCheckpoint,
  to: AgentCheckpoint
): CheckpointDiff {
  const fromHistory = from.state.executionHistory.length;
  const toHistory = to.state.executionHistory.length;

  return {
    phaseChanged: from.phase !== to.phase,
    fromPhase: from.phase,
    toPhase: to.phase,
    iterationChanged: from.iteration !== to.iteration,
    planChanged: getPlanSignature(from.state.plan) !== getPlanSignature(to.state.plan),
    newExecutions: Math.max(0, toHistory - fromHistory),
    errorChanged: (from.state.error !== null) !== (to.state.error !== null),
  };
}
