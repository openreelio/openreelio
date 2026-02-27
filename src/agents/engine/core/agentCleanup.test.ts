import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  registerAgentAbort,
  unregisterAgentAbort,
  abortRunningAgent,
} from './agentCleanup';

describe('agentCleanup', () => {
  afterEach(() => {
    unregisterAgentAbort();
  });

  it('should return false when no abort is registered', () => {
    expect(abortRunningAgent()).toBe(false);
  });

  it('should call registered abort callback', () => {
    const abortFn = vi.fn();
    registerAgentAbort(abortFn);

    const result = abortRunningAgent();

    expect(result).toBe(true);
    expect(abortFn).toHaveBeenCalledOnce();
  });

  it('should return false after unregistering', () => {
    const abortFn = vi.fn();
    registerAgentAbort(abortFn);
    unregisterAgentAbort();

    expect(abortRunningAgent()).toBe(false);
    expect(abortFn).not.toHaveBeenCalled();
  });

  it('should replace previous registration', () => {
    const firstAbort = vi.fn();
    const secondAbort = vi.fn();

    registerAgentAbort(firstAbort);
    registerAgentAbort(secondAbort);

    abortRunningAgent();

    expect(firstAbort).not.toHaveBeenCalled();
    expect(secondAbort).toHaveBeenCalledOnce();
  });
});
