/**
 * ExportDialog Component
 *
 * Modal dialog for exporting a sequence with format/quality settings and progress display.
 */

import { useRef, useCallback } from 'react';
import { X, Download } from 'lucide-react';
import { useExportDialog } from '@/hooks/useExportDialog';
import { PresetOption, ProgressDisplay } from './ExportHelpers';
import { EXPORT_PRESETS } from './constants';
import type { ExportDialogProps } from './types';

// Re-export types for backward compatibility
export type { ExportPreset, ExportStatus, ExportDialogProps } from './types';

export function ExportDialog({
  isOpen,
  onClose,
  sequenceId,
  sequenceName = 'Untitled Sequence',
}: ExportDialogProps): JSX.Element | null {
  // ===========================================================================
  // Hook
  // ===========================================================================
  const {
    selectedPreset,
    setSelectedPreset,
    outputPath,
    status,
    isExporting,
    showSettings,
    canExport,
    handleBrowse,
    handleExport,
    handleRetry,
  } = useExportDialog({ isOpen, sequenceId, sequenceName });

  // ===========================================================================
  // Refs
  // ===========================================================================
  const dialogRef = useRef<HTMLDivElement>(null);

  // ===========================================================================
  // Handlers
  // ===========================================================================
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape' && status.type === 'idle') {
        onClose();
      }
    },
    [onClose, status.type]
  );

  const handleClose = useCallback(() => {
    if (status.type !== 'exporting') {
      onClose();
    }
  }, [onClose, status.type]);

  // ===========================================================================
  // Render
  // ===========================================================================
  if (!isOpen) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={(e) => e.target === e.currentTarget && handleClose()}
    >
      <div
        ref={dialogRef}
        data-testid="export-dialog"
        role="dialog"
        aria-labelledby="export-dialog-title"
        aria-modal="true"
        className="bg-editor-panel border border-editor-border rounded-xl shadow-2xl w-full max-w-lg mx-4"
        onKeyDown={handleKeyDown}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-editor-border">
          <div className="flex items-center gap-3">
            <Download className="w-5 h-5 text-primary-500" />
            <h2 id="export-dialog-title" className="text-lg font-semibold text-editor-text">
              Export Video
            </h2>
          </div>
          <button
            onClick={handleClose}
            disabled={isExporting}
            className="p-1 rounded hover:bg-editor-bg transition-colors text-editor-text-muted hover:text-editor-text disabled:opacity-50"
            aria-label="Close dialog"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-4">
          {showSettings ? (
            <div className="space-y-5">
              {/* Sequence Info */}
              <div className="p-3 bg-editor-bg rounded-lg">
                <p className="text-xs text-editor-text-muted mb-1">Sequence</p>
                <p className="text-sm text-editor-text font-medium">{sequenceName}</p>
              </div>

              {/* Preset Selection */}
              <div>
                <label className="block text-sm font-medium text-editor-text mb-2">
                  Export Preset
                </label>
                <div className="grid grid-cols-2 gap-2 max-h-64 overflow-y-auto">
                  {EXPORT_PRESETS.map((preset) => (
                    <PresetOption
                      key={preset.id}
                      preset={preset}
                      isSelected={selectedPreset === preset.id}
                      onSelect={() => setSelectedPreset(preset.id)}
                      disabled={isExporting}
                    />
                  ))}
                </div>
              </div>

              {/* Output Location */}
              <div>
                <label className="block text-sm font-medium text-editor-text mb-2">
                  Output File
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={outputPath}
                    readOnly
                    className="flex-1 px-3 py-2 bg-editor-bg border border-editor-border rounded-lg text-editor-text text-sm truncate"
                    placeholder="Select output location"
                  />
                  <button
                    type="button"
                    onClick={() => void handleBrowse()}
                    disabled={isExporting}
                    className="px-4 py-2 bg-editor-sidebar border border-editor-border rounded-lg text-editor-text hover:bg-editor-bg transition-colors disabled:opacity-50"
                  >
                    Browse
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <ProgressDisplay status={status} onClose={handleClose} onRetry={handleRetry} />
          )}
        </div>

        {/* Footer - only show when settings visible */}
        {showSettings && (
          <div className="flex justify-end gap-3 px-6 py-4 border-t border-editor-border bg-editor-sidebar/50 rounded-b-xl">
            <button
              type="button"
              onClick={handleClose}
              disabled={isExporting}
              className="px-4 py-2 text-sm text-editor-text hover:bg-editor-bg rounded-lg transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void handleExport()}
              disabled={!canExport || isExporting}
              className="px-4 py-2 text-sm bg-primary-600 text-white rounded-lg hover:bg-primary-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            >
              <Download className="w-4 h-4" />
              Export
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
