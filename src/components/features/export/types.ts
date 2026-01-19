/**
 * Export Component Types
 *
 * Type definitions for the ExportDialog component and related sub-components.
 */

// =============================================================================
// Export Preset Types
// =============================================================================

/** Export preset icon options */
export type ExportPresetIcon = 'monitor' | 'smartphone' | 'film' | 'globe';

/** Export preset configuration */
export interface ExportPreset {
  /** Unique preset identifier */
  id: string;
  /** Display name */
  name: string;
  /** Description of format/quality settings */
  description: string;
  /** Icon to display */
  icon: ExportPresetIcon;
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
