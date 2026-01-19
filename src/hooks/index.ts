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

export { useFrameExtractor } from './useFrameExtractor';
export type {
  UseFrameExtractorOptions,
  UseFrameExtractorReturn,
} from './useFrameExtractor';

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
