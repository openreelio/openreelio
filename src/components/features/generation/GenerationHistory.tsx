/**
 * GenerationHistory Component
 *
 * Displays a list of video generation jobs (active and recent)
 * with the option to clear completed jobs.
 */

import React, { useCallback } from 'react';
import { Trash2 } from 'lucide-react';
import { GenerationJobCard } from './GenerationJobCard';
import type { VideoGenJob } from '@/stores/videoGenStore';

// =============================================================================
// Types
// =============================================================================

export interface GenerationHistoryProps {
  /** All generation jobs (active + recent) */
  jobs: VideoGenJob[];
  /** Called when user cancels a job */
  onCancelJob?: (jobId: string) => void;
  /** Called when user wants to add completed asset to timeline */
  onAddToTimeline?: (assetId: string) => void;
  /** Called when user clears completed jobs */
  onClearCompleted?: () => void;
  /** Optional class name */
  className?: string;
}

// =============================================================================
// Component
// =============================================================================

export const GenerationHistory: React.FC<GenerationHistoryProps> = ({
  jobs,
  onCancelJob,
  onAddToTimeline,
  onClearCompleted,
  className = '',
}) => {
  const hasCompletedJobs = jobs.some(
    (j) => j.status === 'completed' || j.status === 'failed' || j.status === 'cancelled',
  );

  const handleClear = useCallback(() => {
    onClearCompleted?.();
  }, [onClearCompleted]);

  if (jobs.length === 0) {
    return (
      <div className={`text-center py-6 text-sm text-editor-text-muted ${className}`}>
        No generation jobs yet
      </div>
    );
  }

  return (
    <div className={className}>
      {/* Header with clear button */}
      {hasCompletedJobs && onClearCompleted && (
        <div className="flex items-center justify-end mb-2">
          <button
            type="button"
            onClick={handleClear}
            className="flex items-center gap-1 px-2 py-1 rounded text-xs text-editor-text-muted hover:text-editor-text hover:bg-editor-bg transition-colors"
          >
            <Trash2 className="w-3 h-3" />
            Clear completed
          </button>
        </div>
      )}

      {/* Job list */}
      <div className="space-y-2">
        {jobs.map((job) => (
          <GenerationJobCard
            key={job.id}
            job={job}
            onCancel={onCancelJob}
            onAddToTimeline={onAddToTimeline}
          />
        ))}
      </div>
    </div>
  );
};
