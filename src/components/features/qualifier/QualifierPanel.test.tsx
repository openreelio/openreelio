/**
 * QualifierPanel Component Tests
 *
 * TDD tests for HSL-based selective color correction panel.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QualifierPanel } from './QualifierPanel';
import { DEFAULT_QUALIFIER_VALUES, QUALIFIER_PRESETS } from '@/types/qualifier';
import type { QualifierValues } from '@/types/qualifier';

describe('QualifierPanel', () => {
  // ==========================================================================
  // Rendering Tests
  // ==========================================================================

  describe('rendering', () => {
    it('renders panel with header', () => {
      const onChange = vi.fn();
      render(
        <QualifierPanel values={DEFAULT_QUALIFIER_VALUES} onChange={onChange} />
      );

      expect(screen.getByText('HSL Qualifier')).toBeInTheDocument();
    });

    it('renders hue controls', () => {
      const onChange = vi.fn();
      render(
        <QualifierPanel values={DEFAULT_QUALIFIER_VALUES} onChange={onChange} />
      );

      expect(screen.getByLabelText(/Hue Center/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/Hue Width/i)).toBeInTheDocument();
    });

    it('renders saturation controls', () => {
      const onChange = vi.fn();
      render(
        <QualifierPanel values={DEFAULT_QUALIFIER_VALUES} onChange={onChange} />
      );

      expect(screen.getByLabelText(/Sat Min/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/Sat Max/i)).toBeInTheDocument();
    });

    it('renders luminance controls', () => {
      const onChange = vi.fn();
      render(
        <QualifierPanel values={DEFAULT_QUALIFIER_VALUES} onChange={onChange} />
      );

      expect(screen.getByLabelText(/Lum Min/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/Lum Max/i)).toBeInTheDocument();
    });

    it('renders adjustment controls', () => {
      const onChange = vi.fn();
      render(
        <QualifierPanel values={DEFAULT_QUALIFIER_VALUES} onChange={onChange} />
      );

      expect(screen.getByLabelText(/Hue Shift/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/Saturation Adjust/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/Luminance Adjust/i)).toBeInTheDocument();
    });

    it('renders softness and invert controls', () => {
      const onChange = vi.fn();
      render(
        <QualifierPanel values={DEFAULT_QUALIFIER_VALUES} onChange={onChange} />
      );

      expect(screen.getByLabelText(/Softness/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/Invert Selection/i)).toBeInTheDocument();
    });

    it('renders preset buttons', () => {
      const onChange = vi.fn();
      render(
        <QualifierPanel values={DEFAULT_QUALIFIER_VALUES} onChange={onChange} />
      );

      expect(screen.getByRole('button', { name: /Skin Tones/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Sky Blue/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Foliage/i })).toBeInTheDocument();
    });

    it('renders reset button', () => {
      const onChange = vi.fn();
      render(
        <QualifierPanel values={DEFAULT_QUALIFIER_VALUES} onChange={onChange} />
      );

      expect(screen.getByRole('button', { name: /Reset/i })).toBeInTheDocument();
    });
  });

  // ==========================================================================
  // Value Display Tests
  // ==========================================================================

  describe('value display', () => {
    it('displays current hue center value', () => {
      const onChange = vi.fn();
      const values: QualifierValues = {
        ...DEFAULT_QUALIFIER_VALUES,
        hue_center: 200,
      };

      render(<QualifierPanel values={values} onChange={onChange} />);

      const input = screen.getByLabelText(/Hue Center/i);
      expect(input).toHaveValue('200');
    });

    it('displays current saturation range', () => {
      const onChange = vi.fn();
      const values: QualifierValues = {
        ...DEFAULT_QUALIFIER_VALUES,
        sat_min: 0.3,
        sat_max: 0.8,
      };

      render(<QualifierPanel values={values} onChange={onChange} />);

      expect(screen.getByLabelText(/Sat Min/i)).toHaveValue('0.3');
      expect(screen.getByLabelText(/Sat Max/i)).toHaveValue('0.8');
    });

    it('displays invert checkbox state', () => {
      const onChange = vi.fn();
      const values: QualifierValues = {
        ...DEFAULT_QUALIFIER_VALUES,
        invert: true,
      };

      render(<QualifierPanel values={values} onChange={onChange} />);

      const checkbox = screen.getByLabelText(/Invert Selection/i);
      expect(checkbox).toBeChecked();
    });
  });

  // ==========================================================================
  // Interaction Tests
  // ==========================================================================

  describe('interactions', () => {
    it('calls onChange when hue center slider changes', async () => {
      const onChange = vi.fn();

      render(
        <QualifierPanel values={DEFAULT_QUALIFIER_VALUES} onChange={onChange} />
      );

      const slider = screen.getByLabelText(/Hue Center/i);
      fireEvent.change(slider, { target: { value: '180' } });

      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({ hue_center: 180 })
      );
    });

    it('calls onChange when invert is toggled', async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();

      render(
        <QualifierPanel values={DEFAULT_QUALIFIER_VALUES} onChange={onChange} />
      );

      const checkbox = screen.getByLabelText(/Invert Selection/i);
      await user.click(checkbox);

      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({ invert: true })
      );
    });

    it('applies skin tones preset when clicked', async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();

      render(
        <QualifierPanel values={DEFAULT_QUALIFIER_VALUES} onChange={onChange} />
      );

      const presetBtn = screen.getByRole('button', { name: /Skin Tones/i });
      await user.click(presetBtn);

      expect(onChange).toHaveBeenCalledWith(QUALIFIER_PRESETS.skin_tones);
    });

    it('applies sky blue preset when clicked', async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();

      render(
        <QualifierPanel values={DEFAULT_QUALIFIER_VALUES} onChange={onChange} />
      );

      const presetBtn = screen.getByRole('button', { name: /Sky Blue/i });
      await user.click(presetBtn);

      expect(onChange).toHaveBeenCalledWith(QUALIFIER_PRESETS.sky_blue);
    });

    it('applies foliage preset when clicked', async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();

      render(
        <QualifierPanel values={DEFAULT_QUALIFIER_VALUES} onChange={onChange} />
      );

      const presetBtn = screen.getByRole('button', { name: /Foliage/i });
      await user.click(presetBtn);

      expect(onChange).toHaveBeenCalledWith(QUALIFIER_PRESETS.foliage);
    });

    it('resets to defaults when reset button clicked', async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      const modifiedValues: QualifierValues = {
        ...DEFAULT_QUALIFIER_VALUES,
        hue_center: 200,
        sat_adjust: 0.5,
      };

      render(<QualifierPanel values={modifiedValues} onChange={onChange} />);

      const resetBtn = screen.getByRole('button', { name: /Reset/i });
      await user.click(resetBtn);

      expect(onChange).toHaveBeenCalledWith(DEFAULT_QUALIFIER_VALUES);
    });
  });

  // ==========================================================================
  // Collapse Tests
  // ==========================================================================

  describe('collapsible', () => {
    it('hides content when collapsed', () => {
      const onChange = vi.fn();

      render(
        <QualifierPanel
          values={DEFAULT_QUALIFIER_VALUES}
          onChange={onChange}
          collapsed={true}
        />
      );

      expect(screen.queryByLabelText(/Hue Center/i)).not.toBeInTheDocument();
    });

    it('shows content when expanded', () => {
      const onChange = vi.fn();

      render(
        <QualifierPanel
          values={DEFAULT_QUALIFIER_VALUES}
          onChange={onChange}
          collapsed={false}
        />
      );

      expect(screen.getByLabelText(/Hue Center/i)).toBeInTheDocument();
    });

    it('calls onCollapsedChange when header clicked', async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      const onCollapsedChange = vi.fn();

      render(
        <QualifierPanel
          values={DEFAULT_QUALIFIER_VALUES}
          onChange={onChange}
          collapsed={false}
          onCollapsedChange={onCollapsedChange}
        />
      );

      const header = screen.getByRole('button', { name: /HSL Qualifier/i });
      await user.click(header);

      expect(onCollapsedChange).toHaveBeenCalledWith(true);
    });
  });

  // ==========================================================================
  // Disabled State Tests
  // ==========================================================================

  describe('disabled state', () => {
    it('disables all inputs when disabled prop is true', () => {
      const onChange = vi.fn();

      render(
        <QualifierPanel
          values={DEFAULT_QUALIFIER_VALUES}
          onChange={onChange}
          disabled={true}
        />
      );

      const hueInput = screen.getByLabelText(/Hue Center/i);
      const checkbox = screen.getByLabelText(/Invert Selection/i);
      const resetBtn = screen.getByRole('button', { name: /Reset/i });

      expect(hueInput).toBeDisabled();
      expect(checkbox).toBeDisabled();
      expect(resetBtn).toBeDisabled();
    });

    it('applies opacity styling when disabled', () => {
      const onChange = vi.fn();

      render(
        <QualifierPanel
          values={DEFAULT_QUALIFIER_VALUES}
          onChange={onChange}
          disabled={true}
        />
      );

      const panel = screen.getByTestId('qualifier-panel');
      expect(panel).toHaveClass('opacity-50');
    });
  });

  // ==========================================================================
  // Preview Toggle Tests
  // ==========================================================================

  describe('preview toggle', () => {
    it('renders preview toggle when showPreviewToggle is true', () => {
      const onChange = vi.fn();

      render(
        <QualifierPanel
          values={DEFAULT_QUALIFIER_VALUES}
          onChange={onChange}
          showPreviewToggle={true}
        />
      );

      expect(screen.getByLabelText(/Show Mask/i)).toBeInTheDocument();
    });

    it('calls onPreviewChange when preview toggled', async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      const onPreviewChange = vi.fn();

      render(
        <QualifierPanel
          values={DEFAULT_QUALIFIER_VALUES}
          onChange={onChange}
          showPreviewToggle={true}
          previewEnabled={false}
          onPreviewChange={onPreviewChange}
        />
      );

      const toggle = screen.getByLabelText(/Show Mask/i);
      await user.click(toggle);

      expect(onPreviewChange).toHaveBeenCalledWith(true);
    });
  });

  // ==========================================================================
  // Validation Tests
  // ==========================================================================

  describe('validation', () => {
    it('clamps hue center to valid range via slider', () => {
      const onChange = vi.fn();

      render(
        <QualifierPanel values={DEFAULT_QUALIFIER_VALUES} onChange={onChange} />
      );

      // Slider will automatically clamp to max value (360)
      const slider = screen.getByLabelText(/Hue Center/i);
      fireEvent.change(slider, { target: { value: '360' } });

      expect(onChange).toHaveBeenCalled();
      const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1][0];
      expect(lastCall.hue_center).toBeLessThanOrEqual(360);
    });

    it('clamps saturation to valid range via slider', () => {
      const onChange = vi.fn();

      render(
        <QualifierPanel values={DEFAULT_QUALIFIER_VALUES} onChange={onChange} />
      );

      // Slider will automatically clamp to max value (1.0)
      const slider = screen.getByLabelText(/Sat Max/i);
      fireEvent.change(slider, { target: { value: '1.0' } });

      expect(onChange).toHaveBeenCalled();
      const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1][0];
      expect(lastCall.sat_max).toBeLessThanOrEqual(1.0);
    });
  });
});
