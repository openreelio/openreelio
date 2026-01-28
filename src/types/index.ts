/**
 * OpenReelio Frontend Type Definitions
 *
 * TypeScript types that match the Rust types in the Core Engine.
 */

// =============================================================================
// ID Types
// =============================================================================

/** Asset unique identifier (ULID) */
export type AssetId = string;

/** Clip unique identifier (ULID) */
export type ClipId = string;

/** Track unique identifier (ULID) */
export type TrackId = string;

/** Effect unique identifier (ULID) */
export type EffectId = string;

/** Caption unique identifier (ULID) */
export type CaptionId = string;

/** Operation unique identifier (ULID) */
export type OpId = string;

/** Job unique identifier (ULID) */
export type JobId = string;

/** Sequence unique identifier (ULID) */
export type SequenceId = string;

// =============================================================================
// Time Types
// =============================================================================

/** Time in seconds (floating point) */
export type TimeSec = number;

/** Time in frames (integer) */
export type Frame = number;

/** Ratio (for fps, aspect ratio, etc.) */
export interface Ratio {
  num: number;
  den: number;
}

// =============================================================================
// Spatial Types
// =============================================================================

/** 2D coordinates */
export interface Point2D {
  x: number;
  y: number;
}

/** 2D size */
export interface Size2D {
  width: number;
  height: number;
}

/** Color (RGBA) */
export interface Color {
  r: number;
  g: number;
  b: number;
  a?: number;
}

/** Time range */
export interface TimeRange {
  startSec: TimeSec;
  endSec: TimeSec;
}

// =============================================================================
// Input/Interaction Types
// =============================================================================

/** Modifier keys pressed during click events */
export interface ClickModifiers {
  ctrlKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

// =============================================================================
// Asset Types
// =============================================================================

export type AssetKind =
  | 'video'
  | 'audio'
  | 'image'
  | 'subtitle'
  | 'font'
  | 'effectPreset'
  | 'memePack';

/** Proxy video generation status */
export type ProxyStatus =
  | 'notNeeded'
  | 'pending'
  | 'generating'
  | 'ready'
  | 'failed';

/** Minimum video height that requires proxy generation */
export const PROXY_THRESHOLD_HEIGHT = 720;

export interface VideoInfo {
  width: number;
  height: number;
  fps: Ratio;
  codec: string;
  bitrate?: number;
  hasAlpha: boolean;
}

export interface AudioInfo {
  sampleRate: number;
  channels: number;
  codec: string;
  bitrate?: number;
}

/**
 * Audio waveform peak data for visualization.
 * Matches the Rust WaveformData struct from FFmpegRunner.
 */
export interface WaveformData {
  /** Number of peak samples per second of audio */
  samplesPerSecond: number;
  /** Normalized peak values (0.0 - 1.0) */
  peaks: number[];
  /** Total audio duration in seconds */
  durationSec: number;
  /** Number of audio channels (1=mono, 2=stereo) */
  channels: number;
}

export interface LicenseInfo {
  source: 'user' | 'stockProvider' | 'generated' | 'plugin';
  provider?: string;
  licenseType: 'royalty_free' | 'cc0' | 'cc_by' | 'cc_by_sa' | 'editorial' | 'custom' | 'unknown';
  proofPath?: string;
  allowedUse: string[];
  expiresAt?: string;
}

export interface Asset {
  id: AssetId;
  kind: AssetKind;
  name: string;
  uri: string;
  hash: string;
  durationSec?: number;
  fileSize: number;
  importedAt: string;
  video?: VideoInfo;
  audio?: AudioInfo;
  license: LicenseInfo;
  tags: string[];
  /** Thumbnail URL generated via Tauri asset protocol */
  thumbnailUrl?: string;
  /** Proxy video generation status */
  proxyStatus: ProxyStatus;
  /** Proxy video URL for preview playback */
  proxyUrl?: string;
}

/** Check if an asset requires proxy generation based on video dimensions */
export function assetNeedsProxy(asset: Asset): boolean {
  return asset.kind === 'video' &&
         asset.video !== undefined &&
         asset.video.height > PROXY_THRESHOLD_HEIGHT;
}

// =============================================================================
// Timeline Types
// =============================================================================

export interface SequenceFormat {
  canvas: Size2D;
  fps: Ratio;
  audioSampleRate: number;
  audioChannels: number;
}

export interface Sequence {
  id: SequenceId;
  name: string;
  format: SequenceFormat;
  tracks: Track[];
  markers: Marker[];
}

export type TrackKind = 'video' | 'audio' | 'caption' | 'overlay';

export type BlendMode = 'normal' | 'multiply' | 'screen' | 'overlay' | 'add';

export interface Track {
  id: TrackId;
  kind: TrackKind;
  name: string;
  clips: Clip[];
  blendMode: BlendMode;
  muted: boolean;
  locked: boolean;
  visible: boolean;
  /** Volume as linear multiplier (0.0 - 2.0, where 1.0 = 100%) */
  volume: number;
}

export interface ClipRange {
  /** Source media start time in seconds */
  sourceInSec: TimeSec;
  /** Source media end time in seconds */
  sourceOutSec: TimeSec;
}

export interface ClipPlace {
  /** Timeline position in seconds */
  timelineInSec: TimeSec;
  /** Duration on timeline in seconds (may differ from source due to speed) */
  durationSec: TimeSec;
}

export interface Transform {
  position: Point2D;
  scale: Point2D;
  rotationDeg: number;
  anchor: Point2D;
}

export interface AudioSettings {
  volumeDb: number;
  pan: number;
  muted: boolean;
}

export interface Clip {
  id: ClipId;
  assetId: AssetId;
  range: ClipRange;
  place: ClipPlace;
  transform: Transform;
  opacity: number;
  speed: number;
  effects: EffectId[];
  audio: AudioSettings;
  label?: string;
  color?: Color;
}

export interface Marker {
  id: string;
  timeSec: TimeSec;
  label: string;
  color: Color;
  markerType: 'generic' | 'chapter' | 'hook' | 'cta' | 'todo';
}

// =============================================================================
// Caption Types
// =============================================================================

/** Vertical position of caption on screen */
export type VerticalPosition = 'bottom' | 'top' | 'center';

/** Horizontal text alignment */
export type TextAlignment = 'left' | 'center' | 'right';

/** Font weight */
export type FontWeight = 'normal' | 'bold' | 'light';

/** Custom position with x/y coordinates (percentage) */
export interface CustomPosition {
  xPercent: number;
  yPercent: number;
}

/** Caption position on screen */
export type CaptionPosition =
  | { type: 'preset'; vertical: VerticalPosition; marginPercent: number }
  | { type: 'custom'; xPercent: number; yPercent: number };

/** RGBA color for captions (0-255) */
export interface CaptionColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** Caption text style */
export interface CaptionStyle {
  fontFamily: string;
  fontSize: number;
  fontWeight: FontWeight;
  color: CaptionColor;
  backgroundColor?: CaptionColor;
  outlineColor?: CaptionColor;
  outlineWidth: number;
  shadowColor?: CaptionColor;
  shadowOffset: number;
  alignment: TextAlignment;
  italic: boolean;
  underline: boolean;
}

/** A single caption entry with text and timing */
export interface Caption {
  id: CaptionId;
  startSec: number;
  endSec: number;
  text: string;
  styleOverride?: CaptionStyle;
  positionOverride?: CaptionPosition;
  speaker?: string;
  metadata?: Record<string, string>;
}

/** A caption track containing multiple captions */
export interface CaptionTrack {
  id: string;
  name: string;
  language: string;
  visible: boolean;
  locked: boolean;
  captions: Caption[];
  defaultStyle: CaptionStyle;
  defaultPosition: CaptionPosition;
}

/** Default caption style */
export const DEFAULT_CAPTION_STYLE: CaptionStyle = {
  fontFamily: 'Arial',
  fontSize: 48,
  fontWeight: 'normal',
  color: { r: 255, g: 255, b: 255, a: 255 },
  outlineColor: { r: 0, g: 0, b: 0, a: 255 },
  outlineWidth: 2,
  shadowColor: { r: 0, g: 0, b: 0, a: 128 },
  shadowOffset: 2,
  alignment: 'center',
  italic: false,
  underline: false,
};

/** Default caption position */
export const DEFAULT_CAPTION_POSITION: CaptionPosition = {
  type: 'preset',
  vertical: 'bottom',
  marginPercent: 5,
};

// =============================================================================
// Command Types
// =============================================================================

export type CommandType =
  | 'ImportAsset'
  | 'InsertClip'
  | 'SetClipTransform'
  | 'SplitClip'
  | 'TrimClip'
  | 'MoveClip'
  | 'DeleteClip'
  | 'ApplyEffect'
  | 'RemoveEffect'
  | 'UpdateCaption'
  | 'CreateCaption'
  | 'DeleteCaption'
  | 'SetSequenceFormat'
  | 'CreateTrack'
  | 'DeleteTrack'
  | 'ToggleTrackMute'
  | 'ToggleTrackLock'
  | 'ToggleTrackVisibility';

export interface Command {
  type: CommandType;
  payload: Record<string, unknown>;
}

export interface CommandResult {
  opId: OpId;
  changes: StateChange[];
  createdIds: string[];
  deletedIds: string[];
}

export interface UndoRedoResult {
  success: boolean;
  canUndo: boolean;
  canRedo: boolean;
}

export interface StateChange {
  type: string;
  [key: string]: unknown;
}

// =============================================================================
// Job Types
// =============================================================================

/** Job type identifier (snake_case to match Rust IPC) */
export type JobType =
  | 'proxy_generation'
  | 'thumbnail_generation'
  | 'waveform_generation'
  | 'indexing'
  | 'transcription'
  | 'preview_render'
  | 'final_render'
  | 'ai_completion';

/** Job priority level */
export type JobPriority = 'background' | 'normal' | 'preview' | 'user_request';

/** Job status from backend IPC */
export type JobStatusDto =
  | { type: 'queued' }
  | { type: 'running'; progress: number; message?: string }
  | { type: 'completed'; result: unknown }
  | { type: 'failed'; error: string }
  | { type: 'cancelled' };

/** Job info from backend IPC */
export interface JobInfo {
  id: JobId;
  jobType: JobType;
  priority: JobPriority;
  status: JobStatusDto;
  createdAt: string;
  completedAt?: string;
}

/** Job queue statistics */
export interface JobStats {
  queueLength: number;
  activeCount: number;
  runningCount: number;
  numWorkers: number;
}

/** Legacy Job type for backward compatibility */
export interface Job {
  id: JobId;
  type: JobType;
  status: JobStatusDto;
}

// =============================================================================
// AI Types
// =============================================================================

export interface EditScript {
  intent: string;
  commands: Command[];
  requires?: Requirement[];
  qcRules?: string[];
  risk?: RiskAssessment;
  explanation?: string;
}

export interface Requirement {
  kind: 'assetSearch' | 'assetGenerate' | 'assetDownload' | 'transcribe' | 'translate';
  query?: string;
  provider?: string;
  params?: Record<string, unknown>;
}

export interface RiskAssessment {
  copyright: 'none' | 'low' | 'medium' | 'high';
  nsfw: 'none' | 'low' | 'medium' | 'high';
}

export interface Proposal {
  id: string;
  editScript: EditScript;
  status: ProposalStatus;
  createdAt: string;
  previewJobId?: JobId;
  appliedOpIds?: OpId[];
}

export type ProposalStatus =
  | { type: 'pending' }
  | { type: 'previewReady'; previewPath: string }
  | { type: 'applied'; opIds: OpId[] }
  | { type: 'rejected'; reason?: string }
  | { type: 'revised'; newProposalId: string };

// =============================================================================
// FFmpeg Types
// =============================================================================

/** FFmpeg availability status */
export interface FFmpegStatus {
  available: boolean;
  version?: string;
  isBundled: boolean;
  ffmpegPath?: string;
  ffprobePath?: string;
}

/** Media file information from FFprobe */
export interface MediaInfo {
  durationSec: number;
  format: string;
  sizeBytes: number;
  video?: VideoStreamInfo;
  audio?: AudioStreamInfo;
}

/** Video stream information */
export interface VideoStreamInfo {
  width: number;
  height: number;
  fps: number;
  codec: string;
  pixelFormat: string;
  bitrate?: number;
}

/** Audio stream information */
export interface AudioStreamInfo {
  sampleRate: number;
  channels: number;
  codec: string;
  bitrate?: number;
}

// =============================================================================
// Export Types
// =============================================================================

/** Export preset options */
export type ExportPreset =
  | 'youtube_1080p'
  | 'youtube_4k'
  | 'youtube_shorts'
  | 'twitter'
  | 'instagram'
  | 'webm_vp9'
  | 'prores';

/** Export progress event data */
export interface ExportProgress {
  jobId: JobId;
  frame: number;
  totalFrames: number;
  percent: number;
  fps: number;
  etaSeconds: number;
  message?: string;
}

/** Export completion event data */
export interface ExportComplete {
  jobId: JobId;
  outputPath: string;
  durationSec: number;
  fileSize: number;
  encodingTimeSec: number;
}

/** Export error event data */
export interface ExportError {
  jobId: JobId;
  error: string;
}

// =============================================================================
// Effect Types
// =============================================================================

/** Categories of effects */
export type EffectCategory =
  | 'color'
  | 'transform'
  | 'blur_sharpen'
  | 'stylize'
  | 'transition'
  | 'audio'
  | 'text'
  | 'ai'
  | 'custom';

/** Predefined effect types - matches backend EffectType enum */
export type EffectType =
  // Color effects
  | 'brightness'
  | 'contrast'
  | 'saturation'
  | 'hue'
  | 'color_balance'
  | 'gamma'
  | 'levels'
  | 'curves'
  | 'lut'
  // Transform effects
  | 'crop'
  | 'flip'
  | 'mirror'
  | 'rotate'
  // Blur/Sharpen
  | 'gaussian_blur'
  | 'box_blur'
  | 'motion_blur'
  | 'radial_blur'
  | 'sharpen'
  | 'unsharp_mask'
  // Stylize
  | 'vignette'
  | 'glow'
  | 'film_grain'
  | 'chromatic_aberration'
  | 'noise'
  | 'pixelate'
  | 'posterize'
  // Transitions
  | 'cross_dissolve'
  | 'fade'
  | 'wipe'
  | 'slide'
  | 'zoom'
  // Audio
  | 'volume'
  | 'gain'
  | 'eq_band'
  | 'compressor'
  | 'limiter'
  | 'noise_reduction'
  | 'reverb'
  | 'delay'
  // Text
  | 'text_overlay'
  | 'subtitle'
  // AI
  | 'background_removal'
  | 'auto_reframe'
  | 'face_blur'
  | 'object_tracking'
  // Custom
  | { custom: string };

/** Effect parameter value types */
export type ParamValue =
  | { type: 'float'; value: number }
  | { type: 'int'; value: number }
  | { type: 'bool'; value: boolean }
  | { type: 'string'; value: string }
  | { type: 'color'; value: [number, number, number, number] } // RGBA
  | { type: 'point'; value: [number, number] } // x, y
  | { type: 'range'; value: [number, number] }; // min, max

/** Simplified param value for UI (auto-detected type) */
export type SimpleParamValue = number | boolean | string | [number, number, number, number] | [number, number];

/** Parameter definition with constraints */
export interface ParamDef {
  /** Parameter name (key) */
  name: string;
  /** Display label */
  label: string;
  /** Default value */
  default: ParamValue;
  /** Minimum value (for numeric types) */
  min?: number;
  /** Maximum value (for numeric types) */
  max?: number;
  /** Step size for UI */
  step?: number;
}

/** Easing function for keyframe interpolation */
export type Easing =
  | 'linear'
  | 'ease_in'
  | 'ease_out'
  | 'ease_in_out'
  | 'cubic_bezier'
  | 'step'
  | 'hold';

/** A keyframe for parameter animation */
export interface Keyframe {
  /** Time offset from effect start (seconds) */
  timeOffset: number;
  /** Parameter value at this keyframe */
  value: ParamValue;
  /** Easing to next keyframe */
  easing: Easing;
}

/** An effect instance applied to a clip */
export interface Effect {
  /** Unique identifier */
  id: EffectId;
  /** Effect type */
  effectType: EffectType;
  /** Whether the effect is enabled */
  enabled: boolean;
  /** Effect parameters (static values) */
  params: Record<string, SimpleParamValue>;
  /** Keyframed parameters */
  keyframes: Record<string, Keyframe[]>;
  /** Effect order/priority (lower = first) */
  order: number;
}

/** Effect library entry for browsing available effects */
export interface EffectDefinition {
  /** Effect type identifier */
  type: EffectType;
  /** Display name */
  name: string;
  /** Effect category */
  category: EffectCategory;
  /** Description */
  description: string;
  /** Parameter definitions */
  paramDefs: ParamDef[];
  /** Whether this is an audio effect */
  isAudio: boolean;
  /** Preview thumbnail URL (optional) */
  thumbnail?: string;
}

/** Get category for an effect type */
export function getEffectCategory(effectType: EffectType): EffectCategory {
  if (typeof effectType === 'object' && 'custom' in effectType) {
    return 'custom';
  }

  switch (effectType) {
    case 'brightness':
    case 'contrast':
    case 'saturation':
    case 'hue':
    case 'color_balance':
    case 'gamma':
    case 'levels':
    case 'curves':
    case 'lut':
      return 'color';

    case 'crop':
    case 'flip':
    case 'mirror':
    case 'rotate':
      return 'transform';

    case 'gaussian_blur':
    case 'box_blur':
    case 'motion_blur':
    case 'radial_blur':
    case 'sharpen':
    case 'unsharp_mask':
      return 'blur_sharpen';

    case 'vignette':
    case 'glow':
    case 'film_grain':
    case 'chromatic_aberration':
    case 'noise':
    case 'pixelate':
    case 'posterize':
      return 'stylize';

    case 'cross_dissolve':
    case 'fade':
    case 'wipe':
    case 'slide':
    case 'zoom':
      return 'transition';

    case 'volume':
    case 'gain':
    case 'eq_band':
    case 'compressor':
    case 'limiter':
    case 'noise_reduction':
    case 'reverb':
    case 'delay':
      return 'audio';

    case 'text_overlay':
    case 'subtitle':
      return 'text';

    case 'background_removal':
    case 'auto_reframe':
    case 'face_blur':
    case 'object_tracking':
      return 'ai';

    default:
      return 'custom';
  }
}

/** Check if effect type is an audio effect */
export function isAudioEffect(effectType: EffectType): boolean {
  return getEffectCategory(effectType) === 'audio';
}

/** Human-readable category names */
export const EFFECT_CATEGORY_LABELS: Record<EffectCategory, string> = {
  color: 'Color',
  transform: 'Transform',
  blur_sharpen: 'Blur & Sharpen',
  stylize: 'Stylize',
  transition: 'Transition',
  audio: 'Audio',
  text: 'Text',
  ai: 'AI',
  custom: 'Custom',
};

/** Human-readable effect type names */
export const EFFECT_TYPE_LABELS: Partial<Record<string, string>> = {
  brightness: 'Brightness',
  contrast: 'Contrast',
  saturation: 'Saturation',
  hue: 'Hue',
  color_balance: 'Color Balance',
  gamma: 'Gamma',
  levels: 'Levels',
  curves: 'Curves',
  lut: 'LUT',
  crop: 'Crop',
  flip: 'Flip',
  mirror: 'Mirror',
  rotate: 'Rotate',
  gaussian_blur: 'Gaussian Blur',
  box_blur: 'Box Blur',
  motion_blur: 'Motion Blur',
  radial_blur: 'Radial Blur',
  sharpen: 'Sharpen',
  unsharp_mask: 'Unsharp Mask',
  vignette: 'Vignette',
  glow: 'Glow',
  film_grain: 'Film Grain',
  chromatic_aberration: 'Chromatic Aberration',
  noise: 'Noise',
  pixelate: 'Pixelate',
  posterize: 'Posterize',
  cross_dissolve: 'Cross Dissolve',
  fade: 'Fade',
  wipe: 'Wipe',
  slide: 'Slide',
  zoom: 'Zoom',
  volume: 'Volume',
  gain: 'Gain',
  eq_band: 'EQ Band',
  compressor: 'Compressor',
  limiter: 'Limiter',
  noise_reduction: 'Noise Reduction',
  reverb: 'Reverb',
  delay: 'Delay',
  text_overlay: 'Text Overlay',
  subtitle: 'Subtitle',
  background_removal: 'Background Removal',
  auto_reframe: 'Auto Reframe',
  face_blur: 'Face Blur',
  object_tracking: 'Object Tracking',
};

// =============================================================================
// Timeline UI Types
// =============================================================================

/**
 * Snap point type for timeline snapping operations.
 */
export type SnapPointType = 'clip-start' | 'clip-end' | 'playhead' | 'marker' | 'grid';

/**
 * Represents a snap point on the timeline for aligning clips and playhead.
 * Used for snapping during drag operations and playhead scrubbing.
 */
export interface SnapPoint {
  /** Time position in seconds */
  time: number;
  /** Type of snap point */
  type: SnapPointType;
  /** Associated clip ID (for clip snap points) */
  clipId?: string;
  /** Associated marker ID (for marker snap points) */
  markerId?: string;
}
