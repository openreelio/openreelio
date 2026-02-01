import { describe, expect, it, vi } from 'vitest';
import { RequestDeduplicator } from './requestDeduplicator';

describe('RequestDeduplicator (stress)', () => {
  it('deduplicates many concurrent calls under artificial latency', async () => {
    vi.useFakeTimers();

    const dedup = new RequestDeduplicator();
    let executions = 0;

    const operation = async () => {
      executions += 1;
      await new Promise<void>(resolve => setTimeout(resolve, 50));
      return 'ok';
    };

    const promises = Array.from({ length: 50 }, () =>
      dedup.execute('save_project', { projectId: 'p1' }, operation)
    );

    const all = Promise.all(promises);
    await vi.advanceTimersByTimeAsync(50);

    await expect(all).resolves.toEqual(Array.from({ length: 50 }, () => 'ok'));
    expect(executions).toBe(1);

    vi.useRealTimers();
  });

  it('does not poison the key after a failed operation', async () => {
    vi.useFakeTimers();

    const dedup = new RequestDeduplicator();
    let executions = 0;

    const failingOperation = async () => {
      executions += 1;
      await new Promise<void>(resolve => setTimeout(resolve, 10));
      throw new Error('boom');
    };

    const promises = Array.from({ length: 5 }, () =>
      dedup.execute('render', { output: 'x' }, failingOperation)
    );

    const all = Promise.allSettled(promises);
    await vi.advanceTimersByTimeAsync(10);
    const results = await all;

    expect(results.every(r => r.status === 'rejected')).toBe(true);
    expect(executions).toBe(1);

    // Let the debounce cleanup run, then ensure a new request can proceed.
    await vi.advanceTimersByTimeAsync(RequestDeduplicator.DEBOUNCE_WINDOW_MS);

    const succeedingOperation = async () => {
      executions += 1;
      return 'recovered';
    };

    await expect(
      dedup.execute('render', { output: 'x' }, succeedingOperation)
    ).resolves.toBe('recovered');
    expect(executions).toBe(2);

    vi.useRealTimers();
  });

  it('handles non-serializable payloads without throwing and still deduplicates', async () => {
    vi.useFakeTimers();

    const dedup = new RequestDeduplicator();
    let executions = 0;

    // Circular payload should be treated as non-serializable.
    const payload: Record<string, unknown> = {};
    payload.self = payload;

    const operation = async () => {
      executions += 1;
      await new Promise<void>(resolve => setTimeout(resolve, 1));
      return 123;
    };

    const a = dedup.execute('op', payload, operation);
    const b = dedup.execute('op', payload, operation);
    await vi.advanceTimersByTimeAsync(1);

    await expect(Promise.all([a, b])).resolves.toEqual([123, 123]);
    expect(executions).toBe(1);

    vi.useRealTimers();
  });
});

