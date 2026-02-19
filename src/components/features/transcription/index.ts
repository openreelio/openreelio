/**
 * Transcription Feature Module
 *
 * Components for transcription triggers and dialogs.
 */

// =============================================================================
// Shared Types
// =============================================================================

/** Asset data shape used by transcription UI components. */
export type AssetKind = 'video' | 'audio' | 'image';

export interface Resolution {
  width: number;
  height: number;
}

export interface AssetData {
  id: string;
  name: string;
  kind: AssetKind;
  duration?: number;
  thumbnail?: string;
  resolution?: Resolution;
  fileSize?: number;
  importedAt?: string;
}

// =============================================================================
// Component Exports
// =============================================================================

export { AssetContextMenu } from './AssetContextMenu';
export type { AssetContextMenuProps } from './AssetContextMenu';

export { TranscriptionDialog } from './TranscriptionDialog';
export type { TranscriptionDialogProps, TranscriptionOptions } from './TranscriptionDialog';
