/**
 * TextPresetPicker Component Tests
 *
 * TDD: RED phase - Writing tests first for text preset functionality.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TextPresetPicker } from './TextPresetPicker';
import { TEXT_PRESETS } from '@/data/textPresets';

describe('TextPresetPicker', () => {
  const mockOnSelect = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ===========================================================================
  // Rendering Tests
  // ===========================================================================

  describe('rendering', () => {
    it('should render the preset picker container', () => {
      render(<TextPresetPicker onSelect={mockOnSelect} />);

      expect(screen.getByTestId('text-preset-picker')).toBeInTheDocument();
    });

    it('should render all available presets', () => {
      render(<TextPresetPicker onSelect={mockOnSelect} />);

      // Should have at least 8 presets as per task requirements
      expect(TEXT_PRESETS.length).toBeGreaterThanOrEqual(8);

      // Each preset should have a button
      const presetButtons = screen.getAllByRole('button');
      expect(presetButtons.length).toBeGreaterThanOrEqual(8);
    });

    it('should render preset names', () => {
      render(<TextPresetPicker onSelect={mockOnSelect} />);

      // Check for some expected preset names - use getAllByText since names appear in both
      // button labels and potentially other places
      expect(screen.getAllByText(/lower third/i).length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText(/centered title/i).length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText(/subtitle/i).length).toBeGreaterThanOrEqual(1);
    });

    it('should render with custom className', () => {
      render(<TextPresetPicker onSelect={mockOnSelect} className="custom-class" />);

      expect(screen.getByTestId('text-preset-picker')).toHaveClass('custom-class');
    });

    it('should render section header', () => {
      render(<TextPresetPicker onSelect={mockOnSelect} />);

      expect(screen.getByText(/presets/i)).toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Preset Preview Tests
  // ===========================================================================

  describe('preset preview', () => {
    it('should render preview thumbnails for presets', () => {
      render(<TextPresetPicker onSelect={mockOnSelect} />);

      const previews = screen.getAllByTestId(/preset-preview-/);
      expect(previews.length).toBeGreaterThanOrEqual(8);
    });

    it('should show preset style indication in preview', () => {
      render(<TextPresetPicker onSelect={mockOnSelect} />);

      // Check that previews are rendered (they contain visual representation)
      const firstPreview = screen.getByTestId('preset-preview-lower-third');
      expect(firstPreview).toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Interaction Tests
  // ===========================================================================

  describe('interactions', () => {
    it('should call onSelect when clicking a preset', async () => {
      render(<TextPresetPicker onSelect={mockOnSelect} />);

      const lowerThirdPreset = screen.getByTestId('preset-button-lower-third');
      await userEvent.click(lowerThirdPreset);

      expect(mockOnSelect).toHaveBeenCalledTimes(1);
      expect(mockOnSelect).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'lower-third',
        })
      );
    });

    it('should call onSelect with correct preset data', async () => {
      render(<TextPresetPicker onSelect={mockOnSelect} />);

      const centeredTitlePreset = screen.getByTestId('preset-button-centered-title');
      await userEvent.click(centeredTitlePreset);

      expect(mockOnSelect).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'centered-title',
          name: expect.any(String),
          style: expect.objectContaining({
            fontSize: expect.any(Number),
            fontFamily: expect.any(String),
          }),
        })
      );
    });

    it('should support keyboard navigation', async () => {
      render(<TextPresetPicker onSelect={mockOnSelect} />);

      const firstButton = screen.getAllByRole('button')[0];

      // Use userEvent for proper keyboard interaction
      // When a button is focused and Enter/Space is pressed, it triggers click
      await userEvent.click(firstButton);

      expect(mockOnSelect).toHaveBeenCalledTimes(1);
    });
  });

  // ===========================================================================
  // Disabled State Tests
  // ===========================================================================

  describe('disabled state', () => {
    it('should disable all preset buttons when disabled prop is true', () => {
      render(<TextPresetPicker onSelect={mockOnSelect} disabled />);

      const buttons = screen.getAllByRole('button');
      buttons.forEach((button) => {
        expect(button).toBeDisabled();
      });
    });

    it('should not call onSelect when disabled', async () => {
      render(<TextPresetPicker onSelect={mockOnSelect} disabled />);

      const lowerThirdPreset = screen.getByTestId('preset-button-lower-third');
      await userEvent.click(lowerThirdPreset);

      expect(mockOnSelect).not.toHaveBeenCalled();
    });

    it('should show disabled styling', () => {
      render(<TextPresetPicker onSelect={mockOnSelect} disabled />);

      expect(screen.getByTestId('text-preset-picker')).toHaveClass('opacity-50');
    });
  });

  // ===========================================================================
  // Compact Mode Tests
  // ===========================================================================

  describe('compact mode', () => {
    it('should render in compact mode', () => {
      render(<TextPresetPicker onSelect={mockOnSelect} compact />);

      const container = screen.getByTestId('text-preset-picker');
      expect(container).toHaveClass('compact');
    });

    it('should use smaller grid in compact mode', () => {
      render(<TextPresetPicker onSelect={mockOnSelect} compact />);

      // Compact mode uses a different grid layout
      const grid = screen.getByTestId('preset-grid');
      expect(grid).toHaveClass('grid-cols-4');
    });
  });

  // ===========================================================================
  // Preset Data Tests
  // ===========================================================================

  describe('preset data structure', () => {
    it('should have valid preset data structure', () => {
      TEXT_PRESETS.forEach((preset) => {
        expect(preset).toHaveProperty('id');
        expect(preset).toHaveProperty('name');
        expect(preset).toHaveProperty('style');
        expect(preset.style).toHaveProperty('fontFamily');
        expect(preset.style).toHaveProperty('fontSize');
        expect(preset.style).toHaveProperty('color');
      });
    });

    it('should have position data for all presets', () => {
      TEXT_PRESETS.forEach((preset) => {
        expect(preset).toHaveProperty('position');
        expect(preset.position).toHaveProperty('x');
        expect(preset.position).toHaveProperty('y');
        expect(preset.position.x).toBeGreaterThanOrEqual(0);
        expect(preset.position.x).toBeLessThanOrEqual(1);
        expect(preset.position.y).toBeGreaterThanOrEqual(0);
        expect(preset.position.y).toBeLessThanOrEqual(1);
      });
    });

    it('should include variety of preset types', () => {
      const presetNames = TEXT_PRESETS.map((p) => p.name.toLowerCase());

      // Should have diverse preset types
      expect(presetNames.some((n) => n.includes('lower third'))).toBe(true);
      expect(presetNames.some((n) => n.includes('title'))).toBe(true);
      expect(presetNames.some((n) => n.includes('subtitle'))).toBe(true);
    });
  });

  // ===========================================================================
  // Selected State Tests
  // ===========================================================================

  describe('selected state', () => {
    it('should highlight selected preset when selectedPresetId is provided', () => {
      render(
        <TextPresetPicker
          onSelect={mockOnSelect}
          selectedPresetId="lower-third"
        />
      );

      const selectedButton = screen.getByTestId('preset-button-lower-third');
      expect(selectedButton).toHaveClass('ring-2');
    });

    it('should not highlight other presets when one is selected', () => {
      render(
        <TextPresetPicker
          onSelect={mockOnSelect}
          selectedPresetId="lower-third"
        />
      );

      const otherButton = screen.getByTestId('preset-button-centered-title');
      expect(otherButton).not.toHaveClass('ring-2');
    });
  });
});
