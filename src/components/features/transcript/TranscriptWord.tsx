/**
 * TranscriptWord Component
 *
 * Renders a single word in the transcript editor with click-to-seek,
 * playback highlighting, and selection state.
 */

import React from 'react';

/** Props for TranscriptWord */
export interface TranscriptWordProps {
  /** The word text */
  text: string;
  /** Word index in the global words array */
  index: number;
  /** Whether this word is currently being spoken (playhead is on it) */
  isActive: boolean;
  /** Whether this word is in the current selection range */
  isSelected: boolean;
  /** Whether this is the first word of a new segment */
  isSegmentStart: boolean;
  /** Speaker ID for this word (shows speaker change marker) */
  speakerId?: string | null;
  /** Previous word's speaker ID (to detect speaker changes) */
  prevSpeakerId?: string | null;
  /** Click handler for seeking */
  onClick: (index: number) => void;
  /** Mouse down handler for selection start */
  onMouseDown: (index: number) => void;
  /** Mouse enter handler for selection extend */
  onMouseEnter: (index: number) => void;
  /** Read-only mode */
  readOnly?: boolean;
  /** Whether this word is marked for cleanup removal */
  isMarkedForRemoval?: boolean;
}

/** Renders a single clickable word in the transcript */
export const TranscriptWord: React.FC<TranscriptWordProps> = React.memo(
  ({
    text,
    index,
    isActive,
    isSelected,
    isSegmentStart,
    speakerId,
    prevSpeakerId,
    onClick,
    onMouseDown,
    onMouseEnter,
    readOnly,
    isMarkedForRemoval,
  }) => {
    const showSpeakerChange =
      speakerId && prevSpeakerId && speakerId !== prevSpeakerId;

    return (
      <>
        {isSegmentStart && index > 0 && (
          <span className="inline-block w-0.5" />
        )}
        {showSpeakerChange && (
          <span className="block w-full mt-2 mb-1 text-xs text-neutral-500 font-medium">
            [{speakerId}]
          </span>
        )}
        <span
          role="button"
          tabIndex={readOnly ? undefined : 0}
          data-word-index={index}
          className={[
            'inline cursor-pointer rounded-sm px-0.5 py-px transition-colors',
            isActive && 'bg-primary-500/40 text-white font-medium',
            isSelected && !isActive && 'bg-primary-600/30',
            isMarkedForRemoval && !isActive && !isSelected && 'bg-red-600/25 text-red-300 line-through',
            !isActive && !isSelected && !isMarkedForRemoval && 'hover:bg-neutral-700/50',
          ]
            .filter(Boolean)
            .join(' ')}
          onClick={() => onClick(index)}
          onMouseDown={(e) => {
            if (e.button === 0 && !readOnly) onMouseDown(index);
          }}
          onMouseEnter={() => onMouseEnter(index)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onClick(index);
            }
          }}
          aria-label={`Word: ${text}, click to seek`}
        >
          {text}
        </span>
        {' '}
      </>
    );
  }
);

TranscriptWord.displayName = 'TranscriptWord';
