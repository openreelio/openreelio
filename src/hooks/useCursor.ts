/**
 * useCursor Hook
 *
 * Manages cursor states for different timeline operations.
 */

import { useCallback, useEffect } from 'react';

// =============================================================================
// Types
// =============================================================================

export type CursorType =
  | 'default'
  | 'pointer'
  | 'grab'
  | 'grabbing'
  | 'ew-resize'      // Scrubbing
  | 'w-resize'       // Trim left
  | 'e-resize'       // Trim right
  | 'ns-resize'      // Track resize
  | 'crosshair'      // Selection box
  | 'not-allowed'    // Invalid drop
  | 'trim-ripple'    // Custom: Ripple trim
  | 'trim-roll'      // Custom: Roll trim
  | 'trim-slip';     // Custom: Slip edit

// =============================================================================
// Cursor Class Mapping
// =============================================================================

const cursorMap: Record<CursorType, string> = {
  'default': 'cursor-default',
  'pointer': 'cursor-pointer',
  'grab': 'cursor-grab',
  'grabbing': 'cursor-grabbing',
  'ew-resize': 'cursor-ew-resize',
  'w-resize': 'cursor-w-resize',
  'e-resize': 'cursor-e-resize',
  'ns-resize': 'cursor-ns-resize',
  'crosshair': 'cursor-crosshair',
  'not-allowed': 'cursor-not-allowed',
  'trim-ripple': 'cursor-trim-ripple',
  'trim-roll': 'cursor-trim-roll',
  'trim-slip': 'cursor-trim-slip',
};

// =============================================================================
// Hook
// =============================================================================

export interface UseCursorReturn {
  setCursor: (type: CursorType) => void;
  resetCursor: () => void;
}

export function useCursor(): UseCursorReturn {
  const setCursor = useCallback((type: CursorType) => {
    // Remove all cursor classes
    document.body.className = document.body.className
      .replace(/cursor-[\w-]+/g, '')
      .trim();

    // Add new cursor class
    document.body.classList.add(cursorMap[type]);
  }, []);

  const resetCursor = useCallback(() => {
    setCursor('default');
  }, [setCursor]);

  // Reset cursor on unmount
  useEffect(() => {
    return () => {
      resetCursor();
    };
  }, [resetCursor]);

  return { setCursor, resetCursor };
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Get cursor type for clip operation
 */
export function getClipCursor(operation: 'move' | 'trim-left' | 'trim-right' | 'select'): CursorType {
  switch (operation) {
    case 'move':
      return 'grab';
    case 'trim-left':
      return 'w-resize';
    case 'trim-right':
      return 'e-resize';
    case 'select':
      return 'pointer';
    default:
      return 'default';
  }
}

/**
 * Get cursor type for timeline operation
 */
export function getTimelineCursor(operation: 'scrub' | 'select-box' | 'track-resize'): CursorType {
  switch (operation) {
    case 'scrub':
      return 'ew-resize';
    case 'select-box':
      return 'crosshair';
    case 'track-resize':
      return 'ns-resize';
    default:
      return 'default';
  }
}
