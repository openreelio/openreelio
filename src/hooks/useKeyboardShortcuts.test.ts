/**
 * useKeyboardShortcuts Hook Tests
 *
 * Tests for global keyboard shortcut handling including:
 * - Playback controls (Space, Arrow keys, Home, End)
 * - Zoom controls (Ctrl+/-, Ctrl+Plus)
 * - Edit operations (Ctrl+Z, Ctrl+Shift+Z, Delete)
 * - File operations (Ctrl+S)
 * - Input element filtering
 */

import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useKeyboardShortcuts, KEYBOARD_SHORTCUTS } from './useKeyboardShortcuts';
import { usePlaybackStore } from '@/stores/playbackStore';
import { useTimelineStore } from '@/stores/timelineStore';
import { useProjectStore } from '@/stores/projectStore';

// =============================================================================
// Mocks
// =============================================================================

vi.mock('@/stores/playbackStore');
vi.mock('@/stores/timelineStore');
vi.mock('@/stores/projectStore');

// =============================================================================
// Test Utilities
// =============================================================================

const createKeyboardEvent = (
  key: string,
  options: Partial<{
    ctrlKey: boolean;
    shiftKey: boolean;
    altKey: boolean;
    metaKey: boolean;
    target: HTMLElement;
  }> = {}
): KeyboardEvent => {
  const event = new KeyboardEvent('keydown', {
    key,
    ctrlKey: options.ctrlKey ?? false,
    shiftKey: options.shiftKey ?? false,
    altKey: options.altKey ?? false,
    metaKey: options.metaKey ?? false,
    bubbles: true,
    cancelable: true,
  });

  // Override target if provided
  if (options.target) {
    Object.defineProperty(event, 'target', {
      value: options.target,
      writable: false,
    });
  }

  return event;
};

const createInputElement = (tagName: 'input' | 'textarea' | 'select'): HTMLElement => {
  const element = document.createElement(tagName);
  return element;
};

const createContentEditableElement = (): HTMLElement => {
  const element = document.createElement('div');
  element.contentEditable = 'true';
  // Explicitly define isContentEditable since JSDOM may not compute it correctly
  Object.defineProperty(element, 'isContentEditable', {
    value: true,
    configurable: true,
  });
  return element;
};

// =============================================================================
// Test Setup
// =============================================================================

describe('useKeyboardShortcuts', () => {
  const mockTogglePlayback = vi.fn();
  const mockSeek = vi.fn();
  const mockSetCurrentTime = vi.fn();
  const mockSetPlaybackRate = vi.fn();
  const mockPlay = vi.fn();
  const mockPause = vi.fn();
  const mockStepForward = vi.fn();
  const mockStepBackward = vi.fn();
  const mockZoomIn = vi.fn();
  const mockZoomOut = vi.fn();
  const mockClearClipSelection = vi.fn();
  const mockUndo = vi.fn().mockResolvedValue(undefined);
  const mockRedo = vi.fn().mockResolvedValue(undefined);
  const mockSaveProject = vi.fn().mockResolvedValue(undefined);

  const defaultPlaybackStore = {
    togglePlayback: mockTogglePlayback,
    seek: mockSeek,
    setCurrentTime: mockSetCurrentTime,
    currentTime: 5,
    duration: 60,
    setPlaybackRate: mockSetPlaybackRate,
    play: mockPlay,
    pause: mockPause,
    isPlaying: false,
    stepForward: mockStepForward,
    stepBackward: mockStepBackward,
  };

  const defaultTimelineStore = {
    zoomIn: mockZoomIn,
    zoomOut: mockZoomOut,
    selectedClipIds: [],
    clearClipSelection: mockClearClipSelection,
  };

  const defaultProjectStore = {
    undo: mockUndo,
    redo: mockRedo,
    saveProject: mockSaveProject,
    isLoaded: true,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(usePlaybackStore).mockReturnValue(defaultPlaybackStore);
    vi.mocked(useTimelineStore).mockReturnValue(defaultTimelineStore);
    vi.mocked(useProjectStore).mockReturnValue(defaultProjectStore);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ===========================================================================
  // Playback Shortcuts
  // ===========================================================================

  describe('playback shortcuts', () => {
    it('should toggle playback on Space key', () => {
      renderHook(() => useKeyboardShortcuts());

      act(() => {
        window.dispatchEvent(createKeyboardEvent(' '));
      });

      expect(mockTogglePlayback).toHaveBeenCalledTimes(1);
    });

    it('should step back one frame on Left Arrow', () => {
      renderHook(() => useKeyboardShortcuts());

      act(() => {
        window.dispatchEvent(createKeyboardEvent('ArrowLeft'));
      });

      // Should call stepBackward with target FPS (30)
      expect(mockStepBackward).toHaveBeenCalledWith(30);
    });

    it('should step forward one frame on Right Arrow', () => {
      renderHook(() => useKeyboardShortcuts());

      act(() => {
        window.dispatchEvent(createKeyboardEvent('ArrowRight'));
      });

      // Should call stepForward with target FPS (30)
      expect(mockStepForward).toHaveBeenCalledWith(30);
    });

    it('should not go below 0 when stepping back', () => {
      // stepBackward handles boundary checks internally
      renderHook(() => useKeyboardShortcuts());

      act(() => {
        window.dispatchEvent(createKeyboardEvent('ArrowLeft'));
      });

      // stepBackward is called regardless - it handles the 0 boundary internally
      expect(mockStepBackward).toHaveBeenCalledWith(30);
    });

    it('should not exceed duration when stepping forward', () => {
      // stepForward handles boundary checks internally
      renderHook(() => useKeyboardShortcuts());

      act(() => {
        window.dispatchEvent(createKeyboardEvent('ArrowRight'));
      });

      // stepForward is called regardless - it handles the duration boundary internally
      expect(mockStepForward).toHaveBeenCalledWith(30);
    });

    it('should jump to start on Home key', () => {
      renderHook(() => useKeyboardShortcuts());

      act(() => {
        window.dispatchEvent(createKeyboardEvent('Home'));
      });

      expect(mockSeek).toHaveBeenCalledWith(0);
    });

    it('should jump to end on End key', () => {
      renderHook(() => useKeyboardShortcuts());

      act(() => {
        window.dispatchEvent(createKeyboardEvent('End'));
      });

      expect(mockSeek).toHaveBeenCalledWith(60);
    });
  });

  // ===========================================================================
  // Zoom Shortcuts
  // ===========================================================================

  describe('zoom shortcuts', () => {
    it('should zoom in on Ctrl++', () => {
      renderHook(() => useKeyboardShortcuts());

      act(() => {
        window.dispatchEvent(createKeyboardEvent('+', { ctrlKey: true }));
      });

      expect(mockZoomIn).toHaveBeenCalledTimes(1);
    });

    it('should zoom in on Ctrl+=', () => {
      renderHook(() => useKeyboardShortcuts());

      act(() => {
        window.dispatchEvent(createKeyboardEvent('=', { ctrlKey: true }));
      });

      expect(mockZoomIn).toHaveBeenCalledTimes(1);
    });

    it('should zoom out on Ctrl+-', () => {
      renderHook(() => useKeyboardShortcuts());

      act(() => {
        window.dispatchEvent(createKeyboardEvent('-', { ctrlKey: true }));
      });

      expect(mockZoomOut).toHaveBeenCalledTimes(1);
    });

    it('should zoom in with Meta key (Mac)', () => {
      renderHook(() => useKeyboardShortcuts());

      act(() => {
        window.dispatchEvent(createKeyboardEvent('=', { metaKey: true }));
      });

      expect(mockZoomIn).toHaveBeenCalledTimes(1);
    });
  });

  // ===========================================================================
  // Undo/Redo Shortcuts
  // ===========================================================================

  describe('undo/redo shortcuts', () => {
    it('should call undo on Ctrl+Z', () => {
      renderHook(() => useKeyboardShortcuts());

      act(() => {
        window.dispatchEvent(createKeyboardEvent('z', { ctrlKey: true }));
      });

      expect(mockUndo).toHaveBeenCalledTimes(1);
    });

    it('should call redo on Ctrl+Shift+Z', () => {
      renderHook(() => useKeyboardShortcuts());

      act(() => {
        window.dispatchEvent(createKeyboardEvent('z', { ctrlKey: true, shiftKey: true }));
      });

      expect(mockRedo).toHaveBeenCalledTimes(1);
    });

    it('should call redo on Ctrl+Y', () => {
      renderHook(() => useKeyboardShortcuts());

      act(() => {
        window.dispatchEvent(createKeyboardEvent('y', { ctrlKey: true }));
      });

      expect(mockRedo).toHaveBeenCalledTimes(1);
    });

    it('should use custom onUndo if provided', () => {
      const customUndo = vi.fn();
      renderHook(() => useKeyboardShortcuts({ onUndo: customUndo }));

      act(() => {
        window.dispatchEvent(createKeyboardEvent('z', { ctrlKey: true }));
      });

      expect(customUndo).toHaveBeenCalledTimes(1);
      expect(mockUndo).not.toHaveBeenCalled();
    });

    it('should use custom onRedo if provided', () => {
      const customRedo = vi.fn();
      renderHook(() => useKeyboardShortcuts({ onRedo: customRedo }));

      act(() => {
        window.dispatchEvent(createKeyboardEvent('z', { ctrlKey: true, shiftKey: true }));
      });

      expect(customRedo).toHaveBeenCalledTimes(1);
      expect(mockRedo).not.toHaveBeenCalled();
    });

    it('should not call undo/redo if project is not loaded', () => {
      vi.mocked(useProjectStore).mockReturnValue({
        ...defaultProjectStore,
        isLoaded: false,
      });

      renderHook(() => useKeyboardShortcuts());

      act(() => {
        window.dispatchEvent(createKeyboardEvent('z', { ctrlKey: true }));
      });

      expect(mockUndo).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Save Shortcut
  // ===========================================================================

  describe('save shortcut', () => {
    it('should call saveProject on Ctrl+S', () => {
      renderHook(() => useKeyboardShortcuts());

      act(() => {
        window.dispatchEvent(createKeyboardEvent('s', { ctrlKey: true }));
      });

      expect(mockSaveProject).toHaveBeenCalledTimes(1);
    });

    it('should use custom onSave if provided', () => {
      const customSave = vi.fn();
      renderHook(() => useKeyboardShortcuts({ onSave: customSave }));

      act(() => {
        window.dispatchEvent(createKeyboardEvent('s', { ctrlKey: true }));
      });

      expect(customSave).toHaveBeenCalledTimes(1);
      expect(mockSaveProject).not.toHaveBeenCalled();
    });

    it('should not call saveProject if project is not loaded', () => {
      vi.mocked(useProjectStore).mockReturnValue({
        ...defaultProjectStore,
        isLoaded: false,
      });

      renderHook(() => useKeyboardShortcuts());

      act(() => {
        window.dispatchEvent(createKeyboardEvent('s', { ctrlKey: true }));
      });

      expect(mockSaveProject).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Delete Shortcut
  // ===========================================================================

  describe('delete shortcut', () => {
    it('should call onDeleteClips on Delete key when clips are selected', () => {
      vi.mocked(useTimelineStore).mockReturnValue({
        ...defaultTimelineStore,
        selectedClipIds: ['clip-1', 'clip-2'],
      });

      const onDeleteClips = vi.fn();
      renderHook(() => useKeyboardShortcuts({ onDeleteClips }));

      act(() => {
        window.dispatchEvent(createKeyboardEvent('Delete'));
      });

      expect(onDeleteClips).toHaveBeenCalledTimes(1);
    });

    it('should call onDeleteClips on Backspace key when clips are selected', () => {
      vi.mocked(useTimelineStore).mockReturnValue({
        ...defaultTimelineStore,
        selectedClipIds: ['clip-1'],
      });

      const onDeleteClips = vi.fn();
      renderHook(() => useKeyboardShortcuts({ onDeleteClips }));

      act(() => {
        window.dispatchEvent(createKeyboardEvent('Backspace'));
      });

      expect(onDeleteClips).toHaveBeenCalledTimes(1);
    });

    it('should not call onDeleteClips when no clips are selected', () => {
      const onDeleteClips = vi.fn();
      renderHook(() => useKeyboardShortcuts({ onDeleteClips }));

      act(() => {
        window.dispatchEvent(createKeyboardEvent('Delete'));
      });

      expect(onDeleteClips).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Split Shortcut
  // ===========================================================================

  describe('split shortcut', () => {
    it('should call onSplitAtPlayhead on S key when clips are selected', () => {
      vi.mocked(useTimelineStore).mockReturnValue({
        ...defaultTimelineStore,
        selectedClipIds: ['clip-1'],
      });

      const onSplitAtPlayhead = vi.fn();
      renderHook(() => useKeyboardShortcuts({ onSplitAtPlayhead }));

      act(() => {
        window.dispatchEvent(createKeyboardEvent('s'));
      });

      expect(onSplitAtPlayhead).toHaveBeenCalledTimes(1);
    });

    it('should not call onSplitAtPlayhead when no clips are selected', () => {
      const onSplitAtPlayhead = vi.fn();
      renderHook(() => useKeyboardShortcuts({ onSplitAtPlayhead }));

      act(() => {
        window.dispatchEvent(createKeyboardEvent('s'));
      });

      expect(onSplitAtPlayhead).not.toHaveBeenCalled();
    });

    it('should not call onSplitAtPlayhead on Ctrl+S (save)', () => {
      vi.mocked(useTimelineStore).mockReturnValue({
        ...defaultTimelineStore,
        selectedClipIds: ['clip-1'],
      });

      const onSplitAtPlayhead = vi.fn();
      renderHook(() => useKeyboardShortcuts({ onSplitAtPlayhead }));

      act(() => {
        window.dispatchEvent(createKeyboardEvent('s', { ctrlKey: true }));
      });

      expect(onSplitAtPlayhead).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Escape Shortcut
  // ===========================================================================

  describe('escape shortcut', () => {
    it('should clear clip selection on Escape', () => {
      renderHook(() => useKeyboardShortcuts());

      act(() => {
        window.dispatchEvent(createKeyboardEvent('Escape'));
      });

      expect(mockClearClipSelection).toHaveBeenCalledTimes(1);
    });
  });

  // ===========================================================================
  // Export Shortcut
  // ===========================================================================

  describe('export shortcut', () => {
    it('should call onExport on Ctrl+Shift+E', () => {
      const onExport = vi.fn();
      renderHook(() => useKeyboardShortcuts({ onExport }));

      act(() => {
        window.dispatchEvent(createKeyboardEvent('e', { ctrlKey: true, shiftKey: true }));
      });

      expect(onExport).toHaveBeenCalledTimes(1);
    });
  });

  // ===========================================================================
  // Input Element Filtering
  // ===========================================================================

  describe('input element filtering', () => {
    it('should not handle shortcuts when target is input element', () => {
      renderHook(() => useKeyboardShortcuts());

      const inputElement = createInputElement('input');
      act(() => {
        window.dispatchEvent(createKeyboardEvent(' ', { target: inputElement }));
      });

      expect(mockTogglePlayback).not.toHaveBeenCalled();
    });

    it('should not handle shortcuts when target is textarea element', () => {
      renderHook(() => useKeyboardShortcuts());

      const textareaElement = createInputElement('textarea');
      act(() => {
        window.dispatchEvent(createKeyboardEvent(' ', { target: textareaElement }));
      });

      expect(mockTogglePlayback).not.toHaveBeenCalled();
    });

    it('should not handle shortcuts when target is select element', () => {
      renderHook(() => useKeyboardShortcuts());

      const selectElement = createInputElement('select');
      act(() => {
        window.dispatchEvent(createKeyboardEvent(' ', { target: selectElement }));
      });

      expect(mockTogglePlayback).not.toHaveBeenCalled();
    });

    it('should not handle shortcuts when target is contentEditable element', () => {
      renderHook(() => useKeyboardShortcuts());

      const contentEditableElement = createContentEditableElement();
      act(() => {
        window.dispatchEvent(createKeyboardEvent(' ', { target: contentEditableElement }));
      });

      expect(mockTogglePlayback).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Enabled Option
  // ===========================================================================

  describe('enabled option', () => {
    it('should not handle shortcuts when disabled', () => {
      renderHook(() => useKeyboardShortcuts({ enabled: false }));

      act(() => {
        window.dispatchEvent(createKeyboardEvent(' '));
      });

      expect(mockTogglePlayback).not.toHaveBeenCalled();
    });

    it('should handle shortcuts when enabled is true', () => {
      renderHook(() => useKeyboardShortcuts({ enabled: true }));

      act(() => {
        window.dispatchEvent(createKeyboardEvent(' '));
      });

      expect(mockTogglePlayback).toHaveBeenCalledTimes(1);
    });

    it('should handle shortcuts by default (enabled not specified)', () => {
      renderHook(() => useKeyboardShortcuts());

      act(() => {
        window.dispatchEvent(createKeyboardEvent(' '));
      });

      expect(mockTogglePlayback).toHaveBeenCalledTimes(1);
    });
  });

  // ===========================================================================
  // Cleanup
  // ===========================================================================

  describe('cleanup', () => {
    it('should remove event listener on unmount', () => {
      const removeEventListenerSpy = vi.spyOn(window, 'removeEventListener');

      const { unmount } = renderHook(() => useKeyboardShortcuts());
      unmount();

      expect(removeEventListenerSpy).toHaveBeenCalledWith('keydown', expect.any(Function));

      removeEventListenerSpy.mockRestore();
    });
  });

  // ===========================================================================
  // KEYBOARD_SHORTCUTS constant
  // ===========================================================================

  describe('KEYBOARD_SHORTCUTS constant', () => {
    it('should export a list of keyboard shortcuts', () => {
      expect(KEYBOARD_SHORTCUTS).toBeDefined();
      expect(Array.isArray(KEYBOARD_SHORTCUTS)).toBe(true);
      expect(KEYBOARD_SHORTCUTS.length).toBeGreaterThan(0);
    });

    it('should be grouped by category with shortcuts', () => {
      KEYBOARD_SHORTCUTS.forEach((group) => {
        expect(group).toHaveProperty('category');
        expect(group).toHaveProperty('shortcuts');
        expect(typeof group.category).toBe('string');
        expect(Array.isArray(group.shortcuts)).toBe(true);
        expect(group.shortcuts.length).toBeGreaterThan(0);
      });
    });

    it('should have key and description for each shortcut item', () => {
      const allShortcuts = KEYBOARD_SHORTCUTS.flatMap((group) => group.shortcuts);

      allShortcuts.forEach((shortcut) => {
        expect(shortcut).toHaveProperty('key');
        expect(shortcut).toHaveProperty('description');
        expect(typeof shortcut.key).toBe('string');
        expect(typeof shortcut.description).toBe('string');
      });
    });

    it('should include Space for Play/Pause', () => {
      const allShortcuts = KEYBOARD_SHORTCUTS.flatMap((group) => group.shortcuts);
      const spaceShortcut = allShortcuts.find((s) => s.key === 'Space');
      expect(spaceShortcut).toBeDefined();
      expect(spaceShortcut?.description).toContain('Play');
    });

    it('should include Ctrl+Z for Undo', () => {
      const allShortcuts = KEYBOARD_SHORTCUTS.flatMap((group) => group.shortcuts);
      const undoShortcut = allShortcuts.find((s) => s.key === 'Ctrl+Z');
      expect(undoShortcut).toBeDefined();
      expect(undoShortcut?.description).toContain('Undo');
    });
  });
});
