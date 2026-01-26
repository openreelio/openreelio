/**
 * ConfirmDialog Component
 *
 * Reusable confirmation dialog for destructive actions.
 */

import { useCallback, useId, useRef, useEffect, type KeyboardEvent } from 'react';

// =============================================================================
// Types
// =============================================================================

export type ConfirmDialogVariant = 'default' | 'danger' | 'warning';

export interface ConfirmDialogProps {
  /** Whether the dialog is open */
  isOpen: boolean;
  /** Dialog title */
  title: string;
  /** Dialog message */
  message: string;
  /** Callback when confirmed */
  onConfirm: () => void;
  /** Callback when cancelled */
  onCancel: () => void;
  /** Custom confirm button label */
  confirmLabel?: string;
  /** Custom cancel button label */
  cancelLabel?: string;
  /** Dialog variant for styling */
  variant?: ConfirmDialogVariant;
  /** Whether the dialog is in loading state */
  isLoading?: boolean;
  /** Whether clicking backdrop closes the dialog */
  closeOnBackdrop?: boolean;
}

// =============================================================================
// Constants
// =============================================================================

const VARIANT_CLASSES: Record<ConfirmDialogVariant, string> = {
  default: 'bg-primary-600 hover:bg-primary-700',
  danger: 'bg-red-600 hover:bg-red-700',
  warning: 'bg-yellow-600 hover:bg-yellow-700',
};

// =============================================================================
// Component
// =============================================================================

export function ConfirmDialog({
  isOpen,
  title,
  message,
  onConfirm,
  onCancel,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  variant = 'default',
  isLoading = false,
  closeOnBackdrop = true,
}: ConfirmDialogProps) {
  const titleId = useId();

  // ===========================================================================
  // Handlers
  // ===========================================================================

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onCancel();
      }
    },
    [onCancel]
  );

  const handleBackdropClick = useCallback(() => {
    if (closeOnBackdrop) {
      onCancel();
    }
  }, [closeOnBackdrop, onCancel]);

  const handleDialogClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
  }, []);

  // ===========================================================================
  // Refs
  // ===========================================================================

  const cancelButtonRef = useRef<HTMLButtonElement>(null);

  // ===========================================================================
  // Effects
  // ===========================================================================

  useEffect(() => {
    if (isOpen && cancelButtonRef.current) {
      // Focus the cancel button when dialog opens for better accessibility
      cancelButtonRef.current.focus();
    }
  }, [isOpen]);

  // ===========================================================================
  // Render
  // ===========================================================================

  if (!isOpen) {
    return null;
  }

  return (
    <div
      data-testid="confirm-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className="fixed inset-0 z-50 flex items-center justify-center"
      onKeyDown={handleKeyDown}
    >
      {/* Backdrop */}
      <div
        data-testid="dialog-backdrop"
        className="absolute inset-0 bg-surface-overlay backdrop-blur-sm"
        onClick={handleBackdropClick}
      />

      {/* Dialog Content */}
      <div
        className="relative z-10 w-[calc(100%-2rem)] max-w-md mx-4 bg-surface-elevated rounded-lg shadow-xl p-6 border border-border-default"
        onClick={handleDialogClick}
      >
        {/* Title */}
        <h2 id={titleId} className="text-lg font-semibold text-text-primary mb-2">
          {title}
        </h2>

        {/* Message */}
        <p className="text-text-secondary mb-6 break-words">{message}</p>

        {/* Actions */}
        <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 sm:gap-3">
          <button
            ref={cancelButtonRef}
            data-testid="cancel-button"
            type="button"
            className="px-4 py-2 text-sm font-medium text-text-secondary bg-surface-active rounded hover:bg-surface-highest transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={onCancel}
            disabled={isLoading}
          >
            {cancelLabel}
          </button>
          <button
            data-testid="confirm-button"
            type="button"
            className={`px-4 py-2 text-sm font-medium text-white rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 ${VARIANT_CLASSES[variant]}`}
            onClick={onConfirm}
            disabled={isLoading}
          >
            {isLoading && (
              <div
                data-testid="loading-spinner"
                className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"
              />
            )}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
