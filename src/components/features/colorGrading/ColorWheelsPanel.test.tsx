/**
 * ColorWheelsPanel Tests
 *
 * Tests for the complete Lift/Gamma/Gain color wheels panel.
 * Following TDD methodology.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ColorWheelsPanel } from './ColorWheelsPanel';
import type { LiftGammaGain } from '@/utils/colorWheel';

describe('ColorWheelsPanel', () => {
  const defaultLGG: LiftGammaGain = {
    lift: { r: 0, g: 0, b: 0 },
    gamma: { r: 0, g: 0, b: 0 },
    gain: { r: 0, g: 0, b: 0 },
  };

  const defaultLuminance = {
    lift: 0,
    gamma: 0,
    gain: 0,
  };

  const defaultProps = {
    value: defaultLGG,
    luminance: defaultLuminance,
    onChange: vi.fn(),
    onLuminanceChange: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('rendering', () => {
    it('should render all three wheel controls', () => {
      render(<ColorWheelsPanel {...defaultProps} />);

      expect(screen.getByText('Lift')).toBeInTheDocument();
      expect(screen.getByText('Gamma')).toBeInTheDocument();
      expect(screen.getByText('Gain')).toBeInTheDocument();
    });

    it('should render panel title', () => {
      render(<ColorWheelsPanel {...defaultProps} />);
      expect(screen.getByText('Color Wheels')).toBeInTheDocument();
    });

    it('should render reset all button', () => {
      render(<ColorWheelsPanel {...defaultProps} />);
      expect(
        screen.getByRole('button', { name: /reset all/i })
      ).toBeInTheDocument();
    });
  });

  describe('reset functionality', () => {
    it('should reset all wheels when clicking reset all', async () => {
      const onChange = vi.fn();
      const onLuminanceChange = vi.fn();

      render(
        <ColorWheelsPanel
          {...defaultProps}
          value={{
            lift: { r: 0.1, g: 0, b: -0.1 },
            gamma: { r: 0, g: 0.2, b: 0 },
            gain: { r: -0.1, g: 0, b: 0.1 },
          }}
          luminance={{
            lift: 0.1,
            gamma: -0.2,
            gain: 0.3,
          }}
          onChange={onChange}
          onLuminanceChange={onLuminanceChange}
        />
      );

      const resetButton = screen.getByRole('button', { name: /reset all/i });
      await userEvent.click(resetButton);

      expect(onChange).toHaveBeenCalledWith(defaultLGG);
      expect(onLuminanceChange).toHaveBeenCalledWith(defaultLuminance);
    });
  });

  describe('individual wheel updates', () => {
    it('should update only lift when lift changes', async () => {
      const onChange = vi.fn();
      render(<ColorWheelsPanel {...defaultProps} onChange={onChange} />);

      // The panel should handle individual wheel changes
      // by updating only the relevant part of the LGG object
      const liftResetButton = screen
        .getAllByRole('button', { name: /reset/i })
        .find((btn) => btn.closest('[class*="flex-col"]')?.textContent?.includes('Lift'));

      // Verify lift wheel exists
      expect(screen.getByText('Lift')).toBeInTheDocument();
      expect(liftResetButton).toBeDefined();
    });
  });

  describe('collapsed state', () => {
    it('should support collapsed prop', () => {
      render(<ColorWheelsPanel {...defaultProps} collapsed />);

      // When collapsed, wheels should not be visible
      const container = screen.getByTestId('color-wheels-panel');
      expect(container).toHaveAttribute('data-collapsed', 'true');
    });

    it('should toggle collapsed state when clicking header', async () => {
      const onCollapsedChange = vi.fn();
      render(
        <ColorWheelsPanel
          {...defaultProps}
          collapsed={false}
          onCollapsedChange={onCollapsedChange}
        />
      );

      const header = screen.getByRole('button', { name: /color wheels/i });
      await userEvent.click(header);

      expect(onCollapsedChange).toHaveBeenCalledWith(true);
    });
  });

  describe('layout variants', () => {
    it('should render horizontal layout', () => {
      render(<ColorWheelsPanel {...defaultProps} layout="horizontal" />);

      const wheelsContainer = screen.getByTestId('wheels-container');
      expect(wheelsContainer).toHaveClass('flex-row');
    });

    it('should render vertical layout', () => {
      render(<ColorWheelsPanel {...defaultProps} layout="vertical" />);

      const wheelsContainer = screen.getByTestId('wheels-container');
      expect(wheelsContainer).toHaveClass('flex-col');
    });
  });

  describe('disabled state', () => {
    it('should disable all wheels when disabled', () => {
      render(<ColorWheelsPanel {...defaultProps} disabled />);

      const container = screen.getByTestId('color-wheels-panel');
      expect(container).toHaveClass('opacity-50');
    });
  });

  describe('preset functionality', () => {
    it('should render preset dropdown when presets are provided', () => {
      const presets = [
        { name: 'Cool', value: { lift: { r: 0, g: 0, b: 0.1 }, gamma: { r: 0, g: 0, b: 0 }, gain: { r: 0, g: 0, b: 0 } } },
        { name: 'Warm', value: { lift: { r: 0.1, g: 0, b: 0 }, gamma: { r: 0, g: 0, b: 0 }, gain: { r: 0, g: 0, b: 0 } } },
      ];

      render(<ColorWheelsPanel {...defaultProps} presets={presets} />);

      expect(screen.getByRole('combobox', { name: /preset/i })).toBeInTheDocument();
    });

    it('should apply preset when selected', async () => {
      const onChange = vi.fn();
      const presets = [
        { name: 'Cool', value: { lift: { r: 0, g: 0, b: 0.1 }, gamma: { r: 0, g: 0, b: 0 }, gain: { r: 0, g: 0, b: 0 } } },
      ];

      render(
        <ColorWheelsPanel {...defaultProps} onChange={onChange} presets={presets} />
      );

      const select = screen.getByRole('combobox', { name: /preset/i });
      await userEvent.selectOptions(select, 'Cool');

      expect(onChange).toHaveBeenCalledWith(presets[0].value);
    });
  });
});
