/**
 * NoiseReductionControl Tests
 *
 * Tests for the noise reduction control component.
 * Following TDD methodology.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NoiseReductionControl } from './NoiseReductionControl';
import type { NoiseReductionSettings } from '@/utils/noiseReduction';

describe('NoiseReductionControl', () => {
  const defaultSettings: NoiseReductionSettings = {
    algorithm: 'anlmdn',
    strength: 0.5,
    enabled: true,
  };

  const defaultProps = {
    settings: defaultSettings,
    onChange: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('rendering', () => {
    it('should render noise reduction header', () => {
      render(<NoiseReductionControl {...defaultProps} />);

      expect(screen.getByText(/noise reduction/i)).toBeInTheDocument();
    });

    it('should render enable/disable toggle', () => {
      render(<NoiseReductionControl {...defaultProps} />);

      const toggle = screen.getByRole('switch');
      expect(toggle).toBeInTheDocument();
    });

    it('should render algorithm selector', () => {
      render(<NoiseReductionControl {...defaultProps} />);

      expect(screen.getByTestId('algorithm-selector')).toBeInTheDocument();
    });

    it('should render strength slider', () => {
      render(<NoiseReductionControl {...defaultProps} />);

      const slider = screen.getByRole('slider', { name: /strength/i });
      expect(slider).toBeInTheDocument();
    });

    it('should render preset buttons', () => {
      render(<NoiseReductionControl {...defaultProps} />);

      expect(screen.getByRole('button', { name: /light/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /medium/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /heavy/i })).toBeInTheDocument();
    });

    it('should show current strength percentage', () => {
      render(
        <NoiseReductionControl
          {...defaultProps}
          settings={{ ...defaultSettings, strength: 0.75 }}
        />
      );

      expect(screen.getByText('75%')).toBeInTheDocument();
    });
  });

  describe('enable/disable toggle', () => {
    it('should call onChange when toggled on', async () => {
      const onChange = vi.fn();
      render(
        <NoiseReductionControl
          {...defaultProps}
          settings={{ ...defaultSettings, enabled: false }}
          onChange={onChange}
        />
      );

      const toggle = screen.getByRole('switch');
      await userEvent.click(toggle);

      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({ enabled: true })
      );
    });

    it('should call onChange when toggled off', async () => {
      const onChange = vi.fn();
      render(<NoiseReductionControl {...defaultProps} onChange={onChange} />);

      const toggle = screen.getByRole('switch');
      await userEvent.click(toggle);

      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({ enabled: false })
      );
    });

    it('should disable controls when noise reduction is disabled', () => {
      render(
        <NoiseReductionControl
          {...defaultProps}
          settings={{ ...defaultSettings, enabled: false }}
        />
      );

      const slider = screen.getByRole('slider', { name: /strength/i });
      expect(slider).toBeDisabled();
    });
  });

  describe('algorithm selection', () => {
    it('should show current algorithm label', () => {
      render(<NoiseReductionControl {...defaultProps} />);

      // anlmdn is the default - check the selector button specifically
      const selector = screen.getByTestId('algorithm-selector');
      expect(selector).toHaveTextContent(/non-local means/i);
    });

    it('should open algorithm dropdown when clicked', async () => {
      render(<NoiseReductionControl {...defaultProps} />);

      const selector = screen.getByTestId('algorithm-selector');
      await userEvent.click(selector);

      expect(screen.getByRole('listbox')).toBeInTheDocument();
    });

    it('should call onChange when algorithm is changed', async () => {
      const onChange = vi.fn();
      render(<NoiseReductionControl {...defaultProps} onChange={onChange} />);

      const selector = screen.getByTestId('algorithm-selector');
      await userEvent.click(selector);

      const fftOption = screen.getByRole('option', { name: /fft denoise/i });
      await userEvent.click(fftOption);

      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({ algorithm: 'afftdn' })
      );
    });
  });

  describe('strength slider', () => {
    it('should call onChange when strength changes', () => {
      const onChange = vi.fn();
      render(<NoiseReductionControl {...defaultProps} onChange={onChange} />);

      const slider = screen.getByRole('slider', { name: /strength/i });
      fireEvent.change(slider, { target: { value: '0.8' } });

      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({ strength: 0.8 })
      );
    });

    it('should display current value', () => {
      render(
        <NoiseReductionControl
          {...defaultProps}
          settings={{ ...defaultSettings, strength: 0.6 }}
        />
      );

      expect(screen.getByText('60%')).toBeInTheDocument();
    });
  });

  describe('preset buttons', () => {
    it('should apply light preset when clicked', async () => {
      const onChange = vi.fn();
      render(<NoiseReductionControl {...defaultProps} onChange={onChange} />);

      const lightButton = screen.getByRole('button', { name: /light/i });
      await userEvent.click(lightButton);

      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({ strength: 0.3, algorithm: 'anlmdn' })
      );
    });

    it('should apply medium preset when clicked', async () => {
      const onChange = vi.fn();
      render(<NoiseReductionControl {...defaultProps} onChange={onChange} />);

      const mediumButton = screen.getByRole('button', { name: /medium/i });
      await userEvent.click(mediumButton);

      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({ strength: 0.5, algorithm: 'anlmdn' })
      );
    });

    it('should apply heavy preset when clicked', async () => {
      const onChange = vi.fn();
      render(<NoiseReductionControl {...defaultProps} onChange={onChange} />);

      const heavyButton = screen.getByRole('button', { name: /heavy/i });
      await userEvent.click(heavyButton);

      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({ strength: 0.8, algorithm: 'afftdn' })
      );
    });

    it('should highlight the active preset', () => {
      render(
        <NoiseReductionControl
          {...defaultProps}
          settings={{ ...defaultSettings, strength: 0.5, algorithm: 'anlmdn' }}
        />
      );

      const mediumButton = screen.getByRole('button', { name: /medium/i });
      expect(mediumButton).toHaveClass('ring-2');
    });
  });

  describe('disabled state', () => {
    it('should disable all controls when disabled prop is true', () => {
      render(<NoiseReductionControl {...defaultProps} disabled />);

      const toggle = screen.getByRole('switch');
      const slider = screen.getByRole('slider', { name: /strength/i });
      const presetButtons = screen.getAllByRole('button');

      expect(toggle).toBeDisabled();
      expect(slider).toBeDisabled();
      presetButtons.forEach((button) => {
        expect(button).toBeDisabled();
      });
    });

    it('should show disabled styling', () => {
      render(<NoiseReductionControl {...defaultProps} disabled />);

      const container = screen.getByTestId('noise-reduction-control');
      expect(container).toHaveClass('opacity-50');
    });
  });

  describe('accessibility', () => {
    it('should have proper ARIA labels', () => {
      render(<NoiseReductionControl {...defaultProps} />);

      expect(
        screen.getByRole('slider', { name: /strength/i })
      ).toBeInTheDocument();
      expect(
        screen.getByRole('switch', { name: /enable/i })
      ).toBeInTheDocument();
    });

    it('should associate labels with controls', () => {
      render(<NoiseReductionControl {...defaultProps} />);

      const slider = screen.getByRole('slider', { name: /strength/i });
      expect(slider).toHaveAttribute('id');
    });
  });
});
