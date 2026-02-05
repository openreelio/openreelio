/**
 * MaskEditor Component
 *
 * Main orchestrator component for mask (Power Windows) editing.
 * Combines canvas, toolbar, list, and property panel.
 *
 * @module components/features/masks/MaskEditor
 */

import { useCallback } from 'react';
import { X } from 'lucide-react';
import type { Mask, MaskId, MaskShape, ClipId, EffectId, SequenceId, TrackId } from '@/types';
import { useMaskEditor, type MaskTool } from '@/hooks/useMaskEditor';
import { MaskCanvas } from './MaskCanvas';
import { MaskList } from './MaskList';
import { MaskPropertyPanel } from './MaskPropertyPanel';
import { MaskShapeTools } from './MaskShapeTools';

// =============================================================================
// Types
// =============================================================================

export interface MaskEditorProps {
  /** The clip these masks belong to */
  clipId: ClipId;
  /** The effect that holds the masks */
  effectId: EffectId;
  /** The sequence ID */
  sequenceId: SequenceId;
  /** The track ID */
  trackId: TrackId;
  /** Initial masks (optional) */
  initialMasks?: Mask[];
  /** Canvas width */
  canvasWidth?: number;
  /** Canvas height */
  canvasHeight?: number;
  /** Whether the editor is disabled */
  disabled?: boolean;
  /** Compact layout mode */
  compact?: boolean;
  /** Additional CSS classes */
  className?: string;
  /** Called when masks change */
  onMasksChange?: (masks: Mask[]) => void;
}

// =============================================================================
// Component
// =============================================================================

export function MaskEditor({
  clipId,
  effectId,
  sequenceId,
  trackId,
  initialMasks = [],
  canvasWidth = 640,
  canvasHeight = 360,
  disabled = false,
  compact = false,
  className = '',
  onMasksChange,
}: MaskEditorProps) {
  // ---------------------------------------------------------------------------
  // Hook: Mask Editor State
  // ---------------------------------------------------------------------------

  const {
    masks,
    selectedMaskId,
    selectedMask,
    activeTool,
    setActiveTool,
    selectMask,
    clearSelection,
    addMask,
    updateMask,
    updateMaskLocal,
    deleteMask,
    toggleEnabled,
    toggleLocked,
    isLoading,
    isOperating,
    error,
    clearError,
  } = useMaskEditor({
    clipId,
    effectId,
    sequenceId,
    trackId,
    initialMasks,
  });

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  const handleToolChange = useCallback(
    (tool: MaskTool) => {
      if (!disabled) {
        setActiveTool(tool);
      }
    },
    [disabled, setActiveTool]
  );

  const handleMaskSelect = useCallback(
    (id: MaskId | null) => {
      if (!disabled) {
        if (id) {
          selectMask(id);
        } else {
          clearSelection();
        }
      }
    },
    [disabled, selectMask, clearSelection]
  );

  const handleMaskCreate = useCallback(
    async (shape: MaskShape) => {
      if (!disabled) {
        try {
          await addMask(shape.type);
          // Switch to select mode after creating
          setActiveTool('select');
        } catch (err) {
          // Error is handled by the hook, but log for debugging
          console.error('MaskEditor: Failed to create mask', err);
        }
      }
    },
    [disabled, addMask, setActiveTool]
  );

  const handleMaskUpdate = useCallback(
    async (id: MaskId, updates: Partial<Mask>) => {
      if (!disabled) {
        try {
          await updateMask(id, updates);
          onMasksChange?.(masks);
        } catch (err) {
          console.error('MaskEditor: Failed to update mask', err);
        }
      }
    },
    [disabled, updateMask, masks, onMasksChange]
  );

  const handleMaskDelete = useCallback(
    async (id: MaskId) => {
      if (!disabled) {
        try {
          await deleteMask(id);
          onMasksChange?.(masks.filter((m) => m.id !== id));
        } catch (err) {
          console.error('MaskEditor: Failed to delete mask', err);
        }
      }
    },
    [disabled, deleteMask, masks, onMasksChange]
  );

  const handleToggleEnabled = useCallback(
    async (id: MaskId) => {
      if (!disabled) {
        await toggleEnabled(id);
      }
    },
    [disabled, toggleEnabled]
  );

  const handleToggleLocked = useCallback(
    async (id: MaskId) => {
      if (!disabled) {
        await toggleLocked(id);
      }
    },
    [disabled, toggleLocked]
  );

  const handleAddMaskClick = useCallback(async () => {
    if (!disabled) {
      await addMask(activeTool === 'select' ? 'rectangle' : activeTool);
    }
  }, [disabled, addMask, activeTool]);

  const handlePropertyChange = useCallback(
    async (updatedMask: Mask) => {
      if (!disabled && selectedMaskId) {
        // Optimistic local update first
        updateMaskLocal(selectedMaskId, updatedMask);
        // Then sync to backend
        await updateMask(selectedMaskId, updatedMask);
      }
    },
    [disabled, selectedMaskId, updateMaskLocal, updateMask]
  );

  // ---------------------------------------------------------------------------
  // Layout Classes
  // ---------------------------------------------------------------------------

  const containerClasses = [
    'flex flex-col',
    'bg-zinc-900',
    'rounded-lg',
    'border border-zinc-700',
    'overflow-hidden',
    compact ? 'compact' : '',
    disabled ? 'opacity-60 pointer-events-none' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div data-testid="mask-editor" className={containerClasses}>
      {/* Error Banner */}
      {error && (
        <div className="flex items-center justify-between px-3 py-2 bg-red-900/50 border-b border-red-700 text-red-200 text-sm">
          <span>{error}</span>
          <button
            type="button"
            onClick={clearError}
            aria-label="Dismiss"
            className="p-1 hover:bg-red-800 rounded"
          >
            <X size={14} />
          </button>
        </div>
      )}

      {/* Toolbar */}
      <div className="flex items-center justify-between p-2 border-b border-zinc-700 bg-zinc-800/50">
        <MaskShapeTools
          activeTool={activeTool}
          onToolChange={handleToolChange}
          disabled={disabled}
          compact={compact}
        />

        {/* Loading indicator */}
        {(isLoading || isOperating) && (
          <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
        )}
      </div>

      {/* Main Content */}
      <div className="flex flex-1 min-h-0">
        {/* Canvas Area */}
        <div className="flex-1 flex items-center justify-center bg-zinc-950 p-2">
          <MaskCanvas
            masks={masks}
            selectedMaskId={selectedMaskId}
            activeTool={activeTool}
            width={canvasWidth}
            height={canvasHeight}
            onMaskSelect={handleMaskSelect}
            onMaskUpdate={handleMaskUpdate}
            onMaskCreate={handleMaskCreate}
            onMaskDelete={handleMaskDelete}
            disabled={disabled}
            className="rounded border border-zinc-700"
          />
        </div>

        {/* Right Panel */}
        <div className="w-64 border-l border-zinc-700 flex flex-col bg-zinc-900/50">
          {/* Mask List */}
          <div className="flex-1 overflow-y-auto">
            <MaskList
              masks={masks}
              selectedId={selectedMaskId}
              onSelect={handleMaskSelect}
              onAdd={handleAddMaskClick}
              onDelete={selectedMaskId ? () => handleMaskDelete(selectedMaskId) : undefined}
              onToggleEnabled={handleToggleEnabled}
              onToggleLocked={handleToggleLocked}
              disabled={disabled}
            />
          </div>

          {/* Property Panel */}
          {selectedMask && (
            <div className="border-t border-zinc-700">
              <MaskPropertyPanel
                mask={selectedMask}
                onChange={handlePropertyChange}
                disabled={disabled}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default MaskEditor;
