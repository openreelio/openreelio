/**
 * Workflow Engine
 *
 * State machine for managing multi-step agent operations.
 * Coordinates planning, approval, execution, and recovery.
 */

import {
  type WorkflowState,
  type WorkflowStep,
  type WorkflowPhase,
  createWorkflowState,
  isValidTransition,
  isTerminalPhase,
  canCancel,
  getWorkflowProgress,
} from './WorkflowState';
import {
  ApprovalGate,
  createApprovalGate,
  workflowRequiresApproval,
  type ApprovalGateConfig,
  type ApprovalResponse,
} from './ApprovalGate';
import {
  CheckpointManager,
  createCheckpointManager,
  type CheckpointConfig,
} from './Checkpoint';
import { createLogger } from '@/services/logger';

const logger = createLogger('WorkflowEngine');

// =============================================================================
// Types
// =============================================================================

/**
 * Workflow event types.
 */
export type WorkflowEventType =
  | 'phaseChange'
  | 'stepStart'
  | 'stepComplete'
  | 'stepFailed'
  | 'approvalRequired'
  | 'approvalReceived'
  | 'workflowComplete'
  | 'workflowFailed'
  | 'workflowCancelled';

/**
 * Workflow event data.
 */
export interface WorkflowEvent {
  type: WorkflowEventType;
  workflowId: string;
  timestamp: number;
  data?: {
    phase?: WorkflowPhase;
    previousPhase?: WorkflowPhase;
    step?: WorkflowStep;
    stepIndex?: number;
    error?: string;
    progress?: number;
    approvalResponse?: ApprovalResponse;
  };
}

/**
 * Event handler for workflow events.
 */
export type WorkflowEventHandler = (event: WorkflowEvent) => void;

/**
 * Step executor function.
 */
export type StepExecutor = (step: WorkflowStep) => Promise<{
  success: boolean;
  result?: unknown;
  error?: string;
}>;

/**
 * Configuration for the workflow engine.
 */
export interface WorkflowEngineConfig {
  /** Configuration for approval gate */
  approvalConfig?: ApprovalGateConfig;
  /** Configuration for checkpoint manager */
  checkpointConfig?: CheckpointConfig;
  /** Whether to create checkpoints before each step */
  checkpointBeforeSteps?: boolean;
  /** Whether to automatically request approval for high-risk workflows */
  autoRequestApproval?: boolean;
}

// =============================================================================
// Workflow Engine
// =============================================================================

/**
 * Manages workflow lifecycle and step execution.
 *
 * Features:
 * - State machine with phase transitions
 * - Automatic checkpoint creation
 * - Human-in-the-loop approval
 * - Rollback on failure
 * - Event-based progress tracking
 *
 * @example
 * ```typescript
 * const engine = new WorkflowEngine();
 *
 * // Create a workflow
 * const workflow = engine.createWorkflow('Cut clip at 5 seconds', [
 *   { toolName: 'split_clip', args: { time: 5 }, description: 'Split clip' },
 *   { toolName: 'delete_clip', args: {}, description: 'Delete part', requiresApproval: true },
 * ]);
 *
 * // Subscribe to events
 * engine.onEvent((event) => console.log(event.type));
 *
 * // Execute
 * const executor: StepExecutor = async (step) => {
 *   const result = await executeToolCall(step.toolName, step.args);
 *   return { success: true, result };
 * };
 *
 * await engine.execute(workflow.id, executor);
 * ```
 */
export class WorkflowEngine {
  private workflows: Map<string, WorkflowState> = new Map();
  private eventHandlers: Set<WorkflowEventHandler> = new Set();
  private approvalGate: ApprovalGate;
  private checkpointManager: CheckpointManager;
  private checkpointBeforeSteps: boolean;
  private autoRequestApproval: boolean;

  constructor(config: WorkflowEngineConfig = {}) {
    this.approvalGate = createApprovalGate(config.approvalConfig);
    this.checkpointManager = createCheckpointManager(config.checkpointConfig);
    this.checkpointBeforeSteps = config.checkpointBeforeSteps ?? true;
    this.autoRequestApproval = config.autoRequestApproval ?? true;
  }

  // ===========================================================================
  // Workflow Creation
  // ===========================================================================

  /**
   * Create a new workflow.
   *
   * @param intent - User's intent
   * @param steps - Steps to execute
   * @returns The created workflow
   */
  createWorkflow(
    intent: string,
    steps: Omit<WorkflowStep, 'id' | 'status'>[]
  ): WorkflowState {
    const workflow = createWorkflowState(intent, steps);
    this.workflows.set(workflow.id, workflow);

    logger.info('Workflow created', {
      workflowId: workflow.id,
      intent,
      stepCount: steps.length,
    });

    return workflow;
  }

  /**
   * Get a workflow by ID.
   *
   * @param workflowId - The workflow ID
   * @returns The workflow or undefined
   */
  getWorkflow(workflowId: string): WorkflowState | undefined {
    return this.workflows.get(workflowId);
  }

  /**
   * Get all active workflows.
   */
  getActiveWorkflows(): WorkflowState[] {
    return Array.from(this.workflows.values()).filter(
      (w) => !isTerminalPhase(w.phase)
    );
  }

  // ===========================================================================
  // Phase Transitions
  // ===========================================================================

  /**
   * Transition workflow to a new phase.
   *
   * @param workflowId - The workflow ID
   * @param newPhase - Target phase
   * @returns Whether transition succeeded
   */
  transition(workflowId: string, newPhase: WorkflowPhase): boolean {
    const workflow = this.workflows.get(workflowId);
    if (!workflow) {
      logger.warn('Transition failed: workflow not found', { workflowId });
      return false;
    }

    if (!isValidTransition(workflow.phase, newPhase)) {
      logger.warn('Invalid transition', {
        workflowId,
        from: workflow.phase,
        to: newPhase,
      });
      return false;
    }

    const previousPhase = workflow.phase;
    workflow.phase = newPhase;

    if (isTerminalPhase(newPhase)) {
      workflow.completedAt = Date.now();
    }

    this.emitEvent({
      type: 'phaseChange',
      workflowId,
      timestamp: Date.now(),
      data: { phase: newPhase, previousPhase },
    });

    logger.debug('Phase transition', {
      workflowId,
      from: previousPhase,
      to: newPhase,
    });

    return true;
  }

  // ===========================================================================
  // Execution
  // ===========================================================================

  /**
   * Execute a workflow.
   *
   * @param workflowId - The workflow ID
   * @param executor - Function to execute each step
   * @returns Execution result
   */
  async execute(
    workflowId: string,
    executor: StepExecutor
  ): Promise<{
    success: boolean;
    completedSteps: number;
    error?: string;
  }> {
    const workflow = this.workflows.get(workflowId);
    if (!workflow) {
      return { success: false, completedSteps: 0, error: 'Workflow not found' };
    }

    try {
      // Start analysis phase
      this.transition(workflowId, 'analyzing');

      // Move to planning phase
      this.transition(workflowId, 'planning');

      // Check if approval is needed
      if (this.autoRequestApproval && workflowRequiresApproval(workflow)) {
        this.transition(workflowId, 'awaiting_approval');

        const request = this.approvalGate.createRequest(workflow);
        if (request) {
          this.emitEvent({
            type: 'approvalRequired',
            workflowId,
            timestamp: Date.now(),
          });

          try {
            const response = await this.approvalGate.waitForResponse(request.id);

            this.emitEvent({
              type: 'approvalReceived',
              workflowId,
              timestamp: Date.now(),
              data: { approvalResponse: response },
            });

            if (!response.approved) {
              workflow.approvalStatus = 'rejected';
              workflow.rejectionReason = response.reason;
              this.transition(workflowId, 'idle');
              return {
                success: false,
                completedSteps: 0,
                error: `Approval rejected: ${response.reason ?? 'No reason provided'}`,
              };
            }

            workflow.approvalStatus = 'approved';
          } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            this.transition(workflowId, 'cancelled');
            return { success: false, completedSteps: 0, error: errorMsg };
          }
        }
      }

      // Begin execution
      this.transition(workflowId, 'executing');

      // Create initial checkpoint
      await this.checkpointManager.createCheckpoint(
        workflow,
        'Execution started'
      );

      let completedSteps = 0;

      // Execute steps
      for (let i = 0; i < workflow.steps.length; i++) {
        const step = workflow.steps[i];
        workflow.currentStepIndex = i;

        // Create checkpoint before step if enabled
        if (this.checkpointBeforeSteps) {
          await this.checkpointManager.checkpointBeforeStep(workflow, step);
        }

        // Start step
        step.status = 'in_progress';
        step.startedAt = Date.now();

        this.emitEvent({
          type: 'stepStart',
          workflowId,
          timestamp: Date.now(),
          data: { step, stepIndex: i },
        });

        try {
          const result = await executor(step);

          if (result.success) {
            step.status = 'completed';
            step.result = result.result;
            step.completedAt = Date.now();
            completedSteps++;

            this.emitEvent({
              type: 'stepComplete',
              workflowId,
              timestamp: Date.now(),
              data: {
                step,
                stepIndex: i,
                progress: getWorkflowProgress(workflow),
              },
            });
          } else {
            step.status = 'failed';
            step.error = result.error;
            step.completedAt = Date.now();

            this.emitEvent({
              type: 'stepFailed',
              workflowId,
              timestamp: Date.now(),
              data: { step, stepIndex: i, error: result.error },
            });

            // Stop execution on failure
            throw new Error(result.error ?? 'Step execution failed');
          }
        } catch (error) {
          if (step.status !== 'failed') {
            step.status = 'failed';
            step.error = error instanceof Error ? error.message : String(error);
            step.completedAt = Date.now();
          }

          throw error;
        }
      }

      // Verification phase
      this.transition(workflowId, 'verifying');

      // Mark complete
      this.transition(workflowId, 'complete');

      this.emitEvent({
        type: 'workflowComplete',
        workflowId,
        timestamp: Date.now(),
        data: { progress: 100 },
      });

      return { success: true, completedSteps };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      workflow.error = errorMsg;

      this.transition(workflowId, 'failed');

      this.emitEvent({
        type: 'workflowFailed',
        workflowId,
        timestamp: Date.now(),
        data: { error: errorMsg },
      });

      return {
        success: false,
        completedSteps: workflow.steps.filter((s) => s.status === 'completed').length,
        error: errorMsg,
      };
    }
  }

  // ===========================================================================
  // Approval Integration
  // ===========================================================================

  /**
   * Submit approval for a workflow.
   *
   * @param workflowId - The workflow ID
   * @param approved - Whether approved
   * @param reason - Optional reason for rejection
   */
  submitApproval(
    workflowId: string,
    approved: boolean,
    reason?: string
  ): void {
    const pending = this.approvalGate.getPendingRequests();
    const request = pending.find((r) => r.workflowId === workflowId);

    if (request) {
      this.approvalGate.respond({
        requestId: request.id,
        approved,
        reason,
        respondedAt: Date.now(),
      });
    }
  }

  /**
   * Get the approval gate for advanced configuration.
   */
  getApprovalGate(): ApprovalGate {
    return this.approvalGate;
  }

  // ===========================================================================
  // Cancellation & Rollback
  // ===========================================================================

  /**
   * Cancel a workflow.
   *
   * @param workflowId - The workflow ID
   * @returns Whether cancellation succeeded
   */
  cancel(workflowId: string): boolean {
    const workflow = this.workflows.get(workflowId);
    if (!workflow) {
      return false;
    }

    if (!canCancel(workflow.phase)) {
      logger.warn('Cannot cancel workflow in current phase', {
        workflowId,
        phase: workflow.phase,
      });
      return false;
    }

    // Cancel any pending approval
    const pending = this.approvalGate.getPendingRequests();
    const request = pending.find((r) => r.workflowId === workflowId);
    if (request) {
      this.approvalGate.cancelRequest(request.id);
    }

    this.transition(workflowId, 'cancelled');

    this.emitEvent({
      type: 'workflowCancelled',
      workflowId,
      timestamp: Date.now(),
    });

    return true;
  }

  /**
   * Rollback a workflow to its last checkpoint.
   *
   * @param workflowId - The workflow ID
   * @returns The restored state or null
   */
  async rollback(workflowId: string): Promise<WorkflowState | null> {
    const workflow = this.workflows.get(workflowId);
    if (!workflow) {
      return null;
    }

    const restored = await this.checkpointManager.restoreToLatest(workflowId);
    if (!restored) {
      logger.warn('No checkpoint available for rollback', { workflowId });
      return null;
    }

    restored.phase = 'rolled_back';
    this.workflows.set(workflowId, restored);

    logger.info('Workflow rolled back', { workflowId });

    return restored;
  }

  // ===========================================================================
  // Event Handling
  // ===========================================================================

  /**
   * Subscribe to workflow events.
   *
   * @param handler - Event handler function
   * @returns Unsubscribe function
   */
  onEvent(handler: WorkflowEventHandler): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  private emitEvent(event: WorkflowEvent): void {
    for (const handler of this.eventHandlers) {
      try {
        handler(event);
      } catch (error) {
        logger.error('Error in workflow event handler', { error });
      }
    }
  }

  // ===========================================================================
  // Cleanup
  // ===========================================================================

  /**
   * Remove a workflow from the engine.
   *
   * @param workflowId - The workflow ID
   * @param deleteCheckpoints - Whether to delete checkpoints
   */
  async removeWorkflow(
    workflowId: string,
    deleteCheckpoints = false
  ): Promise<void> {
    this.workflows.delete(workflowId);

    if (deleteCheckpoints) {
      await this.checkpointManager.deleteWorkflowCheckpoints(workflowId);
    }

    logger.debug('Workflow removed', { workflowId, deleteCheckpoints });
  }

  /**
   * Clear all workflows.
   */
  async clearAll(): Promise<void> {
    this.workflows.clear();
    this.approvalGate.clearAll();
    logger.debug('All workflows cleared');
  }
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create a new WorkflowEngine instance.
 */
export function createWorkflowEngine(config?: WorkflowEngineConfig): WorkflowEngine {
  return new WorkflowEngine(config);
}
