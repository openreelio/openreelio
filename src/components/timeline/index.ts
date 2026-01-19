/**
 * Timeline Components Index
 *
 * Exports all timeline-related components.
 */

// Main components
export { Timeline } from './Timeline';

// Types (now from dedicated types file)
export type {
  AssetDropData,
  ClipMoveData,
  ClipTrimData,
  ClipSplitData,
  TrackControlData,
  TimelineProps,
  ClipClickModifiers,
} from './types';

// Constants
export {
  TRACK_HEADER_WIDTH,
  TRACK_HEIGHT,
  DEFAULT_TIMELINE_DURATION,
  DEFAULT_FPS,
  MIN_ZOOM,
  MAX_ZOOM,
  DEFAULT_ZOOM,
  ZOOM_STEP,
} from './constants';
export { TimeRuler } from './TimeRuler';
export { Track } from './Track';
export { Clip } from './Clip';
export type { ClickModifiers, ClipWaveformConfig } from './Clip';
export { Playhead } from './Playhead';
export { TimelineToolbar } from './TimelineToolbar';
export type { TimelineToolbarProps } from './TimelineToolbar';
export { ThumbnailStrip } from './ThumbnailStrip';
export type { ThumbnailStripProps } from './ThumbnailStrip';
export { LazyThumbnailStrip } from './LazyThumbnailStrip';
export type { LazyThumbnailStripProps } from './LazyThumbnailStrip';
export { AudioClipWaveform } from './AudioClipWaveform';
export type { AudioClipWaveformProps } from './AudioClipWaveform';
export { VirtualizedTrack } from './VirtualizedTrack';
export type { VirtualizedTrackProps } from './VirtualizedTrack';

// Layer components
export { DragPreviewLayer } from './DragPreviewLayer';
export type { DragPreviewState } from './DragPreviewLayer';
export { SnapIndicator } from './SnapIndicator';
export type { SnapPoint } from './SnapIndicator';
