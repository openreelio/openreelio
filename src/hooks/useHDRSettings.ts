/**
 * useHDRSettings Hook
 *
 * Hook for managing HDR (High Dynamic Range) export settings.
 * Handles color space, transfer function, and luminance configuration.
 *
 * @module hooks/useHDRSettings
 */

import { useState, useCallback, useEffect, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  type HdrMode,
  type HdrExportSettings,
  DEFAULT_HDR_EXPORT,
  HDR10_EXPORT_PRESET,
  validateHdrExportSettings,
} from '@/types/hdr';
import type { SequenceId } from '@/types';
import { createLogger } from '@/services/logger';

const logger = createLogger('useHDRSettings');

// =============================================================================
// Constants
// =============================================================================

/** Maximum Content Light Level (nits) */
const MAX_CLL_MIN = 1;
const MAX_CLL_MAX = 10000;

/** Maximum Frame-Average Light Level (nits) */
const MAX_FALL_MIN = 1;
const MAX_FALL_MAX = 10000;

// =============================================================================
// Types
// =============================================================================

export type HdrPreset = 'sdr' | 'hdr10' | 'hlg';

export interface UseHDRSettingsOptions {
  /** The sequence to configure */
  sequenceId: SequenceId;
  /** Whether to fetch existing settings on mount */
  fetchOnMount?: boolean;
  /** Initial settings (overrides fetch) */
  initialSettings?: HdrExportSettings;
}

export interface UseHDRSettingsResult {
  /** Current HDR settings */
  settings: HdrExportSettings;
  /** Whether this is HDR content */
  isHdr: boolean;
  /** Set the HDR mode (sdr, hdr10, hlg) */
  setHdrMode: (mode: HdrMode) => void;
  /** Set max content light level */
  setMaxCll: (value: number) => void;
  /** Set max frame-average light level */
  setMaxFall: (value: number) => void;
  /** Set bit depth */
  setBitDepth: (depth: 8 | 10 | 12) => void;
  /** Apply a preset configuration */
  applyPreset: (preset: HdrPreset) => void;
  /** Validate codec compatibility */
  validateCodec: (codec: string) => string | null;
  /** Save settings to backend */
  save: () => Promise<boolean>;
  /** Reset to defaults */
  reset: () => void;
  /** Validation warning (if any) */
  validationWarning: string | null;
  /** Whether settings have been modified */
  isDirty: boolean;
  /** Whether loading settings */
  isLoading: boolean;
  /** Whether saving settings */
  isSaving: boolean;
  /** Current error message */
  error: string | null;
  /** Clear error state */
  clearError: () => void;
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Clamps a value within a range.
 */
function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, value));
}

/**
 * Compares two settings objects for equality.
 */
function areSettingsEqual(a: HdrExportSettings, b: HdrExportSettings): boolean {
  return (
    a.hdrMode === b.hdrMode &&
    a.bitDepth === b.bitDepth &&
    a.maxCll === b.maxCll &&
    a.maxFall === b.maxFall
  );
}

/**
 * Gets validation warning for current settings.
 */
function getValidationWarning(settings: HdrExportSettings): string | null {
  if (settings.hdrMode !== 'sdr' && settings.bitDepth < 10) {
    return 'HDR content typically requires 10-bit or higher color depth.';
  }
  return null;
}

// =============================================================================
// Hook Implementation
// =============================================================================

export function useHDRSettings({
  sequenceId,
  fetchOnMount = false,
  initialSettings,
}: UseHDRSettingsOptions): UseHDRSettingsResult {
  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  const [settings, setSettings] = useState<HdrExportSettings>(
    initialSettings ?? DEFAULT_HDR_EXPORT
  );
  const [originalSettings, setOriginalSettings] = useState<HdrExportSettings>(
    initialSettings ?? DEFAULT_HDR_EXPORT
  );
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ---------------------------------------------------------------------------
  // Computed State
  // ---------------------------------------------------------------------------

  const isHdr = settings.hdrMode !== 'sdr';
  const isDirty = !areSettingsEqual(settings, originalSettings);
  const validationWarning = useMemo(() => getValidationWarning(settings), [settings]);

  // ---------------------------------------------------------------------------
  // Fetch Existing Settings
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (!initialSettings) return;
    setSettings(initialSettings);
    setOriginalSettings(initialSettings);
  }, [initialSettings]);

  useEffect(() => {
    if (!fetchOnMount || initialSettings) {
      return;
    }

    let cancelled = false;

    const fetchSettings = async () => {
      setIsLoading(true);
      setError(null);

      try {
        logger.debug('Fetching HDR settings', { sequenceId });

        const fetchedSettings = await invoke<HdrExportSettings>(
          'get_sequence_hdr_settings',
          { sequenceId }
        );

        if (cancelled) return;

        setSettings(fetchedSettings);
        setOriginalSettings(fetchedSettings);

        logger.info('HDR settings loaded', { sequenceId });
      } catch (err) {
        if (cancelled) return;
        const errorMsg = err instanceof Error ? err.message : String(err);
        logger.error('Failed to fetch HDR settings', { error: err, sequenceId });
        setError(errorMsg);
        // Keep default settings on error
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    };

    fetchSettings();

    return () => {
      cancelled = true;
    };
  }, [sequenceId, fetchOnMount, initialSettings]);

  // ---------------------------------------------------------------------------
  // Set HDR Mode
  // ---------------------------------------------------------------------------

  const setHdrMode = useCallback((mode: HdrMode) => {
    setSettings((prev) => {
      if (mode === 'sdr') {
        // Revert to SDR defaults
        return {
          hdrMode: 'sdr',
          bitDepth: 8,
          maxCll: undefined,
          maxFall: undefined,
        };
      }

      // Switching to HDR mode
      return {
        ...prev,
        hdrMode: mode,
        bitDepth: prev.bitDepth < 10 ? 10 : prev.bitDepth, // Auto-upgrade to 10-bit
        maxCll: prev.maxCll ?? 1000,
        maxFall: prev.maxFall ?? 400,
      };
    });
  }, []);

  // ---------------------------------------------------------------------------
  // Set Luminance Values
  // ---------------------------------------------------------------------------

  const setMaxCll = useCallback((value: number) => {
    const clampedValue = clamp(value, MAX_CLL_MIN, MAX_CLL_MAX);
    setSettings((prev) => ({
      ...prev,
      maxCll: clampedValue,
    }));
  }, []);

  const setMaxFall = useCallback((value: number) => {
    const clampedValue = clamp(value, MAX_FALL_MIN, MAX_FALL_MAX);
    setSettings((prev) => ({
      ...prev,
      maxFall: clampedValue,
    }));
  }, []);

  // ---------------------------------------------------------------------------
  // Set Bit Depth
  // ---------------------------------------------------------------------------

  const setBitDepth = useCallback((depth: 8 | 10 | 12) => {
    setSettings((prev) => ({
      ...prev,
      bitDepth: depth,
    }));
  }, []);

  // ---------------------------------------------------------------------------
  // Apply Preset
  // ---------------------------------------------------------------------------

  const applyPreset = useCallback((preset: HdrPreset) => {
    switch (preset) {
      case 'hdr10':
        setSettings(HDR10_EXPORT_PRESET);
        break;
      case 'hlg':
        setSettings({
          hdrMode: 'hlg',
          bitDepth: 10,
          maxCll: 1000,
          maxFall: 400,
        });
        break;
      case 'sdr':
      default:
        setSettings(DEFAULT_HDR_EXPORT);
        break;
    }
  }, []);

  // ---------------------------------------------------------------------------
  // Validate Codec
  // ---------------------------------------------------------------------------

  const validateCodec = useCallback(
    (codec: string): string | null => {
      return validateHdrExportSettings(settings, codec);
    },
    [settings]
  );

  // ---------------------------------------------------------------------------
  // Save Settings
  // ---------------------------------------------------------------------------

  const save = useCallback(async (): Promise<boolean> => {
    setIsSaving(true);
    setError(null);

    try {
      logger.debug('Saving HDR settings', { sequenceId, settings });

      await invoke('execute_command', {
        commandType: 'UpdateSequenceHdrSettings',
        payload: {
          sequenceId,
          settings,
        },
      });

      setOriginalSettings(settings);
      logger.info('HDR settings saved', { sequenceId });

      return true;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error('Failed to save HDR settings', { error: err, sequenceId });
      setError(errorMsg);
      return false;
    } finally {
      setIsSaving(false);
    }
  }, [sequenceId, settings]);

  // ---------------------------------------------------------------------------
  // Reset
  // ---------------------------------------------------------------------------

  const reset = useCallback(() => {
    setSettings(DEFAULT_HDR_EXPORT);
    setOriginalSettings(DEFAULT_HDR_EXPORT);
    setError(null);
    logger.info('HDR settings reset to defaults');
  }, []);

  // ---------------------------------------------------------------------------
  // Clear Error
  // ---------------------------------------------------------------------------

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  // ---------------------------------------------------------------------------
  // Return
  // ---------------------------------------------------------------------------

  return {
    settings,
    isHdr,
    setHdrMode,
    setMaxCll,
    setMaxFall,
    setBitDepth,
    applyPreset,
    validateCodec,
    save,
    reset,
    validationWarning,
    isDirty,
    isLoading,
    isSaving,
    error,
    clearError,
  };
}

export default useHDRSettings;
