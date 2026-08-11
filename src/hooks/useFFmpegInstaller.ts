/**
 * useFFmpegInstaller Hook
 *
 * Runs the in-app FFmpeg installer via the `install_ffmpeg` Tauri command and
 * streams progress from the `ffmpeg-install-progress` event.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { FFmpegStatus } from './useFFmpegStatus';

// =============================================================================
// Types
// =============================================================================

export type FFmpegInstallStage = 'downloading' | 'verifying' | 'extracting' | 'installing' | 'done';

export interface FFmpegInstallProgress {
  /** Current install stage */
  stage: FFmpegInstallStage;
  /** Binary/archive the stage applies to (e.g. "ffmpeg", "ffprobe") */
  binary: string;
  /** Bytes downloaded so far for the current archive */
  downloadedBytes: number;
  /** Total bytes for the current archive, when known */
  totalBytes: number | null;
}

export interface UseFFmpegInstallerOptions {
  /** Called after a successful install with the fresh FFmpeg status */
  onInstalled?: (status: FFmpegStatus) => void;
}

export interface UseFFmpegInstallerResult {
  /** Start the installation (no-op while one is already running) */
  install: () => Promise<void>;
  /** Whether an installation is in progress */
  isInstalling: boolean;
  /** Latest progress event, or null before the first one */
  progress: FFmpegInstallProgress | null;
  /** Error message if the install failed */
  error: string | null;
}

// =============================================================================
// Constants
// =============================================================================

const FFMPEG_INSTALL_PROGRESS_EVENT = 'ffmpeg-install-progress';

// =============================================================================
// Hook
// =============================================================================

export function useFFmpegInstaller(
  options: UseFFmpegInstallerOptions = {},
): UseFFmpegInstallerResult {
  const [isInstalling, setIsInstalling] = useState(false);
  const [progress, setProgress] = useState<FFmpegInstallProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onInstalledRef = useRef(options.onInstalled);
  onInstalledRef.current = options.onInstalled;

  const isMountedRef = useRef(true);
  const isInstallingRef = useRef(false);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const install = useCallback(async () => {
    if (isInstallingRef.current) {
      return;
    }
    isInstallingRef.current = true;
    setIsInstalling(true);
    setProgress(null);
    setError(null);

    let unlisten: UnlistenFn | null = null;
    try {
      unlisten = await listen<FFmpegInstallProgress>(FFMPEG_INSTALL_PROGRESS_EVENT, (event) => {
        if (isMountedRef.current) {
          setProgress(event.payload);
        }
      });

      const status = await invoke<FFmpegStatus>('install_ffmpeg');
      onInstalledRef.current?.(status);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isMountedRef.current) {
        setError(message);
      }
    } finally {
      unlisten?.();
      isInstallingRef.current = false;
      if (isMountedRef.current) {
        setIsInstalling(false);
      }
    }
  }, []);

  return { install, isInstalling, progress, error };
}
