/**
 * Header Component
 *
 * Application header with branding, project info, menu bar, and toolbar.
 */

import { X, Save, FolderOpen, Download } from 'lucide-react';
import { UndoRedoButtons } from '@/components/ui';
import { useProjectStore } from '@/stores';
import { useCallback, useState } from 'react';

// =============================================================================
// Types
// =============================================================================

interface HeaderProps {
  /** Application title */
  title?: string;
  /** Version string */
  version?: string;
  /** Whether to show toolbar (undo/redo buttons) */
  showToolbar?: boolean;
  /** Export button click handler */
  onExport?: () => void;
}

// =============================================================================
// Component
// =============================================================================

export function Header({
  title = 'OpenReelio',
  version = '0.1.0',
  showToolbar = true,
  onExport,
}: HeaderProps) {
  const { meta, isDirty, closeProject, saveProject } = useProjectStore();
  const [isSaving, setIsSaving] = useState(false);
  const [showCloseConfirm, setShowCloseConfirm] = useState(false);

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    try {
      await saveProject();
    } catch (error) {
      console.error('Failed to save project:', error);
    } finally {
      setIsSaving(false);
    }
  }, [saveProject]);

  // Handle close button click - show confirmation if unsaved changes
  const handleCloseClick = useCallback(() => {
    if (isDirty) {
      setShowCloseConfirm(true);
    } else {
      closeProject();
    }
  }, [isDirty, closeProject]);

  // Save and close project
  const handleSaveAndClose = useCallback(async () => {
    setIsSaving(true);
    try {
      await saveProject();
      setShowCloseConfirm(false);
      closeProject();
    } catch (error) {
      console.error('Failed to save project:', error);
      // Keep dialog open on error so user can retry or discard
    } finally {
      setIsSaving(false);
    }
  }, [saveProject, closeProject]);

  // Discard changes and close project
  const handleDiscardAndClose = useCallback(() => {
    setShowCloseConfirm(false);
    closeProject();
  }, [closeProject]);

  // Cancel close action
  const handleCancelClose = useCallback(() => {
    setShowCloseConfirm(false);
  }, []);

  return (
    <div className="h-10 bg-editor-sidebar border-b border-editor-border flex items-center px-4">
      {/* Branding */}
      <h1 className="text-sm font-semibold text-primary-400">{title}</h1>
      <span className="ml-2 text-xs text-editor-text-muted">v{version}</span>

      {/* Separator */}
      {meta && (
        <>
          <div className="mx-3 h-4 w-px bg-editor-border" />

          {/* Project Info */}
          <div className="flex items-center gap-2">
            <FolderOpen className="w-4 h-4 text-editor-text-muted" />
            <span className="text-sm text-editor-text">{meta.name}</span>
            {isDirty && (
              <span className="text-xs text-yellow-500" title="Unsaved changes">
                *
              </span>
            )}
          </div>
        </>
      )}

      {/* Spacer */}
      <div className="flex-1" />

      {/* Toolbar */}
      {showToolbar && (
        <div className="flex items-center gap-2">
          <UndoRedoButtons />

          {/* Separator */}
          <div className="mx-2 h-4 w-px bg-editor-border" />

          {/* Save Button */}
          <button
            onClick={() => void handleSave()}
            disabled={!isDirty || isSaving}
            className="p-1.5 rounded hover:bg-editor-bg transition-colors text-editor-text-muted hover:text-editor-text disabled:opacity-50 disabled:cursor-not-allowed"
            title={isDirty ? 'Save project (Ctrl+S)' : 'No changes to save'}
          >
            <Save className="w-4 h-4" />
          </button>

          {/* Export Button */}
          {onExport && (
            <button
              onClick={onExport}
              className="p-1.5 rounded hover:bg-editor-bg transition-colors text-editor-text-muted hover:text-primary-400"
              title="Export video"
            >
              <Download className="w-4 h-4" />
            </button>
          )}

          {/* Separator */}
          <div className="mx-1 h-4 w-px bg-editor-border" />

          {/* Close Project Button */}
          <button
            onClick={handleCloseClick}
            className="p-1.5 rounded hover:bg-editor-bg transition-colors text-editor-text-muted hover:text-red-400"
            title="Close project"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Unsaved Changes Confirmation Dialog */}
      {showCloseConfirm && (
        <div
          data-testid="unsaved-changes-dialog"
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center"
        >
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/50"
            onClick={handleCancelClose}
          />

          {/* Dialog Content */}
          <div className="relative z-10 w-full max-w-md bg-gray-800 rounded-lg shadow-xl p-6">
            <h2 className="text-lg font-semibold text-white mb-2">
              Unsaved Changes
            </h2>
            <p className="text-gray-300 mb-6">
              You have unsaved changes. Do you want to save before closing?
            </p>

            {/* Actions - 3 buttons: Save, Don't Save, Cancel */}
            <div className="flex justify-end gap-3">
              <button
                type="button"
                className="px-4 py-2 text-sm font-medium text-gray-300 bg-gray-700 rounded hover:bg-gray-600 transition-colors"
                onClick={handleCancelClose}
              >
                Cancel
              </button>
              <button
                type="button"
                className="px-4 py-2 text-sm font-medium text-white bg-red-600 rounded hover:bg-red-700 transition-colors"
                onClick={handleDiscardAndClose}
              >
                Don&apos;t Save
              </button>
              <button
                type="button"
                className="px-4 py-2 text-sm font-medium text-white bg-primary-600 rounded hover:bg-primary-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                onClick={() => void handleSaveAndClose()}
                disabled={isSaving}
              >
                {isSaving && (
                  <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                )}
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
