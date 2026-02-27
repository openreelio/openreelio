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
  /** Trace creation timestamp (ISO 8601) */
  createdAt: string;
}

// =============================================================================
// TraceRecorder Class
// =============================================================================

export class TraceRecorder {
  private traceId: string;
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
  }): void {
    this.sessionId = options.sessionId;
    this.input = options.input;
    this.model = options.model ?? '';
    this.provider = options.provider ?? '';
    this.startTime = Date.now();
    this.finalized = false;
    this.phases = [];
    this.currentPhase = null;
    this.tokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
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
    this.tokenUsage.totalTokens += usage.totalTokens ?? 0;
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
      createdAt: new Date(this.startTime).toISOString(),
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
