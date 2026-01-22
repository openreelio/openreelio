/**
 * Store Exports
 *
 * Central export point for all Zustand stores.
 */

export { useProjectStore, setupProxyEventListeners, cleanupProxyEventListeners } from './projectStore';
export { useTimelineStore } from './timelineStore';
export { useJobsStore } from './jobsStore';
export { usePlaybackStore } from './playbackStore';
export { useWaveformCacheStore, createWaveformCacheKey } from './waveformCacheStore';
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
