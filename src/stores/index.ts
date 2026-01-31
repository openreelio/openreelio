/**
 * Store Exports
 *
 * Central export point for all Zustand stores.
 */

import { createLogger } from '@/services/logger';

const logger = createLogger('Stores');

export { useProjectStore, setupProxyEventListeners, cleanupProxyEventListeners } from './projectStore';
export { useTimelineStore } from './timelineStore';
export { useJobsStore } from './jobsStore';
export { usePlaybackStore } from './playbackStore';
export { useWaveformCacheStore, createWaveformCacheKey } from './waveformCacheStore';
export { useSettingsStore } from './settingsStore';
export { useBinStore } from './binStore';
export type { BinState, BinActions, BinStore } from './binStore';
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
import { useBinStore } from './binStore';

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
  useBinStore.getState().reset();

  logger.info('All project stores reset');
}
