/**
 * TranscriptionDialog Component
 *
 * Modal dialog for configuring and starting transcription.
 * Allows users to select language, model, and other options.
 */

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { X, MessageSquare, AlertTriangle, Loader2 } from 'lucide-react';
import type { AssetData } from '@/components/explorer/AssetItem';

// =============================================================================
// Types
// =============================================================================

export interface TranscriptionOptions {
  /** Language code (e.g., 'en', 'ko', 'auto') */
  language: string;
  /** Model to use for transcription */
  model?: string;
  /** Whether to add transcription to timeline as captions */
  addToTimeline: boolean;
  /** Whether to index for search */
  indexForSearch: boolean;
}

export interface TranscriptionDialogProps {
  /** Asset to transcribe */
  asset: AssetData;
  /** Whether the dialog is open */
  isOpen: boolean;
  /** Callback when transcription is confirmed */
  onConfirm: (options: TranscriptionOptions) => void;
  /** Callback when dialog is cancelled */
  onCancel: () => void;
  /** Available transcription models */
  availableModels?: string[];
  /** Whether transcription is being started */
  isProcessing?: boolean;
}

// =============================================================================
// Constants
// =============================================================================

const LANGUAGES = [
  { code: 'auto', name: 'Auto-detect' },
  { code: 'en', name: 'English' },
  { code: 'ko', name: 'Korean' },
  { code: 'ja', name: 'Japanese' },
  { code: 'zh', name: 'Chinese' },
  { code: 'es', name: 'Spanish' },
  { code: 'fr', name: 'French' },
  { code: 'de', name: 'German' },
  { code: 'pt', name: 'Portuguese' },
  { code: 'ru', name: 'Russian' },
  { code: 'ar', name: 'Arabic' },
];

const DEFAULT_MODELS = ['tiny', 'base', 'small', 'medium', 'large'];

/** Duration threshold (in seconds) to show warning */
const LONG_DURATION_THRESHOLD = 600; // 10 minutes

// =============================================================================
// Helper Functions
// =============================================================================

function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m ${secs}s`;
}

// =============================================================================
// Component
// =============================================================================

export const TranscriptionDialog: React.FC<TranscriptionDialogProps> = ({
  asset,
  isOpen,
  onConfirm,
  onCancel,
  availableModels = DEFAULT_MODELS,
  isProcessing = false,
}) => {
  // Form state
  const [language, setLanguage] = useState('en');
  const [model, setModel] = useState('base');
  const [addToTimeline, setAddToTimeline] = useState(false);
  const [indexForSearch, setIndexForSearch] = useState(true);

  // Refs
  const languageSelectRef = useRef<HTMLSelectElement>(null);
  const titleId = useRef(`transcription-dialog-title-${asset.id}`).current;

  // Reset form when dialog opens
  useEffect(() => {
    if (isOpen) {
      setLanguage('en');
      setModel(availableModels.includes('base') ? 'base' : availableModels[0] || 'base');
      setAddToTimeline(false);
      setIndexForSearch(true);
    }
  }, [isOpen, availableModels]);

  // Handle confirm
  const handleConfirm = useCallback(() => {
    onConfirm({
      language,
      model: availableModels.length > 0 ? model : undefined,
      addToTimeline,
      indexForSearch,
    });
  }, [language, model, addToTimeline, indexForSearch, availableModels, onConfirm]);

  // Handle keyboard
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      } else if (e.key === 'Enter' && !isProcessing) {
        e.preventDefault();
        handleConfirm();
      }
    },
    [onCancel, isProcessing, handleConfirm],
  );

  // Handle backdrop click
  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) {
        onCancel();
      }
    },
    [onCancel],
  );

  // Don't render if not open
  if (!isOpen) {
    return null;
  }

  const isLongDuration = (asset.duration ?? 0) > LONG_DURATION_THRESHOLD;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={handleBackdropClick}
      onKeyDown={handleKeyDown}
    >
      <div
        data-testid="transcription-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="bg-neutral-900 rounded-lg shadow-xl border border-neutral-700 w-full max-w-md mx-4"
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-neutral-700">
          <h2 id={titleId} className="text-lg font-semibold text-white flex items-center gap-2">
            <MessageSquare className="w-5 h-5 text-blue-400" />
            Transcribe Asset
          </h2>
          <button
            type="button"
            onClick={onCancel}
            className="p-1 rounded hover:bg-neutral-700 text-neutral-400 hover:text-white transition-colors"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="p-4 space-y-4">
          {/* Asset Info */}
          <div className="p-3 rounded bg-neutral-800 border border-neutral-700">
            <div className="text-sm font-medium text-white truncate">{asset.name}</div>
            {asset.duration !== undefined && (
              <div className="text-xs text-neutral-400 mt-1">
                Duration: {formatDuration(asset.duration)}
              </div>
            )}
          </div>

          {/* Long Duration Warning */}
          {isLongDuration && (
            <div className="flex items-center gap-2 p-3 rounded bg-yellow-900/30 border border-yellow-700/50 text-yellow-400 text-sm">
              <AlertTriangle className="w-4 h-4 flex-shrink-0" />
              <span>
                This file is {formatDuration(asset.duration ?? 0)} long. Transcription may take a
                while.
              </span>
            </div>
          )}

          {/* Language Selection */}
          <div>
            <label
              htmlFor="transcription-language"
              className="block text-sm font-medium text-neutral-300 mb-1"
            >
              Language
            </label>
            <select
              ref={languageSelectRef}
              autoFocus
              id="transcription-language"
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              disabled={isProcessing}
              className="w-full px-3 py-2 rounded bg-neutral-800 border border-neutral-600 text-white
                focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
            >
              {LANGUAGES.map((lang) => (
                <option key={lang.code} value={lang.code}>
                  {lang.name}
                </option>
              ))}
            </select>
          </div>

          {/* Model Selection (if multiple models available) */}
          {availableModels.length > 0 && (
            <div>
              <label
                htmlFor="transcription-model"
                className="block text-sm font-medium text-neutral-300 mb-1"
              >
                Model
              </label>
              <select
                id="transcription-model"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                disabled={isProcessing}
                className="w-full px-3 py-2 rounded bg-neutral-800 border border-neutral-600 text-white
                  focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
              >
                {availableModels.map((m) => (
                  <option key={m} value={m}>
                    {m.charAt(0).toUpperCase() + m.slice(1)}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-xs text-neutral-500">
                Larger models are more accurate but slower.
              </p>
            </div>
          )}

          {/* Options */}
          <div className="space-y-3">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={addToTimeline}
                onChange={(e) => setAddToTimeline(e.target.checked)}
                disabled={isProcessing}
                className="w-4 h-4 rounded border-neutral-600 bg-neutral-800 text-blue-500
                  focus:ring-2 focus:ring-blue-500 focus:ring-offset-0"
              />
              <span className="text-sm text-neutral-300">Add to timeline as captions</span>
            </label>

            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={indexForSearch}
                onChange={(e) => setIndexForSearch(e.target.checked)}
                disabled={isProcessing}
                className="w-4 h-4 rounded border-neutral-600 bg-neutral-800 text-blue-500
                  focus:ring-2 focus:ring-blue-500 focus:ring-offset-0"
              />
              <span className="text-sm text-neutral-300">Index for search</span>
            </label>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 p-4 border-t border-neutral-700">
          <button
            type="button"
            onClick={onCancel}
            disabled={isProcessing}
            className="px-4 py-2 text-sm rounded border border-neutral-600 text-neutral-300
              hover:bg-neutral-800 disabled:opacity-50 transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={isProcessing}
            className="px-4 py-2 text-sm rounded bg-blue-600 text-white hover:bg-blue-500
              disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
          >
            {isProcessing ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Starting...
              </>
            ) : (
              'Start Transcription'
            )}
          </button>
        </div>
      </div>
    </div>
  );
};

export default TranscriptionDialog;
