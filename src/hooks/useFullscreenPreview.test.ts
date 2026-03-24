/**
 * useFullscreenPreview Hook Tests
 *
 * BDD-style tests covering fullscreen toggle and snapshot capture.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useFullscreenPreview } from './useFullscreenPreview';

// =============================================================================
// Test Helpers
// =============================================================================

function createMockContainer(): HTMLDivElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  return container;
}

function createMockCanvas(container: HTMLElement, width = 1920, height = 1080): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  // Provide a real 2D context that produces a valid data URL
  const originalGetContext = canvas.getContext.bind(canvas);
  vi.spyOn(canvas, 'getContext').mockImplementation((contextId: string, options?: unknown) => {
    return originalGetContext(contextId, options as CanvasRenderingContext2DSettings);
  });

  vi.spyOn(canvas, 'toDataURL').mockReturnValue('data:image/png;base64,MOCK_CANVAS_DATA');

  container.appendChild(canvas);
  return canvas;
}

function createMockVideo(container: HTMLElement): HTMLVideoElement {
  const video = document.createElement('video');
  Object.defineProperty(video, 'videoWidth', { value: 1920, writable: true });
  Object.defineProperty(video, 'videoHeight', { value: 1080, writable: true });
  Object.defineProperty(video, 'readyState', { value: 4, writable: true });
  container.appendChild(video);
  return video;
}

// =============================================================================
// Tests
// =============================================================================

describe('useFullscreenPreview', () => {
  let container: HTMLDivElement;
  let anchorClickSpy: { mockRestore: () => void };
  let canvasToDataUrlSpy: { mockRestore: () => void };

  beforeEach(() => {
    container = createMockContainer();

    // Mock Fullscreen API
    document.exitFullscreen = vi.fn().mockResolvedValue(undefined);
    container.requestFullscreen = vi.fn().mockResolvedValue(undefined);
    anchorClickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    canvasToDataUrlSpy = vi
      .spyOn(HTMLCanvasElement.prototype, 'toDataURL')
      .mockReturnValue('data:image/png;base64,MOCK_CANVAS_DATA');

    // Reset fullscreenElement
    Object.defineProperty(document, 'fullscreenElement', {
      value: null,
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    container.remove();
    anchorClickSpy.mockRestore();
    canvasToDataUrlSpy.mockRestore();
    vi.restoreAllMocks();
  });

  // ===========================================================================
  // Feature: Fullscreen Preview
  // ===========================================================================

  describe('Fullscreen Toggle', () => {
    it('should report isFullscreen as false initially', () => {
      const ref = { current: container };
      const { result } = renderHook(() => useFullscreenPreview(ref));

      expect(result.current.isFullscreen).toBe(false);
    });

    it('should request fullscreen when toggleFullscreen is called and not in fullscreen', () => {
      const ref = { current: container };
      const { result } = renderHook(() => useFullscreenPreview(ref));

      act(() => {
        result.current.toggleFullscreen();
      });

      expect(container.requestFullscreen).toHaveBeenCalledTimes(1);
    });

    it('should exit fullscreen when toggleFullscreen is called and already in fullscreen', () => {
      Object.defineProperty(document, 'fullscreenElement', {
        value: container,
        writable: true,
        configurable: true,
      });

      const ref = { current: container };
      const { result } = renderHook(() => useFullscreenPreview(ref));

      act(() => {
        result.current.toggleFullscreen();
      });

      expect(document.exitFullscreen).toHaveBeenCalledTimes(1);
    });

    it('should update isFullscreen when fullscreenchange event fires', () => {
      const ref = { current: container };
      const { result } = renderHook(() => useFullscreenPreview(ref));

      // Simulate entering fullscreen
      Object.defineProperty(document, 'fullscreenElement', {
        value: container,
        writable: true,
        configurable: true,
      });

      act(() => {
        document.dispatchEvent(new Event('fullscreenchange'));
      });

      expect(result.current.isFullscreen).toBe(true);

      // Simulate exiting fullscreen
      Object.defineProperty(document, 'fullscreenElement', {
        value: null,
        writable: true,
        configurable: true,
      });

      act(() => {
        document.dispatchEvent(new Event('fullscreenchange'));
      });

      expect(result.current.isFullscreen).toBe(false);
    });

    it('should not throw when containerRef is null', () => {
      const ref = { current: null };
      const { result } = renderHook(() => useFullscreenPreview(ref));

      expect(() => {
        act(() => {
          result.current.toggleFullscreen();
        });
      }).not.toThrow();
    });

    it('should clean up fullscreenchange listener on unmount', () => {
      const addSpy = vi.spyOn(document, 'addEventListener');
      const removeSpy = vi.spyOn(document, 'removeEventListener');

      const ref = { current: container };
      const { unmount } = renderHook(() => useFullscreenPreview(ref));

      const addCall = addSpy.mock.calls.find((call) => call[0] === 'fullscreenchange');
      expect(addCall).toBeDefined();

      unmount();

      const removeCall = removeSpy.mock.calls.find((call) => call[0] === 'fullscreenchange');
      expect(removeCall).toBeDefined();

      // Same handler function used for add and remove
      expect(removeCall![1]).toBe(addCall![1]);
    });
  });

  // ===========================================================================
  // Feature: Snapshot Capture
  // ===========================================================================

  describe('Snapshot Capture', () => {
    it('should capture snapshot from canvas element', () => {
      createMockCanvas(container);
      const ref = { current: container };
      const { result } = renderHook(() => useFullscreenPreview(ref));

      const appendSpy = vi.spyOn(document.body, 'appendChild');

      act(() => {
        result.current.captureSnapshot();
      });

      // Verify a link was added (download triggered)
      const linkCall = appendSpy.mock.calls.find(
        (call) => call[0] instanceof HTMLAnchorElement,
      );
      expect(linkCall).toBeDefined();

      const link = linkCall![0] as HTMLAnchorElement;
      expect(link.download).toMatch(/^snapshot_.*\.png$/);
      expect(link.href).toContain('MOCK_CANVAS_DATA');

      appendSpy.mockRestore();
    });

    it('should capture snapshot from video element when no canvas is present', () => {
      const video = createMockVideo(container);
      const ref = { current: container };
      const { result } = renderHook(() => useFullscreenPreview(ref));

      const appendSpy = vi.spyOn(document.body, 'appendChild');

      act(() => {
        result.current.captureSnapshot();
      });

      // Verify a download link was created
      const linkCall = appendSpy.mock.calls.find(
        (call) => call[0] instanceof HTMLAnchorElement,
      );
      expect(linkCall).toBeDefined();

      const link = linkCall![0] as HTMLAnchorElement;
      expect(link.download).toMatch(/^snapshot_.*\.png$/);

      appendSpy.mockRestore();
      video.remove();
    });

    it('should prefer canvas over video when both exist', () => {
      const canvas = createMockCanvas(container);
      createMockVideo(container);

      const ref = { current: container };
      const { result } = renderHook(() => useFullscreenPreview(ref));

      const appendSpy = vi.spyOn(document.body, 'appendChild');

      act(() => {
        result.current.captureSnapshot();
      });

      const linkCall = appendSpy.mock.calls.find(
        (call) => call[0] instanceof HTMLAnchorElement,
      );
      expect(linkCall).toBeDefined();

      const link = linkCall![0] as HTMLAnchorElement;
      // Canvas produces our mocked data URL
      expect(link.href).toContain('MOCK_CANVAS_DATA');

      appendSpy.mockRestore();
      canvas.remove();
    });

    it('should not throw when no renderable element is found', () => {
      const ref = { current: container };
      const { result } = renderHook(() => useFullscreenPreview(ref));

      expect(() => {
        act(() => {
          result.current.captureSnapshot();
        });
      }).not.toThrow();
    });

    it('should not throw when containerRef is null', () => {
      const ref = { current: null };
      const { result } = renderHook(() => useFullscreenPreview(ref));

      expect(() => {
        act(() => {
          result.current.captureSnapshot();
        });
      }).not.toThrow();
    });

    it('should generate filename with timestamp pattern', () => {
      createMockCanvas(container);
      const ref = { current: container };
      const { result } = renderHook(() => useFullscreenPreview(ref));

      const appendSpy = vi.spyOn(document.body, 'appendChild');

      act(() => {
        result.current.captureSnapshot();
      });

      const linkCall = appendSpy.mock.calls.find(
        (call) => call[0] instanceof HTMLAnchorElement,
      );
      const link = linkCall![0] as HTMLAnchorElement;

      // Filename should match pattern: snapshot_YYYY-MM-DD_HH-MM-SS.png
      expect(link.download).toMatch(/^snapshot_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.png$/);

      appendSpy.mockRestore();
    });
  });
});
