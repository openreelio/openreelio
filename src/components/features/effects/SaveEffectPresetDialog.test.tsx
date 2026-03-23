/**
 * SaveEffectPresetDialog Component Tests
 *
 * Integration tests for the save effect preset dialog.
 * Uses BDD-style specs testing user interactions with real DOM.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SaveEffectPresetDialog } from './SaveEffectPresetDialog';
import type { Effect } from '@/types';

// =============================================================================
// Test Data
// =============================================================================

const mockEffect: Effect = {
  id: 'effect-001',
  effectType: 'gaussian_blur',
  enabled: true,
  params: {
    radius: 12.0,
    enabled: true,
  },
  keyframes: {},
  order: 0,
};

const defaultProps = {
  isOpen: true,
  effect: mockEffect,
  onConfirm: vi.fn(),
  onCancel: vi.fn(),
};

// =============================================================================
// Tests
// =============================================================================

describe('SaveEffectPresetDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  // ===========================================================================
  // Rendering
  // ===========================================================================

  describe('rendering', () => {
    it('should render dialog when isOpen is true', () => {
      render(<SaveEffectPresetDialog {...defaultProps} />);

      expect(screen.getByTestId('save-effect-preset-dialog')).toBeInTheDocument();
      expect(screen.getByText('Save Effect Preset')).toBeInTheDocument();
    });

    it('should not render when isOpen is false', () => {
      render(<SaveEffectPresetDialog {...defaultProps} isOpen={false} />);

      expect(screen.queryByTestId('save-effect-preset-dialog')).not.toBeInTheDocument();
    });

    it('should not render when effect is null', () => {
      render(<SaveEffectPresetDialog {...defaultProps} effect={null} />);

      expect(screen.queryByTestId('save-effect-preset-dialog')).not.toBeInTheDocument();
    });

    it('should show effect type label and parameter count', () => {
      render(<SaveEffectPresetDialog {...defaultProps} />);

      expect(screen.getByText(/Gaussian Blur/)).toBeInTheDocument();
      expect(screen.getByText(/2 parameters/)).toBeInTheDocument();
    });

    it('should pre-fill name input with effect type label', () => {
      render(<SaveEffectPresetDialog {...defaultProps} />);

      const nameInput = screen.getByTestId('preset-name-input') as HTMLInputElement;
      expect(nameInput.value).toBe('Gaussian Blur');
    });
  });

  // ===========================================================================
  // User Interactions
  // ===========================================================================

  describe('user interactions', () => {
    it('should call onConfirm with name and description when Save is clicked', () => {
      render(<SaveEffectPresetDialog {...defaultProps} />);

      const nameInput = screen.getByTestId('preset-name-input');
      const descInput = screen.getByTestId('preset-description-input');

      fireEvent.change(nameInput, { target: { value: 'My Custom Blur' } });
      fireEvent.change(descInput, { target: { value: 'A nice blur effect' } });
      fireEvent.click(screen.getByTestId('preset-save-btn'));

      expect(defaultProps.onConfirm).toHaveBeenCalledWith(
        'My Custom Blur',
        'A nice blur effect',
      );
    });

    it('should call onConfirm with undefined description when description is empty', () => {
      render(<SaveEffectPresetDialog {...defaultProps} />);

      const nameInput = screen.getByTestId('preset-name-input');
      fireEvent.change(nameInput, { target: { value: 'Quick Preset' } });
      fireEvent.click(screen.getByTestId('preset-save-btn'));

      expect(defaultProps.onConfirm).toHaveBeenCalledWith('Quick Preset', undefined);
    });

    it('should disable Save button when name is empty', () => {
      render(<SaveEffectPresetDialog {...defaultProps} />);

      const nameInput = screen.getByTestId('preset-name-input');
      fireEvent.change(nameInput, { target: { value: '' } });

      const saveBtn = screen.getByTestId('preset-save-btn');
      expect(saveBtn).toBeDisabled();
    });

    it('should call onCancel when Cancel is clicked', () => {
      render(<SaveEffectPresetDialog {...defaultProps} />);

      fireEvent.click(screen.getByTestId('preset-cancel-btn'));

      expect(defaultProps.onCancel).toHaveBeenCalledOnce();
    });

    it('should call onCancel when Escape key is pressed', () => {
      render(<SaveEffectPresetDialog {...defaultProps} />);

      fireEvent.keyDown(screen.getByTestId('save-effect-preset-dialog'), {
        key: 'Escape',
      });

      expect(defaultProps.onCancel).toHaveBeenCalledOnce();
    });

    it('should call onConfirm when Enter key is pressed with valid name', () => {
      render(<SaveEffectPresetDialog {...defaultProps} />);

      // Name is pre-filled, so Enter should work immediately
      fireEvent.keyDown(screen.getByTestId('save-effect-preset-dialog'), {
        key: 'Enter',
      });

      expect(defaultProps.onConfirm).toHaveBeenCalledOnce();
    });

    it('should call onCancel when overlay is clicked', () => {
      render(<SaveEffectPresetDialog {...defaultProps} />);

      fireEvent.click(screen.getByTestId('save-effect-preset-dialog'));

      expect(defaultProps.onCancel).toHaveBeenCalledOnce();
    });

    it('should trim whitespace from name before confirming', () => {
      render(<SaveEffectPresetDialog {...defaultProps} />);

      const nameInput = screen.getByTestId('preset-name-input');
      fireEvent.change(nameInput, { target: { value: '  Trimmed Name  ' } });
      fireEvent.click(screen.getByTestId('preset-save-btn'));

      expect(defaultProps.onConfirm).toHaveBeenCalledWith('Trimmed Name', undefined);
    });
  });

  // ===========================================================================
  // Edge Cases
  // ===========================================================================

  describe('edge cases', () => {
    it('should handle effect with single parameter correctly', () => {
      const singleParamEffect: Effect = {
        ...mockEffect,
        params: { value: 0.5 },
      };
      render(<SaveEffectPresetDialog {...defaultProps} effect={singleParamEffect} />);

      expect(screen.getByText(/1 parameter[^s]/)).toBeInTheDocument();
    });

    it('should handle effect with no parameters', () => {
      const noParamEffect: Effect = {
        ...mockEffect,
        params: {},
      };
      render(<SaveEffectPresetDialog {...defaultProps} effect={noParamEffect} />);

      expect(screen.getByText(/0 parameters/)).toBeInTheDocument();
    });
  });
});
