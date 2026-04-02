/**
 * BackendToolExecutor
 *
 * Routes tool execution between backend IPC (for backend-safe edit commands)
 * and frontend ToolRegistryAdapter (for orchestration/high-level tools).
 *
 * When the USE_BACKEND_TOOLS feature flag is enabled, tools that map 1:1 to
 * backend CommandPayload variants are dispatched to `execute_agent_plan` for
 * atomic execution with rollback. High-level tools that require frontend state
 * orchestration remain on the frontend.
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
import { isMetaToolsEnabled } from '@/config/featureFlags';
import { getVisibleMetaToolNames } from '@/agents/tools/metaTools';
import { getWorkspaceToolNames } from '@/agents/tools/workspaceTools';

const logger = createLogger('BackendToolExecutor');

// =============================================================================
// Constants
// =============================================================================

/**
 * Tools that can be sent directly to backend `CommandPayload::parse` after
 * snake_case -> camelCase normalization.
 *
 * Keep this list conservative: only include tools whose public args are already
 * command-shaped and do not rely on extra frontend orchestration.
 */
const BACKEND_DIRECT_TOOLS = new Set([
  'move_clip',
  'trim_clip',
  'split_clip',
  'delete_clip',
  'change_clip_speed',
  'add_track',
  'remove_track',
  'remove_marker',
]);

function normalizeToolNameForBackend(toolName: string): string {
  // Backend CommandPayload parsing uses camelCase aliases. Agent tool names are
  // snake_case, so normalize before sending to execute_agent_plan.
  return toolName.replace(/_([a-z])/g, (_, char: string) => char.toUpperCase());
}

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

interface LegacyExecutePlanStep {
  id: string;
  toolName: string;
  params: Record<string, unknown>;
  dependsOn?: string[];
}

interface LegacyExecutePlanRoute {
  plan: AgentPlan;
  stepMappings: Array<{
    legacyStepId: string;
    backendStepIds: string[];
  }>;
}

interface BackendExecutionTarget {
  requestedToolName: string;
  effectiveToolName: string;
  params: Record<string, unknown>;
  metaAction?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseLegacyExecutePlanSteps(args: Record<string, unknown>): LegacyExecutePlanStep[] | null {
  const rawSteps = args.steps;
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
    return null;
  }

  const steps: LegacyExecutePlanStep[] = [];
  for (const rawStep of rawSteps) {
    if (!isRecord(rawStep)) {
      return null;
    }

    const id = typeof rawStep.id === 'string' ? rawStep.id.trim() : '';
    const toolName = typeof rawStep.toolName === 'string' ? rawStep.toolName.trim() : '';
    const params = isRecord(rawStep.params) ? rawStep.params : null;
    const dependsOn = Array.isArray(rawStep.dependsOn)
      ? rawStep.dependsOn.filter((value): value is string => typeof value === 'string')
      : undefined;

    if (!id || !toolName || !params) {
      return null;
    }

    steps.push({
      id,
      toolName,
      params,
      dependsOn,
    });
  }

  return steps;
}

function dedupeDependencies(dependsOn: string[]): string[] {
  return Array.from(new Set(dependsOn.filter((value) => value.length > 0)));
}

function normalizeBackendSingleStepData(
  toolName: string,
  params: Record<string, unknown>,
  data: unknown,
): unknown {
  if (!isRecord(data)) {
    return data;
  }

  const createdIds = Array.isArray(data.createdIds)
    ? data.createdIds.filter((value): value is string => typeof value === 'string')
    : [];

  if (toolName === 'split_clip') {
    return {
      ...data,
      sourceClipId:
        typeof data.sourceClipId === 'string'
          ? data.sourceClipId
          : typeof params.clipId === 'string'
          ? params.clipId
          : undefined,
      newClipId:
        typeof data.newClipId === 'string'
          ? data.newClipId
          : createdIds[0] ?? null,
    };
  }

  if (toolName === 'insert_clip') {
    return {
      ...data,
      clipId:
        typeof data.clipId === 'string'
          ? data.clipId
          : createdIds[0] ?? null,
    };
  }

  return data;
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
  private isBackendToolName(toolName: string): boolean {
    // Only known tools can route either way.
    if (!this.frontendExecutor.getToolDefinition(toolName)) {
      return false;
    }

    // Explicit compound expanders are backend-safe by definition because they
    // emit primitive command steps.
    if (compoundExpanders.has(toolName)) {
      return true;
    }

    return BACKEND_DIRECT_TOOLS.has(toolName);
  }

  private resolveBackendExecutionTarget(
    toolName: string,
    args: Record<string, unknown>,
  ): BackendExecutionTarget | null {
    if (toolName === 'edit') {
      if (!this.frontendExecutor.getToolDefinition(toolName)) {
        return null;
      }

      const action = typeof args.action === 'string' ? args.action.trim() : '';
      if (!action || !this.isBackendToolName(action)) {
        return null;
      }

      // The backend expects command-shaped args, not the meta-tool action wrapper.
      // Strip the action field before building the atomic plan step.
      const { action: ignoredAction, ...metaToolArgs } = args;
      void ignoredAction;
      return {
        requestedToolName: toolName,
        effectiveToolName: action,
        params: metaToolArgs,
        metaAction: action,
      };
    }

    if (!this.isBackendToolName(toolName)) {
      return null;
    }

    return {
      requestedToolName: toolName,
      effectiveToolName: toolName,
      params: args,
    };
  }

  private tryBuildLegacyExecutePlanRoute(
    args: Record<string, unknown>,
    context: ExecutionContext,
  ): LegacyExecutePlanRoute | null {
    const steps = parseLegacyExecutePlanSteps(args);
    if (!steps) {
      return null;
    }

    const seenLegacyIds = new Set<string>();
    const lastBackendStepIdByLegacyId = new Map<string, string>();
    const backendSteps: AgentPlan['steps'] = [];
    const stepMappings: LegacyExecutePlanRoute['stepMappings'] = [];
    let previousLegacyFinalStepId: string | null = null;

    for (const step of steps) {
      if (seenLegacyIds.has(step.id) || step.toolName === 'execute_plan') {
        return null;
      }
      seenLegacyIds.add(step.id);

      if (!this.isBackendToolName(step.toolName)) {
        return null;
      }

      let explicitDependsOn: string[];
      try {
        explicitDependsOn = (step.dependsOn ?? []).map((dep) => {
          const mapped = lastBackendStepIdByLegacyId.get(dep);
          if (!mapped) {
            throw new Error(`Legacy dependency '${dep}' cannot be resolved`);
          }
          return mapped;
        });
      } catch {
        return null;
      }

      const inheritedDependsOn = previousLegacyFinalStepId ? [previousLegacyFinalStepId] : [];
      const firstStepDependsOn = dedupeDependencies([...inheritedDependsOn, ...explicitDependsOn]);

      const expander = compoundExpanders.get(step.toolName);
      if (expander) {
        let expanded: ReturnType<CompoundExpander>;
        try {
          expanded = expander(step.params);
        } catch {
          return null;
        }
        if (expanded.length === 0) {
          return null;
        }

        const generatedIds: string[] = [];
        expanded.forEach((subStep, index) => {
          const backendStepId = `${step.id}__${index + 1}`;
          const dependsOn = index === 0
            ? firstStepDependsOn
            : [generatedIds[index - 1]];

          backendSteps.push({
            id: backendStepId,
            toolName: normalizeToolNameForBackend(subStep.toolName),
            params: subStep.params as Record<string, never>,
            description: `Execute ${subStep.toolName}`,
            riskLevel: 'low',
            dependsOn,
            optional: false,
          });
          generatedIds.push(backendStepId);
        });

        const finalBackendStepId = generatedIds[generatedIds.length - 1];
        if (!finalBackendStepId) {
          return null;
        }
        previousLegacyFinalStepId = finalBackendStepId;
        lastBackendStepIdByLegacyId.set(step.id, finalBackendStepId);
        stepMappings.push({
          legacyStepId: step.id,
          backendStepIds: generatedIds,
        });
        continue;
      }

      backendSteps.push({
        id: step.id,
        toolName: normalizeToolNameForBackend(step.toolName),
        params: step.params as Record<string, never>,
        description: `Execute ${step.toolName}`,
        riskLevel: 'low',
        dependsOn: firstStepDependsOn,
        optional: false,
      });
      previousLegacyFinalStepId = step.id;
      lastBackendStepIdByLegacyId.set(step.id, step.id);
      stepMappings.push({
        legacyStepId: step.id,
        backendStepIds: [step.id],
      });
    }

    return {
      plan: {
        id: `legacy-plan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        goal: `Promote legacy execute_plan to backend atomic execution (${steps.length} steps)`,
        steps: backendSteps,
        approvalGranted: true,
        sessionId: context.sessionId,
      },
      stepMappings,
    };
  }

  private async invokeBackendPlan(
    plan: AgentPlan,
    logContext: Record<string, unknown>,
  ): Promise<
    | { ok: true; result: AgentPlanResult; duration: number }
    | { ok: false; error: string; duration: number }
  > {
    const start = performance.now();

    try {
      const unlistenStart = await listen<PlanStepEvent>('agent:plan_step_start', (event) => {
        logger.debug('Backend step started', { ...logContext, ...event.payload });
      });

      const unlistenComplete = await listen<PlanStepCompleteEvent>(
        'agent:plan_step_complete',
        (event) => {
          logger.debug('Backend step completed', { ...logContext, ...event.payload });
        },
      );

      const unlistenFailed = await listen<PlanStepFailedEvent>(
        'agent:plan_step_failed',
        (event) => {
          logger.warn('Backend step failed', { ...logContext, ...event.payload });
        },
      );

      try {
        const result = await invoke<AgentPlanResult>('execute_agent_plan', { plan });
        return {
          ok: true,
          result,
          duration: performance.now() - start,
        };
      } finally {
        unlistenStart();
        unlistenComplete();
        unlistenFailed();
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error('Backend tool execution failed', {
        ...logContext,
        error: errorMsg,
      });
      return {
        ok: false,
        error: errorMsg,
        duration: performance.now() - start,
      };
    }
  }

  async execute(
    toolName: string,
    args: Record<string, unknown>,
    context: ExecutionContext,
  ): Promise<ToolExecutionResult> {
    if (toolName === 'execute_plan') {
      const legacyRoute = this.tryBuildLegacyExecutePlanRoute(args, context);
      if (legacyRoute) {
        const execution = await this.invokeBackendPlan(legacyRoute.plan, {
          toolName,
          legacy: true,
        });

        if (!execution.ok) {
          return createFailureResult(`Backend execution error: ${execution.error}`, execution.duration);
        }

        const stepResultById = new Map(
          execution.result.stepResults.map((stepResult) => [stepResult.stepId, stepResult]),
        );
        const stepResults = legacyRoute.stepMappings.map((mapping) => {
          const slice = mapping.backendStepIds
            .map((stepId) => stepResultById.get(stepId))
            .filter((stepResult): stepResult is NonNullable<typeof stepResult> => Boolean(stepResult));
          const allSucceeded =
            slice.length === mapping.backendStepIds.length
            && slice.every((stepResult) => stepResult.success);
          const failedStep = slice.find((stepResult) => !stepResult.success);

          return {
            stepId: mapping.legacyStepId,
            success: allSucceeded,
            data:
              slice.length <= 1
                ? slice[0]?.data
                : {
                    subSteps: slice.map((stepResult) => ({
                      stepId: stepResult.stepId,
                      success: stepResult.success,
                      data: stepResult.data,
                    })),
                  },
            error: failedStep?.error,
          };
        });

        if (!execution.result.success) {
          return {
            success: false,
            error:
              execution.result.errorMessage
              ?? execution.result.rollbackReport?.rollbackErrors?.join('; ')
              ?? 'Legacy execute_plan backend promotion failed',
            data: {
              stepResults,
              rollbackReport: execution.result.rollbackReport ?? null,
            },
            duration: execution.duration,
          };
        }

        return {
          success: true,
          data: {
            stepsExecuted: stepResults.length,
            stepResults,
          },
          duration: execution.duration,
          undoable: true,
          undoOperation: {
            tool: 'undo',
            args: {},
            description: 'Undo execute_plan',
          },
        };
      }
    }

    const executionTarget = this.resolveBackendExecutionTarget(toolName, args);
    if (!executionTarget) {
      return this.frontendExecutor.execute(toolName, args, context);
    }

    const start = performance.now();
    const expander = compoundExpanders.get(executionTarget.effectiveToolName);
    let steps: AgentPlan['steps'];
    try {
      steps = expander
        ? expander(executionTarget.params).map((sub, i) => ({
            id: `step-${i + 1}`,
            toolName: normalizeToolNameForBackend(sub.toolName),
            params: sub.params as Record<string, never>,
            description: `Execute ${sub.toolName}`,
            riskLevel: 'low' as const,
            dependsOn: sub.dependsOn ?? (i > 0 ? [`step-${i}`] : []),
            optional: false,
          }))
        : [
            {
              id: 'step-1',
              toolName: normalizeToolNameForBackend(executionTarget.effectiveToolName),
              params: executionTarget.params as Record<string, never>,
              description: `Execute ${executionTarget.effectiveToolName}`,
              riskLevel: 'low' as const,
              dependsOn: [] as string[],
              optional: false,
            },
          ];
    } catch (err) {
      const duration = performance.now() - start;
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.warn('Compound tool expansion failed', {
        requestedToolName: toolName,
        effectiveToolName: executionTarget.effectiveToolName,
        error: errorMsg,
      });
      return createFailureResult(
        `${executionTarget.effectiveToolName} validation failed: ${errorMsg}`,
        duration,
      );
    }

    const plan: AgentPlan = {
      id: `plan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      goal: expander
        ? `Execute compound ${executionTarget.effectiveToolName} (${steps.length} steps)`
        : `Execute ${executionTarget.effectiveToolName}`,
      steps,
      approvalGranted: true,
      sessionId: context.sessionId,
    };

    const execution = await this.invokeBackendPlan(plan, {
      requestedToolName: executionTarget.requestedToolName,
      effectiveToolName: executionTarget.effectiveToolName,
      metaToolAction: executionTarget.metaAction ?? null,
    });
    if (!execution.ok) {
      return createFailureResult(`Backend execution error: ${execution.error}`, execution.duration);
    }

    if (execution.result.success && execution.result.stepResults.length > 0) {
      // For compound tools, aggregate all step results into the data field
      const data = expander
        ? {
            steps: execution.result.stepResults.map((sr) => ({
              success: sr.success,
              data: sr.data,
            })),
            stepsCompleted: execution.result.stepsCompleted,
          }
        : normalizeBackendSingleStepData(
            executionTarget.effectiveToolName,
            executionTarget.params,
            execution.result.stepResults[0].data,
          );

      return {
        success: true,
        data,
        duration: execution.duration,
        undoable: true,
        undoOperation: {
          tool: 'undo',
          args: {},
          description: `Undo ${executionTarget.effectiveToolName}`,
        },
      };
    }

    const errorMsg =
      execution.result.errorMessage
      ?? execution.result.stepResults[0]?.error
      ?? 'Unknown backend execution error';
    return createFailureResult(errorMsg, execution.duration);
  }

  async executeBatch(
    request: BatchExecutionRequest,
    context: ExecutionContext,
  ): Promise<BatchExecutionResult> {
    const start = performance.now();
    const results: Array<{ tool: string; result: ToolExecutionResult }> = [];
    let successCount = 0;
    let failureCount = 0;

    // Resolve each tool's execution target while preserving original order
    const resolvedTools = request.tools.map((tool) => ({
      requestTool: tool,
      executionTarget: this.resolveBackendExecutionTarget(tool.name, tool.args),
    }));

    const allBackend = resolvedTools.every((t) => t.executionTarget !== null);

    // If the batch is mixed (backend + frontend), fall back to sequential
    // per-tool execution to preserve the caller's intended order.
    if (!allBackend) {
      for (const { requestTool, executionTarget } of resolvedTools) {
        if (executionTarget) {
          const singleResult = await this.execute(requestTool.name, requestTool.args, context);
          results.push({ tool: requestTool.name, result: singleResult });
          if (singleResult.success) successCount++;
          else failureCount++;
        } else {
          const frontendResult = await this.frontendExecutor.executeBatch(
            { ...request, tools: [requestTool] },
            context,
          );
          results.push(...frontendResult.results);
          successCount += frontendResult.successCount;
          failureCount += frontendResult.failureCount;
        }
      }

      return {
        success: failureCount === 0,
        results,
        totalDuration: performance.now() - start,
        successCount,
        failureCount,
      };
    }

    // All tools resolve to backend — execute as a single atomic plan with rollback.
    const backendTools = resolvedTools as Array<{
      requestTool: BatchExecutionRequest['tools'][number];
      executionTarget: BackendExecutionTarget;
    }>;

    // Compound tools are expanded into primitive sub-steps.
    if (backendTools.length > 0) {
      // Track which original tool index maps to which step ranges
      const toolStepMapping: Array<{ toolIndex: number; stepStart: number; stepCount: number }> =
        [];
      const allSteps: AgentPlan['steps'] = [];
      let stepCounter = 0;
      let expansionError: string | null = null;

      for (let i = 0; i < backendTools.length; i++) {
        const { requestTool, executionTarget } = backendTools[i];
        const exp = compoundExpanders.get(executionTarget.effectiveToolName);

        if (exp) {
          let subSteps: ReturnType<typeof exp>;
          try {
            subSteps = exp(executionTarget.params);
          } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            expansionError = `${executionTarget.effectiveToolName} validation failed: ${errorMsg}`;
            logger.warn('Batch compound expansion failed', {
              requestedToolName: requestTool.name,
              effectiveToolName: executionTarget.effectiveToolName,
              error: errorMsg,
            });
            break;
          }

          const startIdx = stepCounter;
          for (let j = 0; j < subSteps.length; j++) {
            // Compound sub-steps must always execute sequentially relative to
            // each other, regardless of batch mode. The first sub-step may
            // depend on the previous global step in sequential mode.
            let dependsOn: string[];
            if (subSteps[j].dependsOn) {
              dependsOn = subSteps[j].dependsOn!;
            } else if (j > 0) {
              // Force sequential dependency within compound tool
              dependsOn = [`step-${stepCounter}`];
            } else if (stepCounter > 0 && request.mode === 'sequential') {
              dependsOn = [`step-${stepCounter}`];
            } else {
              dependsOn = [];
            }
            allSteps.push({
              id: `step-${stepCounter + 1}`,
              toolName: normalizeToolNameForBackend(subSteps[j].toolName),
              params: subSteps[j].params as Record<string, never>,
              description: `Execute ${subSteps[j].toolName}`,
              riskLevel: 'low' as const,
              dependsOn,
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
            toolName: normalizeToolNameForBackend(executionTarget.effectiveToolName),
            params: executionTarget.params as Record<string, never>,
            description: `Execute ${executionTarget.effectiveToolName}`,
            riskLevel: 'low' as const,
            dependsOn:
              request.mode === 'sequential' && stepCounter > 0 ? [`step-${stepCounter}`] : [],
            optional: false,
          });
          toolStepMapping.push({ toolIndex: i, stepStart: stepCounter, stepCount: 1 });
          stepCounter++;
        }
      }

      if (expansionError) {
        for (const t of backendTools) {
          results.push({
            tool: t.requestTool.name,
            result: createFailureResult(`Batch expansion error: ${expansionError}`, 0),
          });
          failureCount++;
        }
      } else {
        const plan: AgentPlan = {
          id: `batch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          goal: `Batch execute ${backendTools.length} tools (${allSteps.length} steps)`,
          steps: allSteps,
          approvalGranted: true,
          sessionId: context.sessionId,
        };

        try {
          const planResult = await invoke<AgentPlanResult>('execute_agent_plan', { plan });

          // If the plan failed atomically (with rollback), all tools must be
          // reported as failed — individual step slices may look successful
          // but the entire batch was rolled back.
          if (!planResult.success) {
            const batchError =
              planResult.errorMessage ??
              planResult.rollbackReport?.rollbackErrors?.join('; ') ??
              'Plan execution failed';
            for (const t of backendTools) {
              results.push({
                tool: t.requestTool.name,
                result: createFailureResult(`Batch rolled back: ${batchError}`, 0),
              });
              failureCount++;
            }
          } else {
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
                  tool: backendTools[mapping.toolIndex].requestTool.name,
                  result: {
                    success: true,
                    data:
                      mapping.stepCount > 1
                        ? {
                            steps: stepSlice.map((sr) => ({ success: sr.success, data: sr.data })),
                          }
                        : stepSlice[0].data,
                    duration: totalDuration,
                    undoable: true,
                  },
                });
                successCount++;
              } else {
                const failedStep = stepSlice.find((sr) => !sr?.success);
                results.push({
                  tool: backendTools[mapping.toolIndex].requestTool.name,
                  result: createFailureResult(
                    failedStep?.error ?? 'Step not executed',
                    failedStep?.durationMs ?? 0,
                  ),
                });
                failureCount++;
              }
            }
          }
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          for (const t of backendTools) {
            results.push({
              tool: t.requestTool.name,
              result: createFailureResult(`Batch execution error: ${errorMsg}`, 0),
            });
            failureCount++;
          }
        }
      }
    }

    return {
      success: failureCount === 0,
      results,
      totalDuration: performance.now() - start,
      successCount,
      failureCount,
    };
  }

  canExecuteBatchAtomically(request: BatchExecutionRequest): boolean {
    return request.tools.length > 1
      && request.tools.every((tool) => this.resolveBackendExecutionTarget(tool.name, tool.args) !== null);
  }

  // Delegate all metadata methods to the frontend executor

  getAvailableTools(category?: string): ToolInfo[] {
    const allTools = this.frontendExecutor.getAvailableTools(category);

    // When meta-tools are enabled, expose only meta-tools + workspace tools to the LLM.
    // Individual tools remain registered for dispatch but are hidden from the LLM context.
    if (!category && isMetaToolsEnabled()) {
      const visibleNames = new Set([...getVisibleMetaToolNames(), ...getWorkspaceToolNames()]);
      const filtered = allTools.filter((tool) => visibleNames.has(tool.name));
      // Fallback: if meta-tools are expected but none matched, return all tools
      // to avoid silently hiding every tool from the LLM.
      if (filtered.length === 0 && allTools.length > 0) {
        return allTools;
      }
      return filtered;
    }

    return allTools;
  }

  // Note: getToolDefinition and hasTool intentionally bypass the meta-tool
  // visibility filter. The LLM only sees meta-tools via getAvailableTools(), but
  // individual tools must remain accessible for dispatch (meta-tools forward to them).
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
export function createBackendToolExecutor(frontendExecutor: IToolExecutor): BackendToolExecutor {
  return new BackendToolExecutor(frontendExecutor);
}
