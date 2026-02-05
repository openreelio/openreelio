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

export { useKeyboardShortcutsHelp } from './useKeyboardShortcutsHelp';
export type { UseKeyboardShortcutsHelpReturn } from './useKeyboardShortcutsHelp';

export { useTimelineActions } from './useTimelineActions';

export { useAudioPlayback } from './useAudioPlayback';
export type { UseAudioPlaybackOptions, UseAudioPlaybackReturn } from './useAudioPlayback';

export { useVideoSync, calculateTimelineTime, isTimeInClip, getClipTimelineDuration } from './useVideoSync';
export type { UseVideoSyncOptions, UseVideoSyncReturn } from './useVideoSync';

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

export { useSnapDetection } from './useSnapDetection';
export type {
  ExtendedSnapPoint,
  UseSnapDetectionOptions,
  UseSnapDetectionReturn,
} from './useSnapDetection';

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

export { useCaptionExport } from './useCaptionExport';
export type { CaptionExportFormat } from './useCaptionExport';

export { useShotDetection } from './useShotDetection';
export type {
  ShotDetectionConfig,
  Shot,
  ShotDetectionResult,
  UseShotDetectionReturn,
} from './useShotDetection';

export { useShotMarkers } from './useShotMarkers';
export type {
  UseShotMarkersOptions,
  UseShotMarkersReturn,
} from './useShotMarkers';

export { useAnnotation } from './useAnnotation';
export type {
  UseAnnotationOptions,
  UseAnnotationResult,
} from './useAnnotation';

export { useAnnotationShots } from './useAnnotationShots';
export type {
  UseAnnotationShotsOptions,
  UseAnnotationShotsReturn,
} from './useAnnotationShots';

export { usePlayheadDrag } from './usePlayheadDrag';
export type {
  UsePlayheadDragOptions,
  UsePlayheadDragResult,
} from './usePlayheadDrag';

export { useProjectHandlers } from './useProjectHandlers';
export type {
  ProjectCreateData,
  UseProjectHandlersOptions,
  UseProjectHandlersResult,
} from './useProjectHandlers';

export { useAppLifecycle } from './useAppLifecycle';

export { useTransitionZones } from './useTransitionZones';
export type {
  TransitionZoneData,
  TransitionZoneOptions,
} from './useTransitionZones';

export { useKeyframeAnimation, useAnimatedEffect } from './useKeyframeAnimation';
export type {
  UseAnimatedEffectOptions,
  AnimatedParams,
} from './useKeyframeAnimation';

export { useEffectParamDefs } from './useEffectParamDefs';

export { useAudioEffectChain } from './useAudioEffectChain';
export type {
  UseAudioEffectChainProps,
  UseAudioEffectChainResult,
} from './useAudioEffectChain';

export { useAudioPlaybackWithEffects } from './useAudioPlaybackWithEffects';
export type {
  UseAudioPlaybackWithEffectsOptions,
  UseAudioPlaybackWithEffectsReturn,
} from './useAudioPlaybackWithEffects';

export { useTextClip } from './useTextClip';
export type {
  AddTextClipParams,
  UpdateTextClipParams,
  RemoveTextClipParams,
  UseTextClipResult,
} from './useTextClip';

export { useVideoScopes } from './useVideoScopes';
export type {
  UseVideoScopesOptions,
  UseVideoScopesResult,
} from './useVideoScopes';

export { useShortcutSettings } from './useShortcutSettings';
export type {
  UseShortcutSettingsReturn,
} from './useShortcutSettings';

export {
  useEdgeAutoScroll,
  getEdgeScrollIndicatorClass,
  getEdgeScrollIndicatorState,
} from './useEdgeAutoScroll';
export type {
  ScrollDirection,
  UseEdgeAutoScrollOptions,
  UseEdgeAutoScrollResult,
} from './useEdgeAutoScroll';

export { useAutoFollow } from './useAutoFollow';
export type {
  UseAutoFollowOptions,
  UseAutoFollowReturn,
} from './useAutoFollow';

export { useRazorTool } from './useRazorTool';
export type {
  ClipAtPosition,
  RazorSplitData,
  UseRazorToolOptions,
  UseRazorToolReturn,
} from './useRazorTool';

export {
  useEnhancedKeyboardShortcuts,
  ENHANCED_KEYBOARD_SHORTCUTS,
} from './useEnhancedKeyboardShortcuts';
export type {
  ClipDuplicateData,
  ClipPasteData,
  UseEnhancedKeyboardShortcutsOptions,
} from './useEnhancedKeyboardShortcuts';

export { useClipboard } from './useClipboard';
export type {
  ClipboardOperationResult,
  UseClipboardOptions,
  UseClipboardReturn,
} from './useClipboard';

export { useRippleEdit } from './useRippleEdit';
export type {
  RippleOperation,
  RippleResult,
  UseRippleEditOptions,
  UseRippleEditReturn,
} from './useRippleEdit';

export { useSlipEdit } from './useSlipEdit';
export type {
  SlipEditState,
  SlipEditResult,
  UseSlipEditOptions,
  UseSlipEditReturn,
} from './useSlipEdit';

export { useSlideEdit } from './useSlideEdit';
export type {
  AdjacentClip,
  SlideEditState,
  SlideEditResult,
  UseSlideEditOptions,
  UseSlideEditReturn,
} from './useSlideEdit';

export { useRollEdit } from './useRollEdit';
export type {
  EditPoint,
  RollEditState,
  RollEditResult,
  UseRollEditOptions,
  UseRollEditReturn,
} from './useRollEdit';

export { useAudioMixer } from './useAudioMixer';
export type {
  UseAudioMixerOptions,
  UseAudioMixerReturn,
} from './useAudioMixer';

export { useBinOperations } from './useBinOperations';

export {
  KeyboardScopeProvider,
  useKeyboardScope,
  useRegisterShortcuts,
  useScopedKeyHandler,
  useIsShortcutsActive,
  useCurrentScopeId,
  SCOPE_PRIORITY,
} from './useKeyboardScope';
export type {
  ShortcutHandler,
  KeyboardScope,
  ShortcutOptions,
  ScopePriorityLevel,
  KeyboardScopeContextValue,
} from './useKeyboardScope';

export { useModalKeyboardScope } from './useModalKeyboardScope';
export type {
  UseModalKeyboardScopeOptions,
  UseModalKeyboardScopeReturn,
} from './useModalKeyboardScope';

export { useColorWheels } from './useColorWheels';
export type {
  WheelLuminance,
  UseColorWheelsOptions,
  UseColorWheelsReturn,
} from './useColorWheels';

export { useMulticam } from './useMulticam';
export type {
  GridLayout,
  UseMulticamOptions,
  UseMulticamReturn,
} from './useMulticam';

export { useMulticamKeyboardShortcuts } from './useMulticamKeyboardShortcuts';
export type {
  MulticamShortcut,
  UseMulticamKeyboardShortcutsOptions,
  UseMulticamKeyboardShortcutsReturn,
} from './useMulticamKeyboardShortcuts';

export { useBlendMode } from './useBlendMode';
export type {
  VideoTrackInfo,
  UseBlendModeReturn,
} from './useBlendMode';

// Mask (Power Windows) hooks
export { useMask } from './useMask';
export type {
  AddMaskPayload,
  UpdateMaskPayload,
  RemoveMaskPayload,
  UseMaskResult,
} from './useMask';

export { useMaskEditor } from './useMaskEditor';
export type {
  MaskTool,
  UseMaskEditorOptions,
  UseMaskEditorResult,
} from './useMaskEditor';

// HSL Qualifier hook
export { useQualifier } from './useQualifier';
export type {
  UseQualifierOptions,
  UseQualifierResult,
} from './useQualifier';

// HDR Settings hook
export { useHDRSettings } from './useHDRSettings';
export type {
  HdrPreset,
  UseHDRSettingsOptions,
  UseHDRSettingsResult,
} from './useHDRSettings';

// Chroma Key hook
export {
  useChromaKey,
  DEFAULT_CHROMA_KEY_PARAMS,
} from './useChromaKey';
export type {
  ChromaKeyParams,
  ChromaKeyPreset,
  UseChromaKeyOptions,
  UseChromaKeyReturn,
} from './useChromaKey';
