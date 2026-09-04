/**
 * useSyncPlaybackFps
 *
 * Keeps the shared {@link playbackController} on the active sequence's frame
 * rate. The controller owns the frame grid every `seek(..., { frameAccurate })`
 * and every one-frame step quantises to, and it defaults to 30 — which is wrong
 * for any sequence that declares another rate. Mounting this hook once in the
 * editor makes the sequence the single owner of that grid.
 *
 * @module hooks/useSyncPlaybackFps
 */

import { useEffect } from 'react';
import { playbackController } from '@/services/PlaybackController';
import { useSequenceFps } from './useSequenceFps';

/**
 * Pushes the active sequence's frame rate into the playback controller.
 *
 * @returns The frame rate that was applied, for callers that also need it
 */
export function useSyncPlaybackFps(): number {
  const fps = useSequenceFps();

  useEffect(() => {
    playbackController.setConfig({ fps });
  }, [fps]);

  return fps;
}
