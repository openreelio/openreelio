/**
 * ResizeHandle Component
 *
 * A draggable divider between dock zones that allows resizing.
 * Supports both horizontal (left-right) and vertical (top-bottom) orientations.
 */

import { useCallback, useRef } from 'react';

// =============================================================================
// Types
// =============================================================================

export interface ResizeHandleProps {
  /** Orientation: 'horizontal' resizes left-right, 'vertical' resizes top-bottom */
  orientation: 'horizontal' | 'vertical';
  /** Called continuously during drag with the delta in pixels */
  onResize: (delta: number) => void;
  /** Called when drag ends */
  onResizeEnd?: () => void;
  /** Additional CSS classes */
  className?: string;
  /** Accessible label */
  'aria-label'?: string;
}

// =============================================================================
// Component
// =============================================================================

export function ResizeHandle({
  orientation,
  onResize,
  onResizeEnd,
  className = '',
  'aria-label': ariaLabel,
}: ResizeHandleProps): JSX.Element {
  const isDragging = useRef(false);
  const lastPosition = useRef(0);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();

      isDragging.current = true;
      lastPosition.current = orientation === 'horizontal' ? e.clientX : e.clientY;

      const target = e.currentTarget as HTMLElement;
      target.setPointerCapture(e.pointerId);

      const handlePointerMove = (moveEvent: PointerEvent): void => {
        if (!isDragging.current) return;

        const currentPos =
          orientation === 'horizontal' ? moveEvent.clientX : moveEvent.clientY;
        const delta = currentPos - lastPosition.current;

        if (delta !== 0) {
          onResize(delta);
          lastPosition.current = currentPos;
        }
      };

      const handlePointerUp = (): void => {
        isDragging.current = false;
        onResizeEnd?.();
        document.removeEventListener('pointermove', handlePointerMove);
        document.removeEventListener('pointerup', handlePointerUp);
      };

      document.addEventListener('pointermove', handlePointerMove);
      document.addEventListener('pointerup', handlePointerUp);
    },
    [onResize, onResizeEnd, orientation],
  );

  const KEYBOARD_STEP = 4;

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const isHoriz = orientation === 'horizontal';
      let delta = 0;

      if (isHoriz && e.key === 'ArrowRight') delta = KEYBOARD_STEP;
      else if (isHoriz && e.key === 'ArrowLeft') delta = -KEYBOARD_STEP;
      else if (!isHoriz && e.key === 'ArrowDown') delta = KEYBOARD_STEP;
      else if (!isHoriz && e.key === 'ArrowUp') delta = -KEYBOARD_STEP;

      if (delta !== 0) {
        e.preventDefault();
        onResize(e.shiftKey ? delta * 4 : delta);
      }
    },
    [onResize, orientation],
  );

  const isHorizontal = orientation === 'horizontal';

  const baseClasses = isHorizontal
    ? 'w-1 cursor-col-resize hover:bg-primary-500/40 active:bg-primary-500/60'
    : 'h-1 cursor-row-resize hover:bg-primary-500/40 active:bg-primary-500/60';

  return (
    <div
      data-testid={`resize-handle-${orientation}`}
      className={`${baseClasses} shrink-0 bg-transparent transition-colors duration-100 ${className}`}
      onPointerDown={handlePointerDown}
      onKeyDown={handleKeyDown}
      role="separator"
      aria-orientation={isHorizontal ? 'vertical' : 'horizontal'}
      aria-label={ariaLabel ?? `Resize ${orientation === 'horizontal' ? 'width' : 'height'}`}
      tabIndex={0}
    />
  );
}
