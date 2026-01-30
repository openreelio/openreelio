/**
 * TransitionPicker Component Tests
 *
 * Tests for the transition picker modal/panel that allows users
 * to select and configure transitions between clips.
 * TDD: RED phase - writing tests first
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TransitionPicker } from './TransitionPicker';
import type { TransitionConfig } from './TransitionPicker';

// =============================================================================
// Rendering Tests
// =============================================================================

describe('TransitionPicker', () => {
  describe('rendering', () => {
    it('should render the transition picker container', () => {
      render(<TransitionPicker onSelect={vi.fn()} />);

      expect(screen.getByTestId('transition-picker')).toBeInTheDocument();
    });

    it('should render header with Transitions title', () => {
      render(<TransitionPicker onSelect={vi.fn()} />);

      expect(screen.getByText('Transitions')).toBeInTheDocument();
    });

    it('should display transition types', () => {
      render(<TransitionPicker onSelect={vi.fn()} />);

      expect(screen.getByText('Cross Dissolve')).toBeInTheDocument();
      expect(screen.getByText('Fade')).toBeInTheDocument();
      expect(screen.getByText('Wipe')).toBeInTheDocument();
      expect(screen.getByText('Slide')).toBeInTheDocument();
      expect(screen.getByText('Zoom')).toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Selection Tests
  // ===========================================================================

  describe('selection', () => {
    it('should highlight selected transition', () => {
      render(<TransitionPicker onSelect={vi.fn()} selectedType="wipe" />);

      const wipeCard = screen.getByTestId('transition-card-wipe');
      expect(wipeCard).toHaveClass('ring-2');
    });

    it('should call onSelect with transition type when card is clicked', () => {
      const onSelect = vi.fn();
      render(<TransitionPicker onSelect={onSelect} />);

      fireEvent.click(screen.getByTestId('transition-card-cross_dissolve'));

      expect(onSelect).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'cross_dissolve' })
      );
    });

    it('should default duration to 1 second', () => {
      const onSelect = vi.fn();
      render(<TransitionPicker onSelect={onSelect} />);

      fireEvent.click(screen.getByTestId('transition-card-fade'));

      expect(onSelect).toHaveBeenCalledWith(
        expect.objectContaining({ duration: 1 })
      );
    });
  });

  // ===========================================================================
  // Duration Configuration Tests
  // ===========================================================================

  describe('duration configuration', () => {
    it('should render duration input', () => {
      render(<TransitionPicker onSelect={vi.fn()} />);

      expect(screen.getByLabelText(/duration/i)).toBeInTheDocument();
    });

    it('should allow changing duration', () => {
      const onSelect = vi.fn();
      render(<TransitionPicker onSelect={onSelect} />);

      const durationInput = screen.getByLabelText(/duration/i);
      fireEvent.change(durationInput, { target: { value: '2.5' } });
      fireEvent.click(screen.getByTestId('transition-card-fade'));

      expect(onSelect).toHaveBeenCalledWith(
        expect.objectContaining({ duration: 2.5 })
      );
    });

    it('should clamp duration to minimum 0.1 seconds', () => {
      const onSelect = vi.fn();
      render(<TransitionPicker onSelect={onSelect} />);

      const durationInput = screen.getByLabelText(/duration/i);
      fireEvent.change(durationInput, { target: { value: '0.01' } });
      fireEvent.click(screen.getByTestId('transition-card-fade'));

      expect(onSelect).toHaveBeenCalledWith(
        expect.objectContaining({ duration: 0.1 })
      );
    });

    it('should clamp duration to maximum 10 seconds', () => {
      const onSelect = vi.fn();
      render(<TransitionPicker onSelect={onSelect} />);

      const durationInput = screen.getByLabelText(/duration/i);
      fireEvent.change(durationInput, { target: { value: '15' } });
      fireEvent.click(screen.getByTestId('transition-card-fade'));

      expect(onSelect).toHaveBeenCalledWith(
        expect.objectContaining({ duration: 10 })
      );
    });
  });

  // ===========================================================================
  // Direction Configuration Tests (Wipe/Slide)
  // ===========================================================================

  describe('direction configuration', () => {
    it('should show direction options for Wipe transition', () => {
      render(<TransitionPicker onSelect={vi.fn()} selectedType="wipe" />);

      expect(screen.getByLabelText(/direction/i)).toBeInTheDocument();
    });

    it('should show direction options for Slide transition', () => {
      render(<TransitionPicker onSelect={vi.fn()} selectedType="slide" />);

      expect(screen.getByLabelText(/direction/i)).toBeInTheDocument();
    });

    it('should not show direction options for Cross Dissolve', () => {
      render(<TransitionPicker onSelect={vi.fn()} selectedType="cross_dissolve" />);

      expect(screen.queryByLabelText(/direction/i)).not.toBeInTheDocument();
    });

    it('should include direction in config for directional transitions', () => {
      const onSelect = vi.fn();
      render(<TransitionPicker onSelect={onSelect} selectedType="wipe" />);

      const directionSelect = screen.getByLabelText(/direction/i);
      fireEvent.change(directionSelect, { target: { value: 'right' } });
      fireEvent.click(screen.getByTestId('transition-card-wipe'));

      expect(onSelect).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'wipe',
          direction: 'right',
        })
      );
    });

    it('should support all four directions', () => {
      render(<TransitionPicker onSelect={vi.fn()} selectedType="slide" />);

      const directionSelect = screen.getByLabelText(/direction/i);
      const options = Array.from(directionSelect.querySelectorAll('option'));

      expect(options.map((o) => o.value)).toEqual(
        expect.arrayContaining(['left', 'right', 'up', 'down'])
      );
    });
  });

  // ===========================================================================
  // Zoom Configuration Tests
  // ===========================================================================

  describe('zoom configuration', () => {
    it('should show zoom type options for Zoom transition', () => {
      render(<TransitionPicker onSelect={vi.fn()} selectedType="zoom" />);

      expect(screen.getByLabelText(/zoom type/i)).toBeInTheDocument();
    });

    it('should support zoom in and zoom out options', () => {
      render(<TransitionPicker onSelect={vi.fn()} selectedType="zoom" />);

      const zoomTypeSelect = screen.getByLabelText(/zoom type/i);
      const options = Array.from(zoomTypeSelect.querySelectorAll('option'));

      expect(options.map((o) => o.value)).toEqual(
        expect.arrayContaining(['in', 'out'])
      );
    });

    it('should include zoom type in config', () => {
      const onSelect = vi.fn();
      render(<TransitionPicker onSelect={onSelect} selectedType="zoom" />);

      const zoomTypeSelect = screen.getByLabelText(/zoom type/i);
      fireEvent.change(zoomTypeSelect, { target: { value: 'out' } });
      fireEvent.click(screen.getByTestId('transition-card-zoom'));

      expect(onSelect).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'zoom',
          zoomType: 'out',
        })
      );
    });
  });

  // ===========================================================================
  // Transition Descriptions Tests
  // ===========================================================================

  describe('descriptions', () => {
    it('should display description for each transition type', () => {
      render(<TransitionPicker onSelect={vi.fn()} />);

      expect(screen.getByText(/smooth blend/i)).toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Cancel/Apply Actions Tests
  // ===========================================================================

  describe('actions', () => {
    it('should render cancel button when onCancel is provided', () => {
      render(<TransitionPicker onSelect={vi.fn()} onCancel={vi.fn()} />);

      expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument();
    });

    it('should call onCancel when cancel button is clicked', () => {
      const onCancel = vi.fn();
      render(<TransitionPicker onSelect={vi.fn()} onCancel={onCancel} />);

      fireEvent.click(screen.getByRole('button', { name: /cancel/i }));

      expect(onCancel).toHaveBeenCalled();
    });

    it('should render apply button', () => {
      render(<TransitionPicker onSelect={vi.fn()} />);

      expect(screen.getByRole('button', { name: /apply/i })).toBeInTheDocument();
    });

    it('should call onSelect with current config when apply is clicked', () => {
      const onSelect = vi.fn();
      render(<TransitionPicker onSelect={onSelect} selectedType="fade" />);

      fireEvent.click(screen.getByRole('button', { name: /apply/i }));

      expect(onSelect).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'fade' })
      );
    });
  });

  // ===========================================================================
  // Accessibility Tests
  // ===========================================================================

  describe('accessibility', () => {
    it('should have accessible transition cards', () => {
      render(<TransitionPicker onSelect={vi.fn()} />);

      const card = screen.getByTestId('transition-card-cross_dissolve');
      expect(card).toHaveAttribute('role', 'button');
      expect(card).toHaveAttribute('tabIndex', '0');
    });

    it('should support keyboard selection with Enter', () => {
      const onSelect = vi.fn();
      render(<TransitionPicker onSelect={onSelect} />);

      const card = screen.getByTestId('transition-card-wipe');
      fireEvent.keyDown(card, { key: 'Enter' });

      expect(onSelect).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'wipe' })
      );
    });

    it('should support keyboard selection with Space', () => {
      const onSelect = vi.fn();
      render(<TransitionPicker onSelect={onSelect} />);

      const card = screen.getByTestId('transition-card-slide');
      fireEvent.keyDown(card, { key: ' ' });

      expect(onSelect).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'slide' })
      );
    });
  });

  // ===========================================================================
  // Custom className Tests
  // ===========================================================================

  describe('styling', () => {
    it('should apply custom className', () => {
      render(<TransitionPicker onSelect={vi.fn()} className="custom-class" />);

      expect(screen.getByTestId('transition-picker')).toHaveClass('custom-class');
    });
  });

  // ===========================================================================
  // Initial Config Tests
  // ===========================================================================

  describe('initial config', () => {
    it('should use initial config when provided', () => {
      const initialConfig: TransitionConfig = {
        type: 'wipe',
        duration: 2,
        direction: 'right',
      };

      render(<TransitionPicker onSelect={vi.fn()} initialConfig={initialConfig} />);

      const durationInput = screen.getByLabelText(/duration/i) as HTMLInputElement;
      expect(durationInput.value).toBe('2');

      const directionSelect = screen.getByLabelText(/direction/i) as HTMLSelectElement;
      expect(directionSelect.value).toBe('right');
    });
  });

  // ===========================================================================
  // Security and Edge Cases
  // ===========================================================================

  describe('Security and Edge Cases', () => {
    it('should handle NaN duration input', () => {
      const onSelect = vi.fn();
      render(<TransitionPicker onSelect={onSelect} />);

      const durationInput = screen.getByLabelText(/duration/i);
      fireEvent.change(durationInput, { target: { value: 'NaN' } });
      fireEvent.blur(durationInput);
      fireEvent.click(screen.getByTestId('transition-card-fade'));

      // Duration should be clamped to valid value
      const call = onSelect.mock.calls[0][0];
      expect(Number.isFinite(call.duration)).toBe(true);
      expect(call.duration).toBeGreaterThanOrEqual(0.1);
    });

    it('should handle negative duration input', () => {
      const onSelect = vi.fn();
      render(<TransitionPicker onSelect={onSelect} />);

      const durationInput = screen.getByLabelText(/duration/i);
      fireEvent.change(durationInput, { target: { value: '-5' } });
      fireEvent.blur(durationInput);
      fireEvent.click(screen.getByTestId('transition-card-fade'));

      // Duration should be clamped to minimum
      const call = onSelect.mock.calls[0][0];
      expect(call.duration).toBeGreaterThanOrEqual(0.1);
    });

    it('should handle very large duration input', () => {
      const onSelect = vi.fn();
      render(<TransitionPicker onSelect={onSelect} />);

      const durationInput = screen.getByLabelText(/duration/i);
      fireEvent.change(durationInput, { target: { value: '1000000' } });
      fireEvent.blur(durationInput);
      fireEvent.click(screen.getByTestId('transition-card-fade'));

      // Duration should be clamped to maximum
      const call = onSelect.mock.calls[0][0];
      expect(call.duration).toBeLessThanOrEqual(10);
    });

    it('should handle empty duration input', () => {
      const onSelect = vi.fn();
      render(<TransitionPicker onSelect={onSelect} />);

      const durationInput = screen.getByLabelText(/duration/i) as HTMLInputElement;
      fireEvent.change(durationInput, { target: { value: '' } });
      fireEvent.blur(durationInput);
      fireEvent.click(screen.getByTestId('transition-card-fade'));

      // Should use default or previous valid value
      const call = onSelect.mock.calls[0][0];
      expect(Number.isFinite(call.duration)).toBe(true);
    });
  });

  // ===========================================================================
  // Keyboard Navigation Tests
  // ===========================================================================

  describe('Keyboard Navigation', () => {
    it('should increase duration with ArrowUp', () => {
      render(<TransitionPicker onSelect={vi.fn()} />);

      const durationInput = screen.getByLabelText(/duration/i) as HTMLInputElement;
      const initialValue = parseFloat(durationInput.value);

      fireEvent.keyDown(durationInput, { key: 'ArrowUp' });

      const newValue = parseFloat(durationInput.value);
      expect(newValue).toBeGreaterThan(initialValue);
    });

    it('should decrease duration with ArrowDown', () => {
      render(<TransitionPicker onSelect={vi.fn()} />);

      const durationInput = screen.getByLabelText(/duration/i) as HTMLInputElement;
      const initialValue = parseFloat(durationInput.value);

      fireEvent.keyDown(durationInput, { key: 'ArrowDown' });

      const newValue = parseFloat(durationInput.value);
      expect(newValue).toBeLessThan(initialValue);
    });

    it('should not go below minimum with ArrowDown', () => {
      render(<TransitionPicker onSelect={vi.fn()} />);

      const durationInput = screen.getByLabelText(/duration/i) as HTMLInputElement;
      fireEvent.change(durationInput, { target: { value: '0.1' } });

      // Try to go below minimum
      for (let i = 0; i < 10; i++) {
        fireEvent.keyDown(durationInput, { key: 'ArrowDown' });
      }

      const finalValue = parseFloat(durationInput.value);
      expect(finalValue).toBeGreaterThanOrEqual(0.1);
    });

    it('should call onCancel with Escape key', () => {
      const onCancel = vi.fn();
      render(<TransitionPicker onSelect={vi.fn()} onCancel={onCancel} />);

      const durationInput = screen.getByLabelText(/duration/i);
      fireEvent.keyDown(durationInput, { key: 'Escape' });

      expect(onCancel).toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Concurrent State Changes
  // ===========================================================================

  describe('Concurrent State Changes', () => {
    it('should handle rapid type selection changes', () => {
      const onSelect = vi.fn();
      render(<TransitionPicker onSelect={onSelect} />);

      // Rapidly click different transition types
      fireEvent.click(screen.getByTestId('transition-card-fade'));
      fireEvent.click(screen.getByTestId('transition-card-wipe'));
      fireEvent.click(screen.getByTestId('transition-card-slide'));
      fireEvent.click(screen.getByTestId('transition-card-zoom'));
      fireEvent.click(screen.getByTestId('transition-card-cross_dissolve'));

      // All calls should be valid
      expect(onSelect).toHaveBeenCalledTimes(5);
      onSelect.mock.calls.forEach((call) => {
        expect(call[0]).toHaveProperty('type');
        expect(call[0]).toHaveProperty('duration');
      });
    });

    it('should handle selectedType prop changes during selection', () => {
      const onSelect = vi.fn();
      const { rerender } = render(
        <TransitionPicker onSelect={onSelect} selectedType="fade" />
      );

      // Change prop while component is rendered
      rerender(<TransitionPicker onSelect={onSelect} selectedType="wipe" />);

      // Click apply - should use updated type
      fireEvent.click(screen.getByRole('button', { name: /apply/i }));

      expect(onSelect).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'wipe' })
      );
    });
  });
});
