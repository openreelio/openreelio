/**
 * PasteAttributesDialog Component
 *
 * Modal dialog for selectively pasting effects and clip attributes
 * from the effects clipboard to target clips.
 *
 * Shows checkboxes for each copied effect and attribute category.
 * User selects which items to paste, then confirms.
 */

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import type { AttributeSelection, CopiedClipData } from '@/types';

// =============================================================================
// Types
// =============================================================================

export interface PasteAttributesDialogProps {
  /** Whether the dialog is open */
  isOpen: boolean;
  /** Copied data from clipboard */
  clipboardData: CopiedClipData | null;
  /** Callback when confirmed with selection */
  onConfirm: (selection: AttributeSelection) => void;
  /** Callback when cancelled */
  onCancel: () => void;
}

interface EffectEntry {
  index: number;
  label: string;
}

// =============================================================================
// Helpers
// =============================================================================

function formatEffectType(effectType: unknown): string {
  if (typeof effectType === 'object' && effectType !== null && 'custom' in effectType) {
    const customType = (effectType as { custom?: unknown }).custom;
    if (typeof customType === 'string' && customType.trim().length > 0) {
      return customType.trim();
    }
  }

  if (typeof effectType !== 'string') {
    return 'Unknown';
  }

  return effectType.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// =============================================================================
// Component
// =============================================================================

export function PasteAttributesDialog({
  isOpen,
  clipboardData,
  onConfirm,
  onCancel,
}: PasteAttributesDialogProps): React.JSX.Element | null {
  const dialogId = useId();
  const overlayRef = useRef<HTMLDivElement>(null);

  const [selectedEffects, setSelectedEffects] = useState<Set<number>>(new Set());
  const [transform, setTransform] = useState(false);
  const [opacity, setOpacity] = useState(false);
  const [blendMode, setBlendMode] = useState(false);
  const [speed, setSpeed] = useState(false);
  const [audioSettings, setAudioSettings] = useState(false);

  const effects = useMemo<EffectEntry[]>(() => {
    if (!clipboardData) return [];
    return clipboardData.effects.map((eff, idx) => ({
      index: idx,
      label: formatEffectType(eff.effectType),
    }));
  }, [clipboardData]);

  const hasSelection =
    selectedEffects.size > 0 || transform || opacity || blendMode || speed || audioSettings;

  const handleToggleEffect = useCallback((idx: number) => {
    setSelectedEffects((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  }, []);

  const handleSelectAll = useCallback(() => {
    setSelectedEffects(new Set(effects.map((e) => e.index)));
    setTransform(true);
    setOpacity(true);
    setBlendMode(true);
    setSpeed(true);
    setAudioSettings(true);
  }, [effects]);

  const handleSelectNone = useCallback(() => {
    setSelectedEffects(new Set());
    setTransform(false);
    setOpacity(false);
    setBlendMode(false);
    setSpeed(false);
    setAudioSettings(false);
  }, []);

  const handleConfirm = useCallback(() => {
    const selection: AttributeSelection = {
      effectIndices: Array.from(selectedEffects).sort((a, b) => a - b),
      transform,
      opacity,
      blendMode,
      speed,
      audioSettings,
    };
    onConfirm(selection);
  }, [selectedEffects, transform, opacity, blendMode, speed, audioSettings, onConfirm]);

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

    setSelectedEffects(new Set());
    setTransform(false);
    setOpacity(false);
    setBlendMode(false);
    setSpeed(false);
    setAudioSettings(false);
    overlayRef.current?.focus();
  }, [isOpen, clipboardData?.sourceClipId]);

  if (!isOpen || !clipboardData) return null;

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
            Paste Attributes
          </h2>
          <div className="mt-1 flex gap-2">
            <button className="text-xs text-blue-400 hover:text-blue-300" onClick={handleSelectAll}>
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
          {effects.length > 0 && (
            <div>
              <h3 className="text-xs font-medium text-slate-400 mb-1.5">Effects</h3>
              <div className="space-y-1">
                {effects.map((eff) => (
                  <label
                    key={eff.index}
                    className="flex items-center gap-2 text-sm text-slate-200 cursor-pointer hover:bg-slate-700/50 px-1 py-0.5 rounded"
                  >
                    <input
                      type="checkbox"
                      checked={selectedEffects.has(eff.index)}
                      onChange={() => handleToggleEffect(eff.index)}
                      className="rounded border-slate-500 bg-slate-700 text-blue-500"
                    />
                    {eff.label}
                  </label>
                ))}
              </div>
            </div>
          )}

          {/* Attributes section */}
          <div>
            <h3 className="text-xs font-medium text-slate-400 mb-1.5">Attributes</h3>
            <div className="space-y-1">
              {[
                { label: 'Transform', checked: transform, onChange: setTransform },
                { label: 'Opacity', checked: opacity, onChange: setOpacity },
                { label: 'Blend Mode', checked: blendMode, onChange: setBlendMode },
                { label: 'Speed', checked: speed, onChange: setSpeed },
                { label: 'Audio Settings', checked: audioSettings, onChange: setAudioSettings },
              ].map((attr) => (
                <label
                  key={attr.label}
                  className="flex items-center gap-2 text-sm text-slate-200 cursor-pointer hover:bg-slate-700/50 px-1 py-0.5 rounded"
                >
                  <input
                    type="checkbox"
                    checked={attr.checked}
                    onChange={(e) => attr.onChange(e.target.checked)}
                    className="rounded border-slate-500 bg-slate-700 text-blue-500"
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
            className="px-3 py-1.5 text-sm text-white bg-blue-600 hover:bg-blue-700 rounded disabled:opacity-40 disabled:cursor-not-allowed"
            onClick={handleConfirm}
            disabled={!hasSelection}
          >
            Paste
          </button>
        </div>
      </div>
    </div>
  );
}
