/**
 * QuickActionsBar Component
 *
 * Provides quick action buttons for common AI operations.
 * Includes default actions (captions, silence removal, scene split)
 * and support for custom actions.
 */

import { useCallback, memo } from 'react';
import { useAIStore } from '@/stores/aiStore';
import { useTimelineStore, usePlaybackStore } from '@/stores';

// =============================================================================
// Types
// =============================================================================

export interface QuickAction {
  /** Unique identifier */
  id: string;
  /** Display label */
  label: string;
  /** Icon (emoji or SVG component) */
  icon: React.ReactNode;
  /** AI intent to execute */
  intent: string;
  /** Optional description */
  description?: string;
}

export interface QuickActionsBarProps {
  /** Optional CSS class name */
  className?: string;
  /** Custom actions to add */
  customActions?: QuickAction[];
}

// =============================================================================
// Default Actions
// =============================================================================

const DEFAULT_ACTIONS: QuickAction[] = [
  {
    id: 'add_captions',
    label: 'Add Captions',
    icon: <CaptionsIcon />,
    intent: 'Add captions to the selected clips',
    description: 'Generate subtitles for selected clips',
  },
  {
    id: 'remove_silence',
    label: 'Remove Silence',
    icon: <SilenceIcon />,
    intent: 'Remove all silent parts from the timeline',
    description: 'Detect and remove silent sections',
  },
  {
    id: 'split_scenes',
    label: 'Split Scenes',
    icon: <ScenesIcon />,
    intent: 'Split the video by scene changes',
    description: 'Auto-detect scene changes and split',
  },
];

// =============================================================================
// Component
// =============================================================================

export const QuickActionsBar = memo(function QuickActionsBar({
  className = '',
  customActions = [],
}: QuickActionsBarProps) {
  // Get store state and actions
  const generateEditScript = useAIStore((state) => state.generateEditScript);
  const isGenerating = useAIStore((state) => state.isGenerating);

  // Get playhead from PlaybackStore (single source of truth)
  const playhead = usePlaybackStore((state) => state.currentTime);
  // Get selection from TimelineStore
  const selectedClipIds = useTimelineStore((state) => state.selectedClipIds);
  const selectedTrackIds = useTimelineStore((state) => state.selectedTrackIds);

  // Handle action click
  const handleActionClick = useCallback(
    (action: QuickAction) => {
      generateEditScript(action.intent, {
        playheadPosition: playhead,
        selectedClips: selectedClipIds,
        selectedTracks: selectedTrackIds,
      });
    },
    [generateEditScript, playhead, selectedClipIds, selectedTrackIds]
  );

  // Combine default and custom actions
  const allActions = [...DEFAULT_ACTIONS, ...customActions];

  return (
    <div
      data-testid="quick-actions-bar"
      className={`border-t border-editor-border p-2 ${className}`}
    >
      <div className="flex flex-wrap gap-1.5">
        {allActions.map((action) => (
          <button
            key={action.id}
            type="button"
            onClick={() => handleActionClick(action)}
            disabled={isGenerating}
            className="flex items-center gap-1.5 px-2 py-1.5 text-xs rounded bg-editor-surface hover:bg-editor-surface-hover text-editor-text transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            aria-label={action.description || action.label}
            title={action.description}
          >
            <span className="text-sm">{action.icon}</span>
            <span>{action.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
});

// =============================================================================
// Icons
// =============================================================================

function CaptionsIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z"
      />
    </svg>
  );
}

function SilenceIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z"
      />
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M17 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2"
      />
    </svg>
  );
}

function ScenesIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M4 6h16M4 12h16M4 18h7"
      />
    </svg>
  );
}
