/**
 * Loads an Editing Style Document and computes comparison metrics against the
 * active timeline's primary video track.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { commands, type EditingStyleDocument } from '@/bindings';
import { useProjectStore } from '@/stores';
import type { PacingDataPoint } from '@/components/features/comparison/PacingCurveChart';
import type { TransitionDiffRow } from '@/components/features/comparison/TransitionDiffTable';
import {
  buildOutputStructureSegments,
  buildTransitionDiffCounts,
  calculatePearsonCorrelation,
  derivePacingCurve,
  getPrimaryTrackClips,
  type OutputStructureSegment,
} from '@/utils/referenceComparison';

export interface UseReferenceComparisonReturn {
  /** Loaded ESD document */
  esd: EditingStyleDocument | null;
  /** Reference pacing curve from ESD */
  referenceCurve: PacingDataPoint[];
  /** Output pacing curve derived from the current primary video track */
  outputCurve: PacingDataPoint[];
  /** Output structure segments used for the bottom comparison bar */
  outputStructure: OutputStructureSegment[];
  /** Pearson correlation between reference and output curves */
  correlation: number;
  /** Transition type differences */
  transitionDiffs: TransitionDiffRow[];
  /** Whether ESD data is currently loading */
  isLoading: boolean;
  /** Error message if loading failed */
  error: string | null;
}

const DEBOUNCE_MS = 300;

function sortEsdSummariesByNewest(
  left: { createdAt: string },
  right: { createdAt: string },
): number {
  return Date.parse(right.createdAt) - Date.parse(left.createdAt);
}

async function resolveEsdDocument(explicitEsdId?: string): Promise<EditingStyleDocument | null> {
  let resolvedEsdId = explicitEsdId;
  const requestedSpecificEsd = Boolean(explicitEsdId);

  if (!resolvedEsdId) {
    const listResult = await commands.listEsds();
    if (listResult.status === 'error') {
      throw new Error(String(listResult.error));
    }

    const latestEsd = [...listResult.data].sort(sortEsdSummariesByNewest)[0];
    resolvedEsdId = latestEsd?.id;
  }

  if (!resolvedEsdId) {
    return null;
  }

  const esdResult = await commands.getEsd(resolvedEsdId);
  if (esdResult.status === 'error') {
    throw new Error(String(esdResult.error));
  }

  if (!esdResult.data && requestedSpecificEsd) {
    throw new Error(`ESD "${resolvedEsdId}" not found`);
  }

  return esdResult.data ?? null;
}

export function useReferenceComparison(esdId?: string): UseReferenceComparisonReturn {
  const [esd, setEsd] = useState<EditingStyleDocument | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const activeSequence = useProjectStore((state) => {
    if (!state.activeSequenceId) {
      return null;
    }

    return state.sequences.get(state.activeSequenceId) ?? null;
  });
  const [debouncedSequence, setDebouncedSequence] = useState(activeSequence);

  useEffect(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }

    debounceRef.current = setTimeout(() => {
      setDebouncedSequence(activeSequence);
    }, DEBOUNCE_MS);

    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, [activeSequence]);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setError(null);

    resolveEsdDocument(esdId)
      .then((document) => {
        if (cancelled) {
          return;
        }

        setEsd(document);
      })
      .catch((loadError: unknown) => {
        if (cancelled) {
          return;
        }

        setEsd(null);
        setError(loadError instanceof Error ? loadError.message : String(loadError));
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [esdId]);

  const referenceCurve = useMemo<PacingDataPoint[]>(() => {
    if (!esd) {
      return [];
    }

    return esd.pacingCurve.map((point) => ({
      time: point.normalizedPosition,
      value: point.normalizedDuration,
    }));
  }, [esd]);

  const outputClips = useMemo(() => {
    if (!debouncedSequence) {
      return [];
    }

    return getPrimaryTrackClips(
      debouncedSequence.tracks.map((track) => ({
        id: track.id,
        kind: track.kind,
        visible: track.visible,
        isBaseTrack: track.isBaseTrack,
      })),
      debouncedSequence.tracks.flatMap((track) =>
        track.clips.map((clip) => ({
          trackId: track.id,
          timelineInSec: clip.place.timelineInSec,
          durationSec: clip.place.durationSec,
        })),
      ),
    );
  }, [debouncedSequence]);

  const outputCurve = useMemo<PacingDataPoint[]>(
    () => derivePacingCurve(outputClips),
    [outputClips],
  );

  const outputStructure = useMemo(
    () => buildOutputStructureSegments(esd?.contentMap ?? [], outputClips),
    [esd, outputClips],
  );

  const correlation = useMemo(() => {
    if (referenceCurve.length === 0 || outputCurve.length === 0) {
      return 0;
    }

    return calculatePearsonCorrelation(
      referenceCurve.map((point) => point.value),
      outputCurve.map((point) => point.value),
    );
  }, [outputCurve, referenceCurve]);

  const transitionDiffs = useMemo<TransitionDiffRow[]>(() => {
    if (!esd) {
      return [];
    }

    return buildTransitionDiffCounts(
      esd.transitionInventory.typeFrequency,
      Math.max(0, outputClips.length - 1),
    );
  }, [esd, outputClips.length]);

  return {
    esd,
    referenceCurve,
    outputCurve,
    outputStructure,
    correlation,
    transitionDiffs,
    isLoading,
    error,
  };
}

export default useReferenceComparison;
