import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ExportDialog } from './ExportDialog';

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
  const setExportKind = vi.fn();
  const setSelectedPreset = vi.fn();
  const setSelectedAudioFormat = vi.fn();
  const handleBrowse = vi.fn();
  const handleExport = vi.fn();
  const handleRetry = vi.fn();
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

    mockUseExportDialog.mockReturnValue({
      exportKind: 'video',
      setExportKind,
      selectedPreset: 'youtube_1080p',
      setSelectedPreset,
      selectedAudioFormat: 'wav',
      setSelectedAudioFormat,
      outputPath: 'D:/exports/out.mp4',
      status: { type: 'idle' },
      isExporting: false,
      showSettings: true,
      canExport: true,
      handleBrowse,
      handleExport,
      handleRetry,
    });

    mockUseRenderQueue.mockReturnValue({
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
    });
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
});
