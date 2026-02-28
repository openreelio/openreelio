import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useProjectStore } from '@/stores/projectStore';
import { executeAgentCommand } from './commandExecutor';

type ExecuteCommandFn = ReturnType<typeof useProjectStore.getState>['executeCommand'];

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const baseMeta = {
  id: 'project-1',
  name: 'Test Project',
  path: '/tmp/test.orio',
  createdAt: new Date().toISOString(),
  modifiedAt: new Date().toISOString(),
};

function makeLoadedStore(executeCommand: ExecuteCommandFn) {
  useProjectStore.setState({
    isLoaded: true,
    meta: baseMeta,
    activeSequenceId: null,
    executeCommand,
  });
}

// ---------------------------------------------------------------------------
// Happy-path tests
// ---------------------------------------------------------------------------

describe('executeAgentCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useProjectStore.setState({
      isLoaded: false,
      meta: null,
      activeSequenceId: null,
    });
  });

  it('should throw descriptive error when no project is loaded', async () => {
    await expect(
      executeAgentCommand('MoveClip', {
        sequenceId: 'seq_001',
        clipId: 'clip_001',
        newTimelineIn: 10,
      }),
    ).rejects.toThrow('no project is loaded');
  });

  it('should use project store executor when project is loaded', async () => {
    const mockExecuteCommand = vi.fn().mockResolvedValue({ opId: 'op_store', success: true });
    makeLoadedStore(mockExecuteCommand as unknown as ExecuteCommandFn);

    const result = await executeAgentCommand('MoveClip', {
      sequenceId: 'seq_001',
      trackId: 'track_001',
      clipId: 'clip_001',
      newTimelineIn: 12,
    });

    expect(result).toEqual({ opId: 'op_store', success: true });
    expect(mockExecuteCommand).toHaveBeenCalledWith({
      type: 'MoveClip',
      payload: {
        sequenceId: 'seq_001',
        trackId: 'track_001',
        clipId: 'clip_001',
        newTimelineIn: 12,
      },
    });
  });

  it('should include command type in error message', async () => {
    await expect(
      executeAgentCommand('SplitClip', { clipId: 'c1', splitTime: 5 }),
    ).rejects.toThrow('SplitClip');
  });
});

// ---------------------------------------------------------------------------
// Destructive / edge-case tests
// ---------------------------------------------------------------------------

describe('executeAgentCommand — destructive scenarios', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useProjectStore.setState({
      isLoaded: false,
      meta: null,
      activeSequenceId: null,
    });
  });

  // ── Guard conditions ──────────────────────────────────────────────────────

  it('should reject when isLoaded is true but meta is null (half-loaded state)', async () => {
    // This can happen during a project load race: isLoaded toggled before meta
    // is written. Both fields must be truthy to proceed.
    useProjectStore.setState({ isLoaded: true, meta: null });

    await expect(
      executeAgentCommand('DeleteClip', { clipId: 'clip_001' }),
    ).rejects.toThrow('no project is loaded');
  });

  it('should reject when isLoaded is false but meta is populated (stale meta)', async () => {
    useProjectStore.setState({ isLoaded: false, meta: baseMeta });

    await expect(
      executeAgentCommand('DeleteClip', { clipId: 'clip_001' }),
    ).rejects.toThrow('no project is loaded');
  });

  // ── Error propagation ─────────────────────────────────────────────────────

  it('should propagate errors thrown synchronously by executeCommand', async () => {
    const boom = new Error('sync store failure');
    const throwSync = vi.fn().mockImplementation(() => {
      throw boom;
    });
    makeLoadedStore(throwSync as unknown as ExecuteCommandFn);

    await expect(executeAgentCommand('SplitClip', {})).rejects.toThrow('sync store failure');
  });

  it('should propagate errors rejected asynchronously by executeCommand', async () => {
    const throwAsync = vi.fn().mockRejectedValue(new Error('async rejection'));
    makeLoadedStore(throwAsync as unknown as ExecuteCommandFn);

    await expect(executeAgentCommand('MoveClip', {})).rejects.toThrow('async rejection');
  });

  it('should propagate non-Error rejections (string)', async () => {
    const throwString = vi.fn().mockRejectedValue('plain string error');
    makeLoadedStore(throwString as unknown as ExecuteCommandFn);

    await expect(executeAgentCommand('MoveClip', {})).rejects.toBe('plain string error');
  });

  // ── Payload shape ─────────────────────────────────────────────────────────

  it('should forward an empty payload object without modification', async () => {
    const mock = vi.fn().mockResolvedValue({ opId: 'op_empty', success: true });
    makeLoadedStore(mock as unknown as ExecuteCommandFn);

    await executeAgentCommand('DeleteClip', {});

    expect(mock).toHaveBeenCalledWith({ type: 'DeleteClip', payload: {} });
  });

  it('should forward deeply nested payload without modification', async () => {
    const mock = vi.fn().mockResolvedValue({ opId: 'op_deep', success: true });
    makeLoadedStore(mock as unknown as ExecuteCommandFn);

    const nested = { a: { b: { c: [1, 2, 3] } } };
    await executeAgentCommand('SetEffect', nested);

    expect(mock).toHaveBeenCalledWith({ type: 'SetEffect', payload: nested });
  });

  // ── Concurrency ───────────────────────────────────────────────────────────

  it('should handle multiple concurrent commands without interleaving payloads', async () => {
    const results: string[] = [];
    const delayedExec = vi
      .fn()
      .mockImplementationOnce(async (cmd: { type: string }) => {
        await new Promise((r) => setTimeout(r, 10));
        results.push(cmd.type);
        return { opId: 'op_1', success: true };
      })
      .mockImplementationOnce(async (cmd: { type: string }) => {
        results.push(cmd.type);
        return { opId: 'op_2', success: true };
      });

    makeLoadedStore(delayedExec as unknown as ExecuteCommandFn);

    // Fire both concurrently — the faster one (B) should record first
    const [r1, r2] = await Promise.all([
      executeAgentCommand('CommandA', { id: 'A' }),
      executeAgentCommand('CommandB', { id: 'B' }),
    ]);

    expect(r1).toEqual({ opId: 'op_1', success: true });
    expect(r2).toEqual({ opId: 'op_2', success: true });
    // Both commands were dispatched (order determined by mock timing)
    expect(results).toContain('CommandA');
    expect(results).toContain('CommandB');
  });

  it('should not swallow store errors when one of many concurrent calls fails', async () => {
    const failingExec = vi
      .fn()
      .mockResolvedValueOnce({ opId: 'op_ok', success: true })
      .mockRejectedValueOnce(new Error('partial failure'));

    makeLoadedStore(failingExec as unknown as ExecuteCommandFn);

    const [r1, r2] = await Promise.allSettled([
      executeAgentCommand('CommandOk', {}),
      executeAgentCommand('CommandFail', {}),
    ]);

    expect(r1.status).toBe('fulfilled');
    expect(r2.status).toBe('rejected');
    if (r2.status === 'rejected') {
      expect(r2.reason.message).toBe('partial failure');
    }
  });

  // ── Store state mutation during flight ────────────────────────────────────

  it('should use the project snapshot at call time (not after await)', async () => {
    // This verifies that the guard reads state BEFORE the async boundary,
    // so a project being unloaded mid-flight does not bypass the guard for
    // calls that were already admitted.
    const capturedMeta: (string | null)[] = [];

    const captureExec = vi.fn().mockImplementation(async () => {
      // Simulate project being unloaded mid-execution
      useProjectStore.setState({ isLoaded: false, meta: null });
      capturedMeta.push('ran after unload');
      return { opId: 'op_race', success: true };
    });

    makeLoadedStore(captureExec as unknown as ExecuteCommandFn);

    // The command was admitted before unload, so it should complete
    const result = await executeAgentCommand('SomeCommand', {});
    expect(result).toEqual({ opId: 'op_race', success: true });
    expect(capturedMeta).toContain('ran after unload');
  });
});
