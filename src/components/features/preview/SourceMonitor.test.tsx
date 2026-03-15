/**
 * SourceMonitor Component Tests
 *
 * Integration tests for the source monitor UI.
 * Mocks only external boundaries: useSourceMonitor hook (IPC layer)
 * and Tauri asset protocol.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { UseSourceMonitorReturn } from '@/hooks/useSourceMonitor';

// =============================================================================
// External boundary mocks
// =============================================================================

const mockSourceMonitor: UseSourceMonitorReturn = {
  assetId: null,
  inPoint: null,
  outPoint: null,
  markedDuration: null,
  currentTime: 0,
  isPlaying: false,
  duration: 0,
  loadAsset: vi.fn(),
  clearAsset: vi.fn(),
  setInPoint: vi.fn().mockResolvedValue(undefined),
  setOutPoint: vi.fn().mockResolvedValue(undefined),
  clearInOut: vi.fn().mockResolvedValue(undefined),
  seek: vi.fn(),
  togglePlayback: vi.fn(),
  setCurrentTime: vi.fn(),
  setDuration: vi.fn(),
  setIsPlaying: vi.fn(),
};

vi.mock('@/hooks/useSourceMonitor', () => ({
  useSourceMonitor: () => mockSourceMonitor,
}));

vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: (path: string) => `asset://localhost/${path}`,
}));

// Mock PreviewPlayer to avoid video element complexity in tests
vi.mock('@/components/preview', () => ({
  PreviewPlayer: ({ src, showControls }: { src?: string; showControls?: boolean }) => (
    <div data-testid="preview-player" data-src={src} data-controls={showControls}>
      Mock Player
    </div>
  ),
  SeekBar: ({
    currentTime,
    duration,
    onSeek,
  }: {
    currentTime: number;
    duration: number;
    onSeek?: (time: number) => void;
  }) => (
    <div
      data-testid="seek-bar"
      data-current={currentTime}
      data-duration={duration}
      onClick={() => onSeek?.(5.0)}
    >
      Mock SeekBar
    </div>
  ),
}));

vi.mock('@/stores', () => ({
  useProjectStore: (selector: (s: unknown) => unknown) =>
    selector({
      assets: new Map([
        [
          'test-asset',
          {
            id: 'test-asset',
            kind: 'video',
            name: 'test-video.mp4',
            uri: '/path/to/test-video.mp4',
            durationSec: 30,
          },
        ],
      ]),
    }),
}));

import { SourceMonitor } from './SourceMonitor';

// =============================================================================
// Tests
// =============================================================================

describe('SourceMonitor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset to empty state
    mockSourceMonitor.assetId = null;
    mockSourceMonitor.inPoint = null;
    mockSourceMonitor.outPoint = null;
    mockSourceMonitor.markedDuration = null;
    mockSourceMonitor.currentTime = 0;
    mockSourceMonitor.isPlaying = false;
    mockSourceMonitor.duration = 0;
  });

  it('should show empty state when no asset is loaded', () => {
    render(<SourceMonitor />);

    expect(screen.getByText('No source loaded')).toBeInTheDocument();
    expect(
      screen.getByText('Click an asset in the Project Explorer'),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('preview-player')).not.toBeInTheDocument();
  });

  it('should render video player when asset is loaded', () => {
    mockSourceMonitor.assetId = 'test-asset';

    render(<SourceMonitor />);

    const player = screen.getByTestId('preview-player');
    expect(player).toBeInTheDocument();
    expect(player.dataset.src).toBe('asset://localhost//path/to/test-video.mp4');
    expect(player.dataset.controls).toBe('false');
    expect(screen.getByText(/Source: test-video\.mp4/)).toBeInTheDocument();
  });

  it('should call setInPoint when I key is pressed', () => {
    mockSourceMonitor.assetId = 'test-asset';
    mockSourceMonitor.currentTime = 3.5;

    const { container } = render(<SourceMonitor />);
    const wrapper = container.firstElementChild!;

    fireEvent.keyDown(wrapper, { key: 'i' });

    expect(mockSourceMonitor.setInPoint).toHaveBeenCalledOnce();
  });

  it('should call setOutPoint when O key is pressed', () => {
    mockSourceMonitor.assetId = 'test-asset';
    mockSourceMonitor.currentTime = 8.0;

    const { container } = render(<SourceMonitor />);
    const wrapper = container.firstElementChild!;

    fireEvent.keyDown(wrapper, { key: 'o' });

    expect(mockSourceMonitor.setOutPoint).toHaveBeenCalledOnce();
  });

  it('should display In/Out time labels when points are set', () => {
    mockSourceMonitor.assetId = 'test-asset';
    mockSourceMonitor.inPoint = 2.0;
    mockSourceMonitor.outPoint = 8.0;
    mockSourceMonitor.duration = 30;
    mockSourceMonitor.markedDuration = 6.0;

    render(<SourceMonitor />);

    expect(screen.getByText(/IN 0:02/)).toBeInTheDocument();
    expect(screen.getByText(/OUT 0:08/)).toBeInTheDocument();
    expect(screen.getByText('0:06')).toBeInTheDocument();
  });

  it('should toggle playback when Space key is pressed', () => {
    mockSourceMonitor.assetId = 'test-asset';

    const { container } = render(<SourceMonitor />);
    const wrapper = container.firstElementChild!;

    fireEvent.keyDown(wrapper, { key: ' ' });

    expect(mockSourceMonitor.togglePlayback).toHaveBeenCalledOnce();
  });

  it('should set up draggable for source-to-timeline drag', () => {
    mockSourceMonitor.assetId = 'test-asset';
    mockSourceMonitor.inPoint = 1.0;
    mockSourceMonitor.outPoint = 5.0;

    const { container } = render(<SourceMonitor />);
    const draggableArea = container.querySelector('[draggable="true"]');

    expect(draggableArea).toBeInTheDocument();
  });

  it('should serialize marked source range into drag payload', () => {
    mockSourceMonitor.assetId = 'test-asset';
    mockSourceMonitor.inPoint = 1.5;
    mockSourceMonitor.outPoint = 6.25;

    const { container } = render(<SourceMonitor />);
    const draggableArea = container.querySelector('[draggable="true"]');
    const setData = vi.fn();

    fireEvent.dragStart(draggableArea!, {
      dataTransfer: {
        setData,
        effectAllowed: 'none',
      },
    });

    expect(setData).toHaveBeenCalledWith(
      'application/x-openreelio-source',
      JSON.stringify({
        assetId: 'test-asset',
        sourceIn: 1.5,
        sourceOut: 6.25,
      }),
    );
  });

  it('should call seek when seek bar is clicked', () => {
    mockSourceMonitor.assetId = 'test-asset';
    mockSourceMonitor.duration = 30;

    render(<SourceMonitor />);

    const seekBar = screen.getByTestId('seek-bar');
    fireEvent.click(seekBar);

    expect(mockSourceMonitor.seek).toHaveBeenCalledWith(5.0);
  });

  it('should show play button when paused and pause button when playing', () => {
    mockSourceMonitor.assetId = 'test-asset';
    mockSourceMonitor.isPlaying = false;

    const { rerender } = render(<SourceMonitor />);
    expect(screen.getByLabelText('Play')).toBeInTheDocument();

    mockSourceMonitor.isPlaying = true;
    rerender(<SourceMonitor />);
    expect(screen.getByLabelText('Pause')).toBeInTheDocument();
  });

  it('should clear In/Out points when Escape key is pressed', () => {
    mockSourceMonitor.assetId = 'test-asset';

    const { container } = render(<SourceMonitor />);
    const wrapper = container.firstElementChild!;

    fireEvent.keyDown(wrapper, { key: 'Escape' });

    expect(mockSourceMonitor.clearInOut).toHaveBeenCalledOnce();
  });

  it('should display asset name header after match frame loads asset', () => {
    mockSourceMonitor.assetId = 'test-asset';
    mockSourceMonitor.currentTime = 13.0;
    mockSourceMonitor.duration = 30;

    render(<SourceMonitor />);

    expect(screen.getByText(/Source: test-video\.mp4/)).toBeInTheDocument();
    // Time display should show 0:13 (the matched frame position)
    expect(screen.getByText(/0:13/)).toBeInTheDocument();
  });
});
