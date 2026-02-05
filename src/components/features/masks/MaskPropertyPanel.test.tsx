/**
 * MaskPropertyPanel Component Tests
 *
 * TDD tests for mask property editing panel.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MaskPropertyPanel } from './MaskPropertyPanel';
import type { Mask } from '@/types';

// Test data
const createTestMask = (): Mask => ({
  id: 'mask-1',
  name: 'Test Mask',
  shape: { type: 'rectangle', x: 0.5, y: 0.5, width: 0.3, height: 0.2, cornerRadius: 0, rotation: 0 },
  inverted: false,
  feather: 0.1,
  opacity: 1.0,
  expansion: 0,
  blendMode: 'add',
  enabled: true,
  locked: false,
});

describe('MaskPropertyPanel', () => {
  // ==========================================================================
  // Rendering Tests
  // ==========================================================================

  describe('rendering', () => {
    it('renders nothing when no mask selected', () => {
      const onChange = vi.fn();
      const { container } = render(
        <MaskPropertyPanel mask={null} onChange={onChange} />
      );

      expect(container.firstChild).toBeNull();
    });

    it('renders panel when mask is selected', () => {
      const mask = createTestMask();
      const onChange = vi.fn();

      render(<MaskPropertyPanel mask={mask} onChange={onChange} />);

      expect(screen.getByText('Mask Properties')).toBeInTheDocument();
    });

    it('renders name input', () => {
      const mask = createTestMask();
      const onChange = vi.fn();

      render(<MaskPropertyPanel mask={mask} onChange={onChange} />);

      expect(screen.getByLabelText(/Name/i)).toHaveValue('Test Mask');
    });

    it('renders feather slider', () => {
      const mask = createTestMask();
      const onChange = vi.fn();

      render(<MaskPropertyPanel mask={mask} onChange={onChange} />);

      expect(screen.getByLabelText(/Feather/i)).toBeInTheDocument();
    });

    it('renders opacity slider', () => {
      const mask = createTestMask();
      const onChange = vi.fn();

      render(<MaskPropertyPanel mask={mask} onChange={onChange} />);

      expect(screen.getByLabelText(/Opacity/i)).toBeInTheDocument();
    });

    it('renders expansion slider', () => {
      const mask = createTestMask();
      const onChange = vi.fn();

      render(<MaskPropertyPanel mask={mask} onChange={onChange} />);

      expect(screen.getByLabelText(/Expansion/i)).toBeInTheDocument();
    });

    it('renders blend mode selector', () => {
      const mask = createTestMask();
      const onChange = vi.fn();

      render(<MaskPropertyPanel mask={mask} onChange={onChange} />);

      expect(screen.getByLabelText(/Blend Mode/i)).toBeInTheDocument();
    });

    it('renders invert checkbox', () => {
      const mask = createTestMask();
      const onChange = vi.fn();

      render(<MaskPropertyPanel mask={mask} onChange={onChange} />);

      expect(screen.getByLabelText(/Invert/i)).toBeInTheDocument();
    });
  });

  // ==========================================================================
  // Value Display Tests
  // ==========================================================================

  describe('value display', () => {
    it('displays current feather value', () => {
      const mask = createTestMask();
      mask.feather = 0.5;
      const onChange = vi.fn();

      render(<MaskPropertyPanel mask={mask} onChange={onChange} />);

      expect(screen.getByLabelText(/Feather/i)).toHaveValue('0.5');
    });

    it('displays current opacity value', () => {
      const mask = createTestMask();
      mask.opacity = 0.8;
      const onChange = vi.fn();

      render(<MaskPropertyPanel mask={mask} onChange={onChange} />);

      expect(screen.getByLabelText(/Opacity/i)).toHaveValue('0.8');
    });

    it('displays invert state', () => {
      const mask = createTestMask();
      mask.inverted = true;
      const onChange = vi.fn();

      render(<MaskPropertyPanel mask={mask} onChange={onChange} />);

      expect(screen.getByLabelText(/Invert/i)).toBeChecked();
    });

    it('displays blend mode', () => {
      const mask = createTestMask();
      mask.blendMode = 'subtract';
      const onChange = vi.fn();

      render(<MaskPropertyPanel mask={mask} onChange={onChange} />);

      expect(screen.getByLabelText(/Blend Mode/i)).toHaveValue('subtract');
    });
  });

  // ==========================================================================
  // Interaction Tests
  // ==========================================================================

  describe('interactions', () => {
    it('calls onChange when name changes', async () => {
      const user = userEvent.setup();
      const mask = createTestMask();
      const onChange = vi.fn();

      render(<MaskPropertyPanel mask={mask} onChange={onChange} />);

      const input = screen.getByLabelText(/Name/i);
      await user.clear(input);
      await user.type(input, 'New Name');

      expect(onChange).toHaveBeenCalled();
    });

    it('calls onChange when feather slider changes', () => {
      const mask = createTestMask();
      const onChange = vi.fn();

      render(<MaskPropertyPanel mask={mask} onChange={onChange} />);

      const slider = screen.getByLabelText(/Feather/i);
      fireEvent.change(slider, { target: { value: '0.5' } });

      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({ feather: 0.5 })
      );
    });

    it('calls onChange when opacity slider changes', () => {
      const mask = createTestMask();
      const onChange = vi.fn();

      render(<MaskPropertyPanel mask={mask} onChange={onChange} />);

      const slider = screen.getByLabelText(/Opacity/i);
      fireEvent.change(slider, { target: { value: '0.7' } });

      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({ opacity: 0.7 })
      );
    });

    it('calls onChange when expansion slider changes', () => {
      const mask = createTestMask();
      const onChange = vi.fn();

      render(<MaskPropertyPanel mask={mask} onChange={onChange} />);

      const slider = screen.getByLabelText(/Expansion/i);
      fireEvent.change(slider, { target: { value: '0.2' } });

      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({ expansion: 0.2 })
      );
    });

    it('calls onChange when blend mode changes', async () => {
      const user = userEvent.setup();
      const mask = createTestMask();
      const onChange = vi.fn();

      render(<MaskPropertyPanel mask={mask} onChange={onChange} />);

      const select = screen.getByLabelText(/Blend Mode/i);
      await user.selectOptions(select, 'subtract');

      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({ blendMode: 'subtract' })
      );
    });

    it('calls onChange when invert is toggled', async () => {
      const user = userEvent.setup();
      const mask = createTestMask();
      const onChange = vi.fn();

      render(<MaskPropertyPanel mask={mask} onChange={onChange} />);

      const checkbox = screen.getByLabelText(/Invert/i);
      await user.click(checkbox);

      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({ inverted: true })
      );
    });
  });

  // ==========================================================================
  // Disabled State Tests
  // ==========================================================================

  describe('disabled state', () => {
    it('disables all inputs when disabled', () => {
      const mask = createTestMask();
      const onChange = vi.fn();

      render(
        <MaskPropertyPanel mask={mask} onChange={onChange} disabled={true} />
      );

      expect(screen.getByLabelText(/Name/i)).toBeDisabled();
      expect(screen.getByLabelText(/Feather/i)).toBeDisabled();
      expect(screen.getByLabelText(/Invert/i)).toBeDisabled();
    });

    it('disables inputs when mask is locked', () => {
      const mask = createTestMask();
      mask.locked = true;
      const onChange = vi.fn();

      render(<MaskPropertyPanel mask={mask} onChange={onChange} />);

      expect(screen.getByLabelText(/Feather/i)).toBeDisabled();
    });
  });
});
