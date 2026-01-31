/**
 * VideoScopesPanel Component Tests
 *
 * TDD: Tests for the video scopes container panel.
 */

import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { VideoScopesPanel } from './VideoScopesPanel';
import type { FrameAnalysis } from '@/utils/scopeAnalysis';
import { createEmptyAnalysis } from '@/utils/scopeAnalysis';

// =============================================================================
// Canvas Mock
// =============================================================================

// Mock canvas context for JSDOM
beforeAll(() => {
  // Create a mock canvas context
  const mockContext = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    font: '',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    globalCompositeOperation: 'source-over',
    fillRect: vi.fn(),
    clearRect: vi.fn(),
    strokeRect: vi.fn(),
    fillText: vi.fn(),
    strokeText: vi.fn(),
    beginPath: vi.fn(),
    closePath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    arc: vi.fn(),
    stroke: vi.fn(),
    fill: vi.fn(),
    setLineDash: vi.fn(),
    getLineDash: vi.fn(() => []),
    save: vi.fn(),
    restore: vi.fn(),
    scale: vi.fn(),
    rotate: vi.fn(),
    translate: vi.fn(),
    transform: vi.fn(),
    setTransform: vi.fn(),
    measureText: vi.fn(() => ({ width: 10 })),
    getImageData: vi.fn(() => ({
      data: new Uint8ClampedArray(256 * 256 * 4),
      width: 256,
      height: 256,
    })),
    putImageData: vi.fn(),
    createImageData: vi.fn(),
    createLinearGradient: vi.fn(() => ({
      addColorStop: vi.fn(),
    })),
    createRadialGradient: vi.fn(() => ({
      addColorStop: vi.fn(),
    })),
  };

  // Override getContext on HTMLCanvasElement prototype
  HTMLCanvasElement.prototype.getContext = vi.fn(() => mockContext) as unknown as typeof HTMLCanvasElement.prototype.getContext;
});

// =============================================================================
// Test Data
// =============================================================================

function createMockAnalysis(): FrameAnalysis {
  const analysis = createEmptyAnalysis();

  // Add some data for a mid-gray image
  analysis.histogram.luminance[128] = 1000;
  analysis.histogram.red[128] = 1000;
  analysis.histogram.green[128] = 1000;
  analysis.histogram.blue[128] = 1000;
  analysis.histogram.maxCount = 1000;

  analysis.waveform.columns = Array(100).fill(null).map(() => ({
    min: 100,
    max: 150,
    avg: 128,
    distribution: new Array(256).fill(0),
  }));
  analysis.waveform.width = 100;

  analysis.vectorscope.grid = Array(256).fill(null).map(() => new Array(256).fill(0));
  analysis.vectorscope.grid[128][128] = 1000;
  analysis.vectorscope.size = 256;
  analysis.vectorscope.maxIntensity = 1000;

  analysis.rgbParade.red = { columns: analysis.waveform.columns, width: 100 };
  analysis.rgbParade.green = { columns: analysis.waveform.columns, width: 100 };
  analysis.rgbParade.blue = { columns: analysis.waveform.columns, width: 100 };

  analysis.timestamp = Date.now();
  analysis.width = 1920;
  analysis.height = 1080;

  return analysis;
}

// =============================================================================
// Tests
// =============================================================================

describe('VideoScopesPanel', () => {
  const defaultProps = {
    analysis: createMockAnalysis(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ===========================================================================
  // Rendering Tests
  // ===========================================================================

  describe('rendering', () => {
    it('should render the panel', () => {
      render(<VideoScopesPanel {...defaultProps} />);

      expect(screen.getByTestId('video-scopes-panel')).toBeInTheDocument();
      expect(screen.getByText('Video Scopes')).toBeInTheDocument();
    });

    it('should render all scope tabs', () => {
      render(<VideoScopesPanel {...defaultProps} />);

      expect(screen.getByRole('tab', { name: /histogram/i })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: /waveform/i })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: /vectorscope/i })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: /rgb parade/i })).toBeInTheDocument();
    });

    it('should show histogram display by default', () => {
      render(<VideoScopesPanel {...defaultProps} />);

      expect(screen.getByTestId('histogram-display')).toBeInTheDocument();
    });

    it('should show initial scope when specified', () => {
      render(<VideoScopesPanel {...defaultProps} initialScope="waveform" />);

      expect(screen.getByTestId('waveform-display')).toBeInTheDocument();
    });

    it('should show analyzing indicator when isAnalyzing is true', () => {
      const { container } = render(<VideoScopesPanel {...defaultProps} isAnalyzing={true} />);

      // Look for the pulsing indicator
      const indicator = container.querySelector('.animate-pulse');
      expect(indicator).toBeInTheDocument();
    });

    it('should render without analysis data', () => {
      render(<VideoScopesPanel />);

      expect(screen.getByTestId('video-scopes-panel')).toBeInTheDocument();
      expect(screen.getByTestId('histogram-display')).toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Tab Navigation Tests
  // ===========================================================================

  describe('tab navigation', () => {
    it('should switch to waveform when tab is clicked', () => {
      render(<VideoScopesPanel {...defaultProps} />);

      fireEvent.click(screen.getByRole('tab', { name: /waveform/i }));

      expect(screen.getByTestId('waveform-display')).toBeInTheDocument();
      expect(screen.queryByTestId('histogram-display')).not.toBeInTheDocument();
    });

    it('should switch to vectorscope when tab is clicked', () => {
      render(<VideoScopesPanel {...defaultProps} />);

      fireEvent.click(screen.getByRole('tab', { name: /vectorscope/i }));

      expect(screen.getByTestId('vectorscope-display')).toBeInTheDocument();
    });

    it('should switch to RGB parade when tab is clicked', () => {
      render(<VideoScopesPanel {...defaultProps} />);

      fireEvent.click(screen.getByRole('tab', { name: /rgb parade/i }));

      expect(screen.getByTestId('rgb-parade-display')).toBeInTheDocument();
    });

    it('should call onScopeChange when scope changes', () => {
      const onScopeChange = vi.fn();
      render(<VideoScopesPanel {...defaultProps} onScopeChange={onScopeChange} />);

      fireEvent.click(screen.getByRole('tab', { name: /waveform/i }));

      expect(onScopeChange).toHaveBeenCalledWith('waveform');
    });

    it('should highlight active tab', () => {
      render(<VideoScopesPanel {...defaultProps} />);

      const histogramTab = screen.getByRole('tab', { name: /histogram/i });
      expect(histogramTab).toHaveAttribute('aria-selected', 'true');

      fireEvent.click(screen.getByRole('tab', { name: /waveform/i }));

      const waveformTab = screen.getByRole('tab', { name: /waveform/i });
      expect(waveformTab).toHaveAttribute('aria-selected', 'true');
      expect(histogramTab).toHaveAttribute('aria-selected', 'false');
    });
  });

  // ===========================================================================
  // Settings Tests
  // ===========================================================================

  describe('settings', () => {
    it('should show settings button', () => {
      render(<VideoScopesPanel {...defaultProps} />);

      expect(screen.getByRole('button', { name: /settings/i })).toBeInTheDocument();
    });

    it('should toggle settings panel when button is clicked', () => {
      render(<VideoScopesPanel {...defaultProps} />);

      const settingsButton = screen.getByRole('button', { name: /settings/i });
      fireEvent.click(settingsButton);

      // Settings panel should be visible
      expect(screen.getByText('Display Mode')).toBeInTheDocument();
    });

    it('should show histogram mode options for histogram scope', () => {
      render(<VideoScopesPanel {...defaultProps} />);

      fireEvent.click(screen.getByRole('button', { name: /settings/i }));

      expect(screen.getByRole('combobox')).toBeInTheDocument();
      expect(screen.getByRole('option', { name: /rgb overlay/i })).toBeInTheDocument();
      expect(screen.getByRole('option', { name: /luminance/i })).toBeInTheDocument();
    });

    it('should show logarithmic checkbox for histogram scope', () => {
      render(<VideoScopesPanel {...defaultProps} />);

      fireEvent.click(screen.getByRole('button', { name: /settings/i }));

      expect(screen.getByRole('checkbox')).toBeInTheDocument();
      expect(screen.getByText(/logarithmic/i)).toBeInTheDocument();
    });

    it('should show waveform mode options for waveform scope', () => {
      render(<VideoScopesPanel {...defaultProps} initialScope="waveform" />);

      fireEvent.click(screen.getByRole('button', { name: /settings/i }));

      expect(screen.getByRole('option', { name: /filled/i })).toBeInTheDocument();
      expect(screen.getByRole('option', { name: /line/i })).toBeInTheDocument();
      expect(screen.getByRole('option', { name: /intensity/i })).toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Exposure Indicator Tests
  // ===========================================================================

  describe('exposure indicator', () => {
    it('should display exposure level', () => {
      render(<VideoScopesPanel {...defaultProps} />);

      expect(screen.getByText('Exposure:')).toBeInTheDocument();
    });

    it('should show balanced exposure for mid-gray image', () => {
      render(<VideoScopesPanel {...defaultProps} />);

      // Mid-gray should show ~0.00 exposure
      expect(screen.getByText(/0\.00/)).toBeInTheDocument();
    });

    it('should show underexposed indicator for dark image', () => {
      const darkAnalysis = createMockAnalysis();
      // Shift luminance to dark values
      darkAnalysis.histogram.luminance = new Array(256).fill(0);
      darkAnalysis.histogram.luminance[32] = 1000;

      render(<VideoScopesPanel analysis={darkAnalysis} />);

      // Should show negative exposure value
      const exposureValue = screen.getByText(/-0\./);
      expect(exposureValue).toBeInTheDocument();
    });

    it('should show overexposed indicator for bright image', () => {
      const brightAnalysis = createMockAnalysis();
      // Shift luminance to bright values
      brightAnalysis.histogram.luminance = new Array(256).fill(0);
      brightAnalysis.histogram.luminance[224] = 1000;

      render(<VideoScopesPanel analysis={brightAnalysis} />);

      // Should show positive exposure value
      const exposureValue = screen.getByText(/\+0\./);
      expect(exposureValue).toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Display Component Tests
  // ===========================================================================

  describe('display components', () => {
    it('should pass correct dimensions to histogram display', () => {
      render(<VideoScopesPanel {...defaultProps} width={400} height={300} />);

      const canvas = screen.getByTestId('histogram-display');
      expect(canvas).toHaveAttribute('width', '384'); // 400 - 16 padding
      expect(canvas).toHaveAttribute('height', '300');
    });

    it('should pass correct dimensions to waveform display', () => {
      render(<VideoScopesPanel {...defaultProps} width={400} height={300} initialScope="waveform" />);

      const canvas = screen.getByTestId('waveform-display');
      expect(canvas).toHaveAttribute('width', '384');
      expect(canvas).toHaveAttribute('height', '300');
    });

    it('should use square dimensions for vectorscope', () => {
      render(<VideoScopesPanel {...defaultProps} width={400} height={300} initialScope="vectorscope" />);

      const canvas = screen.getByTestId('vectorscope-display');
      // Should use smaller of width or height
      expect(canvas).toHaveAttribute('width', '300');
      expect(canvas).toHaveAttribute('height', '300');
    });
  });

  // ===========================================================================
  // Accessibility Tests
  // ===========================================================================

  describe('accessibility', () => {
    it('should have proper role attributes on tabs', () => {
      render(<VideoScopesPanel {...defaultProps} />);

      const tabs = screen.getAllByRole('tab');
      expect(tabs).toHaveLength(4);
    });

    it('should have aria-label on scope displays', () => {
      render(<VideoScopesPanel {...defaultProps} />);

      const histogram = screen.getByTestId('histogram-display');
      expect(histogram).toHaveAttribute('aria-label');
    });

    it('should have accessible settings button', () => {
      render(<VideoScopesPanel {...defaultProps} />);

      const settingsButton = screen.getByRole('button', { name: /settings/i });
      expect(settingsButton).toHaveAttribute('aria-label');
    });
  });
});
