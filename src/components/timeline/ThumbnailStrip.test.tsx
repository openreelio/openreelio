/**
 * ThumbnailStrip Component Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { ThumbnailStrip } from './ThumbnailStrip';
import type { Asset } from '@/types';

// Mock useFrameExtractor hook
const mockGetFrame = vi.fn();
vi.mock('@/hooks', () => ({
  useFrameExtractor: () => ({
    getFrame: mockGetFrame,
    isExtracting: false,
    error: null,
    cacheSize: 0,
  }),
}));

// Mock Tauri API
vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: vi.fn((path: string) => `asset://${path}`),
}));

describe('ThumbnailStrip', () => {
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
  });

  describe('rendering', () => {
    it('should render empty state when no asset', () => {
      render(
        <ThumbnailStrip
          asset={null}
          sourceInSec={0}
          sourceOutSec={10}
          width={300}
          height={50}
        />
      );

      expect(screen.getByTestId('thumbnail-strip-empty')).toBeInTheDocument();
      expect(screen.getByText('No preview')).toBeInTheDocument();
    });

    it('should render empty state when width is zero', () => {
      render(
        <ThumbnailStrip
          asset={mockAsset}
          sourceInSec={0}
          sourceOutSec={10}
          width={0}
          height={50}
        />
      );

      expect(screen.getByTestId('thumbnail-strip-empty')).toBeInTheDocument();
    });

    it('should render empty state when duration is zero', () => {
      render(
        <ThumbnailStrip
          asset={mockAsset}
          sourceInSec={5}
          sourceOutSec={5}
          width={300}
          height={50}
        />
      );

      expect(screen.getByTestId('thumbnail-strip-empty')).toBeInTheDocument();
    });

    it('should apply custom className', () => {
      render(
        <ThumbnailStrip
          asset={null}
          sourceInSec={0}
          sourceOutSec={10}
          width={300}
          height={50}
          className="custom-class"
        />
      );

      const container = screen.getByTestId('thumbnail-strip-empty');
      expect(container).toHaveClass('custom-class');
    });
  });

  describe('thumbnail generation', () => {
    it('should extract frames for thumbnails', async () => {
      mockGetFrame.mockResolvedValue('/path/to/frame.png');

      render(
        <ThumbnailStrip
          asset={mockAsset}
          sourceInSec={0}
          sourceOutSec={10}
          width={300}
          height={50}
        />
      );

      await waitFor(
        () => {
          expect(mockGetFrame).toHaveBeenCalled();
        },
        { timeout: 500 }
      );
    });

    it('should display thumbnails when loaded', async () => {
      mockGetFrame.mockResolvedValue('/path/to/frame.png');

      render(
        <ThumbnailStrip
          asset={mockAsset}
          sourceInSec={0}
          sourceOutSec={10}
          width={300}
          height={50}
        />
      );

      await waitFor(
        () => {
          expect(screen.getByTestId('thumbnail-strip')).toBeInTheDocument();
        },
        { timeout: 500 }
      );
    });

    it('should respect maxThumbnails limit', async () => {
      mockGetFrame.mockResolvedValue('/path/to/frame.png');

      render(
        <ThumbnailStrip
          asset={mockAsset}
          sourceInSec={0}
          sourceOutSec={10}
          width={1000}
          height={50}
          maxThumbnails={5}
        />
      );

      await waitFor(
        () => {
          // Should not exceed maxThumbnails
          const calls = mockGetFrame.mock.calls.length;
          expect(calls).toBeLessThanOrEqual(5);
        },
        { timeout: 500 }
      );
    });

    it('should handle file:// URI prefix', async () => {
      const assetWithFileUri: Asset = {
        ...mockAsset,
        uri: 'file:///path/to/video.mp4',
      };

      mockGetFrame.mockResolvedValue('/path/to/frame.png');

      render(
        <ThumbnailStrip
          asset={assetWithFileUri}
          sourceInSec={0}
          sourceOutSec={10}
          width={300}
          height={50}
        />
      );

      await waitFor(
        () => {
          // Should strip file:// prefix
          expect(mockGetFrame).toHaveBeenCalledWith(
            '/path/to/video.mp4',
            expect.any(Number)
          );
        },
        { timeout: 500 }
      );
    });
  });

  describe('error handling', () => {
    it('should handle frame extraction failure', async () => {
      mockGetFrame.mockResolvedValue(null);

      render(
        <ThumbnailStrip
          asset={mockAsset}
          sourceInSec={0}
          sourceOutSec={10}
          width={300}
          height={50}
        />
      );

      await waitFor(
        () => {
          expect(screen.getByTestId('thumbnail-strip')).toBeInTheDocument();
        },
        { timeout: 500 }
      );

      // Component should still render even with failed thumbnails
    });

    it('should handle extraction exception', async () => {
      mockGetFrame.mockRejectedValue(new Error('Extraction failed'));

      render(
        <ThumbnailStrip
          asset={mockAsset}
          sourceInSec={0}
          sourceOutSec={10}
          width={300}
          height={50}
        />
      );

      await waitFor(
        () => {
          expect(screen.getByTestId('thumbnail-strip')).toBeInTheDocument();
        },
        { timeout: 500 }
      );
    });
  });

  describe('dimensions', () => {
    it('should set correct strip dimensions', async () => {
      mockGetFrame.mockResolvedValue('/path/to/frame.png');

      render(
        <ThumbnailStrip
          asset={mockAsset}
          sourceInSec={0}
          sourceOutSec={10}
          width={400}
          height={60}
        />
      );

      await waitFor(
        () => {
          const strip = screen.getByTestId('thumbnail-strip');
          expect(strip).toHaveStyle({ width: '400px', height: '60px' });
        },
        { timeout: 500 }
      );
    });
  });
});
