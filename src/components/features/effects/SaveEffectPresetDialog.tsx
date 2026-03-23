/**
 * SaveEffectPresetDialog Component
 *
 * Modal dialog for saving the current effect's parameters as a reusable preset.
 * User provides a name and optional description, then confirms to save.
 */

import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Save } from 'lucide-react';
import type { Effect } from '@/types';
import { EFFECT_TYPE_LABELS } from '@/types';

// =============================================================================
// Types
// =============================================================================

export interface SaveEffectPresetDialogProps {
  /** Whether the dialog is open */
  isOpen: boolean;
  /** The effect to save as preset */
  effect: Effect | null;
  /** Whether a save request is currently in progress */
  saving?: boolean;
  /** Inline error message */
  error?: string | null;
  /** Callback when confirmed with name and description */
  onConfirm: (name: string, description: string | undefined) => void;
  /** Callback when cancelled */
  onCancel: () => void;
}

// =============================================================================
// Helpers
// =============================================================================

function getEffectLabel(effectType: Effect['effectType']): string {
  if (typeof effectType === 'object' && 'custom' in effectType) {
    return effectType.custom;
  }
  return EFFECT_TYPE_LABELS[effectType] ?? String(effectType);
}

// =============================================================================
// Component
// =============================================================================

export function SaveEffectPresetDialog({
  isOpen,
  effect,
  saving = false,
  error = null,
  onConfirm,
  onCancel,
}: SaveEffectPresetDialogProps): React.JSX.Element | null {
  const dialogId = useId();
  const overlayRef = useRef<HTMLDivElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  // Focus name input when dialog opens
  useEffect(() => {
    if (!isOpen || !nameInputRef.current) return;

    // Pre-fill with effect type label on first open
    if (effect && !name) {
      setName(getEffectLabel(effect.effectType));
    }
    // Use requestAnimationFrame to ensure focus after render
    const rafId = requestAnimationFrame(() => nameInputRef.current?.select());
    return () => cancelAnimationFrame(rafId);
  }, [isOpen, effect]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reset state when dialog closes
  useEffect(() => {
    if (!isOpen) {
      setName('');
      setDescription('');
    }
  }, [isOpen]);

  const canConfirm = name.trim().length > 0 && !saving;

  const handleConfirm = useCallback(() => {
    if (!canConfirm) return;
    onConfirm(name.trim(), description.trim() || undefined);
  }, [canConfirm, name, description, onConfirm]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCancel();
      } else if (e.key === 'Enter' && canConfirm) {
        e.stopPropagation();
        handleConfirm();
      }
    },
    [onCancel, handleConfirm, canConfirm],
  );

  const handleOverlayClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === overlayRef.current) {
        onCancel();
      }
    },
    [onCancel],
  );

  if (!isOpen || !effect) return null;

  const effectLabel = getEffectLabel(effect.effectType);
  const paramCount = Object.keys(effect.params ?? {}).length;

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 outline-none"
      onClick={handleOverlayClick}
      onKeyDown={handleKeyDown}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-labelledby={`${dialogId}-title`}
      data-testid="save-effect-preset-dialog"
    >
      <div className="w-80 rounded-lg bg-slate-800 border border-slate-600 shadow-xl flex flex-col">
        {/* Header */}
        <div className="flex items-center gap-2 p-4 border-b border-slate-700">
          <Save className="w-4 h-4 text-blue-400" />
          <h2 id={`${dialogId}-title`} className="text-sm font-semibold text-white">
            Save Effect Preset
          </h2>
        </div>

        {/* Content */}
        <div className="p-4 space-y-3">
          {/* Effect info */}
          <p className="text-xs text-slate-400">
            Save <span className="text-slate-200">{effectLabel}</span> with {paramCount} parameter
            {paramCount !== 1 ? 's' : ''} as a reusable preset.
          </p>

          {/* Name input */}
          <div>
            <label htmlFor={`${dialogId}-name`} className="block text-xs text-slate-400 mb-1">
              Preset Name
            </label>
            <input
              ref={nameInputRef}
              id={`${dialogId}-name`}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Enter preset name..."
              maxLength={100}
              className="w-full px-3 py-1.5 text-sm bg-slate-900 border border-slate-600 rounded text-white placeholder-slate-500 focus:outline-none focus:border-blue-500"
              data-testid="preset-name-input"
            />
          </div>

          {/* Description input */}
          <div>
            <label htmlFor={`${dialogId}-desc`} className="block text-xs text-slate-400 mb-1">
              Description (optional)
            </label>
            <input
              id={`${dialogId}-desc`}
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Brief description..."
              maxLength={200}
              className="w-full px-3 py-1.5 text-sm bg-slate-900 border border-slate-600 rounded text-white placeholder-slate-500 focus:outline-none focus:border-blue-500"
              data-testid="preset-description-input"
            />
          </div>

          {error && (
            <p className="text-xs text-red-400" data-testid="preset-error-message">
              {error}
            </p>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 p-4 border-t border-slate-700">
          <button
            type="button"
            onClick={onCancel}
            disabled={saving}
            className="px-3 py-1.5 text-xs rounded border border-slate-600 text-slate-300 hover:bg-slate-700 transition-colors"
            data-testid="preset-cancel-btn"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={!canConfirm}
            className="px-3 py-1.5 text-xs rounded bg-blue-600 hover:bg-blue-700 text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            data-testid="preset-save-btn"
          >
            {saving ? 'Saving...' : 'Save Preset'}
          </button>
        </div>
      </div>
    </div>
  );
}
