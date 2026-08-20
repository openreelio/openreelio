/**
 * MoveableTransformOverlay Component
 *
 * Interactive transform overlay for the selected clip in the preview canvas.
 * Drag / resize / rotate are delegated to react-moveable; this component is the
 * project-owned facade around it. It converts between the wire-format clip
 * transform and moveable's screen rectangle through `previewCoords`, and it
 * commits exactly one `SetClipTransform` command per gesture.
 *
 * The DOM the gesture drives is written imperatively: `executeCommand` triggers
 * a full project-state refresh, so dispatching per pointer move would both spam
 * the ops log and fight moveable's own rect cache.
 */

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import Moveable, {
  type OnDrag,
  type OnResize,
  type OnRotate,
} from 'react-moveable';
import { useProjectStore } from '@/stores/projectStore';
import { usePlaybackStore } from '@/stores/playbackStore';
import { useTimelineStore } from '@/stores/timelineStore';
import type { Asset, Sequence, Transform } from '@/types';
import { getClipMotionTransformAtTime } from '@/utils/clipMotion';
import { useSequenceTextClipData } from '@/hooks/useSequenceTextClipData';
import {
  clipBoundsFromTransform,
  isViewportUsable,
  transformFromScreenRect,
  type ClipScreenBounds,
  type ClipScreenRect,
  type PreviewSource,
  type PreviewViewport,
} from '@/utils/previewCoords';
import { getDefaultTransform, resolveOverlayGeometry } from './transformOverlayGeometry';
import { RENDER_DIRECTIONS, stampControlTestIds } from './transformOverlayHandles';

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
  /** Optional stacking order override for layered preview modes */
  zIndex?: number;
}

interface OverlayContext {
  sequenceId: string;
  trackId: string;
  clipId: string;
  transform: Transform;
  source: PreviewSource;
  viewport: PreviewViewport;
  bounds: ClipScreenBounds;
  isText: boolean;
  isKeyframed: boolean;
}

interface GestureState {
  context: OverlayContext;
  rect: ClipScreenRect;
  transform: Transform;
  moved: boolean;
}

// =============================================================================
// Constants
// =============================================================================

/** Rotation snap, in degrees. */
const ROTATION_SNAP_DEG = 15;
/** Vertical offset of the scale readout above the box, in screen pixels. */
const INFO_OFFSET_PX = 24;
/** Shown instead of the scale readout while a clip is driven by motion keyframes. */
const KEYFRAMED_HINT = 'Keyframed - edit motion in the Inspector';

const MOVEABLE_DIRECTIONS = [...RENDER_DIRECTIONS];

function formatScaleLabel(transform: Transform): string {
  return `${Math.round(transform.scale.x * 100)}% x ${Math.round(transform.scale.y * 100)}%`;
}

function boundsToRect(bounds: ClipScreenBounds): ClipScreenRect {
  return {
    left: bounds.left,
    top: bounds.top,
    width: bounds.width,
    height: bounds.height,
    rotationDeg: bounds.rotationDeg,
  };
}

// =============================================================================
// Component
// =============================================================================

export const MoveableTransformOverlay = memo(function MoveableTransformOverlay({
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
  zIndex,
}: TransformOverlayProps) {
  const targetRef = useRef<HTMLDivElement>(null);
  const infoRef = useRef<HTMLDivElement>(null);
  const moveableRef = useRef<Moveable>(null);
  const gestureRef = useRef<GestureState | null>(null);
  const contextRef = useRef<OverlayContext | null>(null);
  const [shiftHeld, setShiftHeld] = useState(false);

  const selectedClipIds = useTimelineStore((state) => state.selectedClipIds);
  const executeCommand = useProjectStore((state) => state.executeCommand);
  const currentTime = usePlaybackStore((state) => state.currentTime);
  const textClipDataById = useSequenceTextClipData(sequence);

  // Transform editing is single-selection only; group transforms need a
  // dedicated batch command (tracked separately).
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

  const context = useMemo<OverlayContext | null>(() => {
    if (!selectedClip || !sequence) return null;

    const { clip, trackId } = selectedClip;
    const sampledTransform =
      getClipMotionTransformAtTime(clip, currentTime) ?? getDefaultTransform();
    const { transform, source, isText } = resolveOverlayGeometry(
      clip,
      sampledTransform,
      assets,
      textClipDataById,
      canvasWidth,
      canvasHeight,
    );

    const viewport: PreviewViewport = {
      canvasWidth,
      canvasHeight,
      containerWidth,
      containerHeight,
      displayScale,
      panX,
      panY,
    };

    return {
      sequenceId: sequence.id,
      trackId,
      clipId: clip.id,
      transform,
      source,
      viewport,
      bounds: clipBoundsFromTransform(transform, source, viewport),
      isText,
      // Keyframed clips resolve their transform from the motion curve, so a
      // SetClipTransform written here would be overwritten on the next frame.
      // Editing is disabled until drags route to SetClipMotionKeyframes
      // (follow-up task task_2d85b37a).
      isKeyframed: (clip.motionKeyframes?.length ?? 0) > 0,
    };
  }, [
    selectedClip,
    sequence,
    currentTime,
    assets,
    textClipDataById,
    canvasWidth,
    canvasHeight,
    containerWidth,
    containerHeight,
    displayScale,
    panX,
    panY,
  ]);

  const applyBounds = useCallback((bounds: ClipScreenBounds, label: string) => {
    const target = targetRef.current;
    if (target) {
      target.style.width = `${bounds.width}px`;
      target.style.height = `${bounds.height}px`;
      target.style.transformOrigin = `${bounds.anchor.x * 100}% ${bounds.anchor.y * 100}%`;
      target.style.transform = `translate(${bounds.left}px, ${bounds.top}px) rotate(${bounds.rotationDeg}deg)`;
    }

    const info = infoRef.current;
    if (info) {
      info.style.transform = `translate(${bounds.left}px, ${bounds.top - INFO_OFFSET_PX}px)`;
      info.textContent = label;
    }
  }, []);

  // The committed transform owns the DOM whenever a gesture is not running.
  useLayoutEffect(() => {
    contextRef.current = context;
    if (!context || gestureRef.current) return;

    applyBounds(
      context.bounds,
      context.isKeyframed ? KEYFRAMED_HINT : formatScaleLabel(context.transform),
    );
    moveableRef.current?.updateRect();
  }, [context, applyBounds]);

  // Re-attach the overlay's stable handle testids to moveable's controls.
  useEffect(() => {
    const controlBox = moveableRef.current?.getControlBoxElement?.();
    if (!controlBox) return;

    stampControlTestIds(controlBox);
    const observer = new MutationObserver(() => stampControlTestIds(controlBox));
    observer.observe(controlBox, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [context]);

  useEffect(() => {
    const sync = (event: KeyboardEvent) => setShiftHeld(event.shiftKey);
    window.addEventListener('keydown', sync);
    window.addEventListener('keyup', sync);
    return () => {
      window.removeEventListener('keydown', sync);
      window.removeEventListener('keyup', sync);
    };
  }, []);

  const beginGesture = useCallback((): boolean => {
    const active = contextRef.current;
    if (!active || active.isKeyframed || !isViewportUsable(active.viewport)) {
      return false;
    }

    gestureRef.current = {
      context: active,
      rect: boundsToRect(active.bounds),
      transform: active.transform,
      moved: false,
    };
    return true;
  }, []);

  const updateGesture = useCallback(
    (patch: Partial<ClipScreenRect>) => {
      const gesture = gestureRef.current;
      if (!gesture) return;

      const { context: active } = gesture;
      gesture.rect = { ...gesture.rect, ...patch };
      gesture.moved = true;
      gesture.transform = transformFromScreenRect(
        gesture.rect,
        active.source,
        active.viewport,
        active.transform,
      );

      // Re-derive the box from the clamped transform so the preview never
      // shows a position the command would refuse to store.
      applyBounds(
        clipBoundsFromTransform(gesture.transform, active.source, active.viewport),
        formatScaleLabel(gesture.transform),
      );
    },
    [applyBounds],
  );

  const endGesture = useCallback(() => {
    const gesture = gestureRef.current;
    gestureRef.current = null;
    if (!gesture) return;

    const { context: active } = gesture;
    if (!gesture.moved) {
      applyBounds(active.bounds, formatScaleLabel(active.transform));
      moveableRef.current?.updateRect();
      return;
    }

    applyBounds(
      clipBoundsFromTransform(gesture.transform, active.source, active.viewport),
      formatScaleLabel(gesture.transform),
    );
    moveableRef.current?.updateRect();

    void executeCommand({
      type: 'SetClipTransform',
      payload: {
        sequenceId: active.sequenceId,
        trackId: active.trackId,
        clipId: active.clipId,
        transform: gesture.transform,
      },
    });
  }, [applyBounds, executeCommand]);

  const handleDrag = useCallback(
    (event: OnDrag) => {
      updateGesture({
        left: event.beforeTranslate[0],
        top: event.beforeTranslate[1],
      });
    },
    [updateGesture],
  );

  const handleResize = useCallback(
    (event: OnResize) => {
      updateGesture({
        width: event.width,
        height: event.height,
        left: event.drag.beforeTranslate[0],
        top: event.drag.beforeTranslate[1],
      });
    },
    [updateGesture],
  );

  const handleRotate = useCallback(
    (event: OnRotate) => {
      updateGesture({ rotationDeg: event.beforeRotate });
    },
    [updateGesture],
  );

  if (!context) {
    return null;
  }

  const isInteractive = !context.isKeyframed;
  // Text scale is stored as a transform but rendered as a font-size change, so
  // text may only resize uniformly. Shift forces uniform resizing otherwise.
  const keepRatio = context.isText || shiftHeld;

  return (
    <div
      className={`absolute inset-0 pointer-events-none ${className}`}
      data-testid="transform-overlay"
      style={{ zIndex }}
    >
      <div
        ref={targetRef}
        className={`absolute left-0 top-0 border-2 border-blue-500 ${
          isInteractive ? 'pointer-events-auto cursor-grab' : 'pointer-events-none border-dashed'
        }`}
        data-testid="transform-bounds"
        data-keyframed={context.isKeyframed ? 'true' : undefined}
      />

      <div
        ref={infoRef}
        className="absolute left-0 top-0 bg-black/70 text-white text-xs px-2 py-1 rounded pointer-events-none whitespace-nowrap"
        data-testid="transform-info"
      >
        {context.isKeyframed ? KEYFRAMED_HINT : formatScaleLabel(context.transform)}
      </div>

      <Moveable
        ref={moveableRef}
        className="pointer-events-auto"
        target={targetRef}
        draggable={isInteractive}
        resizable={isInteractive}
        rotatable={isInteractive}
        origin={false}
        keepRatio={keepRatio}
        renderDirections={MOVEABLE_DIRECTIONS}
        rotationPosition="top"
        throttleRotate={ROTATION_SNAP_DEG}
        transformOrigin={`${context.bounds.anchor.x * 100}% ${context.bounds.anchor.y * 100}%`}
        onDragStart={beginGesture}
        onDrag={handleDrag}
        onDragEnd={endGesture}
        onResizeStart={beginGesture}
        onResize={handleResize}
        onResizeEnd={endGesture}
        onRotateStart={beginGesture}
        onRotate={handleRotate}
        onRotateEnd={endGesture}
      />
    </div>
  );
});
