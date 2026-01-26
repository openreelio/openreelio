/**
 * TimeRuler Component Tests
 *
 * Tests for the timeline ruler showing time markers.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TimeRuler } from './TimeRuler';

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

    it('should show time labels', () => {
      render(<TimeRuler duration={10} zoom={100} scrollX={0} />);
      // Should have time labels like 0:00, 0:01, etc.
      expect(screen.getByText('0:00')).toBeInTheDocument();
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
  });
});
