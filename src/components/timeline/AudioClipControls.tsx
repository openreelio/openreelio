import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import type { Clip } from '@/types';
import {
  CLIP_AUDIO_MAX_VOLUME_DB,
  CLIP_AUDIO_MIN_VOLUME_DB,
  clampClipVolumeDb,
  getClipTimelineDurationSec,
  normalizeClipFadeDurations,
} from '@/utils/clipAudio';
import { TRACK_HEIGHT } from './constants';

export interface ClipAudioSettingsPatch {
  volumeDb?: number;
  pan?: number;
  muted?: boolean;
  fadeInSec?: number;
  fadeOutSec?: number;
}

interface AudioClipControlsProps {
  clip: Clip;
  width: number;
  disabled?: boolean;
  onCommit?: (clipId: string, patch: ClipAudioSettingsPatch) => void | Promise<void>;
}

type AudioDragType = 'volume' | 'fade-in' | 'fade-out';

interface DraftAudioSettings {
  volumeDb: number;
  fadeInSec: number;
  fadeOutSec: number;
}

interface AudioDragState {
  type: AudioDragType;
  startClientX: number;
  startClientY: number;
  startVolumeDb: number;
  startFadeInSec: number;
  startFadeOutSec: number;
  clipDurationSec: number;
  widthPx: number;
}

const MIN_EDITABLE_WIDTH_PX = 40;
const LINE_PADDING_TOP_PX = 6;
const LINE_PADDING_BOTTOM_PX = 6;
const VOLUME_PRECISION = 0.1;
const FADE_PRECISION = 0.01;
const COMPARISON_EPSILON = 1e-3;

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function roundToPrecision(value: number, precision: number): number {
  if (precision <= 0 || !Number.isFinite(precision)) {
    return value;
  }
  const factor = 1 / precision;
  return Math.round(value * factor) / factor;
}

function areNearlyEqual(a: number, b: number, epsilon = COMPARISON_EPSILON): boolean {
  return Math.abs(a - b) <= epsilon;
}

function volumeDbToLineY(volumeDb: number): number {
  const clampedVolume = clampClipVolumeDb(volumeDb);
  const availableHeight = Math.max(1, TRACK_HEIGHT - LINE_PADDING_TOP_PX - LINE_PADDING_BOTTOM_PX);
  const normalized =
    (CLIP_AUDIO_MAX_VOLUME_DB - clampedVolume) /
    (CLIP_AUDIO_MAX_VOLUME_DB - CLIP_AUDIO_MIN_VOLUME_DB);
  return LINE_PADDING_TOP_PX + normalized * availableHeight;
}

function volumeDeltaToDb(initialVolumeDb: number, deltaY: number): number {
  const availableHeight = Math.max(1, TRACK_HEIGHT - LINE_PADDING_TOP_PX - LINE_PADDING_BOTTOM_PX);
  const dbPerPixel = (CLIP_AUDIO_MAX_VOLUME_DB - CLIP_AUDIO_MIN_VOLUME_DB) / availableHeight;
  return clampClipVolumeDb(initialVolumeDb - deltaY * dbPerPixel);
}

function getInitialAudioSettings(clip: Clip): DraftAudioSettings {
  const duration = getClipTimelineDurationSec(clip);
  const { fadeInSec, fadeOutSec } = normalizeClipFadeDurations(
    clip.audio?.fadeInSec ?? 0,
    clip.audio?.fadeOutSec ?? 0,
    duration,
  );

  return {
    volumeDb: clampClipVolumeDb(clip.audio?.volumeDb ?? 0),
    fadeInSec,
    fadeOutSec,
  };
}

export function AudioClipControls({
  clip,
  width,
  disabled = false,
  onCommit,
}: AudioClipControlsProps): JSX.Element | null {
  const clipDurationSec = useMemo(() => getClipTimelineDurationSec(clip), [clip]);
  const initialAudioSettings = useMemo(() => getInitialAudioSettings(clip), [clip]);

  const [activeDrag, setActiveDrag] = useState<AudioDragType | null>(null);
  const [draftAudioSettings, setDraftAudioSettings] =
    useState<DraftAudioSettings>(initialAudioSettings);

  const dragStateRef = useRef<AudioDragState | null>(null);
  const draftAudioRef = useRef<DraftAudioSettings>(initialAudioSettings);

  useEffect(() => {
    draftAudioRef.current = draftAudioSettings;
  }, [draftAudioSettings]);

  useEffect(() => {
    if (activeDrag === null) {
      setDraftAudioSettings(initialAudioSettings);
    }
  }, [activeDrag, initialAudioSettings]);

  const beginDrag = useCallback(
    (type: AudioDragType) => (event: MouseEvent<HTMLElement>) => {
      if (disabled || width < MIN_EDITABLE_WIDTH_PX || clipDurationSec <= 0) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      dragStateRef.current = {
        type,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startVolumeDb: initialAudioSettings.volumeDb,
        startFadeInSec: initialAudioSettings.fadeInSec,
        startFadeOutSec: initialAudioSettings.fadeOutSec,
        clipDurationSec,
        widthPx: width,
      };

      draftAudioRef.current = initialAudioSettings;
      setDraftAudioSettings(initialAudioSettings);
      setActiveDrag(type);
    },
    [clipDurationSec, disabled, initialAudioSettings, width],
  );

  useEffect(() => {
    if (!activeDrag) {
      return;
    }

    const handleMouseMove = (event: globalThis.MouseEvent): void => {
      const dragState = dragStateRef.current;
      if (!dragState) {
        return;
      }

      if (dragState.type === 'volume') {
        const deltaY = event.clientY - dragState.startClientY;
        setDraftAudioSettings((prev) => ({
          ...prev,
          volumeDb: volumeDeltaToDb(dragState.startVolumeDb, deltaY),
        }));
        return;
      }

      const deltaX = event.clientX - dragState.startClientX;
      const secPerPixel = dragState.clipDurationSec / Math.max(1, dragState.widthPx);
      const deltaSec = deltaX * secPerPixel;

      if (dragState.type === 'fade-in') {
        setDraftAudioSettings((prev) => {
          const maxFadeIn = Math.max(0, dragState.clipDurationSec - prev.fadeOutSec);
          return {
            ...prev,
            fadeInSec: clampNumber(dragState.startFadeInSec + deltaSec, 0, maxFadeIn),
          };
        });
        return;
      }

      setDraftAudioSettings((prev) => {
        const maxFadeOut = Math.max(0, dragState.clipDurationSec - prev.fadeInSec);
        return {
          ...prev,
          fadeOutSec: clampNumber(dragState.startFadeOutSec - deltaSec, 0, maxFadeOut),
        };
      });
    };

    const handleMouseUp = (): void => {
      const dragState = dragStateRef.current;
      const finalSettings = draftAudioRef.current;

      dragStateRef.current = null;
      setActiveDrag(null);

      if (!dragState || !onCommit) {
        return;
      }

      const patch: ClipAudioSettingsPatch = {};

      if (!areNearlyEqual(finalSettings.volumeDb, dragState.startVolumeDb)) {
        patch.volumeDb = roundToPrecision(finalSettings.volumeDb, VOLUME_PRECISION);
      }
      if (!areNearlyEqual(finalSettings.fadeInSec, dragState.startFadeInSec)) {
        patch.fadeInSec = roundToPrecision(finalSettings.fadeInSec, FADE_PRECISION);
      }
      if (!areNearlyEqual(finalSettings.fadeOutSec, dragState.startFadeOutSec)) {
        patch.fadeOutSec = roundToPrecision(finalSettings.fadeOutSec, FADE_PRECISION);
      }

      if (Object.keys(patch).length > 0) {
        void onCommit(clip.id, patch);
      }
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [activeDrag, clip.id, onCommit]);

  if (width < MIN_EDITABLE_WIDTH_PX || clipDurationSec <= 0) {
    return null;
  }

  const fadeInPx =
    clipDurationSec > 0
      ? clampNumber((draftAudioSettings.fadeInSec / clipDurationSec) * width, 0, width)
      : 0;
  const fadeOutPx =
    clipDurationSec > 0
      ? clampNumber(width - (draftAudioSettings.fadeOutSec / clipDurationSec) * width, 0, width)
      : width;
  const volumeLineY = volumeDbToLineY(draftAudioSettings.volumeDb);
  const baselineY = TRACK_HEIGHT - 4;

  const readoutText =
    activeDrag === 'fade-in'
      ? `Fade In ${draftAudioSettings.fadeInSec.toFixed(2)}s`
      : activeDrag === 'fade-out'
        ? `Fade Out ${draftAudioSettings.fadeOutSec.toFixed(2)}s`
        : `${draftAudioSettings.volumeDb.toFixed(1)} dB`;

  return (
    <div data-testid="audio-clip-controls" className="absolute inset-0 z-20 pointer-events-none">
      <svg className="absolute inset-0 h-full w-full" viewBox={`0 0 ${width} ${TRACK_HEIGHT}`}>
        <polyline
          points={`0,${baselineY} ${fadeInPx},${volumeLineY} ${fadeOutPx},${volumeLineY} ${width},${baselineY}`}
          fill="none"
          stroke="rgba(74, 222, 128, 0.8)"
          strokeWidth="1.5"
        />
        <line
          x1="0"
          y1={volumeLineY}
          x2={width}
          y2={volumeLineY}
          stroke="rgba(52, 211, 153, 0.35)"
          strokeWidth="1"
          strokeDasharray="3 3"
        />
      </svg>

      <div className="absolute right-2 bottom-1 rounded bg-black/45 px-1.5 py-0.5 text-[10px] text-emerald-100">
        {draftAudioSettings.volumeDb.toFixed(1)} dB
      </div>

      {activeDrag && (
        <div
          data-testid="audio-edit-readout"
          className="absolute left-1/2 top-1 -translate-x-1/2 rounded bg-black/75 px-2 py-0.5 text-[10px] text-emerald-100"
        >
          {readoutText}
        </div>
      )}

      <button
        type="button"
        tabIndex={-1}
        aria-label="Adjust clip volume"
        data-testid="audio-volume-handle"
        className="absolute left-3 right-3 h-3 -translate-y-1/2 cursor-ns-resize rounded border border-emerald-300/50 bg-emerald-300/15 pointer-events-auto"
        style={{ top: `${volumeLineY}px` }}
        onMouseDown={beginDrag('volume')}
      />

      <button
        type="button"
        tabIndex={-1}
        aria-label="Adjust fade in"
        data-testid="audio-fade-in-handle"
        className="absolute top-0 h-5 w-4 -translate-x-1/2 cursor-ew-resize pointer-events-auto"
        style={{ left: `${fadeInPx}px` }}
        onMouseDown={beginDrag('fade-in')}
      >
        <span className="pointer-events-none absolute left-1/2 top-1.5 h-2 w-2 -translate-x-1/2 rotate-45 rounded-[1px] bg-emerald-300 shadow" />
      </button>

      <button
        type="button"
        tabIndex={-1}
        aria-label="Adjust fade out"
        data-testid="audio-fade-out-handle"
        className="absolute top-0 h-5 w-4 -translate-x-1/2 cursor-ew-resize pointer-events-auto"
        style={{ left: `${fadeOutPx}px` }}
        onMouseDown={beginDrag('fade-out')}
      >
        <span className="pointer-events-none absolute left-1/2 top-1.5 h-2 w-2 -translate-x-1/2 rotate-45 rounded-[1px] bg-emerald-300 shadow" />
      </button>
    </div>
  );
}
