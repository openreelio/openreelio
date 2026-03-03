import { useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { Sequence, TextClipData } from '@/types';
import { isTextClip } from '@/types';
import { createLogger } from '@/services/logger';
import { isTauriRuntime } from '@/services/framePaths';
import { useProjectStore } from '@/stores/projectStore';

interface TextClipDataDto {
  sequenceId: string;
  trackId: string;
  clipId: string;
  textData: TextClipData;
}

const logger = createLogger('useSequenceTextClipData');

/**
 * Resolves TextClipData payloads for all text clips in a sequence.
 *
 * Frontend sequence snapshots only include effect IDs, so this hook fetches
 * resolved text payloads from backend effect state for accurate preview/inspector UI.
 */
export function useSequenceTextClipData(
  sequence: Sequence | null | undefined,
): ReadonlyMap<string, TextClipData> {
  const [entries, setEntries] = useState<TextClipDataDto[]>([]);
  const stateVersion = useProjectStore((state) => state.stateVersion);
  const sequenceId = sequence?.id ?? null;

  const textClipFetchKey = useMemo(() => {
    if (!sequence) {
      return null;
    }

    const clipKeys: string[] = [];
    for (const track of sequence.tracks) {
      for (const clip of track.clips) {
        if (!isTextClip(clip.assetId)) {
          continue;
        }

        clipKeys.push(`${clip.id}:${clip.effects.join(',')}`);
      }
    }

    if (clipKeys.length === 0) {
      return `${sequence.id}:none`;
    }

    return `${sequence.id}:${clipKeys.join('|')}`;
  }, [sequence]);

  useEffect(() => {
    let cancelled = false;

    if (!sequenceId || !isTauriRuntime()) {
      setEntries([]);
      return () => {
        cancelled = true;
      };
    }

    if (textClipFetchKey === `${sequenceId}:none`) {
      setEntries([]);
      return () => {
        cancelled = true;
      };
    }

    // stateVersion invalidates resolved text payload cache even when effect ID lists
    // remain unchanged (e.g. UpdateTextClip mutates effect params in place).

    void invoke<TextClipDataDto[]>('get_sequence_text_clip_data', {
      sequenceId,
    })
      .then((nextEntries) => {
        if (!cancelled) {
          setEntries(nextEntries);
        }
      })
      .catch((error) => {
        logger.warn('Failed to resolve text clip payloads', {
          sequenceId,
          error: error instanceof Error ? error.message : String(error),
        });
        if (!cancelled) {
          setEntries([]);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [sequenceId, textClipFetchKey, stateVersion]);

  return useMemo(() => {
    const map = new Map<string, TextClipData>();
    for (const entry of entries) {
      map.set(entry.clipId, entry.textData);
    }
    return map;
  }, [entries]);
}
