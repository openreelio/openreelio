/**
 * useMulticamKeyboardShortcuts Hook Tests
 *
 * TDD: RED phase - Writing tests first for global keyboard shortcuts
 * in multicam editing mode.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useMulticamKeyboardShortcuts } from './useMulticamKeyboardShortcuts';

describe('useMulticamKeyboardShortcuts', () => {
  const mockSwitchAngle = vi.fn();
  const mockSwitchAngleAt = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ===========================================================================
  // Global Keyboard Listener Tests
  // ===========================================================================

  describe('global keyboard listener', () => {
    it('should register global keyboard listener when enabled', () => {
      const addEventListenerSpy = vi.spyOn(window, 'addEventListener');

      renderHook(() =>
        useMulticamKeyboardShortcuts({
          enabled: true,
          angleCount: 4,
          onSwitchAngle: mockSwitchAngle,
        })
      );

      expect(addEventListenerSpy).toHaveBeenCalledWith(
        'keydown',
        expect.any(Function)
      );
    });

    it('should not register listener when disabled', () => {
      const addEventListenerSpy = vi.spyOn(window, 'addEventListener');

      renderHook(() =>
        useMulticamKeyboardShortcuts({
          enabled: false,
          angleCount: 4,
          onSwitchAngle: mockSwitchAngle,
        })
      );

      expect(addEventListenerSpy).not.toHaveBeenCalledWith(
        'keydown',
        expect.any(Function)
      );
    });

    it('should remove listener on unmount', () => {
      const removeEventListenerSpy = vi.spyOn(window, 'removeEventListener');

      const { unmount } = renderHook(() =>
        useMulticamKeyboardShortcuts({
          enabled: true,
          angleCount: 4,
          onSwitchAngle: mockSwitchAngle,
        })
      );

      unmount();

      expect(removeEventListenerSpy).toHaveBeenCalledWith(
        'keydown',
        expect.any(Function)
      );
    });

    it('should remove and re-add listener when enabled changes', () => {
      const addEventListenerSpy = vi.spyOn(window, 'addEventListener');
      const removeEventListenerSpy = vi.spyOn(window, 'removeEventListener');

      const { rerender } = renderHook(
        ({ enabled }) =>
          useMulticamKeyboardShortcuts({
            enabled,
            angleCount: 4,
            onSwitchAngle: mockSwitchAngle,
          }),
        { initialProps: { enabled: true } }
      );

      // Should have added listener
      expect(addEventListenerSpy).toHaveBeenCalledTimes(1);

      // Disable
      rerender({ enabled: false });

      // Should have removed listener
      expect(removeEventListenerSpy).toHaveBeenCalledWith(
        'keydown',
        expect.any(Function)
      );
    });
  });

  // ===========================================================================
  // Angle Switching Tests
  // ===========================================================================

  describe('angle switching with number keys', () => {
    it('should call onSwitchAngle when pressing key 1', () => {
      renderHook(() =>
        useMulticamKeyboardShortcuts({
          enabled: true,
          angleCount: 4,
          onSwitchAngle: mockSwitchAngle,
        })
      );

      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: '1' }));
      });

      expect(mockSwitchAngle).toHaveBeenCalledWith(0);
    });

    it('should call onSwitchAngle when pressing keys 1-9', () => {
      renderHook(() =>
        useMulticamKeyboardShortcuts({
          enabled: true,
          angleCount: 9,
          onSwitchAngle: mockSwitchAngle,
        })
      );

      for (let i = 1; i <= 9; i++) {
        act(() => {
          window.dispatchEvent(new KeyboardEvent('keydown', { key: String(i) }));
        });

        expect(mockSwitchAngle).toHaveBeenCalledWith(i - 1);
      }

      expect(mockSwitchAngle).toHaveBeenCalledTimes(9);
    });

    it('should not switch to angle beyond angleCount', () => {
      renderHook(() =>
        useMulticamKeyboardShortcuts({
          enabled: true,
          angleCount: 4,
          onSwitchAngle: mockSwitchAngle,
        })
      );

      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: '5' }));
      });

      expect(mockSwitchAngle).not.toHaveBeenCalled();
    });

    it('should ignore non-number keys', () => {
      renderHook(() =>
        useMulticamKeyboardShortcuts({
          enabled: true,
          angleCount: 4,
          onSwitchAngle: mockSwitchAngle,
        })
      );

      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Space' }));
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      });

      expect(mockSwitchAngle).not.toHaveBeenCalled();
    });

    it('should ignore key 0', () => {
      renderHook(() =>
        useMulticamKeyboardShortcuts({
          enabled: true,
          angleCount: 4,
          onSwitchAngle: mockSwitchAngle,
        })
      );

      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: '0' }));
      });

      expect(mockSwitchAngle).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Recording Mode Tests
  // ===========================================================================

  describe('recording mode', () => {
    it('should call onSwitchAngleAt when recording and provides currentTime', () => {
      renderHook(() =>
        useMulticamKeyboardShortcuts({
          enabled: true,
          angleCount: 4,
          isRecording: true,
          currentTimeSec: 15.5,
          onSwitchAngleAt: mockSwitchAngleAt,
        })
      );

      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: '2' }));
      });

      expect(mockSwitchAngleAt).toHaveBeenCalledWith(1, 15.5);
    });

    it('should fallback to onSwitchAngle if onSwitchAngleAt not provided', () => {
      renderHook(() =>
        useMulticamKeyboardShortcuts({
          enabled: true,
          angleCount: 4,
          isRecording: true,
          currentTimeSec: 15.5,
          onSwitchAngle: mockSwitchAngle,
        })
      );

      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: '2' }));
      });

      expect(mockSwitchAngle).toHaveBeenCalledWith(1);
    });
  });

  // ===========================================================================
  // Modifier Key Tests
  // ===========================================================================

  describe('modifier key handling', () => {
    it('should ignore number keys when Ctrl is pressed', () => {
      renderHook(() =>
        useMulticamKeyboardShortcuts({
          enabled: true,
          angleCount: 4,
          onSwitchAngle: mockSwitchAngle,
        })
      );

      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: '1', ctrlKey: true }));
      });

      expect(mockSwitchAngle).not.toHaveBeenCalled();
    });

    it('should ignore number keys when Alt is pressed', () => {
      renderHook(() =>
        useMulticamKeyboardShortcuts({
          enabled: true,
          angleCount: 4,
          onSwitchAngle: mockSwitchAngle,
        })
      );

      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: '1', altKey: true }));
      });

      expect(mockSwitchAngle).not.toHaveBeenCalled();
    });

    it('should ignore number keys when Meta is pressed', () => {
      renderHook(() =>
        useMulticamKeyboardShortcuts({
          enabled: true,
          angleCount: 4,
          onSwitchAngle: mockSwitchAngle,
        })
      );

      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: '1', metaKey: true }));
      });

      expect(mockSwitchAngle).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Input Element Focus Tests
  // ===========================================================================

  describe('input element focus handling', () => {
    it('should ignore keys when focus is on input element', () => {
      renderHook(() =>
        useMulticamKeyboardShortcuts({
          enabled: true,
          angleCount: 4,
          onSwitchAngle: mockSwitchAngle,
        })
      );

      // Create and focus an input
      const input = document.createElement('input');
      document.body.appendChild(input);
      input.focus();

      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: '1' }));
      });

      expect(mockSwitchAngle).not.toHaveBeenCalled();

      // Cleanup
      document.body.removeChild(input);
    });

    it('should ignore keys when focus is on textarea element', () => {
      renderHook(() =>
        useMulticamKeyboardShortcuts({
          enabled: true,
          angleCount: 4,
          onSwitchAngle: mockSwitchAngle,
        })
      );

      // Create and focus a textarea
      const textarea = document.createElement('textarea');
      document.body.appendChild(textarea);
      textarea.focus();

      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: '1' }));
      });

      expect(mockSwitchAngle).not.toHaveBeenCalled();

      // Cleanup
      document.body.removeChild(textarea);
    });

    it('should ignore keys when focus is on contenteditable element', () => {
      renderHook(() =>
        useMulticamKeyboardShortcuts({
          enabled: true,
          angleCount: 4,
          onSwitchAngle: mockSwitchAngle,
        })
      );

      // Create and focus a contenteditable div
      const div = document.createElement('div');
      // JSDOM does not reliably reflect `contentEditable` property changes into focus/activeElement.
      // Setting the attribute is the most consistent way to simulate contenteditable behavior.
      div.setAttribute('contenteditable', 'true');
      document.body.appendChild(div);
      div.focus();

      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: '1' }));
      });

      expect(mockSwitchAngle).not.toHaveBeenCalled();

      // Cleanup
      document.body.removeChild(div);
    });
  });

  // ===========================================================================
  // Registered Shortcuts Return Value Tests
  // ===========================================================================

  describe('registered shortcuts', () => {
    it('should return registered shortcuts info', () => {
      const { result } = renderHook(() =>
        useMulticamKeyboardShortcuts({
          enabled: true,
          angleCount: 4,
          onSwitchAngle: mockSwitchAngle,
        })
      );

      expect(result.current.shortcuts).toBeDefined();
      expect(result.current.shortcuts).toHaveLength(4);
      expect(result.current.shortcuts[0]).toMatchObject({
        key: '1',
        angleIndex: 0,
        label: 'Switch to Angle 1',
      });
    });

    it('should return shortcuts up to angleCount', () => {
      const { result } = renderHook(() =>
        useMulticamKeyboardShortcuts({
          enabled: true,
          angleCount: 6,
          onSwitchAngle: mockSwitchAngle,
        })
      );

      expect(result.current.shortcuts).toHaveLength(6);
    });
  });
});
