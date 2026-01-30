/**
 * KeyframeEditor Component Tests
 *
 * Tests for the keyframe editor that allows adding, editing, and deleting
 * keyframes for effect parameters.
 * TDD: RED phase - writing tests first
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { KeyframeEditor } from './KeyframeEditor';
import type { Keyframe, ParamDef } from '@/types';

// =============================================================================
// Test Data
// =============================================================================

const createKeyframe = (
  timeOffset: number,
  value: number,
  easing: Keyframe['easing'] = 'linear'
): Keyframe => ({
  timeOffset,
  value: { type: 'float', value },
  easing,
});

const mockParamDef: ParamDef = {
  name: 'brightness',
  label: 'Brightness',
  default: { type: 'float', value: 0 },
  min: -1,
  max: 1,
  step: 0.01,
};

const mockKeyframes: Keyframe[] = [
  createKeyframe(0, 0),
  createKeyframe(1, 0.5),
  createKeyframe(2, 1),
];

// =============================================================================
// Rendering Tests
// =============================================================================

describe('KeyframeEditor', () => {
  describe('rendering', () => {
    it('should render the keyframe editor container', () => {
      render(
        <KeyframeEditor
          paramDef={mockParamDef}
          keyframes={[]}
          currentTime={0}
          onChange={vi.fn()}
        />
      );

      expect(screen.getByTestId('keyframe-editor')).toBeInTheDocument();
    });

    it('should display parameter label', () => {
      render(
        <KeyframeEditor
          paramDef={mockParamDef}
          keyframes={[]}
          currentTime={0}
          onChange={vi.fn()}
        />
      );

      expect(screen.getByText('Brightness')).toBeInTheDocument();
    });

    it('should render keyframe markers for each keyframe', () => {
      render(
        <KeyframeEditor
          paramDef={mockParamDef}
          keyframes={mockKeyframes}
          currentTime={0}
          duration={3}
          onChange={vi.fn()}
        />
      );

      const markers = screen.getAllByTestId('keyframe-marker');
      expect(markers).toHaveLength(3);
    });

    it('should show empty state when no keyframes', () => {
      render(
        <KeyframeEditor
          paramDef={mockParamDef}
          keyframes={[]}
          currentTime={0}
          onChange={vi.fn()}
        />
      );

      expect(screen.getByText(/no keyframes/i)).toBeInTheDocument();
    });

    it('should show add keyframe button', () => {
      render(
        <KeyframeEditor
          paramDef={mockParamDef}
          keyframes={[]}
          currentTime={0}
          onChange={vi.fn()}
        />
      );

      expect(screen.getByRole('button', { name: /add keyframe/i })).toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Add Keyframe Tests
  // ===========================================================================

  describe('add keyframe', () => {
    it('should call onChange with new keyframe when add button clicked', () => {
      const onChange = vi.fn();
      render(
        <KeyframeEditor
          paramDef={mockParamDef}
          keyframes={[]}
          currentTime={1.5}
          currentValue={0.5}
          onChange={onChange}
        />
      );

      fireEvent.click(screen.getByRole('button', { name: /add keyframe/i }));

      expect(onChange).toHaveBeenCalledWith([
        expect.objectContaining({
          timeOffset: 1.5,
          value: { type: 'float', value: 0.5 },
        }),
      ]);
    });

    it('should insert keyframe in sorted order', () => {
      const onChange = vi.fn();
      const existingKeyframes = [
        createKeyframe(0, 0),
        createKeyframe(2, 1),
      ];

      render(
        <KeyframeEditor
          paramDef={mockParamDef}
          keyframes={existingKeyframes}
          currentTime={1}
          currentValue={0.5}
          onChange={onChange}
        />
      );

      fireEvent.click(screen.getByRole('button', { name: /add keyframe/i }));

      const newKeyframes = onChange.mock.calls[0][0];
      expect(newKeyframes).toHaveLength(3);
      expect(newKeyframes[0].timeOffset).toBe(0);
      expect(newKeyframes[1].timeOffset).toBe(1);
      expect(newKeyframes[2].timeOffset).toBe(2);
    });

    it('should not add duplicate keyframe at same time', () => {
      const onChange = vi.fn();
      const existingKeyframes = [createKeyframe(1, 0.5)];

      render(
        <KeyframeEditor
          paramDef={mockParamDef}
          keyframes={existingKeyframes}
          currentTime={1}
          currentValue={0.5}
          onChange={onChange}
        />
      );

      // Add button should show "update" text when at existing keyframe time
      const updateButton = screen.getByRole('button', { name: /update keyframe/i });
      expect(updateButton).toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Delete Keyframe Tests
  // ===========================================================================

  describe('delete keyframe', () => {
    it('should render delete button for each keyframe', () => {
      render(
        <KeyframeEditor
          paramDef={mockParamDef}
          keyframes={mockKeyframes}
          currentTime={0}
          duration={3}
          onChange={vi.fn()}
        />
      );

      const deleteButtons = screen.getAllByRole('button', { name: /delete/i });
      expect(deleteButtons).toHaveLength(3);
    });

    it('should call onChange without deleted keyframe', () => {
      const onChange = vi.fn();
      render(
        <KeyframeEditor
          paramDef={mockParamDef}
          keyframes={mockKeyframes}
          currentTime={0}
          duration={3}
          onChange={onChange}
        />
      );

      const deleteButtons = screen.getAllByRole('button', { name: /delete/i });
      fireEvent.click(deleteButtons[1]); // Delete middle keyframe

      expect(onChange).toHaveBeenCalledWith([
        mockKeyframes[0],
        mockKeyframes[2],
      ]);
    });
  });

  // ===========================================================================
  // Select Keyframe Tests
  // ===========================================================================

  describe('select keyframe', () => {
    it('should call onSelect when keyframe marker is clicked', () => {
      const onSelect = vi.fn();
      render(
        <KeyframeEditor
          paramDef={mockParamDef}
          keyframes={mockKeyframes}
          currentTime={0}
          duration={3}
          onChange={vi.fn()}
          onSelect={onSelect}
        />
      );

      const markers = screen.getAllByTestId('keyframe-marker');
      fireEvent.click(markers[1]);

      expect(onSelect).toHaveBeenCalledWith(1); // Index of clicked keyframe
    });

    it('should highlight selected keyframe', () => {
      render(
        <KeyframeEditor
          paramDef={mockParamDef}
          keyframes={mockKeyframes}
          currentTime={0}
          duration={3}
          selectedIndex={1}
          onChange={vi.fn()}
        />
      );

      const markers = screen.getAllByTestId('keyframe-marker');
      expect(markers[1]).toHaveClass('ring-2');
    });
  });

  // ===========================================================================
  // Easing Selection Tests
  // ===========================================================================

  describe('easing selection', () => {
    it('should show easing selector for selected keyframe', () => {
      render(
        <KeyframeEditor
          paramDef={mockParamDef}
          keyframes={mockKeyframes}
          currentTime={0}
          duration={3}
          selectedIndex={0}
          onChange={vi.fn()}
        />
      );

      expect(screen.getByLabelText(/easing/i)).toBeInTheDocument();
    });

    it('should update keyframe easing when changed', () => {
      const onChange = vi.fn();
      render(
        <KeyframeEditor
          paramDef={mockParamDef}
          keyframes={mockKeyframes}
          currentTime={0}
          duration={3}
          selectedIndex={0}
          onChange={onChange}
        />
      );

      const select = screen.getByLabelText(/easing/i);
      fireEvent.change(select, { target: { value: 'ease_in' } });

      expect(onChange).toHaveBeenCalledWith([
        expect.objectContaining({ easing: 'ease_in' }),
        mockKeyframes[1],
        mockKeyframes[2],
      ]);
    });
  });

  // ===========================================================================
  // Current Time Indicator Tests
  // ===========================================================================

  describe('current time indicator', () => {
    it('should show current time indicator', () => {
      render(
        <KeyframeEditor
          paramDef={mockParamDef}
          keyframes={mockKeyframes}
          currentTime={1.5}
          duration={3}
          onChange={vi.fn()}
        />
      );

      expect(screen.getByTestId('time-indicator')).toBeInTheDocument();
    });

    it('should position time indicator based on current time', () => {
      render(
        <KeyframeEditor
          paramDef={mockParamDef}
          keyframes={mockKeyframes}
          currentTime={1.5}
          duration={3}
          onChange={vi.fn()}
        />
      );

      const indicator = screen.getByTestId('time-indicator');
      // At time 1.5 of 3s duration = 50%
      expect(indicator).toHaveStyle({ left: '50%' });
    });
  });

  // ===========================================================================
  // Read-Only Mode Tests
  // ===========================================================================

  describe('read-only mode', () => {
    it('should hide add button when readOnly', () => {
      render(
        <KeyframeEditor
          paramDef={mockParamDef}
          keyframes={[]}
          currentTime={0}
          onChange={vi.fn()}
          readOnly
        />
      );

      expect(screen.queryByRole('button', { name: /add keyframe/i })).not.toBeInTheDocument();
    });

    it('should hide delete buttons when readOnly', () => {
      render(
        <KeyframeEditor
          paramDef={mockParamDef}
          keyframes={mockKeyframes}
          currentTime={0}
          duration={3}
          onChange={vi.fn()}
          readOnly
        />
      );

      expect(screen.queryAllByRole('button', { name: /delete/i })).toHaveLength(0);
    });

    it('should disable easing selector when readOnly', () => {
      render(
        <KeyframeEditor
          paramDef={mockParamDef}
          keyframes={mockKeyframes}
          currentTime={0}
          duration={3}
          selectedIndex={0}
          onChange={vi.fn()}
          readOnly
        />
      );

      const select = screen.getByLabelText(/easing/i);
      expect(select).toBeDisabled();
    });
  });

  // ===========================================================================
  // Styling Tests
  // ===========================================================================

  describe('styling', () => {
    it('should apply custom className', () => {
      render(
        <KeyframeEditor
          paramDef={mockParamDef}
          keyframes={[]}
          currentTime={0}
          onChange={vi.fn()}
          className="custom-class"
        />
      );

      expect(screen.getByTestId('keyframe-editor')).toHaveClass('custom-class');
    });
  });
});
