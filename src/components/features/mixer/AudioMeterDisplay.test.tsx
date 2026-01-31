/**
 * AudioMeterDisplay Tests
 *
 * TDD: Tests for the VU/peak meter display component.
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AudioMeterDisplay } from './AudioMeterDisplay';

// =============================================================================
// Rendering Tests
// =============================================================================

describe('AudioMeterDisplay', () => {
  describe('rendering', () => {
    it('should render the meter display', () => {
      render(<AudioMeterDisplay levelDb={-20} />);

      expect(screen.getByTestId('audio-meter-display')).toBeInTheDocument();
    });

    it('should render meter bar', () => {
      render(<AudioMeterDisplay levelDb={-20} />);

      expect(screen.getByTestId('meter-bar')).toBeInTheDocument();
    });

    it('should render scale when showScale is true', () => {
      render(<AudioMeterDisplay levelDb={-20} showScale={true} />);

      expect(screen.getByTestId('meter-scale')).toBeInTheDocument();
    });

    it('should not render scale when showScale is false', () => {
      render(<AudioMeterDisplay levelDb={-20} showScale={false} />);

      expect(screen.queryByTestId('meter-scale')).not.toBeInTheDocument();
    });

    it('should apply custom className', () => {
      render(<AudioMeterDisplay levelDb={-20} className="custom-class" />);

      expect(screen.getByTestId('audio-meter-display')).toHaveClass('custom-class');
    });
  });

  // ===========================================================================
  // Orientation Tests
  // ===========================================================================

  describe('orientation', () => {
    it('should render vertically by default', () => {
      render(<AudioMeterDisplay levelDb={-20} />);

      const meter = screen.getByTestId('audio-meter-display');
      expect(meter).toHaveClass('flex-row');
    });

    it('should render horizontally when orientation is horizontal', () => {
      render(<AudioMeterDisplay levelDb={-20} orientation="horizontal" />);

      const meter = screen.getByTestId('audio-meter-display');
      expect(meter).toHaveClass('flex-col');
    });
  });

  // ===========================================================================
  // Level Display Tests
  // ===========================================================================

  describe('level display', () => {
    it('should have aria-label with current level', () => {
      render(<AudioMeterDisplay levelDb={-12.5} />);

      const meter = screen.getByTestId('audio-meter-display');
      expect(meter).toHaveAttribute('aria-label', 'Audio meter showing -12.5 dB');
    });

    it('should handle very low levels', () => {
      render(<AudioMeterDisplay levelDb={-60} />);

      expect(screen.getByTestId('meter-bar')).toBeInTheDocument();
    });

    it('should handle 0 dB level', () => {
      render(<AudioMeterDisplay levelDb={0} />);

      expect(screen.getByTestId('meter-bar')).toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Peak Indicator Tests
  // ===========================================================================

  describe('peak indicator', () => {
    it('should render peak indicator when peakDb is provided', () => {
      render(<AudioMeterDisplay levelDb={-20} peakDb={-10} />);

      expect(screen.getByTestId('peak-indicator')).toBeInTheDocument();
    });

    it('should not render peak indicator when peakDb is not provided', () => {
      render(<AudioMeterDisplay levelDb={-20} />);

      expect(screen.queryByTestId('peak-indicator')).not.toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Clipping Indicator Tests
  // ===========================================================================

  describe('clipping indicator', () => {
    it('should render clipping indicator when clipping is true', () => {
      render(<AudioMeterDisplay levelDb={-1} clipping={true} />);

      expect(screen.getByTestId('clipping-indicator')).toBeInTheDocument();
    });

    it('should not render clipping indicator when clipping is false', () => {
      render(<AudioMeterDisplay levelDb={-1} clipping={false} />);

      expect(screen.queryByTestId('clipping-indicator')).not.toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Size Tests
  // ===========================================================================

  describe('size', () => {
    it('should use default size', () => {
      render(<AudioMeterDisplay levelDb={-20} />);

      const meterBar = screen.getByTestId('meter-bar');
      // Default size is 150, vertical orientation means height
      expect(meterBar).toHaveStyle({ height: '150px' });
    });

    it('should use custom size', () => {
      render(<AudioMeterDisplay levelDb={-20} size={200} />);

      const meterBar = screen.getByTestId('meter-bar');
      expect(meterBar).toHaveStyle({ height: '200px' });
    });

    it('should use default thickness', () => {
      render(<AudioMeterDisplay levelDb={-20} />);

      const meterBar = screen.getByTestId('meter-bar');
      // Default thickness is 8, vertical orientation means width
      expect(meterBar).toHaveStyle({ width: '8px' });
    });

    it('should use custom thickness', () => {
      render(<AudioMeterDisplay levelDb={-20} thickness={12} />);

      const meterBar = screen.getByTestId('meter-bar');
      expect(meterBar).toHaveStyle({ width: '12px' });
    });
  });

  // ===========================================================================
  // dB Range Tests
  // ===========================================================================

  describe('dB range', () => {
    it('should use default minDb and maxDb', () => {
      render(<AudioMeterDisplay levelDb={-30} />);

      // The meter should render without error
      expect(screen.getByTestId('meter-bar')).toBeInTheDocument();
    });

    it('should use custom minDb and maxDb', () => {
      render(<AudioMeterDisplay levelDb={-30} minDb={-80} maxDb={6} />);

      expect(screen.getByTestId('meter-bar')).toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Scale Markings Tests
  // ===========================================================================

  describe('scale markings', () => {
    it('should render dB scale markings', () => {
      render(<AudioMeterDisplay levelDb={-20} showScale={true} />);

      const scale = screen.getByTestId('meter-scale');
      // Should contain standard marking values
      expect(scale).toHaveTextContent('-60');
      expect(scale).toHaveTextContent('-6');
      expect(scale).toHaveTextContent('0');
    });

    it('should filter markings to visible range', () => {
      render(<AudioMeterDisplay levelDb={-20} minDb={-30} maxDb={0} showScale={true} />);

      const scale = screen.getByTestId('meter-scale');
      // -60 and -48 should not appear (out of range)
      expect(scale).not.toHaveTextContent('-60');
      expect(scale).not.toHaveTextContent('-48');
    });
  });
});
