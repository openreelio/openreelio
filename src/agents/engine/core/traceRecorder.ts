/**
 * TraceRecorder — Structured Agent Trace Recorder
 *
 * Records OpenTelemetry-compatible JSON traces for each AgenticEngine run.
 * Traces capture phase-level granularity including tool calls, durations,
 * and token usage for debugging and observability.
 *
 * Design decisions (D3):
 * - File-based JSON traces (not SQLite) — write-once, read-rarely debugging artifacts
 * - Max 100 files per project, oldest rotated on write
 * - Config opt-out via `enableTracing: false`
 */

import { generateId } from './types';
import type { AgentPhase } from './types';
import type {
  AgentRuntimeKind,
  CompactionTier,
  CompactionTrigger,
  PermissionDecisionAction,
  PermissionDecisionSource,
  PermissionSubjectType,
  ResumeCheckpointKind,
} from './agentSession';

// =============================================================================
// Trace Types
// =============================================================================

/** Record of a single tool call within a phase */
export interface ToolCallTrace {
  /** Tool name */
  name: string;
  /** Whether the call succeeded */
  success: boolean;
  /** Duration in milliseconds */
  durationMs: number;
  /** Error message if failed */
  error?: string;
}

/** Record of a single phase within a run */
export interface PhaseTrace {
  /** Phase name (thinking, planning, executing, observing) */
  phase: AgentPhase;
  /** Phase start timestamp (epoch ms) */
  startTime: number;
  /** Phase end timestamp (epoch ms) */
  endTime: number;
  /** Duration in milliseconds */
  durationMs: number;
  /** Tool calls made during this phase */
  toolCalls: ToolCallTrace[];
  /** Error message if phase failed */
  error?: string;
}

/** Token usage summary */
export interface TokenUsage {
  /** Total input tokens */
  inputTokens: number;
  /** Total output tokens */
  outputTokens: number;
  /** Total tokens (input + output) */
  totalTokens: number;
}

/** Complete trace of an agent run */
export interface AgentTrace {
  /** Unique trace identifier */
  traceId: string;
  /** Runtime kind that produced the trace */
  runtimeKind: AgentRuntimeKind;
  /** Session identifier */
  sessionId: string;
  /** Original user input */
  input: string;
  /** Phase records in chronological order */
  phases: PhaseTrace[];
  /** Total run duration in milliseconds */
  totalDurationMs: number;
  /** Token usage across the run */
  tokenUsage: TokenUsage;
  /** Model used */
  model: string;
  /** Provider used */
  provider: string;
  /** Whether the run used the fast-path parser */
  fastPath: boolean;
  /** Total iteration count */
  iterations: number;
  /** Whether the run succeeded */
  success: boolean;
  /** Error message if run failed */
  error?: string;
  /** Shared operational metadata captured during the run */
  artifacts: AgentTraceArtifacts;
  /** Trace creation timestamp (ISO 8601) */
  createdAt: string;
}

export interface PermissionTraceRecord {
  decisionId: string | null;
  runId: string | null;
  stepId: string | null;
  subjectType: PermissionSubjectType;
  subject: string;
  action: PermissionDecisionAction;
  source: PermissionDecisionSource;
  reason: string | null;
  recordedAt: number;
}

export interface CompactionTraceRecord {
  compactionId: string | null;
  runId: string | null;
  tier: CompactionTier;
  trigger: CompactionTrigger;
  summary: string | null;
  sourceMessageCount: number;
  retainedMessageCount: number;
  estimatedTokensSaved: number | null;
  status: 'persisted' | 'recovered';
  recordedAt: number;
}

export interface CheckpointTraceRecord {
  checkpointId: string | null;
  runId: string | null;
  checkpointKind: ResumeCheckpointKind;
  phase: string | null;
  stepId: string | null;
  toolName: string | null;
  summary: string | null;
  status: 'persisted' | 'consumed' | 'recovered';
  recordedAt: number;
}

export interface AgentTraceArtifacts {
  persistedRunId: string | null;
  permissionStateVersion: number | null;
  compactionVersion: number | null;
  resumeCursorVersion: number | null;
  activeCheckpointId: string | null;
  latestSummaryMessageId: string | null;
  permissionEvents: PermissionTraceRecord[];
  compactionEvents: CompactionTraceRecord[];
  checkpointEvents: CheckpointTraceRecord[];
}

// =============================================================================
// TraceRecorder Class
// =============================================================================

export class TraceRecorder {
  private traceId: string;
  private runtimeKind: AgentRuntimeKind = 'tpao';
  private sessionId: string = '';
  private input: string = '';
  private model: string = '';
  private provider: string = '';
  private fastPath: boolean = false;
  private iterations: number = 0;
  private startTime: number = 0;

  private phases: PhaseTrace[] = [];
  private currentPhase: PhaseTrace | null = null;
  private tokenUsage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  private artifacts: AgentTraceArtifacts = createEmptyArtifacts();

  private finalized: boolean = false;

  constructor() {
    this.traceId = generateId('trace');
  }

  /**
   * Start recording a new agent run.
   */
  startRun(options: {
    sessionId: string;
    input: string;
    model?: string;
    provider?: string;
    traceId?: string;
    runtimeKind?: AgentRuntimeKind;
  }): void {
    this.traceId = options.traceId ?? generateId('trace');
    this.runtimeKind = options.runtimeKind ?? 'tpao';
    this.sessionId = options.sessionId;
    this.input = options.input;
    this.model = options.model ?? '';
    this.provider = options.provider ?? '';
    this.startTime = Date.now();
    this.finalized = false;
    this.fastPath = false;
    this.iterations = 0;
    this.phases = [];
    this.currentPhase = null;
    this.tokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    this.artifacts = createEmptyArtifacts();
  }

  /**
   * Start recording a new phase. Automatically ends the previous phase if one is active.
   */
  startPhase(phase: AgentPhase): void {
    this.endCurrentPhase();
    this.currentPhase = {
      phase,
      startTime: Date.now(),
      endTime: 0,
      durationMs: 0,
      toolCalls: [],
    };
  }

  /**
   * End the current phase and push it to the phases list.
   * If no phase is active, this is a no-op.
   */
  endPhase(error?: string): void {
    this.endCurrentPhase(error);
  }

  /**
   * Record a tool call within the current phase.
   */
  recordToolCall(toolCall: ToolCallTrace): void {
    if (this.currentPhase) {
      this.currentPhase.toolCalls.push(toolCall);
    }
  }

  /**
   * Update the iteration count.
   */
  setIterations(count: number): void {
    this.iterations = count;
  }

  /**
   * Mark this run as using fast-path.
   */
  setFastPath(fastPath: boolean): void {
    this.fastPath = fastPath;
  }

  /**
   * Accumulate token usage.
   */
  addTokenUsage(usage: Partial<TokenUsage>): void {
    this.tokenUsage.inputTokens += usage.inputTokens ?? 0;
    this.tokenUsage.outputTokens += usage.outputTokens ?? 0;
    // Derive total from components to prevent drift
    this.tokenUsage.totalTokens = this.tokenUsage.inputTokens + this.tokenUsage.outputTokens;
  }

  /**
   * Finalize the trace and return the completed AgentTrace.
   * Ends any active phase before finalizing.
   */
  finalize(success: boolean, error?: string): AgentTrace {
    this.endCurrentPhase(error);
    this.finalized = true;

    const endTime = Date.now();
    return {
      traceId: this.traceId,
      runtimeKind: this.runtimeKind,
      sessionId: this.sessionId,
      input: this.input,
      phases: this.phases,
      totalDurationMs: endTime - this.startTime,
      tokenUsage: this.tokenUsage,
      model: this.model,
      provider: this.provider,
      fastPath: this.fastPath,
      iterations: this.iterations,
      success,
      error,
      artifacts: this.artifacts,
      createdAt: new Date(this.startTime).toISOString(),
    };
  }

  recordPermissionEvent(event: PermissionTraceRecord): void {
    this.artifacts.permissionEvents.push(event);
  }

  recordCompactionEvent(event: CompactionTraceRecord): void {
    this.artifacts.compactionEvents.push(event);
  }

  recordCheckpointEvent(event: CheckpointTraceRecord): void {
    this.artifacts.checkpointEvents.push(event);
  }

  setArtifactState(
    state: Partial<Omit<AgentTraceArtifacts, 'permissionEvents' | 'compactionEvents' | 'checkpointEvents'>>,
  ): void {
    this.artifacts = {
      ...this.artifacts,
      ...state,
    };
  }

  /**
   * Whether the trace has been finalized.
   */
  isFinalized(): boolean {
    return this.finalized;
  }

  /**
   * Get the trace ID.
   */
  getTraceId(): string {
    return this.traceId;
  }

  // ===========================================================================
  // Private Helpers
  // ===========================================================================

  private endCurrentPhase(error?: string): void {
    if (!this.currentPhase) return;
    const endTime = Date.now();
    this.currentPhase.endTime = endTime;
    this.currentPhase.durationMs = endTime - this.currentPhase.startTime;
    if (error) {
      this.currentPhase.error = error;
    }
    this.phases.push(this.currentPhase);
    this.currentPhase = null;
  }
}

export function mergeTraceArtifacts(baseTrace: AgentTrace, artifactTrace: AgentTrace): AgentTrace {
  return {
    ...baseTrace,
    runtimeKind: artifactTrace.runtimeKind,
    artifacts: {
      ...baseTrace.artifacts,
      ...artifactTrace.artifacts,
      permissionEvents: [
        ...baseTrace.artifacts.permissionEvents,
        ...artifactTrace.artifacts.permissionEvents,
      ],
      compactionEvents: [
        ...baseTrace.artifacts.compactionEvents,
        ...artifactTrace.artifacts.compactionEvents,
      ],
      checkpointEvents: [
        ...baseTrace.artifacts.checkpointEvents,
        ...artifactTrace.artifacts.checkpointEvents,
      ],
    },
  };
}

function createEmptyArtifacts(): AgentTraceArtifacts {
  return {
    persistedRunId: null,
    permissionStateVersion: null,
    compactionVersion: null,
    resumeCursorVersion: null,
    activeCheckpointId: null,
    latestSummaryMessageId: null,
    permissionEvents: [],
    compactionEvents: [],
    checkpointEvents: [],
  };
}
