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
