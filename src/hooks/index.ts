/**
 * Hooks Index
 *
 * Exports all custom hooks.
 */

export { useProject } from './useProject';
export type { UseProjectReturn } from './useProject';

export { useTimeline } from './useTimeline';
export type { UseTimelineReturn } from './useTimeline';

export { useAssetImport } from './useAssetImport';
export type { UseAssetImportReturn } from './useAssetImport';

export { usePreviewSource } from './usePreviewSource';
export type { PreviewSource } from './usePreviewSource';

export { useToast, useToastStore } from './useToast';
export type { UseToastReturn } from './useToast';

export { useKeyboardShortcuts, KEYBOARD_SHORTCUTS } from './useKeyboardShortcuts';
export type { UseKeyboardShortcutsOptions, KeyboardShortcut } from './useKeyboardShortcuts';

export { useTimelineActions } from './useTimelineActions';

export { useAudioPlayback } from './useAudioPlayback';
export type { UseAudioPlaybackOptions, UseAudioPlaybackReturn } from './useAudioPlayback';

export { useVideoSync, calculateTimelineTime, isTimeInClip, getClipTimelineDuration } from './useVideoSync';
export type { UseVideoSyncOptions, UseVideoSyncReturn } from './useVideoSync';

export { useAIAgent } from './useAIAgent';
export type {
  UseAIAgentReturn,
  AIContext,
  EditScript,
  EditCommand,
  ApplyResult,
  ValidationResult,
  RiskAssessment,
  Requirement,
} from './useAIAgent';

export { useFrameExtractor, useAssetFrameExtractor } from './useFrameExtractor';
export type {
  UseFrameExtractorOptions,
  UseFrameExtractorReturn,
  UseAssetFrameExtractorOptions,
  UseAssetFrameExtractorReturn,
} from './useFrameExtractor';

export { usePlaybackLoop } from './usePlaybackLoop';
export type {
  UsePlaybackLoopOptions,
  UsePlaybackLoopReturn,
} from './usePlaybackLoop';

export { useJobs } from './useJobs';
export type {
  UseJobsOptions,
  UseJobsReturn,
} from './useJobs';

export { useAudioWaveform } from './useAudioWaveform';
export type {
  UseAudioWaveformOptions,
  UseAudioWaveformReturn,
} from './useAudioWaveform';

export { useWaveformPeaks } from './useWaveformPeaks';
export type {
  UseWaveformPeaksOptions,
  UseWaveformPeaksReturn,
} from './useWaveformPeaks';

export { useFFmpegStatus } from './useFFmpegStatus';
export type {
  FFmpegStatus,
  UseFFmpegStatusResult,
} from './useFFmpegStatus';

export { useAutoSave } from './useAutoSave';
export type {
  UseAutoSaveOptions,
  UseAutoSaveReturn,
} from './useAutoSave';

export { useClipDrag } from './useClipDrag';
export type {
  DragType,
  ClipDragData,
  DragPreviewPosition,
  UseClipDragOptions,
  UseClipDragReturn,
} from './useClipDrag';

export { useTimelineEngine } from './useTimelineEngine';
export type {
  UseTimelineEngineOptions,
  UseTimelineEngineReturn,
} from './useTimelineEngine';

export { useAsyncCleanup, useAbortController, useCancellablePromise } from './useAsyncCleanup';
export type {
  AsyncCleanupResult,
  AbortControllerResult,
  CancellablePromiseResult,
} from './useAsyncCleanup';

export { useTimelineClipOperations } from './useTimelineClipOperations';
export type {
  UseTimelineClipOperationsProps,
  UseTimelineClipOperationsResult,
} from './useTimelineClipOperations';

export { useTimelineNavigation } from './useTimelineNavigation';
export type {
  UseTimelineNavigationProps,
  UseTimelineNavigationResult,
} from './useTimelineNavigation';

export { useExportDialog } from './useExportDialog';
export type {
  UseExportDialogProps,
  UseExportDialogResult,
} from './useExportDialog';

export { useAssetDrop } from './useAssetDrop';
export type {
  UseAssetDropOptions,
  UseAssetDropResult,
} from './useAssetDrop';

export { useScrubbing } from './useScrubbing';
export type {
  UseScrubbingOptions,
  UseScrubbingResult,
} from './useScrubbing';

export { useTimelineCoordinates } from './useTimelineCoordinates';
export type {
  UseTimelineCoordinatesOptions,
  UseTimelineCoordinatesResult,
} from './useTimelineCoordinates';

export { useTimelineKeyboard } from './useTimelineKeyboard';
export type {
  UseTimelineKeyboardOptions,
  UseTimelineKeyboardResult,
  ClipSplitData,
} from './useTimelineKeyboard';

export {
  useVirtualizedClips,
  sortClipsByPosition,
  calculateTimelineExtent,
} from './useVirtualizedClips';
export type {
  VirtualizationConfig,
  VirtualizedClip,
  UseVirtualizedClipsResult,
} from './useVirtualizedClips';

export { useLazyThumbnails } from './useLazyThumbnails';
export type {
  ThumbnailRequest,
  ThumbnailState,
  LazyThumbnailsConfig,
  UseLazyThumbnailsResult,
} from './useLazyThumbnails';

export { useMemoryMonitor, formatBytes, calculateTrend } from './useMemoryMonitor';
export type {
  PoolStats,
  CacheStats,
  SystemMemory,
  JSHeapStats,
  MemoryStats,
  CleanupResult,
  UseMemoryMonitorOptions,
  UseMemoryMonitorResult,
} from './useMemoryMonitor';

export { useSelectionBox } from './useSelectionBox';
export type {
  Point,
  SelectionRect,
  UseSelectionBoxOptions,
  UseSelectionBoxReturn,
} from './useSelectionBox';

export { useTranscription } from './useTranscription';
export type {
  TranscriptionSegment,
  TranscriptionResult,
  TranscriptionOptions,
  TranscriptionState,
  UseTranscriptionOptions,
  UseTranscriptionReturn,
} from './useTranscription';

export { useSearch } from './useSearch';
export type {
  SearchOptions,
  AssetSearchResult,
  TranscriptSearchResult,
  SearchResults,
  SearchState,
  UseSearchOptions,
  UseSearchReturn,
  // SQLite-based search types (always available)
  AssetSearchOptions,
  AssetSearchResultItem,
  AssetSearchResponse,
} from './useSearch';

export { usePreviewMode } from './usePreviewMode';
export type {
  PreviewMode,
  PreviewModeResult,
  UsePreviewModeOptions,
} from './usePreviewMode';

export { useAISettings } from './useAISettings';
export type {
  AISettingsState,
} from './useAISettings';

export { useTranscriptionWithIndexing } from './useTranscriptionWithIndexing';
export type {
  UseTranscriptionWithIndexingOptions,
  UseTranscriptionWithIndexingReturn,
} from './useTranscriptionWithIndexing';

export { useCaption } from './useCaption';
export type {
  CreateCaptionParams,
  UseCaptionResult,
} from './useCaption';

export { useCursor, getClipCursor, getTimelineCursor } from './useCursor';
export type {
  CursorType,
  UseCursorReturn,
} from './useCursor';

export { useContextMenu, handleContextMenuEvent } from './useContextMenu';
export type {
  ContextMenuState,
  UseContextMenuReturn,
} from './useContextMenu';

export { useSettings } from './useSettings';
export type {
  UseSettingsOptions,
  UseSettingsReturn,
} from './useSettings';

export { useUpdate } from './useUpdate';
export type {
  UseUpdateState,
  UseUpdateActions,
  UseUpdateReturn,
  UseUpdateOptions,
} from './useUpdate';
