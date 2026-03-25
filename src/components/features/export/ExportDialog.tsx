/**
 * ExportDialog — Modal for exporting with batch queue, range export, and progress display.
 */

import { useRef, useCallback, useState, useEffect } from 'react';
import { X, Download, ListPlus, Cpu, Zap } from 'lucide-react';
import { useExportDialog } from '@/hooks/useExportDialog';
import { useRenderQueue } from '@/hooks/useRenderQueue';
import {
  PresetOption, ProgressDisplay, OutputLocationField, RangeControls, RenderQueuePanel,
} from './ExportHelpers';
import { EXPORT_PRESETS } from './constants';
import type { ExportDialogProps } from './types';
import { commands } from '@/bindings';

// Re-export types for backward compatibility
export type { ExportPreset, ExportStatus, ExportDialogProps } from './types';

export function ExportDialog({
  isOpen,
  onClose,
  sequenceId,
  sequenceName = 'Untitled Sequence',
}: ExportDialogProps): JSX.Element | null {
  // Detect available hardware encoders
  const [encoderInfo, setEncoderInfo] = useState<{ hasHardware: boolean; name: string }>({
    hasHardware: false,
    name: 'CPU (Software)',
  });

  useEffect(() => {
    if (!isOpen) return;
    const detectEncoders = async (): Promise<void> => {
      try {
        const res = await commands.getAvailableEncoders();
        if (res.status === 'ok' && res.data.hasHardware && res.data.hardware.length > 0) {
          setEncoderInfo({ hasHardware: true, name: res.data.hardware[0].displayName });
        } else {
          setEncoderInfo({ hasHardware: false, name: 'CPU (Software)' });
        }
      } catch {
        setEncoderInfo({ hasHardware: false, name: 'CPU (Software)' });
      }
    };
    void detectEncoders();
  }, [isOpen]);

  const renderQueue = useRenderQueue({ sequenceId, sequenceName });
  const {
    selectedPreset, setSelectedPreset, outputPath,
    status, isExporting, showSettings, canExport,
    handleBrowse, handleExport, handleRetry,
  } = useExportDialog({
    isOpen,
    sequenceId,
    sequenceName,
    useRange: renderQueue.useRange,
    inPoint: renderQueue.inPoint,
    outPoint: renderQueue.outPoint,
  });
  const dialogRef = useRef<HTMLDivElement>(null);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape' && status.type === 'idle' && !renderQueue.isBatchRendering) {
        onClose();
      }
    },
    [onClose, status.type, renderQueue.isBatchRendering]
  );

  const handleClose = useCallback(() => {
    if (status.type !== 'exporting' && !renderQueue.isBatchRendering) {
      renderQueue.resetQueue();
      onClose();
    }
  }, [onClose, status.type, renderQueue.isBatchRendering, renderQueue.resetQueue]);

  if (!isOpen) return null;

  const isBusy = isExporting || renderQueue.isBatchRendering;
  const hasPendingItems = renderQueue.queue.some((i) => i.status === 'pending');
  const isRangeValid =
    !renderQueue.useRange ||
    (renderQueue.inPoint >= 0 && renderQueue.inPoint < renderQueue.outPoint);

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
            disabled={isBusy}
            className="p-1 rounded hover:bg-editor-bg transition-colors text-editor-text-muted hover:text-editor-text disabled:opacity-50"
            aria-label="Close dialog"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-4 space-y-4">
          {showSettings && !renderQueue.isBatchRendering ? (
            <>
              {/* Sequence Info + Encoder */}
              <div className="p-3 bg-editor-bg rounded-lg flex items-center justify-between">
                <div>
                  <p className="text-xs text-editor-text-muted mb-1">Sequence</p>
                  <p className="text-sm text-editor-text font-medium">{sequenceName}</p>
                </div>
                <div className="flex items-center gap-1.5 text-xs text-editor-text-muted">
                  {encoderInfo.hasHardware ? (
                    <Zap className="w-3.5 h-3.5 text-yellow-500" />
                  ) : (
                    <Cpu className="w-3.5 h-3.5" />
                  )}
                  <span>{encoderInfo.name}</span>
                </div>
              </div>

              {/* Preset Selection */}
              <div>
                <label className="block text-sm font-medium text-editor-text mb-2">
                  Export Preset
                </label>
                <div className="grid grid-cols-2 gap-2 max-h-48 overflow-y-auto">
                  {EXPORT_PRESETS.map((preset) => (
                    <PresetOption
                      key={preset.id}
                      preset={preset}
                      isSelected={selectedPreset === preset.id}
                      onSelect={() => setSelectedPreset(preset.id)}
                      disabled={isBusy}
                    />
                  ))}
                </div>
              </div>

              {/* Range Export Toggle */}
              <RangeControls
                useRange={renderQueue.useRange}
                onUseRangeChange={renderQueue.setUseRange}
                inPoint={renderQueue.inPoint}
                onInPointChange={renderQueue.setInPoint}
                outPoint={renderQueue.outPoint}
                onOutPointChange={renderQueue.setOutPoint}
                disabled={isBusy}
              />

              <OutputLocationField
                outputPath={outputPath}
                onBrowse={() => void handleBrowse()}
                disabled={isBusy}
              />

              <RenderQueuePanel
                queue={renderQueue.queue}
                isBatchRendering={renderQueue.isBatchRendering}
                batchProgress={renderQueue.batchProgress}
                onCancelJob={(jobId) => void renderQueue.cancelJob(jobId)}
                onRemoveItem={renderQueue.removeFromQueue}
              />
            </>
          ) : renderQueue.isBatchRendering ? (
            <RenderQueuePanel
              queue={renderQueue.queue}
              isBatchRendering={renderQueue.isBatchRendering}
              batchProgress={renderQueue.batchProgress}
              onCancelJob={(jobId) => void renderQueue.cancelJob(jobId)}
              onRemoveItem={renderQueue.removeFromQueue}
            />
          ) : (
            <ProgressDisplay status={status} onClose={handleClose} onRetry={handleRetry} />
          )}
        </div>

        {/* Footer */}
        {showSettings && !renderQueue.isBatchRendering && (
          <div className="flex justify-between px-6 py-4 border-t border-editor-border bg-editor-sidebar/50 rounded-b-xl">
            <button
              type="button"
              onClick={() => void renderQueue.addToQueue(selectedPreset)}
              disabled={isBusy || !sequenceId || !isRangeValid}
              className="px-3 py-2 text-sm text-editor-text hover:bg-editor-bg rounded-lg transition-colors disabled:opacity-50 flex items-center gap-1.5"
              data-testid="add-to-queue-btn"
            >
              <ListPlus className="w-4 h-4" />
              Add to Queue
            </button>
            <div className="flex gap-3">
              {hasPendingItems && (
                <button
                  type="button"
                  onClick={() => void renderQueue.startBatchRender()}
                  disabled={isBusy || !sequenceId || !isRangeValid}
                  className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50 flex items-center gap-2"
                  data-testid="start-batch-btn"
                >
                  Render Queue ({renderQueue.queue.filter((i) => i.status === 'pending').length})
                </button>
              )}
              <button
                type="button"
                onClick={handleClose}
                disabled={isBusy}
                className="px-4 py-2 text-sm text-editor-text hover:bg-editor-bg rounded-lg transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleExport()}
                disabled={!canExport || isBusy || !isRangeValid}
                className="px-4 py-2 text-sm bg-primary-600 text-white rounded-lg hover:bg-primary-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              >
                <Download className="w-4 h-4" />
                Export
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
