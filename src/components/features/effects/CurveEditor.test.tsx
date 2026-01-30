/**
 * CurveEditor Component Tests
 *
 * Tests for the cubic Bezier curve editor used in keyframe easing.
 * TDD: RED phase - writing tests first
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CurveEditor } from './CurveEditor';
import type { BezierControlPoints } from '@/types';

// =============================================================================
// Test Data
// =============================================================================

const defaultPoints: BezierControlPoints = [0.25, 0.1, 0.25, 1.0];

// =============================================================================
// Rendering Tests
// =============================================================================

describe('CurveEditor', () => {
  describe('rendering', () => {
    it('should render the curve canvas', () => {
      render(
        <CurveEditor
          points={defaultPoints}
          onChange={vi.fn()}
        />
      );

      expect(screen.getByRole('img', { name: /bezier curve/i })).toBeInTheDocument();
    });

    it('should render control point handles', () => {
      render(
        <CurveEditor
          points={defaultPoints}
          onChange={vi.fn()}
        />
      );

      // Two control points (P1 and P2)
      const handles = screen.getAllByRole('slider');
      expect(handles).toHaveLength(2);
    });

    it('should render numeric inputs for control points', () => {
      render(
        <CurveEditor
          points={defaultPoints}
          onChange={vi.fn()}
        />
      );

      // Four inputs: x1, y1, x2, y2
      const inputs = screen.getAllByRole('spinbutton');
      expect(inputs).toHaveLength(4);
    });

    it('should display current point values in inputs', () => {
      render(
        <CurveEditor
          points={[0.5, 0.25, 0.75, 0.9]}
          onChange={vi.fn()}
        />
      );

      const inputs = screen.getAllByRole('spinbutton');
      expect(inputs[0]).toHaveValue(0.5);
      expect(inputs[1]).toHaveValue(0.25);
      expect(inputs[2]).toHaveValue(0.75);
      expect(inputs[3]).toHaveValue(0.9);
    });
  });

  // ===========================================================================
  // Input Change Tests
  // ===========================================================================

  describe('numeric input changes', () => {
    it('should call onChange when x1 input changes', () => {
      const onChange = vi.fn();
      render(
        <CurveEditor
          points={defaultPoints}
          onChange={onChange}
        />
      );

      const inputs = screen.getAllByRole('spinbutton');
      fireEvent.change(inputs[0], { target: { value: '0.5' } });

      expect(onChange).toHaveBeenCalledWith([0.5, 0.1, 0.25, 1.0]);
    });

    it('should call onChange when y1 input changes', () => {
      const onChange = vi.fn();
      render(
        <CurveEditor
          points={defaultPoints}
          onChange={onChange}
        />
      );

      const inputs = screen.getAllByRole('spinbutton');
      fireEvent.change(inputs[1], { target: { value: '0.5' } });

      expect(onChange).toHaveBeenCalledWith([0.25, 0.5, 0.25, 1.0]);
    });

    it('should clamp x values to 0-1 range', () => {
      const onChange = vi.fn();
      render(
        <CurveEditor
          points={defaultPoints}
          onChange={onChange}
        />
      );

      const inputs = screen.getAllByRole('spinbutton');
      fireEvent.change(inputs[0], { target: { value: '1.5' } });

      expect(onChange).toHaveBeenCalledWith([1, 0.1, 0.25, 1.0]);
    });

    it('should allow y values outside 0-1 range for overshoot', () => {
      const onChange = vi.fn();
      render(
        <CurveEditor
          points={defaultPoints}
          onChange={onChange}
        />
      );

      const inputs = screen.getAllByRole('spinbutton');
      fireEvent.change(inputs[1], { target: { value: '-0.5' } });

      expect(onChange).toHaveBeenCalledWith([0.25, -0.5, 0.25, 1.0]);
    });
  });

  // ===========================================================================
  // Preset Tests
  // ===========================================================================

  describe('presets', () => {
    it('should render preset buttons', () => {
      render(
        <CurveEditor
          points={defaultPoints}
          onChange={vi.fn()}
        />
      );

      expect(screen.getByRole('button', { name: /^linear$/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^ease$/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^ease-in$/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^ease-out$/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^ease-in-out$/i })).toBeInTheDocument();
    });

    it('should apply linear preset when clicked', () => {
      const onChange = vi.fn();
      render(
        <CurveEditor
          points={defaultPoints}
          onChange={onChange}
        />
      );

      fireEvent.click(screen.getByRole('button', { name: /linear/i }));

      expect(onChange).toHaveBeenCalledWith([0, 0, 1, 1]);
    });

    it('should apply ease-in preset when clicked', () => {
      const onChange = vi.fn();
      render(
        <CurveEditor
          points={defaultPoints}
          onChange={onChange}
        />
      );

      fireEvent.click(screen.getByRole('button', { name: /ease-in$/i }));

      expect(onChange).toHaveBeenCalledWith([0.42, 0, 1, 1]);
    });

    it('should apply ease-out preset when clicked', () => {
      const onChange = vi.fn();
      render(
        <CurveEditor
          points={defaultPoints}
          onChange={onChange}
        />
      );

      fireEvent.click(screen.getByRole('button', { name: /ease-out/i }));

      expect(onChange).toHaveBeenCalledWith([0, 0, 0.58, 1]);
    });

    it('should apply ease-in-out preset when clicked', () => {
      const onChange = vi.fn();
      render(
        <CurveEditor
          points={defaultPoints}
          onChange={onChange}
        />
      );

      fireEvent.click(screen.getByRole('button', { name: /ease-in-out/i }));

      expect(onChange).toHaveBeenCalledWith([0.42, 0, 0.58, 1]);
    });
  });

  // ===========================================================================
  // Read-Only Mode Tests
  // ===========================================================================

  describe('read-only mode', () => {
    it('should disable inputs when readOnly is true', () => {
      render(
        <CurveEditor
          points={defaultPoints}
          onChange={vi.fn()}
          readOnly
        />
      );

      const inputs = screen.getAllByRole('spinbutton');
      inputs.forEach(input => {
        expect(input).toBeDisabled();
      });
    });

    it('should disable preset buttons when readOnly is true', () => {
      render(
        <CurveEditor
          points={defaultPoints}
          onChange={vi.fn()}
          readOnly
        />
      );

      const presetButtons = screen.getAllByRole('button');
      presetButtons.forEach(button => {
        expect(button).toBeDisabled();
      });
    });
  });

  // ===========================================================================
  // Accessibility Tests
  // ===========================================================================

  describe('accessibility', () => {
    it('should have accessible labels for control points', () => {
      render(
        <CurveEditor
          points={defaultPoints}
          onChange={vi.fn()}
        />
      );

      expect(screen.getByLabelText(/x1/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/y1/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/x2/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/y2/i)).toBeInTheDocument();
    });

    it('should have aria-label on curve canvas', () => {
      render(
        <CurveEditor
          points={defaultPoints}
          onChange={vi.fn()}
        />
      );

      const canvas = screen.getByRole('img', { name: /bezier curve/i });
      expect(canvas).toHaveAttribute('aria-label');
    });
  });

  // ===========================================================================
  // Copy/Paste Tests
  // ===========================================================================

  describe('copy functionality', () => {
    it('should render a copy button', () => {
      render(
        <CurveEditor
          points={defaultPoints}
          onChange={vi.fn()}
        />
      );

      expect(screen.getByRole('button', { name: /copy/i })).toBeInTheDocument();
    });

    it('should copy CSS cubic-bezier function to clipboard', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.assign(navigator, {
        clipboard: { writeText },
      });

      render(
        <CurveEditor
          points={[0.42, 0, 0.58, 1]}
          onChange={vi.fn()}
        />
      );

      fireEvent.click(screen.getByRole('button', { name: /copy/i }));

      expect(writeText).toHaveBeenCalledWith('cubic-bezier(0.42, 0, 0.58, 1)');
    });
  });
});
