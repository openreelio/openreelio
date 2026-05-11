import { afterEach, describe, expect, it, vi } from 'vitest';

import { ExternalAgentApprovalBroker } from './approvalBroker';
import type { ExternalAgentApprovalRequest } from './types';

function request(
  overrides: Partial<ExternalAgentApprovalRequest> = {},
): ExternalAgentApprovalRequest {
  return {
    id: 'codex-1',
    runtimeId: 'codex',
    sessionId: 'thr_123',
    turnId: 'turn_1',
    itemId: 'item_1',
    requestId: 1,
    approvalType: 'file_change',
    tool: 'fileChange',
    description: 'Approve file changes',
    args: {},
    reason: null,
    requestedAt: 1000,
    ...overrides,
  };
}

describe('ExternalAgentApprovalBroker', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('should resolve a pending approval with the user decision', async () => {
    const broker = new ExternalAgentApprovalBroker({ timeoutMs: 0 });
    const snapshots: Array<string | null> = [];
    broker.subscribe((snapshot) => snapshots.push(snapshot.pending?.id ?? null));

    const decisionPromise = broker.requestDecision(request());

    expect(snapshots).toEqual([null, 'codex-1']);
    expect(broker.resolve('codex-1', 'accept')).toBe(true);
    await expect(decisionPromise).resolves.toBe('accept');
    expect(broker.getSnapshot().pending).toBeNull();
  });

  it('should return false when resolving an unknown request', () => {
    const broker = new ExternalAgentApprovalBroker({ timeoutMs: 0 });

    expect(broker.resolve('missing', 'decline')).toBe(false);
  });

  it('should conservatively decline when the request times out', async () => {
    vi.useFakeTimers();
    const broker = new ExternalAgentApprovalBroker({ timeoutMs: 1000 });

    const decisionPromise = broker.requestDecision(request());
    vi.advanceTimersByTime(1000);

    await expect(decisionPromise).resolves.toBe('decline');
    expect(broker.getSnapshot().pending).toBeNull();
  });

  it('should preserve epoch timestamps when ordering pending approvals', () => {
    const broker = new ExternalAgentApprovalBroker({ timeoutMs: 0, now: () => 2_000 });

    void broker.requestDecision(request({ id: 'epoch', requestedAt: 0 }));

    expect(broker.getSnapshot().pending?.requestedAt).toBe(0);
    broker.declineAll();
  });
});
