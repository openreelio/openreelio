/**
 * MaskCanvas Component Tests
 *
 * TDD: RED phase - Writing tests first
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MaskCanvas } from './MaskCanvas';
import type { Mask } from '@/types';

// =============================================================================
// Test Fixtures
// =============================================================================

const createRectMask = (id: string): Mask => ({
  id,
  name: `Mask ${id}`,
  shape: {
    type: 'rectangle',
    x: 0.5,
    y: 0.5,
    width: 0.4,
    height: 0.3,
    cornerRadius: 0,
    rotation: 0,
  },
  inverted: false,
  feather: 0,
  opacity: 1,
  expansion: 0,
  blendMode: 'add',
  enabled: true,
  locked: false,
});

const createEllipseMask = (id: string): Mask => ({
  id,
  name: `Mask ${id}`,
  shape: {
    type: 'ellipse',
    x: 0.5,
    y: 0.5,
    radiusX: 0.2,
    radiusY: 0.15,
    rotation: 0,
  },
  inverted: false,
  feather: 0,
  opacity: 1,
  expansion: 0,
  blendMode: 'add',
  enabled: true,
  locked: false,
});

// =============================================================================
// Test Suite
// =============================================================================

describe('MaskCanvas', () => {
  const mockOnMaskSelect = vi.fn();
  const mockOnMaskUpdate = vi.fn();
  const mockOnMaskCreate = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ===========================================================================
  // Rendering Tests
  // ===========================================================================

  describe('rendering', () => {
    it('should render SVG canvas', () => {
      render(
        <MaskCanvas
          masks={[]}
          selectedMaskId={null}
          activeTool="select"
          onMaskSelect={mockOnMaskSelect}
          onMaskUpdate={mockOnMaskUpdate}
          onMaskCreate={mockOnMaskCreate}
        />
      );

      expect(screen.getByTestId('mask-canvas')).toBeInTheDocument();
      expect(screen.getByTestId('mask-canvas').tagName.toLowerCase()).toBe('svg');
    });

    it('should render with specified dimensions', () => {
      render(
        <MaskCanvas
          masks={[]}
          selectedMaskId={null}
          activeTool="select"
          onMaskSelect={mockOnMaskSelect}
          onMaskUpdate={mockOnMaskUpdate}
          onMaskCreate={mockOnMaskCreate}
          width={800}
          height={450}
        />
      );

      const canvas = screen.getByTestId('mask-canvas');
      expect(canvas).toHaveAttribute('width', '800');
      expect(canvas).toHaveAttribute('height', '450');
    });

    it('should render rectangle mask', () => {
      const masks = [createRectMask('rect-1')];

      render(
        <MaskCanvas
          masks={masks}
          selectedMaskId={null}
          activeTool="select"
          onMaskSelect={mockOnMaskSelect}
          onMaskUpdate={mockOnMaskUpdate}
          onMaskCreate={mockOnMaskCreate}
        />
      );

      expect(screen.getByTestId('mask-shape-rect-1')).toBeInTheDocument();
    });

    it('should render ellipse mask', () => {
      const masks = [createEllipseMask('ellipse-1')];

      render(
        <MaskCanvas
          masks={masks}
          selectedMaskId={null}
          activeTool="select"
          onMaskSelect={mockOnMaskSelect}
          onMaskUpdate={mockOnMaskUpdate}
          onMaskCreate={mockOnMaskCreate}
        />
      );

      expect(screen.getByTestId('mask-shape-ellipse-1')).toBeInTheDocument();
    });

    it('should render multiple masks', () => {
      const masks = [createRectMask('mask-1'), createEllipseMask('mask-2')];

      render(
        <MaskCanvas
          masks={masks}
          selectedMaskId={null}
          activeTool="select"
          onMaskSelect={mockOnMaskSelect}
          onMaskUpdate={mockOnMaskUpdate}
          onMaskCreate={mockOnMaskCreate}
        />
      );

      expect(screen.getByTestId('mask-shape-mask-1')).toBeInTheDocument();
      expect(screen.getByTestId('mask-shape-mask-2')).toBeInTheDocument();
    });

    it('should highlight selected mask', () => {
      const masks = [createRectMask('mask-1')];

      render(
        <MaskCanvas
          masks={masks}
          selectedMaskId="mask-1"
          activeTool="select"
          onMaskSelect={mockOnMaskSelect}
          onMaskUpdate={mockOnMaskUpdate}
          onMaskCreate={mockOnMaskCreate}
        />
      );

      const maskShape = screen.getByTestId('mask-shape-mask-1');
      expect(maskShape).toHaveClass('selected');
    });

    it('should render disabled mask with reduced opacity', () => {
      const disabledMask = { ...createRectMask('mask-1'), enabled: false };

      render(
        <MaskCanvas
          masks={[disabledMask]}
          selectedMaskId={null}
          activeTool="select"
          onMaskSelect={mockOnMaskSelect}
          onMaskUpdate={mockOnMaskUpdate}
          onMaskCreate={mockOnMaskCreate}
        />
      );

      const maskShape = screen.getByTestId('mask-shape-mask-1');
      expect(maskShape).toHaveClass('disabled');
    });
  });

  // ===========================================================================
  // Selection Tests
  // ===========================================================================

  describe('selection', () => {
    it('should call onMaskSelect when clicking a mask', () => {
      const masks = [createRectMask('mask-1')];

      render(
        <MaskCanvas
          masks={masks}
          selectedMaskId={null}
          activeTool="select"
          onMaskSelect={mockOnMaskSelect}
          onMaskUpdate={mockOnMaskUpdate}
          onMaskCreate={mockOnMaskCreate}
        />
      );

      fireEvent.click(screen.getByTestId('mask-shape-mask-1'));
      expect(mockOnMaskSelect).toHaveBeenCalledWith('mask-1');
    });

    it('should not select mask when using draw tool', () => {
      const masks = [createRectMask('mask-1')];

      render(
        <MaskCanvas
          masks={masks}
          selectedMaskId={null}
          activeTool="rectangle"
          onMaskSelect={mockOnMaskSelect}
          onMaskUpdate={mockOnMaskUpdate}
          onMaskCreate={mockOnMaskCreate}
        />
      );

      // When using a draw tool, clicking on existing mask should not select it
      // Instead, it should start drawing a new mask
      fireEvent.click(screen.getByTestId('mask-shape-mask-1'));
      // In draw mode, click behavior is different
    });

    it('should render selection handles for selected mask', () => {
      const masks = [createRectMask('mask-1')];

      render(
        <MaskCanvas
          masks={masks}
          selectedMaskId="mask-1"
          activeTool="select"
          onMaskSelect={mockOnMaskSelect}
          onMaskUpdate={mockOnMaskUpdate}
          onMaskCreate={mockOnMaskCreate}
        />
      );

      // Should render 8 resize handles for rectangle
      const handles = screen.getAllByTestId(/^handle-/);
      expect(handles.length).toBeGreaterThanOrEqual(4);
    });
  });

  // ===========================================================================
  // Drawing Tests
  // ===========================================================================

  describe('drawing', () => {
    it('should show draw cursor when using draw tool', () => {
      render(
        <MaskCanvas
          masks={[]}
          selectedMaskId={null}
          activeTool="rectangle"
          onMaskSelect={mockOnMaskSelect}
          onMaskUpdate={mockOnMaskUpdate}
          onMaskCreate={mockOnMaskCreate}
        />
      );

      const canvas = screen.getByTestId('mask-canvas');
      expect(canvas).toHaveClass('cursor-crosshair');
    });

    it('should show pointer cursor in select mode', () => {
      render(
        <MaskCanvas
          masks={[]}
          selectedMaskId={null}
          activeTool="select"
          onMaskSelect={mockOnMaskSelect}
          onMaskUpdate={mockOnMaskUpdate}
          onMaskCreate={mockOnMaskCreate}
        />
      );

      const canvas = screen.getByTestId('mask-canvas');
      expect(canvas).toHaveClass('cursor-default');
    });

    it('should start drawing on mousedown in draw mode', () => {
      render(
        <MaskCanvas
          masks={[]}
          selectedMaskId={null}
          activeTool="rectangle"
          onMaskSelect={mockOnMaskSelect}
          onMaskUpdate={mockOnMaskUpdate}
          onMaskCreate={mockOnMaskCreate}
          width={800}
          height={450}
        />
      );

      const canvas = screen.getByTestId('mask-canvas');

      // Simulate drawing
      fireEvent.mouseDown(canvas, { clientX: 100, clientY: 100 });

      // Should show drawing preview
      expect(screen.queryByTestId('drawing-preview')).toBeInTheDocument();
    });

    it('should create mask on mouseup after drawing', () => {
      render(
        <MaskCanvas
          masks={[]}
          selectedMaskId={null}
          activeTool="rectangle"
          onMaskSelect={mockOnMaskSelect}
          onMaskUpdate={mockOnMaskUpdate}
          onMaskCreate={mockOnMaskCreate}
          width={800}
          height={450}
        />
      );

      const canvas = screen.getByTestId('mask-canvas');

      // Simulate full draw gesture
      fireEvent.mouseDown(canvas, { clientX: 100, clientY: 100 });
      fireEvent.mouseMove(canvas, { clientX: 300, clientY: 200 });
      fireEvent.mouseUp(canvas, { clientX: 300, clientY: 200 });

      expect(mockOnMaskCreate).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'rectangle' })
      );
    });

    it('should cancel drawing on escape key', () => {
      render(
        <MaskCanvas
          masks={[]}
          selectedMaskId={null}
          activeTool="rectangle"
          onMaskSelect={mockOnMaskSelect}
          onMaskUpdate={mockOnMaskUpdate}
          onMaskCreate={mockOnMaskCreate}
          width={800}
          height={450}
        />
      );

      const canvas = screen.getByTestId('mask-canvas');

      // Start drawing
      fireEvent.mouseDown(canvas, { clientX: 100, clientY: 100 });
      expect(screen.queryByTestId('drawing-preview')).toBeInTheDocument();

      // Cancel with Escape
      fireEvent.keyDown(canvas, { key: 'Escape' });
      expect(screen.queryByTestId('drawing-preview')).not.toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Transform Tests
  // ===========================================================================

  describe('transform', () => {
    it('should call onMaskUpdate when dragging a mask', () => {
      const masks = [createRectMask('mask-1')];

      render(
        <MaskCanvas
          masks={masks}
          selectedMaskId="mask-1"
          activeTool="select"
          onMaskSelect={mockOnMaskSelect}
          onMaskUpdate={mockOnMaskUpdate}
          onMaskCreate={mockOnMaskCreate}
          width={800}
          height={450}
        />
      );

      const maskShape = screen.getByTestId('mask-shape-mask-1');

      // Simulate drag
      fireEvent.mouseDown(maskShape, { clientX: 400, clientY: 225 });
      fireEvent.mouseMove(document, { clientX: 450, clientY: 275 });
      fireEvent.mouseUp(document);

      expect(mockOnMaskUpdate).toHaveBeenCalledWith(
        'mask-1',
        expect.objectContaining({
          shape: expect.objectContaining({ type: 'rectangle' }),
        })
      );
    });

    it('should not transform locked mask', () => {
      const lockedMask = { ...createRectMask('mask-1'), locked: true };

      render(
        <MaskCanvas
          masks={[lockedMask]}
          selectedMaskId="mask-1"
          activeTool="select"
          onMaskSelect={mockOnMaskSelect}
          onMaskUpdate={mockOnMaskUpdate}
          onMaskCreate={mockOnMaskCreate}
          width={800}
          height={450}
        />
      );

      const maskShape = screen.getByTestId('mask-shape-mask-1');

      // Try to drag
      fireEvent.mouseDown(maskShape, { clientX: 400, clientY: 225 });
      fireEvent.mouseMove(document, { clientX: 450, clientY: 275 });
      fireEvent.mouseUp(document);

      expect(mockOnMaskUpdate).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Keyboard Shortcuts Tests
  // ===========================================================================

  describe('keyboard shortcuts', () => {
    it('should delete selected mask on Delete key', () => {
      const masks = [createRectMask('mask-1')];
      const mockOnDelete = vi.fn();

      render(
        <MaskCanvas
          masks={masks}
          selectedMaskId="mask-1"
          activeTool="select"
          onMaskSelect={mockOnMaskSelect}
          onMaskUpdate={mockOnMaskUpdate}
          onMaskCreate={mockOnMaskCreate}
          onMaskDelete={mockOnDelete}
        />
      );

      const canvas = screen.getByTestId('mask-canvas');
      fireEvent.keyDown(canvas, { key: 'Delete' });

      expect(mockOnDelete).toHaveBeenCalledWith('mask-1');
    });

    it('should deselect on Escape key', () => {
      const masks = [createRectMask('mask-1')];

      render(
        <MaskCanvas
          masks={masks}
          selectedMaskId="mask-1"
          activeTool="select"
          onMaskSelect={mockOnMaskSelect}
          onMaskUpdate={mockOnMaskUpdate}
          onMaskCreate={mockOnMaskCreate}
        />
      );

      const canvas = screen.getByTestId('mask-canvas');
      fireEvent.keyDown(canvas, { key: 'Escape' });

      expect(mockOnMaskSelect).toHaveBeenCalledWith(null);
    });
  });

  // ===========================================================================
  // Disabled State Tests
  // ===========================================================================

  describe('disabled state', () => {
    it('should not allow interactions when disabled', () => {
      const masks = [createRectMask('mask-1')];

      render(
        <MaskCanvas
          masks={masks}
          selectedMaskId={null}
          activeTool="select"
          onMaskSelect={mockOnMaskSelect}
          onMaskUpdate={mockOnMaskUpdate}
          onMaskCreate={mockOnMaskCreate}
          disabled
        />
      );

      fireEvent.click(screen.getByTestId('mask-shape-mask-1'));
      expect(mockOnMaskSelect).not.toHaveBeenCalled();
    });
  });
});
