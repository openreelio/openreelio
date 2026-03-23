/**
 * RemoveAttributesDialog Component
 *
 * Modal dialog for selectively removing effects and resetting
 * clip attributes to their defaults.
 *
 * Mirrors PasteAttributesDialog — shows current effects and attribute
 * categories with checkboxes for what to remove/reset.
 */

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';

// =============================================================================
// Types
// =============================================================================

export interface RemoveAttributesResult {
  effectIds: string[];
  resetTransform: boolean;
  resetOpacity: boolean;
  resetBlendMode: boolean;
  resetSpeed: boolean;
  resetAudio: boolean;
}

export interface ClipEffectEntry {
  id: string;
  label: string;
}

export interface RemoveAttributesDialogProps {
  /** Whether the dialog is open */
  isOpen: boolean;
  /** Effects currently on the clip */
  clipEffects: ClipEffectEntry[];
  /** Callback when confirmed with selection */
  onConfirm: (result: RemoveAttributesResult) => void;
  /** Callback when cancelled */
  onCancel: () => void;
}

// =============================================================================
// Component
// =============================================================================

export function RemoveAttributesDialog({
  isOpen,
  clipEffects,
  onConfirm,
  onCancel,
}: RemoveAttributesDialogProps): React.JSX.Element | null {
  const dialogId = useId();
  const overlayRef = useRef<HTMLDivElement>(null);

  const [selectedEffectIds, setSelectedEffectIds] = useState<Set<string>>(new Set());
  const [resetTransform, setResetTransform] = useState(false);
  const [resetOpacity, setResetOpacity] = useState(false);
  const [resetBlendMode, setResetBlendMode] = useState(false);
  const [resetSpeed, setResetSpeed] = useState(false);
  const [resetAudio, setResetAudio] = useState(false);

  const hasSelection =
    selectedEffectIds.size > 0 ||
    resetTransform || resetOpacity || resetBlendMode || resetSpeed || resetAudio;
  const clipEffectIdsKey = clipEffects.map((effect) => effect.id).join('|');

  const handleToggleEffect = useCallback((id: string) => {
    setSelectedEffectIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleSelectAll = useCallback(() => {
    setSelectedEffectIds(new Set(clipEffects.map((e) => e.id)));
    setResetTransform(true);
    setResetOpacity(true);
    setResetBlendMode(true);
    setResetSpeed(true);
    setResetAudio(true);
  }, [clipEffects]);

  const handleSelectNone = useCallback(() => {
    setSelectedEffectIds(new Set());
    setResetTransform(false);
    setResetOpacity(false);
    setResetBlendMode(false);
    setResetSpeed(false);
    setResetAudio(false);
  }, []);

  const handleConfirm = useCallback(() => {
    onConfirm({
      effectIds: Array.from(selectedEffectIds),
      resetTransform,
      resetOpacity,
      resetBlendMode,
      resetSpeed,
      resetAudio,
    });
  }, [selectedEffectIds, resetTransform, resetOpacity, resetBlendMode, resetSpeed, resetAudio, onConfirm]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      }
      if (e.key === 'Enter' && hasSelection) {
        e.preventDefault();
        handleConfirm();
      }
    },
    [onCancel, handleConfirm, hasSelection],
  );

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    setSelectedEffectIds(new Set());
    setResetTransform(false);
    setResetOpacity(false);
    setResetBlendMode(false);
    setResetSpeed(false);
    setResetAudio(false);
    overlayRef.current?.focus();
  }, [isOpen, clipEffectIdsKey]);

  if (!isOpen) return null;

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 outline-none"
      onClick={onCancel}
      onKeyDown={handleKeyDown}
      role="dialog"
      aria-modal="true"
      aria-labelledby={`${dialogId}-title`}
      tabIndex={-1}
    >
      <div
        className="w-80 max-h-[70vh] rounded-lg bg-slate-800 border border-slate-600 shadow-xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-4 py-3 border-b border-slate-700">
          <h2 id={`${dialogId}-title`} className="text-sm font-semibold text-slate-100">
            Remove Attributes
          </h2>
          <div className="mt-1 flex gap-2">
            <button
              className="text-xs text-blue-400 hover:text-blue-300"
              onClick={handleSelectAll}
            >
              Select All
            </button>
            <button
              className="text-xs text-slate-400 hover:text-slate-300"
              onClick={handleSelectNone}
            >
              Select None
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-4 py-2 space-y-3">
          {/* Effects section */}
          {clipEffects.length > 0 && (
            <div>
              <h3 className="text-xs font-medium text-slate-400 mb-1.5">Effects</h3>
              <div className="space-y-1">
                {clipEffects.map((eff) => (
                  <label key={eff.id} className="flex items-center gap-2 text-sm text-slate-200 cursor-pointer hover:bg-slate-700/50 px-1 py-0.5 rounded">
                    <input
                      type="checkbox"
                      checked={selectedEffectIds.has(eff.id)}
                      onChange={() => handleToggleEffect(eff.id)}
                      className="rounded border-slate-500 bg-slate-700 text-red-500"
                    />
                    {eff.label}
                  </label>
                ))}
              </div>
            </div>
          )}

          {/* Attributes section */}
          <div>
            <h3 className="text-xs font-medium text-slate-400 mb-1.5">Reset to Default</h3>
            <div className="space-y-1">
              {[
                { label: 'Transform', checked: resetTransform, onChange: setResetTransform },
                { label: 'Opacity', checked: resetOpacity, onChange: setResetOpacity },
                { label: 'Blend Mode', checked: resetBlendMode, onChange: setResetBlendMode },
                { label: 'Speed', checked: resetSpeed, onChange: setResetSpeed },
                { label: 'Audio Settings', checked: resetAudio, onChange: setResetAudio },
              ].map((attr) => (
                <label key={attr.label} className="flex items-center gap-2 text-sm text-slate-200 cursor-pointer hover:bg-slate-700/50 px-1 py-0.5 rounded">
                  <input
                    type="checkbox"
                    checked={attr.checked}
                    onChange={(e) => attr.onChange(e.target.checked)}
                    className="rounded border-slate-500 bg-slate-700 text-red-500"
                  />
                  {attr.label}
                </label>
              ))}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-slate-700 flex justify-end gap-2">
          <button
            className="px-3 py-1.5 text-sm text-slate-300 hover:text-slate-100 rounded border border-slate-600 hover:bg-slate-700"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            className="px-3 py-1.5 text-sm text-white bg-red-600 hover:bg-red-700 rounded disabled:opacity-40 disabled:cursor-not-allowed"
            onClick={handleConfirm}
            disabled={!hasSelection}
          >
            Remove
          </button>
        </div>
      </div>
    </div>
  );
}
