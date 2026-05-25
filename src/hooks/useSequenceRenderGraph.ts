import { useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { RenderGraph } from '@/bindings';
import type { Sequence } from '@/types';
import { createLogger } from '@/services/logger';
import { isTauriRuntime } from '@/services/framePaths';
import { useProjectStore } from '@/stores/projectStore';

const logger = createLogger('useSequenceRenderGraph');

/**
 * Resolves the backend render graph for a sequence.
 *
 * The graph is the shared preview/export contract. UI renderers should prefer
 * its normalized layer payloads over independently parsing clips/effects.
 */
export function useSequenceRenderGraph(sequence: Sequence | null | undefined): RenderGraph | null {
  const [renderGraph, setRenderGraph] = useState<RenderGraph | null>(null);
  const stateVersion = useProjectStore((state) => state.stateVersion);
  const sequenceId = sequence?.id ?? null;

  const graphFetchKey = useMemo(() => {
    if (!sequence) {
      return null;
    }

    const clipKeys: string[] = [];
    for (const track of sequence.tracks) {
      clipKeys.push(`${track.id}:${track.kind}:${track.visible}:${track.muted}`);
      for (const clip of track.clips) {
        clipKeys.push(
          [
            clip.id,
            clip.assetId,
            clip.place.timelineInSec,
            clip.place.durationSec,
            clip.range.sourceInSec,
            clip.range.sourceOutSec,
            clip.transform.position.x,
            clip.transform.position.y,
            clip.transform.scale.x,
            clip.transform.scale.y,
            clip.transform.rotationDeg,
            clip.transform.anchor.x,
            clip.transform.anchor.y,
            clip.opacity,
            clip.enabled ?? true,
            clip.label ?? '',
            clip.captionStyle ? JSON.stringify(clip.captionStyle) : '',
            clip.captionPosition ? JSON.stringify(clip.captionPosition) : '',
            clip.effects.join(','),
          ].join(':'),
        );
      }
    }

    return `${sequence.id}:${clipKeys.join('|')}`;
  }, [sequence]);

  useEffect(() => {
    let cancelled = false;

    if (!sequenceId || !isTauriRuntime()) {
      setRenderGraph(null);
      return () => {
        cancelled = true;
      };
    }

    void invoke<RenderGraph>('get_sequence_render_graph', { sequenceId })
      .then((nextGraph) => {
        if (!cancelled) {
          setRenderGraph(nextGraph);
        }
      })
      .catch((error) => {
        logger.warn('Failed to resolve sequence render graph', {
          sequenceId,
          error: error instanceof Error ? error.message : String(error),
        });
        if (!cancelled) {
          setRenderGraph(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [sequenceId, graphFetchKey, stateVersion]);

  return renderGraph;
}
