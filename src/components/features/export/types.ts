/**
 * Export Component Types
 *
 * Type definitions for the ExportDialog component and related sub-components.
 */

// =============================================================================
// Export Preset Types
// =============================================================================

/** Export workflow kind */
export type ExportKind = 'video' | 'audio';

/** Export option icon options */
export type ExportOptionIcon = 'monitor' | 'smartphone' | 'film' | 'globe' | 'audio';

/** Shared selectable export option shape */
export interface SelectableExportOption {
  /** Unique option identifier */
  id: string;
  /** Display name */
  name: string;
  /** Description of format/quality settings */
  description: string;
  /** Icon to display */
  icon: ExportOptionIcon;
}

/** Export preset configuration */
export type ExportPreset = SelectableExportOption;

/** Audio export format IDs */
export type AudioExportFormat = 'wav' | 'mp3' | 'm4a' | 'flac' | 'ogg';

/** Audio export option configuration */
export interface AudioFormatOption extends SelectableExportOption {
  /** Audio format identifier */
  id: AudioExportFormat;
}

// =============================================================================
// Export Status Types
// =============================================================================

/** Idle state - ready to configure and start export */
export interface ExportStatusIdle {
  type: 'idle';
}

/** Exporting state - export in progress */
export interface ExportStatusExporting {
  type: 'exporting';
  /** Progress percentage (0-100) */
  progress: number;
  /** Status message to display */
  message: string;
}

/** Completed state - export finished successfully */
export interface ExportStatusCompleted {
  type: 'completed';
  /** Path to the exported file */
  outputPath: string;
  /** Export duration in seconds */
  duration: number;
}

/** Failed state - export encountered an error */
export interface ExportStatusFailed {
  type: 'failed';
  /** Error message */
  error: string;
}

/** Export status union type */
export type ExportStatus =
  | ExportStatusIdle
  | ExportStatusExporting
  | ExportStatusCompleted
  | ExportStatusFailed;

// =============================================================================
// Component Props Types
// =============================================================================

/** Props for the ExportDialog component */
export interface ExportDialogProps {
  /** Whether the dialog is open */
  isOpen: boolean;
  /** Callback when dialog is closed */
  onClose: () => void;
  /** Sequence ID to export */
  sequenceId: string | null;
  /** Sequence name for display */
  sequenceName?: string;
  /** Which export mode to show when the dialog opens */
  initialExportKind?: ExportKind;
}

// =============================================================================
// Tauri Event Types
// =============================================================================

/** Render progress event payload from Tauri backend */
export interface RenderProgressEvent {
  /** Job identifier */
  jobId: string;
  /** Current frame number */
  frame: number;
  /** Total frames to encode */
  totalFrames: number;
  /** Progress percentage (0-100) */
  percent: number;
  /** Current encoding speed in FPS */
  fps: number;
  /** Estimated time remaining in seconds */
  etaSeconds: number;
  /** Status message */
  message: string;
}

/** Render complete event payload from Tauri backend */
export interface RenderCompleteEvent {
  /** Job identifier */
  jobId: string;
  /** Path to the exported file */
  outputPath: string;
  /** Video duration in seconds */
  durationSec: number;
  /** Output file size in bytes */
  fileSize: number;
  /** Total encoding time in seconds */
  encodingTimeSec: number;
}

/** Render error event payload from Tauri backend */
export interface RenderErrorEvent {
  /** Job identifier */
  jobId: string;
  /** Error message */
  error: string;
}

// =============================================================================
// Batch Render Types
// =============================================================================

/** Status of an individual render item in the queue */
export type RenderQueueItemStatus = 'pending' | 'rendering' | 'completed' | 'failed' | 'cancelled';

/** A single item in the render queue (frontend state) */
export interface RenderQueueItem {
  /** Unique job ID */
  jobId: string;
  /** Export preset ID */
  presetId: string;
  /** Display name of the preset */
  presetName: string;
  /** Output file path */
  outputPath: string;
  /** Current status */
  status: RenderQueueItemStatus;
  /** Progress percentage (0-100) */
  progress: number;
  /** Optional In point in seconds for range export */
  inPoint?: number;
  /** Optional Out point in seconds for range export */
  outPoint?: number;
  /** Error message (only when status === 'failed') */
  error?: string;
}

/** Batch render progress event payload from Tauri backend */
export interface BatchRenderProgressEvent {
  /** Batch identifier */
  batchId: string;
  /** Current item's job ID */
  jobId: string;
  /** Current item index (0-based) */
  currentItem: number;
  /** Total items in batch */
  totalItems: number;
  /** Per-item progress (0-100) */
  itemPercent: number;
  /** Overall batch progress (0-100) */
  batchPercent: number;
  /** Encoding FPS */
  fps: number;
  /** Estimated time remaining */
  etaSeconds: number;
  /** Status message */
  message: string;
}

/** Batch item completion event payload from Tauri backend */
export interface BatchItemCompleteEvent {
  /** Batch identifier */
  batchId: string;
  /** Item's job ID */
  jobId: string;
  /** Item index (0-based) */
  itemIndex: number;
  /** Total items in batch */
  totalItems: number;
  /** Final status */
  status: 'completed' | 'failed' | 'cancelled';
  /** Output file path */
  outputPath: string;
  /** Duration in seconds (only when completed) */
  durationSec?: number;
  /** File size in bytes (only when completed) */
  fileSize?: number;
  /** Encoding time in seconds (only when completed) */
  encodingTimeSec?: number;
  /** Error message (only when failed) */
  error?: string;
}

/** Batch render completion event payload from Tauri backend */
export interface BatchRenderCompleteEvent {
  /** Batch identifier */
  batchId: string;
  /** Total items processed */
  totalItems: number;
  /** Results for each item */
  results: BatchItemCompleteEvent[];
}
