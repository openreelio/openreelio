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
    const decisions: Array<{ id: string; decision: string }> = [];
    broker.subscribe((snapshot) => snapshots.push(snapshot.pending?.id ?? null));
    broker.subscribeDecision((resolvedRequest, decision) => {
      decisions.push({ id: resolvedRequest.id, decision });
    });

    const decisionPromise = broker.requestDecision(request());

    expect(snapshots).toEqual([null, 'codex-1']);
    expect(broker.resolve('codex-1', 'accept')).toBe(true);
    await expect(decisionPromise).resolves.toBe('accept');
    expect(broker.getSnapshot().pending).toBeNull();
    expect(decisions).toEqual([{ id: 'codex-1', decision: 'accept' }]);
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

  it('should auto-resolve approvals from policy without showing a pending request', async () => {
    const policyResolver = vi.fn(() => 'accept' as const);
    const broker = new ExternalAgentApprovalBroker({ timeoutMs: 0, policyResolver });
    const snapshots: Array<string | null> = [];
    const decisions: Array<{ id: string; decision: string }> = [];
    broker.subscribe((snapshot) => snapshots.push(snapshot.pending?.id ?? null));
    broker.subscribeDecision((resolvedRequest, decision) => {
      decisions.push({ id: resolvedRequest.id, decision });
    });

    await expect(broker.requestDecision(request())).resolves.toBe('accept');

    expect(policyResolver).toHaveBeenCalledWith(expect.objectContaining({ id: 'codex-1' }));
    expect(snapshots).toEqual([null]);
    expect(broker.getSnapshot().pending).toBeNull();
    expect(decisions).toEqual([{ id: 'codex-1', decision: 'accept' }]);
  });

  it('should fall back to pending user approval when policy resolution fails', async () => {
    const policyResolver = vi.fn().mockRejectedValue(new Error('policy unavailable'));
    const broker = new ExternalAgentApprovalBroker({ timeoutMs: 0, policyResolver });
    const snapshots: Array<string | null> = [];
    broker.subscribe((snapshot) => snapshots.push(snapshot.pending?.id ?? null));

    const decisionPromise = broker.requestDecision(request());
    await Promise.resolve();

    expect(policyResolver).toHaveBeenCalledWith(expect.objectContaining({ id: 'codex-1' }));
    expect(snapshots).toEqual([null, 'codex-1']);
    expect(broker.resolveLatest('accept')).toBe(true);
    await expect(decisionPromise).resolves.toBe('accept');
  });

  it('should preserve epoch timestamps when ordering pending approvals', () => {
    const broker = new ExternalAgentApprovalBroker({ timeoutMs: 0, now: () => 2_000 });

    void broker.requestDecision(request({ id: 'epoch', requestedAt: 0 }));

    expect(broker.getSnapshot().pending?.requestedAt).toBe(0);
    broker.declineAll();
  });
});
