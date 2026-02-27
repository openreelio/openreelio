/**
 * useAgentApproval Hook Tests
 *
 * Tests for the approval management hook.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useAgentApproval, useAgentApprovalStore, clearPendingApprovals } from './useAgentApproval';

describe('useAgentApproval', () => {
  beforeEach(() => {
    useAgentApprovalStore.getState().reset();
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe('initial state', () => {
    it('should have no pending request initially', () => {
      const { result } = renderHook(() => useAgentApproval());

      expect(result.current.hasPendingRequest).toBe(false);
    });

    it('should have null current request initially', () => {
      const { result } = renderHook(() => useAgentApproval());

      expect(result.current.currentRequest).toBeNull();
    });

    it('should have empty history initially', () => {
      const { result } = renderHook(() => useAgentApproval());

      expect(result.current.history).toEqual([]);
    });
  });

  describe('requestApproval', () => {
    it('should create approval request', async () => {
      const { result } = renderHook(() => useAgentApproval());

      act(() => {
        result.current.requestApproval({
          toolName: 'delete_clip',
          description: 'Delete clip from timeline',
          riskLevel: 'high',
        });
      });

      expect(result.current.hasPendingRequest).toBe(true);
      expect(result.current.currentRequest?.toolName).toBe('delete_clip');
    });

    it('should generate request ID', () => {
      const { result } = renderHook(() => useAgentApproval());

      act(() => {
        result.current.requestApproval({
          toolName: 'delete_clip',
          description: 'Delete clip',
          riskLevel: 'high',
        });
      });

      expect(result.current.currentRequest?.id).toBeTruthy();
    });

    it('should include timestamp', () => {
      const { result } = renderHook(() => useAgentApproval());

      const now = Date.now();
      vi.setSystemTime(now);

      act(() => {
        result.current.requestApproval({
          toolName: 'delete_clip',
          description: 'Delete clip',
          riskLevel: 'high',
        });
      });

      expect(result.current.currentRequest?.createdAt).toBe(now);
    });

    it('should reject if request already pending', () => {
      const { result } = renderHook(() => useAgentApproval());

      act(() => {
        result.current.requestApproval({
          toolName: 'first',
          description: 'First',
          riskLevel: 'low',
        });
      });

      act(() => {
        result.current.requestApproval({
          toolName: 'second',
          description: 'Second',
          riskLevel: 'low',
        });
      });

      // Should keep first request
      expect(result.current.currentRequest?.toolName).toBe('first');
    });
  });

  describe('approve', () => {
    it('should approve pending request', () => {
      const { result } = renderHook(() => useAgentApproval());

      act(() => {
        result.current.requestApproval({
          toolName: 'delete_clip',
          description: 'Delete clip',
          riskLevel: 'high',
        });
      });

      const requestId = result.current.currentRequest!.id;

      act(() => {
        result.current.approve(requestId);
      });

      expect(result.current.hasPendingRequest).toBe(false);
      expect(result.current.currentRequest).toBeNull();
    });

    it('should add approved request to history', () => {
      const { result } = renderHook(() => useAgentApproval());

      act(() => {
        result.current.requestApproval({
          toolName: 'delete_clip',
          description: 'Delete clip',
          riskLevel: 'high',
        });
      });

      const requestId = result.current.currentRequest!.id;

      act(() => {
        result.current.approve(requestId);
      });

      expect(result.current.history).toHaveLength(1);
      expect(result.current.history[0].response).toBe('approved');
    });

    it('should call onApprove callback if provided', () => {
      const { result } = renderHook(() => useAgentApproval());
      const onApprove = vi.fn();

      act(() => {
        result.current.requestApproval({
          toolName: 'delete_clip',
          description: 'Delete clip',
          riskLevel: 'high',
          onApprove,
        });
      });

      const requestId = result.current.currentRequest!.id;

      act(() => {
        result.current.approve(requestId);
      });

      expect(onApprove).toHaveBeenCalled();
    });

    it('should ignore if request ID does not match', () => {
      const { result } = renderHook(() => useAgentApproval());

      act(() => {
        result.current.requestApproval({
          toolName: 'delete_clip',
          description: 'Delete clip',
          riskLevel: 'high',
        });
      });

      act(() => {
        result.current.approve('wrong-id');
      });

      expect(result.current.hasPendingRequest).toBe(true);
    });
  });

  describe('reject', () => {
    it('should reject pending request', () => {
      const { result } = renderHook(() => useAgentApproval());

      act(() => {
        result.current.requestApproval({
          toolName: 'delete_clip',
          description: 'Delete clip',
          riskLevel: 'high',
        });
      });

      const requestId = result.current.currentRequest!.id;

      act(() => {
        result.current.reject(requestId);
      });

      expect(result.current.hasPendingRequest).toBe(false);
    });

    it('should add rejected request to history', () => {
      const { result } = renderHook(() => useAgentApproval());

      act(() => {
        result.current.requestApproval({
          toolName: 'delete_clip',
          description: 'Delete clip',
          riskLevel: 'high',
        });
      });

      const requestId = result.current.currentRequest!.id;

      act(() => {
        result.current.reject(requestId, 'Too risky');
      });

      expect(result.current.history[0].response).toBe('rejected');
      expect(result.current.history[0].reason).toBe('Too risky');
    });

    it('should call onReject callback if provided', () => {
      const { result } = renderHook(() => useAgentApproval());
      const onReject = vi.fn();

      act(() => {
        result.current.requestApproval({
          toolName: 'delete_clip',
          description: 'Delete clip',
          riskLevel: 'high',
          onReject,
        });
      });

      const requestId = result.current.currentRequest!.id;

      act(() => {
        result.current.reject(requestId, 'No');
      });

      expect(onReject).toHaveBeenCalledWith('No');
    });
  });

  describe('dismiss', () => {
    it('should dismiss without adding to history', () => {
      const { result } = renderHook(() => useAgentApproval());

      act(() => {
        result.current.requestApproval({
          toolName: 'delete_clip',
          description: 'Delete clip',
          riskLevel: 'high',
        });
      });

      act(() => {
        result.current.dismiss();
      });

      expect(result.current.hasPendingRequest).toBe(false);
      expect(result.current.history).toHaveLength(0);
    });
  });

  describe('waitForApproval', () => {
    // These async tests need real timers for Promise resolution
    beforeEach(() => {
      vi.useRealTimers();
    });

    afterEach(() => {
      vi.useFakeTimers();
    });

    it('should resolve with approved when approved', async () => {
      const { result } = renderHook(() => useAgentApproval());

      let approvalResult: boolean | undefined;

      act(() => {
        result.current
          .waitForApproval({
            toolName: 'delete_clip',
            description: 'Delete clip',
            riskLevel: 'high',
          })
          .then((approved) => {
            approvalResult = approved;
          });
      });

      const requestId = result.current.currentRequest!.id;

      act(() => {
        result.current.approve(requestId);
      });

      await waitFor(() => {
        expect(approvalResult).toBe(true);
      });
    });

    it('should resolve with false when rejected', async () => {
      const { result } = renderHook(() => useAgentApproval());

      let approvalResult: boolean | undefined;

      act(() => {
        result.current
          .waitForApproval({
            toolName: 'delete_clip',
            description: 'Delete clip',
            riskLevel: 'high',
          })
          .then((approved) => {
            approvalResult = approved;
          });
      });

      const requestId = result.current.currentRequest!.id;

      act(() => {
        result.current.reject(requestId);
      });

      await waitFor(() => {
        expect(approvalResult).toBe(false);
      });
    });
  });

  describe('history management', () => {
    it('should limit history size', () => {
      const { result } = renderHook(() => useAgentApproval());

      // Create and approve many requests
      for (let i = 0; i < 60; i++) {
        act(() => {
          result.current.requestApproval({
            toolName: `tool_${i}`,
            description: `Description ${i}`,
            riskLevel: 'low',
          });
        });

        act(() => {
          result.current.approve(result.current.currentRequest!.id);
        });
      }

      // Should limit to 50
      expect(result.current.history.length).toBeLessThanOrEqual(50);
    });

    it('should clear history', () => {
      const { result } = renderHook(() => useAgentApproval());

      act(() => {
        result.current.requestApproval({
          toolName: 'delete_clip',
          description: 'Delete clip',
          riskLevel: 'high',
        });
      });

      act(() => {
        result.current.approve(result.current.currentRequest!.id);
      });

      act(() => {
        result.current.clearHistory();
      });

      expect(result.current.history).toHaveLength(0);
    });
  });

  describe('timeout auto-reject', () => {
    it('should auto-reject after 30 seconds', async () => {
      const onReject = vi.fn();
      const { result } = renderHook(() => useAgentApproval());

      let approvalResult: boolean | undefined;

      act(() => {
        result.current
          .waitForApproval({
            toolName: 'delete_clip',
            description: 'Delete clip',
            riskLevel: 'high',
            onReject,
          })
          .then((approved) => {
            approvalResult = approved;
          });
      });

      expect(result.current.hasPendingRequest).toBe(true);

      // Advance past timeout and flush microtasks
      await act(async () => {
        vi.advanceTimersByTime(30_000);
      });

      // Should be auto-rejected
      expect(approvalResult).toBe(false);
      expect(result.current.hasPendingRequest).toBe(false);
      expect(onReject).toHaveBeenCalledWith(
        'Approval timed out — operation was not permitted',
      );
    });

    it('should add timed-out request to history as rejected', async () => {
      const { result } = renderHook(() => useAgentApproval());

      act(() => {
        result.current.waitForApproval({
          toolName: 'delete_clip',
          description: 'Delete clip',
          riskLevel: 'high',
        });
      });

      await act(async () => {
        vi.advanceTimersByTime(30_000);
      });

      expect(result.current.history).toHaveLength(1);
      expect(result.current.history[0].response).toBe('rejected');
      expect(result.current.history[0].reason).toBe(
        'Approval timed out — operation was not permitted',
      );
    });

    it('should not auto-reject if approved before timeout', async () => {
      const onReject = vi.fn();
      const { result } = renderHook(() => useAgentApproval());

      let approvalResult: boolean | undefined;

      act(() => {
        result.current
          .waitForApproval({
            toolName: 'delete_clip',
            description: 'Delete clip',
            riskLevel: 'high',
            onReject,
          })
          .then((approved) => {
            approvalResult = approved;
          });
      });

      const requestId = result.current.currentRequest!.id;

      // Approve before timeout
      await act(async () => {
        vi.advanceTimersByTime(10_000);
        result.current.approve(requestId);
      });

      expect(approvalResult).toBe(true);
      expect(onReject).not.toHaveBeenCalled();

      // Advancing past timeout should have no effect
      await act(async () => {
        vi.advanceTimersByTime(30_000);
      });

      expect(result.current.history).toHaveLength(1);
      expect(result.current.history[0].response).toBe('approved');
    });

    it('should not auto-reject if manually rejected before timeout', async () => {
      const onReject = vi.fn();
      const { result } = renderHook(() => useAgentApproval());

      act(() => {
        result.current.waitForApproval({
          toolName: 'delete_clip',
          description: 'Delete clip',
          riskLevel: 'high',
          onReject,
        });
      });

      const requestId = result.current.currentRequest!.id;

      await act(async () => {
        result.current.reject(requestId, 'User rejected');
      });

      expect(onReject).toHaveBeenCalledWith('User rejected');
      onReject.mockClear();

      // Advancing past timeout should have no additional effect
      await act(async () => {
        vi.advanceTimersByTime(30_000);
      });

      expect(onReject).not.toHaveBeenCalled();
      expect(result.current.history).toHaveLength(1);
    });
  });

  describe('clearPendingApprovals', () => {
    it('should reject all pending resolvers', async () => {
      const { result } = renderHook(() => useAgentApproval());

      let approvalResult: boolean | undefined;

      act(() => {
        result.current
          .waitForApproval({
            toolName: 'delete_clip',
            description: 'Delete clip',
            riskLevel: 'high',
          })
          .then((approved) => {
            approvalResult = approved;
          });
      });

      expect(result.current.hasPendingRequest).toBe(true);

      await act(async () => {
        clearPendingApprovals();
      });

      expect(approvalResult).toBe(false);
      expect(result.current.hasPendingRequest).toBe(false);
    });

    it('should clear timeout timers on cleanup', () => {
      const { result } = renderHook(() => useAgentApproval());
      const onReject = vi.fn();

      act(() => {
        result.current.waitForApproval({
          toolName: 'delete_clip',
          description: 'Delete clip',
          riskLevel: 'high',
          onReject,
        });
      });

      act(() => {
        clearPendingApprovals();
      });

      // Timer should be cleared — advancing time should not trigger onReject
      act(() => {
        vi.advanceTimersByTime(60_000);
      });

      expect(onReject).not.toHaveBeenCalled();
    });

    it('should allow new requests after cleanup', () => {
      const { result } = renderHook(() => useAgentApproval());

      act(() => {
        result.current.requestApproval({
          toolName: 'first',
          description: 'First',
          riskLevel: 'low',
        });
      });

      act(() => {
        clearPendingApprovals();
      });

      // Should be able to create a new request
      act(() => {
        result.current.requestApproval({
          toolName: 'second',
          description: 'Second',
          riskLevel: 'low',
        });
      });

      expect(result.current.hasPendingRequest).toBe(true);
      expect(result.current.currentRequest?.toolName).toBe('second');
    });
  });
});
