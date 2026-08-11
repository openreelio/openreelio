/**
 * FFmpegInstallProgress Component
 *
 * Progress bar for the in-app FFmpeg installer: shows a percentage bar when
 * the total download size is known, otherwise an indeterminate bar, plus the
 * current stage and binary being processed.
 */

import type { FFmpegInstallProgress as InstallProgress } from '@/hooks/useFFmpegInstaller';

// =============================================================================
// Types
// =============================================================================

export interface FFmpegInstallProgressProps {
  /** Latest progress event (null before the first event arrives) */
  progress: InstallProgress | null;
}

// =============================================================================
// Helpers
// =============================================================================

const STAGE_LABELS: Record<string, string> = {
  downloading: 'Downloading',
  verifying: 'Verifying checksum',
  extracting: 'Extracting',
  installing: 'Installing',
  done: 'Finishing up',
};

function formatBytes(bytes: number): string {
  const megabytes = bytes / (1024 * 1024);
  return `${megabytes.toFixed(1)} MB`;
}

// =============================================================================
// Component
// =============================================================================

export function FFmpegInstallProgress({ progress }: FFmpegInstallProgressProps): JSX.Element {
  const stageLabel = progress ? (STAGE_LABELS[progress.stage] ?? progress.stage) : 'Starting…';
  const percent =
    progress && progress.totalBytes && progress.totalBytes > 0
      ? Math.min(100, (progress.downloadedBytes / progress.totalBytes) * 100)
      : null;

  const detail =
    progress && progress.stage === 'downloading'
      ? percent !== null
        ? `${formatBytes(progress.downloadedBytes)} / ${formatBytes(progress.totalBytes ?? 0)}`
        : formatBytes(progress.downloadedBytes)
      : null;

  return (
    <div data-testid="ffmpeg-install-progress" className="space-y-2">
      <div className="flex items-center justify-between text-xs text-text-secondary">
        <span>
          {stageLabel}
          {progress ? ` ${progress.binary}` : ''}
        </span>
        {detail && <span>{detail}</span>}
      </div>
      <div
        role="progressbar"
        aria-label="FFmpeg installation progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent !== null ? Math.round(percent) : undefined}
        className="h-2 w-full overflow-hidden rounded-full bg-surface-active"
      >
        {percent !== null ? (
          <div
            className="h-full rounded-full bg-primary-500 transition-[width] duration-200"
            style={{ width: `${percent}%` }}
          />
        ) : (
          <div className="h-full w-1/3 animate-pulse rounded-full bg-primary-500" />
        )}
      </div>
    </div>
  );
}
