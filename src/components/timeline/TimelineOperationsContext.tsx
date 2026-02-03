/**
 * TimelineOperationsContext
 *
 * Provides timeline operation callbacks to all components in the timeline tree
 * without prop drilling. This context is used by Track, Clip, and other
 * timeline sub-components to perform operations like move, trim, split, etc.
 *
 * @example
 * ```tsx
 * // In Timeline.tsx
 * <TimelineOperationsProvider operations={...}>
 *   <Track />
 * </TimelineOperationsProvider>
 *
 * // In Clip.tsx
 * const { onClipMove, onClipTrim } = useTimelineOperations();
 * ```
 */

import { createContext, useContext, type ReactNode } from 'react';
import type {
  AssetDropData,
  ClipMoveData,
  ClipTrimData,
  ClipSplitData,
  ClipDuplicateData,
  ClipPasteData,
  TrackControlData,
} from './types';

// =============================================================================
// Types
// =============================================================================

/**
 * Timeline operations that can be performed by sub-components.
 * All operations are optional - components should check before calling.
 */
export interface TimelineOperations {
  /** Callback when clips should be deleted */
  onDeleteClips?: (clipIds: string[]) => void;
  /** Callback when asset is dropped on timeline */
  onAssetDrop?: (data: AssetDropData) => void;
  /** Callback when clip is moved */
  onClipMove?: (data: ClipMoveData) => void;
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
  /** Callback when Add Text button is clicked */
  onAddText?: () => void;
}

// =============================================================================
// Context
// =============================================================================

/**
 * Context for timeline operations.
 * Initialized with empty object - components should check for undefined operations.
 */
const TimelineOperationsContext = createContext<TimelineOperations>({});

// =============================================================================
// Provider
// =============================================================================

export interface TimelineOperationsProviderProps {
  children: ReactNode;
  operations: TimelineOperations;
}

/**
 * Provider component for timeline operations.
 * Wrap the timeline component tree with this provider to enable operation callbacks.
 */
export function TimelineOperationsProvider({
  children,
  operations,
}: TimelineOperationsProviderProps): JSX.Element {
  return (
    <TimelineOperationsContext.Provider value={operations}>
      {children}
    </TimelineOperationsContext.Provider>
  );
}

// =============================================================================
// Hook
// =============================================================================

/**
 * Hook to access timeline operations from any component in the timeline tree.
 *
 * @example
 * ```tsx
 * const { onClipMove, onClipTrim } = useTimelineOperations();
 *
 * const handleMove = () => {
 *   onClipMove?.({ sequenceId, trackId, clipId, newTimelineIn });
 * };
 * ```
 */
export function useTimelineOperations(): TimelineOperations {
  return useContext(TimelineOperationsContext);
}

// =============================================================================
// Exports
// =============================================================================

export { TimelineOperationsContext };
