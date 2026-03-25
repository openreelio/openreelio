/**
 * useExportDialog Hook Tests
 *
 * Verifies the dialog wires listeners eagerly and routes range exports
 * to the dedicated backend command.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useExportDialog } from './useExportDialog';

vi.mock('@tauri-apps/plugin-dialog', () => ({
  save: vi.fn(),
}));

describe('useExportDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should register render event listeners when the dialog opens', async () => {
    renderHook(() =>
      useExportDialog({
        isOpen: true,
        sequenceId: 'sequence-1',
        sequenceName: 'Sequence',
      }),
    );

    await waitFor(() => {
      expect(listen).toHaveBeenCalledWith('render-progress', expect.any(Function));
      expect(listen).toHaveBeenCalledWith('render-complete', expect.any(Function));
      expect(listen).toHaveBeenCalledWith('render-error', expect.any(Function));
    });
  });

  it('should call render_range when range export is enabled', async () => {
    vi.mocked(invoke).mockResolvedValue({
      jobId: 'job-1',
      outputPath: '/tmp/out.mp4',
      status: 'started',
    });

    const { result } = renderHook(() =>
      useExportDialog({
        isOpen: true,
        sequenceId: 'sequence-1',
        sequenceName: 'Sequence',
        useRange: true,
        inPoint: 3,
        outPoint: 7.5,
      }),
    );

    act(() => {
      result.current.setOutputPath('/tmp/out.mp4');
      result.current.setSelectedPreset('youtube_1080p');
    });

    await act(async () => {
      await result.current.handleExport();
    });

    expect(invoke).toHaveBeenCalledWith('render_range', {
      sequenceId: 'sequence-1',
      outputPath: '/tmp/out.mp4',
      preset: 'youtube_1080p',
      inPoint: 3,
      outPoint: 7.5,
    });
  });

  it('should fail fast when the selected range is invalid', async () => {
    const { result } = renderHook(() =>
      useExportDialog({
        isOpen: true,
        sequenceId: 'sequence-1',
        sequenceName: 'Sequence',
        useRange: true,
        inPoint: 8,
        outPoint: 4,
      }),
    );

    act(() => {
      result.current.setOutputPath('/tmp/out.mp4');
    });

    await act(async () => {
      await result.current.handleExport();
    });

    expect(invoke).not.toHaveBeenCalled();
    expect(result.current.status).toEqual({
      type: 'failed',
      error: 'In point must be before Out point.',
    });
  });
});
