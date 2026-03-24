/**
 * UndoHistoryPanel Component Tests
 *
 * Integration tests with real useUndoHistory hook and real Zustand stores.
 * Only external boundaries are mocked: Tauri IPC and stateRefreshHelper facade.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { UndoHistoryPanel } from './UndoHistoryPanel';
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

describe('UndoHistoryPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useProjectStore.setState({ isLoaded: true, stateVersion: 0 });
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_undo_history') return Promise.resolve(MOCK_HISTORY);
      if (cmd === 'jump_to_history_state')
        return Promise.resolve({ success: true, canUndo: true, canRedo: true });
      return Promise.resolve(null);
    });
  });

  // ===========================================================================
  // Display
  // ===========================================================================

  describe('display', () => {
    it('should show all undoable operations', async () => {
      render(<UndoHistoryPanel />);

      await waitFor(() => {
        expect(screen.getByText('Insert Clip')).toBeInTheDocument();
        expect(screen.getByText('Split Clip')).toBeInTheDocument();
        expect(screen.getByText('Remove Clip')).toBeInTheDocument();
      });
    });

    it('should show redo entries as dimmed items', async () => {
      render(<UndoHistoryPanel />);

      await waitFor(() => {
        expect(screen.getByText('Move Clip')).toBeInTheDocument();
      });

      const moveClipEl = screen.getByText('Move Clip').closest('[role="option"]');
      expect(moveClipEl?.className).toContain('opacity-40');
    });

    it('should highlight current state entry', async () => {
      render(<UndoHistoryPanel />);

      await waitFor(() => {
        expect(screen.getByText('Remove Clip')).toBeInTheDocument();
      });

      // Current state is index 2 = "Remove Clip"
      const currentEl = screen.getByText('Remove Clip').closest('[role="option"]');
      expect(currentEl?.getAttribute('aria-selected')).toBe('true');
      expect(currentEl?.className).toContain('bg-primary-600/30');
    });

    it('should always show Initial State at the top', async () => {
      render(<UndoHistoryPanel />);

      await waitFor(() => {
        expect(screen.getByText('Initial State')).toBeInTheDocument();
      });
    });

    it('should show operation count in header', async () => {
      render(<UndoHistoryPanel />);

      await waitFor(() => {
        expect(screen.getByText('4 operations')).toBeInTheDocument();
      });
    });

    it('should show header title', async () => {
      render(<UndoHistoryPanel />);

      await waitFor(() => {
        expect(screen.getByText('Undo History')).toBeInTheDocument();
      });
    });
  });

  // ===========================================================================
  // Empty State
  // ===========================================================================

  describe('empty state', () => {
    it('should show empty message when no operations exist', async () => {
      mockInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'get_undo_history')
          return Promise.resolve({ undoEntries: [], redoEntries: [], currentIndex: -1 });
        return Promise.resolve(null);
      });

      render(<UndoHistoryPanel />);

      await waitFor(() => {
        expect(screen.getByText('No operations yet')).toBeInTheDocument();
        expect(screen.getByText('Edits will appear here')).toBeInTheDocument();
      });
    });

    it('should show loading state when history fetch is pending', async () => {
      // Make invoke hang so loading state persists
      mockInvoke.mockImplementation(() => new Promise(() => {}));

      render(<UndoHistoryPanel />);

      await waitFor(() => {
        expect(screen.getByText('Loading history...')).toBeInTheDocument();
      });
    });

    it('should highlight Initial State when currentIndex is -1', async () => {
      mockInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'get_undo_history')
          return Promise.resolve({ undoEntries: [], redoEntries: [], currentIndex: -1 });
        return Promise.resolve(null);
      });

      render(<UndoHistoryPanel />);

      await waitFor(() => {
        expect(screen.getByText('Initial State')).toBeInTheDocument();
      });

      const initialEl = screen.getByText('Initial State').closest('[role="option"]');
      expect(initialEl?.getAttribute('aria-selected')).toBe('true');
    });
  });

  // ===========================================================================
  // Navigation (Jump to State)
  // ===========================================================================

  describe('navigation', () => {
    it('should invoke jump when clicking an undo entry', async () => {
      render(<UndoHistoryPanel />);

      await waitFor(() => {
        expect(screen.getByText('Insert Clip')).toBeInTheDocument();
      });

      const insertClipEl = screen.getByText('Insert Clip').closest('[role="option"]');
      fireEvent.click(insertClipEl!);

      await waitFor(() => {
        expect(mockInvoke).toHaveBeenCalledWith('jump_to_history_state', { targetIndex: 0 });
      });
    });

    it('should invoke jump when clicking a redo entry', async () => {
      render(<UndoHistoryPanel />);

      await waitFor(() => {
        expect(screen.getByText('Move Clip')).toBeInTheDocument();
      });

      const moveClipEl = screen.getByText('Move Clip').closest('[role="option"]');
      fireEvent.click(moveClipEl!);

      await waitFor(() => {
        expect(mockInvoke).toHaveBeenCalledWith('jump_to_history_state', { targetIndex: 3 });
      });
    });

    it('should invoke jump to initial state when clicking Initial State', async () => {
      render(<UndoHistoryPanel />);

      await waitFor(() => {
        expect(screen.getByText('Insert Clip')).toBeInTheDocument();
      });

      const initialEl = screen.getByText('Initial State').closest('[role="option"]');
      fireEvent.click(initialEl!);

      await waitFor(() => {
        expect(mockInvoke).toHaveBeenCalledWith('jump_to_history_state', { targetIndex: -1 });
      });
    });

    it('should support keyboard navigation with Enter key', async () => {
      render(<UndoHistoryPanel />);

      await waitFor(() => {
        expect(screen.getByText('Split Clip')).toBeInTheDocument();
      });

      const splitClipEl = screen.getByText('Split Clip').closest('[role="option"]');
      fireEvent.keyDown(splitClipEl!, { key: 'Enter' });

      await waitFor(() => {
        expect(mockInvoke).toHaveBeenCalledWith('jump_to_history_state', { targetIndex: 1 });
      });
    });

    it('should support keyboard navigation with Space key', async () => {
      render(<UndoHistoryPanel />);

      await waitFor(() => {
        expect(screen.getByText('Insert Clip')).toBeInTheDocument();
      });

      const initialEl = screen.getByText('Initial State').closest('[role="option"]');
      fireEvent.keyDown(initialEl!, { key: ' ' });

      await waitFor(() => {
        expect(mockInvoke).toHaveBeenCalledWith('jump_to_history_state', { targetIndex: -1 });
      });
    });
  });

  // ===========================================================================
  // Read-Only Mode
  // ===========================================================================

  describe('read-only mode', () => {
    it('should not invoke jump when clicking in read-only mode', async () => {
      render(<UndoHistoryPanel readOnly />);

      await waitFor(() => {
        expect(screen.getByText('Insert Clip')).toBeInTheDocument();
      });

      mockInvoke.mockClear();

      const insertClipEl = screen.getByText('Insert Clip').closest('[role="option"]');
      fireEvent.click(insertClipEl!);

      // Allow time for any async effects
      await new Promise((r) => setTimeout(r, 50));

      expect(mockInvoke).not.toHaveBeenCalledWith('jump_to_history_state', expect.anything());
    });

    it('should not navigate on Enter key in read-only mode', async () => {
      render(<UndoHistoryPanel readOnly />);

      await waitFor(() => {
        expect(screen.getByText('Split Clip')).toBeInTheDocument();
      });

      mockInvoke.mockClear();

      const splitClipEl = screen.getByText('Split Clip').closest('[role="option"]');
      fireEvent.keyDown(splitClipEl!, { key: 'Enter' });

      await new Promise((r) => setTimeout(r, 50));

      expect(mockInvoke).not.toHaveBeenCalledWith('jump_to_history_state', expect.anything());
    });
  });

  // ===========================================================================
  // Accessibility
  // ===========================================================================

  describe('accessibility', () => {
    it('should have a listbox role on the history container', async () => {
      render(<UndoHistoryPanel />);

      await waitFor(() => {
        expect(screen.getByRole('listbox', { name: 'Undo history' })).toBeInTheDocument();
      });
    });

    it('should mark each entry as an option with aria-selected', async () => {
      render(<UndoHistoryPanel />);

      await waitFor(() => {
        expect(screen.getByText('Insert Clip')).toBeInTheDocument();
      });

      const options = screen.getAllByRole('option');
      // Initial State + 3 undo + 1 redo = 5
      expect(options).toHaveLength(5);

      // Only current entry should be selected
      const selectedOptions = options.filter(
        (o) => o.getAttribute('aria-selected') === 'true',
      );
      expect(selectedOptions).toHaveLength(1);
    });
  });
});
