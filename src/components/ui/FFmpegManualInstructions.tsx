/**
 * FFmpegManualInstructions Component
 *
 * Collapsible manual installation instructions for FFmpeg, shown as a
 * secondary path below the automatic installer.
 */

import { useCallback } from 'react';

// =============================================================================
// Constants
// =============================================================================

const FFMPEG_DOWNLOAD_URL = 'https://ffmpeg.org/download.html';
const FFMPEG_WINDOWS_URL = 'https://www.gyan.dev/ffmpeg/builds/';
const FFMPEG_MAC_HOMEBREW = 'brew install ffmpeg';
const FFMPEG_LINUX_APT = 'sudo apt install ffmpeg';

// =============================================================================
// Component
// =============================================================================

export function FFmpegManualInstructions(): JSX.Element {
  const handleOpenLink = useCallback((url: string) => {
    window.open(url, '_blank', 'noopener,noreferrer');
  }, []);

  return (
    <details data-testid="ffmpeg-manual-instructions" className="rounded-lg bg-surface-base">
      <summary className="cursor-pointer select-none px-4 py-3 text-sm font-medium text-text-secondary hover:text-text-primary">
        Manual installation
      </summary>
      <div className="px-4 pb-4">
        <div className="mb-3 min-w-0">
          <div className="mb-1 flex items-center gap-2 text-sm text-text-secondary">
            <span className="font-medium text-text-primary">Windows:</span>
          </div>
          <ol className="ml-2 list-inside list-decimal space-y-1 text-xs text-text-secondary">
            <li>
              Download from{' '}
              <button
                type="button"
                className="break-all text-primary-400 underline hover:text-primary-300"
                onClick={() => handleOpenLink(FFMPEG_WINDOWS_URL)}
              >
                gyan.dev/ffmpeg/builds
              </button>
            </li>
            <li>Extract to a folder (e.g., C:\ffmpeg)</li>
            <li>Add the bin folder to your system PATH</li>
          </ol>
        </div>

        <div className="mb-3">
          <div className="mb-1 flex items-center gap-2 text-sm text-text-secondary">
            <span className="font-medium text-text-primary">macOS:</span>
          </div>
          <code className="ml-2 block whitespace-pre-wrap break-all rounded bg-surface-active px-2 py-1 font-mono text-xs text-status-success">
            {FFMPEG_MAC_HOMEBREW}
          </code>
        </div>

        <div>
          <div className="mb-1 flex items-center gap-2 text-sm text-text-secondary">
            <span className="font-medium text-text-primary">Linux (Debian/Ubuntu):</span>
          </div>
          <code className="ml-2 block whitespace-pre-wrap break-all rounded bg-surface-active px-2 py-1 font-mono text-xs text-status-success">
            {FFMPEG_LINUX_APT}
          </code>
        </div>

        <div className="mt-3">
          <button
            type="button"
            className="text-xs text-primary-400 underline hover:text-primary-300"
            onClick={() => handleOpenLink(FFMPEG_DOWNLOAD_URL)}
          >
            Official Download
          </button>
        </div>
      </div>
    </details>
  );
}
