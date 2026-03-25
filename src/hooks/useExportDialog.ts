/**
 * useExportDialog Hook
 *
 * Manages export dialog state, Tauri event listeners, and export operations.
 * Extracted from ExportDialog.tsx to improve maintainability and testability.
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { save } from '@tauri-apps/plugin-dialog';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { commands } from '@/bindings';
import type {
  ExportStatus,
  RenderProgressEvent,
  RenderCompleteEvent,
  RenderErrorEvent,
} from '@/components/features/export/types';
import { EXPORT_PRESETS, getPresetExtension } from '@/components/features/export/constants';

// =============================================================================
// Types
// =============================================================================

export interface UseExportDialogProps {
  /** Whether the dialog is open */
  isOpen: boolean;
  /** Sequence ID to export */
  sequenceId: string | null;
  /** Sequence name for display/default filename */
  sequenceName?: string;
  /** Whether single-export range rendering is enabled */
  useRange?: boolean;
  /** Range start in seconds when `useRange` is enabled */
  inPoint?: number;
  /** Range end in seconds when `useRange` is enabled */
  outPoint?: number;
}

export interface UseExportDialogResult {
  /** Currently selected preset ID */
  selectedPreset: string;
  /** Set the selected preset */
  setSelectedPreset: (presetId: string) => void;
  /** Output file path */
  outputPath: string;
  /** Set the output path */
  setOutputPath: (path: string) => void;
  /** Current export status */
  status: ExportStatus;
  /** Whether export is currently in progress */
  isExporting: boolean;
  /** Whether settings should be shown (not exporting/completed/failed) */
  showSettings: boolean;
  /** Whether export can be started */
  canExport: boolean;
  /** Browse for output file location */
  handleBrowse: () => Promise<void>;
  /** Start the export */
  handleExport: () => Promise<void>;
  /** Retry after failure */
  handleRetry: () => void;
}

// =============================================================================
// Hook Implementation
// =============================================================================

export function useExportDialog({
  isOpen,
  sequenceId,
  sequenceName = 'Untitled Sequence',
  useRange = false,
  inPoint = 0,
  outPoint = 0,
}: UseExportDialogProps): UseExportDialogResult {
  // ===========================================================================
  // State
  // ===========================================================================
  const [selectedPreset, setSelectedPreset] = useState(EXPORT_PRESETS[0].id);
  const [outputPath, setOutputPath] = useState('');
  const [status, setStatus] = useState<ExportStatus>({ type: 'idle' });
  const [currentJobId, setCurrentJobId] = useState<string | null>(null);

  // ===========================================================================
  // Refs
  // ===========================================================================
  const unlistenRefs = useRef<UnlistenFn[]>([]);
  const currentJobIdRef = useRef<string | null>(null);

  // ===========================================================================
  // Reset on Dialog Open
  // ===========================================================================
  useEffect(() => {
    if (isOpen) {
      setSelectedPreset(EXPORT_PRESETS[0].id);
      setOutputPath('');
      setStatus({ type: 'idle' });
      setCurrentJobId(null);
      currentJobIdRef.current = null;
    }
  }, [isOpen]);

  // Keep ref in sync with state
  useEffect(() => {
    currentJobIdRef.current = currentJobId;
  }, [currentJobId]);

  // ===========================================================================
  // Tauri Event Listeners
  // ===========================================================================
  useEffect(() => {
    if (!isOpen) {
      return;
    }

    let isDisposed = false;

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
          const message =
            totalFrames > 0
              ? `Encoding frame ${frame}/${totalFrames} (${fps.toFixed(1)} fps, ETA: ${etaSeconds}s)`
              : `Encoding frame ${frame}...`;
          setStatus({ type: 'exporting', progress: percent, message });
        }
      });
      if (!isDisposed) {
        unlistenRefs.current.push(unlistenProgress);
      }

      // Listen for completion events
      const unlistenComplete = await listen<RenderCompleteEvent>('render-complete', (event) => {
        const jobId = currentJobIdRef.current;
        if (jobId && event.payload.jobId === jobId) {
          currentJobIdRef.current = null;
          setStatus({
            type: 'completed',
            outputPath: event.payload.outputPath,
            duration: event.payload.encodingTimeSec,
          });
          setCurrentJobId(null);
        }
      });
      if (!isDisposed) {
        unlistenRefs.current.push(unlistenComplete);
      }

      // Listen for error events
      const unlistenError = await listen<RenderErrorEvent>('render-error', (event) => {
        const jobId = currentJobIdRef.current;
        if (jobId && event.payload.jobId === jobId) {
          currentJobIdRef.current = null;
          setStatus({ type: 'failed', error: event.payload.error });
          setCurrentJobId(null);
        }
      });
      if (!isDisposed) {
        unlistenRefs.current.push(unlistenError);
      }
    };

    void setupListeners();

    return () => {
      isDisposed = true;
      for (const unlisten of unlistenRefs.current) {
        if (typeof unlisten === 'function') {
          unlisten();
        }
      }
      unlistenRefs.current = [];
    };
  }, [isOpen]);

  // ===========================================================================
  // Handlers
  // ===========================================================================

  /**
   * Open file browser to select output location.
   */
  const handleBrowse = useCallback(async () => {
    const extension = getPresetExtension(selectedPreset);

    const selected = await save({
      defaultPath: `${sequenceName}.${extension}`,
      filters: [{ name: 'Video', extensions: [extension] }],
      title: 'Export Video',
    });

    if (selected) {
      setOutputPath(selected);
    }
  }, [selectedPreset, sequenceName]);

  /**
   * Start the export process.
   */
  const handleExport = useCallback(async () => {
    if (!sequenceId || !outputPath) return;
    if (useRange && (inPoint < 0 || inPoint >= outPoint)) {
      setStatus({ type: 'failed', error: 'In point must be before Out point.' });
      return;
    }

    setStatus({ type: 'exporting', progress: 0, message: 'Starting export...' });

    try {
      const res = useRange
        ? await commands.renderRange(sequenceId, outputPath, selectedPreset, inPoint, outPoint)
        : await commands.startRender(sequenceId, outputPath, selectedPreset);

      if (res.status === 'error') {
        setStatus({ type: 'failed', error: String(res.error) });
        currentJobIdRef.current = null;
        setCurrentJobId(null);
        return;
      }

      const result = res.data;
      currentJobIdRef.current = result.jobId;
      setCurrentJobId(result.jobId);

      if (result.status === 'completed') {
        setStatus({
          type: 'completed',
          outputPath: result.outputPath,
          duration: 0,
        });
        currentJobIdRef.current = null;
        setCurrentJobId(null);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      setStatus({ type: 'failed', error: errorMessage });
      currentJobIdRef.current = null;
      setCurrentJobId(null);
    }
  }, [sequenceId, outputPath, selectedPreset, useRange, inPoint, outPoint]);

  /**
   * Reset to idle state for retry.
   */
  const handleRetry = useCallback(() => {
    currentJobIdRef.current = null;
    setCurrentJobId(null);
    setStatus({ type: 'idle' });
  }, []);

  // ===========================================================================
  // Computed Values
  // ===========================================================================
  const isExporting = status.type === 'exporting';
  const showSettings = status.type === 'idle';
  const canExport = useMemo(
    () => outputPath.length > 0 && sequenceId !== null,
    [outputPath, sequenceId]
  );

  // ===========================================================================
  // Return
  // ===========================================================================
  return {
    selectedPreset,
    setSelectedPreset,
    outputPath,
    setOutputPath,
    status,
    isExporting,
    showSettings,
    canExport,
    handleBrowse,
    handleExport,
    handleRetry,
  };
}
