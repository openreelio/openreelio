/**
 * useFFmpegStatus Hook Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useFFmpegStatus } from './useFFmpegStatus';

// Mock Tauri invoke
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

import { invoke } from '@tauri-apps/api/core';

const mockInvoke = vi.mocked(invoke);

describe('useFFmpegStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  // ===========================================================================
  // Initial State Tests
  // ===========================================================================

  it('starts with loading state', () => {
    mockInvoke.mockImplementation(() => new Promise(() => {})); // Never resolves

    const { result } = renderHook(() => useFFmpegStatus());

    expect(result.current.isLoading).toBe(true);
    expect(result.current.status).toBe(null);
    expect(result.current.error).toBe(null);
  });

  // ===========================================================================
  // Success Tests
  // ===========================================================================

  it('returns FFmpeg status when available', async () => {
    mockInvoke.mockResolvedValueOnce({
      available: true,
      version: '6.0',
      isBundled: false,
      ffmpegPath: '/usr/bin/ffmpeg',
      ffprobePath: '/usr/bin/ffprobe',
    });

    const { result } = renderHook(() => useFFmpegStatus());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.status).toEqual({
      available: true,
      version: '6.0',
      isBundled: false,
      ffmpegPath: '/usr/bin/ffmpeg',
      ffprobePath: '/usr/bin/ffprobe',
    });
    expect(result.current.isAvailable).toBe(true);
    expect(result.current.error).toBe(null);
  });

  it('returns unavailable status when FFmpeg not found', async () => {
    mockInvoke.mockResolvedValueOnce({
      available: false,
      version: null,
      isBundled: false,
      ffmpegPath: null,
      ffprobePath: null,
    });

    const { result } = renderHook(() => useFFmpegStatus());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.status?.available).toBe(false);
    expect(result.current.isAvailable).toBe(false);
  });

  // ===========================================================================
  // Error Tests
  // ===========================================================================

  it('handles invoke error', async () => {
    mockInvoke.mockRejectedValueOnce(new Error('IPC error'));

    const { result } = renderHook(() => useFFmpegStatus());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.error).toBe('IPC error');
    expect(result.current.isAvailable).toBe(false);
  });

  it('handles string error', async () => {
    mockInvoke.mockRejectedValueOnce('Connection failed');

    const { result } = renderHook(() => useFFmpegStatus());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.error).toBe('Connection failed');
  });

  // ===========================================================================
  // Recheck Tests
  // ===========================================================================

  it('can recheck FFmpeg status', async () => {
    mockInvoke
      .mockResolvedValueOnce({
        available: false,
        version: null,
        isBundled: false,
        ffmpegPath: null,
        ffprobePath: null,
      })
      .mockResolvedValueOnce({
        available: true,
        version: '6.0',
        isBundled: false,
        ffmpegPath: '/usr/bin/ffmpeg',
        ffprobePath: '/usr/bin/ffprobe',
      });

    const { result } = renderHook(() => useFFmpegStatus());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.isAvailable).toBe(false);

    await act(async () => {
      await result.current.recheck();
    });

    expect(result.current.isAvailable).toBe(true);
    expect(mockInvoke).toHaveBeenCalledTimes(2);
  });

  // ===========================================================================
  // IPC Call Tests
  // ===========================================================================

  it('calls check_ffmpeg IPC command', async () => {
    mockInvoke.mockResolvedValueOnce({
      available: true,
      version: '6.0',
      isBundled: false,
      ffmpegPath: '/usr/bin/ffmpeg',
      ffprobePath: '/usr/bin/ffprobe',
    });

    renderHook(() => useFFmpegStatus());

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('check_ffmpeg');
    });
  });

  // ===========================================================================
  // Bundled FFmpeg Tests
  // ===========================================================================

  it('detects bundled FFmpeg', async () => {
    mockInvoke.mockResolvedValueOnce({
      available: true,
      version: '6.1.1',
      isBundled: true,
      ffmpegPath: '/app/resources/binaries/ffmpeg',
      ffprobePath: '/app/resources/binaries/ffprobe',
    });

    const { result } = renderHook(() => useFFmpegStatus());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.status?.isBundled).toBe(true);
    expect(result.current.status?.available).toBe(true);
    expect(result.current.status?.version).toBe('6.1.1');
    expect(result.current.isAvailable).toBe(true);
  });

  it('falls back to system FFmpeg when bundled not found', async () => {
    mockInvoke.mockResolvedValueOnce({
      available: true,
      version: '5.1.4',
      isBundled: false,
      ffmpegPath: '/usr/local/bin/ffmpeg',
      ffprobePath: '/usr/local/bin/ffprobe',
    });

    const { result } = renderHook(() => useFFmpegStatus());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.status?.isBundled).toBe(false);
    expect(result.current.status?.available).toBe(true);
    expect(result.current.isAvailable).toBe(true);
  });

  it('shows unavailable when no FFmpeg found (bundled or system)', async () => {
    mockInvoke.mockResolvedValueOnce({
      available: false,
      version: null,
      isBundled: false,
      ffmpegPath: null,
      ffprobePath: null,
    });

    const { result } = renderHook(() => useFFmpegStatus());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.status?.isBundled).toBe(false);
    expect(result.current.status?.available).toBe(false);
    expect(result.current.isAvailable).toBe(false);
  });

  it('detects bundled FFmpeg on Windows', async () => {
    mockInvoke.mockResolvedValueOnce({
      available: true,
      version: '6.1.1',
      isBundled: true,
      ffmpegPath: 'C:\\Program Files\\OpenReelio\\resources\\binaries\\ffmpeg.exe',
      ffprobePath: 'C:\\Program Files\\OpenReelio\\resources\\binaries\\ffprobe.exe',
    });

    const { result } = renderHook(() => useFFmpegStatus());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.status?.isBundled).toBe(true);
    expect(result.current.status?.ffmpegPath).toContain('ffmpeg.exe');
    expect(result.current.status?.ffprobePath).toContain('ffprobe.exe');
  });
});
