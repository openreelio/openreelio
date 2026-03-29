/**
 * ResizeHandle Component Tests
 *
 * BDD-style tests for the draggable resize divider.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ResizeHandle } from './ResizeHandle';

describe('ResizeHandle', () => {
  describe('rendering', () => {
    it('should render horizontal handle as accessible separator', () => {
      render(<ResizeHandle orientation="horizontal" onResize={vi.fn()} />);
      const handle = screen.getByRole('separator');
      expect(handle).toBeInTheDocument();
      // Horizontal drag handle acts as a vertical divider per WAI-ARIA
      expect(handle).toHaveAttribute('aria-orientation', 'vertical');
    });

    it('should render vertical handle as accessible separator', () => {
      render(<ResizeHandle orientation="vertical" onResize={vi.fn()} />);
      const handle = screen.getByRole('separator');
      expect(handle).toBeInTheDocument();
      expect(handle).toHaveAttribute('aria-orientation', 'horizontal');
    });

    it('should use custom aria-label when provided', () => {
      render(
        <ResizeHandle
          orientation="horizontal"
          onResize={vi.fn()}
          aria-label="Resize left panel"
        />,
      );
      expect(screen.getByLabelText('Resize left panel')).toBeInTheDocument();
    });
  });

  describe('resize interaction', () => {
    it('should call onResize with delta during pointer drag', () => {
      const onResize = vi.fn();
      render(<ResizeHandle orientation="horizontal" onResize={onResize} />);
      const handle = screen.getByTestId('resize-handle-horizontal');

      // Start drag at x=100
      fireEvent.pointerDown(handle, { clientX: 100, clientY: 50, pointerId: 1 });

      // Move to x=120 (delta = 20)
      fireEvent(document, new PointerEvent('pointermove', { clientX: 120, clientY: 50 }));

      expect(onResize).toHaveBeenCalledWith(20);
    });

    it('should call onResizeEnd when pointer is released', () => {
      const onResizeEnd = vi.fn();
      render(
        <ResizeHandle
          orientation="horizontal"
          onResize={vi.fn()}
          onResizeEnd={onResizeEnd}
        />,
      );
      const handle = screen.getByTestId('resize-handle-horizontal');

      fireEvent.pointerDown(handle, { clientX: 100, clientY: 50, pointerId: 1 });
      fireEvent(document, new PointerEvent('pointerup', {}));

      expect(onResizeEnd).toHaveBeenCalledTimes(1);
    });

    it('should handle vertical orientation using clientY', () => {
      const onResize = vi.fn();
      render(<ResizeHandle orientation="vertical" onResize={onResize} />);
      const handle = screen.getByTestId('resize-handle-vertical');

      fireEvent.pointerDown(handle, { clientX: 50, clientY: 200, pointerId: 1 });
      fireEvent(document, new PointerEvent('pointermove', { clientX: 50, clientY: 230 }));

      expect(onResize).toHaveBeenCalledWith(30);
    });
  });

  describe('keyboard resize', () => {
    it('should resize on ArrowRight/ArrowLeft for horizontal handles', () => {
      const onResize = vi.fn();
      render(<ResizeHandle orientation="horizontal" onResize={onResize} />);
      const handle = screen.getByRole('separator');

      fireEvent.keyDown(handle, { key: 'ArrowRight' });
      expect(onResize).toHaveBeenCalledWith(4);

      onResize.mockClear();
      fireEvent.keyDown(handle, { key: 'ArrowLeft' });
      expect(onResize).toHaveBeenCalledWith(-4);
    });

    it('should resize on ArrowDown/ArrowUp for vertical handles', () => {
      const onResize = vi.fn();
      render(<ResizeHandle orientation="vertical" onResize={onResize} />);
      const handle = screen.getByRole('separator');

      fireEvent.keyDown(handle, { key: 'ArrowDown' });
      expect(onResize).toHaveBeenCalledWith(4);

      onResize.mockClear();
      fireEvent.keyDown(handle, { key: 'ArrowUp' });
      expect(onResize).toHaveBeenCalledWith(-4);
    });

    it('should multiply step by 4 when Shift is held', () => {
      const onResize = vi.fn();
      render(<ResizeHandle orientation="horizontal" onResize={onResize} />);
      const handle = screen.getByRole('separator');

      fireEvent.keyDown(handle, { key: 'ArrowRight', shiftKey: true });
      expect(onResize).toHaveBeenCalledWith(16);
    });
  });
});
