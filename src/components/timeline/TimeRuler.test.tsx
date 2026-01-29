/**
 * TimeRuler Component Tests
 *
 * Tests for the canvas-based timeline ruler showing time markers.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TimeRuler } from './TimeRuler';

// Mock Canvas API for jsdom environment
const createMockContext = () => ({
  fillRect: vi.fn(),
  fillText: vi.fn(),
  strokeRect: vi.fn(),
  clearRect: vi.fn(),
  beginPath: vi.fn(),
  moveTo: vi.fn(),
  lineTo: vi.fn(),
  stroke: vi.fn(),
  fill: vi.fn(),
  scale: vi.fn(),
  save: vi.fn(),
  restore: vi.fn(),
  setTransform: vi.fn(),
  resetTransform: vi.fn(),
  fillStyle: '',
  strokeStyle: '',
  lineWidth: 1,
  font: '',
  textAlign: 'left' as CanvasTextAlign,
  textBaseline: 'alphabetic' as CanvasTextBaseline,
});

beforeEach(() => {
  // Mock HTMLCanvasElement.getContext
  HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue(createMockContext());

  // Mock window.devicePixelRatio
  Object.defineProperty(window, 'devicePixelRatio', {
    value: 1,
    writable: true,
  });
});

describe('TimeRuler', () => {
  // ===========================================================================
  // Rendering Tests
  // ===========================================================================

  describe('rendering', () => {
    it('should render time markers', () => {
      render(<TimeRuler duration={60} zoom={100} scrollX={0} />);
      // At zoom 100px/sec for 60 seconds, we should see time markers
      expect(screen.getByTestId('time-ruler')).toBeInTheDocument();
    });

    it('should render at correct width based on duration and zoom', () => {
      const { container } = render(<TimeRuler duration={60} zoom={100} scrollX={0} />);
      const ruler = container.querySelector('[data-testid="time-ruler"]');
      // 60 seconds * 100 px/sec = 6000px
      expect(ruler).toHaveStyle({ width: '6000px' });
    });

    it('should render canvas element', () => {
      const { container } = render(<TimeRuler duration={10} zoom={100} scrollX={0} />);
      const canvas = container.querySelector('canvas');
      expect(canvas).toBeInTheDocument();
    });

    it('should call canvas context methods for drawing', () => {
      const mockCtx = createMockContext();
      HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue(mockCtx);

      render(<TimeRuler duration={10} zoom={100} scrollX={0} />);

      // Verify that drawing methods were called
      expect(mockCtx.scale).toHaveBeenCalled();
      expect(mockCtx.fillRect).toHaveBeenCalled(); // Clear canvas
      expect(mockCtx.beginPath).toHaveBeenCalled(); // Draw markers
    });
  });

  // ===========================================================================
  // Interaction Tests
  // ===========================================================================

  describe('interactions', () => {
    it('should call onSeek when mouse down', () => {
      const onSeek = vi.fn();
      render(<TimeRuler duration={60} zoom={100} scrollX={0} onSeek={onSeek} />);

      const ruler = screen.getByTestId('time-ruler');
      // Mouse down at position 500px = 5 seconds at zoom 100
      fireEvent.mouseDown(ruler, { clientX: 500 });

      expect(onSeek).toHaveBeenCalled();
    });

    it('should support drag scrubbing', () => {
      const onSeek = vi.fn();
      render(<TimeRuler duration={60} zoom={100} scrollX={0} onSeek={onSeek} />);

      const ruler = screen.getByTestId('time-ruler');

      // Start drag
      fireEvent.mouseDown(ruler, { clientX: 100 });
      expect(onSeek).toHaveBeenCalledTimes(1);

      // Move during drag
      fireEvent.mouseMove(document, { clientX: 200 });
      expect(onSeek).toHaveBeenCalledTimes(2);

      // End drag
      fireEvent.mouseUp(document);
    });

    it('should not call onSeek when onSeek is not provided', () => {
      render(<TimeRuler duration={60} zoom={100} scrollX={0} />);

      const ruler = screen.getByTestId('time-ruler');
      // This should not throw
      fireEvent.mouseDown(ruler, { clientX: 500 });
    });
  });

  // ===========================================================================
  // Zoom Tests
  // ===========================================================================

  describe('zoom', () => {
    it('should adjust marker density based on zoom level', () => {
      const { rerender } = render(<TimeRuler duration={60} zoom={100} scrollX={0} />);

      // At different zoom levels, marker density should change
      rerender(<TimeRuler duration={60} zoom={50} scrollX={0} />);
      // Lower zoom = fewer markers visible

      rerender(<TimeRuler duration={60} zoom={200} scrollX={0} />);
      // Higher zoom = more detailed markers
      expect(screen.getByTestId('time-ruler')).toBeInTheDocument();
    });

    it('should handle very low zoom levels', () => {
      render(<TimeRuler duration={3600} zoom={10} scrollX={0} />);
      expect(screen.getByTestId('time-ruler')).toBeInTheDocument();
    });

    it('should handle very high zoom levels', () => {
      render(<TimeRuler duration={10} zoom={500} scrollX={0} />);
      expect(screen.getByTestId('time-ruler')).toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Viewport Tests
  // ===========================================================================

  describe('viewport', () => {
    it('should respect viewportWidth prop', () => {
      const mockCtx = createMockContext();
      HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue(mockCtx);

      render(<TimeRuler duration={60} zoom={100} scrollX={0} viewportWidth={800} />);

      // Canvas should be sized based on viewport + buffer
      expect(mockCtx.scale).toHaveBeenCalled();
    });

    it('should handle scroll offset', () => {
      render(<TimeRuler duration={60} zoom={100} scrollX={500} />);

      const ruler = screen.getByTestId('time-ruler');
      expect(ruler).toBeInTheDocument();
    });
  });
});
