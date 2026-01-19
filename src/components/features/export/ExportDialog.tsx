/**
 * ExportDialog Component
 *
 * Modal dialog for exporting a sequence with format/quality settings and progress display.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { save } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import {
  X,
  Download,
  Monitor,
  Smartphone,
  Film,
  Globe,
  CheckCircle,
  XCircle,
  Loader2,
} from 'lucide-react';

// =============================================================================
// Types
// =============================================================================

/** Export preset option */
export interface ExportPreset {
  id: string;
  name: string;
  description: string;
  icon: 'monitor' | 'smartphone' | 'film' | 'globe';
}

/** Export state */
export type ExportStatus =
  | { type: 'idle' }
  | { type: 'exporting'; progress: number; message: string }
  | { type: 'completed'; outputPath: string; duration: number }
  | { type: 'failed'; error: string };

/** Dialog props */
export interface ExportDialogProps {
  /** Whether the dialog is open */
  isOpen: boolean;
  /** Callback when dialog is closed */
  onClose: () => void;
  /** Sequence ID to export */
  sequenceId: string | null;
  /** Sequence name for display */
  sequenceName?: string;
}

/** Render progress event payload */
interface RenderProgressEvent {
  jobId: string;
  frame: number;
  totalFrames: number;
  percent: number;
  fps: number;
  etaSeconds: number;
  message: string;
}

/** Render complete event payload */
interface RenderCompleteEvent {
  jobId: string;
  outputPath: string;
  durationSec: number;
  fileSize: number;
  encodingTimeSec: number;
}

/** Render error event payload */
interface RenderErrorEvent {
  jobId: string;
  error: string;
}

// =============================================================================
// Constants
// =============================================================================

const EXPORT_PRESETS: ExportPreset[] = [
  {
    id: 'youtube_1080p',
    name: 'YouTube 1080p',
    description: 'H.264, 1920x1080, 8Mbps',
    icon: 'monitor',
  },
  {
    id: 'youtube_4k',
    name: 'YouTube 4K',
    description: 'H.264, 3840x2160, 35Mbps',
    icon: 'monitor',
  },
  {
    id: 'youtube_shorts',
    name: 'Shorts/Reels',
    description: 'Vertical 1080x1920',
    icon: 'smartphone',
  },
  {
    id: 'twitter',
    name: 'Twitter/X',
    description: 'H.264, 1280x720, 5Mbps',
    icon: 'globe',
  },
  {
    id: 'instagram',
    name: 'Instagram',
    description: 'Square 1080x1080',
    icon: 'smartphone',
  },
  {
    id: 'webm_vp9',
    name: 'WebM VP9',
    description: 'VP9/Opus, High quality',
    icon: 'globe',
  },
  {
    id: 'prores',
    name: 'ProRes',
    description: 'Apple ProRes 422',
    icon: 'film',
  },
];

// =============================================================================
// Helper Components
// =============================================================================

interface PresetOptionProps {
  preset: ExportPreset;
  isSelected: boolean;
  onSelect: () => void;
  disabled: boolean;
}

function PresetOption({ preset, isSelected, onSelect, disabled }: PresetOptionProps): JSX.Element {
  const icons = {
    monitor: Monitor,
    smartphone: Smartphone,
    film: Film,
    globe: Globe,
  };
  const Icon = icons[preset.icon];

  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      className={`
        flex items-center gap-3 p-3 rounded-lg border transition-colors text-left w-full
        ${disabled ? 'opacity-50 cursor-not-allowed' : ''}
        ${isSelected
          ? 'border-primary-500 bg-primary-500/10'
          : 'border-editor-border hover:border-editor-text-muted'
        }
      `}
    >
      <div className={`p-2 rounded ${isSelected ? 'bg-primary-500 text-white' : 'bg-editor-bg text-editor-text-muted'}`}>
        <Icon className="w-4 h-4" />
      </div>
      <div className="flex-1 min-w-0">
        <p className={`font-medium text-sm truncate ${isSelected ? 'text-primary-400' : 'text-editor-text'}`}>
          {preset.name}
        </p>
        <p className="text-xs text-editor-text-muted truncate">{preset.description}</p>
      </div>
    </button>
  );
}

interface ProgressDisplayProps {
  status: ExportStatus;
  onClose: () => void;
  onRetry: () => void;
}

function ProgressDisplay({ status, onClose, onRetry }: ProgressDisplayProps): JSX.Element {
  if (status.type === 'exporting') {
    return (
      <div className="py-8 text-center">
        <Loader2 className="w-12 h-12 mx-auto text-primary-500 animate-spin mb-4" />
        <p className="text-editor-text font-medium mb-2">Exporting...</p>
        <p className="text-sm text-editor-text-muted mb-4">{status.message}</p>
        <div className="w-full bg-editor-bg rounded-full h-2 mb-2">
          <div
            className="bg-primary-500 h-2 rounded-full transition-all duration-300"
            style={{ width: `${status.progress}%` }}
          />
        </div>
        <p className="text-xs text-editor-text-muted">{Math.round(status.progress)}%</p>
      </div>
    );
  }

  if (status.type === 'completed') {
    return (
      <div className="py-8 text-center">
        <CheckCircle className="w-12 h-12 mx-auto text-green-500 mb-4" />
        <p className="text-editor-text font-medium mb-2">Export Completed!</p>
        <p className="text-sm text-editor-text-muted mb-4">
          Saved to: <span className="text-editor-text">{status.outputPath}</span>
        </p>
        <p className="text-xs text-editor-text-muted">
          Duration: {status.duration.toFixed(1)}s
        </p>
        <button
          onClick={onClose}
          className="mt-6 px-6 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700 transition-colors"
        >
          Done
        </button>
      </div>
    );
  }

  if (status.type === 'failed') {
    return (
      <div className="py-8 text-center">
        <XCircle className="w-12 h-12 mx-auto text-red-500 mb-4" />
        <p className="text-editor-text font-medium mb-2">Export Failed</p>
        <p className="text-sm text-red-400 mb-6">{status.error}</p>
        <div className="flex justify-center gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-editor-text hover:bg-editor-bg rounded-lg transition-colors"
          >
            Close
          </button>
          <button
            onClick={onRetry}
            className="px-4 py-2 text-sm bg-primary-600 text-white rounded-lg hover:bg-primary-700 transition-colors"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return <></>;
}

// =============================================================================
// Main Component
// =============================================================================

export function ExportDialog({
  isOpen,
  onClose,
  sequenceId,
  sequenceName = 'Untitled Sequence',
}: ExportDialogProps): JSX.Element | null {
  // State
  const [selectedPreset, setSelectedPreset] = useState(EXPORT_PRESETS[0].id);
  const [outputPath, setOutputPath] = useState('');
  const [status, setStatus] = useState<ExportStatus>({ type: 'idle' });
  const [currentJobId, setCurrentJobId] = useState<string | null>(null);

  // Refs
  const dialogRef = useRef<HTMLDivElement>(null);
  const unlistenRefs = useRef<UnlistenFn[]>([]);
  const currentJobIdRef = useRef<string | null>(null);

  // Reset form when dialog opens
  useEffect(() => {
    if (isOpen) {
      setSelectedPreset(EXPORT_PRESETS[0].id);
      setOutputPath('');
      setStatus({ type: 'idle' });
      setCurrentJobId(null);
    }
  }, [isOpen]);

  // Keep ref in sync with state for use in event listeners
  useEffect(() => {
    currentJobIdRef.current = currentJobId;
  }, [currentJobId]);

  // Set up Tauri event listeners for render progress
  useEffect(() => {
    const setupListeners = async () => {
      // Clean up previous listeners
      for (const unlisten of unlistenRefs.current) {
        unlisten();
      }
      unlistenRefs.current = [];

      // Listen for progress events
      const unlistenProgress = await listen<RenderProgressEvent>('render-progress', (event) => {
        const jobId = currentJobIdRef.current;
        if (jobId && event.payload.jobId === jobId) {
          const { percent, frame, totalFrames, fps, etaSeconds } = event.payload;
          const message = totalFrames > 0
            ? `Encoding frame ${frame}/${totalFrames} (${fps.toFixed(1)} fps, ETA: ${etaSeconds}s)`
            : `Encoding frame ${frame}...`;
          setStatus({ type: 'exporting', progress: percent, message });
        }
      });
      unlistenRefs.current.push(unlistenProgress);

      // Listen for completion events
      const unlistenComplete = await listen<RenderCompleteEvent>('render-complete', (event) => {
        const jobId = currentJobIdRef.current;
        if (jobId && event.payload.jobId === jobId) {
          setStatus({
            type: 'completed',
            outputPath: event.payload.outputPath,
            duration: event.payload.encodingTimeSec,
          });
          setCurrentJobId(null);
        }
      });
      unlistenRefs.current.push(unlistenComplete);

      // Listen for error events
      const unlistenError = await listen<RenderErrorEvent>('render-error', (event) => {
        const jobId = currentJobIdRef.current;
        if (jobId && event.payload.jobId === jobId) {
          setStatus({ type: 'failed', error: event.payload.error });
          setCurrentJobId(null);
        }
      });
      unlistenRefs.current.push(unlistenError);
    };

    if (currentJobId) {
      void setupListeners();
    }

    // Cleanup on unmount or when job changes
    return () => {
      for (const unlisten of unlistenRefs.current) {
        unlisten();
      }
      unlistenRefs.current = [];
    };
  }, [currentJobId]);

  // Handlers
  const handleBrowse = useCallback(async () => {
    const preset = EXPORT_PRESETS.find(p => p.id === selectedPreset);
    const extension = preset?.id === 'webm_vp9' ? 'webm' : preset?.id === 'prores' ? 'mov' : 'mp4';

    const selected = await save({
      defaultPath: `${sequenceName}.${extension}`,
      filters: [
        { name: 'Video', extensions: [extension] },
      ],
      title: 'Export Video',
    });

    if (selected) {
      setOutputPath(selected);
    }
  }, [selectedPreset, sequenceName]);

  const handleExport = useCallback(async () => {
    if (!sequenceId || !outputPath) return;

    setStatus({ type: 'exporting', progress: 0, message: 'Starting export...' });

    try {
      // Start render - progress will be received via Tauri events
      const result = await invoke<{ jobId: string; outputPath: string; status: string }>(
        'start_render',
        {
          sequenceId,
          outputPath,
          preset: selectedPreset,
        }
      );

      // Store job ID to filter events - this enables event listeners
      setCurrentJobId(result.jobId);

      // Handle different response statuses:
      // - 'started': Export running in background, wait for events
      // - 'completed': Export finished immediately (very short videos)
      if (result.status === 'completed') {
        setStatus({
          type: 'completed',
          outputPath: result.outputPath,
          duration: 0,
        });
        setCurrentJobId(null);
      }
      // For 'started' status, continue showing progress and wait for events
    } catch (error) {
      // Handle validation errors and other failures
      const errorMessage = error instanceof Error ? error.message : String(error);
      setStatus({
        type: 'failed',
        error: errorMessage,
      });
      setCurrentJobId(null);
    }
  }, [sequenceId, outputPath, selectedPreset]);

  const handleRetry = useCallback(() => {
    setStatus({ type: 'idle' });
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape' && status.type === 'idle') {
      onClose();
    }
  }, [onClose, status.type]);

  const handleClose = useCallback(() => {
    if (status.type !== 'exporting') {
      onClose();
    }
  }, [onClose, status.type]);

  // Don't render if closed
  if (!isOpen) {
    return null;
  }

  const isExporting = status.type === 'exporting';
  const showSettings = status.type === 'idle';
  const canExport = outputPath.length > 0 && sequenceId;

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
            <ProgressDisplay
              status={status}
              onClose={handleClose}
              onRetry={handleRetry}
            />
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
