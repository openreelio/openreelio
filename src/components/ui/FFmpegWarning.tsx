/**
 * FFmpegWarning Component
 *
 * Displays a warning modal when FFmpeg is not available on the system.
 * Provides installation instructions and links.
 */

import { useCallback, useId, useRef, useEffect, type KeyboardEvent } from 'react';

// =============================================================================
// Types
// =============================================================================

export interface FFmpegWarningProps {
  /** Whether the dialog is open */
  isOpen: boolean;
  /** Callback when dismissed */
  onDismiss: () => void;
  /** Whether to allow dismissing (user may want to force install) */
  allowDismiss?: boolean;
}

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

export function FFmpegWarning({
  isOpen,
  onDismiss,
  allowDismiss = true,
}: FFmpegWarningProps): JSX.Element | null {
  const titleId = useId();
  const dismissButtonRef = useRef<HTMLButtonElement>(null);

  // ===========================================================================
  // Handlers
  // ===========================================================================

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape' && allowDismiss) {
        onDismiss();
      }
    },
    [onDismiss, allowDismiss]
  );

  const handleBackdropClick = useCallback(() => {
    if (allowDismiss) {
      onDismiss();
    }
  }, [allowDismiss, onDismiss]);

  const handleDialogClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
  }, []);

  const handleOpenLink = useCallback((url: string) => {
    window.open(url, '_blank', 'noopener,noreferrer');
  }, []);

  // ===========================================================================
  // Effects
  // ===========================================================================

  useEffect(() => {
    if (isOpen && dismissButtonRef.current) {
      dismissButtonRef.current.focus();
    }
  }, [isOpen]);

  // ===========================================================================
  // Render
  // ===========================================================================

  if (!isOpen) {
    return null;
  }

  return (
    <div
      data-testid="ffmpeg-warning"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className="fixed inset-0 z-50 flex items-center justify-center"
      onKeyDown={handleKeyDown}
    >
      {/* Backdrop */}
      <div
        data-testid="ffmpeg-warning-backdrop"
        className="absolute inset-0 bg-surface-overlay backdrop-blur-sm"
        onClick={handleBackdropClick}
      />

      {/* Dialog Content */}
      <div
        className="relative z-10 w-[calc(100%-2rem)] max-w-lg mx-4 bg-surface-elevated rounded-lg shadow-xl p-6 border border-border-default"
        onClick={handleDialogClick}
      >
        {/* Warning Icon & Title */}
        <div className="flex items-start gap-4 mb-4">
          <div className="flex-shrink-0 w-12 h-12 bg-status-warning/20 rounded-full flex items-center justify-center">
            <svg
              className="w-6 h-6 text-status-warning"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
              />
            </svg>
          </div>
          <div className="min-w-0">
            <h2 id={titleId} className="text-lg font-semibold text-text-primary">
              FFmpeg Not Found
            </h2>
            <p className="text-text-secondary text-sm mt-1">
              FFmpeg is required for video processing, preview, and export.
            </p>
          </div>
        </div>

        {/* Installation Instructions */}
        <div className="bg-surface-base rounded-lg p-4 mb-4">
          <h3 className="text-sm font-medium text-text-secondary mb-3">
            Installation Instructions
          </h3>

          {/* Windows */}
          <div className="mb-3">
            <div className="flex items-center gap-2 text-sm text-text-secondary mb-1">
              <span className="font-medium text-text-primary">Windows:</span>
            </div>
            <ol className="text-xs text-text-secondary list-decimal list-inside space-y-1 ml-2">
              <li>
                Download from{' '}
                <button
                  type="button"
                  className="text-primary-400 hover:text-primary-300 underline"
                  onClick={() => handleOpenLink(FFMPEG_WINDOWS_URL)}
                >
                  gyan.dev/ffmpeg/builds
                </button>
              </li>
              <li>Extract to a folder (e.g., C:\ffmpeg)</li>
              <li>Add the bin folder to your system PATH</li>
            </ol>
          </div>

          {/* macOS */}
          <div className="mb-3">
            <div className="flex items-center gap-2 text-sm text-text-secondary mb-1">
              <span className="font-medium text-text-primary">macOS:</span>
            </div>
            <code className="block text-xs bg-surface-active text-status-success px-2 py-1 rounded ml-2 font-mono">
              {FFMPEG_MAC_HOMEBREW}
            </code>
          </div>

          {/* Linux */}
          <div>
            <div className="flex items-center gap-2 text-sm text-text-secondary mb-1">
              <span className="font-medium text-text-primary">Linux (Debian/Ubuntu):</span>
            </div>
            <code className="block text-xs bg-surface-active text-status-success px-2 py-1 rounded ml-2 font-mono">
              {FFMPEG_LINUX_APT}
            </code>
          </div>
        </div>

        {/* Note */}
        <p className="text-xs text-text-muted mb-4">
          After installing FFmpeg, restart OpenReelio for changes to take effect.
        </p>

        {/* Actions */}
        <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 sm:gap-3">
          <button
            type="button"
            className="px-4 py-2 text-sm font-medium text-text-secondary bg-surface-active rounded hover:bg-surface-highest transition-colors"
            onClick={() => handleOpenLink(FFMPEG_DOWNLOAD_URL)}
          >
            Official Download
          </button>
          {allowDismiss && (
            <button
              ref={dismissButtonRef}
              data-testid="ffmpeg-warning-dismiss"
              type="button"
              className="px-4 py-2 text-sm font-medium text-white bg-status-warning rounded hover:brightness-110 transition-colors"
              onClick={onDismiss}
            >
              Continue Anyway
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
