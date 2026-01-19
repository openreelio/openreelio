/**
 * ParameterEditor Component Tests
 *
 * Tests for the effect parameter editor component.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ParameterEditor } from './ParameterEditor';
import type { ParamDef } from '@/types';

// =============================================================================
// Test Data
// =============================================================================

const floatParam: ParamDef = {
  name: 'brightness',
  label: 'Brightness',
  default: { type: 'float', value: 0 },
  min: -1,
  max: 1,
  step: 0.1,
};

const boolParam: ParamDef = {
  name: 'enabled',
  label: 'Enabled',
  default: { type: 'bool', value: true },
};

const intParam: ParamDef = {
  name: 'radius',
  label: 'Radius',
  default: { type: 'int', value: 5 },
  min: 0,
  max: 100,
  step: 1,
};

// =============================================================================
// Tests
// =============================================================================

describe('ParameterEditor', () => {
  // ===========================================================================
  // Float Parameter Tests
  // ===========================================================================

  describe('float parameter', () => {
    it('should render slider for float parameter', () => {
      render(
        <ParameterEditor
          paramDef={floatParam}
          value={0.5}
          onChange={vi.fn()}
        />
      );

      expect(screen.getByText('Brightness')).toBeInTheDocument();
      expect(screen.getByRole('slider')).toBeInTheDocument();
    });

    it('should show current value', () => {
      render(
        <ParameterEditor
          paramDef={floatParam}
          value={0.5}
          onChange={vi.fn()}
        />
      );

      // Both slider and input have the same value, use spinbutton to be specific
      expect(screen.getByRole('spinbutton')).toHaveValue(0.5);
    });

    it('should call onChange when slider is moved', () => {
      const onChange = vi.fn();
      render(
        <ParameterEditor
          paramDef={floatParam}
          value={0}
          onChange={onChange}
        />
      );

      const slider = screen.getByRole('slider');
      fireEvent.change(slider, { target: { value: '0.5' } });

      expect(onChange).toHaveBeenCalledWith('brightness', 0.5);
    });

    it('should call onChange when input value changes', () => {
      const onChange = vi.fn();
      render(
        <ParameterEditor
          paramDef={floatParam}
          value={0}
          onChange={onChange}
        />
      );

      const input = screen.getByRole('spinbutton');
      fireEvent.change(input, { target: { value: '0.75' } });

      expect(onChange).toHaveBeenCalledWith('brightness', 0.75);
    });

    it('should clamp value to min/max range', () => {
      const onChange = vi.fn();
      render(
        <ParameterEditor
          paramDef={floatParam}
          value={0}
          onChange={onChange}
        />
      );

      const input = screen.getByRole('spinbutton');
      fireEvent.change(input, { target: { value: '5' } }); // Over max

      expect(onChange).toHaveBeenCalledWith('brightness', 1); // Clamped to max
    });
  });

  // ===========================================================================
  // Boolean Parameter Tests
  // ===========================================================================

  describe('boolean parameter', () => {
    it('should render toggle for boolean parameter', () => {
      render(
        <ParameterEditor
          paramDef={boolParam}
          value={true}
          onChange={vi.fn()}
        />
      );

      expect(screen.getByText('Enabled')).toBeInTheDocument();
      expect(screen.getByRole('checkbox')).toBeInTheDocument();
    });

    it('should show checked state', () => {
      render(
        <ParameterEditor
          paramDef={boolParam}
          value={true}
          onChange={vi.fn()}
        />
      );

      expect(screen.getByRole('checkbox')).toBeChecked();
    });

    it('should call onChange when toggle is clicked', () => {
      const onChange = vi.fn();
      render(
        <ParameterEditor
          paramDef={boolParam}
          value={true}
          onChange={onChange}
        />
      );

      fireEvent.click(screen.getByRole('checkbox'));

      expect(onChange).toHaveBeenCalledWith('enabled', false);
    });
  });

  // ===========================================================================
  // Integer Parameter Tests
  // ===========================================================================

  describe('integer parameter', () => {
    it('should render slider for integer parameter', () => {
      render(
        <ParameterEditor
          paramDef={intParam}
          value={10}
          onChange={vi.fn()}
        />
      );

      expect(screen.getByText('Radius')).toBeInTheDocument();
      expect(screen.getByRole('slider')).toBeInTheDocument();
    });

    it('should round to integer on change', () => {
      const onChange = vi.fn();
      render(
        <ParameterEditor
          paramDef={intParam}
          value={10}
          onChange={onChange}
        />
      );

      const input = screen.getByRole('spinbutton');
      fireEvent.change(input, { target: { value: '15.7' } });

      expect(onChange).toHaveBeenCalledWith('radius', 16); // Rounded
    });
  });

  // ===========================================================================
  // Read-only Tests
  // ===========================================================================

  describe('read-only mode', () => {
    it('should disable controls when readOnly is true', () => {
      render(
        <ParameterEditor
          paramDef={floatParam}
          value={0.5}
          onChange={vi.fn()}
          readOnly
        />
      );

      expect(screen.getByRole('slider')).toBeDisabled();
      expect(screen.getByRole('spinbutton')).toBeDisabled();
    });
  });

  // ===========================================================================
  // Reset Tests
  // ===========================================================================

  describe('reset to default', () => {
    it('should show reset button when value differs from default', () => {
      render(
        <ParameterEditor
          paramDef={floatParam}
          value={0.5} // Different from default (0)
          onChange={vi.fn()}
        />
      );

      expect(screen.getByTestId('reset-button')).toBeInTheDocument();
    });

    it('should not show reset button when value equals default', () => {
      render(
        <ParameterEditor
          paramDef={floatParam}
          value={0} // Same as default
          onChange={vi.fn()}
        />
      );

      expect(screen.queryByTestId('reset-button')).not.toBeInTheDocument();
    });

    it('should call onChange with default value when reset is clicked', () => {
      const onChange = vi.fn();
      render(
        <ParameterEditor
          paramDef={floatParam}
          value={0.5}
          onChange={onChange}
        />
      );

      fireEvent.click(screen.getByTestId('reset-button'));

      expect(onChange).toHaveBeenCalledWith('brightness', 0);
    });
  });
});
