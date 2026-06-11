/**
 * useCaptionExport Hook
 *
 * Provides functionality to export captions to SRT or VTT format.
 */

import { useState, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import type { Caption } from '@/types';
import { createLogger } from '@/services/logger';

const logger = createLogger('useCaptionExport');

// =============================================================================
// Types
// =============================================================================

/** Export format for captions */
export type CaptionExportFormat = 'srt' | 'vtt';

/** Caption data for export */
export interface CaptionForExport {
  startSec: number;
  endSec: number;
  text: string;
  speaker: string | null;
}

/** Hook state */
interface CaptionExportState {
  isExporting: boolean;
  error: string | null;
}

/** Hook return type */
interface UseCaptionExportReturn extends CaptionExportState {
  /** Export captions to a file (with file dialog) */
  exportToFile: (
    captions: Caption[],
    format: CaptionExportFormat,
    defaultName?: string,
  ) => Promise<boolean>;
  /** Export captions to a specific path */
  exportToPath: (
    captions: Caption[],
    path: string,
    format: CaptionExportFormat,
  ) => Promise<boolean>;
  /** Get captions as a string (without saving to file) */
  getAsString: (captions: Caption[], format: CaptionExportFormat) => Promise<string | null>;
  /** Clear any error */
  clearError: () => void;
}

// =============================================================================
// Helper Functions
// =============================================================================

function sanitizeCaptionTextForExport(text: string): string {
  return text
    .replace(/<[^>\n]*>/g, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

function isExportableCaption(caption: Caption): boolean {
  return (
    Number.isFinite(caption.startSec) &&
    Number.isFinite(caption.endSec) &&
    caption.startSec >= 0 &&
    caption.endSec > caption.startSec &&
    sanitizeCaptionTextForExport(caption.text).length > 0
  );
}

/** Converts frontend Caption to export format */
function toExportFormat(caption: Caption): CaptionForExport {
  return {
    startSec: caption.startSec,
    endSec: caption.endSec,
    text: sanitizeCaptionTextForExport(caption.text),
    speaker: caption.speaker ?? null,
  };
}

export function prepareCaptionsForExport(captions: Caption[]): CaptionForExport[] {
  return captions
    .filter(isExportableCaption)
    .slice()
    .sort((left, right) => left.startSec - right.startSec || left.endSec - right.endSec)
    .map(toExportFormat);
}

/** Gets file extension for format */
function getExtension(format: CaptionExportFormat): string {
  return format === 'srt' ? '.srt' : '.vtt';
}

/** Sanitizes filename by replacing invalid characters with underscores */
function sanitizeFilename(name: string): string {
  // Replace characters invalid on Windows/macOS/Linux filesystems
  return name.replace(/[/\\?%*:|"<>]/g, '_').trim() || 'captions';
}

// =============================================================================
// Hook Implementation
// =============================================================================

/**
 * Hook for exporting captions to SRT or VTT format
 *
 * @example
 * ```tsx
 * const { exportToFile, isExporting, error } = useCaptionExport();
 *
 * const handleExport = async () => {
 *   const success = await exportToFile(captions, 'srt', 'subtitles');
 *   if (success) {
 *     console.log('Exported successfully!');
 *   }
 * };
 * ```
 */
export function useCaptionExport(): UseCaptionExportReturn {
  const [state, setState] = useState<CaptionExportState>({
    isExporting: false,
    error: null,
  });

  /**
   * Export captions to a file using a save dialog
   */
  const exportToFile = useCallback(
    async (
      captions: Caption[],
      format: CaptionExportFormat,
      defaultName = 'captions',
    ): Promise<boolean> => {
      const exportData = prepareCaptionsForExport(captions);
      if (exportData.length === 0) {
        setState((prev) => ({ ...prev, error: 'No captions to export' }));
        return false;
      }

      setState({ isExporting: true, error: null });

      try {
        // Sanitize filename to prevent invalid characters
        const safeName = sanitizeFilename(defaultName);

        // Show save dialog
        const filePath = await save({
          defaultPath: `${safeName}${getExtension(format)}`,
          filters: [
            {
              name: format === 'srt' ? 'SubRip Subtitle' : 'WebVTT',
              extensions: [format],
            },
          ],
          title: `Export Captions as ${format.toUpperCase()}`,
        });

        if (!filePath) {
          // User cancelled
          setState({ isExporting: false, error: null });
          return false;
        }

        // Export to the selected path
        await invoke('export_captions', {
          captions: exportData,
          outputPath: filePath,
          format,
        });

        logger.info(`Exported ${exportData.length} captions to ${filePath}`);
        setState({ isExporting: false, error: null });
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('Failed to export captions', { error: message });
        setState({ isExporting: false, error: message });
        return false;
      }
    },
    [],
  );

  /**
   * Export captions to a specific path
   */
  const exportToPath = useCallback(
    async (captions: Caption[], path: string, format: CaptionExportFormat): Promise<boolean> => {
      const exportData = prepareCaptionsForExport(captions);
      if (exportData.length === 0) {
        setState((prev) => ({ ...prev, error: 'No captions to export' }));
        return false;
      }

      setState({ isExporting: true, error: null });

      try {
        await invoke('export_captions', {
          captions: exportData,
          outputPath: path,
          format,
        });

        logger.info(`Exported ${exportData.length} captions to ${path}`);
        setState({ isExporting: false, error: null });
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('Failed to export captions', { error: message });
        setState({ isExporting: false, error: message });
        return false;
      }
    },
    [],
  );

  /**
   * Get captions as a string without saving to file
   */
  const getAsString = useCallback(
    async (captions: Caption[], format: CaptionExportFormat): Promise<string | null> => {
      const exportData = prepareCaptionsForExport(captions);
      if (exportData.length === 0) {
        setState((prev) => ({ ...prev, error: 'No captions to export' }));
        return null;
      }

      setState({ isExporting: true, error: null });

      try {
        const content = await invoke<string>('get_captions_as_string', {
          captions: exportData,
          format,
        });

        setState({ isExporting: false, error: null });
        return content;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('Failed to get captions as string', { error: message });
        setState({ isExporting: false, error: message });
        return null;
      }
    },
    [],
  );

  /**
   * Clear any error
   */
  const clearError = useCallback(() => {
    setState((prev) => ({ ...prev, error: null }));
  }, []);

  return {
    ...state,
    exportToFile,
    exportToPath,
    getAsString,
    clearError,
  };
}

export default useCaptionExport;
