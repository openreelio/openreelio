/**
 * useCommandPalette Hook Tests
 *
 * Integration tests using real Zustand stores (no internal mocking).
 * Only external boundaries (Tauri IPC) are mocked via global setup.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useCommandPalette } from './useCommandPalette';
import { useCommandPaletteStore } from '@/stores/commandPaletteStore';
import { useProjectStore } from '@/stores/projectStore';
import { usePlaybackStore } from '@/stores/playbackStore';
import { TOOL_CONFIGS } from '@/stores/editorToolStore';

// Mock state refresh helper (thin facade around Tauri IPC boundary)
// Prevents unhandled rejections when executeAction triggers store methods
// that call refreshProjectState internally.
vi.mock('@/utils/stateRefreshHelper', () => ({
  refreshProjectState: vi.fn().mockResolvedValue({
    assets: new Map(),
    sequences: new Map(),
    meta: null,
  }),
  applyProjectState: vi.fn(),
}));

describe('useCommandPalette', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Set real stores to the state the hook needs
    useProjectStore.setState({ isLoaded: true });
    usePlaybackStore.setState({ duration: 120 });
    act(() => {
      useCommandPaletteStore.getState().close();
      useCommandPaletteStore.setState({ recentActionIds: [] });
    });
  });

  // ===========================================================================
  // Action Registry
  // ===========================================================================

  describe('action registry', () => {
    it('should register 20+ actions from stores and tools', () => {
      const { result } = renderHook(() => useCommandPalette());

      // transport (5) + edit (4) + view (2) + tools (N) + settings (7) = 18 + N
      expect(result.current.filteredActions.length).toBeGreaterThanOrEqual(20);
    });

    it('should include transport actions', () => {
      const { result } = renderHook(() => useCommandPalette());

      const ids = result.current.filteredActions.map((a) => a.id);
      expect(ids).toContain('transport.play-pause');
      expect(ids).toContain('transport.go-to-start');
      expect(ids).toContain('transport.go-to-end');
    });

    it('should include edit actions', () => {
      const { result } = renderHook(() => useCommandPalette());

      const ids = result.current.filteredActions.map((a) => a.id);
      expect(ids).toContain('edit.undo');
      expect(ids).toContain('edit.redo');
      expect(ids).toContain('edit.save');
    });

    it('should include tool actions from TOOL_CONFIGS', () => {
      const { result } = renderHook(() => useCommandPalette());

      const toolActions = result.current.filteredActions.filter((a) => a.id.startsWith('tool.'));
      expect(toolActions.length).toBe(Object.keys(TOOL_CONFIGS).length);
    });

    it('should include settings actions', () => {
      const { result } = renderHook(() => useCommandPalette());

      const settingsActions = result.current.filteredActions.filter((a) => a.id.startsWith('settings.'));
      expect(settingsActions.length).toBeGreaterThanOrEqual(5);
    });

    it('should include callback-based actions when provided', () => {
      const onExport = vi.fn();
      const onMatchFrame = vi.fn();
      const { result } = renderHook(() =>
        useCommandPalette({ onExport, onMatchFrame }),
      );

      const ids = result.current.filteredActions.map((a) => a.id);
      expect(ids).toContain('view.export');
      expect(ids).toContain('source.match-frame');
    });

    it('should not include callback-based actions when callback not provided', () => {
      const { result } = renderHook(() => useCommandPalette());

      const ids = result.current.filteredActions.map((a) => a.id);
      expect(ids).not.toContain('view.export');
      expect(ids).not.toContain('edit.split');
    });
  });

  // ===========================================================================
  // Search Filtering
  // ===========================================================================

  describe('search filtering', () => {
    it('should return all actions when search query is empty', () => {
      const { result } = renderHook(() => useCommandPalette());
      const total = result.current.filteredActions.length;

      act(() => useCommandPaletteStore.getState().setSearchQuery(''));

      expect(result.current.filteredActions.length).toBe(total);
    });

    it('should filter actions by label substring match', () => {
      const { result } = renderHook(() => useCommandPalette());

      act(() => useCommandPaletteStore.getState().setSearchQuery('undo'));

      const labels = result.current.filteredActions.map((a) => a.label);
      expect(labels).toContain('Undo');
      expect(labels.length).toBeGreaterThanOrEqual(1);
    });

    it('should filter case-insensitively', () => {
      const { result } = renderHook(() => useCommandPalette());

      act(() => useCommandPaletteStore.getState().setSearchQuery('UNDO'));

      expect(result.current.filteredActions.some((a) => a.label === 'Undo')).toBe(true);
    });

    it('should filter by category name', () => {
      const { result } = renderHook(() => useCommandPalette());

      act(() => useCommandPaletteStore.getState().setSearchQuery('transport'));

      const categories = result.current.filteredActions.map((a) => a.category);
      expect(categories.every((c) => c === 'Transport')).toBe(true);
    });

    it('should support multi-word query matching', () => {
      const { result } = renderHook(() => useCommandPalette());

      act(() => useCommandPaletteStore.getState().setSearchQuery('zoom in'));

      expect(result.current.filteredActions.some((a) => a.label === 'Zoom In Timeline')).toBe(true);
    });

    it('should return empty array when no match found', () => {
      const { result } = renderHook(() => useCommandPalette());

      act(() => useCommandPaletteStore.getState().setSearchQuery('xyznonexistent'));

      expect(result.current.filteredActions).toHaveLength(0);
    });
  });

  // ===========================================================================
  // Action Execution
  // ===========================================================================

  describe('action execution', () => {
    it('should close palette after executing action', () => {
      act(() => useCommandPaletteStore.getState().open());

      const { result } = renderHook(() => useCommandPalette());

      act(() => result.current.executeAction('edit.undo'));

      expect(useCommandPaletteStore.getState().isOpen).toBe(false);
    });

    it('should record action in recent list', () => {
      const { result } = renderHook(() => useCommandPalette());

      act(() => result.current.executeAction('edit.undo'));

      expect(useCommandPaletteStore.getState().recentActionIds).toContain('edit.undo');
    });

    it('should not throw when executing non-existent action', () => {
      const { result } = renderHook(() => useCommandPalette());

      expect(() => {
        act(() => result.current.executeAction('nonexistent'));
      }).not.toThrow();
    });

    it('should execute callback-based action when invoked', async () => {
      const onExport = vi.fn();
      const { result } = renderHook(() => useCommandPalette({ onExport }));

      act(() => {
        result.current.executeAction('view.export');
      });

      // requestAnimationFrame defers execution; poll until it fires
      await waitFor(() => {
        expect(onExport).toHaveBeenCalledTimes(1);
      });
    });
  });

  // ===========================================================================
  // Recent Actions
  // ===========================================================================

  describe('recent actions', () => {
    it('should return empty recent actions when no history', () => {
      const { result } = renderHook(() => useCommandPalette());

      expect(result.current.recentActions).toHaveLength(0);
    });

    it('should return resolved recent actions from IDs', () => {
      act(() => {
        useCommandPaletteStore.getState().recordRecentAction('edit.undo');
      });

      const { result } = renderHook(() => useCommandPalette());

      expect(result.current.recentActions.length).toBe(1);
      expect(result.current.recentActions[0].label).toBe('Undo');
    });

    it('should return empty when search query is active', () => {
      act(() => {
        useCommandPaletteStore.getState().recordRecentAction('edit.undo');
        useCommandPaletteStore.getState().setSearchQuery('something');
      });

      const { result } = renderHook(() => useCommandPalette());

      expect(result.current.recentActions).toHaveLength(0);
    });
  });
});
