/**
 * SessionGuard
 *
 * Validates session and project consistency at phase boundaries.
 * Prevents stale execution when the active project changes during
 * a multi-step agent run.
 *
 * Also enforces a simple state machine: phase transitions must follow
 * the TPAO order (idle → thinking → planning → awaiting_approval →
 * executing → observing → completed/failed/aborted). Invalid
 * transitions are rejected with a descriptive error.
 */

import type { AgentPhase } from './types';

// =============================================================================
// Errors
// =============================================================================

export class SessionMismatchError extends Error {
  constructor(
    public readonly expectedProjectId: string,
    public readonly actualProjectId: string,
  ) {
    super(
      `Project changed during agent execution: expected '${expectedProjectId}', got '${actualProjectId}'`,
    );
    this.name = 'SessionMismatchError';
  }
}

export class InvalidPhaseTransitionError extends Error {
  constructor(
    public readonly from: AgentPhase,
    public readonly to: AgentPhase,
  ) {
    super(`Invalid phase transition: '${from}' → '${to}'`);
    this.name = 'InvalidPhaseTransitionError';
  }
}

// =============================================================================
// Valid Transitions
// =============================================================================

/**
 * Allowed phase transitions. Each key maps to the set of phases
 * it can transition to.
 */
const VALID_TRANSITIONS: Record<AgentPhase, AgentPhase[]> = {
  idle: ['thinking'],
  thinking: ['planning', 'completed', 'failed', 'aborted'],
  planning: ['awaiting_approval', 'executing', 'completed', 'failed', 'aborted'],
  awaiting_approval: ['executing', 'completed', 'failed', 'aborted'],
  executing: ['observing', 'completed', 'failed', 'aborted'],
  observing: ['thinking', 'completed', 'failed', 'aborted'],
  completed: ['idle'],
  failed: ['idle'],
  aborted: ['idle'],
};

// =============================================================================
// SessionGuard
// =============================================================================

export class SessionGuard {
  private currentPhase: AgentPhase = 'idle';

  constructor(
    private readonly sessionId: string,
    private readonly projectId: string,
    private readonly projectIdProvider: () => string | undefined,
  ) {}

  /**
   * Validates that the active project has not changed since the session started.
   * Should be called before each phase transition.
   *
   * @throws SessionMismatchError if the project ID no longer matches.
   */
  validateProjectId(): void {
    const currentProjectId = this.projectIdProvider();
    if (currentProjectId !== undefined && currentProjectId !== this.projectId) {
      throw new SessionMismatchError(this.projectId, currentProjectId);
    }
  }

  /**
   * Validates and transitions to a new phase.
   *
   * @param nextPhase - The phase to transition to.
   * @throws InvalidPhaseTransitionError if the transition is not allowed.
   */
  transition(nextPhase: AgentPhase): void {
    const allowed = VALID_TRANSITIONS[this.currentPhase];
    if (!allowed.includes(nextPhase)) {
      throw new InvalidPhaseTransitionError(this.currentPhase, nextPhase);
    }
    this.currentPhase = nextPhase;
  }

  /**
   * Combined check: validates project ID and transitions phase.
   *
   * @param nextPhase - The phase to transition to.
   * @throws SessionMismatchError or InvalidPhaseTransitionError
   */
  guardPhase(nextPhase: AgentPhase): void {
    this.validateProjectId();
    this.transition(nextPhase);
  }

  /** Returns the current phase. */
  getPhase(): AgentPhase {
    return this.currentPhase;
  }

  /** Returns the session ID this guard was created for. */
  getSessionId(): string {
    return this.sessionId;
  }

  /** Resets the guard back to idle. */
  reset(): void {
    this.currentPhase = 'idle';
  }
}
