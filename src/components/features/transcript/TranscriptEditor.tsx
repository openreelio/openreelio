/** Transcript-based video editing panel with word-level interaction. */

import React, { useCallback, useRef, useState } from 'react';
import { FileText, Trash2, AlertCircle, Loader2, Search, Replace } from 'lucide-react';
import { useTranscriptEditing } from '@/hooks/useTranscriptEditing';
import { useCleanupDetection } from '@/hooks/useCleanupDetection';
import { TranscriptWord } from './TranscriptWord';
import { CleanupControls } from './CleanupControls';

export interface TranscriptEditorProps {
  readOnly?: boolean;
}
export const TranscriptEditor: React.FC<TranscriptEditorProps> = ({ readOnly = false }) => {
  const {
    words,
    isLoading,
    error,
    activeWordIndex,
    selection,
    assetId,
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
    reload,
  } = useTranscriptEditing();

  const cleanup = useCleanupDetection();

  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Click a word → seek playhead
  const handleWordClick = useCallback(
    (index: number) => {
      if (!isDragging) seekToWord(index);
    },
    [seekToWord, isDragging],
  );

  // Mouse down → start selection (also creates single-word selection)
  const handleMouseDown = useCallback(
    (index: number) => {
      dragStartRef.current = index;
      setIsDragging(true);
      setSelection({ startIndex: index, endIndex: index });
    },
    [setSelection],
  );

  // Mouse enter during drag → extend selection
  const handleMouseEnter = useCallback(
    (index: number) => {
      if (!isDragging || dragStartRef.current === null) return;
      const start = Math.min(dragStartRef.current, index);
      const end = Math.max(dragStartRef.current, index);
      setSelection({ startIndex: start, endIndex: end });
    },
    [isDragging, setSelection],
  );

  // Mouse up → finalize selection
  const handleMouseUp = useCallback(() => {
    if (isDragging && dragStartRef.current !== null) {
      setIsDragging(false);
    }
    dragStartRef.current = null;
  }, [isDragging]);

  // Keyboard: Delete selected range, Escape to clear
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (readOnly) return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && selection) {
        e.preventDefault();
        void deleteSelection();
      }
      if (e.key === 'Escape') {
        setSelection(null);
      }
    },
    [selection, deleteSelection, setSelection, readOnly],
  );

  // Check if a word is in the selection range
  const isWordSelected = useCallback(
    (index: number): boolean => {
      if (!selection) return false;
      return index >= selection.startIndex && index <= selection.endIndex;
    },
    [selection],
  );

  if (!assetId)
    return (
      <div className="flex flex-col items-center justify-center h-full text-neutral-500 gap-2 p-4">
        <FileText className="w-8 h-8 opacity-50" />
        <p className="text-sm">Select a clip to view its transcript</p>
      </div>
    );
  if (isLoading)
    return (
      <div className="flex items-center justify-center h-full gap-2 text-neutral-400">
        <Loader2 className="w-4 h-4 animate-spin" />
        <span className="text-sm">Loading transcript...</span>
      </div>
    );
  if (error)
    return (
      <div className="flex flex-col items-center justify-center h-full text-neutral-500 gap-2 p-4">
        <AlertCircle className="w-6 h-6 text-yellow-500" />
        <p className="text-sm text-center">{error}</p>
        <button
          onClick={reload}
          className="text-xs text-primary-400 hover:text-primary-300 underline"
        >
          Retry
        </button>
      </div>
    );
  if (words.length === 0)
    return (
      <div className="flex flex-col items-center justify-center h-full text-neutral-500 gap-2 p-4">
        <FileText className="w-6 h-6 opacity-50" />
        <p className="text-sm">No transcript available. Run transcription first.</p>
      </div>
    );

  const selectionLength = selection ? selection.endIndex - selection.startIndex + 1 : 0;

  return (
    <div
      ref={containerRef}
      className="flex flex-col h-full"
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onKeyDown={handleKeyDown}
      tabIndex={0}
      role="textbox"
      aria-label="Transcript editor"
      aria-readonly={readOnly}
    >
      {/* Cleanup controls */}
      {!readOnly && words.length > 0 && (
        <CleanupControls
          detectedRegions={cleanup.detectedRegions}
          isDetecting={cleanup.isDetecting}
          isRemoving={cleanup.isRemoving}
          mode={cleanup.mode}
          totalDurationSec={cleanup.totalDurationSec}
          error={cleanup.error}
          onDetectSilence={cleanup.detectSilence}
          onDetectFillers={cleanup.detectFillers}
          onRemoveDetected={cleanup.removeDetected}
          onClearDetection={cleanup.clearDetection}
          readOnly={readOnly}
        />
      )}

      <div className="px-3 py-2 border-b border-neutral-700 bg-neutral-900/80 space-y-2">
        <div className="grid grid-cols-2 gap-2">
          <label className="space-y-1">
            <span className="text-xs font-medium text-neutral-400 flex items-center gap-1">
              <Search className="w-3.5 h-3.5" />
              Find
            </span>
            <input
              type="search"
              aria-label="Find in transcript"
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
              className="w-full px-2 py-1.5 rounded bg-neutral-800 border border-neutral-600 text-xs text-white placeholder-neutral-500 focus:outline-none focus:ring-2 focus:ring-primary-500"
              placeholder="Search"
            />
          </label>
          <label className="space-y-1">
            <span className="text-xs font-medium text-neutral-400 flex items-center gap-1">
              <Replace className="w-3.5 h-3.5" />
              Replace
            </span>
            <input
              type="text"
              aria-label="Transcript replacement preview"
              value={replacementText}
              onChange={(event) => setReplacementText(event.target.value)}
              disabled={readOnly}
              className="w-full px-2 py-1.5 rounded bg-neutral-800 border border-neutral-600 text-xs text-white placeholder-neutral-500 focus:outline-none focus:ring-2 focus:ring-primary-500 disabled:opacity-50 disabled:cursor-not-allowed"
              placeholder="Preview"
            />
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-neutral-500 mr-auto" aria-live="polite">
            {searchTerm.trim()
              ? `${searchMatches.length} ${searchMatches.length === 1 ? 'match' : 'matches'}`
              : 'No search'}
          </span>
          <button
            type="button"
            onClick={goToPreviousSearchMatch}
            disabled={searchMatches.length === 0}
            className="px-2 py-1 text-xs rounded border border-neutral-600 text-neutral-300 hover:bg-neutral-800 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Previous
          </button>
          <button
            type="button"
            onClick={goToNextSearchMatch}
            disabled={searchMatches.length === 0}
            className="px-2 py-1 text-xs rounded border border-neutral-600 text-neutral-300 hover:bg-neutral-800 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Next
          </button>
          <button
            type="button"
            onClick={() =>
              selectSearchMatch(activeSearchMatchIndex < 0 ? 0 : activeSearchMatchIndex)
            }
            disabled={searchMatches.length === 0}
            className="px-2 py-1 text-xs rounded bg-neutral-700 text-neutral-100 hover:bg-neutral-600 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Select
          </button>
        </div>
        {replacementPreview && (
          <div className="rounded border border-neutral-700 bg-neutral-800/70 px-2 py-1.5 text-xs text-neutral-300">
            <span className="text-neutral-500">Preview: </span>
            {replacementPreview}
          </div>
        )}
      </div>

      {/* Selection toolbar */}
      {selection && !readOnly && (
        <div className="flex items-center gap-2 px-3 py-1.5 bg-neutral-800 border-b border-neutral-700 text-xs">
          <span className="text-neutral-400">
            {selectionLength} word{selectionLength > 1 ? 's' : ''} selected
          </span>
          <button
            onClick={() => void deleteSelection()}
            className="flex items-center gap-1 px-2 py-0.5 rounded bg-red-600/20 text-red-400 hover:bg-red-600/30"
            title="Delete selected words from timeline (Delete key)"
          >
            <Trash2 className="w-3 h-3" />
            Remove
          </button>
          <button
            onClick={() => setSelection(null)}
            className="text-neutral-500 hover:text-neutral-300 ml-auto"
          >
            Clear
          </button>
        </div>
      )}

      {/* Word content area */}
      <div
        className="flex-1 overflow-y-auto p-3 text-sm leading-relaxed select-none"
        role="list"
        aria-label="Transcript words"
      >
        {words.map((word, i) => (
          <TranscriptWord
            key={`${word.segmentIndex}-${word.wordIndex}`}
            text={word.text}
            index={i}
            isActive={i === activeWordIndex}
            isSelected={isWordSelected(i)}
            isSegmentStart={i > 0 && word.segmentIndex !== words[i - 1].segmentIndex}
            speakerId={word.speakerId}
            speakerTurnId={word.speakerTurnId}
            prevSpeakerId={i > 0 ? words[i - 1].speakerId : null}
            prevSpeakerTurnId={i > 0 ? words[i - 1].speakerTurnId : null}
            onClick={handleWordClick}
            onMouseDown={handleMouseDown}
            onMouseEnter={handleMouseEnter}
            readOnly={readOnly}
            isMarkedForRemoval={cleanup.detectedRegions.some(
              (region) => word.endSec > region.startSec && word.startSec < region.endSec,
            )}
          />
        ))}
      </div>
    </div>
  );
};
