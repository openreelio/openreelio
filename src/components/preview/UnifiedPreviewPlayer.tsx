/**
 * UnifiedPreviewPlayer Component
 *
 * Intelligent preview player that automatically switches between:
 * - ProxyPreviewPlayer (HTML5 video) when proxies are ready
 * - TimelinePreviewPlayer (canvas/frame extraction) as fallback
 *
 * This provides the best viewing experience based on available resources.
 */

import { memo, useMemo } from 'react';
import { TimelinePreviewPlayer } from './TimelinePreviewPlayer';
import { ProxyPreviewPlayer } from './ProxyPreviewPlayer';
import { usePreviewMode } from '@/hooks/usePreviewMode';
import { useProjectStore } from '@/stores/projectStore';
import { usePlaybackStore } from '@/stores/playbackStore';
import type { Sequence } from '@/types';

// =============================================================================
// Types
// =============================================================================

export interface UnifiedPreviewPlayerProps {
  /** The sequence to preview (optional - will use active sequence if not provided) */
  sequence?: Sequence | null;
  /** Additional CSS classes */
  className?: string;
  /** Whether to show playback controls */
  showControls?: boolean;
  /** Whether to show timecode display */
  showTimecode?: boolean;
  /** Whether to show FPS statistics (dev mode) */
  showStats?: boolean;
  /** Callback when playback ends */
  onEnded?: () => void;
  /** Callback when frame is rendered (canvas mode only) */
  onFrameRender?: (time: number) => void;
}

// =============================================================================
// Component
// =============================================================================

export const UnifiedPreviewPlayer = memo(function UnifiedPreviewPlayer({
  sequence: sequenceProp,
  className = '',
  showControls = true,
  showTimecode = true,
  showStats = false,
  onEnded,
  onFrameRender,
}: UnifiedPreviewPlayerProps) {
  // Get sequence from prop or store
  const activeSequenceId = useProjectStore((state) => state.activeSequenceId);
  const sequences = useProjectStore((state) => state.sequences);
  const assets = useProjectStore((state) => state.assets);
  const currentTime = usePlaybackStore((state) => state.currentTime);

  const sequence = useMemo(() => {
    if (sequenceProp !== undefined) {
      return sequenceProp;
    }
    return activeSequenceId ? sequences.get(activeSequenceId) ?? null : null;
  }, [sequenceProp, activeSequenceId, sequences]);

  // Determine optimal preview mode
  const { mode, reason, hasGeneratingProxy } = usePreviewMode({
    sequence,
    assets,
    currentTime,
  });

  // Render proxy-based player for video mode
  if (mode === 'video' && sequence) {
    return (
      <div className={`relative ${className}`} data-testid="unified-preview-player" data-mode="video">
        <ProxyPreviewPlayer
          sequence={sequence}
          assets={assets}
          className="w-full h-full"
          showControls={showControls}
        />

        {/* Mode indicator (dev only) */}
        {showStats && (
          <div className="absolute top-2 left-2 bg-green-600/80 text-white text-xs px-2 py-1 rounded">
            Video Mode
          </div>
        )}
      </div>
    );
  }

  // Render canvas-based player for canvas mode
  return (
    <div className={`relative ${className}`} data-testid="unified-preview-player" data-mode="canvas">
      <TimelinePreviewPlayer
        className="w-full h-full"
        showControls={showControls}
        showTimecode={showTimecode}
        showStats={showStats}
        onEnded={onEnded}
        onFrameRender={onFrameRender}
      />

      {/* Proxy generating indicator */}
      {hasGeneratingProxy && (
        <div className="absolute top-2 left-2 bg-yellow-600/80 text-white text-xs px-2 py-1 rounded flex items-center gap-1">
          <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
            />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
            />
          </svg>
          <span>Generating proxy...</span>
        </div>
      )}

      {/* Mode indicator (dev only) */}
      {showStats && !hasGeneratingProxy && (
        <div className="absolute top-2 left-2 bg-blue-600/80 text-white text-xs px-2 py-1 rounded">
          Canvas Mode: {reason}
        </div>
      )}
    </div>
  );
});
