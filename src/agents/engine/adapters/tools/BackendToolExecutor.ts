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

    // Build a single-step plan for backend execution
    const plan: AgentPlan = {
      id: `plan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      goal: `Execute ${toolName}`,
      steps: [
        {
          id: 'step-1',
          toolName,
          params: args as Record<string, never>,
          description: `Execute ${toolName}`,
          riskLevel: 'low' as const,
          dependsOn: [],
          optional: false,
        },
      ],
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
          const stepResult = result.stepResults[0];
          return {
            success: true,
            data: stepResult.data,
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
    if (backendTools.length > 0) {
      const plan: AgentPlan = {
        id: `batch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        goal: `Batch execute ${backendTools.length} tools`,
        steps: backendTools.map((t, i) => ({
          id: `step-${i + 1}`,
          toolName: t.name,
          params: t.args as Record<string, never>,
          description: `Execute ${t.name}`,
          riskLevel: 'low' as const,
          dependsOn: request.mode === 'sequential' && i > 0 ? [`step-${i}`] : [],
          optional: false,
        })),
        approvalGranted: true,
        sessionId: context.sessionId,
      };

      try {
        const planResult = await invoke<AgentPlanResult>('execute_agent_plan', { plan });

        for (let i = 0; i < backendTools.length; i++) {
          const stepResult = planResult.stepResults[i];
          if (stepResult?.success) {
            results.push({
              tool: backendTools[i].name,
              result: {
                success: true,
                data: stepResult.data,
                duration: stepResult.durationMs,
                undoable: true,
              },
            });
            successCount++;
          } else {
            results.push({
              tool: backendTools[i].name,
              result: createFailureResult(
                stepResult?.error ?? 'Step not executed',
                stepResult?.durationMs ?? 0,
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
