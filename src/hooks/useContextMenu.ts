/**
 * useContextMenu Hook
 *
 * Manages context menu state and positioning.
 */

import { useState, useCallback } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import type { MenuItemOrDivider } from '@/components/ui/ContextMenu';

// =============================================================================
// Types
// =============================================================================

export interface ContextMenuState {
  x: number;
  y: number;
  items: MenuItemOrDivider[];
}

export interface UseContextMenuReturn {
  contextMenu: ContextMenuState | null;
  openContextMenu: (x: number, y: number, items: MenuItemOrDivider[]) => void;
  closeContextMenu: () => void;
}

// =============================================================================
// Hook
// =============================================================================

export function useContextMenu(): UseContextMenuReturn {
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  const openContextMenu = useCallback((x: number, y: number, items: MenuItemOrDivider[]) => {
    setContextMenu({ x, y, items });
  }, []);

  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  return {
    contextMenu,
    openContextMenu,
    closeContextMenu,
  };
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Prevent default context menu and get position
 */
export function handleContextMenuEvent(
  e: ReactMouseEvent,
  callback: (x: number, y: number) => void
): void {
  e.preventDefault();
  e.stopPropagation();
  callback(e.clientX, e.clientY);
}
