import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PerformancePanel } from './PerformancePanel';

// Mock only external boundaries: Tauri IPC and runtime detection
vi.mock('@/bindings', () => ({
  commands: {
    getSystemMetrics: vi.fn(),
    detectGpuDevices: vi.fn(),
  },
}));

vi.mock('@/services/runtimeEnvironment', () => ({
  isDesktopRuntimeAvailable: vi.fn(),
}));

import { commands } from '@/bindings';
import { isDesktopRuntimeAvailable } from '@/services/runtimeEnvironment';

const mockMetrics = {
  cpuUsagePercent: 55.3,
  ramTotalBytes: 16_000_000_000,
  ramUsedBytes: 10_400_000_000,
  processMemoryBytes: 320_000_000,
  diskReadBytes: 2_000_000,
  diskWriteBytes: 1_500_000,
  diskTotalBytes: 500_000_000_000,
  diskAvailableBytes: 150_000_000_000,
  cpuCoreCount: 8,
};

const mockGpuStatus = {
  enabled: true,
  devices: [
    {
      id: 'gpu-nvidia',
      name: 'NVIDIA RTX 4090',
      vendor: 'NVIDIA',
      hasEncode: true,
      hasDecode: true,
      isPrimary: true,
    },
  ],
  activeDeviceId: 'gpu-nvidia',
  availableDecoders: {
    hardware: [
      { backend: 'cuda', displayName: 'NVIDIA CUDA', hwaccelName: 'cuda' },
    ],
    hasHardware: true,
  },
  availableEncoders: {
    hardware: [
      {
        backend: 'nvenc',
        displayName: 'NVIDIA NVENC',
        h264Encoder: 'h264_nvenc',
        h265Encoder: 'hevc_nvenc',
      },
    ],
    hasHardware: true,
  },
};

describe('PerformancePanel', () => {
  beforeEach(() => {
    vi.mocked(isDesktopRuntimeAvailable).mockReturnValue(true);
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
    vi.restoreAllMocks();
  });

  it('should display loading state initially', () => {
    // Metrics promise never resolves — component stays in loading
    vi.mocked(commands.getSystemMetrics).mockReturnValue(new Promise(() => {}) as never);
    vi.mocked(commands.detectGpuDevices).mockReturnValue(new Promise(() => {}) as never);

    render(<PerformancePanel />);
    expect(screen.getByText('Loading metrics...')).toBeTruthy();
  });

  it('should display error state with retry button', async () => {
    vi.mocked(commands.getSystemMetrics).mockResolvedValue({
      status: 'error',
      error: 'Connection failed',
    } as never);

    render(<PerformancePanel />);

    await waitFor(() => {
      expect(screen.getByText(/Connection failed/)).toBeTruthy();
    });
    expect(screen.getByText('Retry')).toBeTruthy();
  });

  it('should render all metric sections when data is available', async () => {
    render(<PerformancePanel />);

    await waitFor(() => {
      expect(screen.getByTestId('performance-panel')).toBeTruthy();
    });

    expect(screen.getByText('CPU')).toBeTruthy();
    expect(screen.getByText('RAM')).toBeTruthy();
    expect(screen.getByText('Disk')).toBeTruthy();
    expect(screen.getByText('FPS')).toBeTruthy();
    expect(screen.getByText('Dropped')).toBeTruthy();
    expect(screen.getByText('Process')).toBeTruthy();
  });

  it('should display CPU percentage with core count', async () => {
    render(<PerformancePanel />);

    await waitFor(() => {
      expect(screen.getByText('55.3% (8 cores)')).toBeTruthy();
    });
  });

  it('should display GPU name when detected', async () => {
    render(<PerformancePanel />);

    await waitFor(() => {
      expect(screen.getByText('NVIDIA RTX 4090')).toBeTruthy();
    });
  });

  it('should hide GPU section when no GPU detected', async () => {
    vi.mocked(commands.detectGpuDevices).mockResolvedValue({
      status: 'ok',
      data: { ...mockGpuStatus, devices: [] },
    } as never);

    render(<PerformancePanel />);

    await waitFor(() => {
      expect(screen.getByTestId('performance-panel')).toBeTruthy();
    });

    expect(screen.queryByText('GPU')).toBeNull();
  });

  it('should have accessible meter roles on bars', async () => {
    render(<PerformancePanel />);

    await waitFor(() => {
      expect(screen.getAllByRole('meter').length).toBe(3); // CPU, RAM, Disk
    });
  });

  it('should show unsupported message outside desktop runtime', () => {
    vi.mocked(isDesktopRuntimeAvailable).mockReturnValue(false);

    render(<PerformancePanel />);
    expect(
      screen.getByText('Performance monitoring is only available in the desktop app runtime.'),
    ).toBeTruthy();
  });
});
