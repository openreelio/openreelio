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

export {
  buildBinTree,
  flattenBinTree,
  getBinPath,
  getBinAncestors,
  getBinDescendants,
  getBinChildren,
  getAssetsInBin,
  canMoveBinTo,
  sortBins,
  generateUniqueBinName,
  getDefaultBinColor,
  BIN_COLORS,
  BIN_COLOR_CLASSES,
  type BinTreeNode,
} from './binUtils';

export {
  parseKeySignature,
  buildKeySignature,
  normalizeKeySignature,
  isValidKeySignature,
  keyEventToSignature,
  signatureToDisplayString,
  compareSignatures,
  type KeySignature,
} from './shortcutUtils';

export {
  SHORTCUT_ACTIONS,
  DEFAULT_SHORTCUTS,
  getShortcutAction,
  getActionByShortcut,
  getShortcutForAction,
  getAllShortcuts,
  getShortcutsByCategory,
  type ShortcutAction,
  type ShortcutCategory,
  type ShortcutEntry,
  type CustomShortcuts,
} from './shortcutActions';

export {
  interpolate,
  spring,
  Easing,
  sequence,
  delayToFrames,
  delayedSpring,
  type ExtrapolationMode,
  type InterpolateOptions,
  type SpringConfig,
  type SpringOptions,
} from './interpolation';

export {
  timeToPixels,
  pixelsToTime,
  getTimeFromViewportX,
  getViewportXFromTime,
  getViewportBounds,
  isTimeInViewport,
  ensureTimeInViewport,
  getAutoViewportMode,
  ensureTimeInViewportAuto,
  zoomWithCursorPreservation,
  zoomCenteredOnTime,
  zoomCenteredOnPlayhead,
  calculateFitToWindowZoom,
  fitTimeRangeToViewport,
  calculatePlayheadFollowScroll,
  snapTimeToFrame,
  snapPixelsToFrame,
  clamp,
  smoothZoom,
  calculateZoomStep,
  type ViewportMode,
  type ViewportState,
  type ZoomResult,
  type ViewportBounds,
} from './timelineScrollLogic';

export {
  polarToCartesian,
  cartesianToPolar,
  clampToCircle,
  cartesianToColorOffset,
  colorOffsetToCartesian,
  wheelPositionToRGB,
  rgbToWheelPosition,
  applyLiftGammaGain,
  createLiftGammaGainMatrix,
  createNeutralLGG,
  isNeutralLGG,
  lggToFFmpegFilter,
  type ColorOffset,
  type WheelPosition,
  type LiftGammaGain,
  type RGBColor,
  type CartesianPoint,
  type PolarPoint,
} from './colorWheel';

export {
  createMulticamGroup,
  validateMulticamGroup,
  normalizeWaveformPeaks,
  calculateCrossCorrelation,
  findAudioSyncOffset,
  canSyncAngles,
  addAngleToGroup,
  removeAngleFromGroup,
  switchActiveAngle,
  createAngleSwitchPoint,
  validateAngleSwitch,
  getAngleAtTime,
  getAngleSwitchesInRange,
  sortAngleSwitches,
  calculateGroupDuration,
  mergeOverlappingGroups,
  splitMulticamGroup,
  type AudioMixMode,
  type AngleTransitionType,
  type MulticamAngle,
  type AngleSwitch,
  type MulticamGroup,
  type CreateMulticamGroupOptions,
  type ValidationResult,
  type CreateAngleSwitchOptions,
  type AngleSwitchValidationResult,
  type AngleAtTimeResult,
  type AudioSyncResult,
  type AudioSyncOptions,
} from './multicam';

export {
  BLEND_MODE_DEFINITIONS,
  BLEND_MODE_CATEGORY_LABELS,
  ALL_BLEND_MODES,
  DEFAULT_BLEND_MODE,
  getBlendModeLabel,
  getBlendModeDescription,
  getBlendModeCategory,
  getBlendModesByCategory,
  getUsedCategories,
  isValidBlendMode,
  type BlendModeCategory,
  type BlendModeDefinition,
} from './blendModes';

export {
  NOISE_REDUCTION_ALGORITHMS,
  NOISE_REDUCTION_PRESETS,
  DEFAULT_NOISE_REDUCTION_SETTINGS,
  ALL_NOISE_REDUCTION_ALGORITHMS,
  getNoiseReductionAlgorithmLabel,
  getNoiseReductionAlgorithmDescription,
  getNoiseReductionPreset,
  getNoiseReductionPresetLevels,
  isValidNoiseReductionAlgorithm,
  algorithmRequiresModel,
  buildNoiseReductionFFmpegFilter,
  validateNoiseReductionSettings,
  type NoiseReductionAlgorithm,
  type NoiseReductionPresetLevel,
  type NoiseReductionAlgorithmDef,
  type NoiseReductionSettings,
  type NoiseReductionValidationResult,
} from './noiseReduction';

export {
  TRACKING_METHODS,
  TRACK_COLORS,
  DEFAULT_TRACKING_SETTINGS,
  DEFAULT_TRACK_POINT,
  ALL_TRACKING_METHODS,
  createTrackPoint,
  createTrackRegion,
  createMotionTrack,
  isValidTrackPoint,
  isValidTrackRegion,
  getTrackingMethodLabel,
  getTrackingMethodDescription,
  interpolateTrackData,
  calculateTrackBounds,
  applyTrackToTransform,
  isValidTrackingMethod,
  resetColorIndex,
  getColorAtIndex,
  type TrackingMethod,
  type TrackingMethodDef,
  type TrackKeyframe,
  type TrackPoint,
  type TrackRegion,
  type TrackingSettings,
  type MotionTrack,
  type Transform2D,
  type InterpolatedTrackData,
  type TrackBounds,
  type ApplyTrackOptions,
} from './motionTracking';

export {
  seededRandom,
  deterministicUUID,
  seededColor,
  seededId,
  seededChoice,
  seededShuffle,
  seededInt,
  seededFloat,
  seededBoolean,
} from './deterministic';
