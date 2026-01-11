/**
 * Playhead Component Tests
 *
 * Tests for the timeline playhead indicator.
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Playhead } from './Playhead';

describe('Playhead', () => {
  // ===========================================================================
  // Rendering Tests
  // ===========================================================================

  describe('rendering', () => {
    it('should render playhead', () => {
      render(<Playhead position={0} zoom={100} />);
      expect(screen.getByTestId('playhead')).toBeInTheDocument();
    });

    it('should position playhead based on time and zoom', () => {
      const { container } = render(<Playhead position={5} zoom={100} />);
      const playhead = container.firstChild as HTMLElement;

      // At 5 seconds with zoom 100px/sec = 500px left position
      expect(playhead).toHaveStyle({ left: '500px' });
    });

    it('should update position when position prop changes', () => {
      const { container, rerender } = render(<Playhead position={5} zoom={100} />);
      let playhead = container.firstChild as HTMLElement;

      expect(playhead).toHaveStyle({ left: '500px' });

      rerender(<Playhead position={10} zoom={100} />);
      playhead = container.firstChild as HTMLElement;

      expect(playhead).toHaveStyle({ left: '1000px' });
    });

    it('should span full track height', () => {
      const { container } = render(<Playhead position={0} zoom={100} />);
      const playhead = container.firstChild as HTMLElement;

      expect(playhead).toHaveClass('h-full');
    });
  });

  // ===========================================================================
  // Styling Tests
  // ===========================================================================

  describe('styling', () => {
    it('should have distinctive color', () => {
      const { container } = render(<Playhead position={0} zoom={100} />);
      const playhead = container.firstChild as HTMLElement;

      // Playhead should have primary/accent color
      expect(playhead).toHaveClass('bg-primary-500');
    });

    it('should have appropriate width', () => {
      const { container } = render(<Playhead position={0} zoom={100} />);
      const playhead = container.firstChild as HTMLElement;

      // Playhead should be thin (1-2px)
      expect(playhead).toHaveClass('w-0.5');
    });

    it('should have a head marker at the top', () => {
      render(<Playhead position={0} zoom={100} />);
      expect(screen.getByTestId('playhead-head')).toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Playing State Tests
  // ===========================================================================

  describe('playing state', () => {
    it('should show playing indicator when isPlaying is true', () => {
      render(<Playhead position={0} zoom={100} isPlaying />);
      const playhead = screen.getByTestId('playhead');

      expect(playhead).toHaveAttribute('data-playing', 'true');
    });

    it('should not show playing indicator when isPlaying is false', () => {
      render(<Playhead position={0} zoom={100} isPlaying={false} />);
      const playhead = screen.getByTestId('playhead');

      expect(playhead).toHaveAttribute('data-playing', 'false');
    });
  });
});
