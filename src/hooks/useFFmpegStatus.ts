/**
 * useFFmpegStatus Hook
 *
 * Checks FFmpeg availability on app startup and provides status information.
 */

import { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';

// =============================================================================
// Types
// =============================================================================

export interface FFmpegStatus {
  available: boolean;
  version: string | null;
  isBundled: boolean;
  ffmpegPath: string | null;
  ffprobePath: string | null;
}

export interface UseFFmpegStatusResult {
  /** FFmpeg status information */
  status: FFmpegStatus | null;
  /** Whether the check is in progress */
  isLoading: boolean;
  /** Error message if check failed */
  error: string | null;
  /** Whether FFmpeg is available */
  isAvailable: boolean;
  /** Re-check FFmpeg status */
  recheck: () => Promise<void>;
}

// =============================================================================
// Constants
// =============================================================================

const INITIAL_STATUS: FFmpegStatus = {
  available: false,
  version: null,
  isBundled: false,
  ffmpegPath: null,
  ffprobePath: null,
};

// =============================================================================
// Hook
// =============================================================================

export function useFFmpegStatus(): UseFFmpegStatusResult {
  const [status, setStatus] = useState<FFmpegStatus | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const checkFFmpeg = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const result = await invoke<FFmpegStatus>('check_ffmpeg');
      setStatus({
        available: result.available,
        version: result.version ?? null,
        isBundled: result.isBundled,
        ffmpegPath: result.ffmpegPath ?? null,
        ffprobePath: result.ffprobePath ?? null,
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      setError(errorMessage);
      setStatus(INITIAL_STATUS);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void checkFFmpeg();
  }, [checkFFmpeg]);

  return {
    status,
    isLoading,
    error,
    isAvailable: status?.available ?? false,
    recheck: checkFFmpeg,
  };
}
