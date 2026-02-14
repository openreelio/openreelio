interface UnsavedChangesDialogProps {
  isOpen: boolean;
  isSaving: boolean;
  onCancel: () => void;
  onDiscard: () => void;
  onSave: () => void;
}

export function UnsavedChangesDialog({
  isOpen,
  isSaving,
  onCancel,
  onDiscard,
  onSave,
}: UnsavedChangesDialogProps): JSX.Element | null {
  if (!isOpen) {
    return null;
  }

  return (
    <div
      data-testid="unsaved-changes-dialog"
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
    >
      <div className="absolute inset-0 bg-surface-overlay backdrop-blur-sm" onClick={onCancel} />

      <div className="relative z-10 w-full max-w-md rounded-lg border border-border-default bg-surface-elevated p-6 shadow-xl">
        <h2 className="mb-2 text-lg font-semibold text-text-primary">Unsaved Changes</h2>
        <p className="mb-6 text-text-secondary">
          You have unsaved changes. Do you want to save before closing?
        </p>

        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end sm:gap-3">
          <button
            type="button"
            className="rounded bg-surface-active px-4 py-2 text-sm font-medium text-text-secondary transition-colors hover:bg-surface-highest"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            className="rounded bg-status-error px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-700"
            onClick={onDiscard}
          >
            Don&apos;t Save
          </button>
          <button
            type="button"
            className="flex items-center justify-center gap-2 rounded bg-primary-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-50"
            onClick={onSave}
            disabled={isSaving}
          >
            {isSaving && (
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
            )}
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
