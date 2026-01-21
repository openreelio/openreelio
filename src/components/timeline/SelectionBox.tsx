/**
 * SelectionBox Component
 *
 * Renders the visual selection rectangle for drag-to-select functionality.
 */

import type { SelectionRect } from '@/hooks/useSelectionBox';

// =============================================================================
// Types
// =============================================================================

interface SelectionBoxProps {
  /** The selection rectangle to render */
  rect: SelectionRect | null;
  /** Whether the selection is currently active */
  isActive: boolean;
}

// =============================================================================
// Component
// =============================================================================

export function SelectionBox({ rect, isActive }: SelectionBoxProps): JSX.Element | null {
  if (!isActive || !rect || rect.width < 2 || rect.height < 2) {
    return null;
  }

  return (
    <div
      data-testid="selection-box"
      className="absolute pointer-events-none border-2 border-primary-400 bg-primary-400/20 z-30"
      style={{
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      }}
    />
  );
}
