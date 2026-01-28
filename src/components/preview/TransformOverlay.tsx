/**
 * TransformOverlay Component
 *
 * Visual overlay for clip transforms in the preview canvas.
 * Shows resize handles at corners and edges for interactive resizing.
 * Supports drag to move, drag handles to resize, and rotation.
 */

import { memo, useCallback, useRef, useState, useEffect, useMemo } from 'react';
import { useProjectStore } from '@/stores/projectStore';
import { useTimelineStore } from '@/stores/timelineStore';
import type { Asset, Transform, Sequence } from '@/types';

// =============================================================================
// Types
// =============================================================================

export interface TransformOverlayProps {
  /** The sequence being displayed */
  sequence: Sequence | null;
  /** Assets map for looking up video dimensions */
  assets: Map<string, Asset>;
  /** Canvas width in pixels */
  canvasWidth: number;
  /** Canvas height in pixels */
  canvasHeight: number;
  /** Container width in pixels */
  containerWidth: number;
  /** Container height in pixels */
  containerHeight: number;
  /** Current display scale (from zoom) */
  displayScale: number;
  /** Pan offset X */
  panX: number;
  /** Pan offset Y */
  panY: number;
  /** Additional CSS classes */
  className?: string;
}

type HandlePosition =
  | 'top-left'
  | 'top'
  | 'top-right'
  | 'right'
  | 'bottom-right'
  | 'bottom'
  | 'bottom-left'
  | 'left';

interface DragState {
  type: 'move' | 'resize' | 'rotate';
  handle?: HandlePosition;
  startX: number;
  startY: number;
  startTransform: Transform;
}

// =============================================================================
// Constants
// =============================================================================

const HANDLE_SIZE = 10;
const HANDLE_OFFSET = HANDLE_SIZE / 2;

// =============================================================================
// Component
// =============================================================================

export const TransformOverlay = memo(function TransformOverlay({
  sequence,
  assets,
  canvasWidth,
  canvasHeight,
  containerWidth,
  containerHeight,
  displayScale,
  panX,
  panY,
  className = '',
}: TransformOverlayProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const [dragState, setDragState] = useState<DragState | null>(null);
  const [previewTransform, setPreviewTransform] = useState<Transform | null>(null);

  // Store selectors
  const selectedClipIds = useTimelineStore((state) => state.selectedClipIds);
  const executeCommand = useProjectStore((state) => state.executeCommand);

  // Get the first selected clip (only support single selection for transform)
  const selectedClip = useMemo(() => {
    if (selectedClipIds.length !== 1 || !sequence) return null;

    const clipId = selectedClipIds[0];
    for (const track of sequence.tracks) {
      const clip = track.clips.find((c) => c.id === clipId);
      if (clip) {
        return { clip, trackId: track.id };
      }
    }
    return null;
  }, [selectedClipIds, sequence]);

  // Calculate clip bounds in container coordinates
  const clipBounds = useMemo(() => {
    if (!selectedClip) return null;

    const { clip } = selectedClip;
    const asset = assets.get(clip.assetId);

    // Get video dimensions from asset, fallback to canvas dimensions
    const videoWidth = asset?.video?.width ?? canvasWidth;
    const videoHeight = asset?.video?.height ?? canvasHeight;

    const transform = previewTransform ??
      clip.transform ?? {
        position: { x: 0.5, y: 0.5 },
        scale: { x: 1.0, y: 1.0 },
        rotationDeg: 0,
        anchor: { x: 0.5, y: 0.5 },
      };

    // Calculate base scale to fit video within canvas (maintaining aspect ratio)
    const videoAspect = videoWidth / videoHeight;
    const canvasAspect = canvasWidth / canvasHeight;

    let baseScale: number;
    if (videoAspect > canvasAspect) {
      // Video is wider - fit to width
      baseScale = canvasWidth / videoWidth;
    } else {
      // Video is taller - fit to height
      baseScale = canvasHeight / videoHeight;
    }

    // Calculate the fitted video size (before clip transform)
    const fittedWidth = videoWidth * baseScale;
    const fittedHeight = videoHeight * baseScale;

    // Apply clip's additional scale transform
    const clipWidth = fittedWidth * transform.scale.x;
    const clipHeight = fittedHeight * transform.scale.y;

    // Position is normalized (0.5, 0.5 = center of canvas)
    // Calculate the center position in canvas coordinates
    const centerX = transform.position.x * canvasWidth;
    const centerY = transform.position.y * canvasHeight;

    // Calculate top-left corner based on anchor point
    const left = centerX - clipWidth * transform.anchor.x;
    const top = centerY - clipHeight * transform.anchor.y;

    // Convert to container coordinates with zoom and pan
    const containerCenterX = containerWidth / 2;
    const containerCenterY = containerHeight / 2;

    const scaledLeft = containerCenterX + (left - canvasWidth / 2) * displayScale + panX;
    const scaledTop = containerCenterY + (top - canvasHeight / 2) * displayScale + panY;
    const scaledWidth = clipWidth * displayScale;
    const scaledHeight = clipHeight * displayScale;

    return {
      left: scaledLeft,
      top: scaledTop,
      width: scaledWidth,
      height: scaledHeight,
      rotation: transform.rotationDeg,
      centerX: scaledLeft + scaledWidth / 2,
      centerY: scaledTop + scaledHeight / 2,
    };
  }, [
    selectedClip,
    previewTransform,
    assets,
    canvasWidth,
    canvasHeight,
    containerWidth,
    containerHeight,
    displayScale,
    panX,
    panY,
  ]);

  // Handle positions relative to bounds
  const handlePositions = useMemo(() => {
    if (!clipBounds) return null;

    const { width, height } = clipBounds;

    return {
      'top-left': { x: 0, y: 0 },
      top: { x: width / 2, y: 0 },
      'top-right': { x: width, y: 0 },
      right: { x: width, y: height / 2 },
      'bottom-right': { x: width, y: height },
      bottom: { x: width / 2, y: height },
      'bottom-left': { x: 0, y: height },
      left: { x: 0, y: height / 2 },
    };
  }, [clipBounds]);

  // Start dragging
  const handleMouseDown = useCallback(
    (e: React.MouseEvent, type: 'move' | 'resize' | 'rotate', handle?: HandlePosition) => {
      e.stopPropagation();
      e.preventDefault();

      if (!selectedClip) return;

      const transform = selectedClip.clip.transform ?? {
        position: { x: 0.5, y: 0.5 },
        scale: { x: 1.0, y: 1.0 },
        rotationDeg: 0,
        anchor: { x: 0.5, y: 0.5 },
      };

      setDragState({
        type,
        handle,
        startX: e.clientX,
        startY: e.clientY,
        startTransform: { ...transform },
      });
      setPreviewTransform({ ...transform });
    },
    [selectedClip],
  );

  // Handle drag
  useEffect(() => {
    if (!dragState || !selectedClip || !sequence) return;

    const handleMouseMove = (e: MouseEvent) => {
      // Defensive: avoid division by zero and invalid math.
      if (!Number.isFinite(displayScale) || displayScale <= 0) return;
      if (!Number.isFinite(canvasWidth) || canvasWidth <= 0) return;
      if (!Number.isFinite(canvasHeight) || canvasHeight <= 0) return;

      const deltaX = e.clientX - dragState.startX;
      const deltaY = e.clientY - dragState.startY;

      // Convert pixel delta to canvas-relative delta
      const canvasDeltaX = deltaX / displayScale / canvasWidth;
      const canvasDeltaY = deltaY / displayScale / canvasHeight;

      let transformPatch: Partial<Transform> = {};

      if (dragState.type === 'move') {
        // Move: update position
        transformPatch = {
          position: {
            x: Math.max(0, Math.min(1, dragState.startTransform.position.x + canvasDeltaX)),
            y: Math.max(0, Math.min(1, dragState.startTransform.position.y + canvasDeltaY)),
          },
        };
      } else if (dragState.type === 'resize' && dragState.handle) {
        // Resize: update scale based on handle
        const handle = dragState.handle;
        let scaleX = dragState.startTransform.scale.x;
        let scaleY = dragState.startTransform.scale.y;

        const scaleDeltaX = (deltaX / displayScale / canvasWidth) * 2;
        const scaleDeltaY = (deltaY / displayScale / canvasHeight) * 2;

        // Apply scale based on which handle is being dragged
        if (handle.includes('right')) {
          scaleX = Math.max(0.1, dragState.startTransform.scale.x + scaleDeltaX);
        } else if (handle.includes('left')) {
          scaleX = Math.max(0.1, dragState.startTransform.scale.x - scaleDeltaX);
        }

        if (handle.includes('bottom')) {
          scaleY = Math.max(0.1, dragState.startTransform.scale.y + scaleDeltaY);
        } else if (handle.includes('top')) {
          scaleY = Math.max(0.1, dragState.startTransform.scale.y - scaleDeltaY);
        }

        // Corner handles: maintain aspect ratio if shift is held
        if (
          e.shiftKey &&
          (handle === 'top-left' ||
            handle === 'top-right' ||
            handle === 'bottom-left' ||
            handle === 'bottom-right')
        ) {
          const aspectRatio = dragState.startTransform.scale.x / dragState.startTransform.scale.y;
          const avgScale = (scaleX + scaleY * aspectRatio) / 2;
          scaleX = avgScale;
          scaleY = avgScale / aspectRatio;
        }

        transformPatch = {
          scale: { x: scaleX, y: scaleY },
        };
      }

      const nextTransform: Transform = {
        ...dragState.startTransform,
        ...(transformPatch.position ? { position: transformPatch.position } : {}),
        ...(transformPatch.scale ? { scale: transformPatch.scale } : {}),
      };

      setPreviewTransform(nextTransform);
    };

    const handleMouseUp = () => {
      // Commit transform once at the end of interaction to avoid spamming the ops log.
      if (previewTransform) {
        void executeCommand({
          type: 'SetClipTransform',
          payload: {
            sequenceId: sequence.id,
            trackId: selectedClip.trackId,
            clipId: selectedClip.clip.id,
            transform: previewTransform,
          },
        });
      }
      setDragState(null);
      setPreviewTransform(null);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [
    dragState,
    selectedClip,
    sequence,
    previewTransform,
    displayScale,
    canvasWidth,
    canvasHeight,
    executeCommand,
  ]);

  // Don't render if no clip is selected or no bounds
  if (!selectedClip || !clipBounds || !handlePositions) {
    return null;
  }

  const getCursor = (handle: HandlePosition): string => {
    switch (handle) {
      case 'top-left':
      case 'bottom-right':
        return 'nwse-resize';
      case 'top-right':
      case 'bottom-left':
        return 'nesw-resize';
      case 'top':
      case 'bottom':
        return 'ns-resize';
      case 'left':
      case 'right':
        return 'ew-resize';
      default:
        return 'default';
    }
  };

  return (
    <div
      ref={overlayRef}
      className={`absolute inset-0 pointer-events-none ${className}`}
      data-testid="transform-overlay"
    >
      {/* Bounding box */}
      <div
        className="absolute border-2 border-blue-500 pointer-events-auto"
        style={{
          left: clipBounds.left,
          top: clipBounds.top,
          width: clipBounds.width,
          height: clipBounds.height,
          transform: `rotate(${clipBounds.rotation}deg)`,
          transformOrigin: 'center center',
          cursor: dragState?.type === 'move' ? 'grabbing' : 'grab',
        }}
        onMouseDown={(e) => handleMouseDown(e, 'move')}
        data-testid="transform-bounds"
      >
        {/* Resize handles */}
        {Object.entries(handlePositions).map(([position, coords]) => (
          <div
            key={position}
            className="absolute bg-white border-2 border-blue-500 pointer-events-auto"
            style={{
              left: coords.x - HANDLE_OFFSET,
              top: coords.y - HANDLE_OFFSET,
              width: HANDLE_SIZE,
              height: HANDLE_SIZE,
              cursor: getCursor(position as HandlePosition),
            }}
            onMouseDown={(e) => handleMouseDown(e, 'resize', position as HandlePosition)}
            data-testid={`transform-handle-${position}`}
          />
        ))}
      </div>

      {/* Info display */}
      <div
        className="absolute bg-black/70 text-white text-xs px-2 py-1 rounded pointer-events-none"
        style={{
          left: clipBounds.left,
          top: clipBounds.top - 24,
        }}
      >
        {Math.round(((previewTransform ?? selectedClip.clip.transform)?.scale.x ?? 1) * 100)}% x{' '}
        {Math.round(((previewTransform ?? selectedClip.clip.transform)?.scale.y ?? 1) * 100)}%
      </div>
    </div>
  );
});
