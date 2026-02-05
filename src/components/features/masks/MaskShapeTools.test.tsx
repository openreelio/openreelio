/**
 * MaskShapeTools Component Tests
 *
 * TDD: RED phase - Writing tests first
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MaskShapeTools } from './MaskShapeTools';

describe('MaskShapeTools', () => {
  const mockOnToolChange = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ===========================================================================
  // Rendering Tests
  // ===========================================================================

  describe('rendering', () => {
    it('should render all tool buttons', () => {
      render(
        <MaskShapeTools activeTool="rectangle" onToolChange={mockOnToolChange} />
      );

      expect(screen.getByRole('button', { name: /select/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /rectangle/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /ellipse/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /polygon/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /bezier/i })).toBeInTheDocument();
    });

    it('should render with testid', () => {
      render(
        <MaskShapeTools activeTool="rectangle" onToolChange={mockOnToolChange} />
      );

      expect(screen.getByTestId('mask-shape-tools')).toBeInTheDocument();
    });

    it('should highlight active tool', () => {
      render(
        <MaskShapeTools activeTool="ellipse" onToolChange={mockOnToolChange} />
      );

      const ellipseButton = screen.getByRole('button', { name: /ellipse/i });
      expect(ellipseButton).toHaveClass('bg-blue-600');
    });

    it('should apply custom className', () => {
      render(
        <MaskShapeTools
          activeTool="rectangle"
          onToolChange={mockOnToolChange}
          className="custom-class"
        />
      );

      expect(screen.getByTestId('mask-shape-tools')).toHaveClass('custom-class');
    });
  });

  // ===========================================================================
  // Interaction Tests
  // ===========================================================================

  describe('interactions', () => {
    it('should call onToolChange when clicking select', () => {
      render(
        <MaskShapeTools activeTool="rectangle" onToolChange={mockOnToolChange} />
      );

      fireEvent.click(screen.getByRole('button', { name: /select/i }));
      expect(mockOnToolChange).toHaveBeenCalledWith('select');
    });

    it('should call onToolChange when clicking rectangle', () => {
      render(
        <MaskShapeTools activeTool="select" onToolChange={mockOnToolChange} />
      );

      fireEvent.click(screen.getByRole('button', { name: /rectangle/i }));
      expect(mockOnToolChange).toHaveBeenCalledWith('rectangle');
    });

    it('should call onToolChange when clicking ellipse', () => {
      render(
        <MaskShapeTools activeTool="rectangle" onToolChange={mockOnToolChange} />
      );

      fireEvent.click(screen.getByRole('button', { name: /ellipse/i }));
      expect(mockOnToolChange).toHaveBeenCalledWith('ellipse');
    });

    it('should call onToolChange when clicking polygon', () => {
      render(
        <MaskShapeTools activeTool="rectangle" onToolChange={mockOnToolChange} />
      );

      fireEvent.click(screen.getByRole('button', { name: /polygon/i }));
      expect(mockOnToolChange).toHaveBeenCalledWith('polygon');
    });

    it('should call onToolChange when clicking bezier', () => {
      render(
        <MaskShapeTools activeTool="rectangle" onToolChange={mockOnToolChange} />
      );

      fireEvent.click(screen.getByRole('button', { name: /bezier/i }));
      expect(mockOnToolChange).toHaveBeenCalledWith('bezier');
    });
  });

  // ===========================================================================
  // Disabled State Tests
  // ===========================================================================

  describe('disabled state', () => {
    it('should disable all buttons when disabled prop is true', () => {
      render(
        <MaskShapeTools
          activeTool="rectangle"
          onToolChange={mockOnToolChange}
          disabled
        />
      );

      const buttons = screen.getAllByRole('button');
      buttons.forEach((button) => {
        expect(button).toBeDisabled();
      });
    });

    it('should not call onToolChange when disabled', () => {
      render(
        <MaskShapeTools
          activeTool="rectangle"
          onToolChange={mockOnToolChange}
          disabled
        />
      );

      fireEvent.click(screen.getByRole('button', { name: /ellipse/i }));
      expect(mockOnToolChange).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Compact Mode Tests
  // ===========================================================================

  describe('compact mode', () => {
    it('should render in compact mode', () => {
      render(
        <MaskShapeTools
          activeTool="rectangle"
          onToolChange={mockOnToolChange}
          compact
        />
      );

      // In compact mode, buttons should be smaller
      const toolContainer = screen.getByTestId('mask-shape-tools');
      expect(toolContainer).toHaveClass('gap-0.5');
    });
  });

  // ===========================================================================
  // Keyboard Support Tests
  // ===========================================================================

  describe('keyboard support', () => {
    it('should support keyboard navigation', () => {
      render(
        <MaskShapeTools activeTool="rectangle" onToolChange={mockOnToolChange} />
      );

      const selectButton = screen.getByRole('button', { name: /select/i });
      selectButton.focus();
      expect(document.activeElement).toBe(selectButton);
    });
  });

  // ===========================================================================
  // Tool Icons Tests
  // ===========================================================================

  describe('tool icons', () => {
    it('should render appropriate icons for each tool', () => {
      render(
        <MaskShapeTools activeTool="rectangle" onToolChange={mockOnToolChange} />
      );

      // Each button should contain an SVG icon
      const buttons = screen.getAllByRole('button');
      buttons.forEach((button) => {
        expect(button.querySelector('svg')).toBeInTheDocument();
      });
    });
  });

  // ===========================================================================
  // Orientation Tests
  // ===========================================================================

  describe('orientation', () => {
    it('should render horizontally by default', () => {
      render(
        <MaskShapeTools activeTool="rectangle" onToolChange={mockOnToolChange} />
      );

      expect(screen.getByTestId('mask-shape-tools')).toHaveClass('flex-row');
    });

    it('should render vertically when orientation is vertical', () => {
      render(
        <MaskShapeTools
          activeTool="rectangle"
          onToolChange={mockOnToolChange}
          orientation="vertical"
        />
      );

      expect(screen.getByTestId('mask-shape-tools')).toHaveClass('flex-col');
    });
  });
});
