/**
 * AudioRubberBand Component
 *
 * SVG overlay on audio clips that visualizes volume automation keyframes
 * as a draggable rubber band curve. Users can:
 * - Click on the line to add a keyframe
 * - Drag keyframes to adjust time (horizontal) and value (vertical)
 * - Right-click a keyframe to delete or change interpolation
 */

import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import type { AudioKeyframe, KeyframeInterpolation, Clip } from '@/types';
import { getClipTimelineDurationSec } from '@/utils/clipAudio';
import {
  dbToY,
  yToDb,
  timeToX,
  xToTime,
  interpolateKeyframes,
  type AudioKeyframeActions,
} from '@/hooks/useAudioKeyframes';
import { TRACK_HEIGHT } from './constants';

// =============================================================================
// Types
// =============================================================================

interface AudioRubberBandProps {
  clip: Clip;
  width: number;
  disabled?: boolean;
  actions: AudioKeyframeActions;
}

interface DragState {
  keyframeIndex: number;
  startClientX: number;
  startClientY: number;
  startTimeOffset: number;
  startValueDb: number;
}

// =============================================================================
// Constants
// =============================================================================

const MIN_WIDTH_PX = 40;
const KEYFRAME_RADIUS = 4;
const KEYFRAME_HIT_RADIUS = 8;
const CURVE_SAMPLES = 40;

// =============================================================================
// Component
// =============================================================================

export function AudioRubberBand({
  clip,
  width,
  disabled = false,
  actions,
}: AudioRubberBandProps): JSX.Element | null {
  const clipDurationSec = useMemo(() => getClipTimelineDurationSec(clip), [clip]);
  const rawKeyframes = clip.audio?.volumeKeyframes;
  const keyframes = useMemo<AudioKeyframe[]>(() => rawKeyframes ?? [], [rawKeyframes]);

  const svgRef = useRef<SVGSVGElement>(null);
  const [dragState, setDragState] = useState<DragState | null>(null);
  const [draftPosition, setDraftPosition] = useState<{ x: number; y: number } | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    keyframeIndex: number;
  } | null>(null);
  const dragRef = useRef<DragState | null>(null);

  // Close context menu on outside click
  useEffect(() => {
    if (!contextMenu) return;
    const handleClick = () => setContextMenu(null);
    window.addEventListener('click', handleClick);
    return () => window.removeEventListener('click', handleClick);
  }, [contextMenu]);

  // Build curve polyline and fill path in a single pass
  const { curvePath, fillPath } = useMemo(() => {
    if (keyframes.length === 0) return { curvePath: '', fillPath: '' };
    const bottom = TRACK_HEIGHT;
    const steps = Math.max(CURVE_SAMPLES, Math.ceil(width / 4));
    const points: string[] = [];
    let fill = `M 0,${bottom}`;
    for (let i = 0; i <= steps; i++) {
      const t = (i / steps) * clipDurationSec;
      const db = interpolateKeyframes(keyframes, t);
      const x = timeToX(t, clipDurationSec, width);
      const y = dbToY(db, TRACK_HEIGHT);
      points.push(`${x},${y}`);
      fill += ` L ${x},${y}`;
    }
    fill += ` L ${width},${bottom} Z`;
    return { curvePath: points.join(' '), fillPath: fill };
  }, [keyframes, clipDurationSec, width]);

  // Handle click on the curve line to add a keyframe
  const handleLineClick = useCallback(
    (e: MouseEvent<SVGElement>) => {
      if (disabled || !svgRef.current) return;
      e.stopPropagation();
      const rect = svgRef.current.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const timeOffset = xToTime(x, clipDurationSec, width);
      const valueDb = yToDb(y, TRACK_HEIGHT);
      void actions.addKeyframe(timeOffset, valueDb);
    },
    [disabled, clipDurationSec, width, actions],
  );

  // Begin dragging a keyframe
  const handleKeyframeMouseDown = useCallback(
    (e: MouseEvent<SVGElement>, index: number) => {
      if (disabled) return;
      e.preventDefault();
      e.stopPropagation();
      const kf = keyframes[index];
      const state: DragState = {
        keyframeIndex: index,
        startClientX: e.clientX,
        startClientY: e.clientY,
        startTimeOffset: kf.timeOffset,
        startValueDb: kf.valueDb,
      };
      dragRef.current = state;
      setDragState(state);
      setDraftPosition({
        x: timeToX(kf.timeOffset, clipDurationSec, width),
        y: dbToY(kf.valueDb, TRACK_HEIGHT),
      });
    },
    [disabled, keyframes, clipDurationSec, width],
  );

  // Right-click keyframe for context menu
  const handleKeyframeContextMenu = useCallback((e: MouseEvent<SVGElement>, index: number) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, keyframeIndex: index });
  }, []);

  // Global drag events
  useEffect(() => {
    if (!dragState) return;
    const handleMouseMove = (e: globalThis.MouseEvent) => {
      const ds = dragRef.current;
      if (!ds || !svgRef.current) return;
      const rect = svgRef.current.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      setDraftPosition({
        x: Math.max(0, Math.min(width, x)),
        y: Math.max(0, Math.min(TRACK_HEIGHT, y)),
      });
    };

    const handleMouseUp = (e: globalThis.MouseEvent) => {
      const ds = dragRef.current;
      if (!ds || !svgRef.current) return;
      dragRef.current = null;
      setDragState(null);
      setDraftPosition(null);

      const rect = svgRef.current.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const newTime = xToTime(Math.max(0, Math.min(width, x)), clipDurationSec, width);
      const newDb = yToDb(Math.max(0, Math.min(TRACK_HEIGHT, y)), TRACK_HEIGHT);

      const timeMoved = Math.abs(newTime - ds.startTimeOffset) > 0.001;
      const valueMoved = Math.abs(newDb - ds.startValueDb) > 0.05;

      // IMPORTANT: Set value FIRST (doesn't reorder), then move (may reorder).
      // Reversing this would use a stale keyframeIndex after move-induced re-sort.
      if (valueMoved && !timeMoved) {
        void actions.setKeyframeValue(ds.keyframeIndex, newDb);
      } else if (timeMoved && !valueMoved) {
        void actions.moveKeyframe(ds.keyframeIndex, newTime);
      } else if (valueMoved && timeMoved) {
        void actions
          .setKeyframeValue(ds.keyframeIndex, newDb)
          .then(() => actions.moveKeyframe(ds.keyframeIndex, newTime));
      }
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [dragState, clipDurationSec, width, actions]);

  if (width < MIN_WIDTH_PX || clipDurationSec <= 0 || keyframes.length === 0) {
    return null;
  }

  return (
    <div data-testid="audio-rubber-band" className="absolute inset-0 z-25 pointer-events-none">
      <svg
        ref={svgRef}
        className="absolute inset-0 h-full w-full"
        viewBox={`0 0 ${width} ${TRACK_HEIGHT}`}
      >
        {/* Fill below curve */}
        <path d={fillPath} fill="rgba(251, 191, 36, 0.12)" className="pointer-events-none" />

        {/* Curve line — clickable to add keyframe */}
        <polyline
          data-testid="rubber-band-curve"
          points={curvePath}
          fill="none"
          stroke="rgba(251, 191, 36, 0.85)"
          strokeWidth="2"
          className="pointer-events-auto cursor-crosshair"
          onClick={handleLineClick}
        />

        {/* Keyframe points */}
        {keyframes.map((kf, i) => {
          const isDragging = dragState?.keyframeIndex === i && draftPosition;
          const cx = isDragging ? draftPosition.x : timeToX(kf.timeOffset, clipDurationSec, width);
          const cy = isDragging ? draftPosition.y : dbToY(kf.valueDb, TRACK_HEIGHT);

          return (
            <g key={`kf-${i}`}>
              {/* Invisible hit area */}
              <circle
                cx={cx}
                cy={cy}
                r={KEYFRAME_HIT_RADIUS}
                fill="transparent"
                className="pointer-events-auto cursor-grab"
                onMouseDown={(e) => handleKeyframeMouseDown(e, i)}
                onContextMenu={(e) => handleKeyframeContextMenu(e, i)}
              />
              {/* Visible keyframe dot */}
              <circle
                data-testid={`keyframe-dot-${i}`}
                cx={cx}
                cy={cy}
                r={KEYFRAME_RADIUS}
                fill={isDragging ? '#fbbf24' : '#f59e0b'}
                stroke="white"
                strokeWidth="1.5"
                className="pointer-events-none"
              />
            </g>
          );
        })}
      </svg>

      {/* Context menu */}
      {contextMenu && (
        <KeyframeContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          keyframeIndex={contextMenu.keyframeIndex}
          currentInterpolation={keyframes[contextMenu.keyframeIndex]?.interpolation ?? 'linear'}
          onDelete={() => {
            void actions.removeKeyframe(contextMenu.keyframeIndex);
            setContextMenu(null);
          }}
          onSetInterpolation={(interp) => {
            void actions.setKeyframeValue(
              contextMenu.keyframeIndex,
              keyframes[contextMenu.keyframeIndex]?.valueDb ?? 0,
              interp,
            );
            setContextMenu(null);
          }}
        />
      )}
    </div>
  );
}

// =============================================================================
// Context Menu Sub-component
// =============================================================================

interface KeyframeContextMenuProps {
  x: number;
  y: number;
  keyframeIndex: number;
  currentInterpolation: KeyframeInterpolation;
  onDelete: () => void;
  onSetInterpolation: (interp: KeyframeInterpolation) => void;
}

function KeyframeContextMenu({
  x,
  y,
  currentInterpolation,
  onDelete,
  onSetInterpolation,
}: KeyframeContextMenuProps): JSX.Element {
  const interpLabel = typeof currentInterpolation === 'string' ? currentInterpolation : 'bezier';

  return (
    <div
      data-testid="keyframe-context-menu"
      className="fixed z-50 rounded bg-gray-800 border border-gray-600 shadow-lg py-1 text-xs text-white min-w-[140px] pointer-events-auto"
      style={{ left: x, top: y }}
    >
      <button
        type="button"
        data-testid="keyframe-delete-btn"
        className="w-full px-3 py-1 text-left hover:bg-gray-700"
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
      >
        Delete Keyframe
      </button>
      <div className="border-t border-gray-600 my-0.5" />
      <div className="px-3 py-0.5 text-gray-400">Interpolation ({interpLabel})</div>
      {(['linear', 'hold'] as const).map((interp) => (
        <button
          key={interp}
          type="button"
          className={`w-full px-3 py-1 text-left hover:bg-gray-700 ${
            interpLabel === interp ? 'text-amber-400' : ''
          }`}
          onClick={(e) => {
            e.stopPropagation();
            onSetInterpolation(interp);
          }}
        >
          {interp.charAt(0).toUpperCase() + interp.slice(1)}
        </button>
      ))}
    </div>
  );
}
