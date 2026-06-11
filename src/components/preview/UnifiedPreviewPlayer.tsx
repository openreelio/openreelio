/**
 * UnifiedPreviewPlayer Component
 *
 * Intelligent preview player that automatically switches between:
 * - ProxyPreviewPlayer (HTML5 video) when proxies are ready
 * - TimelinePreviewPlayer (canvas/frame extraction) as fallback
 *
 * This provides the best viewing experience based on available resources.
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Check, Gauge, Grid3X3, Music, Shield } from 'lucide-react';
import { TimelinePreviewPlayer } from './TimelinePreviewPlayer';
import { ProxyPreviewPlayer } from './ProxyPreviewPlayer';
import { TransformOverlay } from './TransformOverlay';
import type { TextPlacementCommitPayload } from './TextPlacementOverlay';
import { TrackingOverlay } from './TrackingOverlay';
import { usePreviewMode } from '@/hooks/usePreviewMode';
import { useProjectStore } from '@/stores/projectStore';
import { usePlaybackStore } from '@/stores/playbackStore';
import {
  PREVIEW_PLAYBACK_QUALITY_SCALE,
  usePreviewStore,
  type PreviewMediaPreference,
  type PreviewPlaybackQuality,
} from '@/stores/previewStore';
import { useTimelineStore } from '@/stores/timelineStore';
import { getClipSourceTimeAtTimelineTime } from '@/utils/clipTiming';
import { usePlaybackController } from '@/services/PlaybackController';
import type { Clip, Effect, Mask, MaskShape, Point2D, Sequence } from '@/types';
import type { TrackKeyframe } from '@/utils/motionTracking';
import type { SyncState } from '@/services/PlaybackController';

// =============================================================================
// Types
// =============================================================================

export interface UnifiedPreviewPlayerProps {
  /** The sequence to preview (optional - will use active sequence if not provided) */
  sequence?: Sequence | null;
  /** Additional CSS classes */
  className?: string;
  /** Whether to show playback controls */
  showControls?: boolean;
  /** Whether to show timecode display */
  showTimecode?: boolean;
  /** Whether to show FPS statistics (dev mode) */
  showStats?: boolean;
  /** Callback when playback ends */
  onEnded?: () => void;
  /** Callback when frame is rendered (canvas mode only) */
  onFrameRender?: (time: number) => void;
  /** Whether the preview should accept click-to-place text input */
  textPlacementModeActive?: boolean;
  /** Commit handler for text entered directly on the preview */
  onTextPlacementCommit?: (payload: TextPlacementCommitPayload) => void | Promise<void>;
}

const PLAYBACK_QUALITY_OPTIONS: Array<{ value: PreviewPlaybackQuality; label: string }> = [
  { value: 'full', label: 'Full' },
  { value: 'half', label: 'Half' },
  { value: 'quarter', label: 'Quarter' },
];

const MEDIA_PREFERENCE_OPTIONS: Array<{ value: PreviewMediaPreference; label: string }> = [
  { value: 'auto', label: 'Auto' },
  { value: 'proxy', label: 'Proxy' },
  { value: 'renderCache', label: 'Render cache' },
];
const AUDIO_DRIFT_WARNING_MS = 50;
const AUDIO_DRIFT_CRITICAL_MS = 500;
const DEFAULT_PREVIEW_CONTAINER_SIZE = { width: 1, height: 1 };

// =============================================================================
// Component
// =============================================================================

function getSequenceFps(sequence: Sequence | null): number {
  const fps = sequence?.format?.fps;
  if (!fps || fps.den === 0) {
    return 30;
  }

  const value = fps.num / fps.den;
  return Number.isFinite(value) && value > 0 ? value : 30;
}

function parseTrackingData(value: unknown, fps: number): TrackKeyframe[] | null {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }

  if (!Array.isArray(parsed)) {
    return null;
  }

  const keyframes = parsed
    .map((item): TrackKeyframe | null => {
      if (typeof item !== 'object' || item === null) {
        return null;
      }

      const candidate = item as {
        time?: unknown;
        frame?: unknown;
        x?: unknown;
        y?: unknown;
        confidence?: unknown;
        scale?: unknown;
        rotation?: unknown;
      };
      const time =
        typeof candidate.time === 'number'
          ? candidate.time
          : typeof candidate.frame === 'number'
            ? candidate.frame / fps
            : NaN;
      const confidence = typeof candidate.confidence === 'number' ? candidate.confidence : 1;

      if (
        !Number.isFinite(time) ||
        typeof candidate.x !== 'number' ||
        typeof candidate.y !== 'number' ||
        !Number.isFinite(candidate.x) ||
        !Number.isFinite(candidate.y)
      ) {
        return null;
      }

      return {
        time,
        x: candidate.x,
        y: candidate.y,
        confidence: Number.isFinite(confidence) ? confidence : 1,
        ...(typeof candidate.scale === 'number' && Number.isFinite(candidate.scale)
          ? { scale: candidate.scale }
          : {}),
        ...(typeof candidate.rotation === 'number' && Number.isFinite(candidate.rotation)
          ? { rotation: candidate.rotation }
          : {}),
      };
    })
    .filter((keyframe): keyframe is TrackKeyframe => keyframe !== null)
    .sort((a, b) => a.time - b.time);

  return keyframes.length > 0 ? keyframes : null;
}

function getObjectTrackingEffect(clip: Clip | null, effects: Map<string, Effect>): Effect | null {
  if (!clip?.effects?.length) {
    return null;
  }

  return (
    clip.effects
      .map((effectId) => effects.get(effectId) ?? null)
      .filter((effect): effect is Effect => effect !== null)
      .filter((effect) => effect.enabled !== false && effect.effectType === 'object_tracking')
      .sort((a, b) => a.order - b.order)[0] ?? null
  );
}

function getSelectedClip(sequence: Sequence | null, selectedClipIds: string[]): Clip | null {
  if (!sequence || selectedClipIds.length !== 1) {
    return null;
  }

  const clipId = selectedClipIds[0];
  for (const track of sequence.tracks) {
    const clip = track.clips.find((candidate) => candidate.id === clipId);
    if (clip) {
      return clip;
    }
  }

  return null;
}

function getSelectedClipMasks(clip: Clip | null, effects: Map<string, Effect>): Mask[] {
  if (!clip?.effects?.length) {
    return [];
  }

  return clip.effects.flatMap((effectId) => {
    const effect = effects.get(effectId);
    if (!effect || effect.enabled === false) {
      return [];
    }

    return effect.masks?.masks.filter((mask) => mask.enabled !== false) ?? [];
  });
}

function maskPoint(point: Point2D, width: number, height: number): string {
  return `${point.x * width},${point.y * height}`;
}

function maskShapeToPath(shape: MaskShape, width: number, height: number): string | null {
  switch (shape.type) {
    case 'polygon':
      return shape.points.length > 0
        ? `${shape.points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${maskPoint(point, width, height)}`).join(' ')} Z`
        : null;
    case 'bezier':
      if (shape.points.length === 0) {
        return null;
      }
      return `${shape.points
        .map((point, index, points) => {
          if (index === 0) {
            return `M ${maskPoint(point.anchor, width, height)}`;
          }
          const previous = points[index - 1];
          const controlOut = previous.handleOut ?? previous.anchor;
          const controlIn = point.handleIn ?? point.anchor;
          return `C ${maskPoint(controlOut, width, height)} ${maskPoint(controlIn, width, height)} ${maskPoint(point.anchor, width, height)}`;
        })
        .join(' ')}${shape.closed ? ' Z' : ''}`;
    default:
      return null;
  }
}

function PreviewGuideOverlay({
  showSafeMargins,
  showGuides,
}: {
  showSafeMargins: boolean;
  showGuides: boolean;
}) {
  if (!showSafeMargins && !showGuides) {
    return null;
  }

  return (
    <div
      data-testid="program-preview-guides"
      className="pointer-events-none absolute inset-0"
      style={{ zIndex: 40 }}
    >
      {showSafeMargins && (
        <>
          <div
            data-testid="program-action-safe"
            className="absolute border border-white/45"
            style={{ inset: '10%' }}
          />
          <div
            data-testid="program-title-safe"
            className="absolute border border-white/30"
            style={{ inset: '20%' }}
          />
        </>
      )}

      {showGuides && (
        <>
          <div
            data-testid="program-guide-v-1"
            className="absolute top-0 bottom-0 w-px bg-white/30"
            style={{ left: '33.3333%' }}
          />
          <div
            data-testid="program-guide-v-2"
            className="absolute top-0 bottom-0 w-px bg-white/30"
            style={{ left: '66.6667%' }}
          />
          <div
            data-testid="program-guide-h-1"
            className="absolute left-0 right-0 h-px bg-white/30"
            style={{ top: '33.3333%' }}
          />
          <div
            data-testid="program-guide-h-2"
            className="absolute left-0 right-0 h-px bg-white/30"
            style={{ top: '66.6667%' }}
          />
          <div className="absolute left-1/2 top-0 bottom-0 w-px bg-white/20" />
          <div className="absolute top-1/2 left-0 right-0 h-px bg-white/20" />
        </>
      )}
    </div>
  );
}

function PreviewOverlayControls({
  showSafeMargins,
  showGuides,
  playbackQuality,
  mediaPreference,
  onToggleSafeMargins,
  onToggleGuides,
  onPlaybackQualityChange,
  onMediaPreferenceChange,
}: {
  showSafeMargins: boolean;
  showGuides: boolean;
  playbackQuality: PreviewPlaybackQuality;
  mediaPreference: PreviewMediaPreference;
  onToggleSafeMargins: () => void;
  onToggleGuides: () => void;
  onPlaybackQualityChange: (quality: PreviewPlaybackQuality) => void;
  onMediaPreferenceChange: (preference: PreviewMediaPreference) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div
      className="absolute top-2 right-12 flex items-center gap-1 rounded border border-white/10 bg-black/45 p-1 text-white shadow-lg backdrop-blur-sm"
      style={{ zIndex: 80 }}
      data-testid="program-overlay-controls"
    >
      <div className="relative">
        <button
          type="button"
          data-testid="preview-quality-menu-button"
          className={`rounded p-1 transition-colors ${
            menuOpen || playbackQuality !== 'full' || mediaPreference !== 'auto'
              ? 'bg-primary-500 text-white'
              : 'text-white/70 hover:bg-white/15'
          }`}
          aria-label="Preview quality"
          aria-expanded={menuOpen}
          title="Preview quality"
          onClick={() => setMenuOpen((open) => !open)}
        >
          <Gauge className="h-3.5 w-3.5" />
        </button>

        {menuOpen && (
          <div
            data-testid="preview-quality-menu"
            className="absolute right-0 top-8 w-44 rounded border border-white/10 bg-gray-950/95 p-1 text-xs text-white shadow-xl backdrop-blur"
          >
            <div className="px-2 py-1 text-[10px] uppercase text-white/45">Resolution</div>
            {PLAYBACK_QUALITY_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                data-testid={`preview-quality-${option.value}`}
                className="flex w-full items-center justify-between rounded px-2 py-1.5 text-left hover:bg-white/10"
                onClick={() => {
                  onPlaybackQualityChange(option.value);
                  setMenuOpen(false);
                }}
              >
                <span>{option.label}</span>
                {playbackQuality === option.value && <Check className="h-3 w-3" />}
              </button>
            ))}

            <div className="my-1 h-px bg-white/10" />
            <div className="px-2 py-1 text-[10px] uppercase text-white/45">Media</div>
            {MEDIA_PREFERENCE_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                data-testid={`preview-media-${option.value}`}
                className="flex w-full items-center justify-between rounded px-2 py-1.5 text-left hover:bg-white/10"
                onClick={() => {
                  onMediaPreferenceChange(option.value);
                  setMenuOpen(false);
                }}
              >
                <span>{option.label}</span>
                {mediaPreference === option.value && <Check className="h-3 w-3" />}
              </button>
            ))}
          </div>
        )}
      </div>
      <button
        type="button"
        data-testid="toggle-safe-margins"
        className={`rounded p-1 transition-colors ${
          showSafeMargins ? 'bg-primary-500 text-white' : 'text-white/70 hover:bg-white/15'
        }`}
        aria-label="Toggle safe margins"
        aria-pressed={showSafeMargins}
        title="Safe margins"
        onClick={onToggleSafeMargins}
      >
        <Shield className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        data-testid="toggle-composition-guides"
        className={`rounded p-1 transition-colors ${
          showGuides ? 'bg-primary-500 text-white' : 'text-white/70 hover:bg-white/15'
        }`}
        aria-label="Toggle composition guides"
        aria-pressed={showGuides}
        title="Composition guides"
        onClick={onToggleGuides}
      >
        <Grid3X3 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function PreviewDiagnosticsOverlay({ syncState }: { syncState: SyncState }) {
  if (syncState.isSynced || syncState.driftMs < AUDIO_DRIFT_WARNING_MS) {
    return null;
  }

  const critical = syncState.driftMs >= AUDIO_DRIFT_CRITICAL_MS;
  const driftLabel = `${Math.round(syncState.driftMs)} ms`;

  return (
    <div
      data-testid="preview-degraded-warning"
      className={`absolute left-2 top-10 flex items-center gap-1.5 rounded border px-2 py-1 text-xs text-white shadow-lg backdrop-blur-sm ${
        critical ? 'border-red-400/40 bg-red-950/80' : 'border-yellow-400/40 bg-yellow-950/80'
      }`}
      style={{ zIndex: 82 }}
      title={`Audio sync drift: ${driftLabel}`}
    >
      <AlertTriangle className="h-3.5 w-3.5" />
      <span>Audio sync drift {driftLabel}</span>
    </div>
  );
}

function PreviewMaskOverlay({
  masks,
  width,
  height,
}: {
  masks: Mask[];
  width: number;
  height: number;
}) {
  if (masks.length === 0) {
    return null;
  }

  return (
    <svg
      data-testid="program-mask-overlay"
      className="pointer-events-none absolute inset-0"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      style={{ zIndex: 45 }}
    >
      {masks.map((mask) => {
        const commonProps = {
          stroke: mask.inverted ? '#F59E0B' : '#A78BFA',
          strokeWidth: 2,
          strokeDasharray: mask.locked ? '6 4' : 'none',
          fill: 'rgba(167, 139, 250, 0.12)',
          opacity: Math.max(0.2, Math.min(1, mask.opacity ?? 1)),
        };

        switch (mask.shape.type) {
          case 'rectangle': {
            const x = (mask.shape.x - mask.shape.width / 2) * width;
            const y = (mask.shape.y - mask.shape.height / 2) * height;
            const rectWidth = mask.shape.width * width;
            const rectHeight = mask.shape.height * height;
            return (
              <g key={mask.id} data-testid={`program-mask-${mask.id}`}>
                <rect
                  x={x}
                  y={y}
                  width={rectWidth}
                  height={rectHeight}
                  rx={mask.shape.cornerRadius * Math.min(width, height)}
                  transform={`rotate(${mask.shape.rotation} ${mask.shape.x * width} ${mask.shape.y * height})`}
                  {...commonProps}
                />
                <circle cx={mask.shape.x * width} cy={mask.shape.y * height} r={5} fill="#A78BFA" />
              </g>
            );
          }
          case 'ellipse':
            return (
              <g key={mask.id} data-testid={`program-mask-${mask.id}`}>
                <ellipse
                  cx={mask.shape.x * width}
                  cy={mask.shape.y * height}
                  rx={mask.shape.radiusX * width}
                  ry={mask.shape.radiusY * height}
                  transform={`rotate(${mask.shape.rotation} ${mask.shape.x * width} ${mask.shape.y * height})`}
                  {...commonProps}
                />
                <circle cx={mask.shape.x * width} cy={mask.shape.y * height} r={5} fill="#A78BFA" />
              </g>
            );
          case 'polygon': {
            const path = maskShapeToPath(mask.shape, width, height);
            return path ? (
              <g key={mask.id} data-testid={`program-mask-${mask.id}`}>
                <path d={path} {...commonProps} />
                {mask.shape.points.map((point, index) => (
                  <circle
                    key={`${mask.id}-${index}`}
                    cx={point.x * width}
                    cy={point.y * height}
                    r={4}
                    fill="#A78BFA"
                  />
                ))}
              </g>
            ) : null;
          }
          case 'bezier': {
            const path = maskShapeToPath(mask.shape, width, height);
            return path ? (
              <g key={mask.id} data-testid={`program-mask-${mask.id}`}>
                <path d={path} {...commonProps} />
                {mask.shape.points.map((point, index) => (
                  <circle
                    key={`${mask.id}-${index}`}
                    cx={point.anchor.x * width}
                    cy={point.anchor.y * height}
                    r={4}
                    fill="#A78BFA"
                  />
                ))}
              </g>
            ) : null;
          }
          case 'gradient':
            return (
              <g key={mask.id} data-testid={`program-mask-${mask.id}`}>
                <line
                  x1={mask.shape.start.x * width}
                  y1={mask.shape.start.y * height}
                  x2={mask.shape.end.x * width}
                  y2={mask.shape.end.y * height}
                  stroke="#A78BFA"
                  strokeWidth={3}
                  strokeDasharray={mask.shape.gradientType === 'radial' ? '4 4' : 'none'}
                  opacity={0.9}
                />
                <circle
                  cx={mask.shape.start.x * width}
                  cy={mask.shape.start.y * height}
                  r={5}
                  fill="#A78BFA"
                />
                <circle
                  cx={mask.shape.end.x * width}
                  cy={mask.shape.end.y * height}
                  r={5}
                  fill="#A78BFA"
                />
              </g>
            );
          default:
            return null;
        }
      })}
    </svg>
  );
}

export const UnifiedPreviewPlayer = memo(function UnifiedPreviewPlayer({
  sequence: sequenceProp,
  className = '',
  showControls = true,
  showTimecode = true,
  showStats = false,
  onEnded,
  onFrameRender,
  textPlacementModeActive = false,
  onTextPlacementCommit,
}: UnifiedPreviewPlayerProps) {
  // Get sequence from prop or store
  const activeSequenceId = useProjectStore((state) => state.activeSequenceId);
  const sequences = useProjectStore((state) => state.sequences);
  const assets = useProjectStore((state) => state.assets);
  const effects = useProjectStore((state) => state.effects);
  const currentTime = usePlaybackStore((state) => state.currentTime);
  const selectedClipIds = useTimelineStore((state) => state.selectedClipIds);
  const showSafeMargins = usePreviewStore((state) => state.showSafeMargins);
  const showGuides = usePreviewStore((state) => state.showGuides);
  const playbackQuality = usePreviewStore((state) => state.playbackQuality);
  const mediaPreference = usePreviewStore((state) => state.mediaPreference);
  const toggleSafeMargins = usePreviewStore((state) => state.toggleSafeMargins);
  const toggleGuides = usePreviewStore((state) => state.toggleGuides);
  const setPlaybackQuality = usePreviewStore((state) => state.setPlaybackQuality);
  const setMediaPreference = usePreviewStore((state) => state.setMediaPreference);
  const setProgramPreviewCanvas = usePreviewStore((state) => state.setProgramPreviewCanvas);
  const { syncState } = usePlaybackController();
  const canvasPreviewRef = useRef<HTMLDivElement | null>(null);
  const [canvasPreviewSize, setCanvasPreviewSize] = useState(DEFAULT_PREVIEW_CONTAINER_SIZE);

  const sequence = useMemo(() => {
    if (sequenceProp !== undefined) {
      return sequenceProp;
    }
    return activeSequenceId ? (sequences.get(activeSequenceId) ?? null) : null;
  }, [sequenceProp, activeSequenceId, sequences]);

  // Determine optimal preview mode
  const { mode, reason, hasGeneratingProxy } = usePreviewMode({
    sequence,
    assets,
    currentTime,
    mediaPreference,
  });

  const handlePreviewCanvasChange = useCallback(
    (canvas: HTMLCanvasElement | null) => {
      setProgramPreviewCanvas(canvas);
    },
    [setProgramPreviewCanvas],
  );

  useEffect(() => {
    if (mode !== 'canvas') {
      setProgramPreviewCanvas(null);
    }
  }, [mode, setProgramPreviewCanvas]);

  useEffect(() => {
    return () => {
      setProgramPreviewCanvas(null);
    };
  }, [setProgramPreviewCanvas]);

  const sequenceCanvas = sequence?.format?.canvas;
  const playbackQualityScale = PREVIEW_PLAYBACK_QUALITY_SCALE[playbackQuality];
  const previewCanvas = useMemo(() => {
    if (!sequenceCanvas) {
      return null;
    }

    return {
      width: Math.max(1, Math.round(sequenceCanvas.width * playbackQualityScale)),
      height: Math.max(1, Math.round(sequenceCanvas.height * playbackQualityScale)),
    };
  }, [playbackQualityScale, sequenceCanvas]);
  const sequenceAspectRatio =
    sequenceCanvas && sequenceCanvas.width > 0 && sequenceCanvas.height > 0
      ? sequenceCanvas.width / sequenceCanvas.height
      : undefined;
  const canvasOverlayDisplayScale = useMemo(() => {
    if (!previewCanvas || previewCanvas.width <= 0 || previewCanvas.height <= 0) {
      return 1;
    }

    const width = canvasPreviewSize.width > 0 ? canvasPreviewSize.width : previewCanvas.width;
    const height = canvasPreviewSize.height > 0 ? canvasPreviewSize.height : previewCanvas.height;
    return Math.min(width / previewCanvas.width, height / previewCanvas.height);
  }, [canvasPreviewSize.height, canvasPreviewSize.width, previewCanvas]);

  useEffect(() => {
    const element = canvasPreviewRef.current;
    if (!element) {
      return;
    }

    const updateSize = () => {
      const rect = element.getBoundingClientRect();
      const fallbackWidth = previewCanvas?.width ?? DEFAULT_PREVIEW_CONTAINER_SIZE.width;
      const fallbackHeight = previewCanvas?.height ?? DEFAULT_PREVIEW_CONTAINER_SIZE.height;
      setCanvasPreviewSize({
        width: rect.width > 0 ? rect.width : fallbackWidth,
        height: rect.height > 0 ? rect.height : fallbackHeight,
      });
    };

    updateSize();

    if (typeof ResizeObserver === 'undefined') {
      return;
    }

    const observer = new ResizeObserver(updateSize);
    observer.observe(element);

    return () => {
      observer.disconnect();
    };
  }, [previewCanvas?.height, previewCanvas?.width]);

  const isAudioOnlySequence = useMemo(() => {
    if (!sequence) {
      return false;
    }

    let hasEnabledAudioClips = false;
    let hasEnabledVisualClips = false;

    for (const track of sequence.tracks) {
      const hasEnabledClips = track.clips.some((clip) => clip.enabled !== false);
      if (!hasEnabledClips) {
        continue;
      }

      if (track.kind === 'audio') {
        hasEnabledAudioClips = true;
      } else {
        hasEnabledVisualClips = true;
      }
    }

    return hasEnabledAudioClips && !hasEnabledVisualClips;
  }, [sequence]);
  const selectedClip = useMemo(
    () => getSelectedClip(sequence, selectedClipIds),
    [selectedClipIds, sequence],
  );
  const trackingOverlay = useMemo(() => {
    if (!sequence || !selectedClip) {
      return null;
    }

    const effect = getObjectTrackingEffect(selectedClip, effects);
    if (!effect) {
      return null;
    }

    const path = parseTrackingData(effect.params.tracking_data, getSequenceFps(sequence));
    if (!path) {
      return null;
    }

    return {
      path,
      currentTime: getClipSourceTimeAtTimelineTime(selectedClip, currentTime),
    };
  }, [currentTime, effects, selectedClip, sequence]);
  const maskOverlayMasks = useMemo(
    () => getSelectedClipMasks(selectedClip, effects),
    [effects, selectedClip],
  );

  // Render proxy-based player for video mode
  if (mode === 'video' && sequence) {
    return (
      <div
        className={`relative ${className}`}
        data-testid="unified-preview-player"
        data-mode="video"
        data-playback-quality={playbackQuality}
        data-media-preference={mediaPreference}
      >
        <ProxyPreviewPlayer
          sequence={sequence}
          assets={assets}
          className="w-full h-full"
          showControls={showControls}
          textPlacementModeActive={textPlacementModeActive}
          onTextPlacementCommit={onTextPlacementCommit}
        />

        <PreviewGuideOverlay showSafeMargins={showSafeMargins} showGuides={showGuides} />
        <PreviewDiagnosticsOverlay syncState={syncState} />
        {previewCanvas && (
          <PreviewMaskOverlay
            masks={maskOverlayMasks}
            width={previewCanvas.width}
            height={previewCanvas.height}
          />
        )}
        {trackingOverlay && previewCanvas && (
          <TrackingOverlay
            isSelectingPoint={false}
            trackingPath={trackingOverlay.path}
            currentTime={trackingOverlay.currentTime}
            width={previewCanvas.width}
            height={previewCanvas.height}
          />
        )}
        <PreviewOverlayControls
          showSafeMargins={showSafeMargins}
          showGuides={showGuides}
          playbackQuality={playbackQuality}
          mediaPreference={mediaPreference}
          onToggleSafeMargins={toggleSafeMargins}
          onToggleGuides={toggleGuides}
          onPlaybackQualityChange={setPlaybackQuality}
          onMediaPreferenceChange={setMediaPreference}
        />

        {/* Mode indicator (dev only) */}
        {showStats && (
          <div className="absolute top-2 left-2 bg-green-600/80 text-white text-xs px-2 py-1 rounded">
            Video Mode
          </div>
        )}
      </div>
    );
  }

  // Render canvas-based player for canvas mode
  return (
    <div
      ref={canvasPreviewRef}
      className={`relative ${className}`}
      data-testid="unified-preview-player"
      data-mode="canvas"
      data-playback-quality={playbackQuality}
      data-media-preference={mediaPreference}
    >
      <TimelinePreviewPlayer
        className="w-full h-full"
        showControls={showControls}
        showTimecode={showTimecode}
        showStats={showStats}
        aspectRatio={sequenceAspectRatio}
        width={previewCanvas?.width}
        height={previewCanvas?.height}
        onEnded={onEnded}
        onFrameRender={onFrameRender}
        onPreviewCanvasChange={handlePreviewCanvasChange}
        textPlacementModeActive={textPlacementModeActive}
        onTextPlacementCommit={onTextPlacementCommit}
      />

      {sequence && previewCanvas && !isAudioOnlySequence && (
        <TransformOverlay
          sequence={sequence}
          assets={assets}
          canvasWidth={previewCanvas.width}
          canvasHeight={previewCanvas.height}
          containerWidth={canvasPreviewSize.width}
          containerHeight={canvasPreviewSize.height}
          displayScale={canvasOverlayDisplayScale}
          panX={0}
          panY={0}
          zIndex={18}
        />
      )}

      <PreviewGuideOverlay showSafeMargins={showSafeMargins} showGuides={showGuides} />
      <PreviewDiagnosticsOverlay syncState={syncState} />
      {previewCanvas && (
        <PreviewMaskOverlay
          masks={maskOverlayMasks}
          width={previewCanvas.width}
          height={previewCanvas.height}
        />
      )}
      {trackingOverlay && previewCanvas && (
        <TrackingOverlay
          isSelectingPoint={false}
          trackingPath={trackingOverlay.path}
          currentTime={trackingOverlay.currentTime}
          width={previewCanvas.width}
          height={previewCanvas.height}
        />
      )}
      <PreviewOverlayControls
        showSafeMargins={showSafeMargins}
        showGuides={showGuides}
        playbackQuality={playbackQuality}
        mediaPreference={mediaPreference}
        onToggleSafeMargins={toggleSafeMargins}
        onToggleGuides={toggleGuides}
        onPlaybackQualityChange={setPlaybackQuality}
        onMediaPreferenceChange={setMediaPreference}
      />

      {isAudioOnlySequence && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-4">
          <div className="rounded-xl border border-white/10 bg-black/60 px-4 py-3 text-center text-white shadow-lg backdrop-blur-sm">
            <Music className="mx-auto mb-2 h-6 w-6 text-primary-300" />
            <p className="text-sm font-medium">Audio-only sequence</p>
            <p className="mt-1 text-xs text-white/70">
              Use playback controls to monitor the mix while editing.
            </p>
          </div>
        </div>
      )}

      {/* Proxy generating indicator */}
      {hasGeneratingProxy && (
        <div className="absolute top-2 left-2 bg-yellow-600/80 text-white text-xs px-2 py-1 rounded flex items-center gap-1">
          <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
            />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
            />
          </svg>
          <span>Generating proxy...</span>
        </div>
      )}

      {/* Mode indicator (dev only) */}
      {showStats && !hasGeneratingProxy && (
        <div className="absolute top-2 left-2 bg-blue-600/80 text-white text-xs px-2 py-1 rounded">
          Canvas Mode: {reason}
        </div>
      )}
    </div>
  );
});
