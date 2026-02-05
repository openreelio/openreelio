/**
 * MaskList Component
 *
 * Displays a list of masks with selection, visibility, and lock controls.
 *
 * @module components/features/masks/MaskList
 */

import React, { useCallback } from 'react';
import {
  Plus,
  Trash2,
  Eye,
  EyeOff,
  Lock,
  Unlock,
  Square,
  Circle,
  Triangle,
  Spline,
} from 'lucide-react';
import type { Mask, MaskId, MaskShape } from '@/types';

// =============================================================================
// Types
// =============================================================================

export interface MaskListProps {
  /** List of masks to display */
  masks: Mask[];
  /** Currently selected mask ID */
  selectedId: MaskId | null;
  /** Called when a mask is selected/deselected */
  onSelect: (id: MaskId | null) => void;
  /** Called when add button is clicked */
  onAdd?: () => void;
  /** Called when delete button is clicked */
  onDelete?: (id: MaskId) => void;
  /** Called when mask enabled state is toggled */
  onToggleEnabled?: (id: MaskId, enabled: boolean) => void;
  /** Called when mask locked state is toggled */
  onToggleLocked?: (id: MaskId, locked: boolean) => void;
  /** Whether controls are disabled */
  disabled?: boolean;
  /** Additional CSS class */
  className?: string;
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Gets the appropriate icon for a mask shape type.
 */
function getMaskIcon(shape: MaskShape) {
  switch (shape.type) {
    case 'rectangle':
      return <Square size={14} data-testid="mask-icon-rectangle" />;
    case 'ellipse':
      return <Circle size={14} data-testid="mask-icon-ellipse" />;
    case 'polygon':
      return <Triangle size={14} data-testid="mask-icon-polygon" />;
    case 'bezier':
      return <Spline size={14} data-testid="mask-icon-bezier" />;
    default:
      return <Square size={14} data-testid="mask-icon-unknown" />;
  }
}

// =============================================================================
// Component
// =============================================================================

export function MaskList({
  masks,
  selectedId,
  onSelect,
  onAdd,
  onDelete,
  onToggleEnabled,
  onToggleLocked,
  disabled = false,
  className = '',
}: MaskListProps) {
  // Handle mask click
  const handleMaskClick = useCallback(
    (id: MaskId) => {
      if (id === selectedId) {
        onSelect(null);
      } else {
        onSelect(id);
      }
    },
    [selectedId, onSelect]
  );

  // Handle visibility toggle
  const handleToggleEnabled = useCallback(
    (e: React.MouseEvent, mask: Mask) => {
      e.stopPropagation();
      onToggleEnabled?.(mask.id, !mask.enabled);
    },
    [onToggleEnabled]
  );

  // Handle lock toggle
  const handleToggleLocked = useCallback(
    (e: React.MouseEvent, mask: Mask) => {
      e.stopPropagation();
      onToggleLocked?.(mask.id, !mask.locked);
    },
    [onToggleLocked]
  );

  // Handle delete
  const handleDelete = useCallback(() => {
    if (selectedId) {
      onDelete?.(selectedId);
    }
  }, [selectedId, onDelete]);

  return (
    <div
      data-testid="mask-list"
      className={`bg-zinc-900 rounded-lg border border-zinc-700 ${className}`}
    >
      {/* Header */}
      <div className="flex items-center justify-between p-2 border-b border-zinc-700">
        <span className="text-xs font-medium text-zinc-400 uppercase tracking-wide">
          Masks
        </span>
        <div className="flex items-center gap-1">
          {/* Delete selected mask */}
          {onDelete && selectedId && (
            <button
              type="button"
              onClick={handleDelete}
              disabled={disabled}
              className="p-1 text-zinc-400 hover:text-red-400 hover:bg-zinc-700 rounded
                         disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              aria-label="Delete"
            >
              <Trash2 size={14} />
            </button>
          )}
          {/* Add mask */}
          {onAdd && (
            <button
              type="button"
              onClick={onAdd}
              disabled={disabled}
              className="p-1 text-zinc-400 hover:text-white hover:bg-zinc-700 rounded
                         disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              aria-label="Add Mask"
            >
              <Plus size={14} />
            </button>
          )}
        </div>
      </div>

      {/* Mask List */}
      <div className="max-h-48 overflow-y-auto">
        {masks.length === 0 ? (
          <div className="p-4 text-center text-xs text-zinc-500">
            No masks
          </div>
        ) : (
          <ul className="divide-y divide-zinc-800">
            {masks.map((mask) => {
              const isSelected = mask.id === selectedId;
              return (
                <li
                  key={mask.id}
                  data-testid={`mask-item-${mask.id}`}
                  onClick={() => !disabled && handleMaskClick(mask.id)}
                  className={`
                    flex items-center gap-2 px-2 py-1.5 cursor-pointer
                    transition-colors
                    ${isSelected ? 'bg-blue-600 text-white' : 'hover:bg-zinc-800'}
                    ${!mask.enabled ? 'opacity-50' : ''}
                    ${disabled ? 'cursor-not-allowed' : ''}
                  `}
                >
                  {/* Shape icon */}
                  <span className="text-zinc-400">{getMaskIcon(mask.shape)}</span>

                  {/* Mask name */}
                  <span className="flex-1 text-xs truncate">
                    {mask.name}
                  </span>

                  {/* Lock indicator */}
                  {mask.locked && (
                    <Lock
                      size={12}
                      className="text-zinc-500"
                      data-testid={`lock-icon-${mask.id}`}
                    />
                  )}

                  {/* Action buttons */}
                  <div className="flex items-center gap-0.5">
                    {/* Visibility toggle */}
                    {onToggleEnabled && (
                      <button
                        type="button"
                        onClick={(e) => handleToggleEnabled(e, mask)}
                        disabled={disabled}
                        className={`p-0.5 rounded transition-colors ${
                          isSelected
                            ? 'hover:bg-blue-500'
                            : 'hover:bg-zinc-700'
                        }`}
                        aria-label="Toggle visibility"
                      >
                        {mask.enabled ? (
                          <Eye size={12} className="text-zinc-400" />
                        ) : (
                          <EyeOff size={12} className="text-zinc-500" />
                        )}
                      </button>
                    )}

                    {/* Lock toggle */}
                    {onToggleLocked && (
                      <button
                        type="button"
                        onClick={(e) => handleToggleLocked(e, mask)}
                        disabled={disabled}
                        className={`p-0.5 rounded transition-colors ${
                          isSelected
                            ? 'hover:bg-blue-500'
                            : 'hover:bg-zinc-700'
                        }`}
                        aria-label="Toggle lock"
                      >
                        {mask.locked ? (
                          <Lock size={12} className="text-zinc-400" />
                        ) : (
                          <Unlock size={12} className="text-zinc-500" />
                        )}
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

export default MaskList;
