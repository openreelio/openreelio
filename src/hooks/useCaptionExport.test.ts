/**
 * useCaptionExport Hook Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useCaptionExport } from './useCaptionExport';
import type { Caption } from '@/types';

// Mock Tauri APIs
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  save: vi.fn(),
}));

const mockCaptions: Caption[] = [
  {
    id: 'cap-1',
    startSec: 0.0,
    endSec: 2.5,
    text: 'Hello World',
    speaker: undefined,
    styleOverride: undefined,
    positionOverride: undefined,
  },
  {
    id: 'cap-2',
    startSec: 3.0,
    endSec: 5.5,
    text: 'Second caption',
    speaker: 'Alice',
    styleOverride: undefined,
    positionOverride: undefined,
  },
];

describe('useCaptionExport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should initialize with default state', () => {
    const { result } = renderHook(() => useCaptionExport());

    expect(result.current.isExporting).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('should export captions to a file', async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    const { save } = await import('@tauri-apps/plugin-dialog');

    vi.mocked(save).mockResolvedValue('/path/to/captions.srt');
    vi.mocked(invoke).mockResolvedValue(undefined);

    const { result } = renderHook(() => useCaptionExport());

    let success: boolean = false;
    await act(async () => {
      success = await result.current.exportToFile(mockCaptions, 'srt');
    });

    expect(success).toBe(true);
    expect(invoke).toHaveBeenCalledWith('export_captions', {
      captions: expect.arrayContaining([
        expect.objectContaining({
          startSec: 0.0,
          endSec: 2.5,
          text: 'Hello World',
        }),
      ]),
      outputPath: '/path/to/captions.srt',
      format: 'srt',
    });
  });

  it('should return false when user cancels dialog', async () => {
    const { save } = await import('@tauri-apps/plugin-dialog');
    vi.mocked(save).mockResolvedValue(null);

    const { result } = renderHook(() => useCaptionExport());

    let success: boolean = true;
    await act(async () => {
      success = await result.current.exportToFile(mockCaptions, 'srt');
    });

    expect(success).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('should return false for empty captions', async () => {
    const { result } = renderHook(() => useCaptionExport());

    let success: boolean = true;
    await act(async () => {
      success = await result.current.exportToFile([], 'srt');
    });

    expect(success).toBe(false);
    expect(result.current.error).toBe('No captions to export');
  });

  it('should handle export errors', async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    const { save } = await import('@tauri-apps/plugin-dialog');

    vi.mocked(save).mockResolvedValue('/path/to/captions.srt');
    vi.mocked(invoke).mockRejectedValue(new Error('Export failed'));

    const { result } = renderHook(() => useCaptionExport());

    let success: boolean = true;
    await act(async () => {
      success = await result.current.exportToFile(mockCaptions, 'srt');
    });

    expect(success).toBe(false);
    expect(result.current.error).toBe('Export failed');
  });

  it('should export to a specific path', async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    vi.mocked(invoke).mockResolvedValue(undefined);

    const { result } = renderHook(() => useCaptionExport());

    let success: boolean = false;
    await act(async () => {
      success = await result.current.exportToPath(mockCaptions, '/custom/path.vtt', 'vtt');
    });

    expect(success).toBe(true);
    expect(invoke).toHaveBeenCalledWith('export_captions', {
      captions: expect.any(Array),
      outputPath: '/custom/path.vtt',
      format: 'vtt',
    });
  });

  it('should get captions as string', async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    const mockContent = 'WEBVTT\n\n00:00:00.000 --> 00:00:02.500\nHello World';
    vi.mocked(invoke).mockResolvedValue(mockContent);

    const { result } = renderHook(() => useCaptionExport());

    let content: string | null = null;
    await act(async () => {
      content = await result.current.getAsString(mockCaptions, 'vtt');
    });

    expect(content).toBe(mockContent);
    expect(invoke).toHaveBeenCalledWith('get_captions_as_string', {
      captions: expect.any(Array),
      format: 'vtt',
    });
  });

  it('should clear error', async () => {
    const { result } = renderHook(() => useCaptionExport());

    // Trigger an error
    await act(async () => {
      await result.current.exportToFile([], 'srt');
    });

    expect(result.current.error).toBe('No captions to export');

    // Clear the error
    act(() => {
      result.current.clearError();
    });

    expect(result.current.error).toBeNull();
  });

  it('should convert captions with speakers correctly', async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    const { save } = await import('@tauri-apps/plugin-dialog');

    vi.mocked(save).mockResolvedValue('/path/to/captions.srt');
    vi.mocked(invoke).mockResolvedValue(undefined);

    const { result } = renderHook(() => useCaptionExport());

    await act(async () => {
      await result.current.exportToFile(mockCaptions, 'srt');
    });

    expect(invoke).toHaveBeenCalledWith('export_captions', {
      captions: expect.arrayContaining([
        expect.objectContaining({
          speaker: null,
        }),
        expect.objectContaining({
          speaker: 'Alice',
        }),
      ]),
      outputPath: '/path/to/captions.srt',
      format: 'srt',
    });
  });

  it('should set isExporting during export', async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    const { save } = await import('@tauri-apps/plugin-dialog');

    let resolveInvoke: (value: unknown) => void;
    const invokePromise = new Promise((resolve) => {
      resolveInvoke = resolve;
    });

    vi.mocked(save).mockResolvedValue('/path/to/captions.srt');
    vi.mocked(invoke).mockImplementation(() => invokePromise);

    const { result } = renderHook(() => useCaptionExport());

    // Start export
    let exportPromise: Promise<boolean>;
    act(() => {
      exportPromise = result.current.exportToFile(mockCaptions, 'srt');
    });

    // Should be exporting
    expect(result.current.isExporting).toBe(true);

    // Complete export
    await act(async () => {
      resolveInvoke!(undefined);
      await exportPromise;
    });

    expect(result.current.isExporting).toBe(false);
  });
});
