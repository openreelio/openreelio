/**
 * useExportDialog Hook
 *
 * Manages export dialog state, Tauri event listeners, and export operations.
 * Extracted from ExportDialog.tsx to improve maintainability and testability.
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { pickExportDestination } from '@/services/exportDestination';
import { commands, type VideoExportRequest } from '@/bindings';
import type {
  AudioExportFormat,
  ExportKind,
  ExportStatus,
  RenderProgressEvent,
  RenderCompleteEvent,
  RenderErrorEvent,
  TimelineExportFormat,
} from '@/components/features/export/types';
import {
  AUDIO_EXPORT_FORMATS,
  EXPORT_PRESETS,
  TIMELINE_EXPORT_FORMATS,
  getAudioFormatExtension,
  getAudioFormatOption,
  getTimelineFormatExtension,
  getTimelineFormatOption,
  getVideoExportRequest,
  getPresetExtension,
  applyHdrSettingsToVideoExportRequest,
} from '@/components/features/export/constants';

function replaceOutputPathExtension(path: string, nextExtension: string): string {
  const trimmedPath = path.trim();
  if (!trimmedPath) {
    return trimmedPath;
  }

  const lastSeparatorIndex = Math.max(trimmedPath.lastIndexOf('/'), trimmedPath.lastIndexOf('\\'));
  const directory = lastSeparatorIndex >= 0 ? trimmedPath.slice(0, lastSeparatorIndex + 1) : '';
  const fileName =
    lastSeparatorIndex >= 0 ? trimmedPath.slice(lastSeparatorIndex + 1) : trimmedPath;
  const lastDotIndex = fileName.lastIndexOf('.');
  const baseName = lastDotIndex > 0 ? fileName.slice(0, lastDotIndex) : fileName;

  return `${directory}${baseName}.${nextExtension}`;
}

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
  /** Which export mode to initialize when opening */
  initialExportKind?: ExportKind;
}

export interface UseExportDialogResult {
  /** Active export workflow kind */
  exportKind: ExportKind;
  /** Switch between video/audio export modes */
  setExportKind: (kind: ExportKind) => void;
  /** Currently selected preset ID */
  selectedPreset: string;
  /** Set the selected preset */
  setSelectedPreset: (presetId: string) => void;
  /** Currently selected audio format */
  selectedAudioFormat: AudioExportFormat;
  /** Set the selected audio format */
  setSelectedAudioFormat: (format: AudioExportFormat) => void;
  /** Currently selected editable timeline format */
  selectedTimelineFormat: TimelineExportFormat;
  /** Set the selected editable timeline format */
  setSelectedTimelineFormat: (format: TimelineExportFormat) => void;
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
  /** Run the preflight and, if the project is clean, start the export */
  handleExport: () => Promise<void>;
  /** Start the export the preflight warned about, after the user chose to proceed */
  confirmExport: () => Promise<void>;
  /** Dismiss the preflight findings without exporting */
  cancelValidation: () => void;
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
  initialExportKind = 'video',
}: UseExportDialogProps): UseExportDialogResult {
  // ===========================================================================
  // State
  // ===========================================================================
  const [exportKind, setExportKind] = useState<ExportKind>(initialExportKind);
  const [selectedPreset, setSelectedPreset] = useState(EXPORT_PRESETS[0].id);
  const [selectedAudioFormat, setSelectedAudioFormat] = useState<AudioExportFormat>(
    AUDIO_EXPORT_FORMATS[0].id,
  );
  const [selectedTimelineFormat, setSelectedTimelineFormat] = useState<TimelineExportFormat>(
    TIMELINE_EXPORT_FORMATS[0].id,
  );
  const [outputPath, setOutputPath] = useState('');
  const [status, setStatus] = useState<ExportStatus>({ type: 'idle' });
  const [currentJobId, setCurrentJobId] = useState<string | null>(null);

  // ===========================================================================
  // Refs
  // ===========================================================================
  const unlistenRefs = useRef<UnlistenFn[]>([]);
  const currentJobIdRef = useRef<string | null>(null);
  /** Request the preflight validated, held so "Export anyway" reuses it verbatim. */
  const pendingVideoRequestRef = useRef<VideoExportRequest | null>(null);

  // ===========================================================================
  // Reset on Dialog Open
  // ===========================================================================
  useEffect(() => {
    if (isOpen) {
      setExportKind(initialExportKind);
      setSelectedPreset(EXPORT_PRESETS[0].id);
      setSelectedAudioFormat(AUDIO_EXPORT_FORMATS[0].id);
      setSelectedTimelineFormat(TIMELINE_EXPORT_FORMATS[0].id);
      setOutputPath('');
      setStatus({ type: 'idle' });
      setCurrentJobId(null);
      currentJobIdRef.current = null;
      pendingVideoRequestRef.current = null;
    }
  }, [initialExportKind, isOpen]);

  // Keep ref in sync with state
  useEffect(() => {
    currentJobIdRef.current = currentJobId;
  }, [currentJobId]);

  useEffect(() => {
    if (!outputPath) {
      return;
    }

    const nextExtension =
      exportKind === 'audio'
        ? getAudioFormatExtension(selectedAudioFormat)
        : exportKind === 'timeline'
          ? getTimelineFormatExtension(selectedTimelineFormat)
          : getPresetExtension(selectedPreset);
    const nextOutputPath = replaceOutputPathExtension(outputPath, nextExtension);

    if (nextOutputPath !== outputPath) {
      setOutputPath(nextOutputPath);
    }
  }, [exportKind, outputPath, selectedAudioFormat, selectedPreset, selectedTimelineFormat]);

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
    if (exportKind === 'audio') {
      const option = getAudioFormatOption(selectedAudioFormat);
      const extension = getAudioFormatExtension(selectedAudioFormat);

      const selected = await pickExportDestination({
        defaultName: `${sequenceName}.${extension}`,
        filters: [{ name: option.name, extensions: [extension] }],
        title: 'Export Audio',
      });

      if (selected) {
        setOutputPath(selected);
      }

      return;
    }

    if (exportKind === 'timeline') {
      const option = getTimelineFormatOption(selectedTimelineFormat);
      const extension = getTimelineFormatExtension(selectedTimelineFormat);

      const selected = await pickExportDestination({
        defaultName: `${sequenceName}.${extension}`,
        filters: [{ name: option.name, extensions: [extension] }],
      });

      if (selected) {
        setOutputPath(selected);
      }

      return;
    }

    const extension = getPresetExtension(selectedPreset);

    const selected = await pickExportDestination({
      defaultName: `${sequenceName}.${extension}`,
      filters: [{ name: 'Video', extensions: [extension] }],
    });

    if (selected) {
      setOutputPath(selected);
    }
  }, [exportKind, selectedAudioFormat, selectedPreset, selectedTimelineFormat, sequenceName]);

  const failWith = useCallback((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    setStatus({ type: 'failed', error: message });
    currentJobIdRef.current = null;
    setCurrentJobId(null);
  }, []);

  /**
   * Resolve the video request the backend renders, HDR settings included.
   *
   * The preflight and the render must be handed the identical request, or the
   * preflight would be validating settings the render never uses.
   */
  const resolveVideoExportRequest = useCallback(async (): Promise<VideoExportRequest> => {
    if (!sequenceId) {
      throw new Error('No sequence selected.');
    }
    const request = getVideoExportRequest(selectedPreset);
    const hdrResult = await commands.getSequenceHdrSettings(sequenceId);
    if (hdrResult.status === 'error') {
      throw new Error(String(hdrResult.error));
    }
    return applyHdrSettingsToVideoExportRequest(request, hdrResult.data);
  }, [selectedPreset, sequenceId]);

  /**
   * Hand the export to the backend. Assumes the caller already decided it may run.
   */
  const startExport = useCallback(
    async (videoRequest: VideoExportRequest | null) => {
      if (!sequenceId || !outputPath) return;

      setStatus({
        type: 'exporting',
        progress: 0,
        message:
          exportKind === 'audio'
            ? 'Starting audio export...'
            : exportKind === 'timeline'
              ? 'Exporting editable timeline...'
              : 'Starting export...',
      });

      try {
        if (exportKind === 'timeline') {
          const res =
            selectedTimelineFormat === 'edl'
              ? await commands.exportEdl(sequenceId, outputPath)
              : await commands.exportFcpxml(sequenceId, outputPath);

          if (res.status === 'error') {
            failWith(String(res.error));
            return;
          }

          setStatus({
            type: 'completed',
            outputPath: res.data.outputPath,
            duration: 0,
          });
          currentJobIdRef.current = null;
          setCurrentJobId(null);
          return;
        }

        const res =
          exportKind === 'audio'
            ? await commands.exportAudioOnly(
                sequenceId,
                selectedAudioFormat,
                outputPath,
                null,
                null,
                useRange ? inPoint : null,
                useRange ? outPoint : null,
              )
            : useRange
              ? await commands.renderRange(
                  sequenceId,
                  outputPath,
                  selectedPreset,
                  videoRequest,
                  inPoint,
                  outPoint,
                )
              : await commands.startRender(sequenceId, outputPath, selectedPreset, videoRequest);

        if (res.status === 'error') {
          failWith(String(res.error));
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
        failWith(error);
      }
    },
    [
      exportKind,
      failWith,
      inPoint,
      outPoint,
      outputPath,
      selectedAudioFormat,
      selectedPreset,
      selectedTimelineFormat,
      sequenceId,
      useRange,
    ],
  );

  /**
   * Validate first, then export.
   *
   * A clean project never sees a dialog: the preflight returns no findings and
   * the export starts exactly as it did before. Anything the render would refuse
   * is reported before a single frame is encoded, against the clip that caused it.
   */
  const handleExport = useCallback(async () => {
    if (!sequenceId || !outputPath) return;
    if (exportKind !== 'timeline' && useRange && (inPoint < 0 || inPoint >= outPoint)) {
      setStatus({ type: 'failed', error: 'In point must be before Out point.' });
      return;
    }

    // Audio-only and editable-timeline exports do not go through the video
    // render path the preflight validates, so there is nothing for it to check.
    if (exportKind !== 'video') {
      await startExport(null);
      return;
    }

    let videoRequest: VideoExportRequest;
    try {
      videoRequest = await resolveVideoExportRequest();
    } catch (error) {
      failWith(error);
      return;
    }

    try {
      const res = await commands.validateExport(
        sequenceId,
        outputPath,
        selectedPreset,
        videoRequest,
        useRange ? inPoint : null,
        useRange ? outPoint : null,
      );

      if (res.status === 'error') {
        failWith(String(res.error));
        return;
      }

      const { findings } = res.data;
      if (findings.length > 0) {
        pendingVideoRequestRef.current = videoRequest;
        setStatus({
          type: 'validation',
          findings,
          blocked: findings.some((finding) => finding.severity === 'error'),
        });
        return;
      }
    } catch (error) {
      failWith(error);
      return;
    }

    pendingVideoRequestRef.current = null;
    await startExport(videoRequest);
  }, [
    exportKind,
    failWith,
    inPoint,
    outPoint,
    outputPath,
    resolveVideoExportRequest,
    selectedPreset,
    sequenceId,
    startExport,
    useRange,
  ]);

  /**
   * Export past the preflight's warnings, at the user's explicit request.
   */
  const confirmExport = useCallback(async () => {
    if (status.type !== 'validation' || status.blocked) {
      return;
    }

    // Reuse the request the preflight validated. Re-resolving is only a
    // safety net: rendering a different request than the one that was
    // validated is exactly the drift the preflight exists to prevent.
    let videoRequest = pendingVideoRequestRef.current;
    if (!videoRequest) {
      try {
        videoRequest = await resolveVideoExportRequest();
      } catch (error) {
        failWith(error);
        return;
      }
    }

    pendingVideoRequestRef.current = null;
    await startExport(videoRequest);
  }, [failWith, resolveVideoExportRequest, startExport, status]);

  /**
   * Dismiss the preflight findings and return to the export settings.
   */
  const cancelValidation = useCallback(() => {
    pendingVideoRequestRef.current = null;
    setStatus({ type: 'idle' });
  }, []);

  /**
   * Reset to idle state for retry.
   */
  const handleRetry = useCallback(() => {
    currentJobIdRef.current = null;
    setCurrentJobId(null);
    pendingVideoRequestRef.current = null;
    setStatus({ type: 'idle' });
  }, []);

  // ===========================================================================
  // Computed Values
  // ===========================================================================
  const isExporting = status.type === 'exporting';
  const showSettings = status.type === 'idle';
  const canExport = useMemo(
    () => outputPath.length > 0 && sequenceId !== null,
    [outputPath, sequenceId],
  );

  // ===========================================================================
  // Return
  // ===========================================================================
  return {
    exportKind,
    setExportKind,
    selectedPreset,
    setSelectedPreset,
    selectedAudioFormat,
    setSelectedAudioFormat,
    selectedTimelineFormat,
    setSelectedTimelineFormat,
    outputPath,
    setOutputPath,
    status,
    isExporting,
    showSettings,
    canExport,
    handleBrowse,
    handleExport,
    confirmExport,
    cancelValidation,
    handleRetry,
  };
}
