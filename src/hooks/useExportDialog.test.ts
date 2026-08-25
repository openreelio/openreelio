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

/** What the preflight returns for a project with nothing worth reporting. */
const CLEAN_PREFLIGHT = { isValid: true, findings: [] };

/**
 * Answers the preflight with a clean result and every other command with
 * `result`, so a test only has to describe the call it cares about.
 */
function mockBackend(result: unknown): void {
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === 'validate_export' ? CLEAN_PREFLIGHT : result,
  );
}

/** Builds one preflight finding. */
function finding(severity: 'error' | 'warning', message: string, clipId: string | null) {
  return { severity, message, clipId, sequenceId: 'sequence-1' };
}

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

  it('should default video export to the standard MP4 preset', () => {
    const { result } = renderHook(() =>
      useExportDialog({
        isOpen: true,
        sequenceId: 'sequence-1',
        sequenceName: 'Sequence',
      }),
    );

    expect(result.current.selectedPreset).toBe('youtube_1080p');
  });

  it('should call render_range when range export is enabled', async () => {
    mockBackend({
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
      settings: expect.objectContaining({
        container: 'mp4',
        videoCodec: 'h264',
        qualityTier: 'standard',
      }),
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

  it('should call export_audio_only when audio export is selected', async () => {
    vi.mocked(invoke).mockResolvedValue({
      jobId: 'job-1',
      outputPath: '/tmp/out.m4a',
      status: 'started',
    });

    const { result } = renderHook(() =>
      useExportDialog({
        isOpen: true,
        sequenceId: 'sequence-1',
        sequenceName: 'Sequence',
        initialExportKind: 'audio',
        useRange: true,
        inPoint: 3,
        outPoint: 7.5,
      }),
    );

    act(() => {
      result.current.setOutputPath('/tmp/out.m4a');
      result.current.setSelectedAudioFormat('m4a');
    });

    await act(async () => {
      await result.current.handleExport();
    });

    expect(invoke).toHaveBeenCalledWith('export_audio_only', {
      sequenceId: 'sequence-1',
      format: 'm4a',
      outputPath: '/tmp/out.m4a',
      bitrate: null,
      sampleRate: null,
      startTime: 3,
      endTime: 7.5,
    });
  });

  it('should call start_render with structured video settings for video export', async () => {
    mockBackend({
      jobId: 'job-1',
      outputPath: '/tmp/out.mp4',
      status: 'started',
    });

    const { result } = renderHook(() =>
      useExportDialog({
        isOpen: true,
        sequenceId: 'sequence-1',
        sequenceName: 'Sequence',
      }),
    );

    act(() => {
      result.current.setOutputPath('/tmp/out.mp4');
      result.current.setSelectedPreset('mp4_high');
    });

    await act(async () => {
      await result.current.handleExport();
    });

    expect(invoke).toHaveBeenCalledWith('start_render', {
      sequenceId: 'sequence-1',
      outputPath: '/tmp/out.mp4',
      preset: 'mp4_high',
      settings: expect.objectContaining({
        container: 'mp4',
        videoCodec: 'h264',
        qualityTier: 'high',
        crf: 18,
      }),
    });
  });

  it('should merge sequence HDR settings into video export requests', async () => {
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === 'validate_export') {
        return CLEAN_PREFLIGHT;
      }
      if (command === 'get_sequence_hdr_settings') {
        return {
          hdrMode: 'hdr10',
          bitDepth: 10,
          maxCll: 1000,
          maxFall: 400,
        };
      }

      return {
        jobId: 'job-1',
        outputPath: '/tmp/out.mp4',
        status: 'started',
      };
    });

    const { result } = renderHook(() =>
      useExportDialog({
        isOpen: true,
        sequenceId: 'sequence-1',
        sequenceName: 'Sequence',
      }),
    );

    act(() => {
      result.current.setOutputPath('/tmp/out.mp4');
      result.current.setSelectedPreset('mp4_high');
    });

    await act(async () => {
      await result.current.handleExport();
    });

    expect(invoke).toHaveBeenCalledWith('start_render', {
      sequenceId: 'sequence-1',
      outputPath: '/tmp/out.mp4',
      preset: 'mp4_high',
      settings: expect.objectContaining({
        videoCodec: 'h265',
        hdrMode: 'hdr_10',
        bitDepth: 10,
        maxCll: 1000,
        maxFall: 400,
      }),
    });
  });

  it('should route editable timeline exports to FCPXML without starting a render job', async () => {
    vi.mocked(invoke).mockResolvedValue({
      format: 'fcpxml',
      outputPath: '/tmp/sequence.fcpxml',
      eventCount: 2,
      trackCount: 1,
      durationSec: 10,
    });

    const { result } = renderHook(() =>
      useExportDialog({
        isOpen: true,
        sequenceId: 'sequence-1',
        sequenceName: 'Sequence',
        initialExportKind: 'timeline',
      }),
    );

    act(() => {
      result.current.setOutputPath('/tmp/sequence.fcpxml');
      result.current.setSelectedTimelineFormat('fcpxml');
    });

    await act(async () => {
      await result.current.handleExport();
    });

    expect(invoke).toHaveBeenCalledWith('export_fcpxml', {
      sequenceId: 'sequence-1',
      outputPath: '/tmp/sequence.fcpxml',
    });
    expect(invoke).not.toHaveBeenCalledWith('start_render', expect.anything());
  });

  it('should route editable timeline exports to EDL and update the extension', async () => {
    vi.mocked(invoke).mockResolvedValue({
      format: 'edl',
      outputPath: '/tmp/sequence.edl',
      eventCount: 2,
      trackCount: 1,
      durationSec: 10,
    });

    const { result } = renderHook(() =>
      useExportDialog({
        isOpen: true,
        sequenceId: 'sequence-1',
        sequenceName: 'Sequence',
        initialExportKind: 'timeline',
      }),
    );

    act(() => {
      result.current.setOutputPath('/tmp/sequence.fcpxml');
      result.current.setSelectedTimelineFormat('edl');
    });

    await waitFor(() => {
      expect(result.current.outputPath).toBe('/tmp/sequence.edl');
    });

    await act(async () => {
      await result.current.handleExport();
    });

    expect(invoke).toHaveBeenCalledWith('export_edl', {
      sequenceId: 'sequence-1',
      outputPath: '/tmp/sequence.edl',
    });
    expect(invoke).not.toHaveBeenCalledWith('start_render', expect.anything());
  });

  it('should ignore invalid render ranges when exporting editable timelines', async () => {
    vi.mocked(invoke).mockResolvedValue({
      format: 'fcpxml',
      outputPath: '/tmp/sequence.fcpxml',
      eventCount: 2,
      trackCount: 1,
      durationSec: 10,
    });

    const { result } = renderHook(() =>
      useExportDialog({
        isOpen: true,
        sequenceId: 'sequence-1',
        sequenceName: 'Sequence',
        initialExportKind: 'timeline',
        useRange: true,
        inPoint: 8,
        outPoint: 4,
      }),
    );

    act(() => {
      result.current.setOutputPath('/tmp/sequence.fcpxml');
    });

    await act(async () => {
      await result.current.handleExport();
    });

    expect(invoke).toHaveBeenCalledWith('export_fcpxml', {
      sequenceId: 'sequence-1',
      outputPath: '/tmp/sequence.fcpxml',
    });
    expect(result.current.status).toEqual({
      type: 'completed',
      outputPath: '/tmp/sequence.fcpxml',
      duration: 0,
    });
  });

  describe('export preflight', () => {
    const renderVideoDialog = () =>
      renderHook(() =>
        useExportDialog({
          isOpen: true,
          sequenceId: 'sequence-1',
          sequenceName: 'Sequence',
        }),
      );

    const configureVideoExport = (result: ReturnType<typeof renderVideoDialog>['result']) => {
      act(() => {
        result.current.setOutputPath('/tmp/out.mp4');
        result.current.setSelectedPreset('mp4_high');
      });
    };

    it('should start the render without a prompt when the preflight finds nothing', async () => {
      mockBackend({ jobId: 'job-1', outputPath: '/tmp/out.mp4', status: 'started' });

      const { result } = renderVideoDialog();
      configureVideoExport(result);

      await act(async () => {
        await result.current.handleExport();
      });

      expect(invoke).toHaveBeenCalledWith('start_render', expect.anything());
      expect(result.current.status.type).toBe('exporting');
    });

    it('should block the export and never render when the preflight reports an error', async () => {
      vi.mocked(invoke).mockImplementation(async (command) => {
        if (command === 'validate_export') {
          return {
            isValid: false,
            findings: [finding('error', 'Layered video is not supported', 'pip-clip')],
          };
        }
        return { jobId: 'job-1', outputPath: '/tmp/out.mp4', status: 'started' };
      });

      const { result } = renderVideoDialog();
      configureVideoExport(result);

      await act(async () => {
        await result.current.handleExport();
      });

      expect(result.current.status).toEqual({
        type: 'validation',
        blocked: true,
        findings: [finding('error', 'Layered video is not supported', 'pip-clip')],
      });
      expect(invoke).not.toHaveBeenCalledWith('start_render', expect.anything());
    });

    it('should render only after the user confirms a warning-only preflight', async () => {
      vi.mocked(invoke).mockImplementation(async (command) => {
        if (command === 'validate_export') {
          return {
            isValid: true,
            findings: [finding('warning', 'Motion keyframes render static', 'moving-clip')],
          };
        }
        return { jobId: 'job-1', outputPath: '/tmp/out.mp4', status: 'started' };
      });

      const { result } = renderVideoDialog();
      configureVideoExport(result);

      await act(async () => {
        await result.current.handleExport();
      });

      expect(result.current.status).toEqual({
        type: 'validation',
        blocked: false,
        findings: [finding('warning', 'Motion keyframes render static', 'moving-clip')],
      });
      expect(invoke).not.toHaveBeenCalledWith('start_render', expect.anything());

      await act(async () => {
        await result.current.confirmExport();
      });

      expect(invoke).toHaveBeenCalledWith('start_render', expect.anything());
      expect(result.current.status.type).toBe('exporting');
    });

    it('should return to the settings without rendering when the preflight is cancelled', async () => {
      vi.mocked(invoke).mockImplementation(async (command) => {
        if (command === 'validate_export') {
          return {
            isValid: true,
            findings: [finding('warning', 'Motion keyframes render static', 'moving-clip')],
          };
        }
        return { jobId: 'job-1', outputPath: '/tmp/out.mp4', status: 'started' };
      });

      const { result } = renderVideoDialog();
      configureVideoExport(result);

      await act(async () => {
        await result.current.handleExport();
      });

      act(() => {
        result.current.cancelValidation();
      });

      expect(result.current.status).toEqual({ type: 'idle' });
      expect(result.current.showSettings).toBe(true);
      expect(invoke).not.toHaveBeenCalledWith('start_render', expect.anything());
    });
  });

  it('should browse with audio-specific filters when audio export is selected', async () => {
    vi.mocked(invoke).mockResolvedValue('/tmp/out.ogg');

    const { result } = renderHook(() =>
      useExportDialog({
        isOpen: true,
        sequenceId: 'sequence-1',
        sequenceName: 'Sequence',
        initialExportKind: 'audio',
      }),
    );

    act(() => {
      result.current.setSelectedAudioFormat('ogg');
    });

    await act(async () => {
      await result.current.handleBrowse();
    });

    expect(invoke).toHaveBeenCalledWith('pick_export_destination', {
      defaultName: 'Sequence.ogg',
      filters: [{ name: 'Ogg Audio', extensions: ['ogg'] }],
      title: 'Export Audio',
    });
    expect(result.current.outputPath).toBe('/tmp/out.ogg');
  });

  it('should update the output extension when switching export kind', async () => {
    const { result } = renderHook(() =>
      useExportDialog({
        isOpen: true,
        sequenceId: 'sequence-1',
        sequenceName: 'Sequence',
      }),
    );

    act(() => {
      result.current.setOutputPath('/tmp/final.mp4');
      result.current.setExportKind('audio');
    });

    await waitFor(() => {
      expect(result.current.outputPath).toBe('/tmp/final.wav');
    });
  });

  it('should update the output extension when switching to editable timeline export', async () => {
    const { result } = renderHook(() =>
      useExportDialog({
        isOpen: true,
        sequenceId: 'sequence-1',
        sequenceName: 'Sequence',
      }),
    );

    act(() => {
      result.current.setOutputPath('/tmp/final.mp4');
      result.current.setExportKind('timeline');
    });

    await waitFor(() => {
      expect(result.current.outputPath).toBe('/tmp/final.fcpxml');
    });
  });

  it('should update the output extension when changing audio format', async () => {
    const { result } = renderHook(() =>
      useExportDialog({
        isOpen: true,
        sequenceId: 'sequence-1',
        sequenceName: 'Sequence',
        initialExportKind: 'audio',
      }),
    );

    act(() => {
      result.current.setOutputPath('/tmp/final.wav');
      result.current.setSelectedAudioFormat('ogg');
    });

    await waitFor(() => {
      expect(result.current.outputPath).toBe('/tmp/final.ogg');
    });
  });
});
