/**
 * useAutoSave Hook
 *
 * Provides automatic project saving with debouncing.
 * Saves the project when isDirty changes to true after a delay.
 */

import { useEffect, useRef, useCallback, useState } from 'react';
import { useProjectStore } from '@/stores';

// =============================================================================
// Types
// =============================================================================

export interface UseAutoSaveOptions {
  /** Delay in milliseconds before saving (default: 30000 = 30 seconds) */
  delay?: number;
  /** Whether auto-save is enabled (default: true) */
  enabled?: boolean;
  /** Callback when save starts */
  onSaveStart?: () => void;
  /** Callback when save completes successfully */
  onSaveComplete?: () => void;
  /** Callback when save fails */
  onSaveError?: (error: Error) => void;
}

export interface UseAutoSaveReturn {
  /** Whether a save is currently in progress */
  isSaving: boolean;
  /** Last save timestamp */
  lastSavedAt: Date | null;
  /** Error from last save attempt */
  lastError: Error | null;
  /** Manually trigger a save */
  saveNow: () => Promise<void>;
  /** Time until next auto-save (null if not scheduled) */
  timeUntilSave: number | null;
}

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_DELAY_MS = 30_000; // 30 seconds

// =============================================================================
// Hook
// =============================================================================

export function useAutoSave(options: UseAutoSaveOptions = {}): UseAutoSaveReturn {
  const {
    delay = DEFAULT_DELAY_MS,
    enabled = true,
    onSaveStart,
    onSaveComplete,
    onSaveError,
  } = options;

  // Get store state and actions
  const { isDirty, isLoaded, saveProject } = useProjectStore();

  // Local state
  const [isSaving, setIsSaving] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);
  const [lastError, setLastError] = useState<Error | null>(null);
  const [timeUntilSave, setTimeUntilSave] = useState<number | null>(null);

  // Refs for timer management
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const countdownIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const scheduledSaveTimeRef = useRef<number | null>(null);

  // Save function
  const performSave = useCallback(async () => {
    if (isSaving) return;

    setIsSaving(true);
    setLastError(null);
    onSaveStart?.();

    try {
      await saveProject();
      setLastSavedAt(new Date());
      onSaveComplete?.();
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      setLastError(err);
      onSaveError?.(err);
    } finally {
      setIsSaving(false);
      setTimeUntilSave(null);
      scheduledSaveTimeRef.current = null;
    }
  }, [isSaving, saveProject, onSaveStart, onSaveComplete, onSaveError]);

  // Manual save function
  const saveNow = useCallback(async () => {
    // Clear any pending auto-save
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = null;
    }
    if (countdownIntervalRef.current) {
      clearInterval(countdownIntervalRef.current);
      countdownIntervalRef.current = null;
    }

    await performSave();
  }, [performSave]);

  // Effect to handle auto-save scheduling
  useEffect(() => {
    // Clear existing timers
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = null;
    }
    if (countdownIntervalRef.current) {
      clearInterval(countdownIntervalRef.current);
      countdownIntervalRef.current = null;
    }

    // Only schedule if enabled, project is loaded, and dirty
    if (!enabled || !isLoaded || !isDirty || isSaving) {
      setTimeUntilSave(null);
      scheduledSaveTimeRef.current = null;
      return;
    }

    // Schedule save
    const saveTime = Date.now() + delay;
    scheduledSaveTimeRef.current = saveTime;

    saveTimeoutRef.current = setTimeout(() => {
      void performSave();
    }, delay);

    // Update countdown every second
    setTimeUntilSave(delay);
    countdownIntervalRef.current = setInterval(() => {
      if (scheduledSaveTimeRef.current) {
        const remaining = Math.max(0, scheduledSaveTimeRef.current - Date.now());
        setTimeUntilSave(remaining);
        if (remaining <= 0 && countdownIntervalRef.current) {
          clearInterval(countdownIntervalRef.current);
          countdownIntervalRef.current = null;
        }
      }
    }, 1000);

    // Cleanup
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
        saveTimeoutRef.current = null;
      }
      if (countdownIntervalRef.current) {
        clearInterval(countdownIntervalRef.current);
        countdownIntervalRef.current = null;
      }
    };
  }, [enabled, isLoaded, isDirty, isSaving, delay, performSave]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
      if (countdownIntervalRef.current) {
        clearInterval(countdownIntervalRef.current);
      }
    };
  }, []);

  return {
    isSaving,
    lastSavedAt,
    lastError,
    saveNow,
    timeUntilSave,
  };
}
