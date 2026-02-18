/**
 * BinItem Component
 *
 * Individual bin/folder item in the Project Explorer tree view.
 * Supports expand/collapse, selection, inline editing, and drag-drop.
 *
 * Features:
 * - Color-coded folder icon
 * - Expand/collapse for nested bins
 * - Asset count badge
 * - Inline name editing
 * - Drag and drop support
 * - Context menu
 */

import { memo, useState, useRef, useEffect, useCallback } from 'react';
import { Folder, FolderOpen, ChevronRight, ChevronDown } from 'lucide-react';
import type { BinColor, BinId } from '@/types';
import { BIN_COLOR_CLASSES } from '@/utils/binUtils';

// =============================================================================
// Types
// =============================================================================

export interface BinItemProps {
  /** Bin ID */
  id: BinId;
  /** Bin name */
  name: string;
  /** Bin color */
  color: BinColor;
  /** Nesting depth (for indentation) */
  depth: number;
  /** Whether the bin is expanded */
  expanded: boolean;
  /** Whether the bin has child bins */
  hasChildren: boolean;
  /** Number of assets in this bin */
  assetCount: number;
  /** Whether the bin is selected */
  isSelected: boolean;
  /** Whether the bin is being edited */
  isEditing?: boolean;
  /** Whether this is a drop target */
  isDropTarget?: boolean;
  /** Callback when bin is selected */
  onSelect?: (id: BinId) => void;
  /** Callback when bin is double-clicked (enter bin) */
  onDoubleClick?: (id: BinId) => void;
  /** Callback when expand/collapse is toggled */
  onToggleExpand?: (id: BinId) => void;
  /** Callback for context menu */
  onContextMenu?: (id: BinId, event: React.MouseEvent) => void;
  /** Callback when bin is renamed */
  onRename?: (id: BinId, newName: string) => void;
  /** Callback when editing is cancelled */
  onCancelEdit?: () => void;
  /** Callback when drag starts */
  onDragStart?: (id: BinId, event: React.DragEvent) => void;
  /** Callback when something is dropped on this bin */
  onDrop?: (id: BinId, event: React.DragEvent) => void;
  /** Callback when dragging over */
  onDragOver?: (id: BinId, event: React.DragEvent) => void;
  /** Callback when drag leaves */
  onDragLeave?: (id: BinId, event: React.DragEvent) => void;
  /** Callback when drag ends (cancelled or completed) */
  onDragEnd?: () => void;
  /** Additional CSS classes */
  className?: string;
}

// =============================================================================
// Constants
// =============================================================================

const BASE_PADDING = 8;
const INDENT_PER_LEVEL = 16;

// =============================================================================
// Component
// =============================================================================

export const BinItem = memo(function BinItem({
  id,
  name,
  color,
  depth,
  expanded,
  hasChildren,
  assetCount,
  isSelected,
  isEditing = false,
  isDropTarget = false,
  onSelect,
  onDoubleClick,
  onToggleExpand,
  onContextMenu,
  onRename,
  onCancelEdit,
  onDragStart,
  onDrop,
  onDragOver,
  onDragLeave,
  onDragEnd,
  className = '',
}: BinItemProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [editValue, setEditValue] = useState(name);

  // Focus input when editing starts
  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  // Reset edit value when name changes or editing starts
  useEffect(() => {
    setEditValue(name);
  }, [name, isEditing]);

  // ===========================================================================
  // Handlers
  // ===========================================================================

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onSelect?.(id);
    },
    [id, onSelect]
  );

  const handleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onDoubleClick?.(id);
    },
    [id, onDoubleClick]
  );

  const handleExpandClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onToggleExpand?.(id);
    },
    [id, onToggleExpand]
  );

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      onContextMenu?.(id, e);
    },
    [id, onContextMenu]
  );

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setEditValue(e.target.value);
  }, []);

  const handleInputBlur = useCallback(() => {
    if (editValue.trim() && editValue !== name) {
      onRename?.(id, editValue.trim());
    } else {
      onCancelEdit?.();
    }
  }, [id, editValue, name, onRename, onCancelEdit]);

  const handleInputKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (editValue.trim()) {
          onRename?.(id, editValue.trim());
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        onCancelEdit?.();
      }
    },
    [id, editValue, onRename, onCancelEdit]
  );

  const handleDragStart = useCallback(
    (e: React.DragEvent) => {
      onDragStart?.(id, e);
    },
    [id, onDragStart]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      onDrop?.(id, e);
    },
    [id, onDrop]
  );

  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      onDragOver?.(id, e);
    },
    [id, onDragOver]
  );

  const handleDragLeave = useCallback(
    (e: React.DragEvent) => {
      e.stopPropagation();
      onDragLeave?.(id, e);
    },
    [id, onDragLeave]
  );

  // ===========================================================================
  // Render
  // ===========================================================================

  const paddingLeft = BASE_PADDING + depth * INDENT_PER_LEVEL;
  const colorClass = BIN_COLOR_CLASSES[color]?.text || 'text-gray-500';
  const FolderIcon = expanded && hasChildren ? FolderOpen : Folder;

  return (
    <div
      data-testid={`bin-item-${id}`}
      className={`
        flex items-center gap-1 py-1 pr-2 rounded cursor-pointer
        transition-colors
        ${isSelected ? 'bg-primary-500/20' : 'hover:bg-surface-active'}
        ${isDropTarget ? 'ring-2 ring-primary-500' : ''}
        ${className}
      `}
      style={{ paddingLeft }}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onContextMenu={handleContextMenu}
      draggable
      onDragStart={handleDragStart}
      onDragEnd={onDragEnd}
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
    >
      {/* Expand/Collapse Icon */}
      {hasChildren ? (
        <button
          data-testid="bin-expand-icon"
          data-expanded={expanded}
          className="p-0.5 rounded hover:bg-surface-highest"
          onClick={handleExpandClick}
          aria-label={expanded ? 'Collapse' : 'Expand'}
        >
          {expanded ? (
            <ChevronDown className="w-3 h-3 text-editor-text-muted" />
          ) : (
            <ChevronRight className="w-3 h-3 text-editor-text-muted" />
          )}
        </button>
      ) : (
        <div className="w-4" /> // Spacer for alignment
      )}

      {/* Folder Icon */}
      <FolderIcon
        data-testid="bin-folder-icon"
        className={`w-4 h-4 flex-shrink-0 ${colorClass}`}
      />

      {/* Name or Input */}
      {isEditing ? (
        <input
          ref={inputRef}
          data-testid="bin-name-input"
          type="text"
          value={editValue}
          onChange={handleInputChange}
          onBlur={handleInputBlur}
          onKeyDown={handleInputKeyDown}
          className="flex-1 min-w-0 px-1 py-0.5 text-sm bg-surface-active border border-border-focus rounded text-editor-text focus:outline-none"
        />
      ) : (
        <span className="flex-1 min-w-0 text-sm text-editor-text truncate">{name}</span>
      )}

      {/* Asset Count Badge */}
      {assetCount > 0 && !isEditing && (
        <span
          data-testid="bin-asset-count"
          className="px-1.5 py-0.5 text-[10px] font-medium bg-surface-highest text-editor-text-muted rounded-full"
        >
          {assetCount}
        </span>
      )}
    </div>
  );
});

export default BinItem;
