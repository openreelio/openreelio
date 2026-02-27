/**
 * BackendToolExecutor
 *
 * Routes tool execution between backend IPC (for editing tools) and
 * frontend ToolRegistryAdapter (for analysis/utility tools).
 *
 * When the USE_BACKEND_TOOLS feature flag is enabled, editing tools
 * (clip, track, effect, transition, audio, caption) are dispatched to
 * the backend `execute_agent_plan` IPC endpoint for atomic execution
 * with rollback support. Analysis and utility tools remain on the frontend.
 *
 * Implements the IToolExecutor interface.
 */

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

import type {
  IToolExecutor,
  ExecutionContext,
  ToolExecutionResult,
  ToolInfo,
  ToolDefinition,
  BatchExecutionRequest,
  BatchExecutionResult,
} from '../../ports/IToolExecutor';
import { createFailureResult } from '../../ports/IToolExecutor';
import type { RiskLevel, ValidationResult } from '../../core/types';
import type { AgentPlan, AgentPlanResult } from '@/bindings';
import { createLogger } from '@/services/logger';

const logger = createLogger('BackendToolExecutor');

// =============================================================================
// Constants
// =============================================================================

/** Tool categories that route to the backend for atomic execution */
const BACKEND_CATEGORIES = new Set([
  'clip',
  'track',
  'timeline',
  'effect',
  'transition',
  'audio',
  'caption',
  'asset',
]);

/**
 * Compound tool expander function signature.
 * Takes tool args and returns an array of primitive plan steps
 * that the backend can execute atomically.
 */
export type CompoundExpander = (
  args: Record<string, unknown>,
) => Array<{ toolName: string; params: Record<string, unknown>; dependsOn?: string[] }>;

/**
 * Registry of compound tools that need expansion into primitive steps.
 * Compound tools like ripple_edit, roll_edit, slip_edit, slide_edit
 * generate multiple sub-steps sent as a single atomic plan.
 */
const compoundExpanders = new Map<string, CompoundExpander>();

/**
 * Register a compound tool expander.
 */
export function registerCompoundExpander(toolName: string, expander: CompoundExpander): void {
  compoundExpanders.set(toolName, expander);
}

/**
 * Unregister a compound tool expander.
 */
export function unregisterCompoundExpander(toolName: string): void {
  compoundExpanders.delete(toolName);
}

/**
 * Check if a tool has a compound expander registered.
 */
export function hasCompoundExpander(toolName: string): boolean {
  return compoundExpanders.has(toolName);
}

// =============================================================================
// Types
// =============================================================================

interface PlanStepEvent {
  planId: string;
  stepId: string;
  stepIndex: number;
  totalSteps: number;
}

interface PlanStepCompleteEvent extends PlanStepEvent {
  operationId: string | null;
  durationMs: number;
}

interface PlanStepFailedEvent extends PlanStepEvent {
  error: string;
}

// =============================================================================
// Implementation
// =============================================================================

/**
 * BackendToolExecutor routes editing tools to the backend plan executor
 * and delegates analysis/utility tools to the frontend fallback executor.
 */
export class BackendToolExecutor implements IToolExecutor {
  constructor(private readonly frontendExecutor: IToolExecutor) {}

  /**
   * Determines whether a tool should be executed on the backend.
   */
  private isBackendTool(toolName: string): boolean {
    const toolDef = this.frontendExecutor.getToolDefinition(toolName);
    if (!toolDef) return false;
    return BACKEND_CATEGORIES.has(toolDef.category);
  }

  async execute(
    toolName: string,
    args: Record<string, unknown>,
    context: ExecutionContext,
  ): Promise<ToolExecutionResult> {
    if (!this.isBackendTool(toolName)) {
      return this.frontendExecutor.execute(toolName, args, context);
    }

    const start = performance.now();

    // Check if this is a compound tool that needs expansion
    const expander = compoundExpanders.get(toolName);
    const steps = expander
      ? expander(args).map((sub, i) => ({
          id: `step-${i + 1}`,
          toolName: sub.toolName,
          params: sub.params as Record<string, never>,
          description: `Execute ${sub.toolName}`,
          riskLevel: 'low' as const,
          dependsOn: sub.dependsOn ?? (i > 0 ? [`step-${i}`] : []),
          optional: false,
        }))
      : [
          {
            id: 'step-1',
            toolName,
            params: args as Record<string, never>,
            description: `Execute ${toolName}`,
            riskLevel: 'low' as const,
            dependsOn: [] as string[],
            optional: false,
          },
        ];

    const plan: AgentPlan = {
      id: `plan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      goal: expander ? `Execute compound ${toolName} (${steps.length} steps)` : `Execute ${toolName}`,
      steps,
      approvalGranted: true,
      sessionId: context.sessionId,
    };

    try {
      // Listen for step events (fire-and-forget)
      const unlistenStart = await listen<PlanStepEvent>('agent:plan_step_start', (event) => {
        logger.debug('Backend step started', { ...event.payload });
      });

      const unlistenComplete = await listen<PlanStepCompleteEvent>(
        'agent:plan_step_complete',
        (event) => {
          logger.debug('Backend step completed', { ...event.payload });
        },
      );

      const unlistenFailed = await listen<PlanStepFailedEvent>(
        'agent:plan_step_failed',
        (event) => {
          logger.warn('Backend step failed', { ...event.payload });
        },
      );

      try {
        const result = await invoke<AgentPlanResult>('execute_agent_plan', { plan });
        const duration = performance.now() - start;

        if (result.success && result.stepResults.length > 0) {
          // For compound tools, aggregate all step results into the data field
          const data = expander
            ? {
                steps: result.stepResults.map((sr) => ({
                  success: sr.success,
                  data: sr.data,
                })),
                stepsCompleted: result.stepsCompleted,
              }
            : result.stepResults[0].data;

          return {
            success: true,
            data,
            duration,
            undoable: true,
            undoOperation: {
              tool: 'undo',
              args: {},
              description: `Undo ${toolName}`,
            },
          };
        }

        const errorMsg =
          result.errorMessage ??
          result.stepResults[0]?.error ??
          'Unknown backend execution error';
        return createFailureResult(errorMsg, duration);
      } finally {
        unlistenStart();
        unlistenComplete();
        unlistenFailed();
      }
    } catch (err) {
      const duration = performance.now() - start;
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error('Backend tool execution failed', { toolName, error: errorMsg });
      return createFailureResult(`Backend execution error: ${errorMsg}`, duration);
    }
  }

  async executeBatch(
    request: BatchExecutionRequest,
    context: ExecutionContext,
  ): Promise<BatchExecutionResult> {
    const start = performance.now();
    const results: Array<{ tool: string; result: ToolExecutionResult }> = [];
    let successCount = 0;
    let failureCount = 0;

    // Separate tools into backend and frontend batches
    const backendTools = request.tools.filter((t) => this.isBackendTool(t.name));
    const frontendTools = request.tools.filter((t) => !this.isBackendTool(t.name));

    // Execute backend tools as a single plan (atomic with rollback)
    // Compound tools are expanded into primitive sub-steps.
    if (backendTools.length > 0) {
      // Track which original tool index maps to which step ranges
      const toolStepMapping: Array<{ toolIndex: number; stepStart: number; stepCount: number }> =
        [];
      const allSteps: AgentPlan['steps'] = [];
      let stepCounter = 0;

      for (let i = 0; i < backendTools.length; i++) {
        const t = backendTools[i];
        const exp = compoundExpanders.get(t.name);

        if (exp) {
          const subSteps = exp(t.args);
          const startIdx = stepCounter;
          for (let j = 0; j < subSteps.length; j++) {
            allSteps.push({
              id: `step-${stepCounter + 1}`,
              toolName: subSteps[j].toolName,
              params: subSteps[j].params as Record<string, never>,
              description: `Execute ${subSteps[j].toolName}`,
              riskLevel: 'low' as const,
              dependsOn:
                subSteps[j].dependsOn ??
                (stepCounter > 0 && request.mode === 'sequential'
                  ? [`step-${stepCounter}`]
                  : []),
              optional: false,
            });
            stepCounter++;
          }
          toolStepMapping.push({
            toolIndex: i,
            stepStart: startIdx,
            stepCount: subSteps.length,
          });
        } else {
          allSteps.push({
            id: `step-${stepCounter + 1}`,
            toolName: t.name,
            params: t.args as Record<string, never>,
            description: `Execute ${t.name}`,
            riskLevel: 'low' as const,
            dependsOn:
              request.mode === 'sequential' && stepCounter > 0
                ? [`step-${stepCounter}`]
                : [],
            optional: false,
          });
          toolStepMapping.push({ toolIndex: i, stepStart: stepCounter, stepCount: 1 });
          stepCounter++;
        }
      }

      const plan: AgentPlan = {
        id: `batch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        goal: `Batch execute ${backendTools.length} tools (${allSteps.length} steps)`,
        steps: allSteps,
        approvalGranted: true,
        sessionId: context.sessionId,
      };

      try {
        const planResult = await invoke<AgentPlanResult>('execute_agent_plan', { plan });

        // Map step results back to original tools using the step mapping
        for (const mapping of toolStepMapping) {
          const stepSlice = planResult.stepResults.slice(
            mapping.stepStart,
            mapping.stepStart + mapping.stepCount,
          );
          const allSucceeded = stepSlice.every((sr) => sr?.success);

          if (allSucceeded && stepSlice.length > 0) {
            const totalDuration = stepSlice.reduce((sum, sr) => sum + (sr?.durationMs ?? 0), 0);
            results.push({
              tool: backendTools[mapping.toolIndex].name,
              result: {
                success: true,
                data:
                  mapping.stepCount > 1
                    ? { steps: stepSlice.map((sr) => ({ success: sr.success, data: sr.data })) }
                    : stepSlice[0].data,
                duration: totalDuration,
                undoable: true,
              },
            });
            successCount++;
          } else {
            const failedStep = stepSlice.find((sr) => !sr?.success);
            results.push({
              tool: backendTools[mapping.toolIndex].name,
              result: createFailureResult(
                failedStep?.error ?? 'Step not executed',
                failedStep?.durationMs ?? 0,
              ),
            });
            failureCount++;
          }
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        for (const t of backendTools) {
          results.push({
            tool: t.name,
            result: createFailureResult(`Batch execution error: ${errorMsg}`, 0),
          });
          failureCount++;
        }
      }
    }

    // Execute frontend tools via the frontend executor
    if (frontendTools.length > 0) {
      const frontendRequest: BatchExecutionRequest = {
        ...request,
        tools: frontendTools,
      };
      const frontendResult = await this.frontendExecutor.executeBatch(frontendRequest, context);
      results.push(...frontendResult.results);
      successCount += frontendResult.successCount;
      failureCount += frontendResult.failureCount;
    }

    return {
      success: failureCount === 0,
      results,
      totalDuration: performance.now() - start,
      successCount,
      failureCount,
    };
  }

  // Delegate all metadata methods to the frontend executor

  getAvailableTools(category?: string): ToolInfo[] {
    return this.frontendExecutor.getAvailableTools(category);
  }

  getToolDefinition(name: string): ToolDefinition | null {
    return this.frontendExecutor.getToolDefinition(name);
  }

  validateArgs(toolName: string, args: Record<string, unknown>): ValidationResult {
    return this.frontendExecutor.validateArgs(toolName, args);
  }

  hasTool(name: string): boolean {
    return this.frontendExecutor.hasTool(name);
  }

  getToolsByCategory(): Map<string, ToolInfo[]> {
    return this.frontendExecutor.getToolsByCategory();
  }

  getToolsByRisk(maxRisk: RiskLevel): ToolInfo[] {
    return this.frontendExecutor.getToolsByRisk(maxRisk);
  }
}

/**
 * Create a BackendToolExecutor that wraps a frontend executor.
 *
 * Editing tools are routed to the backend; analysis/utility tools
 * are delegated to the frontend executor.
 */
export function createBackendToolExecutor(
  frontendExecutor: IToolExecutor,
): BackendToolExecutor {
  return new BackendToolExecutor(frontendExecutor);
}
