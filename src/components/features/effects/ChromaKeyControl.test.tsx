/**
 * ChromaKeyControl Tests
 *
 * Tests for the chroma key (green screen) control component.
 * Following TDD methodology.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChromaKeyControl } from './ChromaKeyControl';

describe('ChromaKeyControl', () => {
  const defaultProps = {
    keyColor: '#00FF00',
    similarity: 0.3,
    blend: 0.1,
    onKeyColorChange: vi.fn(),
    onSimilarityChange: vi.fn(),
    onBlendChange: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('rendering', () => {
    it('should render key color control', () => {
      render(<ChromaKeyControl {...defaultProps} />);

      expect(screen.getByText(/key color/i)).toBeInTheDocument();
      expect(screen.getByTestId('color-swatch')).toBeInTheDocument();
    });

    it('should render similarity slider', () => {
      render(<ChromaKeyControl {...defaultProps} />);

      expect(screen.getByText(/similarity/i)).toBeInTheDocument();
      const slider = screen.getByRole('slider', { name: /similarity/i });
      expect(slider).toBeInTheDocument();
    });

    it('should render blend slider', () => {
      render(<ChromaKeyControl {...defaultProps} />);

      expect(screen.getByText(/blend/i)).toBeInTheDocument();
      const slider = screen.getByRole('slider', { name: /blend/i });
      expect(slider).toBeInTheDocument();
    });

    it('should show current color value', () => {
      render(<ChromaKeyControl {...defaultProps} keyColor="#00FF00" />);

      const swatch = screen.getByTestId('color-swatch');
      expect(swatch).toHaveStyle({ backgroundColor: '#00FF00' });
    });

    it('should show preset color buttons', () => {
      render(<ChromaKeyControl {...defaultProps} />);

      expect(screen.getByRole('button', { name: /green/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /blue/i })).toBeInTheDocument();
    });
  });

  describe('color interaction', () => {
    it('should call onKeyColorChange when preset is clicked', async () => {
      const onKeyColorChange = vi.fn();
      render(
        <ChromaKeyControl {...defaultProps} onKeyColorChange={onKeyColorChange} />
      );

      const blueButton = screen.getByRole('button', { name: /blue/i });
      await userEvent.click(blueButton);

      expect(onKeyColorChange).toHaveBeenCalledWith('#0000FF');
    });

    it('should call onKeyColorChange when green preset is clicked', async () => {
      const onKeyColorChange = vi.fn();
      render(
        <ChromaKeyControl
          {...defaultProps}
          keyColor="#0000FF"
          onKeyColorChange={onKeyColorChange}
        />
      );

      const greenButton = screen.getByRole('button', { name: /green/i });
      await userEvent.click(greenButton);

      expect(onKeyColorChange).toHaveBeenCalledWith('#00FF00');
    });

    it('should allow custom color input', async () => {
      const onKeyColorChange = vi.fn();
      render(
        <ChromaKeyControl {...defaultProps} onKeyColorChange={onKeyColorChange} />
      );

      const colorInput = screen.getByTestId('color-input');
      fireEvent.change(colorInput, { target: { value: '#FF00FF' } });

      expect(onKeyColorChange).toHaveBeenCalledWith('#FF00FF');
    });
  });

  describe('slider interaction', () => {
    it('should call onSimilarityChange when slider changes', () => {
      const onSimilarityChange = vi.fn();
      render(
        <ChromaKeyControl
          {...defaultProps}
          onSimilarityChange={onSimilarityChange}
        />
      );

      const slider = screen.getByRole('slider', { name: /similarity/i });
      fireEvent.change(slider, { target: { value: '0.5' } });

      expect(onSimilarityChange).toHaveBeenCalledWith(0.5);
    });

    it('should call onBlendChange when slider changes', () => {
      const onBlendChange = vi.fn();
      render(
        <ChromaKeyControl {...defaultProps} onBlendChange={onBlendChange} />
      );

      const slider = screen.getByRole('slider', { name: /blend/i });
      fireEvent.change(slider, { target: { value: '0.3' } });

      expect(onBlendChange).toHaveBeenCalledWith(0.3);
    });

    it('should display current similarity value', () => {
      render(<ChromaKeyControl {...defaultProps} similarity={0.45} />);

      expect(screen.getByText('45%')).toBeInTheDocument();
    });

    it('should display current blend value', () => {
      render(<ChromaKeyControl {...defaultProps} blend={0.25} />);

      expect(screen.getByText('25%')).toBeInTheDocument();
    });
  });

  describe('reset functionality', () => {
    it('should reset all values when reset button is clicked', async () => {
      const onKeyColorChange = vi.fn();
      const onSimilarityChange = vi.fn();
      const onBlendChange = vi.fn();

      render(
        <ChromaKeyControl
          {...defaultProps}
          keyColor="#FF0000"
          similarity={0.8}
          blend={0.6}
          onKeyColorChange={onKeyColorChange}
          onSimilarityChange={onSimilarityChange}
          onBlendChange={onBlendChange}
        />
      );

      const resetButton = screen.getByRole('button', { name: /reset/i });
      await userEvent.click(resetButton);

      expect(onKeyColorChange).toHaveBeenCalledWith('#00FF00');
      expect(onSimilarityChange).toHaveBeenCalledWith(0.3);
      expect(onBlendChange).toHaveBeenCalledWith(0.1);
    });
  });

  describe('disabled state', () => {
    it('should disable all controls when disabled', () => {
      render(<ChromaKeyControl {...defaultProps} disabled />);

      const container = screen.getByTestId('chroma-key-control');
      expect(container).toHaveClass('opacity-50');

      const sliders = screen.getAllByRole('slider');
      sliders.forEach((slider) => {
        expect(slider).toBeDisabled();
      });
    });

    it('should not respond to clicks when disabled', async () => {
      const onKeyColorChange = vi.fn();
      render(
        <ChromaKeyControl
          {...defaultProps}
          disabled
          onKeyColorChange={onKeyColorChange}
        />
      );

      const blueButton = screen.getByRole('button', { name: /blue/i });
      await userEvent.click(blueButton);

      expect(onKeyColorChange).not.toHaveBeenCalled();
    });
  });

  describe('accessibility', () => {
    it('should have proper ARIA labels', () => {
      render(<ChromaKeyControl {...defaultProps} />);

      expect(
        screen.getByRole('slider', { name: /similarity/i })
      ).toBeInTheDocument();
      expect(screen.getByRole('slider', { name: /blend/i })).toBeInTheDocument();
    });

    it('should have accessible color picker', () => {
      render(<ChromaKeyControl {...defaultProps} />);

      const colorInput = screen.getByTestId('color-input');
      expect(colorInput).toHaveAttribute('type', 'color');
    });
  });

  describe('visual feedback', () => {
    it('should highlight active preset', () => {
      render(<ChromaKeyControl {...defaultProps} keyColor="#00FF00" />);

      const greenButton = screen.getByRole('button', { name: /green/i });
      expect(greenButton).toHaveClass('ring-2');
    });

    it('should not highlight inactive preset', () => {
      render(<ChromaKeyControl {...defaultProps} keyColor="#00FF00" />);

      const blueButton = screen.getByRole('button', { name: /blue/i });
      expect(blueButton).not.toHaveClass('ring-2');
    });
  });
});
