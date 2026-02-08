/**
 * Executor Phase - Plan Execution
 *
 * The third phase of the agentic loop that executes
 * the steps in a plan and collects results.
 *
 * Responsibilities:
 * - Execute plan steps in dependency order
 * - Support parallel execution for independent steps
 * - Handle errors and retries
 * - Track execution progress
 * - Support abort functionality
 * - Create execution records
 */

import type {
  IToolExecutor,
  ExecutionContext,
  ToolExecutionResult,
} from '../ports/IToolExecutor';
import type { Plan, PlanStep } from '../core/types';
import {
  ToolExecutionError,
  ExecutionTimeoutError,
  DependencyError,
  DoomLoopError,
} from '../core/errors';
import { DoomLoopDetector } from '../core/DoomLoopDetector';

// =============================================================================
// Types
// =============================================================================

/**
 * Configuration for the Executor phase
 */
export interface ExecutorConfig {
  /** Timeout for each step in milliseconds */
  stepTimeout?: number;
  /** Maximum retries per step on failure */
  maxRetries?: number;
  /** Stop execution on first error */
  stopOnError?: boolean;
  /** Enable parallel execution for independent steps */
  parallelExecution?: boolean;
}

/**
 * Default configuration values
 */
const DEFAULT_CONFIG: Required<ExecutorConfig> = {
  stepTimeout: 30000, // 30 seconds
  maxRetries: 0,
  stopOnError: true,
  parallelExecution: false,
};

/**
 * Execution progress phase
 */
export type ExecutionPhase =
  | 'started'
  | 'step_started'
  | 'step_completed'
  | 'step_failed'
  | 'completed'
  | 'aborted';

/**
 * Execution progress event
 */
export interface ExecutionProgress {
  phase: ExecutionPhase;
  stepId?: string;
  stepIndex?: number;
  totalSteps: number;
  completedCount: number;
  failedCount: number;
  message?: string;
  /** Tool execution result (only present for step_completed / step_failed) */
  result?: ToolExecutionResult;
}

/**
 * Record of a step execution
 */
export interface StepExecutionRecord {
  stepId: string;
  tool: string;
  args: Record<string, unknown>;
  result: ToolExecutionResult;
  startTime: number;
  endTime: number;
  retryCount: number;
}

/**
 * Result of plan execution
 */
export interface ExecutionResult {
  success: boolean;
  completedSteps: StepExecutionRecord[];
  failedSteps: StepExecutionRecord[];
  totalDuration: number;
  aborted: boolean;
}

// =============================================================================
// Executor Class
// =============================================================================

/**
 * Executor phase implementation
 *
 * Executes plan steps in order, respecting dependencies,
 * and handles errors and retries.
 *
 * @example
 * ```typescript
 * const executor = createExecutor(toolExecutor);
 * const result = await executor.execute(plan, context, (progress) => {
 *   console.log(`Step ${progress.stepIndex}/${progress.totalSteps}`);
 * });
 *
 * if (result.success) {
 *   console.log('All steps completed');
 * } else {
 *   console.log(`${result.failedSteps.length} steps failed`);
 * }
 * ```
 */
export class Executor {
  private readonly toolExecutor: IToolExecutor;
  private readonly config: Required<ExecutorConfig>;
  private readonly doomLoopDetector: DoomLoopDetector;
  private abortController: AbortController | null = null;
  private isAborted = false;

  constructor(toolExecutor: IToolExecutor, config: ExecutorConfig = {}) {
    this.toolExecutor = toolExecutor;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.doomLoopDetector = new DoomLoopDetector(3);
  }

  // ===========================================================================
  // Public Methods
  // ===========================================================================

  /**
   * Execute a plan
   *
   * @param plan - The plan to execute
   * @param context - Execution context
   * @param onProgress - Optional progress callback
   * @returns Execution result with completed and failed steps
   */
  async execute(
    plan: Plan,
    context: ExecutionContext,
    onProgress?: (progress: ExecutionProgress) => void
  ): Promise<ExecutionResult> {
    this.abortController = new AbortController();
    this.isAborted = false;
    this.doomLoopDetector.reset();

    const startTime = Date.now();
    const completedSteps: StepExecutionRecord[] = [];
    const failedSteps: StepExecutionRecord[] = [];
    const completedStepIds = new Set<string>();

    // Emit started event
    this.emitProgress(onProgress, {
      phase: 'started',
      totalSteps: plan.steps.length,
      completedCount: 0,
      failedCount: 0,
    });

    try {
      // Validate dependencies exist
      this.validateDependencies(plan.steps);

      // Get execution order based on dependencies
      const executionOrder = this.getExecutionOrder(plan.steps);

      for (let i = 0; i < executionOrder.length; i++) {
        if (this.isAborted) {
          break;
        }

        const step = executionOrder[i];

        // Check dependencies are satisfied
        this.checkDependencies(step, completedStepIds);

        // Emit step started
        this.emitProgress(onProgress, {
          phase: 'step_started',
          stepId: step.id,
          stepIndex: i,
          totalSteps: plan.steps.length,
          completedCount: completedSteps.length,
          failedCount: failedSteps.length,
          message: step.description,
        });

        // Check for doom loop before execution
        if (this.doomLoopDetector.check(step.tool, step.args)) {
          throw new DoomLoopError(step.tool, 3);
        }

        // Execute the step
        const record = await this.executeStep(step, context);

        if (record.result.success) {
          completedSteps.push(record);
          completedStepIds.add(step.id);

          this.emitProgress(onProgress, {
            phase: 'step_completed',
            stepId: step.id,
            stepIndex: i,
            totalSteps: plan.steps.length,
            completedCount: completedSteps.length,
            failedCount: failedSteps.length,
            result: record.result,
          });
        } else {
          failedSteps.push(record);

          this.emitProgress(onProgress, {
            phase: 'step_failed',
            stepId: step.id,
            stepIndex: i,
            totalSteps: plan.steps.length,
            completedCount: completedSteps.length,
            failedCount: failedSteps.length,
            message: record.result.error,
            result: record.result,
          });

          if (this.config.stopOnError) {
            break;
          }
        }
      }

      // Emit completed event
      this.emitProgress(onProgress, {
        phase: this.isAborted ? 'aborted' : 'completed',
        totalSteps: plan.steps.length,
        completedCount: completedSteps.length,
        failedCount: failedSteps.length,
      });

      return {
        success: failedSteps.length === 0 && !this.isAborted,
        completedSteps,
        failedSteps,
        totalDuration: Date.now() - startTime,
        aborted: this.isAborted,
      };
    } finally {
      this.abortController = null;
    }
  }

  /**
   * Abort ongoing execution
   */
  abort(): void {
    this.isAborted = true;
    if (this.abortController) {
      this.abortController.abort();
    }
  }

  // ===========================================================================
  // Private Methods - Step Execution
  // ===========================================================================

  /**
   * Execute a single step with retries and timeout
   */
  private async executeStep(
    step: PlanStep,
    context: ExecutionContext
  ): Promise<StepExecutionRecord> {
    const startTime = Date.now();
    let retryCount = 0;
    let lastResult: ToolExecutionResult | null = null;
    let lastError: Error | null = null;

    while (retryCount <= this.config.maxRetries) {
      if (this.isAborted) {
        return {
          stepId: step.id,
          tool: step.tool,
          args: step.args,
          result: {
            success: false,
            error: 'Execution aborted',
            duration: Date.now() - startTime,
          },
          startTime,
          endTime: Date.now(),
          retryCount,
        };
      }

      try {
        lastResult = await this.executeWithTimeout(
          () => this.toolExecutor.execute(step.tool, step.args, context),
          this.config.stepTimeout,
          step.id
        );

        if (lastResult.success) {
          return {
            stepId: step.id,
            tool: step.tool,
            args: step.args,
            result: lastResult,
            startTime,
            endTime: Date.now(),
            retryCount,
          };
        }

        // Tool returned failure, try again if retries available
        retryCount++;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Check if it's a timeout or abort - don't retry
        if (error instanceof ExecutionTimeoutError || this.isAborted) {
          throw error;
        }

        // Check if it's a tool error that was thrown
        if (lastError.message !== 'Execution aborted') {
          throw new ToolExecutionError(step.id, lastError);
        }

        retryCount++;
      }
    }

    // All retries exhausted
    return {
      stepId: step.id,
      tool: step.tool,
      args: step.args,
      result: lastResult ?? {
        success: false,
        error: lastError?.message ?? 'Unknown error',
        duration: Date.now() - startTime,
      },
      startTime,
      endTime: Date.now(),
      retryCount,
    };
  }

  /**
   * Execute operation with timeout
   */
  private async executeWithTimeout<T>(
    operation: () => Promise<T>,
    timeout: number,
    stepId: string
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      let timedOut = false;

      const timeoutId = setTimeout(() => {
        if (!settled) {
          timedOut = true;
          settled = true;
          this.isAborted = true;
          reject(new ExecutionTimeoutError(stepId, timeout));
        }
      }, timeout);

      if (this.isAborted) {
        clearTimeout(timeoutId);
        reject(new Error('Execution aborted'));
        return;
      }

      const handleAbort = () => {
        if (!settled && !timedOut) {
          settled = true;
          clearTimeout(timeoutId);
          reject(new Error('Execution aborted'));
        }
      };

      const signal = this.abortController?.signal;
      if (signal) {
        signal.addEventListener('abort', handleAbort);
      }

      const cleanup = () => {
        if (signal) {
          signal.removeEventListener('abort', handleAbort);
        }
      };

      operation()
        .then((result) => {
          if (!settled) {
            settled = true;
            clearTimeout(timeoutId);
            cleanup();
            resolve(result);
          }
        })
        .catch((error) => {
          if (!settled) {
            settled = true;
            clearTimeout(timeoutId);
            cleanup();
            reject(error);
          }
        });
    });
  }

  // ===========================================================================
  // Private Methods - Dependency Management
  // ===========================================================================

  /**
   * Validate that all dependencies in steps exist
   */
  private validateDependencies(steps: PlanStep[]): void {
    const stepIds = new Set(steps.map((s) => s.id));

    for (const step of steps) {
      if (step.dependsOn) {
        for (const depId of step.dependsOn) {
          if (!stepIds.has(depId)) {
            throw new DependencyError(step.id, [depId]);
          }
        }
      }
    }
  }

  /**
   * Check that all dependencies for a step have been completed
   */
  private checkDependencies(
    step: PlanStep,
    completedStepIds: Set<string>
  ): void {
    if (step.dependsOn) {
      const missing = step.dependsOn.filter((id) => !completedStepIds.has(id));
      if (missing.length > 0) {
        throw new DependencyError(step.id, missing);
      }
    }
  }

  /**
   * Get execution order based on dependencies (topological sort)
   */
  private getExecutionOrder(steps: PlanStep[]): PlanStep[] {
    if (steps.length === 0) {
      return [];
    }

    // Build dependency graph
    const stepMap = new Map(steps.map((s) => [s.id, s]));
    const inDegree = new Map<string, number>();
    const dependents = new Map<string, string[]>();

    for (const step of steps) {
      inDegree.set(step.id, step.dependsOn?.length ?? 0);
      dependents.set(step.id, []);
    }

    for (const step of steps) {
      if (step.dependsOn) {
        for (const depId of step.dependsOn) {
          const deps = dependents.get(depId) ?? [];
          deps.push(step.id);
          dependents.set(depId, deps);
        }
      }
    }

    // Kahn's algorithm
    const result: PlanStep[] = [];
    const queue: string[] = [];

    // Find all steps with no dependencies
    for (const [id, degree] of inDegree) {
      if (degree === 0) {
        queue.push(id);
      }
    }

    while (queue.length > 0) {
      const id = queue.shift()!;
      const step = stepMap.get(id)!;
      result.push(step);

      for (const depId of dependents.get(id) ?? []) {
        const newDegree = (inDegree.get(depId) ?? 0) - 1;
        inDegree.set(depId, newDegree);
        if (newDegree === 0) {
          queue.push(depId);
        }
      }
    }

    // Detect cycles - if not all steps were processed, there's a cycle
    if (result.length !== steps.length) {
      const remaining = steps
        .filter((s) => !result.some((r) => r.id === s.id))
        .map((s) => s.id);
      throw new DependencyError(remaining[0] ?? 'unknown', remaining);
    }

    return result;
  }

  // ===========================================================================
  // Private Methods - Progress
  // ===========================================================================

  /**
   * Emit progress event if callback provided
   */
  private emitProgress(
    onProgress: ((progress: ExecutionProgress) => void) | undefined,
    progress: ExecutionProgress
  ): void {
    if (onProgress) {
      onProgress(progress);
    }
  }
}

// =============================================================================
// Factory Functions
// =============================================================================

/**
 * Create a new Executor instance
 *
 * @param toolExecutor - Tool executor for running tools
 * @param config - Optional configuration
 * @returns Configured Executor instance
 */
export function createExecutor(
  toolExecutor: IToolExecutor,
  config?: ExecutorConfig
): Executor {
  return new Executor(toolExecutor, config);
}
