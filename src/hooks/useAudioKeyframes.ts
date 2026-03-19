/**
 * useAudioKeyframes Hook
 *
 * Provides CRUD operations for audio volume keyframes via IPC commands,
 * plus coordinate conversion utilities for the rubber band UI.
 */

import { useCallback } from 'react';
import { useProjectStore } from '@/stores/projectStore';
import type { AudioKeyframe, KeyframeInterpolation, CommandResult } from '@/types';
import {
  CLIP_AUDIO_MIN_VOLUME_DB,
  CLIP_AUDIO_MAX_VOLUME_DB,
} from '@/utils/clipAudio';

// =============================================================================
// Coordinate Conversion
// =============================================================================

const LINE_PADDING_TOP_PX = 6;
const LINE_PADDING_BOTTOM_PX = 6;

/** Convert a dB value to a Y pixel position within a given track height */
export function dbToY(valueDb: number, trackHeight: number): number {
  const clamped = Math.min(CLIP_AUDIO_MAX_VOLUME_DB, Math.max(CLIP_AUDIO_MIN_VOLUME_DB, valueDb));
  const available = Math.max(1, trackHeight - LINE_PADDING_TOP_PX - LINE_PADDING_BOTTOM_PX);
  const normalized =
    (CLIP_AUDIO_MAX_VOLUME_DB - clamped) /
    (CLIP_AUDIO_MAX_VOLUME_DB - CLIP_AUDIO_MIN_VOLUME_DB);
  return LINE_PADDING_TOP_PX + normalized * available;
}

/** Convert a Y pixel position back to a dB value */
export function yToDb(y: number, trackHeight: number): number {
  const available = Math.max(1, trackHeight - LINE_PADDING_TOP_PX - LINE_PADDING_BOTTOM_PX);
  const normalized = Math.max(0, Math.min(1, (y - LINE_PADDING_TOP_PX) / available));
  const db = CLIP_AUDIO_MAX_VOLUME_DB - normalized * (CLIP_AUDIO_MAX_VOLUME_DB - CLIP_AUDIO_MIN_VOLUME_DB);
  return Math.round(db * 10) / 10;
}

/** Convert a time offset (seconds from clip start) to X pixel position */
export function timeToX(timeOffset: number, clipDurationSec: number, widthPx: number): number {
  if (clipDurationSec <= 0) return 0;
  return (timeOffset / clipDurationSec) * widthPx;
}

/** Convert an X pixel position to a time offset (seconds from clip start) */
export function xToTime(x: number, clipDurationSec: number, widthPx: number): number {
  if (widthPx <= 0) return 0;
  const time = (x / widthPx) * clipDurationSec;
  return Math.max(0, Math.min(clipDurationSec, Math.round(time * 1000) / 1000));
}

// =============================================================================
// Interpolation
// =============================================================================

/** Interpolate the volume at a given time offset within a sorted keyframe list */
export function interpolateKeyframes(keyframes: AudioKeyframe[], timeOffset: number): number {
  if (keyframes.length === 0) return 0;
  if (keyframes.length === 1) return keyframes[0].valueDb;

  if (timeOffset <= keyframes[0].timeOffset) return keyframes[0].valueDb;
  if (timeOffset >= keyframes[keyframes.length - 1].timeOffset) {
    return keyframes[keyframes.length - 1].valueDb;
  }

  for (let i = 0; i < keyframes.length - 1; i++) {
    const curr = keyframes[i];
    const next = keyframes[i + 1];
    if (timeOffset >= curr.timeOffset && timeOffset <= next.timeOffset) {
      if (curr.interpolation === 'hold') return curr.valueDb;
      const t =
        next.timeOffset === curr.timeOffset
          ? 1
          : (timeOffset - curr.timeOffset) / (next.timeOffset - curr.timeOffset);
      return curr.valueDb + t * (next.valueDb - curr.valueDb);
    }
  }

  return keyframes[keyframes.length - 1].valueDb;
}

// =============================================================================
// Hook
// =============================================================================

interface UseAudioKeyframesParams {
  sequenceId: string;
  trackId: string;
  clipId: string;
}

export interface AudioKeyframeActions {
  addKeyframe: (timeOffset: number, valueDb: number, interpolation?: KeyframeInterpolation) => Promise<CommandResult>;
  removeKeyframe: (keyframeIndex: number) => Promise<CommandResult>;
  moveKeyframe: (keyframeIndex: number, newTimeOffset: number) => Promise<CommandResult>;
  setKeyframeValue: (keyframeIndex: number, valueDb: number, interpolation?: KeyframeInterpolation) => Promise<CommandResult>;
}

export function useAudioKeyframes({
  sequenceId,
  trackId,
  clipId,
}: UseAudioKeyframesParams): AudioKeyframeActions {
  const executeCommand = useProjectStore((state) => state.executeCommand);

  const addKeyframe = useCallback(
    async (
      timeOffset: number,
      valueDb: number,
      interpolation: KeyframeInterpolation = 'linear',
    ): Promise<CommandResult> => {
      return executeCommand({
        type: 'AddAudioKeyframe',
        payload: {
          sequenceId,
          trackId,
          clipId,
          timeOffset,
          valueDb,
          interpolation,
        },
      });
    },
    [executeCommand, sequenceId, trackId, clipId],
  );

  const removeKeyframe = useCallback(
    async (keyframeIndex: number): Promise<CommandResult> => {
      return executeCommand({
        type: 'RemoveAudioKeyframe',
        payload: { sequenceId, trackId, clipId, keyframeIndex },
      });
    },
    [executeCommand, sequenceId, trackId, clipId],
  );

  const moveKeyframe = useCallback(
    async (keyframeIndex: number, newTimeOffset: number): Promise<CommandResult> => {
      return executeCommand({
        type: 'MoveAudioKeyframe',
        payload: { sequenceId, trackId, clipId, keyframeIndex, newTimeOffset },
      });
    },
    [executeCommand, sequenceId, trackId, clipId],
  );

  const setKeyframeValue = useCallback(
    async (
      keyframeIndex: number,
      valueDb: number,
      interpolation?: KeyframeInterpolation,
    ): Promise<CommandResult> => {
      return executeCommand({
        type: 'SetAudioKeyframeValue',
        payload: {
          sequenceId,
          trackId,
          clipId,
          keyframeIndex,
          valueDb,
          ...(interpolation != null ? { interpolation } : {}),
        },
      });
    },
    [executeCommand, sequenceId, trackId, clipId],
  );

  return { addKeyframe, removeKeyframe, moveKeyframe, setKeyframeValue };
}
