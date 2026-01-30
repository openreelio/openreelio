/**
 * FramePreview Component Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { FramePreview } from './FramePreview';
import type { Asset } from '@/types';

// Mock useFrameExtractor hook
const mockGetFrame = vi.fn();
const mockIsExtracting = { value: false };
const mockError = { value: null as string | null };

vi.mock('@/hooks', () => ({
  useFrameExtractor: () => ({
    getFrame: mockGetFrame,
    get isExtracting() {
      return mockIsExtracting.value;
    },
    get error() {
      return mockError.value;
    },
    cacheSize: 0,
  }),
}));

// Mock Tauri API
vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: vi.fn((path: string) => `asset://${path}`),
}));

describe('FramePreview', () => {
  const mockAsset: Asset = {
    id: 'asset-1',
    kind: 'video',
    name: 'test-video.mp4',
    uri: '/path/to/video.mp4',
    hash: 'abc123',
    durationSec: 120,
    fileSize: 1024000,
    importedAt: '2024-01-01T00:00:00Z',
    license: {
      source: 'user',
      licenseType: 'royalty_free',
      allowedUse: ['commercial'],
    },
    tags: [],
    proxyStatus: 'notNeeded',
    video: {
      width: 1920,
      height: 1080,
      fps: { num: 30, den: 1 },
      codec: 'h264',
      hasAlpha: false,
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockIsExtracting.value = false;
    mockError.value = null;
  });

  describe('rendering', () => {
    it('should render empty state when no asset', () => {
      render(<FramePreview asset={null} timeSec={0} />);

      expect(screen.getByTestId('frame-preview-empty')).toBeInTheDocument();
      expect(screen.getByText('No asset')).toBeInTheDocument();
    });

    it('should render with default dimensions', () => {
      render(<FramePreview asset={null} timeSec={0} />);

      const container = screen.getByTestId('frame-preview-empty');
      expect(container).toHaveStyle({ width: '320px', height: '180px' });
    });

    it('should render with custom dimensions', () => {
      render(<FramePreview asset={null} timeSec={0} width={640} height={360} />);

      const container = screen.getByTestId('frame-preview-empty');
      expect(container).toHaveStyle({ width: '640px', height: '360px' });
    });

    it('should apply custom className', () => {
      render(<FramePreview asset={null} timeSec={0} className="custom-class" />);

      const container = screen.getByTestId('frame-preview-empty');
      expect(container).toHaveClass('custom-class');
    });
  });

  describe('frame loading', () => {
    it('should extract frame after debounce delay', async () => {
      mockGetFrame.mockResolvedValueOnce('/path/to/frame.png');

      render(<FramePreview asset={mockAsset} timeSec={5.5} />);

      await waitFor(
        () => {
          expect(mockGetFrame).toHaveBeenCalledWith('/path/to/video.mp4', 5.5);
        },
        { timeout: 500 }
      );
    });

    it('should display extracted frame', async () => {
      mockGetFrame.mockResolvedValueOnce('/path/to/frame.png');

      render(<FramePreview asset={mockAsset} timeSec={5.5} />);

      await waitFor(
        () => {
          const img = screen.getByTestId('frame-preview-image');
          expect(img).toHaveAttribute('src', 'asset:///path/to/frame.png');
        },
        { timeout: 500 }
      );
    });

    it('should show time badge', async () => {
      mockGetFrame.mockResolvedValueOnce('/path/to/frame.png');

      render(<FramePreview asset={mockAsset} timeSec={65.5} />);

      await waitFor(
        () => {
          expect(screen.getByTestId('frame-preview')).toBeInTheDocument();
        },
        { timeout: 500 }
      );

      // Time badge should show formatted time (1:05.50)
      expect(screen.getByText('1:05.50')).toBeInTheDocument();
    });

    it('should call onFrameLoaded callback', async () => {
      const onFrameLoaded = vi.fn();
      mockGetFrame.mockResolvedValueOnce('/path/to/frame.png');

      render(
        <FramePreview
          asset={mockAsset}
          timeSec={5.5}
          onFrameLoaded={onFrameLoaded}
        />
      );

      await waitFor(
        () => {
          expect(onFrameLoaded).toHaveBeenCalledWith('/path/to/frame.png');
        },
        { timeout: 500 }
      );
    });

    it('should handle file:// URI prefix', async () => {
      const assetWithFileUri: Asset = {
        ...mockAsset,
        uri: 'file:///path/to/video.mp4',
      };

      mockGetFrame.mockResolvedValueOnce('/path/to/frame.png');

      render(<FramePreview asset={assetWithFileUri} timeSec={5.5} />);

      await waitFor(
        () => {
          expect(mockGetFrame).toHaveBeenCalledWith('/path/to/video.mp4', 5.5);
        },
        { timeout: 500 }
      );
    });
  });

  describe('error handling', () => {
    it('should display error state when extraction fails', async () => {
      mockGetFrame.mockResolvedValueOnce(null);

      render(<FramePreview asset={mockAsset} timeSec={5.5} />);

      await waitFor(
        () => {
          expect(screen.getByTestId('frame-preview-error')).toBeInTheDocument();
        },
        { timeout: 500 }
      );
    });

    it('should call onError callback', async () => {
      const onError = vi.fn();
      mockGetFrame.mockResolvedValueOnce(null);

      render(<FramePreview asset={mockAsset} timeSec={5.5} onError={onError} />);

      await waitFor(
        () => {
          expect(onError).toHaveBeenCalledWith('Failed to extract frame');
        },
        { timeout: 500 }
      );
    });
  });

  describe('debouncing', () => {
    it('should not call getFrame immediately on render', () => {
      mockGetFrame.mockResolvedValue('/path/to/frame.png');

      render(<FramePreview asset={mockAsset} timeSec={1.0} />);

      // Should not be called immediately
      expect(mockGetFrame).not.toHaveBeenCalled();
    });

    it('should call getFrame after debounce delay', async () => {
      mockGetFrame.mockResolvedValue('/path/to/frame.png');

      render(<FramePreview asset={mockAsset} timeSec={1.0} />);

      await waitFor(
        () => {
          expect(mockGetFrame).toHaveBeenCalledTimes(1);
        },
        { timeout: 500 }
      );
    });
  });

  describe('loading state', () => {
    it('should render frame-preview container when asset is provided', async () => {
      mockGetFrame.mockResolvedValue('/path/to/frame.png');

      render(<FramePreview asset={mockAsset} timeSec={5.5} showLoading={true} />);

      await waitFor(
        () => {
          expect(screen.getByTestId('frame-preview')).toBeInTheDocument();
        },
        { timeout: 500 }
      );
    });

    it('should not show loading indicator when showLoading is false', async () => {
      mockGetFrame.mockResolvedValue('/path/to/frame.png');

      render(<FramePreview asset={mockAsset} timeSec={5.5} showLoading={false} />);

      await waitFor(
        () => {
          expect(screen.getByTestId('frame-preview')).toBeInTheDocument();
        },
        { timeout: 500 }
      );

      expect(screen.queryByTestId('frame-preview-loading')).not.toBeInTheDocument();
    });
  });

  describe('memoization', () => {
    it('should skip extraction for same asset and time', async () => {
      mockGetFrame.mockResolvedValue('/path/to/frame.png');

      const { rerender } = render(<FramePreview asset={mockAsset} timeSec={5.5} />);

      await waitFor(
        () => {
          expect(mockGetFrame).toHaveBeenCalledTimes(1);
        },
        { timeout: 500 }
      );

      // Rerender with same props
      rerender(<FramePreview asset={mockAsset} timeSec={5.5} />);

      // Wait a bit and verify no additional calls
      await act(async () => {
        await new Promise((r) => setTimeout(r, 200));
      });

      expect(mockGetFrame).toHaveBeenCalledTimes(1);
    });
  });

  describe('destructive scenarios', () => {
    it('should only request the latest frame during rapid scrubbing', async () => {
      vi.useFakeTimers();
      try {
        mockGetFrame.mockImplementation(async (_path: string, sec: number) => {
          await new Promise<void>((resolve) => setTimeout(resolve, 10));
          return `/path/to/frame-${sec}.png`;
        });

        const { rerender } = render(<FramePreview asset={mockAsset} timeSec={1.0} />);

        rerender(<FramePreview asset={mockAsset} timeSec={2.0} />);
        rerender(<FramePreview asset={mockAsset} timeSec={3.0} />);

        // Debounce delay in component is 100ms.
        await act(async () => {
          vi.advanceTimersByTime(100);
        });

        // Resolve getFrame() promise.
        await act(async () => {
          vi.advanceTimersByTime(20);
        });

        expect(mockGetFrame).toHaveBeenCalledTimes(1);
        expect(mockGetFrame).toHaveBeenCalledWith('/path/to/video.mp4', 3.0);
      } finally {
        vi.useRealTimers();
      }
    });

    it('should not call callbacks after unmount (in-flight extraction)', async () => {
      vi.useFakeTimers();
      try {
        const onFrameLoaded = vi.fn();
        const deferred: { resolve: (value: string | null) => void } = { resolve: () => undefined };

        mockGetFrame.mockImplementation(() => new Promise<string | null>((resolve) => (deferred.resolve = resolve)));

        const { unmount } = render(
          <FramePreview asset={mockAsset} timeSec={1.0} onFrameLoaded={onFrameLoaded} />,
        );

        // Kick off extraction after debounce.
        await act(async () => {
          vi.advanceTimersByTime(100);
        });

        unmount();

        // Resolve after unmount; callback should not run.
        deferred.resolve('/path/to/frame.png');
        await act(async () => {
          await Promise.resolve();
        });

        expect(onFrameLoaded).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
