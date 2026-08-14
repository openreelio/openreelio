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
import { runProjectBackendMutation } from '@/services/projectMutationGateway';
import { isMetaToolsEnabled } from '@/config/featureFlags';
import { normalizeMarkerColor } from '@/agents/tools/markerColor';
import { getVisibleMetaToolNames } from '@/agents/tools/metaTools';
import { getWorkspaceToolNames } from '@/agents/tools/workspaceTools';
import { useProjectStore } from '@/stores/projectStore';
import {
  requiresProjectMutationPreflight,
  validateMutationPreconditions,
  validateMutationStateRevision,
} from './mutationPreflight';

const logger = createLogger('BackendToolExecutor');
const AGENT_PLAN_MUTATION_TIMEOUT_MS = 5 * 60 * 1000;

// =============================================================================
// Constants
// =============================================================================

/**
 * Upper bound on the steps one `execute_plan` call may carry.
 *
 * Pinned to the backstop every other plan surface enforces — see
 * `MAX_PLAN_STEPS` in `src-tauri/src/core/ai/plan_executor.rs`, which the CLI
 * (`crates/openreelio-cli/src/commands/plan.rs`) and MCP re-export. A batch
 * tool is the one place an agent can smuggle unbounded work past the engine's
 * per-run step budget, so the cap is checked here before the plan is built.
 */
export const MAX_PLAN_STEPS = 1000;

/**
 * A tool that maps onto exactly one backend `CommandPayload`.
 *
 * `commandType` is the name `CommandPayload::parse` accepts (its serde alias),
 * and `mapParams` is the deterministic, state-free transform from the tool's
 * public args to that payload's fields. A tool belongs here only when the
 * backend command does everything its frontend handler does; anything that
 * reads the timeline snapshot, resolves a name, or issues more than one command
 * is a compound expander or stays on the frontend.
 */
interface BackendDirectRoute {
  readonly commandType: string;
  readonly mapParams?: (params: Record<string, unknown>) => Record<string, unknown>;
}

function withoutKeys(
  params: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  const next = { ...params };
  for (const key of keys) {
    delete next[key];
  }
  return next;
}

/** `dissolve` is the tool's spelling of the `cross_dissolve` effect type. */
function mapTransitionTypeToEffectType(value: unknown): unknown {
  return value === 'dissolve' ? 'cross_dissolve' : value;
}

/**
 * Tools that can be sent directly to backend `CommandPayload::parse`.
 *
 * Every entry is an audited 1:1 mapping; the guard test in
 * `BackendToolExecutor.backendSafety.test.ts` fails when a registered mutating
 * tool has no decision recorded here or in `BACKEND_FRONTEND_ONLY_TOOLS`.
 */
const BACKEND_DIRECT_ROUTES: ReadonlyMap<string, BackendDirectRoute> = new Map<
  string,
  BackendDirectRoute
>([
  // --- Args are already payload-shaped (name normalizes, fields match) -------
  ['add_effect', { commandType: 'addEffect' }],
  ['add_marker', { commandType: 'addMarker' }],
  ['move_clip', { commandType: 'moveClip' }],
  ['trim_clip', { commandType: 'trimClip' }],
  ['split_clip', { commandType: 'splitClip' }],
  ['delete_clip', { commandType: 'deleteClip' }],
  ['change_clip_speed', { commandType: 'changeClipSpeed' }],
  ['add_track', { commandType: 'addTrack' }],
  ['remove_track', { commandType: 'removeTrack' }],
  ['rename_track', { commandType: 'renameTrack' }],
  ['remove_effect', { commandType: 'removeEffect' }],
  ['remove_marker', { commandType: 'removeMarker' }],
  ['add_mask', { commandType: 'addMask' }],
  ['update_mask', { commandType: 'updateMask' }],
  ['remove_mask', { commandType: 'removeMask' }],

  // --- Fields match; only the command name differs --------------------------
  ['mute_clip', { commandType: 'setClipMute' }],
  ['create_workspace_folder', { commandType: 'createFolder' }],
  ['rename_workspace_entry', { commandType: 'renameFile' }],
  ['move_workspace_entry', { commandType: 'moveFile' }],
  ['delete_workspace_entry', { commandType: 'deleteFile' }],

  // --- Deterministic arg remaps ---------------------------------------------
  [
    'add_transition',
    {
      commandType: 'addEffect',
      mapParams: (params) => ({
        ...withoutKeys(params, ['transitionType', 'duration']),
        effectType: mapTransitionTypeToEffectType(params.transitionType),
        params: { duration: params.duration },
      }),
    },
  ],
  [
    'set_transition_duration',
    {
      commandType: 'updateEffect',
      // UpdateEffectPayload denies unknown fields: the locating ids must go.
      mapParams: (params) => ({
        effectId: params.transitionId,
        params: { duration: params.duration },
      }),
    },
  ],
  [
    'adjust_effect_param',
    {
      commandType: 'updateEffect',
      mapParams: (params) => ({
        effectId: params.effectId,
        params: { [String(params.paramName)]: params.paramValue },
      }),
    },
  ],
  [
    'add_fade_in',
    {
      commandType: 'setClipAudio',
      mapParams: (params) => ({
        ...withoutKeys(params, ['duration']),
        fadeInSec: params.duration,
      }),
    },
  ],
  [
    'add_fade_out',
    {
      commandType: 'setClipAudio',
      mapParams: (params) => ({
        ...withoutKeys(params, ['duration']),
        fadeOutSec: params.duration,
      }),
    },
  ],
]);

/**
 * Names of the tools that route straight to a backend command.
 *
 * Exported for the backend-safety guard test; execution reads
 * `BACKEND_DIRECT_ROUTES` directly.
 */
export function getBackendDirectToolNames(): readonly string[] {
  return [...BACKEND_DIRECT_ROUTES.keys()];
}

function normalizeToolNameForBackend(toolName: string): string {
  const route = BACKEND_DIRECT_ROUTES.get(toolName);
  if (route) {
    return route.commandType;
  }

  // Compound sub-steps and pass-through names: backend CommandPayload parsing
  // uses camelCase aliases, agent tool names are snake_case.
  return toolName.replace(/_([a-z])/g, (_, char: string) => char.toUpperCase());
}

function normalizeBackendParamsForBackend(
  toolName: string,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const routed = BACKEND_DIRECT_ROUTES.get(toolName)?.mapParams?.(params) ?? params;

  const isAddMarker = toolName === 'add_marker' || toolName === 'addMarker';
  if (!isAddMarker || !Object.prototype.hasOwnProperty.call(routed, 'color')) {
    return routed;
  }

  const nextParams = { ...routed };
  const color = normalizeMarkerColor(nextParams.color);
  if (color) {
    nextParams.color = color;
  } else {
    delete nextParams.color;
  }

  return nextParams;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

/**
 * Either a plan promoted to the atomic backend path, or the reason it could
 * not be — naming the step that blocked it, never a blanket refusal.
 */
type LegacyExecutePlanOutcome =
  | { ok: true; route: LegacyExecutePlanRoute }
  | { ok: false; error: string };

interface BackendExecutionTarget {
  requestedToolName: string;
  effectiveToolName: string;
  params: Record<string, unknown>;
  metaAction?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseLegacyExecutePlanSteps(
  args: Record<string, unknown>,
): { ok: true; steps: LegacyExecutePlanStep[] } | { ok: false; error: string } {
  const rawSteps = args.steps;
  if (!Array.isArray(rawSteps)) {
    return { ok: false, error: 'execute_plan requires a `steps` array.' };
  }
  if (rawSteps.length === 0) {
    return { ok: false, error: 'execute_plan requires at least one step.' };
  }
  if (rawSteps.length > MAX_PLAN_STEPS) {
    return {
      ok: false,
      error:
        `execute_plan received ${rawSteps.length} steps, which exceeds the maximum of ` +
        `${MAX_PLAN_STEPS}. Split the work into several plans.`,
    };
  }

  const steps: LegacyExecutePlanStep[] = [];
  for (const [index, rawStep] of rawSteps.entries()) {
    if (!isRecord(rawStep)) {
      return { ok: false, error: `Step at index ${index} must be an object.` };
    }

    const id = typeof rawStep.id === 'string' ? rawStep.id.trim() : '';
    const toolName = typeof rawStep.toolName === 'string' ? rawStep.toolName.trim() : '';
    const params = isRecord(rawStep.params) ? rawStep.params : null;
    const dependsOn = Array.isArray(rawStep.dependsOn)
      ? rawStep.dependsOn.filter((value): value is string => typeof value === 'string')
      : undefined;

    if (!id || !toolName || !params) {
      const missing = [
        id ? null : 'id',
        toolName ? null : 'toolName',
        params ? null : 'params',
      ].filter((field): field is string => field !== null);
      return {
        ok: false,
        error: `Step at index ${index} is missing required field(s): ${missing.join(', ')}.`,
      };
    }

    steps.push({
      id,
      toolName,
      params,
      dependsOn,
    });
  }

  return { ok: true, steps };
}

/**
 * The tools an `execute_plan` step may use, for rejection messages.
 * Compound tools are included because they expand into backend steps.
 */
function describeSupportedPlanTools(): string {
  return [...BACKEND_DIRECT_ROUTES.keys(), ...compoundExpanders.keys()].sort().join(', ');
}

function dedupeDependencies(dependsOn: string[]): string[] {
  return Array.from(new Set(dependsOn.filter((value) => value.length > 0)));
}

/**
 * Reshape one backend step result into the tool's advertised output shape.
 *
 * The backend `CommandResult` only carries `operationId`/`createdIds`/
 * `deletedIds`, so a route may only exist for a tool whose output contract this
 * function can satisfy. The route-fidelity guard in
 * `BackendToolExecutor.backendSafety.test.ts` calls it for exactly that reason.
 */
export function normalizeBackendSingleStepData(
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
      newClipId: typeof data.newClipId === 'string' ? data.newClipId : (createdIds[0] ?? null),
    };
  }

  if (toolName === 'add_transition') {
    // Callers address a transition by the effect id the command created.
    return {
      ...data,
      transitionId:
        typeof data.transitionId === 'string' ? data.transitionId : (createdIds[0] ?? null),
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
  private readonly sessionStateVersions = new Map<string, number>();
  private readonly poisonedSessions = new Set<string>();

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

    return BACKEND_DIRECT_ROUTES.has(toolName);
  }

  private isUnsafeMutatingFallback(toolName: string, args: Record<string, unknown>): boolean {
    const toolDefinition = this.frontendExecutor.getToolDefinition(toolName);
    if (!toolDefinition) {
      return false;
    }

    return requiresProjectMutationPreflight(toolName, toolDefinition.category, args);
  }

  private getMutationPreflightFailure(
    toolName: string,
    args: Record<string, unknown>,
    context: ExecutionContext,
  ): string | null {
    if (this.poisonedSessions.has(context.sessionId)) {
      return (
        'SESSION_SYNC_FAILED: a previous backend mutation succeeded but local state refresh failed. ' +
        'Refresh context and re-plan before running more mutating steps.'
      );
    }

    const { error: revisionError, currentVersion } = validateMutationStateRevision(
      context,
      this.sessionStateVersions.get(context.sessionId),
    );
    if (revisionError) {
      this.rememberSessionStateVersion(context.sessionId, currentVersion);
      return revisionError;
    }

    const preflightErrors = validateMutationPreconditions(
      toolName,
      args,
      context,
      this.frontendExecutor.getToolDefinition(toolName)?.category,
    );
    if (preflightErrors.length > 0) {
      return `PRECONDITION_FAILED: ${preflightErrors.join('; ')}`;
    }

    return null;
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
        params: normalizeBackendParamsForBackend(action, metaToolArgs),
        metaAction: action,
      };
    }

    if (!this.isBackendToolName(toolName)) {
      return null;
    }

    return {
      requestedToolName: toolName,
      effectiveToolName: toolName,
      params: normalizeBackendParamsForBackend(toolName, args),
    };
  }

  private tryBuildLegacyExecutePlanRoute(
    args: Record<string, unknown>,
    context: ExecutionContext,
  ): LegacyExecutePlanOutcome {
    const parsed = parseLegacyExecutePlanSteps(args);
    if (!parsed.ok) {
      return { ok: false, error: parsed.error };
    }
    const steps = parsed.steps;

    // A batch tool call is one tool call but many edit steps, so it must be
    // charged against the run's step budget like any planned step would be.
    const remainingStepBudget = context.remainingStepBudget;
    if (typeof remainingStepBudget === 'number' && steps.length > remainingStepBudget) {
      return {
        ok: false,
        error:
          `This plan needs ${steps.length} steps but only ${remainingStepBudget} remain in this ` +
          `run's step budget. Run a smaller plan, or finish the run and start another.`,
      };
    }

    const seenLegacyIds = new Set<string>();
    const lastBackendStepIdByLegacyId = new Map<string, string>();
    const backendSteps: AgentPlan['steps'] = [];
    const stepMappings: LegacyExecutePlanRoute['stepMappings'] = [];
    let previousLegacyFinalStepId: string | null = null;

    for (const step of steps) {
      if (seenLegacyIds.has(step.id)) {
        return { ok: false, error: `Duplicate step id '${step.id}'.` };
      }
      if (step.toolName === 'execute_plan') {
        return { ok: false, error: `Step '${step.id}': execute_plan cannot call itself.` };
      }
      seenLegacyIds.add(step.id);

      if (!this.isBackendToolName(step.toolName)) {
        return {
          ok: false,
          error:
            `Step '${step.id}' uses '${step.toolName}', which has no atomic backend route, ` +
            `so the whole plan was rejected rather than applied halfway. ` +
            `Call '${step.toolName}' on its own and keep execute_plan for these tools: ` +
            `${describeSupportedPlanTools()}.`,
        };
      }

      let explicitDependsOn: string[];
      try {
        explicitDependsOn = (step.dependsOn ?? []).map((dep) => {
          const mapped = lastBackendStepIdByLegacyId.get(dep);
          if (!mapped) {
            throw new Error(
              `Step '${step.id}' depends on '${dep}', which is not an earlier step in this plan`,
            );
          }
          return mapped;
        });
      } catch (err) {
        return { ok: false, error: `${getErrorMessage(err)}.` };
      }

      const inheritedDependsOn = previousLegacyFinalStepId ? [previousLegacyFinalStepId] : [];
      const firstStepDependsOn = dedupeDependencies([...inheritedDependsOn, ...explicitDependsOn]);

      const expander = compoundExpanders.get(step.toolName);
      if (expander) {
        let expanded: ReturnType<CompoundExpander>;
        try {
          expanded = expander(step.params);
        } catch (err) {
          return {
            ok: false,
            error: `Step '${step.id}' (${step.toolName}) could not be expanded: ${getErrorMessage(err)}`,
          };
        }
        if (expanded.length === 0) {
          return {
            ok: false,
            error: `Step '${step.id}' (${step.toolName}) expanded into no backend commands.`,
          };
        }

        const generatedIds: string[] = [];
        expanded.forEach((subStep, index) => {
          const backendStepId = `${step.id}__${index + 1}`;
          const dependsOn = index === 0 ? firstStepDependsOn : [generatedIds[index - 1]];

          const normalizedParams = normalizeBackendParamsForBackend(
            subStep.toolName,
            subStep.params,
          );
          backendSteps.push({
            id: backendStepId,
            toolName: normalizeToolNameForBackend(subStep.toolName),
            params: normalizedParams as Record<string, never>,
            description: `Execute ${subStep.toolName}`,
            riskLevel: 'low',
            dependsOn,
            optional: false,
          });
          generatedIds.push(backendStepId);
        });

        const finalBackendStepId = generatedIds[generatedIds.length - 1];
        if (!finalBackendStepId) {
          return {
            ok: false,
            error: `Step '${step.id}' (${step.toolName}) produced no executable backend step.`,
          };
        }
        previousLegacyFinalStepId = finalBackendStepId;
        lastBackendStepIdByLegacyId.set(step.id, finalBackendStepId);
        stepMappings.push({
          legacyStepId: step.id,
          backendStepIds: generatedIds,
        });
        continue;
      }

      const normalizedParams = normalizeBackendParamsForBackend(step.toolName, step.params);
      backendSteps.push({
        id: step.id,
        toolName: normalizeToolNameForBackend(step.toolName),
        params: normalizedParams as Record<string, never>,
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
      ok: true,
      route: {
        plan: {
          id: `plan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          goal: `Execute a ${steps.length}-step plan atomically`,
          steps: backendSteps,
          approvalGranted: true,
          sessionId: context.sessionId,
        },
        stepMappings,
      },
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
        const result = await runProjectBackendMutation(
          'executeAgentPlan',
          () => invoke<AgentPlanResult>('execute_agent_plan', { plan }),
          {
            refreshProjectState: false,
            markDirty: false,
            timeoutMs: AGENT_PLAN_MUTATION_TIMEOUT_MS,
          },
        );
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
      let planOutcome: LegacyExecutePlanOutcome;
      try {
        planOutcome = this.tryBuildLegacyExecutePlanRoute(args, context);
      } catch (err) {
        return createFailureResult(`execute_plan validation failed: ${getErrorMessage(err)}`, 0);
      }

      if (!planOutcome.ok) {
        return createFailureResult(`execute_plan rejected: ${planOutcome.error}`, 0);
      }

      {
        const planRoute = planOutcome.route;
        for (const step of planRoute.plan.steps) {
          if ((step.dependsOn?.length ?? 0) > 0) {
            continue;
          }
          const preflightFailure = this.getMutationPreflightFailure(
            step.toolName.replace(/[A-Z]/g, (match) => `_${match.toLowerCase()}`),
            step.params as Record<string, unknown>,
            context,
          );
          if (preflightFailure) {
            return createFailureResult(preflightFailure, 0);
          }
        }
        const execution = await this.invokeBackendPlan(planRoute.plan, {
          toolName,
          stepCount: planRoute.plan.steps.length,
        });

        if (!execution.ok) {
          this.rememberSessionStateVersion(
            context.sessionId,
            useProjectStore.getState().stateVersion,
          );
          return createFailureResult(
            `Backend execution error: ${execution.error}`,
            execution.duration,
          );
        }

        const syncWarning = await this.syncProjectState(context.sessionId);

        const stepResultById = new Map(
          execution.result.stepResults.map((stepResult) => [stepResult.stepId, stepResult]),
        );
        const stepResults = planRoute.stepMappings.map((mapping) => {
          const slice = mapping.backendStepIds
            .map((stepId) => stepResultById.get(stepId))
            .filter((stepResult): stepResult is NonNullable<typeof stepResult> =>
              Boolean(stepResult),
            );
          const allSucceeded =
            slice.length === mapping.backendStepIds.length &&
            slice.every((stepResult) => stepResult.success);
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
              execution.result.errorMessage ??
              execution.result.rollbackReport?.rollbackErrors?.join('; ') ??
              'execute_plan failed and was rolled back',
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
            ...(syncWarning ? { syncWarning } : {}),
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

    let executionTarget: BackendExecutionTarget | null;
    try {
      executionTarget = this.resolveBackendExecutionTarget(toolName, args);
    } catch (err) {
      return createFailureResult(`${toolName} validation failed: ${getErrorMessage(err)}`, 0);
    }

    if (!executionTarget) {
      if (this.isUnsafeMutatingFallback(toolName, args)) {
        const preflightFailure = this.getMutationPreflightFailure(toolName, args, context);
        if (preflightFailure) {
          return createFailureResult(preflightFailure, 0);
        }
      }

      const frontendResult = await this.frontendExecutor.execute(toolName, args, context);
      this.rememberSessionStateVersion(context.sessionId, useProjectStore.getState().stateVersion);
      return frontendResult;
    }

    const preflightFailure = this.getMutationPreflightFailure(
      executionTarget.effectiveToolName,
      executionTarget.params,
      context,
    );
    if (preflightFailure) {
      return createFailureResult(preflightFailure, 0);
    }

    const start = performance.now();
    const expander = compoundExpanders.get(executionTarget.effectiveToolName);
    let steps: AgentPlan['steps'];
    try {
      steps = expander
        ? expander(executionTarget.params).map((sub, i) => {
            const normalizedParams = normalizeBackendParamsForBackend(sub.toolName, sub.params);
            return {
              id: `step-${i + 1}`,
              toolName: normalizeToolNameForBackend(sub.toolName),
              params: normalizedParams as Record<string, never>,
              description: `Execute ${sub.toolName}`,
              riskLevel: 'low' as const,
              dependsOn: sub.dependsOn ?? (i > 0 ? [`step-${i}`] : []),
              optional: false,
            };
          })
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
      const errorMsg = getErrorMessage(err);
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
      this.rememberSessionStateVersion(context.sessionId, useProjectStore.getState().stateVersion);
      return createFailureResult(`Backend execution error: ${execution.error}`, execution.duration);
    }

    const syncWarning = await this.syncProjectState(context.sessionId);

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
        data: this.appendSyncWarning(data, syncWarning),
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
      execution.result.errorMessage ??
      execution.result.stepResults[0]?.error ??
      'Unknown backend execution error';
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

    // Resolve each tool's execution target while preserving original order.
    const resolvedTools: Array<{
      requestTool: BatchExecutionRequest['tools'][number];
      executionTarget: BackendExecutionTarget | null;
    }> = [];
    for (const tool of request.tools) {
      try {
        resolvedTools.push({
          requestTool: tool,
          executionTarget: this.resolveBackendExecutionTarget(tool.name, tool.args),
        });
      } catch (err) {
        return {
          success: false,
          results: [
            {
              tool: tool.name,
              result: createFailureResult(
                `${tool.name} validation failed: ${getErrorMessage(err)}`,
                performance.now() - start,
              ),
            },
          ],
          totalDuration: performance.now() - start,
          successCount: 0,
          failureCount: 1,
        };
      }
    }

    const allBackend = resolvedTools.every((t) => t.executionTarget !== null);

    // If the batch is mixed (backend + frontend), fall back to sequential
    // per-tool execution to preserve the caller's intended order.
    if (!allBackend) {
      for (const { requestTool } of resolvedTools) {
        const singleResult = await this.execute(requestTool.name, requestTool.args, context);
        results.push({ tool: requestTool.name, result: singleResult });
        if (singleResult.success) successCount++;
        else failureCount++;
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
        const shouldPreflightNow = request.mode !== 'sequential' || i === 0;
        if (shouldPreflightNow) {
          const preflightFailure = this.getMutationPreflightFailure(
            executionTarget.effectiveToolName,
            executionTarget.params,
            context,
          );
          if (preflightFailure) {
            return {
              success: false,
              results: [
                {
                  tool: requestTool.name,
                  result: createFailureResult(preflightFailure, performance.now() - start),
                },
              ],
              totalDuration: performance.now() - start,
              successCount: 0,
              failureCount: 1,
            };
          }
        }
        const exp = compoundExpanders.get(executionTarget.effectiveToolName);

        if (exp) {
          let subSteps: ReturnType<typeof exp>;
          try {
            subSteps = exp(executionTarget.params);
          } catch (err) {
            const errorMsg = getErrorMessage(err);
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
            const normalizedParams = normalizeBackendParamsForBackend(
              subSteps[j].toolName,
              subSteps[j].params,
            );
            allSteps.push({
              id: `step-${stepCounter + 1}`,
              toolName: normalizeToolNameForBackend(subSteps[j].toolName),
              params: normalizedParams as Record<string, never>,
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
          const planResult = await runProjectBackendMutation(
            'executeAgentPlanBatch',
            () => invoke<AgentPlanResult>('execute_agent_plan', { plan }),
            {
              refreshProjectState: false,
              markDirty: false,
              timeoutMs: AGENT_PLAN_MUTATION_TIMEOUT_MS,
            },
          );
          const syncWarning = await this.syncProjectState(context.sessionId);

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
                    data: this.appendSyncWarning(
                      mapping.stepCount > 1
                        ? {
                            steps: stepSlice.map((sr) => ({ success: sr.success, data: sr.data })),
                          }
                        : stepSlice[0].data,
                      syncWarning,
                    ),
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
          const errorMsg = getErrorMessage(err);
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
    try {
      return (
        request.tools.length > 1 &&
        request.tools.every(
          (tool) => this.resolveBackendExecutionTarget(tool.name, tool.args) !== null,
        )
      );
    } catch {
      return false;
    }
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

  private rememberSessionStateVersion(sessionId: string, stateVersion: number): void {
    this.sessionStateVersions.set(sessionId, stateVersion);
    this.poisonedSessions.delete(sessionId);
    if (this.sessionStateVersions.size <= 200) {
      return;
    }

    const oldest = this.sessionStateVersions.keys().next().value;
    if (typeof oldest === 'string') {
      this.sessionStateVersions.delete(oldest);
      this.poisonedSessions.delete(oldest);
    }
  }

  private poisonSession(sessionId: string): void {
    this.sessionStateVersions.delete(sessionId);
    this.poisonedSessions.add(sessionId);

    if (this.poisonedSessions.size <= 200) {
      return;
    }

    const oldest = this.poisonedSessions.values().next().value;
    if (typeof oldest === 'string') {
      this.poisonedSessions.delete(oldest);
    }
  }

  private async syncProjectState(sessionId: string): Promise<string | null> {
    const projectState = useProjectStore.getState();
    if (!projectState.isLoaded || !projectState.meta) {
      this.rememberSessionStateVersion(sessionId, projectState.stateVersion);
      return null;
    }

    try {
      const nextStateVersion = await projectState.refreshFromBackendMutation();

      this.rememberSessionStateVersion(sessionId, nextStateVersion);
      return null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn('Backend execution succeeded but frontend state refresh failed', {
        sessionId,
        error: message,
      });
      this.poisonSession(sessionId);
      return message;
    }
  }

  private appendSyncWarning(data: unknown, syncWarning: string | null): unknown {
    if (!syncWarning) {
      return data;
    }

    if (!isRecord(data)) {
      return {
        data,
        syncWarning,
      };
    }

    return {
      ...data,
      syncWarning,
    };
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
