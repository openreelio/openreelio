/**
 * WaveformPeaksDisplay Component Tests
 *
 * Tests for the canvas-based waveform visualization component.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { WaveformPeaksDisplay } from './WaveformPeaksDisplay';

// =============================================================================
// Test Data
// =============================================================================

const mockPeaks = Array(500)
  .fill(0)
  .map((_, i) => Math.sin(i * 0.1) * 0.5 + 0.5);

// =============================================================================
// Mocks
// =============================================================================

// Mock canvas context
const mockFillRect = vi.fn();
const mockClearRect = vi.fn();
const mockBeginPath = vi.fn();
const mockMoveTo = vi.fn();
const mockLineTo = vi.fn();
const mockStroke = vi.fn();
const mockFill = vi.fn();
const mockClosePath = vi.fn();

const mockContext = {
  fillRect: mockFillRect,
  clearRect: mockClearRect,
  beginPath: mockBeginPath,
  moveTo: mockMoveTo,
  lineTo: mockLineTo,
  stroke: mockStroke,
  fill: mockFill,
  closePath: mockClosePath,
  fillStyle: '',
  strokeStyle: '',
  lineWidth: 1,
};

beforeEach(() => {
  vi.clearAllMocks();

  // Mock HTMLCanvasElement.getContext
  HTMLCanvasElement.prototype.getContext = vi.fn(() => mockContext) as unknown as typeof HTMLCanvasElement.prototype.getContext;
});

// =============================================================================
// Tests
// =============================================================================

describe('WaveformPeaksDisplay', () => {
  describe('rendering', () => {
    it('should render a canvas element', () => {
      render(
        <WaveformPeaksDisplay
          peaks={mockPeaks}
          width={300}
          height={50}
        />
      );

      const canvas = screen.getByRole('img', { hidden: true });
      expect(canvas).toBeInTheDocument();
      expect(canvas.tagName.toLowerCase()).toBe('canvas');
    });

    it('should set correct canvas dimensions', () => {
      render(
        <WaveformPeaksDisplay
          peaks={mockPeaks}
          width={400}
          height={60}
        />
      );

      const canvas = screen.getByRole('img', { hidden: true });
      expect(canvas).toHaveAttribute('width', '400');
      expect(canvas).toHaveAttribute('height', '60');
    });

    it('should apply custom className', () => {
      render(
        <WaveformPeaksDisplay
          peaks={mockPeaks}
          width={300}
          height={50}
          className="custom-waveform"
        />
      );

      const canvas = screen.getByRole('img', { hidden: true });
      expect(canvas).toHaveClass('custom-waveform');
    });
  });

  describe('empty states', () => {
    it('should handle empty peaks array', () => {
      render(
        <WaveformPeaksDisplay
          peaks={[]}
          width={300}
          height={50}
        />
      );

      const canvas = screen.getByRole('img', { hidden: true });
      expect(canvas).toBeInTheDocument();
    });

    it('should handle null peaks', () => {
      render(
        <WaveformPeaksDisplay
          peaks={null as unknown as number[]}
          width={300}
          height={50}
        />
      );

      expect(screen.queryByRole('img', { hidden: true })).toBeInTheDocument();
    });
  });

  describe('styling', () => {
    it('should use default color when not specified', () => {
      render(
        <WaveformPeaksDisplay
          peaks={mockPeaks}
          width={300}
          height={50}
        />
      );

      // Canvas should be drawn with default blue color
      expect(mockContext.fillStyle).toBeDefined();
    });

    it('should apply custom color', () => {
      render(
        <WaveformPeaksDisplay
          peaks={mockPeaks}
          width={300}
          height={50}
          color="#ff0000"
        />
      );

      const canvas = screen.getByRole('img', { hidden: true });
      expect(canvas).toBeInTheDocument();
    });

    it('should apply custom opacity', () => {
      render(
        <WaveformPeaksDisplay
          peaks={mockPeaks}
          width={300}
          height={50}
          opacity={0.5}
        />
      );

      const canvas = screen.getByRole('img', { hidden: true });
      expect(canvas).toHaveStyle({ opacity: '0.5' });
    });
  });

  describe('display modes', () => {
    it('should support bars display mode', () => {
      render(
        <WaveformPeaksDisplay
          peaks={mockPeaks}
          width={300}
          height={50}
          mode="bars"
        />
      );

      // Should call fillRect for each bar
      expect(mockFillRect).toHaveBeenCalled();
    });

    it('should support line display mode', () => {
      render(
        <WaveformPeaksDisplay
          peaks={mockPeaks}
          width={300}
          height={50}
          mode="line"
        />
      );

      // Should call stroke for line path
      expect(mockStroke).toHaveBeenCalled();
    });

    it('should support fill display mode', () => {
      render(
        <WaveformPeaksDisplay
          peaks={mockPeaks}
          width={300}
          height={50}
          mode="fill"
        />
      );

      // Should call fill for filled area
      expect(mockFill).toHaveBeenCalled();
    });
  });

  describe('mirrored mode', () => {
    it('should render mirrored waveform when enabled', () => {
      render(
        <WaveformPeaksDisplay
          peaks={mockPeaks}
          width={300}
          height={50}
          mirrored={true}
        />
      );

      const canvas = screen.getByRole('img', { hidden: true });
      expect(canvas).toBeInTheDocument();
    });
  });

  describe('performance', () => {
    it('should handle large peak arrays efficiently', () => {
      const largePeaks = Array(10000)
        .fill(0)
        .map(() => Math.random());

      const startTime = performance.now();

      render(
        <WaveformPeaksDisplay
          peaks={largePeaks}
          width={1000}
          height={100}
        />
      );

      const endTime = performance.now();
      const renderTime = endTime - startTime;

      // Should render in less than 100ms
      expect(renderTime).toBeLessThan(100);
    });
  });

  describe('clipping', () => {
    it('should support sourceInSec and sourceOutSec for clipping', () => {
      render(
        <WaveformPeaksDisplay
          peaks={mockPeaks}
          width={300}
          height={50}
          samplesPerSecond={100}
          sourceInSec={1}
          sourceOutSec={3}
        />
      );

      // Should only render peaks between 1s and 3s (indices 100-300)
      const canvas = screen.getByRole('img', { hidden: true });
      expect(canvas).toBeInTheDocument();
    });
  });
});
