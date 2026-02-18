/**
 * BinContextMenu Component
 *
 * Context menu for bin/folder operations in the Project Explorer.
 * Supports creating subfolders, renaming, setting color, and deleting.
 * Portal-based with viewport-aware positioning.
 */

import { useEffect, useRef, useState, useLayoutEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { FolderPlus, Edit3, Palette, Trash2 } from 'lucide-react';
import { BIN_COLORS, BIN_COLOR_CLASSES } from '@/utils/binUtils';
import type { BinId, BinColor } from '@/types';

// =============================================================================
// Types
// =============================================================================

export interface BinContextMenuProps {
  /** ID of the bin */
  binId: BinId;
  /** Display name of the bin */
  binName: string;
  /** Current color of the bin */
  binColor: BinColor;
  /** Position to render the menu */
  position: { x: number; y: number };
  /** Close the menu */
  onClose: () => void;
  /** Create a subfolder inside this bin */
  onCreateSubfolder: (parentBinId: BinId) => void;
  /** Start renaming this bin */
  onRename: (binId: BinId) => void;
  /** Set the color of this bin */
  onSetColor: (binId: BinId, color: BinColor) => void;
  /** Delete this bin */
  onDelete: (binId: BinId) => void;
}

// =============================================================================
// Component
// =============================================================================

export function BinContextMenu({
  binId,
  binName,
  binColor,
  position,
  onClose,
  onCreateSubfolder,
  onRename,
  onSetColor,
  onDelete,
}: BinContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [adjustedPosition, setAdjustedPosition] = useState(position);

  // Viewport-aware positioning
  useLayoutEffect(() => {
    if (!menuRef.current) return;

    const menu = menuRef.current;
    const menuRect = menu.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    let x = position.x;
    let y = position.y;

    if (x + menuRect.width > viewportWidth) {
      x = Math.max(8, viewportWidth - menuRect.width - 8);
    }

    if (y + menuRect.height > viewportHeight) {
      if (y - menuRect.height > 0) {
        y = y - menuRect.height;
      } else {
        y = Math.max(8, viewportHeight - menuRect.height - 8);
      }
    }

    setAdjustedPosition({ x, y });
  }, [position]);

  // Click outside handler
  // Uses a mounted flag instead of setTimeout to avoid race conditions
  // where rapid open/close sequences could leave stale listeners.
  useEffect(() => {
    let isMounted = true;

    const handleClickOutside = (e: MouseEvent) => {
      if (!isMounted) return;
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    // Register on next frame so the opening click doesn't immediately close
    const frameId = requestAnimationFrame(() => {
      if (isMounted) {
        document.addEventListener('mousedown', handleClickOutside);
      }
    });

    return () => {
      isMounted = false;
      cancelAnimationFrame(frameId);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [onClose]);

  // Escape key handler
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  // ===========================================================================
  // Handlers
  // ===========================================================================

  const handleCreateSubfolder = useCallback(() => {
    onCreateSubfolder(binId);
    onClose();
  }, [binId, onCreateSubfolder, onClose]);

  const handleRename = useCallback(() => {
    onRename(binId);
    onClose();
  }, [binId, onRename, onClose]);

  const handleToggleColorPicker = useCallback(() => {
    setShowColorPicker((prev) => !prev);
  }, []);

  const handleSetColor = useCallback(
    (color: BinColor) => {
      onSetColor(binId, color);
      onClose();
    },
    [binId, onSetColor, onClose],
  );

  const handleDelete = useCallback(() => {
    onDelete(binId);
    onClose();
  }, [binId, onDelete, onClose]);

  // ===========================================================================
  // Render
  // ===========================================================================

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label={`Folder actions: ${binName}`}
      className="fixed z-[100] min-w-[200px] py-1.5 bg-surface-elevated rounded-lg border border-border-subtle shadow-xl"
      style={{
        left: adjustedPosition.x,
        top: adjustedPosition.y,
      }}
    >
      {/* Header */}
      <div className="px-3 py-1.5 text-xs font-medium text-text-secondary truncate border-b border-border-subtle mb-1">
        {binName}
      </div>

      {/* New Subfolder */}
      <button
        role="menuitem"
        data-testid="bin-context-create-subfolder"
        className="w-full px-3 py-2 text-left text-sm flex items-center gap-2.5 text-text-primary hover:bg-surface-active transition-colors"
        onClick={handleCreateSubfolder}
      >
        <FolderPlus className="w-4 h-4" />
        <span className="font-medium">New Subfolder</span>
      </button>

      {/* Rename */}
      <button
        role="menuitem"
        data-testid="bin-context-rename"
        className="w-full px-3 py-2 text-left text-sm flex items-center gap-2.5 text-text-primary hover:bg-surface-active transition-colors"
        onClick={handleRename}
      >
        <Edit3 className="w-4 h-4" />
        <span className="font-medium">Rename</span>
      </button>

      {/* Set Color */}
      <button
        role="menuitem"
        data-testid="bin-context-set-color"
        className="w-full px-3 py-2 text-left text-sm flex items-center gap-2.5 text-text-primary hover:bg-surface-active transition-colors"
        onClick={handleToggleColorPicker}
      >
        <Palette className="w-4 h-4" />
        <span className="font-medium">Set Color</span>
      </button>

      {/* Color Picker (inline expandable) */}
      {showColorPicker && (
        <div data-testid="bin-color-picker" className="px-3 py-2 flex items-center gap-1.5">
          {BIN_COLORS.map((color) => {
            const colorClasses = BIN_COLOR_CLASSES[color];
            const isActive = color === binColor;

            return (
              <button
                key={color}
                data-testid={`color-swatch-${color}`}
                className={`w-5 h-5 rounded-full ${colorClasses.bg} transition-transform hover:scale-110 ${
                  isActive ? 'ring-2 ring-white ring-offset-1 ring-offset-surface-elevated' : ''
                }`}
                onClick={() => handleSetColor(color)}
                aria-label={`Set color to ${color}`}
                title={color}
              />
            );
          })}
        </div>
      )}

      {/* Divider */}
      <div role="separator" className="my-1.5 h-px bg-border-subtle w-full" />

      {/* Delete */}
      <button
        role="menuitem"
        data-testid="bin-context-delete"
        className="w-full px-3 py-2 text-left text-sm flex items-center gap-2.5 text-status-error hover:bg-status-error/10 transition-colors"
        onClick={handleDelete}
      >
        <Trash2 className="w-4 h-4" />
        <span className="font-medium">Delete</span>
      </button>
    </div>,
    document.body,
  );
}
