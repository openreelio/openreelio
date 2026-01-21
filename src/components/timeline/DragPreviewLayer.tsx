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
  /** Whether the drop target is valid (compatible track type) */
  isValidDrop?: boolean;
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

  // Determine visual style based on drop validity
  const isValid = dragPreview.isValidDrop !== false;
  const bgClass = isValid ? 'bg-primary-500/30' : 'bg-red-500/30';
  const borderClass = isValid ? 'border-primary-500' : 'border-red-500';

  return (
    <div
      data-testid="drag-preview"
      data-valid-drop={isValid}
      className={`absolute ${bgClass} border-2 ${borderClass} border-dashed rounded pointer-events-none z-20`}
      style={{
        left: `${trackHeaderWidth + dragPreview.left - scrollX}px`,
        top: `${dragPreview.trackIndex * trackHeight}px`,
        width: `${dragPreview.width}px`,
        height: `${trackHeight}px`,
      }}
    />
  );
}
