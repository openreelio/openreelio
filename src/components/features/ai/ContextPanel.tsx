/**
 * ContextPanel Component
 *
 * Displays current editing context: playhead position, selected clips,
 * and sequence information. Collapsible to save space.
 */

import { useState, memo } from 'react';
import { useTimelineStore, useProjectStore } from '@/stores';
import { formatDuration } from '@/utils/formatters';

// =============================================================================
// Types
// =============================================================================

export interface ContextPanelProps {
  /** Optional CSS class name */
  className?: string;
  /** Initially expanded state */
  defaultExpanded?: boolean;
}

// =============================================================================
// Component
// =============================================================================

export const ContextPanel = memo(function ContextPanel({
  className = '',
  defaultExpanded = true,
}: ContextPanelProps) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);

  // Get context from timeline store
  const playhead = useTimelineStore((state) => state.playhead);
  const selectedClipIds = useTimelineStore((state) => state.selectedClipIds);

  // Get sequence duration from project store (calculated from tracks)
  const activeSequenceId = useProjectStore((state) => state.activeSequenceId);
  const sequences = useProjectStore((state) => state.sequences);
  const activeSequence = activeSequenceId ? sequences.get(activeSequenceId) : null;

  // Calculate duration from all clips
  const duration = activeSequence?.tracks.reduce((maxDuration, track) => {
    const trackMaxEnd = track.clips.reduce((max, clip) => {
      const clipEnd = clip.place.timelineInSec + clip.place.durationSec;
      return Math.max(max, clipEnd);
    }, 0);
    return Math.max(maxDuration, trackMaxEnd);
  }, 0) ?? 0;

  const selectedCount = selectedClipIds.length;

  return (
    <div
      data-testid="context-panel"
      className={`border-t border-editor-border ${className}`}
    >
      {/* Header - always visible */}
      <button
        type="button"
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full px-3 py-2 flex items-center justify-between text-xs text-editor-text-secondary hover:bg-editor-surface transition-colors"
        aria-expanded={isExpanded}
      >
        <span className="font-medium">Context</span>
        <svg
          className={`w-4 h-4 transition-transform ${
            isExpanded ? 'rotate-180' : ''
          }`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M19 9l-7 7-7-7"
          />
        </svg>
      </button>

      {/* Content - collapsible */}
      {isExpanded && (
        <div className="px-3 pb-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
          <ContextItem
            icon={<PlayheadIcon />}
            label="Playhead"
            value={formatDuration(playhead)}
          />
          <ContextItem
            icon={<ClipIcon />}
            label="Selected"
            value={`${selectedCount} clip${selectedCount !== 1 ? 's' : ''}`}
          />
          <ContextItem
            icon={<DurationIcon />}
            label="Duration"
            value={formatDuration(duration)}
          />
        </div>
      )}
    </div>
  );
});

// =============================================================================
// Sub-Components
// =============================================================================

interface ContextItemProps {
  icon: React.ReactNode;
  label: string;
  value: string;
}

function ContextItem({ icon, label, value }: ContextItemProps) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-editor-text-secondary">{icon}</span>
      <span className="text-editor-text-secondary">{label}:</span>
      <span className="text-editor-text font-medium">{value}</span>
    </div>
  );
}

function PlayheadIcon() {
  return (
    <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24">
      <path d="M12 2L8 6h8l-4-4zm0 20l4-4H8l4 4zm0-6a4 4 0 100-8 4 4 0 000 8z" />
    </svg>
  );
}

function ClipIcon() {
  return (
    <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24">
      <path d="M4 6h16v2H4V6zm0 5h16v2H4v-2zm0 5h16v2H4v-2z" />
    </svg>
  );
}

function DurationIcon() {
  return (
    <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24">
      <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67V7z" />
    </svg>
  );
}
