/**
 * Utilities Index
 *
 * Exports all utility functions.
 */

export {
  formatDuration,
  formatTimecode,
  parseTimecode,
  formatFileSize,
  formatRelativeTime,
} from './formatters';

export {
  isError,
  isErrorLike,
  extractErrorMessage,
  normalizeError,
  getUserFriendlyError,
  getErrorSeverity,
  createErrorHandler,
} from './errorMessages';

export {
  checkFFmpeg,
  extractFrame,
  probeMedia,
  generateThumbnail,
  generateWaveform,
  getTempFramePath,
  isVideoFile,
  isAudioFile,
  isImageFile,
} from './ffmpeg';

export {
  loadRecentProjects,
  saveRecentProjects,
  addRecentProject,
  removeRecentProject,
  removeRecentProjectByPath,
  clearRecentProjects,
  getRecentProjectById,
  getRecentProjectByPath,
  type RecentProject,
} from './recentProjects';

export {
  timeToPixel,
  pixelToTime,
  snapToGrid,
  clampTime,
  calculateClipBounds,
  calculateDragDelta,
  calculateClipDuration,
  calculateClipEndTime,
  isTimeWithinClip,
  findNearestSnapPoint,
  getGridIntervalForZoom,
  MIN_CLIP_DURATION,
  DEFAULT_ZOOM,
  GRID_INTERVALS,
  type TimelineScale,
  type ClipBounds,
  type ClipBoundsParams,
  type DragDeltaResult,
} from './timeline';

export {
  getSnapPoints,
  findNearestSnapPoint as findNearestSnapPointAdvanced,
  snapToNearestPoint,
  createClipSnapPoints,
  createPlayheadSnapPoint,
  createMarkerSnapPoint,
  createGridSnapPoints,
  calculateSnapThreshold,
  getSnapIndicatorPosition,
  type SnapPointType,
  type SnapPoint,
  type SnapResult,
  type NearestSnapResult,
  type ClipInfo,
  type GetSnapPointsOptions,
} from './gridSnapping';

export {
  validateProjectName,
  buildProjectPath,
  isValidProjectName,
  type ProjectNameValidationResult,
} from './projectPath';

export {
  validateDrop,
  checkClipOverlap,
  isAssetCompatibleWithTrack,
  getTrackTypeMismatchMessage,
  validDrop,
  invalidDrop,
  type DropInvalidReason,
  type DropValidity,
  type DropValidationContext,
} from './dropValidity';

export {
  transitions,
  durations,
  easings,
  springConfig,
  getTransition,
  createTransition,
  prefersReducedMotion,
  getSafeDuration,
} from './animations';

export {
  CommandQueue,
  commandQueue,
  _resetCommandQueueForTesting,
  type CancellableOperation,
  type QueueStatus,
} from './commandQueue';

export {
  RequestDeduplicator,
  requestDeduplicator,
  _resetDeduplicatorForTesting,
} from './requestDeduplicator';

export {
  fetchProjectState,
  transformProjectState,
  refreshProjectState,
  applyProjectState,
  type BackendProjectState,
  type TransformedProjectState,
} from './stateRefreshHelper';

export {
  shotResultToShot,
  shotResultsToShots,
  shotToShotResult,
  mergeShots,
} from './shotConverter';

export {
  easingFunctions,
  interpolateValue,
  getValueAtTime,
  getKeyframesInRange,
  hasKeyframeAtTime,
  getKeyframeAtTime,
  getKeyframeEasingFunction,
  type InterpolatedValue,
  type InterpolationOptions,
  type EasingFunction,
} from './keyframeInterpolation';

export {
  getEffectParamDefs,
  AUDIO_EFFECT_PARAM_DEFS,
  VIDEO_EFFECT_PARAM_DEFS,
  TRANSITION_EFFECT_PARAM_DEFS,
} from './effectParamDefs';

export {
  evaluateCubicBezier,
  createBezierEasing,
  isValidBezierPoints,
  clampBezierPoints,
  BEZIER_PRESETS,
  type BezierPoints,
  type EasingFn,
} from './bezierCurve';
