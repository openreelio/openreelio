/**
 * PowerWindowSection — Collapsible mask section for color effects.
 * Provides CRUD for power window masks within the EffectInspector.
 */
import { memo, useCallback, useState } from 'react';
import { ChevronDown, ChevronRight, Square, Circle, Blend } from 'lucide-react';
import type { Effect, Mask, MaskId } from '@/types';
import { useMask, createRectangleMask, createEllipseMask, createGradientMask } from '@/hooks/useMask';
import { MaskList, MaskPropertyPanel } from '@/components/features/masks';
import { refreshProjectState } from '@/utils/stateRefreshHelper';

export interface PowerWindowSectionProps {
  /** The effect to manage masks for */
  effect: Effect;
  /** Clip context for IPC commands */
  clipContext?: {
    sequenceId: string;
    trackId: string;
    clipId: string;
  };
  /** Whether controls are read-only */
  readOnly?: boolean;
  /** Callback after mask changes (to refresh state) */
  onMaskChange?: () => void;
}

const SHAPE_PRESETS = [
  { id: 'ellipse' as const, label: 'Circle', icon: Circle },
  { id: 'rectangle' as const, label: 'Rectangle', icon: Square },
  { id: 'gradient' as const, label: 'Gradient', icon: Blend },
] as const;

type ShapePresetId = (typeof SHAPE_PRESETS)[number]['id'];

export const PowerWindowSection = memo(function PowerWindowSection({
  effect,
  clipContext,
  readOnly = false,
  onMaskChange,
}: PowerWindowSectionProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [selectedMaskId, setSelectedMaskId] = useState<MaskId | null>(null);
  const { addMask, updateMask, removeMask } = useMask();
  const masks = effect.masks?.masks ?? [];
  const selectedMask = masks.find((m) => m.id === selectedMaskId) ?? null;

  const refreshState = useCallback(async () => {
    await refreshProjectState();
    onMaskChange?.();
  }, [onMaskChange]);

  const handleAddMask = useCallback(
    async (shapeType: ShapePresetId) => {
      if (!clipContext || readOnly) return;

      const shape =
        shapeType === 'ellipse'
          ? createEllipseMask()
          : shapeType === 'gradient'
            ? createGradientMask()
            : createRectangleMask();

      const maskId = await addMask({
        sequenceId: clipContext.sequenceId,
        trackId: clipContext.trackId,
        clipId: clipContext.clipId,
        effectId: effect.id,
        shape,
        feather: shapeType === 'gradient' ? 0 : 0.1,
      });

      if (maskId) {
        setSelectedMaskId(maskId);
        setIsExpanded(true);
        await refreshState();
      }
    },
    [clipContext, readOnly, effect.id, addMask, refreshState]
  );

  const handleDeleteMask = useCallback(
    async (maskId: MaskId) => {
      if (readOnly) return;
      const success = await removeMask({ effectId: effect.id, maskId });
      if (success) {
        if (selectedMaskId === maskId) setSelectedMaskId(null);
        await refreshState();
      }
    },
    [readOnly, effect.id, removeMask, selectedMaskId, refreshState]
  );

  const handleToggleEnabled = useCallback(
    async (maskId: MaskId, enabled: boolean) => {
      if (readOnly) return;
      await updateMask({ effectId: effect.id, maskId, enabled });
      await refreshState();
    },
    [readOnly, effect.id, updateMask, refreshState]
  );

  const handlePropertyChange = useCallback(
    async (updatedMask: Mask) => {
      if (readOnly) return;
      await updateMask({
        effectId: effect.id,
        maskId: updatedMask.id,
        shape: updatedMask.shape,
        feather: updatedMask.feather,
        opacity: updatedMask.opacity,
        expansion: updatedMask.expansion,
        inverted: updatedMask.inverted,
        blendMode: updatedMask.blendMode,
      });
      await refreshState();
    },
    [readOnly, effect.id, updateMask, refreshState]
  );

  const handleToggleLocked = useCallback(
    async (maskId: MaskId, locked: boolean) => {
      if (readOnly) return;
      await updateMask({ effectId: effect.id, maskId, locked });
      await refreshState();
    },
    [readOnly, effect.id, updateMask, refreshState]
  );

  return (
    <div className="border-t border-editor-border mt-2 pt-2">
      {/* Header */}
      <button
        type="button"
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex items-center gap-1.5 w-full text-left text-xs font-medium text-editor-text-muted hover:text-editor-text transition-colors"
        aria-expanded={isExpanded}
        aria-label="Toggle power windows section"
      >
        {isExpanded ? (
          <ChevronDown className="w-3.5 h-3.5" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5" />
        )}
        Power Windows
        {masks.length > 0 && (
          <span className="ml-1 px-1.5 py-0.5 bg-primary-600/30 text-primary-400 rounded text-[10px]">
            {masks.length}
          </span>
        )}
      </button>

      {isExpanded && (
        <div className="mt-2 space-y-2">
          {/* Add Shape Buttons */}
          {!readOnly && clipContext && (
            <div className="flex items-center gap-1">
              <span className="text-[10px] text-editor-text-muted mr-1">Add:</span>
              {SHAPE_PRESETS.map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => handleAddMask(id)}
                  aria-label={`Add ${label} power window`}
                  className="p-1.5 rounded hover:bg-editor-hover text-editor-text-muted hover:text-editor-text transition-colors"
                  title={label}
                >
                  <Icon className="w-3.5 h-3.5" />
                </button>
              ))}
            </div>
          )}

          {/* Mask List */}
          {masks.length > 0 ? (
            <MaskList
              masks={masks}
              selectedId={selectedMaskId}
              onSelect={setSelectedMaskId}
              onDelete={readOnly ? undefined : handleDeleteMask}
              onToggleEnabled={readOnly ? undefined : handleToggleEnabled}
              onToggleLocked={readOnly ? undefined : handleToggleLocked}
              disabled={readOnly}
            />
          ) : (
            <p className="text-[11px] text-editor-text-muted text-center py-2">
              No power windows. Add a shape to apply the effect selectively.
            </p>
          )}

          {/* Property Panel for Selected Mask */}
          {selectedMask && (
            <MaskPropertyPanel
              mask={selectedMask}
              onChange={handlePropertyChange}
              disabled={readOnly}
            />
          )}
        </div>
      )}
    </div>
  );
});

export default PowerWindowSection;
