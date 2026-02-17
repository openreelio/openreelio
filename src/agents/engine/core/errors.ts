/**
 * Agentic Engine - Custom Errors
 *
 * Defines all error types used throughout the Agentic Engine.
 * Each error type provides structured information for proper handling.
 */

import type { AgentPhase, PlanStep } from './types';

// =============================================================================
// Base Error
// =============================================================================

/**
 * Base class for all Agentic Engine errors
 */
export abstract class AgentError extends Error {
  /** Error code for programmatic handling */
  abstract readonly code: string;
  /** Phase where error occurred */
  abstract readonly phase: AgentPhase;
  /** Whether this error is recoverable */
  abstract readonly recoverable: boolean;
  /** Timestamp when error occurred */
  readonly timestamp: number;

  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
    this.timestamp = Date.now();

    // Maintain proper stack trace in V8 environments
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }

  /**
   * Convert to a plain object for serialization
   */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      phase: this.phase,
      recoverable: this.recoverable,
      timestamp: this.timestamp,
      stack: this.stack,
    };
  }
}

// =============================================================================
// Configuration Errors
// =============================================================================

/**
 * Error in engine configuration
 */
export class ConfigurationError extends AgentError {
  readonly code = 'CONFIG_ERROR';
  readonly phase: AgentPhase = 'idle';
  readonly recoverable = false;
  readonly invalidField: string;

  constructor(message: string, invalidField: string) {
    super(message);
    this.invalidField = invalidField;
  }

  toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      invalidField: this.invalidField,
    };
  }
}

// =============================================================================
// Session Errors
// =============================================================================

/**
 * Session already in progress
 */
export class SessionActiveError extends AgentError {
  readonly code = 'SESSION_ACTIVE';
  readonly phase: AgentPhase = 'idle';
  readonly recoverable = false;
  readonly activeSessionId: string;

  constructor(activeSessionId: string) {
    super(`Session ${activeSessionId} is already active`);
    this.activeSessionId = activeSessionId;
  }

  toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      activeSessionId: this.activeSessionId,
    };
  }
}

/**
 * Session was aborted by user or system
 */
export class SessionAbortedError extends AgentError {
  readonly code = 'SESSION_ABORTED';
  readonly phase: AgentPhase;
  readonly recoverable = false;
  readonly reason: string;

  constructor(reason: string, phase: AgentPhase) {
    super(`Session aborted: ${reason}`);
    this.reason = reason;
    this.phase = phase;
  }

  toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      reason: this.reason,
    };
  }
}

// =============================================================================
// Think Phase Errors
// =============================================================================

/**
 * Timeout during thinking phase
 */
export class ThinkingTimeoutError extends AgentError {
  readonly code = 'THINKING_TIMEOUT';
  readonly phase: AgentPhase = 'thinking';
  readonly recoverable = true;
  readonly timeoutMs: number;

  constructor(timeoutMs: number, hint?: string) {
    super(
      `Thinking phase timed out after ${timeoutMs}ms. ` +
        (hint ??
          'AI response took too long. Check your AI provider settings or try a simpler request.'),
    );
    this.timeoutMs = timeoutMs;
  }

  toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      timeoutMs: this.timeoutMs,
    };
  }
}

/**
 * Failed to understand user input
 */
export class UnderstandingError extends AgentError {
  readonly code = 'UNDERSTANDING_FAILED';
  readonly phase: AgentPhase = 'thinking';
  readonly recoverable = true;
  readonly details?: string;

  constructor(message: string, details?: string | Record<string, unknown>) {
    super(message);
    this.details = typeof details === 'string' ? details : undefined;
  }

  toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      details: this.details,
    };
  }
}

// =============================================================================
// Plan Phase Errors
// =============================================================================

/**
 * Timeout during planning phase
 */
export class PlanningTimeoutError extends AgentError {
  readonly code = 'PLANNING_TIMEOUT';
  readonly phase: AgentPhase = 'planning';
  readonly recoverable = true;
  readonly timeoutMs: number;

  constructor(timeoutMs: number, hint?: string) {
    super(
      `Planning phase timed out after ${timeoutMs}ms. ` +
        (hint ??
          'AI response took too long. Check your AI provider settings or try a simpler request.'),
    );
    this.timeoutMs = timeoutMs;
  }

  toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      timeoutMs: this.timeoutMs,
    };
  }
}

/**
 * Failed to generate a valid plan
 */
export class PlanGenerationError extends AgentError {
  readonly code = 'PLAN_GENERATION_FAILED';
  readonly phase: AgentPhase = 'planning';
  readonly recoverable = true;
  readonly reason: string;

  constructor(reason: string) {
    super(`Failed to generate plan: ${reason}`);
    this.reason = reason;
  }

  toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      reason: this.reason,
    };
  }
}

/**
 * Plan validation failed
 */
export class PlanValidationError extends AgentError {
  readonly code = 'PLAN_VALIDATION_FAILED';
  readonly phase: AgentPhase = 'planning';
  readonly recoverable = true;
  readonly validationErrors: string[];

  constructor(message: string, validationErrors: string[]) {
    super(
      `${message}: ${validationErrors.length > 0 ? validationErrors.join(', ') : 'no details'}`,
    );
    this.validationErrors = validationErrors;
  }

  toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      validationErrors: this.validationErrors,
    };
  }
}

/**
 * Required tool not available
 */
export class ToolNotFoundError extends AgentError {
  readonly code = 'TOOL_NOT_FOUND';
  readonly phase: AgentPhase = 'planning';
  readonly recoverable = false;
  readonly toolName: string;

  constructor(toolName: string) {
    super(`Required tool not found: ${toolName}`);
    this.toolName = toolName;
  }

  toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      toolName: this.toolName,
    };
  }
}

// =============================================================================
// Approval Errors
// =============================================================================

/**
 * User rejected the plan
 */
export class ApprovalRejectedError extends AgentError {
  readonly code = 'APPROVAL_REJECTED';
  readonly phase: AgentPhase = 'awaiting_approval';
  readonly recoverable = false;
  readonly planId: string;
  readonly reason?: string;

  constructor(planId: string, reason?: string) {
    super(`Plan ${planId} was rejected${reason ? `: ${reason}` : ''}`);
    this.planId = planId;
    this.reason = reason;
  }

  toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      planId: this.planId,
      reason: this.reason,
    };
  }
}

/**
 * Approval request timed out
 */
export class ApprovalTimeoutError extends AgentError {
  readonly code = 'APPROVAL_TIMEOUT';
  readonly phase: AgentPhase = 'awaiting_approval';
  readonly recoverable = false;
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Approval request timed out after ${timeoutMs}ms`);
    this.timeoutMs = timeoutMs;
  }

  toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      timeoutMs: this.timeoutMs,
    };
  }
}

// =============================================================================
// Execution Errors
// =============================================================================

/**
 * Timeout during tool execution
 */
export class ExecutionTimeoutError extends AgentError {
  readonly code = 'EXECUTION_TIMEOUT';
  readonly phase: AgentPhase = 'executing';
  readonly recoverable = true;
  readonly timeoutMs: number;
  readonly stepId: string;
  readonly step?: PlanStep;

  constructor(stepOrId: PlanStep | string, timeoutMs: number) {
    const stepId = typeof stepOrId === 'string' ? stepOrId : stepOrId.id;
    const toolName = typeof stepOrId === 'string' ? stepId : stepOrId.tool;
    super(`Tool ${toolName} timed out after ${timeoutMs}ms`);
    this.stepId = stepId;
    this.timeoutMs = timeoutMs;
    if (typeof stepOrId !== 'string') {
      this.step = stepOrId;
    }
  }

  toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      timeoutMs: this.timeoutMs,
      stepId: this.stepId,
      step: this.step,
    };
  }
}

/**
 * Tool execution failed
 */
export class ToolExecutionError extends AgentError {
  readonly code = 'TOOL_EXECUTION_FAILED';
  readonly phase: AgentPhase = 'executing';
  readonly recoverable: boolean;
  readonly stepId: string;
  readonly toolError: string;
  readonly step?: PlanStep;

  constructor(
    stepIdOrStep: string | PlanStep,
    toolError: string | Error,
    recoverable: boolean = true,
  ) {
    const stepId = typeof stepIdOrStep === 'string' ? stepIdOrStep : stepIdOrStep.id;
    const errorMessage = toolError instanceof Error ? toolError.message : toolError;

    super(`Tool execution failed at step ${stepId}: ${errorMessage}`);
    this.stepId = stepId;
    this.toolError = errorMessage;
    this.recoverable = recoverable;

    if (typeof stepIdOrStep !== 'string') {
      this.step = stepIdOrStep;
    }
  }

  toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      stepId: this.stepId,
      step: this.step,
      toolError: this.toolError,
    };
  }
}

/**
 * Invalid tool arguments
 */
export class InvalidArgumentsError extends AgentError {
  readonly code = 'INVALID_ARGUMENTS';
  readonly phase: AgentPhase = 'executing';
  readonly recoverable = true;
  readonly toolName: string;
  readonly validationErrors: string[];

  constructor(toolName: string, validationErrors: string[]) {
    super(`Invalid arguments for ${toolName}: ${validationErrors.join(', ')}`);
    this.toolName = toolName;
    this.validationErrors = validationErrors;
  }

  toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      toolName: this.toolName,
      validationErrors: this.validationErrors,
    };
  }
}

/**
 * Step dependency not satisfied
 */
export class DependencyError extends AgentError {
  readonly code = 'DEPENDENCY_NOT_SATISFIED';
  readonly phase: AgentPhase = 'executing';
  readonly recoverable = false;
  readonly stepId: string;
  readonly missingDependencies: string[];

  constructor(stepId: string, missingDependencies: string[]) {
    super(`Step ${stepId} has unsatisfied dependencies: ${missingDependencies.join(', ')}`);
    this.stepId = stepId;
    this.missingDependencies = missingDependencies;
  }

  toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      stepId: this.stepId,
      missingDependencies: this.missingDependencies,
    };
  }
}

/**
 * Planned steps exceed configured run budget
 */
export class StepBudgetExceededError extends AgentError {
  readonly code = 'STEP_BUDGET_EXCEEDED';
  readonly phase: AgentPhase = 'planning';
  readonly recoverable = true;
  readonly maxSteps: number;
  readonly attemptedSteps: number;

  constructor(maxSteps: number, attemptedSteps: number) {
    super(`Step budget exceeded: attempted ${attemptedSteps}, allowed ${maxSteps}`);
    this.maxSteps = maxSteps;
    this.attemptedSteps = attemptedSteps;
  }

  toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      maxSteps: this.maxSteps,
      attemptedSteps: this.attemptedSteps,
    };
  }
}

/**
 * Tool call attempts exceed configured run budget
 */
export class ToolBudgetExceededError extends AgentError {
  readonly code = 'TOOL_BUDGET_EXCEEDED';
  readonly phase: AgentPhase = 'executing';
  readonly recoverable = true;
  readonly maxToolCalls: number;
  readonly usedToolCalls: number;
  readonly stepId?: string;
  readonly toolName?: string;

  constructor(maxToolCalls: number, usedToolCalls: number, stepId?: string, toolName?: string) {
    const stepLabel = stepId ? ` at step ${stepId}` : '';
    const toolLabel = toolName ? ` (${toolName})` : '';
    super(
      `Tool call budget exceeded${stepLabel}${toolLabel}: used ${usedToolCalls}, allowed ${maxToolCalls}`,
    );
    this.maxToolCalls = maxToolCalls;
    this.usedToolCalls = usedToolCalls;
    this.stepId = stepId;
    this.toolName = toolName;
  }

  toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      maxToolCalls: this.maxToolCalls,
      usedToolCalls: this.usedToolCalls,
      stepId: this.stepId,
      toolName: this.toolName,
    };
  }
}

// =============================================================================
// Doom Loop Error
// =============================================================================

/**
 * Agent is stuck in a repetitive loop calling the same tool
 */
export class DoomLoopError extends AgentError {
  readonly code = 'DOOM_LOOP_DETECTED';
  readonly phase: AgentPhase = 'executing';
  readonly recoverable = false;
  readonly tool: string;
  readonly consecutiveCalls: number;

  constructor(tool: string, consecutiveCalls: number) {
    super(
      `Doom loop detected: tool '${tool}' called ${consecutiveCalls} consecutive times with identical arguments`,
    );
    this.tool = tool;
    this.consecutiveCalls = consecutiveCalls;
  }

  toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      tool: this.tool,
      consecutiveCalls: this.consecutiveCalls,
    };
  }
}

// =============================================================================
// Observation Errors
// =============================================================================

/**
 * Timeout during observation phase
 */
export class ObservationTimeoutError extends AgentError {
  readonly code = 'OBSERVATION_TIMEOUT';
  readonly phase: AgentPhase = 'observing';
  readonly recoverable = true;
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Observation phase timed out after ${timeoutMs}ms`);
    this.timeoutMs = timeoutMs;
  }

  toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      timeoutMs: this.timeoutMs,
    };
  }
}

/**
 * Observation analysis failed
 */
export class ObservationError extends AgentError {
  readonly code = 'OBSERVATION_FAILED';
  readonly phase: AgentPhase = 'observing';
  readonly recoverable = true;

  constructor(message: string) {
    super(message);
  }
}

// =============================================================================
// Iteration Errors
// =============================================================================

/**
 * Maximum iterations exceeded
 */
export class MaxIterationsError extends AgentError {
  readonly code = 'MAX_ITERATIONS_EXCEEDED';
  readonly phase: AgentPhase;
  readonly recoverable = false;
  readonly maxIterations: number;

  constructor(maxIterations: number, phase: AgentPhase) {
    super(`Maximum iterations (${maxIterations}) exceeded`);
    this.maxIterations = maxIterations;
    this.phase = phase;
  }

  toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      maxIterations: this.maxIterations,
    };
  }
}

// =============================================================================
// LLM Errors
// =============================================================================

/**
 * LLM API call failed
 */
export class LLMError extends AgentError {
  readonly code = 'LLM_ERROR';
  readonly phase: AgentPhase;
  readonly recoverable: boolean;
  readonly provider: string;
  readonly statusCode?: number;

  constructor(
    provider: string,
    message: string,
    phase: AgentPhase,
    statusCode?: number,
    recoverable: boolean = true,
  ) {
    super(`LLM error (${provider}): ${message}`);
    this.provider = provider;
    this.phase = phase;
    this.statusCode = statusCode;
    this.recoverable = recoverable;
  }

  toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      provider: this.provider,
      statusCode: this.statusCode,
    };
  }
}

/**
 * LLM rate limit exceeded
 */
export class RateLimitError extends LLMError {
  readonly retryAfterMs?: number;

  constructor(provider: string, phase: AgentPhase, retryAfterMs?: number) {
    super(provider, 'Rate limit exceeded', phase, 429, true);
    this.retryAfterMs = retryAfterMs;
  }

  toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      retryAfterMs: this.retryAfterMs,
    };
  }
}

/**
 * LLM authentication failed
 */
export class AuthenticationError extends LLMError {
  constructor(provider: string, phase: AgentPhase) {
    super(provider, 'Authentication failed', phase, 401, false);
  }
}

// =============================================================================
// Context Errors
// =============================================================================

/**
 * Context is invalid or missing required data
 */
export class ContextError extends AgentError {
  readonly code = 'CONTEXT_ERROR';
  readonly phase: AgentPhase;
  readonly recoverable = false;
  readonly missingFields: string[];

  constructor(missingFields: string[], phase: AgentPhase) {
    super(`Invalid context: missing ${missingFields.join(', ')}`);
    this.missingFields = missingFields;
    this.phase = phase;
  }

  toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      missingFields: this.missingFields,
    };
  }
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Check if an error is an AgentError
 */
export function isAgentError(error: unknown): error is AgentError {
  return error instanceof AgentError;
}

/**
 * Check if an error is recoverable
 */
export function isRecoverable(error: unknown): boolean {
  if (isAgentError(error)) {
    return error.recoverable;
  }
  return false;
}

/**
 * Generic wrapper for unexpected errors.
 *
 * This is used to preserve the phase where an error occurred while keeping
 * the error surface consistent for the UI layer.
 */
export class UnhandledAgentError extends AgentError {
  readonly code = 'UNHANDLED_ERROR';
  readonly phase: AgentPhase;
  readonly recoverable = true;
  readonly originalName: string | null;

  constructor(phase: AgentPhase, original: unknown) {
    const message = original instanceof Error ? original.message : String(original);
    super(`[${phase}] ${message}`);
    this.phase = phase;
    this.originalName = original instanceof Error ? original.name : null;
  }

  toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      originalName: this.originalName,
    };
  }
}

/**
 * Wrap any error as an AgentError
 */
export function wrapError(error: unknown, phase: AgentPhase): AgentError {
  if (isAgentError(error)) {
    return error;
  }

  return new UnhandledAgentError(phase, error);
}

/**
 * Create timeout error for the given phase
 */
export function createTimeoutError(phase: AgentPhase, timeoutMs: number): AgentError {
  switch (phase) {
    case 'thinking':
      return new ThinkingTimeoutError(timeoutMs);
    case 'planning':
      return new PlanningTimeoutError(timeoutMs);
    case 'observing':
      return new ObservationTimeoutError(timeoutMs);
    default:
      return new ExecutionTimeoutError('timeout', timeoutMs);
  }
}
