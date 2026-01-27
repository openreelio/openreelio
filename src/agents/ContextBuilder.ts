/**
 * Context Builder
 *
 * Builds AgentContext from application state for AI agent processing.
 * Uses builder pattern for flexible context construction.
 */

import type { AgentContext } from './Agent';

// =============================================================================
// Types
// =============================================================================

/** Clip data from project state */
interface ClipData {
  id: string;
  sourceId: string;
  place: {
    timelineInSec: number;
    durationSec: number;
  };
}

/** Track data from project state */
interface TrackData {
  id: string;
  type?: string;
  clips: ClipData[];
}

/** Sequence data from project state */
interface SequenceData {
  id: string;
  name: string;
  tracks: TrackData[];
}

/** Project state shape (simplified for context building) */
export interface ProjectStateShape {
  activeSequenceId?: string | null;
  sequences?: Map<string, SequenceData>;
  assets?: Map<string, { id: string; name: string; type: string }>;
}

/** Timeline state shape (simplified for context building) */
export interface TimelineStateShape {
  playhead?: number;
  selectedClipIds?: string[];
  selectedTrackIds?: string[];
  zoom?: number;
  scrollPosition?: number;
}

/** Options for buildAgentContext helper */
export interface AgentContextOptions {
  projectState?: ProjectStateShape;
  timelineState?: TimelineStateShape;
  includeClipDetails?: boolean;
  includeTrackSummary?: boolean;
  additionalMetadata?: Record<string, unknown>;
}

/** Detailed clip information for context */
interface ClipDetail {
  id: string;
  sourceId: string;
  startTime: number;
  duration: number;
}

/** Track summary for context */
interface TrackSummary {
  id: string;
  type: string;
  clipCount: number;
}

// =============================================================================
// Context Builder
// =============================================================================

/**
 * Builder class for constructing AgentContext from various sources.
 *
 * Usage:
 * ```typescript
 * const context = new ContextBuilder()
 *   .withProjectId('proj_001')
 *   .fromProjectState(projectState)
 *   .fromTimelineState(timelineState)
 *   .withClipDetails(true)
 *   .build();
 * ```
 */
export class ContextBuilder {
  private context: AgentContext = {};
  private projectState: ProjectStateShape | null = null;
  private includeClipDetails = false;
  private includeTrackSummary = false;

  // ===========================================================================
  // Basic Setters
  // ===========================================================================

  /**
   * Set the project ID.
   */
  withProjectId(projectId: string): this {
    this.context.projectId = projectId;
    return this;
  }

  /**
   * Set the sequence ID.
   */
  withSequenceId(sequenceId: string): this {
    this.context.sequenceId = sequenceId;
    return this;
  }

  /**
   * Set the playhead position.
   */
  withPlayheadPosition(position: number): this {
    this.context.playheadPosition = position;
    return this;
  }

  /**
   * Set the timeline duration.
   */
  withTimelineDuration(duration: number): this {
    this.context.timelineDuration = duration;
    return this;
  }

  /**
   * Set selected clip IDs.
   */
  withSelectedClips(clipIds: string[]): this {
    this.context.selectedClipIds = clipIds;
    return this;
  }

  /**
   * Set selected track IDs.
   */
  withSelectedTracks(trackIds: string[]): this {
    this.context.selectedTrackIds = trackIds;
    return this;
  }

  /**
   * Add custom metadata.
   */
  withMetadata(metadata: Record<string, unknown>): this {
    this.context.metadata = {
      ...this.context.metadata,
      ...metadata,
    };
    return this;
  }

  // ===========================================================================
  // State Integration
  // ===========================================================================

  /**
   * Build context from project store state.
   */
  fromProjectState(state: ProjectStateShape): this {
    this.projectState = state;

    // Set sequence ID
    if (state.activeSequenceId) {
      this.context.sequenceId = state.activeSequenceId;
    }

    // Calculate timeline duration from active sequence
    if (state.activeSequenceId && state.sequences) {
      const sequence = state.sequences.get(state.activeSequenceId);
      if (sequence) {
        const duration = this.calculateTimelineDuration(sequence);
        this.context.timelineDuration = duration;
      }
    }

    return this;
  }

  /**
   * Build context from timeline store state.
   */
  fromTimelineState(state: TimelineStateShape): this {
    if (state.playhead !== undefined) {
      this.context.playheadPosition = state.playhead;
    }

    if (state.selectedClipIds) {
      this.context.selectedClipIds = [...state.selectedClipIds];
    }

    if (state.selectedTrackIds) {
      this.context.selectedTrackIds = [...state.selectedTrackIds];
    }

    return this;
  }

  // ===========================================================================
  // Detail Options
  // ===========================================================================

  /**
   * Include detailed clip information in metadata.
   */
  withClipDetails(include: boolean): this {
    this.includeClipDetails = include;
    return this;
  }

  /**
   * Include track summary in metadata.
   */
  withTrackSummary(include: boolean): this {
    this.includeTrackSummary = include;
    return this;
  }

  // ===========================================================================
  // Build
  // ===========================================================================

  /**
   * Build the final AgentContext.
   */
  build(): AgentContext {
    // Add clip details if requested
    if (this.includeClipDetails && this.projectState && this.context.selectedClipIds) {
      const clipDetails = this.getSelectedClipDetails();
      if (clipDetails.length > 0) {
        this.withMetadata({ selectedClipDetails: clipDetails });
      }
    }

    // Add track summary if requested
    if (this.includeTrackSummary && this.projectState) {
      const trackSummary = this.getTrackSummary();
      if (trackSummary.length > 0) {
        this.withMetadata({ trackSummary });
      }
    }

    return { ...this.context };
  }

  /**
   * Reset the builder state.
   */
  reset(): this {
    this.context = {};
    this.projectState = null;
    this.includeClipDetails = false;
    this.includeTrackSummary = false;
    return this;
  }

  // ===========================================================================
  // Private Helpers
  // ===========================================================================

  /**
   * Calculate the total timeline duration from a sequence.
   */
  private calculateTimelineDuration(sequence: SequenceData): number {
    let maxEnd = 0;

    for (const track of sequence.tracks) {
      for (const clip of track.clips) {
        const clipEnd = clip.place.timelineInSec + clip.place.durationSec;
        maxEnd = Math.max(maxEnd, clipEnd);
      }
    }

    return maxEnd;
  }

  /**
   * Get detailed information for selected clips.
   */
  private getSelectedClipDetails(): ClipDetail[] {
    if (!this.projectState || !this.context.selectedClipIds) {
      return [];
    }

    const selectedIds = new Set(this.context.selectedClipIds);
    const details: ClipDetail[] = [];
    const sequence = this.getActiveSequence();

    if (!sequence) return [];

    for (const track of sequence.tracks) {
      for (const clip of track.clips) {
        if (selectedIds.has(clip.id)) {
          details.push({
            id: clip.id,
            sourceId: clip.sourceId,
            startTime: clip.place.timelineInSec,
            duration: clip.place.durationSec,
          });
        }
      }
    }

    return details;
  }

  /**
   * Get summary of all tracks in the active sequence.
   */
  private getTrackSummary(): TrackSummary[] {
    const sequence = this.getActiveSequence();
    if (!sequence) return [];

    return sequence.tracks.map((track) => ({
      id: track.id,
      type: track.type ?? 'unknown',
      clipCount: track.clips.length,
    }));
  }

  /**
   * Get the active sequence from project state.
   */
  private getActiveSequence(): SequenceData | null {
    if (!this.projectState?.activeSequenceId || !this.projectState.sequences) {
      return null;
    }

    return this.projectState.sequences.get(this.projectState.activeSequenceId) ?? null;
  }
}

// =============================================================================
// Helper Function
// =============================================================================

/**
 * Build an AgentContext from options.
 *
 * This is a convenience function for building context without
 * explicitly using the builder pattern.
 *
 * @param options - Context building options
 * @returns The built AgentContext
 */
export function buildAgentContext(options: AgentContextOptions): AgentContext {
  const builder = new ContextBuilder();

  if (options.projectState) {
    builder.fromProjectState(options.projectState);
  }

  if (options.timelineState) {
    builder.fromTimelineState(options.timelineState);
  }

  if (options.includeClipDetails) {
    builder.withClipDetails(true);
  }

  if (options.includeTrackSummary) {
    builder.withTrackSummary(true);
  }

  if (options.additionalMetadata) {
    builder.withMetadata(options.additionalMetadata);
  }

  return builder.build();
}
