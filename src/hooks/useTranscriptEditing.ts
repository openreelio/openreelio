/**
 * useTranscriptEditing Hook
 *
 * Provides transcript-driven editing: word-level timing, playhead-synced
 * highlighting, selection-based deletion, and segment reordering.
 */

import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { createLogger } from '@/services/logger';
import { usePlaybackStore } from '@/stores/playbackStore';
import { useProjectStore } from '@/stores/projectStore';
import { useTimelineStore } from '@/stores/timelineStore';
import { runProjectBackendMutation } from '@/services/projectMutationGateway';
import {
  getClipSourceTimeAtTimelineTime,
  getClipTimelineTimeAtSourceTime,
} from '@/utils/clipTiming';

const logger = createLogger('useTranscriptEditing');

// =============================================================================
// Types
// =============================================================================

/** A word with estimated timing from the backend */
export interface TranscriptWord {
  text: string;
  startSec: number;
  endSec: number;
  segmentIndex: number;
  wordIndex: number;
  confidence: number;
  speakerId?: string | null;
  speakerTurnId?: string | null;
}

/** Word selection range for editing operations */
export interface WordSelection {
  startIndex: number;
  endIndex: number;
}

/** Contiguous transcript search match */
export interface TranscriptSearchMatch {
  startIndex: number;
  endIndex: number;
  text: string;
}

/** Return type of the hook */
export interface UseTranscriptEditingReturn {
  /** Words with timing that overlap the selected clip's source range */
  words: TranscriptWord[];
  /** Whether words are currently loading */
  isLoading: boolean;
  /** Error message if loading or operation failed */
  error: string | null;
  /** Index of the word currently under the playhead */
  activeWordIndex: number;
  /** Current word selection range */
  selection: WordSelection | null;
  /** The asset ID of the clip being edited */
  assetId: string | null;
  /** Current transcript search query */
  searchTerm: string;
  /** Replacement text used for correction preview */
  replacementText: string;
  /** Contiguous word matches for the current query */
  searchMatches: TranscriptSearchMatch[];
  /** Active search match index, or -1 when there are no matches */
  activeSearchMatchIndex: number;
  /** Correction preview for the active match. This does not mutate source transcript data. */
  replacementPreview: string | null;

  /** Set the word selection range */
  setSelection: (selection: WordSelection | null) => void;
  /** Set transcript search query */
  setSearchTerm: (term: string) => void;
  /** Set replacement text for correction preview */
  setReplacementText: (text: string) => void;
  /** Select a search match and sync word selection to it */
  selectSearchMatch: (matchIndex: number) => void;
  /** Select next search match */
  goToNextSearchMatch: () => void;
  /** Select previous search match */
  goToPreviousSearchMatch: () => void;
  /** Seek playhead to a word's start time */
  seekToWord: (wordIndex: number) => void;
  /** Delete the selected word range from the timeline */
  deleteSelection: () => Promise<void>;
  /** Reorder: move selected range to a target word position */
  reorderToPosition: (targetWordIndex: number) => Promise<void>;
  /** Reload transcript words */
  reload: () => void;
}

// =============================================================================
// Hook Implementation
// =============================================================================

function normalizeTranscriptToken(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}'-]+/gu, '')
    .trim();
}

function buildSearchMatches(words: TranscriptWord[], query: string): TranscriptSearchMatch[] {
  const queryTokens = query.trim().split(/\s+/).map(normalizeTranscriptToken).filter(Boolean);

  if (queryTokens.length === 0) {
    return [];
  }

  const normalizedWords = words.map((word) => normalizeTranscriptToken(word.text));
  const matches: TranscriptSearchMatch[] = [];

  for (let index = 0; index <= words.length - queryTokens.length; index += 1) {
    const isMatch = queryTokens.every((token, offset) => {
      const candidate = normalizedWords[index + offset];
      return queryTokens.length === 1 ? candidate.includes(token) : candidate === token;
    });

    if (isMatch) {
      const endIndex = index + queryTokens.length - 1;
      matches.push({
        startIndex: index,
        endIndex,
        text: words
          .slice(index, endIndex + 1)
          .map((word) => word.text)
          .join(' '),
      });
    }
  }

  return matches;
}

export function useTranscriptEditing(): UseTranscriptEditingReturn {
  const isMountedRef = useRef(true);
  const [words, setWords] = useState<TranscriptWord[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<WordSelection | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [replacementText, setReplacementText] = useState('');
  const [activeSearchMatchIndex, setActiveSearchMatchIndex] = useState(-1);
  const [loadTrigger, setLoadTrigger] = useState(0);

  const currentTime = usePlaybackStore((s) => s.currentTime);
  const seek = usePlaybackStore((s) => s.seek);
  const selectedClipIds = useTimelineStore((s) => s.selectedClipIds);
  const activeSequenceId = useProjectStore((s) => s.activeSequenceId);
  const sequences = useProjectStore((s) => s.sequences);

  // Resolve the selected clip's asset ID and clip metadata
  const clipInfo = useMemo(() => {
    if (selectedClipIds.length !== 1) return null;
    const clipId = selectedClipIds[0];

    if (!activeSequenceId) return null;

    const seq = sequences.get(activeSequenceId);
    if (!seq) return null;

    for (const track of seq.tracks) {
      const clip = track.clips.find((c) => c.id === clipId);
      if (clip) {
        return {
          clipId: clip.id,
          assetId: clip.assetId,
          trackId: track.id,
          sequenceId: activeSequenceId,
          sourceInSec: clip.range.sourceInSec,
          sourceOutSec: clip.range.sourceOutSec,
          speed: clip.speed,
          timelineInSec: clip.place.timelineInSec,
          clip,
        };
      }
    }
    return null;
  }, [selectedClipIds, activeSequenceId, sequences]);

  useEffect(() => {
    setSelection(null);
  }, [clipInfo?.clipId]);

  const selectedAssetId = clipInfo?.assetId ?? null;

  // Load transcript words when clip selection changes
  useEffect(() => {
    if (!selectedAssetId) {
      setWords([]);
      setError(null);
      return;
    }

    let cancelled = false;
    setIsLoading(true);
    setError(null);

    invoke<TranscriptWord[]>('get_transcript_words', {
      assetId: selectedAssetId,
    })
      .then((result) => {
        if (!cancelled && isMountedRef.current) {
          setWords(result);
          setIsLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled && isMountedRef.current) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn('Failed to load transcript words', { error: msg });
          setWords([]);
          setError(msg);
          setIsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [selectedAssetId, loadTrigger]);

  // Cleanup on unmount
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const visibleWords = useMemo(() => {
    if (!clipInfo) {
      return [];
    }

    return words.filter(
      (word) => word.endSec > clipInfo.sourceInSec && word.startSec < clipInfo.sourceOutSec,
    );
  }, [words, clipInfo]);

  const searchMatches = useMemo(
    () => buildSearchMatches(visibleWords, searchTerm),
    [visibleWords, searchTerm],
  );

  useEffect(() => {
    setActiveSearchMatchIndex(searchMatches.length > 0 ? 0 : -1);
  }, [searchMatches.length, searchTerm]);

  const selectSearchMatch = useCallback(
    (matchIndex: number) => {
      if (searchMatches.length === 0) {
        setActiveSearchMatchIndex(-1);
        setSelection(null);
        return;
      }

      const normalizedIndex =
        ((matchIndex % searchMatches.length) + searchMatches.length) % searchMatches.length;
      const match = searchMatches[normalizedIndex];
      setActiveSearchMatchIndex(normalizedIndex);
      setSelection({ startIndex: match.startIndex, endIndex: match.endIndex });
    },
    [searchMatches],
  );

  const goToNextSearchMatch = useCallback(() => {
    if (searchMatches.length === 0) return;
    selectSearchMatch(activeSearchMatchIndex < 0 ? 0 : activeSearchMatchIndex + 1);
  }, [activeSearchMatchIndex, searchMatches.length, selectSearchMatch]);

  const goToPreviousSearchMatch = useCallback(() => {
    if (searchMatches.length === 0) return;
    selectSearchMatch(
      activeSearchMatchIndex < 0 ? searchMatches.length - 1 : activeSearchMatchIndex - 1,
    );
  }, [activeSearchMatchIndex, searchMatches.length, selectSearchMatch]);

  const replacementPreview = useMemo(() => {
    if (!replacementText && !searchTerm.trim()) {
      return null;
    }

    const activeMatch =
      activeSearchMatchIndex >= 0 ? searchMatches[activeSearchMatchIndex] : undefined;
    if (!activeMatch) {
      return null;
    }

    const before = visibleWords
      .slice(Math.max(0, activeMatch.startIndex - 4), activeMatch.startIndex)
      .map((word) => word.text);
    const after = visibleWords
      .slice(activeMatch.endIndex + 1, activeMatch.endIndex + 5)
      .map((word) => word.text);
    return [...before, replacementText, ...after].join(' ').trim();
  }, [activeSearchMatchIndex, replacementText, searchMatches, searchTerm, visibleWords]);

  // Find the active word index based on playhead position
  const activeWordIndex = useMemo(() => {
    if (visibleWords.length === 0 || !clipInfo) return -1;

    // Convert timeline time to source time
    const sourceTime = getClipSourceTimeAtTimelineTime(clipInfo.clip, currentTime);

    for (let i = 0; i < visibleWords.length; i++) {
      if (sourceTime >= visibleWords[i].startSec && sourceTime < visibleWords[i].endSec) {
        return i;
      }
    }
    return -1;
  }, [visibleWords, currentTime, clipInfo]);

  // Seek playhead to a word's start time
  const seekToWord = useCallback(
    (wordIndex: number) => {
      if (wordIndex < 0 || wordIndex >= visibleWords.length || !clipInfo) return;
      const word = visibleWords[wordIndex];
      // Convert source time to timeline time
      const timelineTime = getClipTimelineTimeAtSourceTime(clipInfo.clip, word.startSec);
      seek(timelineTime, 'transcript-word');
    },
    [visibleWords, clipInfo, seek],
  );

  // Serialization guard to prevent duplicate destructive IPC calls
  const mutationInFlightRef = useRef(false);

  // Delete the selected word range
  const deleteSelection = useCallback(async () => {
    if (mutationInFlightRef.current || !selection || !clipInfo) return;

    const startWord = visibleWords[selection.startIndex];
    const endWord = visibleWords[selection.endIndex];
    if (!startWord || !endWord) return;

    mutationInFlightRef.current = true;
    setError(null);
    try {
      await runProjectBackendMutation('deleteTranscriptRange', () =>
        invoke('delete_transcript_range', {
          args: {
            sequenceId: clipInfo.sequenceId,
            trackId: clipInfo.trackId,
            clipId: clipInfo.clipId,
            startSec: startWord.startSec,
            endSec: endWord.endSec,
          },
        }),
      );
      if (isMountedRef.current) {
        setSelection(null);
        setLoadTrigger((t) => t + 1); // Trigger reload after edit
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('Failed to delete transcript range', { error: msg });
      if (isMountedRef.current) setError(msg);
    } finally {
      mutationInFlightRef.current = false;
    }
  }, [selection, visibleWords, clipInfo]);

  // Reorder: move selected range to target word position
  const reorderToPosition = useCallback(
    async (targetWordIndex: number) => {
      if (mutationInFlightRef.current || !selection || !clipInfo) return;

      const startWord = visibleWords[selection.startIndex];
      const endWord = visibleWords[selection.endIndex];
      const targetWord = visibleWords[targetWordIndex];
      if (!startWord || !endWord || !targetWord) return;

      // Convert target word's source time to timeline position
      const targetTimelineSec = getClipTimelineTimeAtSourceTime(clipInfo.clip, targetWord.startSec);

      mutationInFlightRef.current = true;
      setError(null);
      try {
        await runProjectBackendMutation('reorderTranscriptSegment', () =>
          invoke('reorder_transcript_segment', {
            args: {
              sequenceId: clipInfo.sequenceId,
              trackId: clipInfo.trackId,
              clipId: clipInfo.clipId,
              sourceStartSec: startWord.startSec,
              sourceEndSec: endWord.endSec,
              targetPositionSec: targetTimelineSec,
            },
          }),
        );
        if (isMountedRef.current) {
          setSelection(null);
          setLoadTrigger((t) => t + 1);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error('Failed to reorder transcript segment', { error: msg });
        if (isMountedRef.current) setError(msg);
      } finally {
        mutationInFlightRef.current = false;
      }
    },
    [selection, visibleWords, clipInfo],
  );

  const reload = useCallback(() => {
    setLoadTrigger((t) => t + 1);
  }, []);

  return {
    words: visibleWords,
    isLoading,
    error,
    activeWordIndex,
    selection,
    assetId: clipInfo?.assetId ?? null,
    searchTerm,
    replacementText,
    searchMatches,
    activeSearchMatchIndex,
    replacementPreview,
    setSelection,
    setSearchTerm,
    setReplacementText,
    selectSearchMatch,
    goToNextSearchMatch,
    goToPreviousSearchMatch,
    seekToWord,
    deleteSelection,
    reorderToPosition,
    reload,
  };
}
