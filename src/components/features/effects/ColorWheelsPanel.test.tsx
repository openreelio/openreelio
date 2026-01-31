/**
 * ColorWheelsPanel Component Tests
 *
 * TDD: Tests for the 3-way color corrector (Lift/Gamma/Gain) panel.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ColorWheelsPanel } from './ColorWheelsPanel';
import type { ColorWheelsValues } from './ColorWheelsPanel';

// =============================================================================
// Test Data
// =============================================================================

const defaultValues: ColorWheelsValues = {
  lift_r: 0,
  lift_g: 0,
  lift_b: 0,
  gamma_r: 0,
  gamma_g: 0,
  gamma_b: 0,
  gain_r: 0,
  gain_g: 0,
  gain_b: 0,
};

// =============================================================================
// Tests
// =============================================================================

describe('ColorWheelsPanel', () => {
  const defaultProps = {
    values: defaultValues,
    onChange: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ===========================================================================
  // Rendering Tests
  // ===========================================================================

  describe('rendering', () => {
    it('should render the panel with title', () => {
      render(<ColorWheelsPanel {...defaultProps} />);

      expect(screen.getByTestId('color-wheels-panel')).toBeInTheDocument();
      expect(screen.getByText('Color Wheels')).toBeInTheDocument();
    });

    it('should render three color wheel sections', () => {
      render(<ColorWheelsPanel {...defaultProps} />);

      expect(screen.getByText('Lift')).toBeInTheDocument();
      expect(screen.getByText('Gamma')).toBeInTheDocument();
      expect(screen.getByText('Gain')).toBeInTheDocument();
    });

    it('should render RGB sliders for each section', () => {
      render(<ColorWheelsPanel {...defaultProps} />);

      // Each section should have R, G, B sliders (3 sections x 3 sliders = 9 total)
      const redSliders = screen.getAllByLabelText(/red/i);
      const greenSliders = screen.getAllByLabelText(/green/i);
      const blueSliders = screen.getAllByLabelText(/blue/i);

      expect(redSliders).toHaveLength(3);
      expect(greenSliders).toHaveLength(3);
      expect(blueSliders).toHaveLength(3);
    });

    it('should display current values on sliders', () => {
      const values: ColorWheelsValues = {
        ...defaultValues,
        lift_r: 0.5,
        gamma_g: -0.3,
        gain_b: 0.8,
      };

      render(<ColorWheelsPanel values={values} onChange={vi.fn()} />);

      // Check that slider values are displayed
      const liftRedSlider = screen.getByTestId('slider-lift_r');
      expect(liftRedSlider).toHaveValue('0.5');

      const gammaGreenSlider = screen.getByTestId('slider-gamma_g');
      expect(gammaGreenSlider).toHaveValue('-0.3');

      const gainBlueSlider = screen.getByTestId('slider-gain_b');
      expect(gainBlueSlider).toHaveValue('0.8');
    });
  });

  // ===========================================================================
  // Interaction Tests
  // ===========================================================================

  describe('interactions', () => {
    it('should call onChange when lift slider changes', () => {
      const onChange = vi.fn();
      render(<ColorWheelsPanel values={defaultValues} onChange={onChange} />);

      const liftRedSlider = screen.getByTestId('slider-lift_r');
      fireEvent.change(liftRedSlider, { target: { value: '0.5' } });

      expect(onChange).toHaveBeenCalledWith('lift_r', 0.5);
    });

    it('should call onChange when gamma slider changes', () => {
      const onChange = vi.fn();
      render(<ColorWheelsPanel values={defaultValues} onChange={onChange} />);

      const gammaGreenSlider = screen.getByTestId('slider-gamma_g');
      fireEvent.change(gammaGreenSlider, { target: { value: '-0.25' } });

      expect(onChange).toHaveBeenCalledWith('gamma_g', -0.25);
    });

    it('should call onChange when gain slider changes', () => {
      const onChange = vi.fn();
      render(<ColorWheelsPanel values={defaultValues} onChange={onChange} />);

      const gainBlueSlider = screen.getByTestId('slider-gain_b');
      fireEvent.change(gainBlueSlider, { target: { value: '0.75' } });

      expect(onChange).toHaveBeenCalledWith('gain_b', 0.75);
    });

    it('should call onReset when reset button is clicked', () => {
      const onReset = vi.fn();
      render(<ColorWheelsPanel values={defaultValues} onChange={vi.fn()} onReset={onReset} />);

      const resetButton = screen.getByRole('button', { name: /reset/i });
      fireEvent.click(resetButton);

      expect(onReset).toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Constraint Tests
  // ===========================================================================

  describe('value constraints', () => {
    it('should clamp slider values to -1.0 to 1.0 range', () => {
      const onChange = vi.fn();
      render(<ColorWheelsPanel values={defaultValues} onChange={onChange} />);

      const slider = screen.getByTestId('slider-lift_r');

      // Slider should have min/max attributes
      expect(slider).toHaveAttribute('min', '-1');
      expect(slider).toHaveAttribute('max', '1');
    });

    it('should use step of 0.01 for fine control', () => {
      render(<ColorWheelsPanel {...defaultProps} />);

      const slider = screen.getByTestId('slider-lift_r');
      expect(slider).toHaveAttribute('step', '0.01');
    });
  });

  // ===========================================================================
  // Read-only Mode Tests
  // ===========================================================================

  describe('read-only mode', () => {
    it('should disable sliders when readOnly is true', () => {
      render(<ColorWheelsPanel {...defaultProps} readOnly={true} />);

      const sliders = screen.getAllByRole('slider');
      sliders.forEach((slider) => {
        expect(slider).toBeDisabled();
      });
    });

    it('should hide reset button when readOnly is true', () => {
      render(<ColorWheelsPanel {...defaultProps} readOnly={true} onReset={vi.fn()} />);

      expect(screen.queryByRole('button', { name: /reset/i })).not.toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Visual Feedback Tests
  // ===========================================================================

  describe('visual feedback', () => {
    it('should show color preview for each section', () => {
      const values: ColorWheelsValues = {
        lift_r: 0.5,
        lift_g: 0,
        lift_b: -0.3,
        gamma_r: 0,
        gamma_g: 0.4,
        gamma_b: 0,
        gain_r: 0,
        gain_g: 0,
        gain_b: 0.6,
      };

      render(<ColorWheelsPanel values={values} onChange={vi.fn()} />);

      // Color preview elements should exist
      expect(screen.getByTestId('color-preview-lift')).toBeInTheDocument();
      expect(screen.getByTestId('color-preview-gamma')).toBeInTheDocument();
      expect(screen.getByTestId('color-preview-gain')).toBeInTheDocument();
    });

    it('should show value display next to sliders', () => {
      const values: ColorWheelsValues = {
        ...defaultValues,
        lift_r: 0.35,
      };

      render(<ColorWheelsPanel values={values} onChange={vi.fn()} />);

      // Should display the numeric value
      expect(screen.getByTestId('value-lift_r')).toHaveTextContent('0.35');
    });
  });

  // ===========================================================================
  // Section Labels Tests
  // ===========================================================================

  describe('section labels', () => {
    it('should show Lift section with shadows description', () => {
      render(<ColorWheelsPanel {...defaultProps} />);

      expect(screen.getByText('Lift')).toBeInTheDocument();
      expect(screen.getByText(/shadows/i)).toBeInTheDocument();
    });

    it('should show Gamma section with midtones description', () => {
      render(<ColorWheelsPanel {...defaultProps} />);

      expect(screen.getByText('Gamma')).toBeInTheDocument();
      expect(screen.getByText(/midtones/i)).toBeInTheDocument();
    });

    it('should show Gain section with highlights description', () => {
      render(<ColorWheelsPanel {...defaultProps} />);

      expect(screen.getByText('Gain')).toBeInTheDocument();
      expect(screen.getByText(/highlights/i)).toBeInTheDocument();
    });
  });
});
