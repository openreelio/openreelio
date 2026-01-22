/**
 * Context Menu Component
 *
 * Robust, accessible, viewport-aware context menu with keyboard navigation.
 */

import { useEffect, useRef, useState, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';

// =============================================================================
// Types
// =============================================================================

export interface MenuItem {
  type?: never;
  label: string;
  shortcut?: string;
  icon?: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}

export interface MenuDivider {
  type: 'divider';
}

export type MenuItemOrDivider = MenuItem | MenuDivider;

export interface ContextMenuProps {
  x: number;
  y: number;
  items: MenuItemOrDivider[];
  onClose: () => void;
}

// =============================================================================
// Helper Functions
// =============================================================================

function useAdjustedPosition(
  x: number,
  y: number,
  menuRef: React.RefObject<HTMLDivElement>,
): { x: number; y: number; height: string } {
  const [position, setPosition] = useState({ x, y, height: 'auto' });

  // useLayoutEffect prevents visual jumping by calculating before paint
  useLayoutEffect(() => {
    if (!menuRef.current) return;

    const menu = menuRef.current;
    const menuRect = menu.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    let adjustedX = x;
    let adjustedY = y;
    let maxHeight = 'auto';

    // Horizontal adjustment (flip to left if overflow)
    if (x + menuRect.width > viewportWidth) {
      adjustedX = x - menuRect.width;
      // If still off-screen to the left, pin to right edge
      if (adjustedX < 0) adjustedX = viewportWidth - menuRect.width - 8;
    }

    // Vertical adjustment
    if (y + menuRect.height > viewportHeight) {
      // Try flipping up
      if (y - menuRect.height > 0) {
        adjustedY = y - menuRect.height;
      } else {
        // If fits neither up nor down, pin to bottom and scroll
        adjustedY = Math.max(8, viewportHeight - menuRect.height - 8);

        // If menu is taller than viewport, constrain height
        if (menuRect.height > viewportHeight) {
          adjustedY = 8;
          maxHeight = `${viewportHeight - 16}px`;
        }
      }
    }

    setPosition({ x: adjustedX, y: adjustedY, height: maxHeight });
  }, [x, y, menuRef]);

  return position;
}

// =============================================================================
// Context Menu Component
// =============================================================================

export function ContextMenu({ x, y, items, onClose }: ContextMenuProps): JSX.Element {
  const menuRef = useRef<HTMLDivElement>(null);
  const [focusedIndex, setFocusedIndex] = useState(-1);

  // Smart positioning
  const { x: finalX, y: finalY, height } = useAdjustedPosition(x, y, menuRef);

  // Click outside handler
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    const timeoutId = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
    }, 50); // Small debounce to avoid immediate close

    return () => {
      clearTimeout(timeoutId);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [onClose]);

  // Keyboard Navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const menuItemIndices = items
        .map((item, idx) => (!('type' in item) ? idx : -1))
        .filter((idx) => idx !== -1);

      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        e.stopPropagation();
        setFocusedIndex((prev) => {
          const currentIndex = menuItemIndices.indexOf(prev);
          const nextIndex = currentIndex + 1 < menuItemIndices.length ? currentIndex + 1 : 0;
          return menuItemIndices[nextIndex];
        });
      }

      if (e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        setFocusedIndex((prev) => {
          const currentIndex = menuItemIndices.indexOf(prev);
          const nextIndex = currentIndex - 1 >= 0 ? currentIndex - 1 : menuItemIndices.length - 1;
          return menuItemIndices[nextIndex];
        });
      }

      if (e.key === 'Enter' && focusedIndex >= 0) {
        e.preventDefault();
        e.stopPropagation();
        const item = items[focusedIndex] as MenuItem;
        if (item && !item.disabled) {
          item.onClick();
          onClose();
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [items, focusedIndex, onClose]);

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      className="fixed z-[100] min-w-[200px] py-1.5 bg-surface-elevated rounded-lg border border-border-subtle shadow-xl animate-scale-in overflow-y-auto"
      style={{
        left: finalX,
        top: finalY,
        maxHeight: height,
      }}
    >
      {items.map((item, index) => {
        if ('type' in item && item.type === 'divider') {
          return <div key={`divider-${index}`} className="my-1.5 h-px bg-border-subtle w-full" />;
        }

        const menuItem = item as MenuItem;
        const isFocused = index === focusedIndex;

        return (
          <button
            key={index}
            onClick={(e) => {
              e.stopPropagation();
              if (!menuItem.disabled) {
                menuItem.onClick();
                onClose();
              }
            }}
            onMouseEnter={() => setFocusedIndex(index)}
            disabled={menuItem.disabled}
            className={`
              w-full px-3 py-2 text-left text-sm flex items-center justify-between
              transition-colors duration-50 select-none
              ${
                menuItem.disabled
                  ? 'opacity-40 cursor-not-allowed text-text-muted'
                  : menuItem.danger
                    ? 'text-status-error hover:bg-status-error/10'
                    : 'text-text-primary hover:bg-surface-active'
              }
              ${isFocused && !menuItem.disabled ? 'bg-surface-active' : ''}
              focus:outline-none
            `}
          >
            <span className="flex items-center gap-2.5">
              {menuItem.icon && <span className="w-4 h-4">{menuItem.icon}</span>}
              <span className="font-medium">{menuItem.label}</span>
            </span>
            {menuItem.shortcut && (
              <span className="text-text-muted text-[10px] font-mono tracking-wider ml-6 uppercase opacity-70">
                {menuItem.shortcut}
              </span>
            )}
          </button>
        );
      })}
    </div>,
    document.body,
  );
}
