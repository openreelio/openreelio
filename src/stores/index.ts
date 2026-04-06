/**
 * Store Exports
 *
 * Central export point for all Zustand stores.
 */

import { createLogger } from '@/services/logger';

const logger = createLogger('Stores');

export {
  useProjectStore,
  setupProxyEventListeners,
  cleanupProxyEventListeners,
} from './projectStore';
export { useTimelineStore } from './timelineStore';
export { useJobsStore } from './jobsStore';
export { usePlaybackStore } from './playbackStore';
export { useWaveformCacheStore, createWaveformCacheKey } from './waveformCacheStore';
export { useSettingsStore } from './settingsStore';
export { useEditorToolStore, TOOL_CONFIGS, getToolCursor } from './editorToolStore';
export type { EditorTool, ToolConfig, ClipboardItem, EditorToolStore } from './editorToolStore';

export {
  useShortcutStore,
  formatShortcut,
  DEFAULT_SHORTCUTS,
  SHORTCUT_PRESETS,
} from './shortcutStore';
export type {
  ShortcutBinding,
  ShortcutPreset,
  ShortcutConflict,
  ShortcutStore,
} from './shortcutStore';

export { useAudioMixerStore } from './audioMixerStore';
export type {
  TrackMixerState,
  MasterMixerState,
  StereoLevels,
  AudioMixerStore,
} from './audioMixerStore';
export {
  useAnnotationStore,
  selectShots,
  selectIsAnalyzing,
  selectHasCloudProvider,
  selectProgress,
  selectIsAnalyzed,
  selectIsStale,
} from './annotationStore';
export type { AnalysisRequest, AnnotationState } from './annotationStore';
export type { Job, JobStatus, JobType, JobProgress } from './jobsStore';
export type { PlaybackState, PlaybackActions, PlaybackStore } from './playbackStore';
export type {
  WaveformCacheEntry,
  WaveformRequest,
  WaveformCacheStats,
  WaveformCacheState,
  WaveformCacheActions,
} from './waveformCacheStore';

export {
  useAIStore,
  setupAIEventListeners,
  cleanupAIEventListeners,
  selectIsAIReady,
  selectProviderType,
  selectHasPendingProposal,
} from './aiStore';
export type {
  ProviderType,
  ProviderStatus,
  ProviderConfig,
  EditCommand,
  RiskAssessment,
  EditScript,
  ProposalStatus,
  AIProposal,
  ChatMessage,
  AIContext,
} from './aiStore';

export {
  useModalStore,
  isModalType,
  getModalPayload,
  getModalInfo,
  useOpenModal,
  useCloseModal,
  useIsModalOpen,
  useCurrentModal,
} from './modalStore';
export type { ModalState, OpenableModal, ModalStore } from './modalStore';

export {
  useRenderQueueStore,
  usePendingRenderJobs,
  useActiveRenderJobs,
  useRenderQueueStats,
  useRenderJob,
} from './renderQueueStore';
export type {
  RenderJobType,
  RenderJobStatus,
  RenderPhase,
  RenderPriority,
  RenderProgress,
  RenderResult,
  RenderJob,
  QueueStats,
  RenderQueueStore,
} from './renderQueueStore';

export { useUIStore } from './uiStore';
export type { SettingsTab } from './uiStore';

export {
  useCommandPaletteStore,
  selectIsCommandPaletteOpen,
  selectSearchQuery,
  selectSelectedIndex,
} from './commandPaletteStore';
export type { PaletteAction, ActionCategory } from './commandPaletteStore';

export {
  useWorkspaceStore,
  setupWorkspaceEventListeners,
  cleanupWorkspaceEventListeners,
  selectFileTree,
  selectIsScanning,
  selectScanResult,
  selectWorkspaceError,
} from './workspaceStore';

export { useConversationStore } from './conversationStore';
export type {
  ConversationState,
  ConversationActions,
  ConversationStore,
} from './conversationStore';
export { useAgentArtifactReviewStore } from './agentArtifactReviewStore';
export { useAgentDelegationStore } from './agentDelegationStore';

export { usePreviewStore, MIN_ZOOM, MAX_ZOOM, ZOOM_STEP, ZOOM_PRESETS } from './previewStore';
export type { ZoomMode, PreviewState, PreviewActions, PreviewStore } from './previewStore';

export {
  useWorkspaceLayoutStore,
  PANEL_REGISTRY,
  WORKSPACE_PRESETS,
  createDefaultLayout,
  findPanelZone,
  findPreset,
  MIN_ZONE_SIZES,
  MAX_ZONE_SIZES,
  selectLayout,
  selectZone,
  selectZoneSizes,
  selectIsDragging,
  selectDraggedPanelId,
  selectActivePresetId,
  selectCustomPresets,
  selectAllPresets,
} from './workspaceLayoutStore';
export type {
  PanelId,
  DockZoneId,
  DockZone,
  ZoneSizes,
  WorkspaceLayout,
  PanelMeta,
  WorkspacePreset,
  WorkspaceLayoutStore,
} from './workspaceLayoutStore';

export {
  useAgentStore,
  useHasActiveSession,
  useCurrentPhase,
  useSessionHistory,
  useAgentPreferences,
} from './agentStore';
export type { SessionState, SessionSummary, AgentPreferences } from './agentStore';

// =============================================================================
// Global Store Reset
// =============================================================================

// Import stores directly since this module is the central export point
// These imports don't cause circular dependencies because they're used synchronously
import { useTimelineStore } from './timelineStore';
import { usePlaybackStore } from './playbackStore';
import { useWaveformCacheStore } from './waveformCacheStore';
import { useAIStore } from './aiStore';
import { useAnnotationStore } from './annotationStore';
import { useEditorToolStore } from './editorToolStore';
import { useAudioMixerStore } from './audioMixerStore';
import { useModalStore } from './modalStore';
import { useRenderQueueStore } from './renderQueueStore';
import { useConversationStore } from './conversationStore';
import { useAgentArtifactReviewStore } from './agentArtifactReviewStore';
import { useAgentDelegationStore } from './agentDelegationStore';
import { usePreviewStore } from './previewStore';
import { useAgentStore } from './agentStore';
import { useWorkspaceStore, cleanupWorkspaceEventListeners } from './workspaceStore';
import { useCommandPaletteStore } from './commandPaletteStore';
import { useWorkspaceLayoutStore } from './workspaceLayoutStore';

/**
 * Reset all project-related stores to their initial state.
 * Call this when closing a project to ensure clean state for the next project.
 *
 * Note: This does not reset settings store as settings persist across projects.
 */
export function resetProjectStores(): void {
  // Reset each store
  useTimelineStore.getState().reset();
  usePlaybackStore.getState().reset();
  useWaveformCacheStore.getState().clearCache();
  useAIStore.getState().clearChatHistory();
  useAnnotationStore.getState().reset();
  useEditorToolStore.getState().reset();
  useAudioMixerStore.getState().reset();
  useModalStore.getState().closeModal();
  useRenderQueueStore.getState().clearAll();
  useConversationStore.getState().clearConversation();
  useAgentArtifactReviewStore.getState().clearSelection();
  useAgentDelegationStore.getState().clear();
  usePreviewStore.getState().resetView();
  useAgentStore.getState().reset();
  useWorkspaceStore.getState().reset();
  useCommandPaletteStore.getState().close();
  useWorkspaceLayoutStore.getState().clearTransientState();
  cleanupWorkspaceEventListeners();

  logger.info('All project stores reset');
}
