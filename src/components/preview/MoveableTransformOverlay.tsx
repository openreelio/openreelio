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
 *
 * ---------------------------------------------------------------------------
 * Intentional behavior changes vs. the hand-rolled overlay this replaced:
 *
 * 1. A gesture that ends without moving no longer dispatches a command. The old
 *    overlay committed an identical transform on every mouse-up, which pushed a
 *    no-op op onto the log and consumed an undo step.
 * 2. Holding Shift now forces a uniform resize on the EDGE handles too, not
 *    only on the corners. Text clips remain uniform-only regardless of Shift.
 * 3. Rotation snaps to 15 degree steps only while Shift is held. Rotation is
 *    free by default, matching the convention every other NLE uses; the old
 *    overlay was free-only and an intermediate revision of this one was
 *    snap-only.
 * 4. A clip driven by motion keyframes is read-only here (dashed box, gestures
 *    refused). Its transform is sampled from the motion curve, so a
 *    `SetClipTransform` written from a gesture would be overwritten on the next
 *    frame. Routing gestures to `SetClipMotionKeyframes` is task_2d85b37a.
 * ---------------------------------------------------------------------------
 */

import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import Moveable, {
  type OnDrag,
  type OnResize,
  type OnRotate,
} from 'react-moveable';
import { useProjectStore } from '@/stores/projectStore';
import { usePlaybackStore } from '@/stores/playbackStore';
import { useTimelineStore } from '@/stores/timelineStore';
import { createLogger } from '@/services/logger';
import type { Asset, Sequence, Transform } from '@/types';
import { getClipMotionTransformAtTime, hasActiveMotionKeyframes } from '@/utils/clipMotion';
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
import { resolveOverlayGeometry } from './transformOverlayGeometry';
import { RENDER_DIRECTIONS, stampControlTestIds } from './transformOverlayHandles';

const logger = createLogger('MoveableTransformOverlay');

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

/** Which scale axes the active gesture is allowed to rewrite. */
interface ScaleAxes {
  x: boolean;
  y: boolean;
}

interface GestureState {
  context: OverlayContext;
  /** Screen rectangle the gesture started from; never mutated. */
  startRect: ClipScreenRect;
  /** Screen rectangle as of the latest pointer move. */
  rect: ClipScreenRect;
  transform: Transform;
  scaleAxes: ScaleAxes;
  moved: boolean;
}

// =============================================================================
// Constants
// =============================================================================

/** Rotation snap, in degrees. */
const ROTATION_SNAP_DEG = 15;
/** Vertical offset of the scale readout above the box, in screen pixels. */
const INFO_OFFSET_PX = 24;
/**
 * Accent colour moveable paints its control box with, exposed as the
 * `--moveable-color` custom property it reads. Kept equal to the Tailwind
 * `border-blue-500` the overlay box itself uses so the two agree.
 */
const OVERLAY_ACCENT_COLOR = '#3b82f6';
/** Shown instead of the scale readout while a clip is driven by motion keyframes. */
const KEYFRAMED_HINT = 'Keyframed - edit motion in the Inspector';

const MOVEABLE_DIRECTIONS = [...RENDER_DIRECTIONS];

function formatScaleLabel(transform: Transform): string {
  return `${Math.round(transform.scale.x * 100)}% x ${Math.round(transform.scale.y * 100)}%`;
}

function boxTransform(bounds: ClipScreenBounds): string {
  return `translate(${bounds.left}px, ${bounds.top}px) rotate(${bounds.rotationDeg}deg)`;
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

/**
 * Size for a uniform (keepRatio) resize, held exactly on the starting aspect.
 *
 * moveable rounds both axes to whole CSS pixels, so replaying its width AND its
 * height drifts the aspect ratio by up to ~0.05% per gesture. The axis that
 * moved further is taken as authoritative and the other one is derived from it,
 * which keeps `scale.x / scale.y` bit-stable across repeated resizes.
 *
 * @param startRect - Rectangle the gesture started from.
 * @param width - Width moveable reported.
 * @param height - Height moveable reported.
 */
function uniformResizeSize(
  startRect: ClipScreenRect,
  width: number,
  height: number,
): { width: number; height: number } {
  if (!(startRect.width > 0) || !(startRect.height > 0)) {
    return { width, height };
  }

  const aspect = startRect.width / startRect.height;
  const widthDelta = Math.abs(width - startRect.width);
  // Compare both deltas in width units so the dominant axis is picked fairly.
  const heightDelta = Math.abs(height - startRect.height) * aspect;

  if (widthDelta >= heightDelta) {
    return { width, height: width / aspect };
  }

  return { width: height * aspect, height };
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
}: TransformOverlayProps): JSX.Element | null {
  const targetRef = useRef<HTMLDivElement>(null);
  const infoRef = useRef<HTMLDivElement>(null);
  const moveableRef = useRef<Moveable>(null);
  const gestureRef = useRef<GestureState | null>(null);
  const contextRef = useRef<OverlayContext | null>(null);
  const keepRatioRef = useRef(false);
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
    const sampledTransform = getClipMotionTransformAtTime(clip, currentTime);
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
      // (follow-up task task_2d85b37a). The predicate must agree with the
      // sampler: keyframes the sampler discards do not drive anything.
      isKeyframed: hasActiveMotionKeyframes(clip),
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

  const isInteractive = context !== null && !context.isKeyframed;
  // Text scale is stored as a transform but rendered as a font-size change, so
  // text may only resize uniformly. Shift forces uniform resizing otherwise.
  const keepRatio = context !== null && (context.isText || shiftHeld);

  const applyBounds = useCallback((bounds: ClipScreenBounds, label: string): void => {
    const target = targetRef.current;
    if (target) {
      target.style.width = `${bounds.width}px`;
      target.style.height = `${bounds.height}px`;
      target.style.transformOrigin = `${bounds.anchor.x * 100}% ${bounds.anchor.y * 100}%`;
      target.style.transform = boxTransform(bounds);
    }

    const info = infoRef.current;
    if (info) {
      info.style.transform = `translate(${bounds.left}px, ${bounds.top - INFO_OFFSET_PX}px)`;
      info.textContent = label;
    }
  }, []);

  // The committed bounds are rendered as style props so the target already has
  // its final size when moveable first measures it. Once a gesture starts the
  // writes go through `applyBounds` instead, which never re-renders.
  useLayoutEffect(() => {
    contextRef.current = context;
    keepRatioRef.current = keepRatio;
    if (!context || gestureRef.current) return;

    moveableRef.current?.updateRect();
  }, [context, keepRatio]);

  // Re-attach the overlay's stable handle testids to moveable's controls.
  // Keyed off identity rather than `context`, which is rebuilt on every
  // playhead tick: re-subscribing a MutationObserver 60 times a second during
  // playback is pure churn, and moveable only rebuilds its controls when the
  // selection or the interactive flag changes.
  useEffect(() => {
    const controlBox = moveableRef.current?.getControlBoxElement?.();
    if (!controlBox) return;

    stampControlTestIds(controlBox);
    const observer = new MutationObserver(() => stampControlTestIds(controlBox));
    observer.observe(controlBox, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [context?.clipId, isInteractive]);

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

    const rect = boundsToRect(active.bounds);
    gestureRef.current = {
      context: active,
      startRect: rect,
      rect,
      transform: active.transform,
      // A gesture only earns the right to rewrite a scale axis by resizing it.
      scaleAxes: { x: false, y: false },
      moved: false,
    };
    return true;
  }, []);

  const updateGesture = useCallback(
    (patch: Partial<ClipScreenRect>): void => {
      const gesture = gestureRef.current;
      if (!gesture) return;

      const { context: active } = gesture;
      gesture.rect = { ...gesture.rect, ...patch };
      gesture.moved = true;

      const recovered = transformFromScreenRect(
        gesture.rect,
        active.source,
        active.viewport,
        active.transform,
      );

      // Scale is recovered from the rectangle, which is only meaningful for the
      // axes a resize actually dragged. Drag and rotate carry the committed
      // scale through byte-for-byte so they can never nudge it — or, for a clip
      // scaled below the clamp floor, snap it back up on the first pointer move.
      gesture.transform = {
        ...recovered,
        scale: {
          x: gesture.scaleAxes.x ? recovered.scale.x : active.transform.scale.x,
          y: gesture.scaleAxes.y ? recovered.scale.y : active.transform.scale.y,
        },
      };

      // Re-derive the box from the clamped transform so the preview never
      // shows a position the command would refuse to store.
      applyBounds(
        clipBoundsFromTransform(gesture.transform, active.source, active.viewport),
        formatScaleLabel(gesture.transform),
      );
    },
    [applyBounds],
  );

  const endGesture = useCallback((): void => {
    const gesture = gestureRef.current;
    gestureRef.current = null;
    if (!gesture) return;

    const { context: active } = gesture;

    /** Snaps the box back to the last transform the project actually accepted. */
    const restoreCommitted = (): void => {
      // Another gesture or another selection owns the box now; leave it alone.
      if (gestureRef.current || contextRef.current?.clipId !== active.clipId) return;

      applyBounds(active.bounds, formatScaleLabel(active.transform));
      moveableRef.current?.updateRect();
    };

    if (!gesture.moved) {
      restoreCommitted();
      return;
    }

    applyBounds(
      clipBoundsFromTransform(gesture.transform, active.source, active.viewport),
      formatScaleLabel(gesture.transform),
    );
    moveableRef.current?.updateRect();

    void Promise.resolve(
      executeCommand({
        type: 'SetClipTransform',
        payload: {
          sequenceId: active.sequenceId,
          trackId: active.trackId,
          clipId: active.clipId,
          transform: gesture.transform,
        },
      }),
    ).catch((error: unknown) => {
      // The final geometry was written imperatively, so a rejected command
      // would otherwise leave the box parked at a position the store never
      // took - and no state change means no re-derive to correct it.
      logger.error('Failed to commit clip transform from preview gesture', {
        clipId: active.clipId,
        error: error instanceof Error ? error.message : String(error),
      });
      restoreCommitted();
    });
  }, [applyBounds, executeCommand]);

  const handleDrag = useCallback(
    (event: OnDrag): void => {
      updateGesture({
        left: event.beforeTranslate[0],
        top: event.beforeTranslate[1],
      });
    },
    [updateGesture],
  );

  const handleResize = useCallback(
    (event: OnResize): void => {
      const gesture = gestureRef.current;
      if (!gesture) return;

      const patch: Partial<ClipScreenRect> = {
        left: event.drag.beforeTranslate[0],
        top: event.drag.beforeTranslate[1],
      };

      if (keepRatioRef.current) {
        const uniform = uniformResizeSize(gesture.startRect, event.width, event.height);
        patch.width = uniform.width;
        patch.height = uniform.height;
        gesture.scaleAxes = { x: true, y: true };
      } else {
        // moveable reports both axes on every resize, rounded to CSS pixels.
        // For an edge handle only the dragged axis may change, so the other one
        // is left alone rather than absorbing the rounding error.
        if (event.direction[0] !== 0) {
          patch.width = event.width;
          gesture.scaleAxes.x = true;
        }
        if (event.direction[1] !== 0) {
          patch.height = event.height;
          gesture.scaleAxes.y = true;
        }
      }

      updateGesture(patch);
    },
    [updateGesture],
  );

  const handleRotate = useCallback(
    (event: OnRotate): void => {
      updateGesture({ rotationDeg: event.beforeRotate });
    },
    [updateGesture],
  );

  if (!context) {
    return null;
  }

  return (
    <div
      className={`absolute inset-0 pointer-events-none ${className}`}
      data-testid="transform-overlay"
      style={{ zIndex, '--moveable-color': OVERLAY_ACCENT_COLOR } as CSSProperties}
    >
      <div
        ref={targetRef}
        className={`absolute border-2 border-blue-500 ${
          isInteractive ? 'pointer-events-auto cursor-grab' : 'pointer-events-none border-dashed'
        }`}
        data-testid="transform-bounds"
        data-keyframed={context.isKeyframed ? 'true' : undefined}
        style={{
          left: 0,
          top: 0,
          width: context.bounds.width,
          height: context.bounds.height,
          transformOrigin: `${context.bounds.anchor.x * 100}% ${context.bounds.anchor.y * 100}%`,
          transform: boxTransform(context.bounds),
        }}
      />

      <div
        ref={infoRef}
        className="absolute left-0 top-0 bg-black/70 text-white text-xs px-2 py-1 rounded pointer-events-none whitespace-nowrap"
        data-testid="transform-info"
        style={{
          transform: `translate(${context.bounds.left}px, ${context.bounds.top - INFO_OFFSET_PX}px)`,
        }}
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
        useResizeObserver
        useMutationObserver
        keepRatio={keepRatio}
        renderDirections={MOVEABLE_DIRECTIONS}
        rotationPosition="top"
        // moveable throttles the ABSOLUTE angle, so a non-zero value here would
        // yank a clip already sitting at 7 degrees onto the grid the moment a
        // rotation starts. Rotation stays free unless Shift asks for the snap.
        throttleRotate={shiftHeld ? ROTATION_SNAP_DEG : 0}
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
