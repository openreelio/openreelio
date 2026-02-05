/**
 * useMulticamKeyboardShortcuts Hook
 *
 * Provides global keyboard shortcuts for multicam angle switching.
 * Keys 1-9 switch to corresponding angles when multicam mode is active.
 *
 * Features:
 * - Global keyboard listener (works without focus on specific component)
 * - Support for recording mode (records switch with timestamp)
 * - Ignores shortcuts when input elements are focused
 * - Ignores shortcuts when modifier keys are pressed
 *
 * @module hooks/useMulticamKeyboardShortcuts
 */

import { useEffect, useCallback, useMemo } from 'react';

// =============================================================================
// Types
// =============================================================================

export interface MulticamShortcut {
  /** The key to press (1-9) */
  key: string;
  /** The angle index (0-8) */
  angleIndex: number;
  /** Display label for the shortcut */
  label: string;
  /** Action identifier */
  action: string;
}

export interface UseMulticamKeyboardShortcutsOptions {
  /** Whether keyboard shortcuts are enabled */
  enabled: boolean;
  /** Number of available angles */
  angleCount: number;
  /** Whether recording mode is active */
  isRecording?: boolean;
  /** Current playback time in seconds (used when recording) */
  currentTimeSec?: number;
  /** Callback for angle switch (simple mode) */
  onSwitchAngle?: (angleIndex: number) => void;
  /** Callback for angle switch with timestamp (recording mode) */
  onSwitchAngleAt?: (angleIndex: number, timeSec: number) => void;
}

export interface UseMulticamKeyboardShortcutsReturn {
  /** Information about registered shortcuts */
  shortcuts: MulticamShortcut[];
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Check if the active element is an input or editable element
 */
function isEditableElement(element: Element | null): boolean {
  if (!element) return false;

  const tagName = element.tagName.toLowerCase();
  if (tagName === 'input' || tagName === 'textarea' || tagName === 'select') {
    return true;
  }

  if (element instanceof HTMLElement) {
    // Check both isContentEditable property and contenteditable attribute
    // The attribute check is needed for JSDOM compatibility
    if (element.isContentEditable || element.getAttribute('contenteditable') === 'true') {
      return true;
    }
  }

  return false;
}

/**
 * Check if any modifier key is pressed
 */
function hasModifierKey(event: KeyboardEvent): boolean {
  return event.ctrlKey || event.altKey || event.metaKey;
}

// =============================================================================
// Hook Implementation
// =============================================================================

export function useMulticamKeyboardShortcuts(
  options: UseMulticamKeyboardShortcutsOptions
): UseMulticamKeyboardShortcutsReturn {
  const {
    enabled,
    angleCount,
    isRecording = false,
    currentTimeSec = 0,
    onSwitchAngle,
    onSwitchAngleAt,
  } = options;

  // ---------------------------------------------------------------------------
  // Generate Shortcuts Info
  // ---------------------------------------------------------------------------

  const shortcuts = useMemo<MulticamShortcut[]>(() => {
    const maxShortcuts = Math.min(angleCount, 9);
    const result: MulticamShortcut[] = [];

    for (let i = 0; i < maxShortcuts; i++) {
      result.push({
        key: String(i + 1),
        angleIndex: i,
        label: `Switch to Angle ${i + 1}`,
        action: `multicam.switchAngle${i + 1}`,
      });
    }

    return result;
  }, [angleCount]);

  // ---------------------------------------------------------------------------
  // Keyboard Event Handler
  // ---------------------------------------------------------------------------

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      // Ignore if any modifier key is pressed
      if (hasModifierKey(event)) {
        return;
      }

      // Ignore if focus is on an editable element
      if (isEditableElement(document.activeElement)) {
        return;
      }

      // Check for number keys 1-9
      const num = parseInt(event.key, 10);
      if (isNaN(num) || num < 1 || num > 9) {
        return;
      }

      const angleIndex = num - 1;

      // Check if angle exists
      if (angleIndex >= angleCount) {
        return;
      }

      // Prevent default behavior
      event.preventDefault();

      // Trigger the appropriate callback
      if (isRecording && onSwitchAngleAt) {
        onSwitchAngleAt(angleIndex, currentTimeSec);
      } else if (onSwitchAngle) {
        onSwitchAngle(angleIndex);
      }
    },
    [angleCount, isRecording, currentTimeSec, onSwitchAngle, onSwitchAngleAt]
  );

  // ---------------------------------------------------------------------------
  // Register/Unregister Global Listener
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (!enabled) {
      return;
    }

    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [enabled, handleKeyDown]);

  // ---------------------------------------------------------------------------
  // Return
  // ---------------------------------------------------------------------------

  return {
    shortcuts,
  };
}

export default useMulticamKeyboardShortcuts;
