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

  const handleClose = useCallback(() => {
    // TODO: Prompt to save if dirty
    closeProject();
  }, [closeProject]);

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
            onClick={handleClose}
            className="p-1.5 rounded hover:bg-editor-bg transition-colors text-editor-text-muted hover:text-red-400"
            title="Close project"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}
    </div>
  );
}
