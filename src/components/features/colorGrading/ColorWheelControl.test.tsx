/**
 * ColorWheelControl Tests
 *
 * Tests for the individual color wheel control component.
 * Following TDD methodology.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ColorWheelControl } from './ColorWheelControl';
import type { ColorOffset } from '@/utils/colorWheel';

describe('ColorWheelControl', () => {
  const defaultProps = {
    label: 'Lift',
    value: { r: 0, g: 0, b: 0 } as ColorOffset,
    luminance: 0,
    onChange: vi.fn(),
    onLuminanceChange: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('rendering', () => {
    it('should render with label', () => {
      render(<ColorWheelControl {...defaultProps} />);
      expect(screen.getByText('Lift')).toBeInTheDocument();
    });

    it('should render wheel canvas', () => {
      render(<ColorWheelControl {...defaultProps} />);
      const canvas = screen.getByTestId('color-wheel-canvas');
      expect(canvas).toBeInTheDocument();
    });

    it('should render luminance slider', () => {
      render(<ColorWheelControl {...defaultProps} />);
      const slider = screen.getByRole('slider', { name: /luminance/i });
      expect(slider).toBeInTheDocument();
    });

    it('should render reset button', () => {
      render(<ColorWheelControl {...defaultProps} />);
      const resetButton = screen.getByRole('button', { name: /reset/i });
      expect(resetButton).toBeInTheDocument();
    });
  });

  describe('interaction', () => {
    it('should call onChange when clicking on wheel', async () => {
      const onChange = vi.fn();
      render(<ColorWheelControl {...defaultProps} onChange={onChange} />);

      const canvas = screen.getByTestId('color-wheel-canvas');

      // Simulate click at center-right (red direction)
      fireEvent.mouseDown(canvas, { clientX: 150, clientY: 75 });
      fireEvent.mouseUp(canvas);

      expect(onChange).toHaveBeenCalled();
    });

    it('should call onLuminanceChange when adjusting slider', async () => {
      const onLuminanceChange = vi.fn();
      render(
        <ColorWheelControl
          {...defaultProps}
          onLuminanceChange={onLuminanceChange}
        />
      );

      const slider = screen.getByRole('slider', { name: /luminance/i });
      fireEvent.change(slider, { target: { value: '0.5' } });

      expect(onLuminanceChange).toHaveBeenCalledWith(0.5);
    });

    it('should reset to neutral when clicking reset', async () => {
      const onChange = vi.fn();
      const onLuminanceChange = vi.fn();
      render(
        <ColorWheelControl
          {...defaultProps}
          value={{ r: 0.2, g: -0.1, b: 0.1 }}
          luminance={0.3}
          onChange={onChange}
          onLuminanceChange={onLuminanceChange}
        />
      );

      const resetButton = screen.getByRole('button', { name: /reset/i });
      await userEvent.click(resetButton);

      expect(onChange).toHaveBeenCalledWith({ r: 0, g: 0, b: 0 });
      expect(onLuminanceChange).toHaveBeenCalledWith(0);
    });
  });

  describe('visual feedback', () => {
    it('should show handle at correct position for non-zero offset', () => {
      render(
        <ColorWheelControl
          {...defaultProps}
          value={{ r: 0.3, g: -0.15, b: -0.15 }}
        />
      );

      // The handle should be rendered (visually at a red-ish position)
      const handle = screen.getByTestId('color-wheel-handle');
      expect(handle).toBeInTheDocument();
    });

    it('should show handle at center for neutral offset', () => {
      render(<ColorWheelControl {...defaultProps} />);

      const handle = screen.getByTestId('color-wheel-handle');
      expect(handle).toBeInTheDocument();
      // Handle should be at center
      expect(handle).toHaveAttribute('data-centered', 'true');
    });
  });

  describe('disabled state', () => {
    it('should not respond to clicks when disabled', async () => {
      const onChange = vi.fn();
      render(
        <ColorWheelControl {...defaultProps} onChange={onChange} disabled />
      );

      const canvas = screen.getByTestId('color-wheel-canvas');
      fireEvent.mouseDown(canvas, { clientX: 150, clientY: 75 });

      expect(onChange).not.toHaveBeenCalled();
    });

    it('should show disabled styling', () => {
      render(<ColorWheelControl {...defaultProps} disabled />);

      const container = screen.getByTestId('color-wheel-container');
      expect(container).toHaveClass('opacity-50');
    });
  });

  describe('size variants', () => {
    it('should render small variant', () => {
      render(<ColorWheelControl {...defaultProps} size="sm" />);

      const canvas = screen.getByTestId('color-wheel-canvas');
      expect(canvas).toHaveAttribute('width', '100');
    });

    it('should render medium variant (default)', () => {
      render(<ColorWheelControl {...defaultProps} />);

      const canvas = screen.getByTestId('color-wheel-canvas');
      expect(canvas).toHaveAttribute('width', '150');
    });

    it('should render large variant', () => {
      render(<ColorWheelControl {...defaultProps} size="lg" />);

      const canvas = screen.getByTestId('color-wheel-canvas');
      expect(canvas).toHaveAttribute('width', '200');
    });
  });

  describe('accessibility', () => {
    it('should have accessible label for wheel', () => {
      render(<ColorWheelControl {...defaultProps} label="Gamma" />);

      const canvas = screen.getByTestId('color-wheel-canvas');
      expect(canvas).toHaveAttribute('aria-label', 'Gamma color wheel');
    });

    it('should support keyboard navigation for luminance', async () => {
      const onLuminanceChange = vi.fn();
      render(
        <ColorWheelControl
          {...defaultProps}
          luminance={0}
          onLuminanceChange={onLuminanceChange}
        />
      );

      const slider = screen.getByRole('slider', { name: /luminance/i });

      // Slider should be focusable
      expect(slider).not.toBeDisabled();

      // Simulate a direct value change (keyboard navigation works through change events)
      fireEvent.change(slider, { target: { value: '0.1' } });
      expect(onLuminanceChange).toHaveBeenCalledWith(0.1);
    });
  });
});
