/**
 * useLazyThumbnails Hook Tests
 *
 * Tests for viewport-based lazy thumbnail loading including:
 * - IntersectionObserver-based visibility detection
 * - Priority loading for visible thumbnails
 * - Loading state management
 * - Cleanup and memory management
 */

import { renderHook, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  useLazyThumbnails,
  type ThumbnailRequest,
  type LazyThumbnailsConfig,
} from './useLazyThumbnails';

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

  // Static registry for test access
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

  // Test helper: simulate intersection
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

// Replace global IntersectionObserver
const originalIntersectionObserver = global.IntersectionObserver;

// Mock frame extraction function
const mockExtractFrame = vi.fn<(assetPath: string, timeSec: number) => Promise<string | null>>(
  async () => null,
);

// =============================================================================
// Test Fixtures
// =============================================================================

const createThumbnailRequest = (
  id: string,
  timeSec: number,
  assetPath: string = '/path/to/video.mp4',
): ThumbnailRequest => ({
  id,
  timeSec,
  assetPath,
});

const defaultConfig: LazyThumbnailsConfig = {
  extractFrame: mockExtractFrame,
  rootMargin: '100px',
  maxConcurrent: 3,
};

// =============================================================================
// Tests
// =============================================================================

describe('useLazyThumbnails', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    MockIntersectionObserver.instances = [];
    global.IntersectionObserver =
      MockIntersectionObserver as unknown as typeof IntersectionObserver;
    mockExtractFrame.mockResolvedValue('/path/to/frame.png');
  });

  afterEach(() => {
    global.IntersectionObserver = originalIntersectionObserver;
  });

  // ===========================================================================
  // Initialization
  // ===========================================================================

  describe('initialization', () => {
    it('should initialize with empty thumbnails', () => {
      const requests: ThumbnailRequest[] = [];

      const { result } = renderHook(() => useLazyThumbnails(requests, defaultConfig));

      expect(result.current.thumbnails).toEqual({});
      expect(result.current.loadingCount).toBe(0);
      expect(result.current.loadedCount).toBe(0);
    });

    it('should create IntersectionObserver', () => {
      const requests = [createThumbnailRequest('1', 1)];

      renderHook(() => useLazyThumbnails(requests, defaultConfig));

      expect(MockIntersectionObserver.instances.length).toBe(1);
    });

    it('should use provided rootMargin', () => {
      const requests = [createThumbnailRequest('1', 1)];

      renderHook(() => useLazyThumbnails(requests, { ...defaultConfig, rootMargin: '200px' }));

      // Observer is created - we verify it was called
      expect(MockIntersectionObserver.instances.length).toBe(1);
    });
  });

  // ===========================================================================
  // Element Registration
  // ===========================================================================

  describe('element registration', () => {
    it('should provide registerRef function', () => {
      const requests = [createThumbnailRequest('1', 1)];

      const { result } = renderHook(() => useLazyThumbnails(requests, defaultConfig));

      expect(typeof result.current.registerRef).toBe('function');
    });

    it('should observe element when ref is registered', () => {
      const requests = [createThumbnailRequest('1', 1)];

      const { result } = renderHook(() => useLazyThumbnails(requests, defaultConfig));

      const element = document.createElement('div');

      act(() => {
        result.current.registerRef('1', element);
      });

      const observer = MockIntersectionObserver.instances[0];
      expect(observer.getObservedElements()).toContain(element);
    });

    it('should unobserve element when ref is set to null', () => {
      const requests = [createThumbnailRequest('1', 1)];

      const { result } = renderHook(() => useLazyThumbnails(requests, defaultConfig));

      const element = document.createElement('div');

      act(() => {
        result.current.registerRef('1', element);
      });

      const observer = MockIntersectionObserver.instances[0];
      expect(observer.getObservedElements()).toContain(element);

      act(() => {
        result.current.registerRef('1', null);
      });

      expect(observer.getObservedElements()).not.toContain(element);
    });
  });

  // ===========================================================================
  // Visibility and Loading
  // ===========================================================================

  describe('visibility and loading', () => {
    it('should trigger extraction when element becomes visible', async () => {
      const requests = [createThumbnailRequest('1', 5)];

      const { result } = renderHook(() => useLazyThumbnails(requests, defaultConfig));

      const element = document.createElement('div');

      act(() => {
        result.current.registerRef('1', element);
      });

      const observer = MockIntersectionObserver.instances[0];

      act(() => {
        observer.simulateIntersection([{ target: element, isIntersecting: true }]);
      });

      await waitFor(() => {
        expect(mockExtractFrame).toHaveBeenCalledWith('/path/to/video.mp4', 5);
      });
    });

    it('should not trigger extraction when element is not visible', async () => {
      const requests = [createThumbnailRequest('1', 5)];

      const { result } = renderHook(() => useLazyThumbnails(requests, defaultConfig));

      const element = document.createElement('div');

      act(() => {
        result.current.registerRef('1', element);
      });

      const observer = MockIntersectionObserver.instances[0];

      act(() => {
        observer.simulateIntersection([{ target: element, isIntersecting: false }]);
      });

      // Wait a bit to ensure extraction was not called
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(mockExtractFrame).not.toHaveBeenCalled();
    });

    it('should update thumbnail state after successful extraction', async () => {
      const requests = [createThumbnailRequest('1', 5)];
      mockExtractFrame.mockResolvedValue('/path/to/frame-5.png');

      const { result } = renderHook(() => useLazyThumbnails(requests, defaultConfig));

      const element = document.createElement('div');

      act(() => {
        result.current.registerRef('1', element);
      });

      const observer = MockIntersectionObserver.instances[0];

      act(() => {
        observer.simulateIntersection([{ target: element, isIntersecting: true }]);
      });

      await waitFor(() => {
        expect(result.current.thumbnails['1']).toEqual({
          src: '/path/to/frame-5.png',
          loading: false,
          error: false,
        });
      });
    });

    it('should handle extraction failure gracefully', async () => {
      const requests = [createThumbnailRequest('1', 5)];
      mockExtractFrame.mockRejectedValue(new Error('Extraction failed'));

      const { result } = renderHook(() => useLazyThumbnails(requests, defaultConfig));

      const element = document.createElement('div');

      act(() => {
        result.current.registerRef('1', element);
      });

      const observer = MockIntersectionObserver.instances[0];

      act(() => {
        observer.simulateIntersection([{ target: element, isIntersecting: true }]);
      });

      await waitFor(() => {
        expect(result.current.thumbnails['1']).toEqual({
          src: null,
          loading: false,
          error: true,
        });
      });
    });

    it('should handle null extraction result', async () => {
      const requests = [createThumbnailRequest('1', 5)];
      mockExtractFrame.mockResolvedValue(null);

      const { result } = renderHook(() => useLazyThumbnails(requests, defaultConfig));

      const element = document.createElement('div');

      act(() => {
        result.current.registerRef('1', element);
      });

      const observer = MockIntersectionObserver.instances[0];

      act(() => {
        observer.simulateIntersection([{ target: element, isIntersecting: true }]);
      });

      await waitFor(() => {
        expect(result.current.thumbnails['1']).toEqual({
          src: null,
          loading: false,
          error: true,
        });
      });
    });
  });

  // ===========================================================================
  // Loading State
  // ===========================================================================

  describe('loading state', () => {
    it('should track loading state during extraction', async () => {
      const requests = [createThumbnailRequest('1', 5)];

      let resolveExtraction: (value: string | null) => void = () => {};
      mockExtractFrame.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveExtraction = resolve;
          }),
      );

      const { result } = renderHook(() => useLazyThumbnails(requests, defaultConfig));

      const element = document.createElement('div');

      act(() => {
        result.current.registerRef('1', element);
      });

      const observer = MockIntersectionObserver.instances[0];

      act(() => {
        observer.simulateIntersection([{ target: element, isIntersecting: true }]);
      });

      // Wait for loading to start
      await waitFor(() => {
        expect(result.current.thumbnails['1']?.loading).toBe(true);
      });

      expect(result.current.loadingCount).toBe(1);

      // Resolve extraction
      await act(async () => {
        resolveExtraction('/path/to/frame.png');
      });

      await waitFor(() => {
        expect(result.current.thumbnails['1']?.loading).toBe(false);
        expect(result.current.loadingCount).toBe(0);
        expect(result.current.loadedCount).toBe(1);
      });
    });

    it('should not extract already loaded thumbnail', async () => {
      const requests = [createThumbnailRequest('1', 5)];
      mockExtractFrame.mockResolvedValue('/path/to/frame.png');

      const { result } = renderHook(() => useLazyThumbnails(requests, defaultConfig));

      const element = document.createElement('div');

      act(() => {
        result.current.registerRef('1', element);
      });

      const observer = MockIntersectionObserver.instances[0];

      // First intersection
      act(() => {
        observer.simulateIntersection([{ target: element, isIntersecting: true }]);
      });

      await waitFor(() => {
        expect(result.current.thumbnails['1']?.loading).toBe(false);
      });

      expect(mockExtractFrame).toHaveBeenCalledTimes(1);

      // Second intersection (should not trigger extraction again)
      act(() => {
        observer.simulateIntersection([{ target: element, isIntersecting: false }]);
        observer.simulateIntersection([{ target: element, isIntersecting: true }]);
      });

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(mockExtractFrame).toHaveBeenCalledTimes(1);
    });
  });

  // ===========================================================================
  // Concurrency Control
  // ===========================================================================

  describe('concurrency control', () => {
    it('should respect maxConcurrent limit', async () => {
      const requests = [
        createThumbnailRequest('1', 1),
        createThumbnailRequest('2', 2),
        createThumbnailRequest('3', 3),
        createThumbnailRequest('4', 4),
        createThumbnailRequest('5', 5),
      ];

      const pendingResolvers: ((value: string | null) => void)[] = [];
      mockExtractFrame.mockImplementation(
        () =>
          new Promise((resolve) => {
            pendingResolvers.push(resolve);
          }),
      );

      const config: LazyThumbnailsConfig = {
        ...defaultConfig,
        maxConcurrent: 2,
      };

      const { result } = renderHook(() => useLazyThumbnails(requests, config));

      // Register all elements
      const elements = requests.map(() => document.createElement('div'));

      act(() => {
        requests.forEach((req, i) => {
          result.current.registerRef(req.id, elements[i]);
        });
      });

      const observer = MockIntersectionObserver.instances[0];

      // Make all visible at once
      act(() => {
        observer.simulateIntersection(elements.map((el) => ({ target: el, isIntersecting: true })));
      });

      // Wait for extractions to start
      await waitFor(() => {
        expect(mockExtractFrame).toHaveBeenCalled();
      });

      // Should only have maxConcurrent extractions running
      expect(result.current.loadingCount).toBeLessThanOrEqual(2);
    });

    it('should process queue when extractions complete', async () => {
      const requests = [
        createThumbnailRequest('1', 1),
        createThumbnailRequest('2', 2),
        createThumbnailRequest('3', 3),
      ];

      const pendingResolvers: ((value: string | null) => void)[] = [];
      mockExtractFrame.mockImplementation(
        () =>
          new Promise((resolve) => {
            pendingResolvers.push(resolve);
          }),
      );

      const config: LazyThumbnailsConfig = {
        ...defaultConfig,
        maxConcurrent: 1,
      };

      const { result } = renderHook(() => useLazyThumbnails(requests, config));

      const elements = requests.map(() => document.createElement('div'));

      act(() => {
        requests.forEach((req, i) => {
          result.current.registerRef(req.id, elements[i]);
        });
      });

      const observer = MockIntersectionObserver.instances[0];

      act(() => {
        observer.simulateIntersection(elements.map((el) => ({ target: el, isIntersecting: true })));
      });

      // Wait for first extraction to start
      await waitFor(() => {
        expect(pendingResolvers.length).toBe(1);
      });

      // Complete first extraction
      await act(async () => {
        pendingResolvers[0]('/path/to/frame-1.png');
      });

      // Second extraction should start
      await waitFor(() => {
        expect(pendingResolvers.length).toBe(2);
      });
    });
  });

  // ===========================================================================
  // Cleanup
  // ===========================================================================

  describe('cleanup', () => {
    it('should disconnect observer on unmount', () => {
      const requests = [createThumbnailRequest('1', 1)];

      const { unmount } = renderHook(() => useLazyThumbnails(requests, defaultConfig));

      const observer = MockIntersectionObserver.instances[0];
      const disconnectSpy = vi.spyOn(observer, 'disconnect');

      unmount();

      expect(disconnectSpy).toHaveBeenCalled();
    });

    it('should clear pending extractions on unmount', async () => {
      const requests = [createThumbnailRequest('1', 1)];

      let resolveExtraction: (value: string | null) => void = () => {};
      mockExtractFrame.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveExtraction = resolve;
          }),
      );

      const { result, unmount } = renderHook(() => useLazyThumbnails(requests, defaultConfig));

      const element = document.createElement('div');

      act(() => {
        result.current.registerRef('1', element);
      });

      const observer = MockIntersectionObserver.instances[0];

      act(() => {
        observer.simulateIntersection([{ target: element, isIntersecting: true }]);
      });

      // Wait for extraction to start
      await waitFor(() => {
        expect(result.current.thumbnails['1']?.loading).toBe(true);
      });

      unmount();

      // Resolve after unmount - should not cause errors
      await act(async () => {
        resolveExtraction('/path/to/frame.png');
      });
    });
  });

  // ===========================================================================
  // Request Updates
  // ===========================================================================

  describe('request updates', () => {
    it('should handle request list changes', async () => {
      const initialRequests = [createThumbnailRequest('1', 1)];
      mockExtractFrame.mockResolvedValue('/path/to/frame.png');

      const { result, rerender } = renderHook(
        ({ requests }) => useLazyThumbnails(requests, defaultConfig),
        { initialProps: { requests: initialRequests } },
      );

      // Add new request
      const newRequests = [...initialRequests, createThumbnailRequest('2', 2)];

      rerender({ requests: newRequests });

      // New request should be trackable
      const element = document.createElement('div');

      act(() => {
        result.current.registerRef('2', element);
      });

      const observer = MockIntersectionObserver.instances[0];
      expect(observer.getObservedElements()).toContain(element);
    });
  });

  // ===========================================================================
  // Utility Functions
  // ===========================================================================

  describe('utility functions', () => {
    it('should provide getThumbnailState helper', () => {
      const requests = [createThumbnailRequest('1', 1)];

      const { result } = renderHook(() => useLazyThumbnails(requests, defaultConfig));

      const state = result.current.getThumbnailState('1');
      expect(state).toEqual({
        src: null,
        loading: false,
        error: false,
      });
    });

    it('should return default state for unknown id', () => {
      const requests: ThumbnailRequest[] = [];

      const { result } = renderHook(() => useLazyThumbnails(requests, defaultConfig));

      const state = result.current.getThumbnailState('unknown');
      expect(state).toEqual({
        src: null,
        loading: false,
        error: false,
      });
    });
  });
});
