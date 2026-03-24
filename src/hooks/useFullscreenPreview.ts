/**
 * useFullscreenPreview Hook
 *
 * Manages fullscreen mode and snapshot capture for the preview player.
 * Uses the browser Fullscreen API on a container element, and captures
 * the current frame from a canvas or video element within that container.
 */

import { useState, useCallback, useEffect, type RefObject } from 'react';
import { createLogger } from '@/services/logger';

const logger = createLogger('useFullscreenPreview');

// =============================================================================
// Types
// =============================================================================

export interface UseFullscreenPreviewResult {
  /** Whether the preview is currently in fullscreen mode */
  isFullscreen: boolean;
  /** Toggle fullscreen mode on the container element */
  toggleFullscreen: () => void;
  /** Capture the current preview frame as a PNG and trigger a download */
  captureSnapshot: () => void;
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Find the best renderable element inside the container for snapshot capture.
 * Prefers canvas (composite output) over video (single-source proxy).
 */
function findRenderableElement(
  container: HTMLElement,
): HTMLCanvasElement | HTMLVideoElement | null {
  const canvas = container.querySelector('canvas');
  if (canvas && canvas.width > 0 && canvas.height > 0) {
    return canvas;
  }

  const video = container.querySelector('video');
  if (video && video.readyState >= 2) {
    return video;
  }

  return null;
}

/**
 * Draw the current frame of a video element onto an offscreen canvas
 * and return the canvas for data extraction.
 */
function drawVideoToCanvas(video: HTMLVideoElement): HTMLCanvasElement {
  const offscreen = document.createElement('canvas');
  offscreen.width = video.videoWidth || video.clientWidth;
  offscreen.height = video.videoHeight || video.clientHeight;
  const ctx = offscreen.getContext('2d');
  if (ctx) {
    ctx.drawImage(video, 0, 0, offscreen.width, offscreen.height);
  }
  return offscreen;
}

/**
 * Generate a timestamped filename for snapshots.
 */
function generateSnapshotFilename(): string {
  const now = new Date();
  const timestamp = now
    .toISOString()
    .replace(/[:.]/g, '-')
    .replace('T', '_')
    .slice(0, 19);
  return `snapshot_${timestamp}.png`;
}

/**
 * Trigger a browser download of a data URL.
 */
function downloadDataUrl(dataUrl: string, filename: string): void {
  const link = document.createElement('a');
  link.download = filename;
  link.href = dataUrl;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

// =============================================================================
// Hook
// =============================================================================

export function useFullscreenPreview(
  containerRef: RefObject<HTMLElement | null>,
): UseFullscreenPreviewResult {
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Sync state with browser fullscreen changes (handles Escape, F11, etc.)
  // Scoped to containerRef so other elements' fullscreen state doesn't interfere.
  useEffect(() => {
    const handleFullscreenChange = (): void => {
      setIsFullscreen(document.fullscreenElement === containerRef.current);
    };

    // Sync initial state on mount
    handleFullscreenChange();
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
    };
  }, [containerRef]);

  const toggleFullscreen = useCallback((): void => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    if (document.fullscreenElement === container) {
      document.exitFullscreen().catch((error: unknown) => {
        logger.warn('Failed to exit fullscreen', { error });
      });
    } else if (!document.fullscreenElement) {
      container.requestFullscreen().catch((error: unknown) => {
        logger.warn('Failed to enter fullscreen', { error });
      });
    }
  }, [containerRef]);

  const captureSnapshot = useCallback((): void => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const element = findRenderableElement(container);
    if (!element) {
      logger.warn('No canvas or video element found for snapshot capture');
      return;
    }

    try {
      let dataUrl: string;

      if (element instanceof HTMLCanvasElement) {
        dataUrl = element.toDataURL('image/png');
      } else {
        const offscreen = drawVideoToCanvas(element);
        dataUrl = offscreen.toDataURL('image/png');
      }

      const filename = generateSnapshotFilename();
      downloadDataUrl(dataUrl, filename);
      logger.info('Snapshot captured', { filename });
    } catch (error: unknown) {
      logger.error('Failed to capture snapshot', { error });
    }
  }, [containerRef]);

  return { isFullscreen, toggleFullscreen, captureSnapshot };
}
