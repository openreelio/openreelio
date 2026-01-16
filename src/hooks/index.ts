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
