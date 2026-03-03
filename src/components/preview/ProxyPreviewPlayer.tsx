/**
 * ProxyPreviewPlayer Component
 *
 * Renders timeline sequence preview using proxy videos.
 * Manages multiple video elements for active clips at current time.
 */

import { useRef, useMemo, useCallback, useEffect, useState } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import {
  PLAYBACK_EVENTS,
  type PlaybackSeekEventDetail,
  usePlaybackStore,
} from '@/stores/playbackStore';
import { useProjectStore } from '@/stores/projectStore';
import { useTimelineStore } from '@/stores/timelineStore';
import { createLogger } from '@/services/logger';
import { PlayerControls } from './PlayerControls';
import { normalizeFileUriToPath } from '@/utils/uri';
import { useSequenceTextClipData } from '@/hooks/useSequenceTextClipData';
import { extractTextDataFromClipWithMap } from '@/utils/textRenderer';
import {
  getClipSourceTimeAtTimelineTime,
  getSafeClipSpeed,
  isClipActiveAtTime,
} from '@/utils/clipTiming';
import { isCaptionLikeClip } from '@/utils/captionClip';
import {
  isTextClip,
  type Sequence,
  type Asset,
  type Clip,
  type CaptionStyle,
  type CaptionPosition,
  type CaptionColor,
  type TextClipData,
} from '@/types';

// =============================================================================
// Types
// =============================================================================

export interface ProxyPreviewPlayerProps {
  /** Sequence to preview */
  sequence: Sequence | null;
  /** Assets map for looking up proxy URLs */
  assets: Map<string, Asset>;
  /** Additional CSS classes */
  className?: string;
  /** Whether to show controls */
  showControls?: boolean;
}

interface ActiveClip {
  clip: Clip;
  asset: Asset;
  trackId: string;
  trackIndex: number;
}

interface RenderableClip extends ActiveClip {
  src: string;
}

interface ActiveCaption {
  clip: Clip;
  trackId: string;
  trackKind: Sequence['tracks'][number]['kind'];
  trackIndex: number;
  text: string;
}

interface ActiveTextOverlay {
  clip: Clip;
  trackIndex: number;
  textData: TextClipData;
}

interface CaptionDragState {
  captionId: string;
  trackId: string;
  pointerId: number;
  offsetX: number;
  offsetY: number;
}

// =============================================================================
// Constants
// =============================================================================

const FRAME_INTERVAL = 1000 / 30; // 30fps for animation frame updates
const PRECISE_SEEK_TOLERANCE = 0.008; // ~0.5 frame at 60fps for paused scrubbing
const DRIFT_SEEK_TOLERANCE = 0.12; // reduce micro-stutter from overly frequent drift seeks
const HARD_SEEK_DETECTION_DELTA = 0.25; // Treat as explicit jump when delta exceeds this
const TIME_CHANGE_EPSILON = 0.001;
const TRACK_LAYER_Z_INDEX_STEP = 10;
const CAPTION_LAYER_Z_INDEX_OFFSET = 5;
const TEXT_LAYER_Z_INDEX_OFFSET = 6;
const CONTROLS_Z_INDEX_OFFSET = 100;
const URI_SCHEME_PATTERN = /^[a-zA-Z][a-zA-Z\d+\-.]*:/;

const logger = createLogger('ProxyPreviewPlayer');

function isWindowsAbsolutePath(path: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(path);
}

function clampTimelineTime(time: number, duration: number): number {
  if (!Number.isFinite(time)) {
    return 0;
  }
  if (!Number.isFinite(duration) || duration <= 0) {
    return Math.max(0, time);
  }
  return Math.max(0, Math.min(duration, time));
}

const DEFAULT_CAPTION_STYLE: CaptionStyle = {
  fontFamily: 'Arial',
  fontSize: 48,
  fontWeight: 'normal',
  color: { r: 255, g: 255, b: 255, a: 255 },
  outlineColor: { r: 0, g: 0, b: 0, a: 255 },
  outlineWidth: 2,
  shadowColor: { r: 0, g: 0, b: 0, a: 160 },
  shadowOffset: 2,
  alignment: 'center',
  italic: false,
  underline: false,
};

const DEFAULT_CAPTION_POSITION: CaptionPosition = {
  type: 'preset',
  vertical: 'bottom',
  marginPercent: 5,
};

function clampPercent(value: number, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(0, Math.min(100, value));
}

function normalizeCaptionStyle(style: CaptionStyle | undefined): CaptionStyle {
  if (!style) {
    return DEFAULT_CAPTION_STYLE;
  }

  return {
    ...DEFAULT_CAPTION_STYLE,
    ...style,
    color: {
      ...DEFAULT_CAPTION_STYLE.color,
      ...style.color,
    },
    backgroundColor: style.backgroundColor
      ? {
          r: style.backgroundColor.r,
          g: style.backgroundColor.g,
          b: style.backgroundColor.b,
          a: style.backgroundColor.a,
        }
      : undefined,
    outlineColor: style.outlineColor
      ? {
          r: style.outlineColor.r,
          g: style.outlineColor.g,
          b: style.outlineColor.b,
          a: style.outlineColor.a,
        }
      : undefined,
    shadowColor: style.shadowColor
      ? {
          r: style.shadowColor.r,
          g: style.shadowColor.g,
          b: style.shadowColor.b,
          a: style.shadowColor.a,
        }
      : undefined,
  };
}

function normalizeCaptionPosition(position: CaptionPosition | undefined): CaptionPosition {
  if (!position) {
    return DEFAULT_CAPTION_POSITION;
  }

  if (position.type === 'custom') {
    return {
      type: 'custom',
      xPercent: clampPercent(position.xPercent, 50),
      yPercent: clampPercent(position.yPercent, 90),
    };
  }

  return {
    type: 'preset',
    vertical: position.vertical,
    marginPercent: clampPercent(position.marginPercent, 5),
  };
}

function resolveCaptionAnchor(
  style: CaptionStyle,
  position: CaptionPosition,
): {
  xPercent: number;
  yPercent: number;
} {
  let xPercent = 50;
  if (style.alignment === 'left') {
    xPercent = 10;
  } else if (style.alignment === 'right') {
    xPercent = 90;
  }

  let yPercent = 90;
  if (position.type === 'custom') {
    xPercent = position.xPercent;
    yPercent = position.yPercent;
  } else if (position.vertical === 'top') {
    yPercent = position.marginPercent;
  } else if (position.vertical === 'center') {
    yPercent = 50;
  } else {
    yPercent = 100 - position.marginPercent;
  }

  return {
    xPercent: clampPercent(xPercent, 50),
    yPercent: clampPercent(yPercent, 90),
  };
}

function toRgba(color: CaptionColor): string {
  return `rgba(${color.r}, ${color.g}, ${color.b}, ${color.a / 255})`;
}

function buildCaptionTextShadow(style: CaptionStyle): string | undefined {
  const parts: string[] = [];

  if (style.outlineColor && style.outlineWidth > 0) {
    const width = Math.max(1, Math.round(style.outlineWidth));
    const outline = toRgba(style.outlineColor);
    parts.push(
      `${-width}px 0 ${outline}`,
      `${width}px 0 ${outline}`,
      `0 ${-width}px ${outline}`,
      `0 ${width}px ${outline}`,
      `${-width}px ${-width}px ${outline}`,
      `${width}px ${-width}px ${outline}`,
      `${-width}px ${width}px ${outline}`,
      `${width}px ${width}px ${outline}`,
    );
  }

  if (style.shadowColor && style.shadowOffset > 0) {
    const offset = style.shadowOffset;
    parts.push(`${offset}px ${offset}px ${offset}px ${toRgba(style.shadowColor)}`);
  }

  return parts.length > 0 ? parts.join(', ') : undefined;
}

function resolveCaptionPositionForClip(
  clip: Clip,
  trackKind: Sequence['tracks'][number]['kind'],
): CaptionPosition {
  if (clip.captionPosition) {
    return normalizeCaptionPosition(clip.captionPosition);
  }

  // Legacy/non-caption clips can still be repositioned through transform.position.
  if (trackKind !== 'caption') {
    const xPercent = clampPercent(clip.transform.position.x * 100, 50);
    const yPercent = clampPercent(clip.transform.position.y * 100, 90);
    const hasCustomTransformPosition =
      Math.abs(xPercent - 50) > 0.01 || Math.abs(yPercent - 50) > 0.01;

    if (hasCustomTransformPosition) {
      return {
        type: 'custom',
        xPercent,
        yPercent,
      };
    }
  }

  return DEFAULT_CAPTION_POSITION;
}

function isIdentityClipTransform(clip: Clip): boolean {
  const { transform } = clip;

  return (
    Math.abs(transform.position.x - 0.5) < 0.0001 &&
    Math.abs(transform.position.y - 0.5) < 0.0001 &&
    Math.abs(transform.scale.x - 1) < 0.0001 &&
    Math.abs(transform.scale.y - 1) < 0.0001 &&
    Math.abs(transform.rotationDeg) < 0.0001 &&
    Math.abs(transform.anchor.x - 0.5) < 0.0001 &&
    Math.abs(transform.anchor.y - 0.5) < 0.0001
  );
}

function applyClipTransformToTextData(clip: Clip, textData: TextClipData): TextClipData {
  if (isIdentityClipTransform(clip)) {
    return textData;
  }

  const scaleFactor = Math.max(
    0.1,
    (Math.abs(clip.transform.scale.x) + Math.abs(clip.transform.scale.y)) / 2,
  );

  return {
    ...textData,
    position: {
      x: clip.transform.position.x,
      y: clip.transform.position.y,
    },
    rotation: clip.transform.rotationDeg,
    style: {
      ...textData.style,
      fontSize: Math.max(1, Math.round(textData.style.fontSize * scaleFactor)),
      backgroundPadding: Math.max(0, Math.round(textData.style.backgroundPadding * scaleFactor)),
      letterSpacing: Math.round(textData.style.letterSpacing * scaleFactor),
    },
    shadow: textData.shadow
      ? {
          ...textData.shadow,
          offsetX: Math.round(textData.shadow.offsetX * scaleFactor),
          offsetY: Math.round(textData.shadow.offsetY * scaleFactor),
          blur: Math.max(0, Math.round(textData.shadow.blur * scaleFactor)),
        }
      : textData.shadow,
    outline: textData.outline
      ? {
          ...textData.outline,
          width:
            textData.outline.width <= 0
              ? 0
              : Math.max(1, Math.round(textData.outline.width * scaleFactor)),
        }
      : textData.outline,
  };
}

function parseHexColor(color: string): string | null {
  if (!color.startsWith('#')) {
    return null;
  }

  const raw = color.slice(1).trim();
  const isValidHex = /^[a-fA-F\d]+$/.test(raw);
  if (!isValidHex) {
    return null;
  }

  const expand = (value: string): string =>
    value
      .split('')
      .map((char) => `${char}${char}`)
      .join('');

  let normalized = raw;
  if (normalized.length === 3 || normalized.length === 4) {
    normalized = expand(normalized);
  }

  if (normalized.length !== 6 && normalized.length !== 8) {
    return null;
  }

  const r = parseInt(normalized.slice(0, 2), 16);
  const g = parseInt(normalized.slice(2, 4), 16);
  const b = parseInt(normalized.slice(4, 6), 16);
  const alphaValue = normalized.length === 8 ? parseInt(normalized.slice(6, 8), 16) / 255 : 1;

  return `rgba(${r}, ${g}, ${b}, ${alphaValue})`;
}

function resolveTextColor(color: string | undefined, fallback: string): string {
  const candidate = color?.trim();
  if (!candidate) {
    return fallback;
  }

  return parseHexColor(candidate) ?? candidate;
}

function buildTextOverlayShadow(textData: TextClipData): string | undefined {
  const parts: string[] = [];

  if (textData.outline && textData.outline.width > 0) {
    const width = Math.max(1, Math.round(textData.outline.width));
    const outlineColor = resolveTextColor(textData.outline.color, '#000000');
    parts.push(
      `${-width}px 0 ${outlineColor}`,
      `${width}px 0 ${outlineColor}`,
      `0 ${-width}px ${outlineColor}`,
      `0 ${width}px ${outlineColor}`,
      `${-width}px ${-width}px ${outlineColor}`,
      `${width}px ${-width}px ${outlineColor}`,
      `${-width}px ${width}px ${outlineColor}`,
      `${width}px ${width}px ${outlineColor}`,
    );
  }

  if (textData.shadow) {
    const shadow = textData.shadow;
    parts.push(
      `${shadow.offsetX}px ${shadow.offsetY}px ${Math.max(0, shadow.blur)}px ${resolveTextColor(shadow.color, '#000000')}`,
    );
  }

  return parts.length > 0 ? parts.join(', ') : undefined;
}

// =============================================================================
// Component
// =============================================================================

export function ProxyPreviewPlayer({
  sequence,
  assets,
  className = '',
  showControls = true,
}: ProxyPreviewPlayerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRefs = useRef<Map<string, HTMLVideoElement>>(new Map());
  const animationFrameRef = useRef<number | null>(null);
  const lastUpdateTimeRef = useRef<number>(0);
  // Track previous store time to detect explicit jump seeks during active playback.
  const prevTimeRef = useRef<number>(0);

  // Playback state from store
  const {
    currentTime,
    isPlaying,
    syncWithTimeline = true,
    duration,
    volume,
    isMuted,
    playbackRate,
    seek,
    setCurrentTime,
    setIsPlaying,
    togglePlayback,
    setVolume,
    toggleMute,
    setPlaybackRate,
  } = usePlaybackStore();

  const selectedClipIds = useTimelineStore((state) => state.selectedClipIds);
  const executeCommand = useProjectStore((state) => state.executeCommand);

  // Local state
  const [buffered, setBuffered] = useState(0);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [videoErrors, setVideoErrors] = useState<Map<string, string>>(new Map());
  const [captionDragState, setCaptionDragState] = useState<CaptionDragState | null>(null);
  const [captionDraftPosition, setCaptionDraftPosition] = useState<CaptionPosition | null>(null);

  // NOTE: Playback duration is managed by useTimelineEngine (Timeline component).
  // Do NOT compute or set it here - competing setDuration calls cause the SeekBar
  // and Timeline to use different duration ranges, breaking positional sync.

  // Calculate sequence FPS
  const sequenceFps = useMemo(() => {
    if (!sequence?.format?.fps) return 30;
    const { num, den } = sequence.format.fps;
    return den > 0 ? num / den : 30;
  }, [sequence]);

  const textClipDataById = useSequenceTextClipData(sequence);

  // Cache previous active clip result to stabilize the reference when the same
  // clips are active across consecutive frames. This prevents unnecessary
  // downstream re-renders and effect re-fires during steady-state playback.
  const prevActiveClipsRef = useRef<ActiveClip[]>([]);

  // Find active clips at current time (sorted by layer/track)
  const activeClips = useMemo((): ActiveClip[] => {
    if (!sequence) {
      if (prevActiveClipsRef.current.length === 0) return prevActiveClipsRef.current;
      prevActiveClipsRef.current = [];
      return prevActiveClipsRef.current;
    }

    const clips: ActiveClip[] = [];

    sequence.tracks.forEach((track, trackIndex) => {
      if (track.muted || !track.visible) return;

      // Proxy mode renders plain video tracks only (no overlay/caption compositing).
      if (track.kind !== 'video') return;

      for (const clip of track.clips) {
        // Check if clip is active at current time
        if (isClipActiveAtTime(clip, currentTime)) {
          const asset = assets.get(clip.assetId);
          if (!asset || asset.kind !== 'video') {
            continue;
          }

          clips.push({
            clip,
            asset,
            trackId: track.id,
            trackIndex,
          });
        }
      }
    });

    // Sort back-to-front by timeline lane order.
    // Timeline renders lower indices as higher lanes, so higher indices should render first.
    clips.sort((a, b) => b.trackIndex - a.trackIndex);

    // Return the same reference if the active clip set hasn't changed.
    // This avoids cascading re-renders when playhead moves within the same clip.
    const prev = prevActiveClipsRef.current;
    if (
      clips.length === prev.length &&
      clips.every(
        (clipInfo, index) =>
          clipInfo.clip === prev[index].clip &&
          clipInfo.asset === prev[index].asset &&
          clipInfo.trackId === prev[index].trackId &&
          clipInfo.trackIndex === prev[index].trackIndex,
      )
    ) {
      return prev;
    }

    prevActiveClipsRef.current = clips;
    return clips;
  }, [sequence, currentTime, assets]);

  // Get video source URL for an asset
  // Prioritizes proxy URL when proxy is ready, falls back to original.
  // Rejects unsupported URI schemes to prevent unsafe URL injection.
  const getVideoSrc = useCallback((asset: Asset): string | null => {
    const safeDecodeURIComponent = (input: string): string => {
      try {
        return decodeURIComponent(input);
      } catch {
        return input;
      }
    };

    // Use proxy URL only when proxy generation is complete
    const useProxy = asset.proxyStatus === 'ready' && asset.proxyUrl;
    const url = (useProxy ? asset.proxyUrl : asset.uri)?.trim();

    if (!url) return null;

    const hasUnsupportedUriScheme =
      URI_SCHEME_PATTERN.test(url) &&
      !isWindowsAbsolutePath(url) &&
      !url.startsWith('http://') &&
      !url.startsWith('https://') &&
      !url.startsWith('file://') &&
      !url.startsWith('asset://');

    if (hasUnsupportedUriScheme) {
      const scheme = url.slice(0, url.indexOf(':')).toLowerCase();
      logger.warn('Blocked unsupported preview media URL scheme', { assetId: asset.id, scheme });
      return null;
    }

    // Already a valid HTTP/HTTPS URL
    if (url.startsWith('http://') || url.startsWith('https://')) {
      return url;
    }

    // Already converted to Tauri asset protocol (starts with asset://)
    // Note: This should rarely happen as backend now sends raw paths
    if (url.startsWith('asset://')) {
      // Try to extract the path and re-convert properly
      // Format might be: asset://localhost/C:/path/to/file
      const pathMatch = url.match(/^asset:\/\/localhost\/(.+)$/);
      if (pathMatch) {
        return convertFileSrc(safeDecodeURIComponent(pathMatch[1]));
      }
      return url;
    }

    // Convert file:// URL to Tauri asset protocol
    if (url.startsWith('file://')) {
      const path = normalizeFileUriToPath(url);
      return convertFileSrc(path);
    }

    // Handle all other paths (Windows: C:\\path, Unix: /path)
    // convertFileSrc handles both formats correctly
    return convertFileSrc(safeDecodeURIComponent(url));
  }, []);

  const renderableClips = useMemo((): RenderableClip[] => {
    const clips: RenderableClip[] = [];

    for (const clipInfo of activeClips) {
      const src = getVideoSrc(clipInfo.asset);
      if (!src) continue;
      clips.push({ ...clipInfo, src });
    }

    return clips;
  }, [activeClips, getVideoSrc]);

  const activeCaptions = useMemo((): ActiveCaption[] => {
    if (!sequence) {
      return [];
    }

    const captions: ActiveCaption[] = [];

    sequence.tracks.forEach((track, trackIndex) => {
      if (track.muted || !track.visible) {
        return;
      }

      for (const clip of track.clips) {
        if (!isClipActiveAtTime(clip, currentTime)) {
          continue;
        }

        const asset = assets.get(clip.assetId);
        if (!isCaptionLikeClip(track, clip, asset)) {
          continue;
        }

        const text = clip.label?.trim();
        if (!text) {
          continue;
        }

        captions.push({
          clip,
          trackId: track.id,
          trackKind: track.kind,
          trackIndex,
          text,
        });
      }
    });

    captions.sort((a, b) => b.trackIndex - a.trackIndex);
    return captions;
  }, [sequence, assets, currentTime]);

  const activeTextOverlays = useMemo((): ActiveTextOverlay[] => {
    if (!sequence) {
      return [];
    }

    const overlays: ActiveTextOverlay[] = [];

    sequence.tracks.forEach((track, trackIndex) => {
      if (track.muted || !track.visible) {
        return;
      }

      for (const clip of track.clips) {
        if (!isClipActiveAtTime(clip, currentTime) || !isTextClip(clip.assetId)) {
          continue;
        }

        const textData = extractTextDataFromClipWithMap(clip, textClipDataById);
        if (!textData || !textData.content.trim()) {
          continue;
        }

        overlays.push({
          clip,
          trackIndex,
          textData: applyClipTransformToTextData(clip, textData),
        });
      }
    });

    overlays.sort((a, b) => b.trackIndex - a.trackIndex);
    return overlays;
  }, [sequence, currentTime, textClipDataById]);

  const selectedCaptionId = selectedClipIds.length === 1 ? selectedClipIds[0] : null;
  const selectedActiveCaption = useMemo(() => {
    if (!selectedCaptionId) {
      return null;
    }

    return activeCaptions.find((caption) => caption.clip.id === selectedCaptionId) ?? null;
  }, [activeCaptions, selectedCaptionId]);

  useEffect(() => {
    if (!selectedActiveCaption || captionDragState?.captionId !== selectedActiveCaption.clip.id) {
      setCaptionDragState(null);
      setCaptionDraftPosition(null);
    }
  }, [selectedActiveCaption, captionDragState]);

  const resolvePointerCaptionPosition = useCallback(
    (
      clientX: number,
      clientY: number,
      offsetX: number,
      offsetY: number,
    ): CaptionPosition | null => {
      const container = containerRef.current;
      if (!container) {
        return null;
      }

      const rect = container.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        return null;
      }

      const anchorX = clientX - rect.left - offsetX;
      const anchorY = clientY - rect.top - offsetY;

      return {
        type: 'custom',
        xPercent: clampPercent((anchorX / rect.width) * 100, 50),
        yPercent: clampPercent((anchorY / rect.height) * 100, 90),
      };
    },
    [],
  );

  const handleCaptionPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>, caption: ActiveCaption) => {
      if (!sequence) {
        return;
      }

      if (selectedCaptionId !== caption.clip.id) {
        return;
      }

      const style = normalizeCaptionStyle(caption.clip.captionStyle);
      const currentPosition =
        captionDraftPosition ?? resolveCaptionPositionForClip(caption.clip, caption.trackKind);

      const container = containerRef.current;
      if (!container) {
        return;
      }

      const rect = container.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        return;
      }

      const anchor = resolveCaptionAnchor(style, currentPosition);
      const anchorX = rect.left + (anchor.xPercent / 100) * rect.width;
      const anchorY = rect.top + (anchor.yPercent / 100) * rect.height;
      const offsetX = event.clientX - anchorX;
      const offsetY = event.clientY - anchorY;

      const nextPosition = resolvePointerCaptionPosition(
        event.clientX,
        event.clientY,
        offsetX,
        offsetY,
      );
      if (!nextPosition) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);

      setCaptionDragState({
        captionId: caption.clip.id,
        trackId: caption.trackId,
        pointerId: event.pointerId,
        offsetX,
        offsetY,
      });
      setCaptionDraftPosition(nextPosition);
    },
    [sequence, selectedCaptionId, captionDraftPosition, resolvePointerCaptionPosition],
  );

  const handleCaptionPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>, caption: ActiveCaption) => {
      if (!captionDragState || captionDragState.captionId !== caption.clip.id) {
        return;
      }

      if (captionDragState.pointerId !== event.pointerId) {
        return;
      }

      const nextPosition = resolvePointerCaptionPosition(
        event.clientX,
        event.clientY,
        captionDragState.offsetX,
        captionDragState.offsetY,
      );
      if (!nextPosition) {
        return;
      }

      event.preventDefault();
      setCaptionDraftPosition(nextPosition);
    },
    [captionDragState, resolvePointerCaptionPosition],
  );

  const commitCaptionPosition = useCallback(
    async (caption: ActiveCaption, position: CaptionPosition) => {
      if (!sequence) {
        return;
      }

      try {
        if (caption.trackKind === 'caption') {
          await executeCommand({
            type: 'UpdateCaption',
            payload: {
              sequenceId: sequence.id,
              trackId: caption.trackId,
              captionId: caption.clip.id,
              position,
            },
          });
          return;
        }

        // Legacy subtitle-like clips on non-caption tracks are moved via transform.
        await executeCommand({
          type: 'SetClipTransform',
          payload: {
            sequenceId: sequence.id,
            trackId: caption.trackId,
            clipId: caption.clip.id,
            transform: {
              ...caption.clip.transform,
              position: {
                x: position.type === 'custom' ? position.xPercent / 100 : 0.5,
                y: position.type === 'custom' ? position.yPercent / 100 : 0.9,
              },
            },
          },
        });
      } catch (error) {
        logger.error('Failed to commit caption position from preview drag', {
          error,
          sequenceId: sequence.id,
          trackId: caption.trackId,
          captionId: caption.clip.id,
        });
      }
    },
    [executeCommand, sequence],
  );

  const handleCaptionPointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>, caption: ActiveCaption) => {
      if (!captionDragState || captionDragState.captionId !== caption.clip.id) {
        return;
      }

      if (captionDragState.pointerId !== event.pointerId) {
        return;
      }

      event.preventDefault();
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }

      const finalPosition = captionDraftPosition;
      const activeCaption = activeCaptions.find(
        (item) => item.clip.id === captionDragState.captionId,
      );
      setCaptionDragState(null);
      setCaptionDraftPosition(null);

      if (finalPosition && activeCaption) {
        void commitCaptionPosition(activeCaption, finalPosition);
      }
    },
    [activeCaptions, captionDragState, captionDraftPosition, commitCaptionPosition],
  );

  const handleCaptionPointerCancel = useCallback(
    (event: React.PointerEvent<HTMLDivElement>, caption: ActiveCaption) => {
      if (!captionDragState || captionDragState.captionId !== caption.clip.id) {
        return;
      }

      if (captionDragState.pointerId !== event.pointerId) {
        return;
      }

      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      setCaptionDragState(null);
      setCaptionDraftPosition(null);
    },
    [captionDragState],
  );

  const getClampedSourceTime = useCallback((clip: Clip, timelineTime: number) => {
    return getClipSourceTimeAtTimelineTime(clip, timelineTime);
  }, []);

  // Sync video elements to timeline position.
  // - forceSeek=true: hard align to requested time (user seek/scrub)
  // - forceSeek=false: only correct significant drift during playback
  const syncVideos = useCallback(
    (timelineTime: number, forceSeek: boolean = false) => {
      const safeTimelineTime = clampTimelineTime(timelineTime, duration);

      renderableClips.forEach(({ clip }) => {
        const video = videoRefs.current.get(clip.id);
        if (!video) return;

        const clampedSourceTime = getClampedSourceTime(clip, safeTimelineTime);
        const safeSpeed = getSafeClipSpeed(clip);

        const tolerance = forceSeek || !isPlaying ? PRECISE_SEEK_TOLERANCE : DRIFT_SEEK_TOLERANCE;
        // During active playback, avoid forcing currentTime while the element is
        // already seeking. Re-seeking a seeking element can cause visible jitter.
        if (!forceSeek && isPlaying && video.seeking) {
          return;
        }

        if (Math.abs(video.currentTime - clampedSourceTime) > tolerance) {
          video.currentTime = clampedSourceTime;
        }

        // Sync playback rate
        video.playbackRate = playbackRate * safeSpeed;

        // ProxyPreviewPlayer video elements stay muted; Web Audio owns timeline audio output.
        // Keep volume at zero as a defensive fallback even if browser muted state changes.
        video.volume = 0;

        // Sync play state
        if (isPlaying && video.paused) {
          const playResult = video.play();
          if (playResult && typeof playResult.catch === 'function') {
            void playResult.catch(() => {
              // Autoplay prevented
            });
          }
        } else if (!isPlaying && !video.paused) {
          video.pause();
        }
      });
    },
    [duration, renderableClips, getClampedSourceTime, isPlaying, playbackRate],
  );

  // Track playback start time for synthetic time advancement
  const playbackStartRef = useRef<{ timestamp: number; timelineTime: number } | null>(null);

  // Animation frame loop for playback
  const updatePlayback = useCallback(
    (timestamp: number) => {
      if (!isPlaying) {
        animationFrameRef.current = null;
        return;
      }

      try {
        // Limit updates to avoid excessive re-renders
        if (timestamp - lastUpdateTimeRef.current >= FRAME_INTERVAL) {
          const prevTimestamp = lastUpdateTimeRef.current;
          lastUpdateTimeRef.current = timestamp;

          // Find the first playing video to sync time from (not just first clip)
          // This handles cases where some clips may have load errors or be paused
          let foundVideoSource = false;
          for (const { clip } of renderableClips) {
            const video = videoRefs.current.get(clip.id);
            if (video && !video.paused && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
              // Calculate timeline time from video time
              const offsetInSource = video.currentTime - clip.range.sourceInSec;
              const safeSpeed = getSafeClipSpeed(clip);
              const timelineTime = clip.place.timelineInSec + offsetInSource / safeSpeed;
              const clampedTimelineTime = clampTimelineTime(timelineTime, duration);
              setCurrentTime(clampedTimelineTime, 'proxy-video-clock');
              // Update synthetic time reference
              playbackStartRef.current = { timestamp, timelineTime: clampedTimelineTime };
              foundVideoSource = true;
              break; // Use first valid video as time source
            }
          }

          // Fallback: If no video is available, advance time synthetically
          // This ensures playback continues even when all videos fail to load
          if (!foundVideoSource && prevTimestamp > 0) {
            const elapsed = (timestamp - prevTimestamp) / 1000; // Convert to seconds
            const timeAdvance = elapsed * playbackRate;
            const newTime = clampTimelineTime(currentTime + timeAdvance, duration);
            setCurrentTime(newTime, 'proxy-synthetic-clock');

            // Stop at end of duration
            if (newTime >= duration) {
              setIsPlaying(false);
            }
          }
        }
      } catch (error) {
        logger.error('Proxy playback frame update failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        if (isPlaying) {
          animationFrameRef.current = requestAnimationFrame(updatePlayback);
        } else {
          animationFrameRef.current = null;
        }
      }
    },
    [isPlaying, renderableClips, setCurrentTime, playbackRate, currentTime, duration, setIsPlaying],
  );

  // Start/stop animation frame loop
  useEffect(() => {
    // TimelineEngine is the authoritative playback clock in editor mode.
    // Keep this fallback loop disabled while timeline sync is enabled to avoid
    // competing currentTime writers and playhead snap-back during scrubbing.
    if (isPlaying && !syncWithTimeline) {
      animationFrameRef.current = requestAnimationFrame(updatePlayback);
    } else if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }

    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, [isPlaying, syncWithTimeline, updatePlayback]);

  // Baseline sync pass (playing only):
  // Drift correction during active playback. When paused, the hard-seek
  // effect below handles precise alignment on every time change.
  useEffect(() => {
    if (!isPlaying) return;
    syncVideos(currentTime, false);
  }, [currentTime, isPlaying, syncVideos]);

  // Playback state transition sync:
  // Ensure pause is applied immediately even when currentTime does not change.
  // Without this, toggling play->pause can leave HTMLVideoElements running
  // until the next seek/time update arrives.
  useEffect(() => {
    if (!isPlaying) {
      // Hard-stop every known video element to avoid background playback from
      // stale refs that may not be in the current active clip set.
      videoRefs.current.forEach((video) => {
        if (!video.paused) {
          video.pause();
        }
      });

      syncVideos(currentTime, true);
    }
  }, [isPlaying, currentTime, syncVideos]);

  // Hard-seek pass:
  // - always when paused (timeline scrubbing/playhead drag)
  // - when playing only for explicit jump deltas
  useEffect(() => {
    const timeDiff = Math.abs(currentTime - prevTimeRef.current);
    const hasSignificantTimeChange = timeDiff > TIME_CHANGE_EPSILON;

    if (hasSignificantTimeChange) {
      const shouldHardSeek = !isPlaying || timeDiff >= HARD_SEEK_DETECTION_DELTA;
      if (shouldHardSeek) {
        syncVideos(currentTime, true);
      }
    }

    // Always update ref to prevent drift from sub-epsilon increments
    prevTimeRef.current = currentTime;
  }, [currentTime, isPlaying, syncVideos]);

  // Explicit user-intent seek path (seek bar, keyboard jump, etc.).
  // Use hard seek regardless of playback state to keep preview frame-accurate.
  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const handlePlaybackSeek = (event: Event) => {
      const customEvent = event as CustomEvent<PlaybackSeekEventDetail>;
      const targetTime = customEvent.detail?.time;
      if (!Number.isFinite(targetTime)) {
        return;
      }
      syncVideos(targetTime, true);
    };

    window.addEventListener(PLAYBACK_EVENTS.SEEK, handlePlaybackSeek);
    return () => {
      window.removeEventListener(PLAYBACK_EVENTS.SEEK, handlePlaybackSeek);
    };
  }, [syncVideos]);

  // Clean up stale video refs
  useEffect(() => {
    const activeClipIds = new Set(renderableClips.map((c) => c.clip.id));
    videoRefs.current.forEach((video, clipId) => {
      if (!activeClipIds.has(clipId)) {
        video.pause();
        videoRefs.current.delete(clipId);
      }
    });
  }, [renderableClips]);

  // Clear error state when clips change or proxy becomes ready
  useEffect(() => {
    const activeClipIds = new Set(renderableClips.map((c) => c.clip.id));

    setVideoErrors((prev) => {
      let changed = false;
      const next = new Map(prev);

      // Clear errors for clips that are no longer active
      next.forEach((_, clipId) => {
        if (!activeClipIds.has(clipId)) {
          next.delete(clipId);
          changed = true;
        }
      });

      // Clear errors for clips whose proxy is now ready
      renderableClips.forEach(({ clip, asset }) => {
        if (next.has(clip.id) && asset.proxyStatus === 'ready') {
          next.delete(clip.id);
          changed = true;
        }
      });

      return changed ? next : prev;
    });
  }, [renderableClips]);

  // Handle video element ref
  const setVideoRef = useCallback((clipId: string, el: HTMLVideoElement | null) => {
    if (el) {
      videoRefs.current.set(clipId, el);
    } else {
      videoRefs.current.delete(clipId);
    }
  }, []);

  // Handle video loaded
  const handleVideoLoaded = useCallback(
    (clipId: string) => {
      const video = videoRefs.current.get(clipId);
      if (video) {
        // Update buffered progress
        if (video.buffered.length > 0) {
          const bufferedEnd = video.buffered.end(video.buffered.length - 1);
          setBuffered(bufferedEnd);
        }
        // Clear any previous error for this clip (skip if no error existed)
        setVideoErrors((prev) => {
          if (!prev.has(clipId)) return prev;
          const next = new Map(prev);
          next.delete(clipId);
          return next;
        });

        // Keep newly loaded clips frame-accurate with the current playhead.
        // Without this, paused scrubbing can display frame 0 until the next seek.
        syncVideos(currentTime, true);
      }
    },
    [currentTime, syncVideos],
  );

  // Handle video load error
  const handleVideoError = useCallback((clipId: string, error: string) => {
    logger.error('Proxy video element failed to load', { clipId, error });
    setVideoErrors((prev) => {
      const next = new Map(prev);
      next.set(clipId, error);
      return next;
    });
  }, []);

  // Control handlers
  const handlePlayPause = useCallback(() => {
    togglePlayback();
  }, [togglePlayback]);

  const handleSeek = useCallback(
    (time: number) => {
      seek(Math.max(0, Math.min(duration, time)));
    },
    [seek, duration],
  );

  const handleVolumeChange = useCallback(
    (newVolume: number) => {
      setVolume(newVolume);
    },
    [setVolume],
  );

  const handleMuteToggle = useCallback(() => {
    toggleMute();
  }, [toggleMute]);

  const handleFullscreenToggle = useCallback(() => {
    if (!containerRef.current) return;

    if (!document.fullscreenElement) {
      void containerRef.current
        .requestFullscreen?.()
        .then(() => {
          setIsFullscreen(true);
        })
        .catch(() => {
          // Fullscreen not supported
        });
    } else {
      void document
        .exitFullscreen?.()
        .then(() => {
          setIsFullscreen(false);
        })
        .catch(() => {
          // Exit failed
        });
    }
  }, []);

  // Listen for fullscreen changes
  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
    };
  }, []);

  // Handle playback end
  useEffect(() => {
    if (!syncWithTimeline && isPlaying && currentTime >= duration && duration > 0) {
      setIsPlaying(false);
      setCurrentTime(duration, 'proxy-playback-end');
    }
  }, [syncWithTimeline, currentTime, duration, isPlaying, setIsPlaying, setCurrentTime]);

  // Keyboard shortcuts
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.defaultPrevented) return;

      switch (e.key) {
        case ' ':
          e.preventDefault();
          togglePlayback();
          break;
        case 'f':
        case 'F':
          e.preventDefault();
          handleFullscreenToggle();
          break;
      }
    },
    [togglePlayback, handleFullscreenToggle],
  );

  // Calculate aspect ratio from sequence format (guard against zero height)
  const aspectRatio =
    sequence?.format?.canvas && sequence.format.canvas.height > 0
      ? sequence.format.canvas.width / sequence.format.canvas.height
      : 16 / 9;

  const controlsZIndex =
    sequence !== null
      ? sequence.tracks.length * TRACK_LAYER_Z_INDEX_STEP + CONTROLS_Z_INDEX_OFFSET
      : CONTROLS_Z_INDEX_OFFSET;

  // Empty state
  if (!sequence) {
    return (
      <div
        data-testid="proxy-preview-empty"
        className={`flex items-center justify-center bg-black ${className}`}
        style={{ aspectRatio: 16 / 9 }}
        role="region"
        aria-label="Video preview"
      >
        <div className="text-gray-500 text-center">
          <svg
            className="w-16 h-16 mx-auto mb-2"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"
            />
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
          <p>No sequence loaded</p>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      data-testid="proxy-preview-player"
      className={`relative bg-black overflow-hidden ${className}`}
      style={{ aspectRatio }}
      tabIndex={0}
      role="region"
      aria-label="Video preview"
      onKeyDown={handleKeyDown}
    >
      {/* Video Layers */}
      <div className="absolute inset-0 pointer-events-none" data-testid="proxy-video-layer">
        {renderableClips.length === 0 ? (
          <div className="w-full h-full flex items-center justify-center text-gray-500">
            <p>No clips at current time</p>
          </div>
        ) : (
          renderableClips.map(({ clip, asset, trackIndex, src }) => {
            const error = videoErrors.get(clip.id);

            // Show error state if video failed to load
            if (error) {
              return (
                <div
                  key={clip.id}
                  data-testid={`proxy-video-error-${clip.id}`}
                  className="absolute inset-0 flex items-center justify-center bg-gray-900 pointer-events-none"
                  style={{
                    zIndex: (sequence.tracks.length - trackIndex) * TRACK_LAYER_Z_INDEX_STEP,
                  }}
                >
                  <div className="text-center text-red-400">
                    <svg
                      className="w-12 h-12 mx-auto mb-2"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={1.5}
                        d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                      />
                    </svg>
                    <p className="text-sm">Failed to load video</p>
                    <p className="text-xs text-gray-500 mt-1">{asset.name}</p>
                  </div>
                </div>
              );
            }

            return (
              <video
                key={clip.id}
                ref={(el) => setVideoRef(clip.id, el)}
                data-testid={`proxy-video-${clip.id}`}
                src={src}
                className="absolute inset-0 w-full h-full object-contain pointer-events-none"
                style={{
                  opacity: clip.opacity,
                  zIndex: (sequence.tracks.length - trackIndex) * TRACK_LAYER_Z_INDEX_STEP,
                }}
                playsInline
                muted
                onLoadedData={() => handleVideoLoaded(clip.id)}
                onError={(e) =>
                  handleVideoError(clip.id, e.currentTarget.error?.message || 'Unknown error')
                }
              />
            );
          })
        )}
      </div>

      {/* Caption overlays (rendered in proxy mode to avoid canvas fallback for captions) */}
      {activeCaptions.length > 0 && (
        <div className="absolute inset-0 pointer-events-none" data-testid="proxy-caption-layer">
          {activeCaptions.map((caption) => {
            const style = normalizeCaptionStyle(caption.clip.captionStyle);
            const resolvedPosition =
              selectedCaptionId === caption.clip.id && captionDraftPosition
                ? captionDraftPosition
                : resolveCaptionPositionForClip(caption.clip, caption.trackKind);
            const anchor = resolveCaptionAnchor(style, resolvedPosition);

            const translateX =
              style.alignment === 'left' ? '0%' : style.alignment === 'right' ? '-100%' : '-50%';

            const isSelected = selectedCaptionId === caption.clip.id;
            const isEditableSelected = isSelected;
            const isDraggingSelected =
              captionDragState?.captionId === caption.clip.id && captionDragState.pointerId != null;

            const fontWeight =
              style.fontWeight === 'bold' ? 700 : style.fontWeight === 'light' ? 300 : 400;
            const textShadow = buildCaptionTextShadow(style);
            const textDecoration = style.underline ? 'underline' : 'none';

            return (
              <div
                key={caption.clip.id}
                data-testid={`proxy-caption-${caption.clip.id}`}
                className={`absolute select-none ${isEditableSelected ? 'pointer-events-auto' : 'pointer-events-none'}`}
                style={{
                  left: `${anchor.xPercent}%`,
                  top: `${anchor.yPercent}%`,
                  transform: `translate(${translateX}, -50%)`,
                  color: toRgba(style.color),
                  fontFamily: style.fontFamily,
                  fontSize: `${Math.max(12, style.fontSize * 0.75)}px`,
                  fontWeight,
                  fontStyle: style.italic ? 'italic' : 'normal',
                  textAlign: style.alignment,
                  textDecoration,
                  whiteSpace: 'pre-line',
                  lineHeight: 1.2,
                  backgroundColor: style.backgroundColor
                    ? toRgba(style.backgroundColor)
                    : 'transparent',
                  textShadow,
                  border: isEditableSelected ? '1px dashed rgba(59, 130, 246, 0.9)' : 'none',
                  borderRadius: isEditableSelected ? '4px' : '0',
                  padding: isEditableSelected || style.backgroundColor ? '2px 6px' : '0',
                  cursor: isEditableSelected
                    ? isDraggingSelected
                      ? 'grabbing'
                      : 'grab'
                    : 'default',
                  zIndex:
                    (sequence.tracks.length - caption.trackIndex) * TRACK_LAYER_Z_INDEX_STEP +
                    CAPTION_LAYER_Z_INDEX_OFFSET,
                }}
                title={isEditableSelected ? 'Drag to reposition caption' : undefined}
                onPointerDown={(event) => handleCaptionPointerDown(event, caption)}
                onPointerMove={(event) => handleCaptionPointerMove(event, caption)}
                onPointerUp={(event) => handleCaptionPointerUp(event, caption)}
                onPointerCancel={(event) => handleCaptionPointerCancel(event, caption)}
              >
                {caption.text}
              </div>
            );
          })}
        </div>
      )}

      {/* Text overlays (virtual text clips rendered without forcing canvas mode) */}
      {activeTextOverlays.length > 0 && (
        <div
          className="absolute inset-0 pointer-events-none"
          data-testid="proxy-text-overlay-layer"
        >
          {activeTextOverlays.map(({ clip, trackIndex, textData }) => {
            const translateX =
              textData.style.alignment === 'left'
                ? '0%'
                : textData.style.alignment === 'right'
                  ? '-100%'
                  : '-50%';
            const rotation = Number.isFinite(textData.rotation) ? textData.rotation : 0;
            const fontSize = Math.max(10, textData.style.fontSize * 0.75);
            const opacity = Math.max(0, Math.min(1, textData.opacity * clip.opacity));
            const textShadow = buildTextOverlayShadow(textData);
            const hasBackground = !!textData.style.backgroundColor;
            const backgroundPadding = Math.max(0, textData.style.backgroundPadding * 0.75);

            return (
              <div
                key={clip.id}
                data-testid={`proxy-text-overlay-${clip.id}`}
                className="absolute select-none pointer-events-none"
                style={{
                  left: `${clampPercent(textData.position.x * 100, 50)}%`,
                  top: `${clampPercent(textData.position.y * 100, 50)}%`,
                  transform: `translate(${translateX}, -50%) rotate(${rotation}deg)`,
                  transformOrigin:
                    textData.style.alignment === 'left'
                      ? 'left center'
                      : textData.style.alignment === 'right'
                        ? 'right center'
                        : 'center center',
                  color: resolveTextColor(textData.style.color, '#FFFFFF'),
                  fontFamily: textData.style.fontFamily,
                  fontSize: `${fontSize}px`,
                  fontWeight: textData.style.bold ? 700 : 400,
                  fontStyle: textData.style.italic ? 'italic' : 'normal',
                  textAlign: textData.style.alignment,
                  textDecoration: textData.style.underline ? 'underline' : 'none',
                  lineHeight: textData.style.lineHeight,
                  letterSpacing: `${textData.style.letterSpacing}px`,
                  whiteSpace: 'pre-line',
                  backgroundColor: hasBackground
                    ? resolveTextColor(textData.style.backgroundColor, 'transparent')
                    : 'transparent',
                  borderRadius: hasBackground ? '4px' : '0',
                  padding: hasBackground ? `${backgroundPadding}px` : '0',
                  textShadow,
                  opacity,
                  zIndex:
                    (sequence.tracks.length - trackIndex) * TRACK_LAYER_Z_INDEX_STEP +
                    TEXT_LAYER_Z_INDEX_OFFSET,
                }}
              >
                {textData.content}
              </div>
            );
          })}
        </div>
      )}

      {/* Controls Overlay */}
      {showControls && (
        <div
          className="absolute bottom-0 left-0 right-0 pointer-events-auto"
          data-testid="proxy-controls-layer"
          style={{ zIndex: controlsZIndex }}
        >
          <PlayerControls
            currentTime={currentTime}
            duration={duration}
            isPlaying={isPlaying}
            volume={volume}
            isMuted={isMuted}
            buffered={buffered}
            isFullscreen={isFullscreen}
            fps={sequenceFps}
            playbackRate={playbackRate}
            onPlayPause={handlePlayPause}
            onSeek={handleSeek}
            onVolumeChange={handleVolumeChange}
            onMuteToggle={handleMuteToggle}
            onFullscreenToggle={handleFullscreenToggle}
            onPlaybackRateChange={setPlaybackRate}
          />
        </div>
      )}
    </div>
  );
}
