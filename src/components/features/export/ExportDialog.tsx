/**
 * ExportDialog — Modal for video/audio export with batch queue, range export, and progress display.
 */

import { useRef, useCallback, useState, useEffect } from 'react';
import { X, Download, ListPlus, Cpu, Zap, Music } from 'lucide-react';
import { useExportDialog } from '@/hooks/useExportDialog';
import { useRenderQueue } from '@/hooks/useRenderQueue';
import {
  PresetOption,
  ProgressDisplay,
  OutputLocationField,
  RangeControls,
  RenderQueuePanel,
} from './ExportHelpers';
import { AUDIO_EXPORT_FORMATS, EXPORT_PRESETS } from './constants';
import type { ExportDialogProps } from './types';
import { commands } from '@/bindings';

// Re-export types for backward compatibility
export type { ExportPreset, ExportStatus, ExportDialogProps } from './types';

export function ExportDialog({
  isOpen,
  onClose,
  sequenceId,
  sequenceName = 'Untitled Sequence',
  initialExportKind = 'video',
}: ExportDialogProps): JSX.Element | null {
  const [encoderInfo, setEncoderInfo] = useState<{ hasHardware: boolean; name: string }>({
    hasHardware: false,
    name: 'CPU (Software)',
  });

  const renderQueue = useRenderQueue({ sequenceId, sequenceName });
  const { isBatchRendering, resetQueue } = renderQueue;
  const {
    exportKind,
    setExportKind,
    selectedPreset,
    setSelectedPreset,
    selectedAudioFormat,
    setSelectedAudioFormat,
    outputPath,
    status,
    isExporting,
    showSettings,
    canExport,
    handleBrowse,
    handleExport,
    handleRetry,
  } = useExportDialog({
    isOpen,
    sequenceId,
    sequenceName,
    useRange: renderQueue.useRange,
    inPoint: renderQueue.inPoint,
    outPoint: renderQueue.outPoint,
    initialExportKind,
  });
  const dialogRef = useRef<HTMLDivElement>(null);
  const wasOpenRef = useRef(isOpen);

  useEffect(() => {
    if (!isOpen || exportKind !== 'video') {
      return;
    }

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
  }, [exportKind, isOpen]);

  useEffect(() => {
    if (wasOpenRef.current && !isOpen && !isBatchRendering) {
      resetQueue();
    }

    wasOpenRef.current = isOpen;
  }, [isBatchRendering, isOpen, resetQueue]);

  const handleClose = useCallback(() => {
    if (status.type !== 'exporting' && !isBatchRendering) {
      onClose();
    }
  }, [isBatchRendering, onClose, status.type]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape' && status.type === 'idle' && !isBatchRendering) {
        handleClose();
      }
    },
    [handleClose, isBatchRendering, status.type],
  );

  if (!isOpen) return null;

  const isBusy = isExporting || renderQueue.isBatchRendering;
  const hasPendingItems = renderQueue.queue.some((item) => item.status === 'pending');
  const isRangeValid =
    !renderQueue.useRange ||
    (renderQueue.inPoint >= 0 && renderQueue.inPoint < renderQueue.outPoint);
  const exportTitle = exportKind === 'audio' ? 'Export Audio' : 'Export Video';
  const ExportTitleIcon = exportKind === 'audio' ? Music : Download;

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
        className="mx-4 w-full max-w-lg rounded-xl border border-editor-border bg-editor-panel shadow-2xl"
        onKeyDown={handleKeyDown}
      >
        <div className="flex items-center justify-between border-b border-editor-border px-6 py-4">
          <div className="flex items-center gap-3">
            <ExportTitleIcon className="h-5 w-5 text-primary-500" />
            <h2 id="export-dialog-title" className="text-lg font-semibold text-editor-text">
              {exportTitle}
            </h2>
          </div>
          <button
            onClick={handleClose}
            disabled={isBusy}
            className="rounded p-1 text-editor-text-muted transition-colors hover:bg-editor-bg hover:text-editor-text disabled:opacity-50"
            aria-label="Close dialog"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-4 px-6 py-4">
          {showSettings && !renderQueue.isBatchRendering ? (
            <>
              <div className="grid grid-cols-2 gap-2 rounded-lg bg-editor-bg p-1">
                <button
                  type="button"
                  onClick={() => setExportKind('video')}
                  disabled={isBusy}
                  className={`rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                    exportKind === 'video'
                      ? 'bg-primary-600 text-white'
                      : 'text-editor-text-muted hover:bg-editor-panel'
                  }`}
                >
                  Video
                </button>
                <button
                  type="button"
                  onClick={() => setExportKind('audio')}
                  disabled={isBusy}
                  className={`rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                    exportKind === 'audio'
                      ? 'bg-primary-600 text-white'
                      : 'text-editor-text-muted hover:bg-editor-panel'
                  }`}
                >
                  Audio
                </button>
              </div>

              <div className="flex items-center justify-between gap-3 rounded-lg bg-editor-bg p-3">
                <div>
                  <p className="mb-1 text-xs text-editor-text-muted">Sequence</p>
                  <p className="text-sm font-medium text-editor-text">{sequenceName}</p>
                  {exportKind === 'audio' && (
                    <p className="mt-1 text-xs text-editor-text-muted">
                      Mix down enabled audio tracks to a single master file.
                    </p>
                  )}
                </div>
                {exportKind === 'video' ? (
                  <div className="flex items-center gap-1.5 text-xs text-editor-text-muted">
                    {encoderInfo.hasHardware ? (
                      <Zap className="h-3.5 w-3.5 text-yellow-500" />
                    ) : (
                      <Cpu className="h-3.5 w-3.5" />
                    )}
                    <span>{encoderInfo.name}</span>
                  </div>
                ) : (
                  <div className="flex items-center gap-1.5 text-xs text-editor-text-muted">
                    <Music className="h-3.5 w-3.5" />
                    <span>Audio-only mixdown</span>
                  </div>
                )}
              </div>

              {exportKind === 'video' ? (
                <div>
                  <label className="mb-2 block text-sm font-medium text-editor-text">
                    Export Preset
                  </label>
                  <div className="grid max-h-48 grid-cols-2 gap-2 overflow-y-auto">
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
              ) : (
                <div>
                  <label className="mb-2 block text-sm font-medium text-editor-text">
                    Audio Format
                  </label>
                  <div className="grid max-h-48 grid-cols-2 gap-2 overflow-y-auto">
                    {AUDIO_EXPORT_FORMATS.map((format) => (
                      <PresetOption
                        key={format.id}
                        preset={format}
                        isSelected={selectedAudioFormat === format.id}
                        onSelect={() => setSelectedAudioFormat(format.id)}
                        disabled={isBusy}
                      />
                    ))}
                  </div>
                </div>
              )}

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

              {exportKind === 'video' && (
                <RenderQueuePanel
                  queue={renderQueue.queue}
                  isBatchRendering={renderQueue.isBatchRendering}
                  batchProgress={renderQueue.batchProgress}
                  onCancelJob={(jobId) => void renderQueue.cancelJob(jobId)}
                  onRemoveItem={renderQueue.removeFromQueue}
                />
              )}
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

        {showSettings && !renderQueue.isBatchRendering && (
          <div className="flex justify-between rounded-b-xl border-t border-editor-border bg-editor-sidebar/50 px-6 py-4">
            {exportKind === 'video' ? (
              <button
                type="button"
                onClick={() => void renderQueue.addToQueue(selectedPreset)}
                disabled={isBusy || !sequenceId || !isRangeValid}
                className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm text-editor-text transition-colors hover:bg-editor-bg disabled:opacity-50"
                data-testid="add-to-queue-btn"
              >
                <ListPlus className="h-4 w-4" />
                Add to Queue
              </button>
            ) : (
              <div />
            )}

            <div className="flex gap-3">
              {exportKind === 'video' && hasPendingItems && (
                <button
                  type="button"
                  onClick={() => void renderQueue.startBatchRender()}
                  disabled={isBusy || !sequenceId || !isRangeValid}
                  className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
                  data-testid="start-batch-btn"
                >
                  Render Queue (
                  {renderQueue.queue.filter((item) => item.status === 'pending').length})
                </button>
              )}
              <button
                type="button"
                onClick={handleClose}
                disabled={isBusy}
                className="rounded-lg px-4 py-2 text-sm text-editor-text transition-colors hover:bg-editor-bg disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleExport()}
                disabled={!canExport || isBusy || !isRangeValid}
                className="flex items-center gap-2 rounded-lg bg-primary-600 px-4 py-2 text-sm text-white transition-colors hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Download className="h-4 w-4" />
                {exportKind === 'audio' ? 'Export Audio' : 'Export'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
