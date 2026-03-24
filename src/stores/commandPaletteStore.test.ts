/**
 * Command Palette Store Tests
 *
 * BDD-style tests for the command palette state management.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useCommandPaletteStore } from './commandPaletteStore';

describe('commandPaletteStore', () => {
  beforeEach(() => {
    act(() => {
      useCommandPaletteStore.getState().close();
      // Clear recent actions by resetting to empty
      useCommandPaletteStore.setState({ recentActionIds: [] });
    });
  });

  // ===========================================================================
  // Open / Close
  // ===========================================================================

  describe('open/close', () => {
    it('should start with palette closed', () => {
      const { result } = renderHook(() => useCommandPaletteStore());
      expect(result.current.isOpen).toBe(false);
      expect(result.current.searchQuery).toBe('');
      expect(result.current.selectedIndex).toBe(0);
    });

    it('should open palette and reset search state', () => {
      const { result } = renderHook(() => useCommandPaletteStore());

      act(() => result.current.open());

      expect(result.current.isOpen).toBe(true);
      expect(result.current.searchQuery).toBe('');
      expect(result.current.selectedIndex).toBe(0);
    });

    it('should close palette and reset all state', () => {
      const { result } = renderHook(() => useCommandPaletteStore());

      act(() => {
        result.current.open();
        result.current.setSearchQuery('test');
        result.current.setSelectedIndex(5);
      });

      act(() => result.current.close());

      expect(result.current.isOpen).toBe(false);
      expect(result.current.searchQuery).toBe('');
      expect(result.current.selectedIndex).toBe(0);
    });

    it('should toggle between open and closed', () => {
      const { result } = renderHook(() => useCommandPaletteStore());

      act(() => result.current.toggle());
      expect(result.current.isOpen).toBe(true);

      act(() => result.current.toggle());
      expect(result.current.isOpen).toBe(false);
    });
  });

  // ===========================================================================
  // Search Query
  // ===========================================================================

  describe('search query', () => {
    it('should update search query and reset selected index', () => {
      const { result } = renderHook(() => useCommandPaletteStore());

      act(() => {
        result.current.open();
        result.current.setSelectedIndex(3);
        result.current.setSearchQuery('undo');
      });

      expect(result.current.searchQuery).toBe('undo');
      expect(result.current.selectedIndex).toBe(0);
    });
  });

  // ===========================================================================
  // Selected Index
  // ===========================================================================

  describe('selected index', () => {
    it('should set selected index for keyboard navigation', () => {
      const { result } = renderHook(() => useCommandPaletteStore());

      act(() => result.current.setSelectedIndex(7));

      expect(result.current.selectedIndex).toBe(7);
    });
  });

  // ===========================================================================
  // Recent Actions
  // ===========================================================================

  describe('recent actions', () => {
    it('should record an action as recently used', () => {
      const { result } = renderHook(() => useCommandPaletteStore());

      act(() => result.current.recordRecentAction('edit.undo'));

      expect(result.current.recentActionIds).toEqual(['edit.undo']);
    });

    it('should move re-executed action to front of list', () => {
      const { result } = renderHook(() => useCommandPaletteStore());

      act(() => {
        result.current.recordRecentAction('edit.undo');
        result.current.recordRecentAction('edit.redo');
        result.current.recordRecentAction('edit.undo');
      });

      expect(result.current.recentActionIds).toEqual(['edit.undo', 'edit.redo']);
    });

    it('should cap recent actions at 10 entries', () => {
      const { result } = renderHook(() => useCommandPaletteStore());

      act(() => {
        for (let i = 0; i < 15; i++) {
          result.current.recordRecentAction(`action-${i}`);
        }
      });

      expect(result.current.recentActionIds).toHaveLength(10);
      expect(result.current.recentActionIds[0]).toBe('action-14');
    });
  });
});
