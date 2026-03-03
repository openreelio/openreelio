/**
 * usePreviewMode Hook
 *
 * Determines the optimal preview mode based on both proxy readiness and
 * whether the active frame can be represented by the proxy video renderer.
 */

import { useMemo, useRef } from 'react';
import { isTextClip, type Sequence, type Asset, type Clip, type Track } from '@/types';
import { isClipActiveAtTime } from '@/utils/clipTiming';
import { isCaptionLikeClip } from '@/utils/captionClip';

// =============================================================================
// Types
// =============================================================================

export type PreviewMode = 'video' | 'canvas';

export interface PreviewModeResult {
  /** The recommended preview mode */
  mode: PreviewMode;
  /** Human-readable reason for the mode selection */
  reason: string;
  /** Whether any proxies are currently generating */
  hasGeneratingProxy: boolean;
  /** Count of clips that would benefit from proxy */
  clipsNeedingProxy: number;
}

export interface UsePreviewModeOptions {
  /** The active sequence */
  sequence: Sequence | null;
  /** Assets map for looking up proxy status */
  assets: Map<string, Asset>;
  /** Current playhead time in seconds */
  currentTime: number;
}

// =============================================================================
// Helper Functions
// =============================================================================

interface ActiveClipInfo {
  clip: Clip;
  track: Track;
  asset: Asset | null;
}

const FLOAT_EPSILON = 0.0001;
const ACTIVE_CLIP_EPSILON_SEC = 1 / 240;
const NO_CLIP_HYSTERESIS_SEC = 1 / 30;
const URI_SCHEME_PATTERN = /^[a-zA-Z][a-zA-Z\d+\-.]*:/;

function nearlyEqual(a: number, b: number): boolean {
  return Math.abs(a - b) <= FLOAT_EPSILON;
}

/**
 * Find all active clips at the given timeline position.
 */
function findActiveClips(
  sequence: Sequence,
  currentTime: number,
  assets: Map<string, Asset>,
): ActiveClipInfo[] {
  const activeClips: ActiveClipInfo[] = [];

  for (const track of sequence.tracks) {
    // Skip muted or hidden tracks
    if (track.muted || !track.visible) continue;

    for (const clip of track.clips) {
      if (isClipActiveAtTime(clip, currentTime, ACTIVE_CLIP_EPSILON_SEC)) {
        activeClips.push({
          clip,
          track,
          asset: assets.get(clip.assetId) ?? null,
        });
      }
    }
  }

  return activeClips;
}

/**
 * Check if a video asset has a ready proxy.
 */
function hasReadyProxy(asset: Asset): boolean {
  return asset.proxyStatus === 'ready' && !!asset.proxyUrl;
}

function isWindowsAbsolutePath(path: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(path);
}

function hasPlayableVideoSource(asset: Asset): boolean {
  const source = asset.uri?.trim();
  if (!source) {
    return false;
  }

  const hasUnsupportedUriScheme =
    URI_SCHEME_PATTERN.test(source) &&
    !isWindowsAbsolutePath(source) &&
    !source.startsWith('http://') &&
    !source.startsWith('https://') &&
    !source.startsWith('file://') &&
    !source.startsWith('asset://');

  return !hasUnsupportedUriScheme;
}

/**
 * Check if an asset is a video that could benefit from proxy.
 */
function isVideoAsset(asset: Asset): boolean {
  return asset.kind === 'video';
}

/**
 * Check whether a clip uses the identity transform expected by proxy mode.
 */
function hasIdentityTransform(clip: Clip): boolean {
  const { transform } = clip;

  return (
    nearlyEqual(transform.position.x, 0.5) &&
    nearlyEqual(transform.position.y, 0.5) &&
    nearlyEqual(transform.scale.x, 1) &&
    nearlyEqual(transform.scale.y, 1) &&
    nearlyEqual(transform.rotationDeg, 0) &&
    nearlyEqual(transform.anchor.x, 0.5) &&
    nearlyEqual(transform.anchor.y, 0.5)
  );
}

/**
 * Return a canvas-only reason when an active clip needs composition features
 * unsupported by proxy video mode.
 */
function getCanvasFallbackReason({ clip, track, asset }: ActiveClipInfo): string | null {
  // Audio tracks do not affect visual mode selection.
  if (track.kind === 'audio') {
    return null;
  }

  // Caption-style overlays are supported in video mode via HTML overlay rendering.
  if (isCaptionLikeClip(track, clip, asset)) {
    return null;
  }

  // Text clips (virtual assets) are rendered as HTML overlays in video mode.
  // Keep blend mode guard because proxy text overlays do not support blend compositing.
  if (isTextClip(clip.assetId)) {
    if (track.blendMode !== 'normal') {
      return 'Track blend mode requires canvas compositing';
    }
    return null;
  }

  if (track.kind !== 'video') {
    return 'Overlay/caption compositing requires canvas mode';
  }

  if (!asset) {
    return 'Active clip asset is unavailable - using frame extraction';
  }

  if (!isVideoAsset(asset)) {
    return 'Active non-video clip requires canvas compositing';
  }

  if (track.blendMode !== 'normal') {
    return 'Track blend mode requires canvas compositing';
  }

  if (!hasIdentityTransform(clip)) {
    return 'Clip transform requires canvas compositing';
  }

  if (!nearlyEqual(clip.opacity, 1)) {
    return 'Clip opacity compositing requires canvas mode';
  }

  if (clip.effects.length > 0) {
    return 'Clip effects require canvas compositing';
  }

  return null;
}

// =============================================================================
// Hook
// =============================================================================

export function usePreviewMode({
  sequence,
  assets,
  currentTime,
}: UsePreviewModeOptions): PreviewModeResult {
  const previousResultRef = useRef<PreviewModeResult | null>(null);
  const previousTimeRef = useRef<number | null>(null);

  return useMemo(() => {
    // No sequence = canvas mode (show empty state)
    if (!sequence) {
      const result: PreviewModeResult = {
        mode: 'canvas',
        reason: 'No sequence loaded',
        hasGeneratingProxy: false,
        clipsNeedingProxy: 0,
      };
      previousResultRef.current = result;
      previousTimeRef.current = currentTime;
      return result;
    }

    // Find all active clips at current time
    const activeClips = findActiveClips(sequence, currentTime, assets);

    // No clips at playhead = canvas mode (show black frame)
    if (activeClips.length === 0) {
      const previousResult = previousResultRef.current;
      const previousTime = previousTimeRef.current;

      if (
        previousResult &&
        previousTime !== null &&
        previousResult.mode === 'video' &&
        Math.abs(currentTime - previousTime) <= NO_CLIP_HYSTERESIS_SEC
      ) {
        const stabilizedResult: PreviewModeResult = {
          ...previousResult,
          reason: 'Stabilizing mode at clip boundary',
        };
        previousResultRef.current = stabilizedResult;
        previousTimeRef.current = currentTime;
        return stabilizedResult;
      }

      const result: PreviewModeResult = {
        mode: 'canvas',
        reason: 'No clips at playhead',
        hasGeneratingProxy: false,
        clipsNeedingProxy: 0,
      };
      previousResultRef.current = result;
      previousTimeRef.current = currentTime;
      return result;
    }

    // If any active visual clip needs compositing, force canvas mode.
    const canvasFallbackReason = activeClips
      .map((activeClip) => getCanvasFallbackReason(activeClip))
      .find((reason): reason is string => reason !== null);

    if (canvasFallbackReason) {
      const result: PreviewModeResult = {
        mode: 'canvas',
        reason: canvasFallbackReason,
        hasGeneratingProxy: false,
        clipsNeedingProxy: 0,
      };
      previousResultRef.current = result;
      previousTimeRef.current = currentTime;
      return result;
    }

    // Analyze proxy readiness for active video clips on visual tracks.
    const videoClips = activeClips.filter(
      (activeClip): activeClip is ActiveClipInfo & { asset: Asset } =>
        activeClip.track.kind === 'video' &&
        !isCaptionLikeClip(activeClip.track, activeClip.clip, activeClip.asset) &&
        activeClip.asset !== null &&
        isVideoAsset(activeClip.asset),
    );

    if (videoClips.length === 0) {
      const hasRenderableTextOverlay = activeClips.some(
        ({ clip, track }) =>
          isTextClip(clip.assetId) && track.kind !== 'audio' && track.blendMode === 'normal',
      );

      if (hasRenderableTextOverlay) {
        const result: PreviewModeResult = {
          mode: 'video',
          reason: 'Text overlays can render in video mode',
          hasGeneratingProxy: false,
          clipsNeedingProxy: 0,
        };
        previousResultRef.current = result;
        previousTimeRef.current = currentTime;
        return result;
      }

      const result: PreviewModeResult = {
        mode: 'canvas',
        reason: 'No video clips (images use canvas)',
        hasGeneratingProxy: false,
        clipsNeedingProxy: 0,
      };
      previousResultRef.current = result;
      previousTimeRef.current = currentTime;
      return result;
    }

    const clipStatuses = videoClips.map(({ asset }) => ({
      hasProxy: hasReadyProxy(asset),
      hasPlayableSource: hasPlayableVideoSource(asset),
      isGenerating: asset.proxyStatus === 'generating',
      needsProxy: asset.proxyStatus !== 'notNeeded',
    }));

    const allHaveProxy = clipStatuses.every((status) => status.hasProxy);
    const allPlayableInVideoMode = clipStatuses.every(
      (status) => status.hasProxy || status.hasPlayableSource,
    );
    const anyGenerating = clipStatuses.some((status) => status.isGenerating);
    const clipsNeedingProxy = clipStatuses.filter(
      (status) => status.needsProxy && !status.hasProxy,
    ).length;

    if (allHaveProxy) {
      const result: PreviewModeResult = {
        mode: 'video',
        reason: 'All video clips have ready proxies',
        hasGeneratingProxy: false,
        clipsNeedingProxy: 0,
      };
      previousResultRef.current = result;
      previousTimeRef.current = currentTime;
      return result;
    }

    if (allPlayableInVideoMode) {
      const result: PreviewModeResult = {
        mode: 'video',
        reason: anyGenerating
          ? 'Using source media while proxies generate'
          : 'Using source media for clips without ready proxies',
        hasGeneratingProxy: anyGenerating,
        clipsNeedingProxy,
      };
      previousResultRef.current = result;
      previousTimeRef.current = currentTime;
      return result;
    }

    const result: PreviewModeResult = {
      mode: 'canvas',
      reason: anyGenerating
        ? 'Proxies generating and some clips have no playable source - using frame extraction'
        : 'Some clips have no playable source and missing proxy - using frame extraction',
      hasGeneratingProxy: anyGenerating,
      clipsNeedingProxy,
    };
    previousResultRef.current = result;
    previousTimeRef.current = currentTime;
    return result;
  }, [sequence, assets, currentTime]);
}
