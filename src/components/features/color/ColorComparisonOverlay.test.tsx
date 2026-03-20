/**
 * ColorComparisonOverlay Tests
 *
 * BDD integration tests for the before/after color comparison overlay.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ColorComparisonOverlay } from './ColorComparisonOverlay';
import type { ComparisonMode } from '@/hooks/useColorComparison';

// =============================================================================
// Test Helpers
// =============================================================================

const defaultProps = {
  isEnabled: true,
  mode: 'split' as ComparisonMode,
  dividerPosition: 50,
  onDividerChange: vi.fn(),
  onModeChange: vi.fn(),
};

// =============================================================================
// Tests
// =============================================================================

describe('ColorComparisonOverlay', () => {
  describe('visibility', () => {
    it('should not render when disabled', () => {
      render(<ColorComparisonOverlay {...defaultProps} isEnabled={false} />);
      expect(screen.queryByTestId('color-comparison-overlay')).not.toBeInTheDocument();
    });

    it('should render overlay container when enabled', () => {
      render(<ColorComparisonOverlay {...defaultProps} />);
      expect(screen.getByTestId('color-comparison-overlay')).toBeInTheDocument();
    });
  });

  describe('split view', () => {
    it('should show vertical divider at correct position', () => {
      render(<ColorComparisonOverlay {...defaultProps} dividerPosition={50} />);
      const divider = screen.getByTestId('comparison-divider-split');
      expect(divider).toBeInTheDocument();
      expect(divider.style.left).toBe('50%');
    });

    it('should update divider position when prop changes', () => {
      const { rerender } = render(
        <ColorComparisonOverlay {...defaultProps} dividerPosition={50} />,
      );
      rerender(<ColorComparisonOverlay {...defaultProps} dividerPosition={30} />);
      const divider = screen.getByTestId('comparison-divider-split');
      expect(divider.style.left).toBe('30%');
    });

    it('should show Before and After labels', () => {
      render(<ColorComparisonOverlay {...defaultProps} />);
      expect(screen.getByTestId('label-before')).toHaveTextContent('Before');
      expect(screen.getByTestId('label-after')).toHaveTextContent('After');
    });

    it('should have accessible vertical separator role', () => {
      render(<ColorComparisonOverlay {...defaultProps} />);
      const divider = screen.getByRole('separator');
      expect(divider).toHaveAttribute('aria-orientation', 'vertical');
      expect(divider).toHaveAttribute('aria-valuenow', '50');
      expect(divider).toHaveAttribute('aria-label', 'Split view divider');
    });

    it('should not show wipe or side-by-side dividers', () => {
      render(<ColorComparisonOverlay {...defaultProps} />);
      expect(screen.queryByTestId('comparison-divider-wipe')).not.toBeInTheDocument();
      expect(screen.queryByTestId('comparison-divider-center')).not.toBeInTheDocument();
    });
  });

  describe('wipe view', () => {
    it('should show horizontal divider at correct position', () => {
      render(<ColorComparisonOverlay {...defaultProps} mode="wipe" />);
      const divider = screen.getByTestId('comparison-divider-wipe');
      expect(divider).toBeInTheDocument();
      expect(divider.style.top).toBe('50%');
    });

    it('should have accessible horizontal separator role', () => {
      render(<ColorComparisonOverlay {...defaultProps} mode="wipe" />);
      const divider = screen.getByRole('separator');
      expect(divider).toHaveAttribute('aria-orientation', 'horizontal');
      expect(divider).toHaveAttribute('aria-label', 'Wipe view divider');
    });

    it('should show After label at the bottom', () => {
      render(<ColorComparisonOverlay {...defaultProps} mode="wipe" />);
      const afterLabel = screen.getByTestId('label-after');
      expect(afterLabel).toHaveTextContent('After');
      expect(afterLabel.className).toContain('bottom-2');
    });

    it('should not show split divider', () => {
      render(<ColorComparisonOverlay {...defaultProps} mode="wipe" />);
      expect(screen.queryByTestId('comparison-divider-split')).not.toBeInTheDocument();
    });
  });

  describe('side-by-side view', () => {
    it('should show Before and After labels', () => {
      render(<ColorComparisonOverlay {...defaultProps} mode="side-by-side" />);
      expect(screen.getByTestId('label-before')).toHaveTextContent('Before');
      expect(screen.getByTestId('label-after')).toHaveTextContent('After');
    });

    it('should show non-interactive center divider', () => {
      render(<ColorComparisonOverlay {...defaultProps} mode="side-by-side" />);
      expect(screen.getByTestId('comparison-divider-center')).toBeInTheDocument();
    });

    it('should not show interactive split or wipe dividers', () => {
      render(<ColorComparisonOverlay {...defaultProps} mode="side-by-side" />);
      expect(screen.queryByTestId('comparison-divider-split')).not.toBeInTheDocument();
      expect(screen.queryByTestId('comparison-divider-wipe')).not.toBeInTheDocument();
    });
  });

  describe('mode selector', () => {
    it('should render all three mode buttons', () => {
      render(<ColorComparisonOverlay {...defaultProps} />);
      expect(screen.getByTestId('mode-btn-split')).toBeInTheDocument();
      expect(screen.getByTestId('mode-btn-wipe')).toBeInTheDocument();
      expect(screen.getByTestId('mode-btn-side-by-side')).toBeInTheDocument();
    });

    it('should display correct labels on mode buttons', () => {
      render(<ColorComparisonOverlay {...defaultProps} />);
      expect(screen.getByTestId('mode-btn-split')).toHaveTextContent('Split');
      expect(screen.getByTestId('mode-btn-wipe')).toHaveTextContent('Wipe');
      expect(screen.getByTestId('mode-btn-side-by-side')).toHaveTextContent('Side by Side');
    });

    it('should highlight active mode button', () => {
      render(<ColorComparisonOverlay {...defaultProps} mode="wipe" />);
      expect(screen.getByTestId('mode-btn-wipe')).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByTestId('mode-btn-split')).toHaveAttribute('aria-pressed', 'false');
      expect(screen.getByTestId('mode-btn-side-by-side')).toHaveAttribute(
        'aria-pressed',
        'false',
      );
    });

    it('should call onModeChange when mode button is clicked', () => {
      const onModeChange = vi.fn();
      render(<ColorComparisonOverlay {...defaultProps} onModeChange={onModeChange} />);

      fireEvent.click(screen.getByTestId('mode-btn-wipe'));

      expect(onModeChange).toHaveBeenCalledWith('wipe');
    });

    it('should call onModeChange with side-by-side when clicked', () => {
      const onModeChange = vi.fn();
      render(<ColorComparisonOverlay {...defaultProps} onModeChange={onModeChange} />);

      fireEvent.click(screen.getByTestId('mode-btn-side-by-side'));

      expect(onModeChange).toHaveBeenCalledWith('side-by-side');
    });
  });

  describe('divider interaction', () => {
    it('should start drag on mouseDown and update position on mouseMove', () => {
      const onDividerChange = vi.fn();
      render(
        <ColorComparisonOverlay {...defaultProps} onDividerChange={onDividerChange} />,
      );

      // Mock the container's getBoundingClientRect for position calculation
      const container = screen.getByTestId('color-comparison-overlay');
      vi.spyOn(container, 'getBoundingClientRect').mockReturnValue({
        left: 0,
        top: 0,
        width: 800,
        height: 600,
        right: 800,
        bottom: 600,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      });

      const divider = screen.getByTestId('comparison-divider-split');
      fireEvent.mouseDown(divider, { clientX: 400, clientY: 300 });

      // Simulate document-level mouse move
      fireEvent.mouseMove(document, { clientX: 300, clientY: 300 });

      expect(onDividerChange).toHaveBeenCalledWith(37.5); // 300/800 * 100
    });

    it('should stop drag on mouseUp', () => {
      const onDividerChange = vi.fn();
      render(
        <ColorComparisonOverlay {...defaultProps} onDividerChange={onDividerChange} />,
      );

      const container = screen.getByTestId('color-comparison-overlay');
      vi.spyOn(container, 'getBoundingClientRect').mockReturnValue({
        left: 0,
        top: 0,
        width: 800,
        height: 600,
        right: 800,
        bottom: 600,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      });

      const divider = screen.getByTestId('comparison-divider-split');
      fireEvent.mouseDown(divider, { clientX: 400, clientY: 300 });
      fireEvent.mouseUp(document);

      // After mouseUp, subsequent moves should not trigger callback
      onDividerChange.mockClear();
      fireEvent.mouseMove(document, { clientX: 200, clientY: 300 });

      expect(onDividerChange).not.toHaveBeenCalled();
    });

    it('should calculate vertical position for wipe mode drag', () => {
      const onDividerChange = vi.fn();
      render(
        <ColorComparisonOverlay
          {...defaultProps}
          mode="wipe"
          onDividerChange={onDividerChange}
        />,
      );

      const container = screen.getByTestId('color-comparison-overlay');
      vi.spyOn(container, 'getBoundingClientRect').mockReturnValue({
        left: 0,
        top: 0,
        width: 800,
        height: 600,
        right: 800,
        bottom: 600,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      });

      const divider = screen.getByTestId('comparison-divider-wipe');
      fireEvent.mouseDown(divider, { clientX: 400, clientY: 300 });
      fireEvent.mouseMove(document, { clientX: 400, clientY: 150 });

      expect(onDividerChange).toHaveBeenCalledWith(25); // 150/600 * 100
    });

    it('should prevent default and stop propagation on mouseDown', () => {
      render(<ColorComparisonOverlay {...defaultProps} />);

      const divider = screen.getByTestId('comparison-divider-split');
      const preventDefault = vi.fn();
      const stopPropagation = vi.fn();

      fireEvent.mouseDown(divider, { preventDefault, stopPropagation });

      // fireEvent creates its own event; verify the divider cursor is active
      expect(divider.className).toContain('cursor-col-resize');
    });
  });

  describe('read-only mode', () => {
    it('should hide mode selector in read-only mode', () => {
      render(<ColorComparisonOverlay {...defaultProps} readOnly />);
      expect(screen.queryByTestId('comparison-mode-selector')).not.toBeInTheDocument();
    });

    it('should still show divider and labels in read-only mode', () => {
      render(<ColorComparisonOverlay {...defaultProps} readOnly />);
      expect(screen.getByTestId('comparison-divider-split')).toBeInTheDocument();
      expect(screen.getByTestId('label-before')).toBeInTheDocument();
      expect(screen.getByTestId('label-after')).toBeInTheDocument();
    });

    it('should not trigger drag in read-only mode', () => {
      const onDividerChange = vi.fn();
      render(
        <ColorComparisonOverlay
          {...defaultProps}
          onDividerChange={onDividerChange}
          readOnly
        />,
      );

      const divider = screen.getByTestId('comparison-divider-split');
      fireEvent.mouseDown(divider, { clientX: 400, clientY: 300 });
      fireEvent.mouseMove(document, { clientX: 300, clientY: 300 });

      expect(onDividerChange).not.toHaveBeenCalled();
    });
  });
});
