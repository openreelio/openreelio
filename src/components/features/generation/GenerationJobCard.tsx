/**
 * GenerationJobCard Component
 *
 * Displays the status and progress of a single video generation job.
 * Shows truncated prompt, progress bar, status badge, and action buttons.
 */

import { useCallback, memo } from 'react';
import { X, Plus } from 'lucide-react';
import type { VideoGenJob } from '@/stores/videoGenStore';

// =============================================================================
// Types
// =============================================================================

export interface GenerationJobCardProps {
  /** The generation job to display */
  job: VideoGenJob;
  /** Called when the user wants to cancel this job */
  onCancel?: (jobId: string) => void;
  /** Called when the user wants to add the completed asset to the timeline */
  onAddToTimeline?: (assetId: string) => void;
  /** Optional class name */
  className?: string;
}

// =============================================================================
// Helpers
// =============================================================================

const STATUS_COLORS: Record<string, string> = {
  submitting: 'bg-gray-500',
  queued: 'bg-yellow-500',
  processing: 'bg-blue-500',
  downloading: 'bg-blue-500',
  importing: 'bg-blue-500',
  completed: 'bg-green-500',
  failed: 'bg-red-500',
  cancelled: 'bg-neutral-500',
};

const STATUS_LABELS: Record<string, string> = {
  submitting: 'Submitting',
  queued: 'Queued',
  processing: 'Processing',
  downloading: 'Downloading',
  importing: 'Importing',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

function isActiveStatus(status: string): boolean {
  return ['submitting', 'queued', 'processing', 'downloading', 'importing'].includes(status);
}

// =============================================================================
// Component
// =============================================================================

export const GenerationJobCard = memo(function GenerationJobCard({
  job,
  onCancel,
  onAddToTimeline,
  className = '',
}: GenerationJobCardProps) {
  const handleCancel = useCallback(() => {
    onCancel?.(job.id);
  }, [onCancel, job.id]);

  const handleAddToTimeline = useCallback(() => {
    if (job.assetId) {
      onAddToTimeline?.(job.assetId);
    }
  }, [onAddToTimeline, job.assetId]);

  const truncatedPrompt =
    job.prompt.length > 60 ? `${job.prompt.slice(0, 57)}...` : job.prompt;

  const active = isActiveStatus(job.status);

  return (
    <div
      className={`p-3 rounded-lg border border-editor-border bg-editor-bg ${className}`}
    >
      {/* Header: prompt + status badge */}
      <div className="flex items-start justify-between gap-2 mb-2">
        <p className="text-sm text-editor-text flex-1 truncate" title={job.prompt}>
          {truncatedPrompt}
        </p>
        <span
          className={`shrink-0 inline-flex items-center px-2 py-0.5 rounded text-xs font-medium text-white ${
            STATUS_COLORS[job.status] ?? 'bg-gray-500'
          }`}
        >
          {STATUS_LABELS[job.status] ?? job.status}
        </span>
      </div>

      {/* Progress bar (visible for active jobs) */}
      {active && (
        <div className="mb-2">
          <div className="flex items-center justify-between text-xs text-editor-text-muted mb-1">
            <span>{job.status === 'queued' ? 'Waiting...' : 'Generating...'}</span>
            <span>{job.progress}%</span>
          </div>
          <div className="w-full h-1.5 bg-editor-border rounded-full overflow-hidden">
            <div
              className="h-full bg-primary-500 rounded-full transition-all duration-300"
              style={{ width: `${job.progress}%` }}
            />
          </div>
        </div>
      )}

      {/* Error message */}
      {job.error && (
        <p className="text-xs text-red-400 mb-2 truncate" title={job.error}>
          {job.error}
        </p>
      )}

      {/* Footer: cost + actions */}
      <div className="flex items-center justify-between">
        <span className="text-xs text-editor-text-muted">
          Est. ${(job.estimatedCostCents / 100).toFixed(2)}
        </span>

        <div className="flex items-center gap-1">
          {active && onCancel && (
            <button
              type="button"
              onClick={handleCancel}
              className="p-1 rounded text-editor-text-muted hover:text-red-400 hover:bg-red-500/10 transition-colors"
              title="Cancel generation"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
          {job.status === 'completed' && job.assetId && onAddToTimeline && (
            <button
              type="button"
              onClick={handleAddToTimeline}
              className="flex items-center gap-1 px-2 py-1 rounded text-xs text-primary-400 hover:bg-primary-500/10 transition-colors"
              title="Add to timeline"
            >
              <Plus className="w-3 h-3" />
              Add to Timeline
            </button>
          )}
        </div>
      </div>
    </div>
  );
});
