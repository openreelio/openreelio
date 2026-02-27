import { describe, it, expect, beforeEach } from 'vitest';
import { TraceRecorder } from '../traceRecorder';

describe('TraceRecorder', () => {
  let recorder: TraceRecorder;

  beforeEach(() => {
    recorder = new TraceRecorder();
  });

  it('should generate a unique trace ID on construction', () => {
    const id = recorder.getTraceId();
    expect(id).toMatch(/^trace_/);
    expect(id.length).toBeGreaterThan(10);
  });

  it('should record a successful 4-phase TPAO run', () => {
    recorder.startRun({
      sessionId: 'session-1',
      input: 'split at 5 seconds',
      model: 'claude-sonnet-4-5-20251015',
      provider: 'anthropic',
    });

    // Think phase
    recorder.startPhase('thinking');
    recorder.endPhase();

    // Plan phase
    recorder.startPhase('planning');
    recorder.endPhase();

    // Execute phase
    recorder.startPhase('executing');
    recorder.recordToolCall({
      name: 'split_clip_at_time',
      success: true,
      durationMs: 42,
    });
    recorder.recordToolCall({
      name: 'trim_clip',
      success: true,
      durationMs: 18,
    });
    recorder.endPhase();

    // Observe phase
    recorder.startPhase('observing');
    recorder.endPhase();

    recorder.setIterations(1);
    const trace = recorder.finalize(true);

    expect(trace.sessionId).toBe('session-1');
    expect(trace.input).toBe('split at 5 seconds');
    expect(trace.model).toBe('claude-sonnet-4-5-20251015');
    expect(trace.provider).toBe('anthropic');
    expect(trace.fastPath).toBe(false);
    expect(trace.iterations).toBe(1);
    expect(trace.success).toBe(true);
    expect(trace.error).toBeUndefined();
    expect(trace.totalDurationMs).toBeGreaterThanOrEqual(0);
    expect(trace.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    expect(trace.phases).toHaveLength(4);
    expect(trace.phases[0].phase).toBe('thinking');
    expect(trace.phases[1].phase).toBe('planning');
    expect(trace.phases[2].phase).toBe('executing');
    expect(trace.phases[3].phase).toBe('observing');

    // Execute phase should have 2 tool calls
    expect(trace.phases[2].toolCalls).toHaveLength(2);
    expect(trace.phases[2].toolCalls[0].name).toBe('split_clip_at_time');
    expect(trace.phases[2].toolCalls[0].success).toBe(true);
    expect(trace.phases[2].toolCalls[1].name).toBe('trim_clip');
  });

  it('should record an abbreviated fast-path trace', () => {
    recorder.startRun({
      sessionId: 'session-fp',
      input: 'split at 3s',
      model: 'test-model',
      provider: 'test-provider',
    });

    recorder.setFastPath(true);

    // Fast-path only records plan + execute (abbreviated)
    recorder.startPhase('planning');
    recorder.endPhase();

    recorder.startPhase('executing');
    recorder.recordToolCall({
      name: 'split_clip_at_time',
      success: true,
      durationMs: 15,
    });
    recorder.endPhase();

    recorder.setIterations(1);
    const trace = recorder.finalize(true);

    expect(trace.fastPath).toBe(true);
    expect(trace.phases).toHaveLength(2);
    expect(trace.phases[0].phase).toBe('planning');
    expect(trace.phases[1].phase).toBe('executing');
    expect(trace.phases[1].toolCalls).toHaveLength(1);
  });

  it('should record a failed run with error message', () => {
    recorder.startRun({
      sessionId: 'session-fail',
      input: 'delete everything',
    });

    recorder.startPhase('thinking');
    recorder.endPhase();

    recorder.startPhase('planning');
    recorder.endPhase();

    recorder.startPhase('executing');
    recorder.recordToolCall({
      name: 'delete_clip',
      success: false,
      durationMs: 5,
      error: 'Clip not found',
    });
    recorder.endPhase('Execution failed: Clip not found');

    recorder.setIterations(1);
    const trace = recorder.finalize(false, 'Execution failed: Clip not found');

    expect(trace.success).toBe(false);
    expect(trace.error).toBe('Execution failed: Clip not found');
    expect(trace.phases).toHaveLength(3);
    expect(trace.phases[2].error).toBe('Execution failed: Clip not found');
    expect(trace.phases[2].toolCalls[0].success).toBe(false);
    expect(trace.phases[2].toolCalls[0].error).toBe('Clip not found');
  });

  it('should track token usage', () => {
    recorder.startRun({ sessionId: 's1', input: 'test' });
    recorder.addTokenUsage({ inputTokens: 100, outputTokens: 50, totalTokens: 150 });
    recorder.addTokenUsage({ inputTokens: 200, outputTokens: 75, totalTokens: 275 });

    const trace = recorder.finalize(true);
    expect(trace.tokenUsage.inputTokens).toBe(300);
    expect(trace.tokenUsage.outputTokens).toBe(125);
    expect(trace.tokenUsage.totalTokens).toBe(425);
  });

  it('should auto-close previous phase when starting a new one', () => {
    recorder.startRun({ sessionId: 's1', input: 'test' });

    recorder.startPhase('thinking');
    // No explicit endPhase — startPhase should close it
    recorder.startPhase('planning');
    recorder.endPhase();

    const trace = recorder.finalize(true);
    expect(trace.phases).toHaveLength(2);
    expect(trace.phases[0].phase).toBe('thinking');
    expect(trace.phases[0].durationMs).toBeGreaterThanOrEqual(0);
    expect(trace.phases[1].phase).toBe('planning');
  });

  it('should auto-close active phase on finalize', () => {
    recorder.startRun({ sessionId: 's1', input: 'test' });

    recorder.startPhase('executing');
    recorder.recordToolCall({ name: 'test_tool', success: true, durationMs: 10 });
    // No explicit endPhase — finalize should close it

    const trace = recorder.finalize(true);
    expect(trace.phases).toHaveLength(1);
    expect(trace.phases[0].toolCalls).toHaveLength(1);
  });

  it('should mark finalized state', () => {
    recorder.startRun({ sessionId: 's1', input: 'test' });
    expect(recorder.isFinalized()).toBe(false);

    recorder.finalize(true);
    expect(recorder.isFinalized()).toBe(true);
  });

  it('should handle endPhase as no-op when no phase is active', () => {
    recorder.startRun({ sessionId: 's1', input: 'test' });
    // Should not throw
    recorder.endPhase();
    const trace = recorder.finalize(true);
    expect(trace.phases).toHaveLength(0);
  });

  it('should ignore tool calls when no phase is active', () => {
    recorder.startRun({ sessionId: 's1', input: 'test' });
    // Should not throw
    recorder.recordToolCall({ name: 'orphan', success: true, durationMs: 1 });
    const trace = recorder.finalize(true);
    expect(trace.phases).toHaveLength(0);
  });

  it('should default model and provider to empty strings', () => {
    recorder.startRun({ sessionId: 's1', input: 'test' });
    const trace = recorder.finalize(true);
    expect(trace.model).toBe('');
    expect(trace.provider).toBe('');
  });
});
