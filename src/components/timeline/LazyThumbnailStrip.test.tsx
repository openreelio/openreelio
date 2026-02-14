/**
 * LazyThumbnailStrip Component Tests
 *
 * Tests for the lazy-loading thumbnail strip including:
 * - Empty states
 * - Thumbnail generation and display
 * - IntersectionObserver integration
 * - Error handling
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { LazyThumbnailStrip } from './LazyThumbnailStrip';
import type { Asset } from '@/types';

// =============================================================================
// Mock Setup
// =============================================================================

// Mock IntersectionObserver
class MockIntersectionObserver {
  readonly root: Element | null = null;
  readonly rootMargin: string = '';
  readonly thresholds: ReadonlyArray<number> = [];
  private callback: IntersectionObserverCallback;
  private observedElements: Set<Element> = new Set();

  static instances: MockIntersectionObserver[] = [];

  constructor(callback: IntersectionObserverCallback, _options?: IntersectionObserverInit) {
    void _options;
    this.callback = callback;
    MockIntersectionObserver.instances.push(this);
  }

  observe(element: Element): void {
    this.observedElements.add(element);
  }

  unobserve(element: Element): void {
    this.observedElements.delete(element);
  }

  disconnect(): void {
    this.observedElements.clear();
  }

  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }

  simulateIntersection(entries: Partial<IntersectionObserverEntry>[]): void {
    const fullEntries = entries.map((entry) => ({
      isIntersecting: false,
      intersectionRatio: 0,
      boundingClientRect: {} as DOMRectReadOnly,
      intersectionRect: {} as DOMRectReadOnly,
      rootBounds: null,
      target: document.createElement('div'),
      time: Date.now(),
      ...entry,
    }));
    this.callback(fullEntries, this);
  }

  getObservedElements(): Element[] {
    return Array.from(this.observedElements);
  }
}

const originalIntersectionObserver = global.IntersectionObserver;

// Mock useFrameExtractor hook
const mockGetFrame = vi.fn();
vi.mock('@/hooks', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/hooks')>();
  return {
    ...original,
    useFrameExtractor: () => ({
      getFrame: mockGetFrame,
      isExtracting: false,
      error: null,
      cacheSize: 0,
    }),
  };
});

// Mock Tauri API
vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: vi.fn((path: string) => `asset://${path}`),
}));

// =============================================================================
// Test Fixtures
// =============================================================================

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

// =============================================================================
// Tests
// =============================================================================

describe('LazyThumbnailStrip', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    MockIntersectionObserver.instances = [];
    global.IntersectionObserver =
      MockIntersectionObserver as unknown as typeof IntersectionObserver;
    mockGetFrame.mockResolvedValue('/path/to/frame.png');
  });

  afterEach(() => {
    global.IntersectionObserver = originalIntersectionObserver;
  });

  // ===========================================================================
  // Empty States
  // ===========================================================================

  describe('empty states', () => {
    it('should render empty state when no asset', () => {
      render(
        <LazyThumbnailStrip
          asset={null}
          sourceInSec={0}
          sourceOutSec={10}
          width={300}
          height={50}
        />,
      );

      expect(screen.getByTestId('lazy-thumbnail-strip-empty')).toBeInTheDocument();
      expect(screen.getByText('No preview')).toBeInTheDocument();
    });

    it('should render empty state when width is zero', () => {
      render(
        <LazyThumbnailStrip
          asset={mockAsset}
          sourceInSec={0}
          sourceOutSec={10}
          width={0}
          height={50}
        />,
      );

      expect(screen.getByTestId('lazy-thumbnail-strip-empty')).toBeInTheDocument();
    });

    it('should render empty state when duration is zero', () => {
      render(
        <LazyThumbnailStrip
          asset={mockAsset}
          sourceInSec={5}
          sourceOutSec={5}
          width={300}
          height={50}
        />,
      );

      expect(screen.getByTestId('lazy-thumbnail-strip-empty')).toBeInTheDocument();
    });

    it('should apply custom className', () => {
      render(
        <LazyThumbnailStrip
          asset={null}
          sourceInSec={0}
          sourceOutSec={10}
          width={300}
          height={50}
          className="custom-class"
        />,
      );

      const container = screen.getByTestId('lazy-thumbnail-strip-empty');
      expect(container).toHaveClass('custom-class');
    });
  });

  // ===========================================================================
  // Thumbnail Generation
  // ===========================================================================

  describe('thumbnail generation', () => {
    it('should render thumbnail strip with asset', () => {
      render(
        <LazyThumbnailStrip
          asset={mockAsset}
          sourceInSec={0}
          sourceOutSec={10}
          width={300}
          height={50}
        />,
      );

      expect(screen.getByTestId('lazy-thumbnail-strip')).toBeInTheDocument();
    });

    it('should create thumbnail placeholders', () => {
      render(
        <LazyThumbnailStrip
          asset={mockAsset}
          sourceInSec={0}
          sourceOutSec={10}
          width={300}
          height={50}
          maxThumbnails={3}
        />,
      );

      // Should have some thumbnail elements
      expect(screen.getByTestId('lazy-thumbnail-0')).toBeInTheDocument();
    });

    it('should respect maxThumbnails limit', () => {
      render(
        <LazyThumbnailStrip
          asset={mockAsset}
          sourceInSec={0}
          sourceOutSec={10}
          width={1000}
          height={50}
          maxThumbnails={3}
        />,
      );

      // Should have at most 3 thumbnails
      expect(screen.getByTestId('lazy-thumbnail-0')).toBeInTheDocument();
      expect(screen.getByTestId('lazy-thumbnail-1')).toBeInTheDocument();
      expect(screen.getByTestId('lazy-thumbnail-2')).toBeInTheDocument();
      expect(screen.queryByTestId('lazy-thumbnail-3')).not.toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Lazy Loading
  // ===========================================================================

  describe('lazy loading', () => {
    it('should observe thumbnails with IntersectionObserver', () => {
      render(
        <LazyThumbnailStrip
          asset={mockAsset}
          sourceInSec={0}
          sourceOutSec={10}
          width={300}
          height={50}
          maxThumbnails={3}
        />,
      );

      // Should have created an IntersectionObserver
      expect(MockIntersectionObserver.instances.length).toBeGreaterThan(0);

      // Observer should have elements
      const observer = MockIntersectionObserver.instances[0];
      expect(observer.getObservedElements().length).toBeGreaterThan(0);
    });

    it('should extract frame when thumbnail becomes visible', async () => {
      render(
        <LazyThumbnailStrip
          asset={mockAsset}
          sourceInSec={0}
          sourceOutSec={10}
          width={300}
          height={50}
          maxThumbnails={3}
        />,
      );

      const observer = MockIntersectionObserver.instances[0];
      const elements = observer.getObservedElements();

      // Simulate first thumbnail becoming visible
      act(() => {
        observer.simulateIntersection([{ target: elements[0], isIntersecting: true }]);
      });

      await waitFor(() => {
        expect(mockGetFrame).toHaveBeenCalled();
      });
    });

    it('should not extract frame when thumbnail is not visible', async () => {
      render(
        <LazyThumbnailStrip
          asset={mockAsset}
          sourceInSec={0}
          sourceOutSec={10}
          width={300}
          height={50}
          maxThumbnails={3}
        />,
      );

      const observer = MockIntersectionObserver.instances[0];
      const elements = observer.getObservedElements();

      // Simulate thumbnail NOT becoming visible
      act(() => {
        observer.simulateIntersection([{ target: elements[0], isIntersecting: false }]);
      });

      // Wait a bit and check extraction was not called
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(mockGetFrame).not.toHaveBeenCalled();
    });

    it('should display thumbnail after extraction', async () => {
      mockGetFrame.mockResolvedValue('/path/to/extracted-frame.png');

      render(
        <LazyThumbnailStrip
          asset={mockAsset}
          sourceInSec={0}
          sourceOutSec={10}
          width={300}
          height={50}
          maxThumbnails={3}
        />,
      );

      const observer = MockIntersectionObserver.instances[0];
      const elements = observer.getObservedElements();

      act(() => {
        observer.simulateIntersection([{ target: elements[0], isIntersecting: true }]);
      });

      await waitFor(() => {
        const thumbnail = screen.getByTestId('lazy-thumbnail-0');
        const img = thumbnail.querySelector('img');
        expect(img).toBeInTheDocument();
        expect(img).toHaveAttribute('src', 'asset:///path/to/extracted-frame.png');
      });
    });

    it('should request new frames when source range changes', async () => {
      const { rerender } = render(
        <LazyThumbnailStrip
          asset={mockAsset}
          sourceInSec={0}
          sourceOutSec={10}
          width={300}
          height={50}
          maxThumbnails={1}
        />,
      );

      const firstObserver = MockIntersectionObserver.instances[0];
      const firstElement = firstObserver.getObservedElements()[0];

      act(() => {
        firstObserver.simulateIntersection([{ target: firstElement, isIntersecting: true }]);
      });

      await waitFor(() => {
        expect(mockGetFrame).toHaveBeenCalledTimes(1);
      });

      expect(mockGetFrame.mock.calls[0][1]).toBeCloseTo(5, 3);

      rerender(
        <LazyThumbnailStrip
          asset={mockAsset}
          sourceInSec={10}
          sourceOutSec={20}
          width={300}
          height={50}
          maxThumbnails={1}
        />,
      );

      const latestObserver = MockIntersectionObserver.instances.at(-1);
      const latestElement = latestObserver?.getObservedElements()[0];

      expect(latestObserver).toBeDefined();
      expect(latestElement).toBeDefined();

      act(() => {
        latestObserver?.simulateIntersection([{ target: latestElement!, isIntersecting: true }]);
      });

      await waitFor(() => {
        expect(mockGetFrame).toHaveBeenCalledTimes(2);
      });

      expect(mockGetFrame.mock.calls[1][1]).toBeCloseTo(15, 3);
    });
  });

  // ===========================================================================
  // Error Handling
  // ===========================================================================

  describe('error handling', () => {
    it('should handle extraction failure gracefully', async () => {
      mockGetFrame.mockResolvedValue(null);

      render(
        <LazyThumbnailStrip
          asset={mockAsset}
          sourceInSec={0}
          sourceOutSec={10}
          width={300}
          height={50}
          maxThumbnails={3}
        />,
      );

      const observer = MockIntersectionObserver.instances[0];
      const elements = observer.getObservedElements();

      act(() => {
        observer.simulateIntersection([{ target: elements[0], isIntersecting: true }]);
      });

      await waitFor(() => {
        const thumbnail = screen.getByTestId('lazy-thumbnail-0');
        // Should show error indicator
        expect(thumbnail.querySelector('.text-gray-500')).toBeInTheDocument();
      });
    });

    it('should handle extraction exception', async () => {
      mockGetFrame.mockRejectedValue(new Error('Extraction failed'));

      render(
        <LazyThumbnailStrip
          asset={mockAsset}
          sourceInSec={0}
          sourceOutSec={10}
          width={300}
          height={50}
          maxThumbnails={3}
        />,
      );

      const observer = MockIntersectionObserver.instances[0];
      const elements = observer.getObservedElements();

      act(() => {
        observer.simulateIntersection([{ target: elements[0], isIntersecting: true }]);
      });

      // Component should not crash
      await waitFor(() => {
        expect(screen.getByTestId('lazy-thumbnail-strip')).toBeInTheDocument();
      });
    });
  });

  // ===========================================================================
  // Dimensions
  // ===========================================================================

  describe('dimensions', () => {
    it('should set correct strip dimensions', () => {
      render(
        <LazyThumbnailStrip
          asset={mockAsset}
          sourceInSec={0}
          sourceOutSec={10}
          width={400}
          height={60}
        />,
      );

      const strip = screen.getByTestId('lazy-thumbnail-strip');
      expect(strip).toHaveStyle({ width: '400px', height: '60px' });
    });
  });

  // ===========================================================================
  // File URI Handling
  // ===========================================================================

  describe('file URI handling', () => {
    it('should handle file:// URI prefix', async () => {
      const assetWithFileUri: Asset = {
        ...mockAsset,
        uri: 'file:///path/to/video.mp4',
      };

      render(
        <LazyThumbnailStrip
          asset={assetWithFileUri}
          sourceInSec={0}
          sourceOutSec={10}
          width={300}
          height={50}
          maxThumbnails={3}
        />,
      );

      const observer = MockIntersectionObserver.instances[0];
      const elements = observer.getObservedElements();

      act(() => {
        observer.simulateIntersection([{ target: elements[0], isIntersecting: true }]);
      });

      await waitFor(() => {
        // Should strip file:// prefix
        expect(mockGetFrame).toHaveBeenCalledWith('/path/to/video.mp4', expect.any(Number));
      });
    });
  });
});
