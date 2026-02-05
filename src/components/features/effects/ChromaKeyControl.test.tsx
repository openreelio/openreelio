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
import { DEFAULT_CHROMA_KEY_PARAMS } from '@/hooks/useChromaKey';

describe('ChromaKeyControl', () => {
  let user: ReturnType<typeof userEvent.setup>;

  const defaultProps = {
    initialParams: DEFAULT_CHROMA_KEY_PARAMS,
    onChange: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    user = userEvent.setup();
  });

  describe('rendering', () => {
    it('should render key color control', () => {
      render(<ChromaKeyControl {...defaultProps} />);

      expect(screen.getByText(/^key color$/i)).toBeInTheDocument();
      expect(screen.getByTestId('color-swatch')).toBeInTheDocument();
    });

    it('should render similarity slider', () => {
      render(<ChromaKeyControl {...defaultProps} />);

      expect(screen.getByText(/^similarity$/i)).toBeInTheDocument();
      expect(screen.getByRole('slider', { name: /similarity/i })).toBeInTheDocument();
    });

    it('should render softness slider', () => {
      render(<ChromaKeyControl {...defaultProps} />);

      expect(screen.getByText(/^softness$/i)).toBeInTheDocument();
      expect(screen.getByRole('slider', { name: /softness/i })).toBeInTheDocument();
    });

    it('should show current color value', () => {
      render(
        <ChromaKeyControl
          {...defaultProps}
          initialParams={{ ...DEFAULT_CHROMA_KEY_PARAMS, keyColor: '#00FF00' }}
        />
      );

      expect(screen.getByTestId('color-input')).toHaveValue('#00ff00');
    });

    it('should show preset color buttons', () => {
      render(<ChromaKeyControl {...defaultProps} />);

      expect(screen.getByRole('button', { name: /green/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /blue/i })).toBeInTheDocument();
    });
  });

  describe('color interaction', () => {
    it('should call onChange when preset is clicked', async () => {
      const onChange = vi.fn();
      render(<ChromaKeyControl {...defaultProps} onChange={onChange} />);

      await user.click(screen.getByRole('button', { name: /blue/i }));

      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({ keyColor: '#0000FF' })
      );
    });

    it('should call onChange when green preset is clicked', async () => {
      const onChange = vi.fn();
      render(
        <ChromaKeyControl
          {...defaultProps}
          initialParams={{ ...DEFAULT_CHROMA_KEY_PARAMS, keyColor: '#0000FF' }}
          onChange={onChange}
        />
      );

      await user.click(screen.getByRole('button', { name: /green/i }));

      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({ keyColor: '#00FF00' })
      );
    });

    it('should allow custom color input', () => {
      const onChange = vi.fn();
      render(<ChromaKeyControl {...defaultProps} onChange={onChange} />);

      const colorInput = screen.getByTestId('color-input');
      fireEvent.change(colorInput, { target: { value: '#FF00FF' } });

      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({ keyColor: '#FF00FF' })
      );
    });
  });

  describe('slider interaction', () => {
    it('should call onChange when similarity slider changes', () => {
      const onChange = vi.fn();
      render(<ChromaKeyControl {...defaultProps} onChange={onChange} />);

      const slider = screen.getByRole('slider', { name: /similarity/i });
      fireEvent.change(slider, { target: { value: '0.5' } });

      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({ similarity: 0.5 })
      );
    });

    it('should call onChange when softness slider changes', () => {
      const onChange = vi.fn();
      render(<ChromaKeyControl {...defaultProps} onChange={onChange} />);

      const slider = screen.getByRole('slider', { name: /softness/i });
      fireEvent.change(slider, { target: { value: '0.3' } });

      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({ softness: 0.3 })
      );
    });

    it('should display current similarity value', () => {
      render(
        <ChromaKeyControl
          {...defaultProps}
          initialParams={{ ...DEFAULT_CHROMA_KEY_PARAMS, similarity: 0.45 }}
        />
      );

      expect(screen.getByText('45%')).toBeInTheDocument();
    });

    it('should display current softness value', () => {
      render(
        <ChromaKeyControl
          {...defaultProps}
          initialParams={{ ...DEFAULT_CHROMA_KEY_PARAMS, softness: 0.25 }}
        />
      );

      expect(screen.getByText('25%')).toBeInTheDocument();
    });
  });

  describe('reset functionality', () => {
    it('should reset all values when reset button is clicked', async () => {
      const onChange = vi.fn();
      render(
        <ChromaKeyControl
          initialParams={{
            ...DEFAULT_CHROMA_KEY_PARAMS,
            keyColor: '#FF0000',
            similarity: 0.8,
            softness: 0.6,
            spillSuppression: 0.7,
            edgeFeather: 5,
          }}
          onChange={onChange}
        />
      );

      await user.click(screen.getByRole('button', { name: /reset chroma key/i }));

      expect(onChange).toHaveBeenCalledWith(DEFAULT_CHROMA_KEY_PARAMS);
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

      expect(screen.getByTestId('color-input')).toBeDisabled();
      expect(screen.getByRole('button', { name: /reset chroma key/i })).toBeDisabled();
    });

    it('should not respond to clicks when disabled', async () => {
      const onChange = vi.fn();
      render(<ChromaKeyControl {...defaultProps} disabled onChange={onChange} />);

      const blueButton = screen.getByRole('button', { name: /blue/i });
      expect(blueButton).toBeDisabled();

      await user.click(blueButton);
      expect(onChange).not.toHaveBeenCalled();
    });
  });

  describe('accessibility', () => {
    it('should have proper ARIA labels', () => {
      render(<ChromaKeyControl {...defaultProps} />);

      expect(screen.getByRole('slider', { name: /similarity/i })).toBeInTheDocument();
      expect(screen.getByRole('slider', { name: /softness/i })).toBeInTheDocument();
    });

    it('should have accessible color picker', () => {
      render(<ChromaKeyControl {...defaultProps} />);

      const colorInput = screen.getByTestId('color-input');
      expect(colorInput).toHaveAttribute('type', 'color');
    });
  });

  describe('visual feedback', () => {
    it('should highlight active preset', () => {
      render(
        <ChromaKeyControl
          {...defaultProps}
          initialParams={{ ...DEFAULT_CHROMA_KEY_PARAMS, keyColor: '#00FF00' }}
        />
      );

      const greenButton = screen.getByRole('button', { name: /green/i });
      expect(greenButton).toHaveClass('ring-2');
    });

    it('should not highlight inactive preset', () => {
      render(
        <ChromaKeyControl
          {...defaultProps}
          initialParams={{ ...DEFAULT_CHROMA_KEY_PARAMS, keyColor: '#00FF00' }}
        />
      );

      const blueButton = screen.getByRole('button', { name: /blue/i });
      expect(blueButton).not.toHaveClass('ring-2');
    });
  });
});
