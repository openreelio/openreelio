/**
 * Services Index
 *
 * Centralized exports for application services.
 */

export {
  createLogger,
  addLogHandler,
  removeLogHandler,
  clearLogHandlers,
  setGlobalLogLevel,
  getGlobalLogLevel,
  consoleHandler,
  initializeLogger,
  LogLevel,
  type Logger,
  type LogEntry,
  type LogHandler,
} from './logger';

export { FrameCache, frameCache, type FrameCacheConfig, type CacheStats } from './frameCache';

export {
  createAudioEffectNode,
  updateAudioEffectNode,
  getEffectNodeType,
  convertDbToLinear,
  convertLinearToDb,
  type AudioNodeType,
  type EffectNodeConfig,
  type AudioEffectNode,
} from './audioEffectFactory';

export {
  PlaybackController,
  playbackController,
  usePlaybackController,
  type SyncState,
  type DragOperation,
  type PlaybackMode,
  type PlaybackEvent,
  type PlaybackEventListener,
  type PlaybackControllerConfig,
} from './PlaybackController';

export {
  SnapPointManager,
  snapPointManager,
  useSnapPointManager,
  type SnapPointSource,
  type SnapPointManagerConfig,
  type SnapResult,
} from './SnapPointManager';

export {
  PlaybackMonitor,
  playbackMonitor,
  usePlaybackMonitor,
  type DriftEvent,
  type FrameStats,
  type SessionStats,
} from './playbackMonitor';

export {
  fetchWorkspaceTreeFromBackend,
  scanWorkspaceFromBackend,
  createFolderInBackend,
  renameFileInBackend,
  moveFileInBackend,
  deleteFileInBackend,
  revealInExplorerFromBackend,
} from './workspaceGateway';
