/**
 * useShortcutSettings Hook Tests
 *
 * TDD: Tests for shortcut customization hook.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useShortcutSettings } from './useShortcutSettings';
import { useSettingsStore } from '@/stores/settingsStore';
import { DEFAULT_SHORTCUTS } from '@/utils/shortcutActions';

// =============================================================================
// Mock settingsStore
// =============================================================================

vi.mock('@/stores/settingsStore', () => ({
  useSettingsStore: vi.fn(),
}));

const mockUseSettingsStore = useSettingsStore as unknown as ReturnType<typeof vi.fn>;

// =============================================================================
// Tests
// =============================================================================

describe('useShortcutSettings', () => {
  let mockUpdateSettings: ReturnType<typeof vi.fn>;
  let mockCustomShortcuts: Record<string, string>;

  beforeEach(() => {
    mockCustomShortcuts = {};
    mockUpdateSettings = vi.fn((section: string, values: { customShortcuts: Record<string, string> }) => {
      if (section === 'shortcuts') {
        mockCustomShortcuts = values.customShortcuts;
      }
    });

    mockUseSettingsStore.mockImplementation((selector) => {
      const state = {
        settings: {
          shortcuts: { customShortcuts: mockCustomShortcuts },
        },
        updateSettings: mockUpdateSettings,
      };
      return selector ? selector(state) : state;
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('getShortcut', () => {
    it('should return default shortcut when no custom set', () => {
      const { result } = renderHook(() => useShortcutSettings());

      const shortcut = result.current.getShortcut('playback.playPause');
      expect(shortcut).toBe(DEFAULT_SHORTCUTS['playback.playPause']);
    });

    it('should return custom shortcut when set', () => {
      mockCustomShortcuts['playback.playPause'] = 'P';

      const { result } = renderHook(() => useShortcutSettings());

      const shortcut = result.current.getShortcut('playback.playPause');
      expect(shortcut).toBe('P');
    });
  });

  describe('setShortcut', () => {
    it('should call store updateSettings with new shortcut', () => {
      const { result } = renderHook(() => useShortcutSettings());

      act(() => {
        result.current.setShortcut('playback.playPause', 'P');
      });

      expect(mockUpdateSettings).toHaveBeenCalledWith('shortcuts', {
        customShortcuts: { 'playback.playPause': 'P' },
      });
    });
  });

  describe('resetShortcut', () => {
    it('should call store updateSettings with shortcut removed', () => {
      mockCustomShortcuts['playback.playPause'] = 'P';
      const { result } = renderHook(() => useShortcutSettings());

      act(() => {
        result.current.resetShortcut('playback.playPause');
      });

      expect(mockUpdateSettings).toHaveBeenCalledWith('shortcuts', {
        customShortcuts: {},
      });
    });
  });

  describe('resetAllShortcuts', () => {
    it('should call store updateSettings with empty customShortcuts', () => {
      mockCustomShortcuts['playback.playPause'] = 'P';
      const { result } = renderHook(() => useShortcutSettings());

      act(() => {
        result.current.resetAllShortcuts();
      });

      expect(mockUpdateSettings).toHaveBeenCalledWith('shortcuts', {
        customShortcuts: {},
      });
    });
  });

  describe('isCustomized', () => {
    it('should return false for default shortcut', () => {
      const { result } = renderHook(() => useShortcutSettings());

      expect(result.current.isCustomized('playback.playPause')).toBe(false);
    });

    it('should return true for customized shortcut', () => {
      mockCustomShortcuts['playback.playPause'] = 'P';

      const { result } = renderHook(() => useShortcutSettings());

      expect(result.current.isCustomized('playback.playPause')).toBe(true);
    });
  });

  describe('hasConflict', () => {
    it('should return no conflict for unique shortcut', () => {
      const { result } = renderHook(() => useShortcutSettings());

      const conflict = result.current.hasConflict('Ctrl+Shift+Alt+X');
      expect(conflict).toBeNull();
    });

    it('should return conflicting action for used shortcut', () => {
      const { result } = renderHook(() => useShortcutSettings());

      // Space is the default for playback.playPause
      const conflict = result.current.hasConflict('Space');
      expect(conflict).toBe('playback.playPause');
    });

    it('should exclude current action from conflict check', () => {
      const { result } = renderHook(() => useShortcutSettings());

      // Checking Space for playback.playPause should not conflict with itself
      const conflict = result.current.hasConflict('Space', 'playback.playPause');
      expect(conflict).toBeNull();
    });
  });

  describe('getShortcutsByCategory', () => {
    it('should return shortcuts grouped by category', () => {
      const { result } = renderHook(() => useShortcutSettings());

      const byCategory = result.current.getShortcutsByCategory();

      expect(byCategory.playback).toBeDefined();
      expect(byCategory.timeline).toBeDefined();
      expect(byCategory.project).toBeDefined();
    });

    it('should include custom shortcuts', () => {
      mockCustomShortcuts['playback.playPause'] = 'P';

      const { result } = renderHook(() => useShortcutSettings());

      const byCategory = result.current.getShortcutsByCategory();
      const playPause = byCategory.playback.find((s) => s.actionId === 'playback.playPause');

      expect(playPause?.shortcut).toBe('P');
    });
  });

  describe('customShortcuts', () => {
    it('should expose customShortcuts from store', () => {
      mockCustomShortcuts['playback.playPause'] = 'P';
      mockCustomShortcuts['project.save'] = 'Ctrl+Shift+S';

      const { result } = renderHook(() => useShortcutSettings());

      expect(result.current.customShortcuts).toEqual({
        'playback.playPause': 'P',
        'project.save': 'Ctrl+Shift+S',
      });
    });
  });
});
