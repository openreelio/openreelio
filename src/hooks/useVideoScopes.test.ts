import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useVideoScopes } from './useVideoScopes';

const originalGetContext = HTMLCanvasElement.prototype.getContext;

function installCanvasMock(): void {
  HTMLCanvasElement.prototype.getContext = vi.fn(function getContext(
    this: HTMLCanvasElement,
    contextId: string,
  ) {
    if (contextId !== '2d') {
      return null;
    }

    return {
      canvas: this,
      getImageData: vi.fn(() => ({
        data: new Uint8ClampedArray([
          32, 64, 96, 255, 128, 160, 192, 255, 224, 224, 224, 255, 8, 16, 24, 255,
        ]),
        width: 2,
        height: 2,
      })),
    } as unknown as CanvasRenderingContext2D;
  }) as unknown as typeof HTMLCanvasElement.prototype.getContext;
}

describe('useVideoScopes', () => {
  beforeEach(() => {
    installCanvasMock();
  });

  afterEach(() => {
    HTMLCanvasElement.prototype.getContext = originalGetContext;
  });

  it('should report unavailable source when no preview canvas is connected', () => {
    const canvasRef = { current: null };
    const { result } = renderHook(() =>
      useVideoScopes(canvasRef, { enabled: false, autoStart: false }),
    );

    act(() => {
      result.current.analyze();
    });

    expect(result.current.sourceStatus).toBe('unavailable');
    expect(result.current.sourceWidth).toBe(0);
    expect(result.current.sourceHeight).toBe(0);
  });

  it('should analyze image data from the connected preview canvas', () => {
    const canvas = document.createElement('canvas');
    canvas.width = 2;
    canvas.height = 2;
    const canvasRef = { current: canvas };

    const { result } = renderHook(() =>
      useVideoScopes(canvasRef, { enabled: false, autoStart: false }),
    );

    act(() => {
      result.current.analyze();
    });

    expect(result.current.sourceStatus).toBe('connected');
    expect(result.current.sourceWidth).toBe(2);
    expect(result.current.sourceHeight).toBe(2);
    expect(result.current.lastAnalyzedAt).toEqual(expect.any(Number));
    expect(result.current.analysis.histogram.maxCount).toBeGreaterThan(0);
  });
});
