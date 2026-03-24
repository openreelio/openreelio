/**
 * useUndoHistory Hook Tests
 *
 * Integration tests using real Zustand stores.
 * Only external boundaries are mocked: Tauri IPC and stateRefreshHelper facade.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useUndoHistory, getCommandLabel } from './useUndoHistory';
import { useProjectStore } from '@/stores';
import type { UndoHistoryInfo } from '@/types';

// Mock Tauri IPC (external boundary)
const mockInvoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

// Mock state refresh helper (thin facade around Tauri IPC boundary)
vi.mock('@/utils/stateRefreshHelper', () => ({
  refreshProjectState: vi.fn().mockResolvedValue({
    assets: new Map(),
    sequences: new Map(),
    meta: null,
  }),
  applyProjectState: vi.fn(),
}));

const MOCK_HISTORY: UndoHistoryInfo = {
  undoEntries: [
    { opId: 'op-1', commandType: 'InsertClip', timestamp: '2026-03-24T10:00:00Z', index: 0 },
    { opId: 'op-2', commandType: 'SplitClip', timestamp: '2026-03-24T10:01:00Z', index: 1 },
    { opId: 'op-3', commandType: 'RemoveClip', timestamp: '2026-03-24T10:02:00Z', index: 2 },
  ],
  redoEntries: [
    { opId: 'op-4', commandType: 'MoveClip', timestamp: '2026-03-24T10:03:00Z', index: 3 },
  ],
  currentIndex: 2,
};

describe('useUndoHistory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Use real store — set the state the hook needs
    useProjectStore.setState({ isLoaded: true, stateVersion: 0 });
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_undo_history') return Promise.resolve(MOCK_HISTORY);
      if (cmd === 'jump_to_history_state')
        return Promise.resolve({ success: true, canUndo: true, canRedo: true });
      return Promise.resolve(null);
    });
  });

  // ===========================================================================
  // History Fetching
  // ===========================================================================

  describe('history fetching', () => {
    it('should fetch undo history on mount when project is loaded', async () => {
      renderHook(() => useUndoHistory());

      await waitFor(() => {
        expect(mockInvoke).toHaveBeenCalledWith('get_undo_history');
      });
    });

    it('should not fetch history when project is not loaded', async () => {
      useProjectStore.setState({ isLoaded: false });
      renderHook(() => useUndoHistory());

      // Give time for any potential fetch
      await act(async () => {
        await new Promise((r) => setTimeout(r, 50));
      });

      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it('should populate undo and redo entries from backend response', async () => {
      const { result } = renderHook(() => useUndoHistory());

      await waitFor(() => {
        expect(result.current.undoEntries).toHaveLength(3);
        expect(result.current.redoEntries).toHaveLength(1);
        expect(result.current.currentIndex).toBe(2);
      });
    });

    it('should refresh history when stateVersion changes', async () => {
      renderHook(() => useUndoHistory());

      await waitFor(() => {
        expect(mockInvoke).toHaveBeenCalledTimes(1);
      });

      // Simulate stateVersion change (as happens after any command execution)
      act(() => {
        useProjectStore.setState({ stateVersion: 1 });
      });

      await waitFor(() => {
        expect(mockInvoke).toHaveBeenCalledTimes(2);
      });
    });

    it('should handle empty history gracefully', async () => {
      mockInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'get_undo_history')
          return Promise.resolve({ undoEntries: [], redoEntries: [], currentIndex: -1 });
        return Promise.resolve(null);
      });

      const { result } = renderHook(() => useUndoHistory());

      await waitFor(() => {
        expect(result.current.undoEntries).toHaveLength(0);
        expect(result.current.redoEntries).toHaveLength(0);
        expect(result.current.currentIndex).toBe(-1);
      });
    });
  });

  // ===========================================================================
  // Jump To State
  // ===========================================================================

  describe('jumpToState', () => {
    it('should invoke jump_to_history_state with target index', async () => {
      const { result } = renderHook(() => useUndoHistory());

      await waitFor(() => {
        expect(result.current.currentIndex).toBe(2);
      });

      await act(async () => {
        await result.current.jumpToState(0);
      });

      expect(mockInvoke).toHaveBeenCalledWith('jump_to_history_state', { targetIndex: 0 });
    });

    it('should refresh history after a successful jump', async () => {
      let currentHistory = MOCK_HISTORY;

      mockInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'get_undo_history') {
          return Promise.resolve(currentHistory);
        }
        if (cmd === 'jump_to_history_state') {
          currentHistory = {
            undoEntries: [
              {
                opId: 'op-1',
                commandType: 'InsertClip',
                timestamp: '2026-03-24T10:00:00Z',
                index: 0,
              },
            ],
            redoEntries: [
              {
                opId: 'op-2',
                commandType: 'SplitClip',
                timestamp: '2026-03-24T10:01:00Z',
                index: 1,
              },
              {
                opId: 'op-3',
                commandType: 'RemoveClip',
                timestamp: '2026-03-24T10:02:00Z',
                index: 2,
              },
              {
                opId: 'op-4',
                commandType: 'MoveClip',
                timestamp: '2026-03-24T10:03:00Z',
                index: 3,
              },
            ],
            currentIndex: 0,
          };
          return Promise.resolve({ success: true, canUndo: true, canRedo: true });
        }
        return Promise.resolve(null);
      });

      const { result } = renderHook(() => useUndoHistory());

      await waitFor(() => {
        expect(result.current.currentIndex).toBe(2);
      });

      await act(async () => {
        await result.current.jumpToState(0);
      });

      await waitFor(() => {
        expect(result.current.currentIndex).toBe(0);
      });
    });

    it('should skip jump when target equals current index', async () => {
      const { result } = renderHook(() => useUndoHistory());

      await waitFor(() => {
        expect(result.current.currentIndex).toBe(2);
      });

      await act(async () => {
        await result.current.jumpToState(2);
      });

      // Should not call jump IPC (only get_undo_history on mount)
      expect(mockInvoke).not.toHaveBeenCalledWith('jump_to_history_state', expect.anything());
    });
  });
});

// ===========================================================================
// Command Labels (pure function — unit tests)
// ===========================================================================

describe('getCommandLabel', () => {
  it('should return human-readable label for known command types', () => {
    expect(getCommandLabel('InsertClip')).toBe('Insert Clip');
    expect(getCommandLabel('SplitClip')).toBe('Split Clip');
    expect(getCommandLabel('RippleDelete')).toBe('Ripple Delete');
    expect(getCommandLabel('CreateAdjustmentLayer')).toBe('Adjustment Layer');
    expect(getCommandLabel('SetMasterVolume')).toBe('Master Volume');
  });

  it('should convert PascalCase to spaced words for unknown command types', () => {
    expect(getCommandLabel('SomeUnknownCommand')).toBe('Some Unknown Command');
  });

  it('should handle single-word command types', () => {
    expect(getCommandLabel('Lift')).toBe('Lift Edit');
  });
});
