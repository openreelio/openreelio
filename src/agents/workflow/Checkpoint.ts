/**
 * Checkpoint
 *
 * Recovery checkpoint system for workflow state persistence.
 * Enables rollback on failure and crash recovery.
 */

import type { WorkflowState, WorkflowStep } from './WorkflowState';
import { createLogger } from '@/services/logger';

const logger = createLogger('Checkpoint');

// =============================================================================
// Types
// =============================================================================

/**
 * A checkpoint snapshot of workflow state.
 */
export interface Checkpoint {
  /** Unique checkpoint identifier */
  id: string;
  /** Associated workflow ID */
  workflowId: string;
  /** The workflow state at checkpoint time */
  state: WorkflowState;
  /** When the checkpoint was created */
  createdAt: number;
  /** Description of what was checkpointed */
  description: string;
  /** Optional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Configuration for checkpoint manager.
 */
export interface CheckpointConfig {
  /** Maximum checkpoints to keep per workflow */
  maxCheckpointsPerWorkflow?: number;
  /** Storage adapter for persistence (optional) */
  storage?: CheckpointStorage;
}

/**
 * Storage interface for checkpoint persistence.
 */
export interface CheckpointStorage {
  /** Save a checkpoint */
  save(checkpoint: Checkpoint): Promise<void>;
  /** Load a checkpoint by ID */
  load(id: string): Promise<Checkpoint | null>;
  /** Load all checkpoints for a workflow */
  loadForWorkflow(workflowId: string): Promise<Checkpoint[]>;
  /** Delete a checkpoint */
  delete(id: string): Promise<void>;
  /** Delete all checkpoints for a workflow */
  deleteForWorkflow(workflowId: string): Promise<void>;
}

// =============================================================================
// In-Memory Storage
// =============================================================================

/**
 * Simple in-memory storage for checkpoints.
 * Suitable for testing or when persistence is not required.
 */
export class InMemoryCheckpointStorage implements CheckpointStorage {
  private checkpoints: Map<string, Checkpoint> = new Map();

  async save(checkpoint: Checkpoint): Promise<void> {
    this.checkpoints.set(checkpoint.id, checkpoint);
  }

  async load(id: string): Promise<Checkpoint | null> {
    return this.checkpoints.get(id) ?? null;
  }

  async loadForWorkflow(workflowId: string): Promise<Checkpoint[]> {
    return Array.from(this.checkpoints.values())
      .filter((cp) => cp.workflowId === workflowId)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  async delete(id: string): Promise<void> {
    this.checkpoints.delete(id);
  }

  async deleteForWorkflow(workflowId: string): Promise<void> {
    for (const [id, checkpoint] of this.checkpoints) {
      if (checkpoint.workflowId === workflowId) {
        this.checkpoints.delete(id);
      }
    }
  }

  /** For testing: clear all checkpoints */
  clear(): void {
    this.checkpoints.clear();
  }

  /** For testing: get count */
  getCount(): number {
    return this.checkpoints.size;
  }
}

// =============================================================================
// Checkpoint Manager
// =============================================================================

/**
 * Manages checkpoint creation, storage, and recovery.
 *
 * Features:
 * - Automatic checkpoint creation at key workflow points
 * - Configurable retention policy
 * - Pluggable storage backends
 * - State restoration for rollback
 *
 * @example
 * ```typescript
 * const manager = new CheckpointManager({ maxCheckpointsPerWorkflow: 5 });
 *
 * // Create a checkpoint before executing a step
 * await manager.createCheckpoint(workflow, 'Before step execution');
 *
 * // If something fails, restore
 * const latestCheckpoint = await manager.getLatestCheckpoint(workflow.id);
 * if (latestCheckpoint) {
 *   const restoredState = manager.restoreFromCheckpoint(latestCheckpoint);
 * }
 * ```
 */
export class CheckpointManager {
  private storage: CheckpointStorage;
  private maxCheckpointsPerWorkflow: number;

  constructor(config: CheckpointConfig = {}) {
    this.storage = config.storage ?? new InMemoryCheckpointStorage();
    this.maxCheckpointsPerWorkflow = config.maxCheckpointsPerWorkflow ?? 10;
  }

  // ===========================================================================
  // Checkpoint Creation
  // ===========================================================================

  /**
   * Create a checkpoint for the current workflow state.
   *
   * @param workflow - Current workflow state
   * @param description - Description of the checkpoint
   * @param metadata - Optional metadata
   * @returns The created checkpoint
   */
  async createCheckpoint(
    workflow: WorkflowState,
    description: string,
    metadata?: Record<string, unknown>
  ): Promise<Checkpoint> {
    const checkpoint: Checkpoint = {
      id: crypto.randomUUID(),
      workflowId: workflow.id,
      state: this.deepCloneState(workflow),
      createdAt: Date.now(),
      description,
      metadata,
    };

    await this.storage.save(checkpoint);
    await this.enforceRetentionPolicy(workflow.id);

    logger.debug('Checkpoint created', {
      checkpointId: checkpoint.id,
      workflowId: workflow.id,
      description,
    });

    return checkpoint;
  }

  /**
   * Create a checkpoint before executing a specific step.
   *
   * @param workflow - Current workflow state
   * @param step - The step about to be executed
   * @returns The created checkpoint
   */
  async checkpointBeforeStep(
    workflow: WorkflowState,
    step: WorkflowStep
  ): Promise<Checkpoint> {
    return this.createCheckpoint(
      workflow,
      `Before step: ${step.description}`,
      { stepId: step.id, stepIndex: workflow.currentStepIndex }
    );
  }

  // ===========================================================================
  // Checkpoint Retrieval
  // ===========================================================================

  /**
   * Get a checkpoint by ID.
   *
   * @param checkpointId - The checkpoint ID
   * @returns The checkpoint or null
   */
  async getCheckpoint(checkpointId: string): Promise<Checkpoint | null> {
    return this.storage.load(checkpointId);
  }

  /**
   * Get the latest checkpoint for a workflow.
   *
   * @param workflowId - The workflow ID
   * @returns The latest checkpoint or null
   */
  async getLatestCheckpoint(workflowId: string): Promise<Checkpoint | null> {
    const checkpoints = await this.storage.loadForWorkflow(workflowId);
    return checkpoints.length > 0 ? checkpoints[0] : null;
  }

  /**
   * Get all checkpoints for a workflow (newest first).
   *
   * @param workflowId - The workflow ID
   * @returns Array of checkpoints
   */
  async getCheckpointsForWorkflow(workflowId: string): Promise<Checkpoint[]> {
    return this.storage.loadForWorkflow(workflowId);
  }

  // ===========================================================================
  // Restoration
  // ===========================================================================

  /**
   * Restore workflow state from a checkpoint.
   *
   * @param checkpoint - The checkpoint to restore from
   * @returns The restored workflow state
   */
  restoreFromCheckpoint(checkpoint: Checkpoint): WorkflowState {
    logger.info('Restoring from checkpoint', {
      checkpointId: checkpoint.id,
      workflowId: checkpoint.workflowId,
      description: checkpoint.description,
    });

    return this.deepCloneState(checkpoint.state);
  }

  /**
   * Restore to the latest checkpoint for a workflow.
   *
   * @param workflowId - The workflow ID
   * @returns The restored state or null if no checkpoints
   */
  async restoreToLatest(workflowId: string): Promise<WorkflowState | null> {
    const latest = await this.getLatestCheckpoint(workflowId);
    if (!latest) {
      return null;
    }
    return this.restoreFromCheckpoint(latest);
  }

  // ===========================================================================
  // Cleanup
  // ===========================================================================

  /**
   * Delete a checkpoint.
   *
   * @param checkpointId - The checkpoint ID
   */
  async deleteCheckpoint(checkpointId: string): Promise<void> {
    await this.storage.delete(checkpointId);
    logger.debug('Checkpoint deleted', { checkpointId });
  }

  /**
   * Delete all checkpoints for a workflow.
   *
   * @param workflowId - The workflow ID
   */
  async deleteWorkflowCheckpoints(workflowId: string): Promise<void> {
    await this.storage.deleteForWorkflow(workflowId);
    logger.debug('Workflow checkpoints deleted', { workflowId });
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  private async enforceRetentionPolicy(workflowId: string): Promise<void> {
    const checkpoints = await this.storage.loadForWorkflow(workflowId);

    if (checkpoints.length > this.maxCheckpointsPerWorkflow) {
      // Delete oldest checkpoints (they're sorted newest first)
      const toDelete = checkpoints.slice(this.maxCheckpointsPerWorkflow);
      for (const cp of toDelete) {
        await this.storage.delete(cp.id);
      }

      logger.debug('Enforced retention policy', {
        workflowId,
        deleted: toDelete.length,
      });
    }
  }

  private deepCloneState(state: WorkflowState): WorkflowState {
    return JSON.parse(JSON.stringify(state));
  }
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create a new CheckpointManager instance.
 */
export function createCheckpointManager(config?: CheckpointConfig): CheckpointManager {
  return new CheckpointManager(config);
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Calculate the state diff between two checkpoints.
 *
 * @param older - The older checkpoint
 * @param newer - The newer checkpoint
 * @returns Summary of changes
 */
export function getCheckpointDiff(
  older: Checkpoint,
  newer: Checkpoint
): {
  phaseChanged: boolean;
  stepsChanged: number;
  newPhase?: string;
  completedSteps: string[];
} {
  const olderState = older.state;
  const newerState = newer.state;

  const completedSteps: string[] = [];
  let stepsChanged = 0;

  for (let i = 0; i < newerState.steps.length; i++) {
    const olderStep = olderState.steps[i];
    const newerStep = newerState.steps[i];

    if (olderStep?.status !== newerStep?.status) {
      stepsChanged++;
      if (newerStep?.status === 'completed') {
        completedSteps.push(newerStep.id);
      }
    }
  }

  return {
    phaseChanged: olderState.phase !== newerState.phase,
    stepsChanged,
    newPhase: olderState.phase !== newerState.phase ? newerState.phase : undefined,
    completedSteps,
  };
}
