/**
 * SeekBar Component Tests
 *
 * Tests for the video player seek bar.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SeekBar } from './SeekBar';

// =============================================================================
// Tests
// =============================================================================

describe('SeekBar', () => {
  const defaultProps = {
    currentTime: 30,
    duration: 120,
    buffered: 60,
  };

  // ===========================================================================
  // Rendering Tests
  // ===========================================================================

  describe('rendering', () => {
    it('should render seek bar container', () => {
      render(<SeekBar {...defaultProps} />);
      expect(screen.getByTestId('seek-bar')).toBeInTheDocument();
    });

    it('should render progress bar', () => {
      render(<SeekBar {...defaultProps} />);
      expect(screen.getByTestId('seek-bar')).toBeInTheDocument();
    });

    it('should render buffer bar', () => {
      render(<SeekBar {...defaultProps} />);
      expect(screen.getByTestId('buffer-bar')).toBeInTheDocument();
    });

    it('should have correct progress width based on currentTime and duration', () => {
      render(<SeekBar {...defaultProps} />);
      // 30/120 = 25%
      const progressBar = screen.getByTestId('seek-bar').querySelector('[class*="bg-primary"]');
      expect(progressBar).toHaveStyle({ width: '25%' });
    });

    it('should have correct buffer width', () => {
      render(<SeekBar {...defaultProps} />);
      // 60/120 = 50%
      const bufferBar = screen.getByTestId('buffer-bar');
      expect(bufferBar).toHaveStyle({ width: '50%' });
    });
  });

  // ===========================================================================
  // Interaction Tests
  // ===========================================================================

  describe('interactions', () => {
    it('should call onSeek when clicked', () => {
      const onSeek = vi.fn();
      render(<SeekBar {...defaultProps} onSeek={onSeek} />);

      const seekBar = screen.getByTestId('seek-bar');

      // Mock getBoundingClientRect
      seekBar.getBoundingClientRect = vi.fn().mockReturnValue({
        left: 0,
        width: 200,
      });

      fireEvent.click(seekBar, { clientX: 100 });

      // Click at 100px of 200px = 50% of 120s = 60s
      expect(onSeek).toHaveBeenCalledWith(60);
    });

    it('should not call onSeek when disabled', () => {
      const onSeek = vi.fn();
      render(<SeekBar {...defaultProps} onSeek={onSeek} disabled />);

      const seekBar = screen.getByTestId('seek-bar');
      fireEvent.click(seekBar, { clientX: 100 });

      expect(onSeek).not.toHaveBeenCalled();
    });

    it('should handle zero duration gracefully', () => {
      render(<SeekBar currentTime={0} duration={0} />);

      const progressBar = screen.getByTestId('seek-bar').querySelector('[class*="bg-primary"]');
      expect(progressBar).toHaveStyle({ width: '0%' });
    });
  });

  // ===========================================================================
  // Accessibility Tests
  // ===========================================================================

  describe('accessibility', () => {
    it('should have slider role', () => {
      render(<SeekBar {...defaultProps} />);
      expect(screen.getByRole('slider')).toBeInTheDocument();
    });

    it('should have correct aria attributes', () => {
      render(<SeekBar {...defaultProps} />);
      const slider = screen.getByRole('slider');

      expect(slider).toHaveAttribute('aria-valuenow', '30');
      expect(slider).toHaveAttribute('aria-valuemin', '0');
      expect(slider).toHaveAttribute('aria-valuemax', '120');
    });

    it('should have aria-label', () => {
      render(<SeekBar {...defaultProps} />);
      expect(screen.getByRole('slider')).toHaveAttribute('aria-label', 'Seek');
    });
  });
});
