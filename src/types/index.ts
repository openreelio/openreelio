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
  /** Proxy video URL for preview playback */
  proxyUrl?: string;
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
  type: 'generic' | 'chapter' | 'hook' | 'cta' | 'todo';
}

// =============================================================================
// Command Types
// =============================================================================

export type CommandType =
  | 'ImportAsset'
  | 'InsertClip'
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
