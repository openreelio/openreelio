/**
 * DragPreviewLayer Component
 *
 * Renders a ghost preview of clips being dragged on the timeline.
 * Shows the target position for clip move/trim operations.
 */

// =============================================================================
// Types
// =============================================================================

export interface DragPreviewState {
  /** ID of the clip being dragged */
  clipId: string;
  /** Left position in pixels */
  left: number;
  /** Width in pixels */
  width: number;
  /** Index of the target track */
  trackIndex: number;
}

interface DragPreviewLayerProps {
  /** Current drag preview state (null if not dragging) */
  dragPreview: DragPreviewState | null;
  /** Track header width in pixels */
  trackHeaderWidth: number;
  /** Track height in pixels */
  trackHeight: number;
  /** Horizontal scroll offset */
  scrollX: number;
}

// =============================================================================
// Component
// =============================================================================

/**
 * Renders a visual preview of where a clip will be placed during drag operations.
 *
 * @param props - Component props
 * @returns Drag preview element or null if not dragging
 *
 * @example
 * ```tsx
 * <DragPreviewLayer
 *   dragPreview={dragPreview}
 *   trackHeaderWidth={TRACK_HEADER_WIDTH}
 *   trackHeight={TRACK_HEIGHT}
 *   scrollX={scrollX}
 * />
 * ```
 */
export function DragPreviewLayer({
  dragPreview,
  trackHeaderWidth,
  trackHeight,
  scrollX,
}: DragPreviewLayerProps) {
  if (!dragPreview) {
    return null;
  }

  return (
    <div
      data-testid="drag-preview"
      className="absolute bg-primary-500/30 border-2 border-primary-500 border-dashed rounded pointer-events-none z-20"
      style={{
        left: `${trackHeaderWidth + dragPreview.left - scrollX}px`,
        top: `${dragPreview.trackIndex * trackHeight}px`,
        width: `${dragPreview.width}px`,
        height: `${trackHeight}px`,
      }}
    />
  );
}
