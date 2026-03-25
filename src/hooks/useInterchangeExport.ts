/**
 * Hook for interchange format exports (EDL, FCPXML).
 *
 * Manages file save dialog, IPC invocation, and status tracking
 * for exporting sequences to NLE interchange formats.
 */

import { useCallback, useState } from 'react';
import { save } from '@tauri-apps/plugin-dialog';
import { commands } from '@/bindings';
import type { InterchangeExportResult, InterchangeFormat } from '@/bindings';
import { createLogger } from '@/services/logger';

// =============================================================================
// Types
// =============================================================================

const logger = createLogger('useInterchangeExport');

export type InterchangeExportStatus =
  | { type: 'idle' }
  | { type: 'exporting'; message: string }
  | { type: 'completed'; result: InterchangeExportResult }
  | { type: 'failed'; error: string };

export interface UseInterchangeExportReturn {
  /** Current export status */
  status: InterchangeExportStatus;
  /** Start an EDL export with file dialog */
  exportEdl: (sequenceId: string, sequenceName: string) => Promise<void>;
  /** Start an FCPXML export with file dialog */
  exportFcpxml: (sequenceId: string, sequenceName: string) => Promise<void>;
  /** Reset status to idle */
  reset: () => void;
}

// =============================================================================
// Format Configuration
// =============================================================================

const FORMAT_CONFIG: Record<
  InterchangeFormat,
  { extension: string; filterName: string; supported: boolean; label: string }
> = {
  edl: {
    extension: 'edl',
    filterName: 'Edit Decision List',
    supported: true,
    label: 'EDL',
  },
  fcpxml: {
    extension: 'fcpxml',
    filterName: 'Final Cut Pro XML',
    supported: true,
    label: 'FCPXML',
  },
  otio: {
    extension: 'otio',
    filterName: 'OpenTimelineIO',
    supported: false,
    label: 'OTIO',
  },
};

function sanitizeFilename(name: string): string {
  return name.replace(/[/\\?%*:|"<>]/g, '_').trim() || 'sequence';
}

// =============================================================================
// Hook
// =============================================================================

export function useInterchangeExport(): UseInterchangeExportReturn {
  const [status, setStatus] = useState<InterchangeExportStatus>({ type: 'idle' });

  const doExport = useCallback(
    async (format: InterchangeFormat, sequenceId: string, sequenceName: string): Promise<void> => {
      const config = FORMAT_CONFIG[format];
      if (!config.supported) {
        setStatus({ type: 'failed', error: `${config.label} export is not yet supported.` });
        return;
      }

      try {
        const safeName = sanitizeFilename(sequenceName);
        const outputPath = await save({
          defaultPath: `${safeName}.${config.extension}`,
          filters: [{ name: config.filterName, extensions: [config.extension] }],
          title: `Export as ${config.label}`,
        });

        if (!outputPath) {
          setStatus({ type: 'idle' });
          return;
        }

        setStatus({ type: 'exporting', message: `Exporting ${config.label}...` });

        const res = format === 'edl'
          ? await commands.exportEdl(sequenceId, outputPath)
          : await commands.exportFcpxml(sequenceId, outputPath);

        if (res.status === 'error') {
          setStatus({ type: 'failed', error: String(res.error) });
          return;
        }

        const result = res.data;

        logger.info('Interchange export completed', {
          format: config.label,
          outputPath,
          sequenceId,
        });
        setStatus({ type: 'completed', result });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('Interchange export failed', {
          format: config.label,
          sequenceId,
          error: message,
        });
        setStatus({ type: 'failed', error: message });
      }
    },
    [],
  );

  const exportEdl = useCallback(
    async (sequenceId: string, sequenceName: string): Promise<void> => {
      await doExport('edl', sequenceId, sequenceName);
    },
    [doExport],
  );

  const exportFcpxml = useCallback(
    async (sequenceId: string, sequenceName: string): Promise<void> => {
      await doExport('fcpxml', sequenceId, sequenceName);
    },
    [doExport],
  );

  const reset = useCallback(() => {
    setStatus({ type: 'idle' });
  }, []);

  return { status, exportEdl, exportFcpxml, reset };
}
