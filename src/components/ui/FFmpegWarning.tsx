/**
 * FFmpegWarning Component
 *
 * Displays a warning modal when FFmpeg is not available on the system.
 * Offers a one-click automatic installation (primary) and manual
 * installation instructions (collapsed, secondary).
 */

import { useCallback, useId, useRef, useEffect, useState, type KeyboardEvent } from 'react';
import { useFFmpegInstaller } from '@/hooks/useFFmpegInstaller';
import { ModalShell } from './ModalShell';
import { FFmpegInstallProgress } from './FFmpegInstallProgress';
import { FFmpegManualInstructions } from './FFmpegManualInstructions';

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
  /** Re-checks FFmpeg status (after install or manual installation) */
  onRecheck?: () => void | Promise<void>;
}

// =============================================================================
// Component
// =============================================================================

export function FFmpegWarning({
  isOpen,
  onDismiss,
  allowDismiss = true,
  onRecheck,
}: FFmpegWarningProps): JSX.Element | null {
  const titleId = useId();
  const installButtonRef = useRef<HTMLButtonElement>(null);
  const [installSucceeded, setInstallSucceeded] = useState(false);

  const { install, isInstalling, progress, error } = useFFmpegInstaller({
    onInstalled: () => {
      setInstallSucceeded(true);
      void onRecheck?.();
    },
  });

  // ===========================================================================
  // Handlers
  // ===========================================================================

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape' && allowDismiss) {
        onDismiss();
      }
    },
    [onDismiss, allowDismiss],
  );

  const handleBackdropClick = useCallback(() => {
    if (allowDismiss) {
      onDismiss();
    }
  }, [allowDismiss, onDismiss]);

  // ===========================================================================
  // Effects
  // ===========================================================================

  useEffect(() => {
    if (isOpen && installButtonRef.current) {
      installButtonRef.current.focus();
    }
  }, [isOpen]);

  // ===========================================================================
  // Render
  // ===========================================================================

  if (!isOpen) {
    return null;
  }

  return (
    <ModalShell
      role="alertdialog"
      ariaLabelledBy={titleId}
      onRequestClose={handleBackdropClick}
      onKeyDown={handleKeyDown}
      overlayClassName="bg-surface-overlay backdrop-blur-sm"
      overlayTestId="ffmpeg-warning-backdrop"
      testId="ffmpeg-warning"
      widthClassName="max-w-lg"
      dialogClassName="rounded-lg border border-border-default bg-surface-elevated shadow-xl"
      header={
        <div className="flex items-start gap-4 px-6 pt-6">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-status-warning/20">
            <svg
              className="h-6 w-6 text-status-warning"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              aria-hidden="true"
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
            <p className="mt-1 break-words text-sm text-text-secondary [overflow-wrap:anywhere]">
              FFmpeg is required for video processing, preview, and export.
            </p>
          </div>
        </div>
      }
      footer={
        <div className="flex flex-col-reverse gap-2 px-6 pb-6 sm:flex-row sm:justify-end sm:gap-3">
          {onRecheck && (
            <button
              type="button"
              data-testid="ffmpeg-warning-recheck"
              className="rounded bg-surface-active px-4 py-2 text-sm font-medium text-text-secondary transition-colors hover:bg-surface-highest"
              onClick={() => void onRecheck()}
            >
              Check Again
            </button>
          )}
          {allowDismiss && (
            <button
              data-testid="ffmpeg-warning-dismiss"
              type="button"
              className="rounded bg-status-warning px-4 py-2 text-sm font-medium text-white transition-colors hover:brightness-110"
              onClick={onDismiss}
            >
              Continue Anyway
            </button>
          )}
        </div>
      }
    >
      <div className="space-y-4 break-words px-6 py-4 [overflow-wrap:anywhere]">
        {installSucceeded ? (
          <div
            data-testid="ffmpeg-install-success"
            className="rounded-lg bg-status-success/10 p-4 text-sm text-status-success"
          >
            FFmpeg was installed successfully. Video processing is ready to use.
          </div>
        ) : (
          <div className="space-y-3">
            {isInstalling ? (
              <FFmpegInstallProgress progress={progress} />
            ) : (
              <button
                ref={installButtonRef}
                type="button"
                data-testid="ffmpeg-warning-install"
                className="w-full rounded bg-primary-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-primary-500"
                onClick={() => void install()}
              >
                Install FFmpeg Automatically
              </button>
            )}
            {error && (
              <p data-testid="ffmpeg-install-error" className="text-xs text-status-error">
                Installation failed: {error}
              </p>
            )}
            <FFmpegManualInstructions />
            <p className="text-xs text-text-muted">
              After installing FFmpeg manually, click &quot;Check Again&quot; to detect it — no
              restart needed.
            </p>
          </div>
        )}
      </div>
    </ModalShell>
  );
}
