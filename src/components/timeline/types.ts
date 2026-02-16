/**
 * Timeline Component Types
 *
 * Type definitions for the Timeline component and its sub-components.
 * Centralized to avoid duplication and improve maintainability.
 */

import type { Sequence } from '@/types';

// =============================================================================
// Asset Drop Types
// =============================================================================

/**
 * Data passed when an asset is dropped on the timeline.
 */
export interface AssetDropData {
  /** ID of the dropped asset */
  assetId: string;
  /** ID of the track where asset was dropped */
  trackId: string;
  /** Timeline position in seconds where asset was dropped */
  timelinePosition: number;
}

// =============================================================================
// Clip Operation Types
// =============================================================================

/**
 * Data for moving a clip to a new position.
 */
export interface ClipMoveData {
  /** ID of the sequence containing the clip */
  sequenceId: string;
  /** ID of the track containing the clip */
  trackId: string;
  /** ID of the clip being moved */
  clipId: string;
  /** New timeline in position in seconds */
  newTimelineIn: number;
  /** Optional new track ID if moving to different track */
  newTrackId?: string;
  /** If true, bypass linked companion operations for this action */
  ignoreLinkedSelection?: boolean;
}

/**
 * Data for trimming a clip.
 */
export interface ClipTrimData {
  /** ID of the sequence containing the clip */
  sequenceId: string;
  /** ID of the track containing the clip */
  trackId: string;
  /** ID of the clip being trimmed */
  clipId: string;
  /** New source in position (for left trim) */
  newSourceIn?: number;
  /** New source out position (for right trim) */
  newSourceOut?: number;
  /** New timeline in position (for left trim) */
  newTimelineIn?: number;
  /** If true, bypass linked companion operations for this action */
  ignoreLinkedSelection?: boolean;
}

/**
 * Data for splitting a clip at a specific time.
 */
export interface ClipSplitData {
  /** ID of the sequence containing the clip */
  sequenceId: string;
  /** ID of the track containing the clip */
  trackId: string;
  /** ID of the clip being split */
  clipId: string;
  /** Time position to split at */
  splitTime: number;
  /** If true, keep only the left portion after split */
  keepLeft?: boolean;
  /** If true, keep only the right portion after split */
  keepRight?: boolean;
  /** If true, bypass linked companion operations for this action */
  ignoreLinkedSelection?: boolean;
}

/**
 * Data for duplicating a clip.
 */
export interface ClipDuplicateData {
  /** ID of the sequence containing the clip */
  sequenceId: string;
  /** ID of the track containing the clip */
  trackId: string;
  /** ID of the clip being duplicated */
  clipId: string;
  /** Timeline position for the duplicate */
  newTimelineIn: number;
  /** If true, bypass linked companion operations for this action */
  ignoreLinkedSelection?: boolean;
}

/**
 * Data for pasting a clip from clipboard.
 */
export interface ClipPasteData {
  /** ID of the target sequence */
  sequenceId: string;
  /** ID of the target track */
  trackId: string;
  /** Serialized clip data */
  clipData: {
    assetId: string;
    label?: string;
    timelineIn: number;
    sourceIn: number;
    sourceOut: number;
    speed: number;
    volume: number;
    opacity: number;
  };
  /** Timeline position to paste at */
  pasteTime: number;
}

/**
 * Data for updating a caption.
 */
export interface CaptionUpdateData {
  /** ID of the sequence containing the caption */
  sequenceId: string;
  /** ID of the track containing the caption */
  trackId: string;
  /** ID of the caption being updated */
  captionId: string;
  /** New text content */
  text?: string;
  /** New start time */
  startSec?: number;
  /** New end time */
  endSec?: number;
  /** Style updates (JSON string or object) */
  style?: unknown;
}

// =============================================================================
// Track Control Types

// =============================================================================

/**
 * Data for track control operations (mute, lock, visibility).
 */
export interface TrackControlData {
  /** ID of the sequence containing the track */
  sequenceId: string;
  /** ID of the track being controlled */
  trackId: string;
}

/**
 * Data for creating a new timeline track.
 */
export interface TrackCreateData {
  /** ID of the sequence where the track should be created */
  sequenceId: string;
  /** Track kind to create */
  kind: 'video' | 'audio';
  /** Optional custom track name */
  name?: string;
  /** Optional insertion position (0-based) */
  position?: number;
}

// =============================================================================
// Component Props Types
// =============================================================================

/**
 * Props for the main Timeline component.
 *
 * Note: Caption updates are handled through the Inspector component, not Timeline.
 * When a caption is selected in the timeline, its properties are edited via Inspector.
 */
export interface TimelineProps {
  /** Sequence to display */
  sequence: Sequence | null;
  /** Callback when clips should be deleted */
  onDeleteClips?: (clipIds: string[]) => void | Promise<void>;
  /** Callback when asset is dropped on timeline */
  onAssetDrop?: (data: AssetDropData) => void;
  /** Callback when clip is moved */
  onClipMove?: (data: ClipMoveData) => void | Promise<void>;
  /** Callback when clip is trimmed */
  onClipTrim?: (data: ClipTrimData) => void;
  /** Callback when clip is split */
  onClipSplit?: (data: ClipSplitData) => void;
  /** Callback when clip is duplicated */
  onClipDuplicate?: (data: ClipDuplicateData) => void;
  /** Callback when clip is pasted */
  onClipPaste?: (data: ClipPasteData) => void;
  /** Callback when track mute is toggled */
  onTrackMuteToggle?: (data: TrackControlData) => void;
  /** Callback when track lock is toggled */
  onTrackLockToggle?: (data: TrackControlData) => void;
  /** Callback when track visibility is toggled */
  onTrackVisibilityToggle?: (data: TrackControlData) => void;
  /** Callback when a new track should be created */
  onTrackCreate?: (data: TrackCreateData) => void | Promise<void>;
  /** Callback when Add Text button is clicked */
  onAddText?: () => void;
}

// =============================================================================
// Clip Click Modifiers
// =============================================================================

/**
 * Keyboard modifiers during clip click.
 */
export interface ClipClickModifiers {
  /** Whether Ctrl key was held */
  ctrlKey: boolean;
  /** Whether Shift key was held */
  shiftKey: boolean;
  /** Whether Meta key (Cmd on Mac) was held */
  metaKey: boolean;
}
