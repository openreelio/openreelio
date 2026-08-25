import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ExportDialog } from './ExportDialog';
import { usePlaybackStore } from '@/stores/playbackStore';
import { useProjectStore } from '@/stores/projectStore';
import { useTimelineStore } from '@/stores/timelineStore';
import type { Sequence } from '@/types';

const { mockUseExportDialog, mockUseRenderQueue, mockGetAvailableEncoders } = vi.hoisted(() => ({
  mockUseExportDialog: vi.fn(),
  mockUseRenderQueue: vi.fn(),
  mockGetAvailableEncoders: vi.fn(),
}));

vi.mock('@/hooks/useExportDialog', () => ({
  useExportDialog: mockUseExportDialog,
}));

vi.mock('@/hooks/useRenderQueue', () => ({
  useRenderQueue: mockUseRenderQueue,
}));

vi.mock('@/bindings', () => ({
  commands: {
    getAvailableEncoders: mockGetAvailableEncoders,
  },
}));

describe('ExportDialog', () => {
  let exportDialogState: Record<string, unknown>;
  let renderQueueState: Record<string, unknown>;
  const setExportKind = vi.fn();
  const setSelectedPreset = vi.fn();
  const setSelectedAudioFormat = vi.fn();
  const setSelectedTimelineFormat = vi.fn();
  const handleBrowse = vi.fn();
  const handleExport = vi.fn();
  const handleRetry = vi.fn();
  const confirmExport = vi.fn();
  const cancelValidation = vi.fn();
  const resetQueue = vi.fn();
  const addToQueue = vi.fn();
  const startBatchRender = vi.fn();
  const cancelJob = vi.fn();
  const removeFromQueue = vi.fn();
  const setUseRange = vi.fn();
  const setInPoint = vi.fn();
  const setOutPoint = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();

    mockGetAvailableEncoders.mockResolvedValue({
      status: 'ok',
      data: {
        hasHardware: true,
        hardware: [{ displayName: 'NVENC' }],
      },
    });

    exportDialogState = {
      exportKind: 'video',
      setExportKind,
      selectedPreset: 'youtube_1080p',
      setSelectedPreset,
      selectedAudioFormat: 'wav',
      setSelectedAudioFormat,
      selectedTimelineFormat: 'fcpxml',
      setSelectedTimelineFormat,
      outputPath: 'D:/exports/out.mp4',
      status: { type: 'idle' },
      isExporting: false,
      showSettings: true,
      canExport: true,
      handleBrowse,
      handleExport,
      confirmExport,
      cancelValidation,
      handleRetry,
    };
    mockUseExportDialog.mockImplementation(() => exportDialogState);

    renderQueueState = {
      queue: [],
      isBatchRendering: false,
      batchId: null,
      batchProgress: 0,
      useRange: false,
      setUseRange,
      inPoint: 0,
      setInPoint,
      outPoint: 10,
      setOutPoint,
      addToQueue,
      removeFromQueue,
      clearQueue: vi.fn(),
      startBatchRender,
      cancelJob,
      resetQueue,
    };
    mockUseRenderQueue.mockImplementation(() => renderQueueState);
  });

  it('queries available encoders only once when opened in video mode', async () => {
    render(
      <ExportDialog isOpen onClose={vi.fn()} sequenceId="sequence-1" sequenceName="Sequence" />,
    );

    await waitFor(() => {
      expect(mockGetAvailableEncoders).toHaveBeenCalledTimes(1);
    });
  });

  it('defers queue reset until after the dialog closes', async () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <ExportDialog isOpen onClose={onClose} sequenceId="sequence-1" sequenceName="Sequence" />,
    );

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(resetQueue).not.toHaveBeenCalled();

    rerender(
      <ExportDialog
        isOpen={false}
        onClose={onClose}
        sequenceId="sequence-1"
        sequenceName="Sequence"
      />,
    );

    await waitFor(() => {
      expect(resetQueue).toHaveBeenCalledTimes(1);
    });
  });

  it('resets queue when a background batch finishes after the dialog closes', async () => {
    const onClose = vi.fn();
    renderQueueState = {
      ...renderQueueState,
      isBatchRendering: true,
    };

    const { rerender } = render(
      <ExportDialog isOpen onClose={onClose} sequenceId="sequence-1" sequenceName="Sequence" />,
    );

    rerender(
      <ExportDialog
        isOpen={false}
        onClose={onClose}
        sequenceId="sequence-1"
        sequenceName="Sequence"
      />,
    );

    expect(resetQueue).not.toHaveBeenCalled();

    renderQueueState = {
      ...renderQueueState,
      isBatchRendering: false,
    };

    rerender(
      <ExportDialog
        isOpen={false}
        onClose={onClose}
        sequenceId="sequence-1"
        sequenceName="Sequence"
      />,
    );

    await waitFor(() => {
      expect(resetQueue).toHaveBeenCalledTimes(1);
    });
  });

  it('does not block timeline export when a stale video range is invalid', () => {
    exportDialogState = {
      ...exportDialogState,
      exportKind: 'timeline',
      outputPath: 'D:/exports/timeline.fcpxml',
    };
    renderQueueState = {
      ...renderQueueState,
      useRange: true,
      inPoint: 8,
      outPoint: 4,
    };

    render(
      <ExportDialog isOpen onClose={vi.fn()} sequenceId="sequence-1" sequenceName="Sequence" />,
    );

    expect(screen.getByRole('button', { name: /export timeline/i })).not.toBeDisabled();
  });

  describe('preflight findings', () => {
    const OFFENDING_CLIP_ID = 'pip-clip';
    const CLIP_TIMELINE_IN_SEC = 4.5;

    const showFindings = (blocked: boolean) => {
      exportDialogState = {
        ...exportDialogState,
        showSettings: false,
        status: {
          type: 'validation',
          blocked,
          findings: [
            {
              severity: blocked ? 'error' : 'warning',
              message: 'Motion keyframes render static',
              clipId: OFFENDING_CLIP_ID,
              sequenceId: 'sequence-1',
            },
            {
              severity: 'warning',
              message: 'Sequence-level advisory',
              clipId: null,
              sequenceId: 'sequence-1',
            },
          ],
        },
      };
    };

    beforeEach(() => {
      const sequence = {
        id: 'sequence-1',
        tracks: [
          {
            clips: [
              {
                id: OFFENDING_CLIP_ID,
                place: { timelineInSec: CLIP_TIMELINE_IN_SEC },
              },
            ],
          },
        ],
      } as unknown as Sequence;

      useProjectStore.setState({
        sequences: new Map([['sequence-1', sequence]]),
        activeSequenceId: 'sequence-1',
      });
      useTimelineStore.getState().clearClipSelection();
      usePlaybackStore.setState({ duration: 60, currentTime: 0 });
    });

    it('reveals the offending clip when a finding row is selected', async () => {
      showFindings(false);

      render(
        <ExportDialog isOpen onClose={vi.fn()} sequenceId="sequence-1" sequenceName="Sequence" />,
      );
      // The dialog probes the encoder list on open; let it settle first.
      await waitFor(() => expect(mockGetAvailableEncoders).toHaveBeenCalled());

      fireEvent.click(screen.getByTestId(`export-finding-${OFFENDING_CLIP_ID}`));

      expect(useTimelineStore.getState().selectedClipIds).toEqual([OFFENDING_CLIP_ID]);
      expect(usePlaybackStore.getState().currentTime).toBe(CLIP_TIMELINE_IN_SEC);
    });

    it('offers no way past a blocking finding', async () => {
      showFindings(true);

      render(
        <ExportDialog isOpen onClose={vi.fn()} sequenceId="sequence-1" sequenceName="Sequence" />,
      );
      // The dialog probes the encoder list on open; let it settle first.
      await waitFor(() => expect(mockGetAvailableEncoders).toHaveBeenCalled());

      expect(screen.queryByTestId('export-validation-proceed')).not.toBeInTheDocument();
      expect(screen.getByTestId('export-validation-cancel')).toBeInTheDocument();
    });

    it('lets the user export past warnings', async () => {
      showFindings(false);

      render(
        <ExportDialog isOpen onClose={vi.fn()} sequenceId="sequence-1" sequenceName="Sequence" />,
      );
      // The dialog probes the encoder list on open; let it settle first.
      await waitFor(() => expect(mockGetAvailableEncoders).toHaveBeenCalled());

      fireEvent.click(screen.getByTestId('export-validation-proceed'));

      expect(confirmExport).toHaveBeenCalledTimes(1);
    });

    it('renders a finding with no clip as plain text', async () => {
      showFindings(false);

      render(
        <ExportDialog isOpen onClose={vi.fn()} sequenceId="sequence-1" sequenceName="Sequence" />,
      );
      // The dialog probes the encoder list on open; let it settle first.
      await waitFor(() => expect(mockGetAvailableEncoders).toHaveBeenCalled());

      expect(screen.getByText('Sequence-level advisory').tagName).toBe('P');
    });
  });
});
