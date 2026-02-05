/**
 * ContextPanel Component
 *
 * Displays current editing context: playhead position, selected clips,
 * sequence information, and API usage. Collapsible to save space.
 */

import { useState, memo, useMemo } from 'react';
import { useTimelineStore, useProjectStore, usePlaybackStore, useSettingsStore } from '@/stores';
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

  // Get playhead from PlaybackStore (single source of truth)
  const playhead = usePlaybackStore((state) => state.currentTime);
  // Get selection from TimelineStore
  const selectedClipIds = useTimelineStore((state) => state.selectedClipIds);

  // Get sequence duration from project store (calculated from tracks)
  const activeSequenceId = useProjectStore((state) => state.activeSequenceId);
  const sequences = useProjectStore((state) => state.sequences);
  const activeSequence = activeSequenceId ? sequences.get(activeSequenceId) : null;

  // Get AI settings for usage display
  const aiSettings = useSettingsStore((state) => state.settings.ai);

  // Calculate duration from all clips
  const duration = activeSequence?.tracks.reduce((maxDuration, track) => {
    const trackMaxEnd = track.clips.reduce((max, clip) => {
      const clipEnd = clip.place.timelineInSec + clip.place.durationSec;
      return Math.max(max, clipEnd);
    }, 0);
    return Math.max(maxDuration, trackMaxEnd);
  }, 0) ?? 0;

  const selectedCount = selectedClipIds.length;

  // Calculate API usage stats
  const usageStats = useMemo(() => {
    const usageCents = aiSettings.currentMonthUsageCents ?? 0;
    const budgetCents = aiSettings.monthlyBudgetCents;
    const usageDollars = (usageCents / 100).toFixed(2);
    const budgetDollars = budgetCents ? (budgetCents / 100).toFixed(2) : null;
    const usagePercent = budgetCents ? Math.min((usageCents / budgetCents) * 100, 100) : null;
    const isApproachingLimit = usagePercent !== null && usagePercent >= 80;
    const isOverBudget = usagePercent !== null && usagePercent >= 100;

    return {
      usageDollars,
      budgetDollars,
      usagePercent,
      isApproachingLimit,
      isOverBudget,
    };
  }, [aiSettings.currentMonthUsageCents, aiSettings.monthlyBudgetCents]);

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
        <div className="px-3 pb-2 space-y-2">
          {/* Timeline context */}
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
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

          {/* API Usage */}
          <div className="pt-1 border-t border-editor-border/50">
            <div className="flex items-center justify-between text-xs">
              <span className="text-editor-text-secondary flex items-center gap-1">
                <CostIcon />
                API Usage
              </span>
              <span
                className={`font-medium ${
                  usageStats.isOverBudget
                    ? 'text-red-400'
                    : usageStats.isApproachingLimit
                    ? 'text-yellow-400'
                    : 'text-editor-text'
                }`}
              >
                ${usageStats.usageDollars}
                {usageStats.budgetDollars && (
                  <span className="text-editor-text-secondary font-normal">
                    {' '}/ ${usageStats.budgetDollars}
                  </span>
                )}
              </span>
            </div>
            {/* Progress bar - only show if budget is set */}
            {usageStats.usagePercent !== null && (
              <div className="mt-1 h-1 bg-editor-surface rounded-full overflow-hidden">
                <div
                  className={`h-full transition-all ${
                    usageStats.isOverBudget
                      ? 'bg-red-500'
                      : usageStats.isApproachingLimit
                      ? 'bg-yellow-500'
                      : 'bg-green-500'
                  }`}
                  style={{ width: `${usageStats.usagePercent}%` }}
                />
              </div>
            )}
            {usageStats.budgetDollars === null && (
              <span className="text-[10px] text-editor-text-secondary">
                No budget limit set
              </span>
            )}
          </div>
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

function CostIcon() {
  return (
    <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24">
      <path d="M11.8 10.9c-2.27-.59-3-1.2-3-2.15 0-1.09 1.01-1.85 2.7-1.85 1.78 0 2.44.85 2.5 2.1h2.21c-.07-1.72-1.12-3.3-3.21-3.81V3h-3v2.16c-1.94.42-3.5 1.68-3.5 3.61 0 2.31 1.91 3.46 4.7 4.13 2.5.6 3 1.48 3 2.41 0 .69-.49 1.79-2.7 1.79-2.06 0-2.87-.92-2.98-2.1h-2.2c.12 2.19 1.76 3.42 3.68 3.83V21h3v-2.15c1.95-.37 3.5-1.5 3.5-3.55 0-2.84-2.43-3.81-4.7-4.4z" />
    </svg>
  );
}
