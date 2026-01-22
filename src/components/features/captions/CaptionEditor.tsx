/**
 * CaptionEditor Component
 *
 * Modal dialog for editing caption text, timing, and speaker information.
 * Supports keyboard shortcuts and validation.
 */

import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { X, Trash2, Clock, User, Type, AlertTriangle } from 'lucide-react';
import type { Caption, CaptionStyle } from '@/types';

// =============================================================================
// Types
// =============================================================================

export interface CaptionEditorProps {
  /** Caption data to edit */
  caption: Caption;
  /** Whether the modal is open */
  isOpen: boolean;
  /** Callback when caption is saved */
  onSave: (caption: Caption) => void | Promise<void>;
  /** Callback when editing is cancelled */
  onCancel: () => void;
  /** Optional callback for deleting the caption */
  onDelete?: (captionId: string) => void | Promise<void>;
  /** Default caption style (for preview) */
  defaultStyle?: CaptionStyle;
  /** Maximum recommended text length (shows warning if exceeded) */
  maxRecommendedLength?: number;
  /** Whether the editor is in read-only mode */
  readOnly?: boolean;
}

interface FormState {
  text: string;
  speaker: string;
  startSec: string;
  endSec: string;
}

interface ValidationErrors {
  text?: string;
  startSec?: string;
  endSec?: string;
  timeRange?: string;
}

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_MAX_RECOMMENDED_LENGTH = 80;

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Format seconds to display string
 */
function formatTimeDisplay(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return '0';
  return seconds.toFixed(1);
}

/**
 * Parse time input string to seconds
 */
function parseTimeInput(value: string): number | null {
  const num = parseFloat(value);
  if (isNaN(num)) return null;
  return num;
}

/**
 * Validate form data and return errors
 */
function validateForm(formState: FormState): ValidationErrors {
  const errors: ValidationErrors = {};

  // Validate text
  if (!formState.text.trim()) {
    errors.text = 'Caption text is required';
  }

  // Validate start time
  const startSec = parseTimeInput(formState.startSec);
  if (startSec === null) {
    errors.startSec = 'Invalid start time';
  } else if (startSec < 0) {
    errors.startSec = 'Time must be non-negative';
  }

  // Validate end time
  const endSec = parseTimeInput(formState.endSec);
  if (endSec === null) {
    errors.endSec = 'Invalid end time';
  } else if (endSec < 0) {
    errors.endSec = 'Time must be non-negative';
  }

  // Validate time range
  if (startSec !== null && endSec !== null && startSec >= endSec) {
    errors.timeRange = 'End time must be after start time';
  }

  return errors;
}

// =============================================================================
// Component
// =============================================================================

export const CaptionEditor: React.FC<CaptionEditorProps> = ({
  caption,
  isOpen,
  onSave,
  onCancel,
  onDelete,
  maxRecommendedLength = DEFAULT_MAX_RECOMMENDED_LENGTH,
  readOnly = false,
}) => {
  // Form state
  const [formState, setFormState] = useState<FormState>({
    text: caption.text,
    speaker: caption.speaker ?? '',
    startSec: formatTimeDisplay(caption.startSec),
    endSec: formatTimeDisplay(caption.endSec),
  });

  // UI state
  const [errors, setErrors] = useState<ValidationErrors>({});
  const [isSaving, setIsSaving] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  // Refs
  const textInputRef = useRef<HTMLTextAreaElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const titleId = useRef(`caption-editor-title-${caption.id}`).current;

  const resetForm = useCallback(() => {
    setFormState({
      text: caption.text,
      speaker: caption.speaker ?? '',
      startSec: formatTimeDisplay(caption.startSec),
      endSec: formatTimeDisplay(caption.endSec),
    });
    setErrors({});
    setShowDeleteConfirm(false);
  }, [caption]);

  // Reset form when caption changes
  useEffect(() => {
    if (isOpen) {
      resetForm();
    }
  }, [isOpen, resetForm]);

  // Focus text input when modal opens
  useEffect(() => {
    if (isOpen && textInputRef.current) {
      textInputRef.current.focus();
    }
  }, [isOpen]);

  // Calculate duration
  const duration = useMemo(() => {
    const start = parseTimeInput(formState.startSec);
    const end = parseTimeInput(formState.endSec);
    if (start !== null && end !== null && end > start) {
      return (end - start).toFixed(1);
    }
    return '0';
  }, [formState.startSec, formState.endSec]);

  // Character count
  const charCount = formState.text.length;
  const exceedsRecommended = charCount > maxRecommendedLength;

  // Check if form is valid for saving
  const isFormValid = useMemo(() => {
    const validationErrors = validateForm(formState);
    return Object.keys(validationErrors).length === 0;
  }, [formState]);

  // Handle form field changes
  const handleTextChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setFormState((prev) => ({ ...prev, text: e.target.value }));
    setErrors((prev) => ({ ...prev, text: undefined }));
  }, []);

  const handleSpeakerChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setFormState((prev) => ({ ...prev, speaker: e.target.value }));
  }, []);

  const handleStartSecChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setFormState((prev) => ({ ...prev, startSec: e.target.value }));
    setErrors((prev) => ({ ...prev, startSec: undefined, timeRange: undefined }));
  }, []);

  const handleEndSecChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setFormState((prev) => ({ ...prev, endSec: e.target.value }));
    setErrors((prev) => ({ ...prev, endSec: undefined, timeRange: undefined }));
  }, []);

  // Handle save
  const handleSave = useCallback(async () => {
    const validationErrors = validateForm(formState);
    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors);
      return;
    }

    setIsSaving(true);
    try {
      const startSec = parseTimeInput(formState.startSec) ?? caption.startSec;
      const endSec = parseTimeInput(formState.endSec) ?? caption.endSec;

      const updatedCaption: Caption = {
        ...caption,
        text: formState.text.trim(),
        speaker: formState.speaker.trim() || undefined,
        startSec,
        endSec,
      };

      await onSave(updatedCaption);
    } finally {
      setIsSaving(false);
    }
  }, [formState, caption, onSave]);

  // Handle delete
  const handleDelete = useCallback(async () => {
    if (!onDelete) return;
    await onDelete(caption.id);
    setShowDeleteConfirm(false);
  }, [caption.id, onDelete]);

  // Handle keyboard events
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        resetForm();
        onCancel();
      } else if (e.key === 'Enter' && e.ctrlKey && !readOnly && isFormValid) {
        e.preventDefault();
        handleSave();
      }
    },
    [onCancel, readOnly, isFormValid, handleSave, resetForm],
  );

  // Handle backdrop click
  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) {
        resetForm();
        onCancel();
      }
    },
    [onCancel, resetForm],
  );

  // Don't render if not open
  if (!isOpen) {
    return null;
  }

  return (
    <div
      data-testid="caption-editor-backdrop"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={handleBackdropClick}
      onKeyDown={handleKeyDown}
    >
      <div
        ref={modalRef}
        data-testid="caption-editor-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="bg-neutral-900 rounded-lg shadow-xl border border-neutral-700 w-full max-w-lg mx-4"
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-neutral-700">
          <h2 id={titleId} className="text-lg font-semibold text-white flex items-center gap-2">
            <Type className="w-5 h-5 text-teal-400" />
            Edit Caption
          </h2>
          <button
            type="button"
            onClick={() => {
              resetForm();
              onCancel();
            }}
            className="p-1 rounded hover:bg-neutral-700 text-neutral-400 hover:text-white transition-colors"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="p-4 space-y-4">
          {/* Text Input */}
          <div>
            <label
              htmlFor="caption-text"
              className="block text-sm font-medium text-neutral-300 mb-1"
            >
              Caption Text
            </label>
            <textarea
              ref={textInputRef}
              id="caption-text"
              aria-label="Caption Text"
              autoFocus
              value={formState.text}
              onChange={handleTextChange}
              disabled={readOnly}
              rows={3}
              className={`w-full px-3 py-2 rounded bg-neutral-800 border text-white placeholder-neutral-500
                focus:outline-none focus:ring-2 focus:ring-teal-500 disabled:opacity-50 disabled:cursor-not-allowed
                ${errors.text ? 'border-red-500' : 'border-neutral-600'}`}
              placeholder="Enter caption text..."
            />
            <div className="flex items-center justify-between mt-1">
              <span
                className={`text-xs ${exceedsRecommended ? 'text-yellow-400' : 'text-neutral-500'}`}
              >
                {charCount} characters
                {exceedsRecommended && ' (exceeds recommended length)'}
              </span>
              {errors.text && <span className="text-xs text-red-400">{errors.text}</span>}
            </div>
          </div>

          {/* Speaker Input */}
          <div>
            <label
              htmlFor="caption-speaker"
              className="block text-sm font-medium text-neutral-300 mb-1 flex items-center gap-1"
            >
              <User className="w-4 h-4" />
              Speaker
            </label>
            <input
              id="caption-speaker"
              aria-label="Speaker"
              type="text"
              value={formState.speaker}
              onChange={handleSpeakerChange}
              disabled={readOnly}
              className="w-full px-3 py-2 rounded bg-neutral-800 border border-neutral-600 text-white placeholder-neutral-500
                focus:outline-none focus:ring-2 focus:ring-teal-500 disabled:opacity-50 disabled:cursor-not-allowed"
              placeholder="Optional speaker name..."
            />
          </div>

          {/* Time Inputs */}
          <div className="grid grid-cols-3 gap-4">
            {/* Start Time */}
            <div>
              <label
                htmlFor="caption-start"
                className="block text-sm font-medium text-neutral-300 mb-1 flex items-center gap-1"
              >
                <Clock className="w-4 h-4" />
                Start (s)
              </label>
              <input
                id="caption-start"
                aria-label="Start time"
                type="number"
                role="spinbutton"
                step="0.1"
                min="0"
                value={formState.startSec}
                onChange={handleStartSecChange}
                disabled={readOnly}
                className={`w-full px-3 py-2 rounded bg-neutral-800 border text-white
                  focus:outline-none focus:ring-2 focus:ring-teal-500 disabled:opacity-50 disabled:cursor-not-allowed
                  ${errors.startSec ? 'border-red-500' : 'border-neutral-600'}`}
              />
              {errors.startSec && (
                <span className="text-xs text-red-400 mt-1 block">{errors.startSec}</span>
              )}
            </div>

            {/* End Time */}
            <div>
              <label
                htmlFor="caption-end"
                className="block text-sm font-medium text-neutral-300 mb-1 flex items-center gap-1"
              >
                <Clock className="w-4 h-4" />
                End (s)
              </label>
              <input
                id="caption-end"
                aria-label="End time"
                type="number"
                role="spinbutton"
                step="0.1"
                min="0"
                value={formState.endSec}
                onChange={handleEndSecChange}
                disabled={readOnly}
                className={`w-full px-3 py-2 rounded bg-neutral-800 border text-white
                  focus:outline-none focus:ring-2 focus:ring-teal-500 disabled:opacity-50 disabled:cursor-not-allowed
                  ${errors.endSec ? 'border-red-500' : 'border-neutral-600'}`}
              />
              {errors.endSec && (
                <span className="text-xs text-red-400 mt-1 block">{errors.endSec}</span>
              )}
            </div>

            {/* Duration (read-only) */}
            <div>
              <label className="block text-sm font-medium text-neutral-300 mb-1">Duration</label>
              <div className="px-3 py-2 rounded bg-neutral-800/50 border border-neutral-700 text-neutral-400">
                {duration}s
              </div>
            </div>
          </div>

          {/* Time Range Error */}
          {errors.timeRange && (
            <div className="flex items-center gap-2 text-red-400 text-sm">
              <AlertTriangle className="w-4 h-4" />
              {errors.timeRange}
            </div>
          )}

          {/* Delete Confirmation */}
          {showDeleteConfirm && (
            <div className="p-3 rounded bg-red-900/30 border border-red-700">
              <p className="text-sm text-red-200 mb-3">
                Are you sure you want to delete this caption? This action cannot be undone.
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={handleDelete}
                  className="px-3 py-1.5 text-sm rounded bg-red-600 text-white hover:bg-red-500 transition-colors"
                >
                  Confirm Delete
                </button>
                <button
                  type="button"
                  onClick={() => setShowDeleteConfirm(false)}
                  className="px-3 py-1.5 text-sm rounded border border-neutral-600 text-neutral-300 hover:bg-neutral-800 transition-colors"
                >
                  No, Keep It
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between p-4 border-t border-neutral-700">
          <div>
            {onDelete && !showDeleteConfirm && (
              <button
                type="button"
                onClick={() => setShowDeleteConfirm(true)}
                disabled={readOnly}
                className="flex items-center gap-2 px-3 py-2 text-sm rounded border border-red-700 text-red-400
                  hover:bg-red-900/30 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                <Trash2 className="w-4 h-4" />
                Delete
              </button>
            )}
          </div>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => {
                resetForm();
                onCancel();
              }}
              className="px-4 py-2 text-sm rounded border border-neutral-600 text-neutral-300
                hover:bg-neutral-800 transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={readOnly || !formState.text.trim() || isSaving}
              className="px-4 py-2 text-sm rounded bg-teal-600 text-white hover:bg-teal-500
                disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
            >
              {isSaving ? (
                <>
                  <span className="animate-spin">⏳</span>
                  Saving...
                </>
              ) : (
                'Save'
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default CaptionEditor;
