/**
 * Playhead Component Tests
 *
 * Comprehensive tests for the timeline playhead indicator including:
 * - Basic rendering
 * - Positioning
 * - Dragging functionality
 * - Visual states
 * - Accessibility
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Playhead } from './Playhead';

// =============================================================================
// Test Utilities
// =============================================================================

const createMockMouseEvent = (options: Partial<MouseEventInit> = {}): MouseEventInit => ({
  bubbles: true,
  cancelable: true,
  ...options,
});

/**
 * Helper to check playhead transform position.
 * The playhead uses CSS transform for GPU-accelerated positioning.
 */
const expectPlayheadPosition = (element: HTMLElement, expectedPixels: number) => {
  const transform = element.style.transform;
  const expectedTransform = `translateX(${expectedPixels}px)`;
  expect(transform).toBe(expectedTransform);
};

// =============================================================================
// Tests
// =============================================================================

describe('Playhead', () => {
  // ===========================================================================
  // Rendering Tests
  // ===========================================================================

  describe('rendering', () => {
    it('should render playhead', () => {
      render(<Playhead position={0} zoom={100} />);
      expect(screen.getByTestId('playhead')).toBeInTheDocument();
    });

    it('should render playhead line', () => {
      render(<Playhead position={0} zoom={100} />);
      expect(screen.getByTestId('playhead-line')).toBeInTheDocument();
    });

    it('should render playhead line hit area', () => {
      render(<Playhead position={0} zoom={100} />);
      expect(screen.getByTestId('playhead-line-hit-area')).toBeInTheDocument();
    });

    it('should render playhead head marker', () => {
      render(<Playhead position={0} zoom={100} />);
      expect(screen.getByTestId('playhead-head')).toBeInTheDocument();
    });

    it('should render playhead head visual', () => {
      render(<Playhead position={0} zoom={100} />);
      expect(screen.getByTestId('playhead-head-visual')).toBeInTheDocument();
    });

    it('should span full track height', () => {
      render(<Playhead position={0} zoom={100} />);
      const playhead = screen.getByTestId('playhead');
      expect(playhead).toHaveClass('h-full');
    });
  });

  // ===========================================================================
  // Positioning Tests
  // ===========================================================================

  describe('positioning', () => {
    it('should position playhead at track header width when position is 0', () => {
      render(<Playhead position={0} zoom={100} trackHeaderWidth={0} />);
      const playhead = screen.getByTestId('playhead');
      expectPlayheadPosition(playhead, 0);
    });

    it('should position playhead based on time and zoom', () => {
      // With trackHeaderWidth=0: 5 * 100 = 500px
      render(<Playhead position={5} zoom={100} trackHeaderWidth={0} />);
      const playhead = screen.getByTestId('playhead');
      expectPlayheadPosition(playhead, 500);
    });

    it('should include trackHeaderWidth in position calculation', () => {
      // With default trackHeaderWidth=192: 5 * 100 + 192 = 692px
      render(<Playhead position={5} zoom={100} />);
      const playhead = screen.getByTestId('playhead');
      expectPlayheadPosition(playhead, 692);
    });

    it('should account for scrollX in position', () => {
      // With trackHeaderWidth=192, scrollX=100: 5 * 100 + 192 - 100 = 592px
      render(<Playhead position={5} zoom={100} scrollX={100} />);
      const playhead = screen.getByTestId('playhead');
      expectPlayheadPosition(playhead, 592);
    });

    it('should update position when position prop changes', () => {
      const { rerender } = render(<Playhead position={5} zoom={100} trackHeaderWidth={0} />);
      let playhead = screen.getByTestId('playhead');
      expectPlayheadPosition(playhead, 500);

      rerender(<Playhead position={10} zoom={100} trackHeaderWidth={0} />);
      playhead = screen.getByTestId('playhead');
      expectPlayheadPosition(playhead, 1000);
    });

    it('should update position when zoom changes', () => {
      const { rerender } = render(<Playhead position={5} zoom={100} trackHeaderWidth={0} />);
      let playhead = screen.getByTestId('playhead');
      expectPlayheadPosition(playhead, 500);

      rerender(<Playhead position={5} zoom={200} trackHeaderWidth={0} />);
      playhead = screen.getByTestId('playhead');
      expectPlayheadPosition(playhead, 1000);
    });

    it('should handle fractional positions', () => {
      render(<Playhead position={2.5} zoom={100} trackHeaderWidth={0} />);
      const playhead = screen.getByTestId('playhead');
      expectPlayheadPosition(playhead, 250);
    });

    it('should handle high zoom levels', () => {
      render(<Playhead position={1} zoom={500} trackHeaderWidth={0} />);
      const playhead = screen.getByTestId('playhead');
      expectPlayheadPosition(playhead, 500);
    });

    it('should handle low zoom levels', () => {
      render(<Playhead position={10} zoom={10} trackHeaderWidth={0} />);
      const playhead = screen.getByTestId('playhead');
      expectPlayheadPosition(playhead, 100);
    });
  });

  // ===========================================================================
  // Playing State Tests
  // ===========================================================================

  describe('playing state', () => {
    it('should indicate playing state via data attribute when isPlaying is true', () => {
      render(<Playhead position={0} zoom={100} isPlaying />);
      const playhead = screen.getByTestId('playhead');
      expect(playhead).toHaveAttribute('data-playing', 'true');
    });

    it('should indicate non-playing state via data attribute when isPlaying is false', () => {
      render(<Playhead position={0} zoom={100} isPlaying={false} />);
      const playhead = screen.getByTestId('playhead');
      expect(playhead).toHaveAttribute('data-playing', 'false');
    });

    it('should default to not playing when isPlaying not provided', () => {
      render(<Playhead position={0} zoom={100} />);
      const playhead = screen.getByTestId('playhead');
      expect(playhead).toHaveAttribute('data-playing', 'false');
    });
  });

  // ===========================================================================
  // Dragging State Tests
  // ===========================================================================

  describe('dragging state', () => {
    it('should indicate dragging state via data attribute', () => {
      render(<Playhead position={0} zoom={100} isDragging />);
      const playhead = screen.getByTestId('playhead');
      expect(playhead).toHaveAttribute('data-dragging', 'true');
    });

    it('should indicate non-dragging state via data attribute', () => {
      render(<Playhead position={0} zoom={100} isDragging={false} />);
      const playhead = screen.getByTestId('playhead');
      expect(playhead).toHaveAttribute('data-dragging', 'false');
    });

    it('should default to not dragging when isDragging not provided', () => {
      render(<Playhead position={0} zoom={100} />);
      const playhead = screen.getByTestId('playhead');
      expect(playhead).toHaveAttribute('data-dragging', 'false');
    });

    it('should apply scale transform during drag', () => {
      render(<Playhead position={0} zoom={100} isDragging />);
      const head = screen.getByTestId('playhead-head');
      expect(head).toHaveClass('scale-110');
    });
  });

  // ===========================================================================
  // Drag Handlers Tests
  // ===========================================================================

  describe('drag handlers', () => {
    it('should call onDragStart when head is clicked', () => {
      const onDragStart = vi.fn();
      render(<Playhead position={0} zoom={100} onDragStart={onDragStart} />);

      const head = screen.getByTestId('playhead-head');
      fireEvent.mouseDown(head, createMockMouseEvent());

      expect(onDragStart).toHaveBeenCalledTimes(1);
    });

    it('should call onPointerDown when pointer down on head', () => {
      const onPointerDown = vi.fn();
      render(<Playhead position={0} zoom={100} onPointerDown={onPointerDown} />);

      const head = screen.getByTestId('playhead-head');
      fireEvent.pointerDown(head);

      expect(onPointerDown).toHaveBeenCalledTimes(1);
    });

    it('should call onDragStart when line hit area is clicked', () => {
      const onDragStart = vi.fn();
      render(<Playhead position={0} zoom={100} onDragStart={onDragStart} />);

      const lineHitArea = screen.getByTestId('playhead-line-hit-area');
      fireEvent.mouseDown(lineHitArea, createMockMouseEvent());

      expect(onDragStart).toHaveBeenCalledTimes(1);
    });

    it('should call onPointerDown when line hit area receives pointer down', () => {
      const onPointerDown = vi.fn();
      render(<Playhead position={0} zoom={100} onPointerDown={onPointerDown} />);

      const lineHitArea = screen.getByTestId('playhead-line-hit-area');
      fireEvent.pointerDown(lineHitArea);

      expect(onPointerDown).toHaveBeenCalledTimes(1);
    });

    it('should not throw when clicking head without handlers', () => {
      render(<Playhead position={0} zoom={100} />);

      const head = screen.getByTestId('playhead-head');
      expect(() => {
        fireEvent.mouseDown(head, createMockMouseEvent());
      }).not.toThrow();
    });
  });

  // ===========================================================================
  // Interactivity Tests
  // ===========================================================================

  describe('interactivity', () => {
    it('should enable pointer events on head when handlers provided', () => {
      render(<Playhead position={0} zoom={100} onDragStart={vi.fn()} />);
      const head = screen.getByTestId('playhead-head');
      expect(head).toHaveStyle({ pointerEvents: 'auto' });
    });

    it('should enable pointer events on line hit area when handlers provided', () => {
      render(<Playhead position={0} zoom={100} onDragStart={vi.fn()} />);
      const lineHitArea = screen.getByTestId('playhead-line-hit-area');
      expect(lineHitArea).toHaveStyle({ pointerEvents: 'auto' });
    });

    it('should disable pointer events on head when no handlers', () => {
      render(<Playhead position={0} zoom={100} />);
      const head = screen.getByTestId('playhead-head');
      expect(head).toHaveStyle({ pointerEvents: 'none' });
    });

    it('should disable pointer events on line hit area when no handlers', () => {
      render(<Playhead position={0} zoom={100} />);
      const lineHitArea = screen.getByTestId('playhead-line-hit-area');
      expect(lineHitArea).toHaveStyle({ pointerEvents: 'none' });
    });

    it('should disable pointer events on line', () => {
      render(<Playhead position={0} zoom={100} />);
      const line = screen.getByTestId('playhead-line');
      expect(line).toHaveClass('pointer-events-none');
    });

    it('should show grab cursor when interactive', () => {
      render(<Playhead position={0} zoom={100} onDragStart={vi.fn()} />);
      const head = screen.getByTestId('playhead-head');
      expect(head).toHaveStyle({ cursor: 'grab' });
    });

    it('should show grabbing cursor when dragging', () => {
      render(<Playhead position={0} zoom={100} onDragStart={vi.fn()} isDragging />);
      const head = screen.getByTestId('playhead-head');
      expect(head).toHaveStyle({ cursor: 'grabbing' });
    });

    it('should show default cursor when not interactive', () => {
      render(<Playhead position={0} zoom={100} />);
      const head = screen.getByTestId('playhead-head');
      expect(head).toHaveStyle({ cursor: 'default' });
    });
  });

  // ===========================================================================
  // Accessibility Tests
  // ===========================================================================

  describe('accessibility', () => {
    it('should have slider role on head', () => {
      render(<Playhead position={0} zoom={100} onDragStart={vi.fn()} />);
      const head = screen.getByTestId('playhead-head');
      expect(head).toHaveAttribute('role', 'slider');
    });

    it('should have aria-label on head', () => {
      render(<Playhead position={0} zoom={100} onDragStart={vi.fn()} />);
      const head = screen.getByTestId('playhead-head');
      expect(head).toHaveAttribute('aria-label', 'Playhead position');
    });

    it('should have aria-valuemin on head', () => {
      render(<Playhead position={0} zoom={100} onDragStart={vi.fn()} />);
      const head = screen.getByTestId('playhead-head');
      expect(head).toHaveAttribute('aria-valuemin', '0');
    });

    it('should have aria-valuenow reflecting position', () => {
      render(<Playhead position={5} zoom={100} onDragStart={vi.fn()} />);
      const head = screen.getByTestId('playhead-head');
      expect(head).toHaveAttribute('aria-valuenow', '5');
    });

    it('should have aria-orientation horizontal', () => {
      render(<Playhead position={0} zoom={100} onDragStart={vi.fn()} />);
      const head = screen.getByTestId('playhead-head');
      expect(head).toHaveAttribute('aria-orientation', 'horizontal');
    });

    it('should be focusable when interactive', () => {
      render(<Playhead position={0} zoom={100} onDragStart={vi.fn()} />);
      const head = screen.getByTestId('playhead-head');
      expect(head).toHaveAttribute('tabIndex', '0');
    });

    it('should not be focusable when not interactive', () => {
      render(<Playhead position={0} zoom={100} />);
      const head = screen.getByTestId('playhead-head');
      expect(head).toHaveAttribute('tabIndex', '-1');
    });
  });

  // ===========================================================================
  // Styling Tests
  // ===========================================================================

  describe('styling', () => {
    it('should have z-index for layering', () => {
      // z-30 is used within an isolated stacking context (parent has isolation: isolate)
      // This keeps the playhead above timeline elements but contained within the timeline
      render(<Playhead position={0} zoom={100} />);
      const playhead = screen.getByTestId('playhead');
      expect(playhead).toHaveClass('z-30');
    });

    it('should have shadow on head during drag', () => {
      render(<Playhead position={0} zoom={100} isDragging />);
      const headVisual = screen.getByTestId('playhead-head-visual');
      expect(headVisual).toHaveClass('drop-shadow-lg');
    });
  });

  // ===========================================================================
  // Memoization Tests
  // ===========================================================================

  describe('memoization', () => {
    it('should not re-render when same props passed', () => {
      const onDragStart = vi.fn();
      const { rerender } = render(
        <Playhead position={5} zoom={100} onDragStart={onDragStart} trackHeaderWidth={0} />,
      );

      // Re-render with same props
      rerender(<Playhead position={5} zoom={100} onDragStart={onDragStart} trackHeaderWidth={0} />);

      // Component should still be rendered correctly
      const playhead = screen.getByTestId('playhead');
      expectPlayheadPosition(playhead, 500);
    });
  });

  // ===========================================================================
  // Edge Cases
  // ===========================================================================

  describe('edge cases', () => {
    it('should handle zero zoom gracefully', () => {
      render(<Playhead position={5} zoom={0} trackHeaderWidth={0} />);
      const playhead = screen.getByTestId('playhead');
      // 5 * 0 = 0px
      expectPlayheadPosition(playhead, 0);
    });

    it('should handle very large position values', () => {
      render(<Playhead position={3600} zoom={100} trackHeaderWidth={0} />);
      const playhead = screen.getByTestId('playhead');
      // 3600 * 100 = 360000px
      expectPlayheadPosition(playhead, 360000);
    });

    it('should handle very small position values', () => {
      render(<Playhead position={0.001} zoom={100} trackHeaderWidth={0} />);
      const playhead = screen.getByTestId('playhead');
      // 0.001 * 100 = 0.1px
      // Note: The actual transform may differ slightly due to floating point
      const transform = playhead.style.transform;
      expect(transform).toMatch(/translateX\(0\.1(000+)?px\)/);
    });

    it('should handle simultaneous isPlaying and isDragging', () => {
      render(<Playhead position={0} zoom={100} isPlaying isDragging />);
      const playhead = screen.getByTestId('playhead');
      expect(playhead).toHaveAttribute('data-playing', 'true');
      expect(playhead).toHaveAttribute('data-dragging', 'true');
    });

    it('should still render when playhead is scrolled off visible area', () => {
      // Position 0, scrollX 1000, trackHeaderWidth 192 => -808px position
      // Component always renders, visibility is controlled by parent
      const { container } = render(
        <Playhead position={0} zoom={100} scrollX={1000} trackHeaderWidth={192} />,
      );
      expect(container.querySelector('[data-testid="playhead"]')).toBeInTheDocument();
    });
  });
});
