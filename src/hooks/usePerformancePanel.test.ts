import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { usePerformancePanel } from './usePerformancePanel';
import { DESKTOP_RUNTIME_TEST_FLAG } from '@/services/runtimeEnvironment';

// Mock Tauri IPC — external boundary (OK to mock per project mock policy)
vi.mock('../bindings', () => ({
  commands: {
    getSystemMetrics: vi.fn(),
    detectGpuDevices: vi.fn(),
  },
}));

import { commands } from '../bindings';

const mockMetrics = {
  cpuUsagePercent: 42.5,
  ramTotalBytes: 16_000_000_000,
  ramUsedBytes: 8_000_000_000,
  processMemoryBytes: 250_000_000,
  diskReadBytes: 1_000_000,
  diskWriteBytes: 500_000,
  diskTotalBytes: 500_000_000_000,
  diskAvailableBytes: 200_000_000_000,
  cpuCoreCount: 8,
};

const mockGpuStatus = {
  devices: [{ name: 'NVIDIA RTX 4090', isPrimary: true }],
};

describe('usePerformancePanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    globalThis[DESKTOP_RUNTIME_TEST_FLAG] = true;
    vi.mocked(commands.getSystemMetrics).mockResolvedValue({
      status: 'ok',
      data: mockMetrics,
    } as never);
    vi.mocked(commands.detectGpuDevices).mockResolvedValue({
      status: 'ok',
      data: mockGpuStatus,
    } as never);
  });

  afterEach(() => {
    cleanup();
    delete globalThis[DESKTOP_RUNTIME_TEST_FLAG];
    vi.useRealTimers();
  });

  it('should fetch system metrics on mount when enabled', async () => {
    const { result } = renderHook(() => usePerformancePanel(true, 5000));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(commands.getSystemMetrics).toHaveBeenCalled();
    expect(result.current.system).toEqual(mockMetrics);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('should not fetch metrics when disabled', async () => {
    renderHook(() => usePerformancePanel(false, 5000));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });

    expect(commands.getSystemMetrics).not.toHaveBeenCalled();
  });

  it('should detect GPU name from primary device', async () => {
    const { result } = renderHook(() => usePerformancePanel(true, 5000));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(result.current.gpuName).toBe('NVIDIA RTX 4090');
  });

  it('should handle system metrics error gracefully', async () => {
    vi.mocked(commands.getSystemMetrics).mockResolvedValue({
      status: 'error',
      error: 'Permission denied',
    } as never);

    const { result } = renderHook(() => usePerformancePanel(true, 5000));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(result.current.error).toBe('Permission denied');
    expect(result.current.system).toBeNull();
    expect(result.current.isLoading).toBe(false);
  });

  it('should initialize FPS metrics to zero', () => {
    const { result } = renderHook(() => usePerformancePanel(false, 5000));

    expect(result.current.fpsMetrics.fps).toBe(0);
    expect(result.current.fpsMetrics.droppedFrames).toBe(0);
  });

  it('should provide refresh function that re-fetches metrics', async () => {
    const { result } = renderHook(() => usePerformancePanel(true, 5000));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    // Clear to check re-fetch
    vi.mocked(commands.getSystemMetrics).mockClear();

    await act(async () => {
      await result.current.refresh();
    });

    expect(commands.getSystemMetrics).toHaveBeenCalledTimes(1);
  });

  it('should stay idle when desktop runtime is unavailable', async () => {
    delete globalThis[DESKTOP_RUNTIME_TEST_FLAG];

    const { result } = renderHook(() => usePerformancePanel(true, 5000));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(commands.getSystemMetrics).not.toHaveBeenCalled();
    expect(commands.detectGpuDevices).not.toHaveBeenCalled();
    expect(result.current.isSupported).toBe(false);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.system).toBeNull();
    expect(result.current.error).toBeNull();
  });
});
