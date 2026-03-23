/**
 * PasteAttributesDialog Component Tests
 *
 * Integration tests for the paste attributes dialog that allows
 * selective pasting of effects and clip attributes from the clipboard.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PasteAttributesDialog } from './PasteAttributesDialog';
import type { CopiedClipData } from '@/types';

// =============================================================================
// Test Data
// =============================================================================

const mockClipboardData: CopiedClipData = {
  sourceClipId: 'clip-1',
  effects: [
    { id: 'eff-1', effectType: 'brightness', enabled: true, params: {}, keyframes: {}, order: 0 },
    { id: 'eff-2', effectType: 'gaussian_blur', enabled: true, params: {}, keyframes: {}, order: 1 },
  ],
  transform: { position: { x: 0.5, y: 0.5 }, scale: { x: 1, y: 1 }, rotationDeg: 0, anchor: { x: 0.5, y: 0.5 } },
  opacity: 0.8,
  blendMode: 'normal',
  speed: 1.5,
  reverse: false,
  audio: { volumeDb: 0, pan: 0, muted: false },
};

const defaultProps = {
  isOpen: true,
  clipboardData: mockClipboardData,
  onConfirm: vi.fn(),
  onCancel: vi.fn(),
};

// =============================================================================
// Tests
// =============================================================================

describe('PasteAttributesDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  // ===========================================================================
  // Rendering Tests
  // ===========================================================================

  describe('rendering', () => {
    it('should render effects checkboxes when clipboard has effects', () => {
      render(<PasteAttributesDialog {...defaultProps} />);

      expect(screen.getByText('Brightness')).toBeInTheDocument();
      expect(screen.getByText('Gaussian Blur')).toBeInTheDocument();
    });

    it('should render a readable label for custom effect types', () => {
      render(
        <PasteAttributesDialog
          {...defaultProps}
          clipboardData={{
            ...mockClipboardData,
            effects: [
              {
                id: 'eff-custom',
                effectType: { custom: 'third_party_glow' },
                enabled: true,
                params: {},
                keyframes: {},
                order: 0,
              },
            ],
          }}
        />,
      );

      expect(screen.getByText('third_party_glow')).toBeInTheDocument();
      expect(screen.queryByText('[object Object]')).not.toBeInTheDocument();
    });

    it('should render attribute checkboxes for transform, opacity, blend mode, speed, audio', () => {
      render(<PasteAttributesDialog {...defaultProps} />);

      expect(screen.getByText('Transform')).toBeInTheDocument();
      expect(screen.getByText('Opacity')).toBeInTheDocument();
      expect(screen.getByText('Blend Mode')).toBeInTheDocument();
      expect(screen.getByText('Speed')).toBeInTheDocument();
      expect(screen.getByText('Audio Settings')).toBeInTheDocument();
    });

    it('should not render when isOpen is false', () => {
      render(<PasteAttributesDialog {...defaultProps} isOpen={false} />);

      expect(screen.queryByText('Paste Attributes')).not.toBeInTheDocument();
    });

    it('should not render when clipboardData is null', () => {
      render(<PasteAttributesDialog {...defaultProps} clipboardData={null} />);

      expect(screen.queryByText('Paste Attributes')).not.toBeInTheDocument();
    });

    it('should render the dialog title', () => {
      render(<PasteAttributesDialog {...defaultProps} />);

      expect(screen.getByText('Paste Attributes')).toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Button State Tests
  // ===========================================================================

  describe('button state', () => {
    it('should disable Paste button when nothing is selected', () => {
      render(<PasteAttributesDialog {...defaultProps} />);

      const pasteButton = screen.getByRole('button', { name: /paste/i });
      expect(pasteButton).toBeDisabled();
    });

    it('should enable Paste button when at least one item is selected', () => {
      render(<PasteAttributesDialog {...defaultProps} />);

      const transformCheckbox = screen.getByLabelText('Transform');
      fireEvent.click(transformCheckbox);

      const pasteButton = screen.getByRole('button', { name: /paste/i });
      expect(pasteButton).not.toBeDisabled();
    });

    it('should enable Paste button when an effect checkbox is selected', () => {
      render(<PasteAttributesDialog {...defaultProps} />);

      const brightnessCheckbox = screen.getByLabelText('Brightness');
      fireEvent.click(brightnessCheckbox);

      const pasteButton = screen.getByRole('button', { name: /paste/i });
      expect(pasteButton).not.toBeDisabled();
    });
  });

  // ===========================================================================
  // Confirm / Cancel Tests
  // ===========================================================================

  describe('confirm and cancel', () => {
    it('should call onConfirm with selected indices when Paste is clicked', () => {
      const onConfirm = vi.fn();
      render(<PasteAttributesDialog {...defaultProps} onConfirm={onConfirm} />);

      // Select the first effect (Brightness, index 0) and Opacity attribute
      fireEvent.click(screen.getByLabelText('Brightness'));
      fireEvent.click(screen.getByLabelText('Opacity'));

      fireEvent.click(screen.getByRole('button', { name: /paste/i }));

      expect(onConfirm).toHaveBeenCalledWith({
        effectIndices: [0],
        transform: false,
        opacity: true,
        blendMode: false,
        speed: false,
        audioSettings: false,
      });
    });

    it('should include multiple effect indices when multiple effects are selected', () => {
      const onConfirm = vi.fn();
      render(<PasteAttributesDialog {...defaultProps} onConfirm={onConfirm} />);

      // Select both effects
      fireEvent.click(screen.getByLabelText('Brightness'));
      fireEvent.click(screen.getByLabelText('Gaussian Blur'));

      fireEvent.click(screen.getByRole('button', { name: /paste/i }));

      expect(onConfirm).toHaveBeenCalledWith(
        expect.objectContaining({
          effectIndices: [0, 1],
        }),
      );
    });

    it('should call onCancel when Cancel is clicked', () => {
      const onCancel = vi.fn();
      render(<PasteAttributesDialog {...defaultProps} onCancel={onCancel} />);

      fireEvent.click(screen.getByRole('button', { name: /cancel/i }));

      expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it('should call onCancel when Escape is pressed', () => {
      const onCancel = vi.fn();
      render(<PasteAttributesDialog {...defaultProps} onCancel={onCancel} />);

      const dialog = screen.getByRole('dialog');
      fireEvent.keyDown(dialog, { key: 'Escape' });

      expect(onCancel).toHaveBeenCalledTimes(1);
    });
  });

  // ===========================================================================
  // Select All / Select None Tests
  // ===========================================================================

  describe('select all and select none', () => {
    it('should select all items when Select All is clicked', () => {
      const onConfirm = vi.fn();
      render(<PasteAttributesDialog {...defaultProps} onConfirm={onConfirm} />);

      fireEvent.click(screen.getByText('Select All'));

      // Paste button should now be enabled
      const pasteButton = screen.getByRole('button', { name: /paste/i });
      expect(pasteButton).not.toBeDisabled();

      // Confirm to verify all items are selected
      fireEvent.click(pasteButton);

      expect(onConfirm).toHaveBeenCalledWith({
        effectIndices: [0, 1],
        transform: true,
        opacity: true,
        blendMode: true,
        speed: true,
        audioSettings: true,
      });
    });

    it('should deselect all items when Select None is clicked', () => {
      render(<PasteAttributesDialog {...defaultProps} />);

      // First select all
      fireEvent.click(screen.getByText('Select All'));

      // Verify Paste is enabled
      expect(screen.getByRole('button', { name: /paste/i })).not.toBeDisabled();

      // Then deselect all
      fireEvent.click(screen.getByText('Select None'));

      // Paste button should be disabled again
      expect(screen.getByRole('button', { name: /paste/i })).toBeDisabled();
    });

    it('should check all checkboxes when Select All is clicked', () => {
      render(<PasteAttributesDialog {...defaultProps} />);

      fireEvent.click(screen.getByText('Select All'));

      const checkboxes = screen.getAllByRole('checkbox');
      checkboxes.forEach((checkbox) => {
        expect(checkbox).toBeChecked();
      });
    });

    it('should uncheck all checkboxes when Select None is clicked', () => {
      render(<PasteAttributesDialog {...defaultProps} />);

      // Select all first, then deselect
      fireEvent.click(screen.getByText('Select All'));
      fireEvent.click(screen.getByText('Select None'));

      const checkboxes = screen.getAllByRole('checkbox');
      checkboxes.forEach((checkbox) => {
        expect(checkbox).not.toBeChecked();
      });
    });
  });

  // ===========================================================================
  // Toggle Behavior Tests
  // ===========================================================================

  describe('toggle behavior', () => {
    it('should toggle an effect checkbox off after it was toggled on', () => {
      render(<PasteAttributesDialog {...defaultProps} />);

      const brightnessCheckbox = screen.getByLabelText('Brightness');

      // Toggle on
      fireEvent.click(brightnessCheckbox);
      expect(brightnessCheckbox).toBeChecked();

      // Toggle off
      fireEvent.click(brightnessCheckbox);
      expect(brightnessCheckbox).not.toBeChecked();
    });

    it('should toggle an attribute checkbox independently', () => {
      render(<PasteAttributesDialog {...defaultProps} />);

      const speedCheckbox = screen.getByLabelText('Speed');
      const audioCheckbox = screen.getByLabelText('Audio Settings');

      fireEvent.click(speedCheckbox);
      fireEvent.click(audioCheckbox);

      expect(speedCheckbox).toBeChecked();
      expect(audioCheckbox).toBeChecked();

      // Only deselect speed
      fireEvent.click(speedCheckbox);

      expect(speedCheckbox).not.toBeChecked();
      expect(audioCheckbox).toBeChecked();
    });
  });

  describe('dialog lifecycle', () => {
    it('should reset selections when reopened', () => {
      const { rerender } = render(<PasteAttributesDialog {...defaultProps} />);

      fireEvent.click(screen.getByLabelText('Brightness'));
      expect(screen.getByRole('button', { name: /paste/i })).not.toBeDisabled();

      rerender(<PasteAttributesDialog {...defaultProps} isOpen={false} />);
      rerender(<PasteAttributesDialog {...defaultProps} isOpen />);

      expect(screen.getByLabelText('Brightness')).not.toBeChecked();
      expect(screen.getByRole('button', { name: /paste/i })).toBeDisabled();
    });
  });
});
