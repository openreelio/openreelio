/**
 * Toast Component
 *
 * Displays notification messages with auto-dismiss and different variants.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { X, CheckCircle, AlertCircle, AlertTriangle, Info } from 'lucide-react';

// =============================================================================
// Types
// =============================================================================

export type ToastVariant = 'success' | 'error' | 'warning' | 'info';

export interface ToastData {
  id: string;
  message: string;
  variant: ToastVariant;
  duration?: number;
  undoAction?: () => void;
  undoLabel?: string;
  createdAt?: number;
}

interface ToastProps {
  toast: ToastData;
  onClose: (id: string) => void;
}

interface ToastContainerProps {
  toasts: ToastData[];
  onClose: (id: string) => void;
}

// =============================================================================
// Variant Styles
// =============================================================================

const variantConfig: Record<ToastVariant, {
  icon: typeof CheckCircle;
  bgClass: string;
  iconClass: string;
  borderClass: string;
  progressClass: string;
}> = {
  success: {
    icon: CheckCircle,
    bgClass: 'bg-status-success/10',
    iconClass: 'text-status-success',
    borderClass: 'border-status-success/30',
    progressClass: 'bg-status-success',
  },
  error: {
    icon: AlertCircle,
    bgClass: 'bg-status-error/10',
    iconClass: 'text-status-error',
    borderClass: 'border-status-error/30',
    progressClass: 'bg-status-error',
  },
  warning: {
    icon: AlertTriangle,
    bgClass: 'bg-status-warning/10',
    iconClass: 'text-status-warning',
    borderClass: 'border-status-warning/30',
    progressClass: 'bg-status-warning',
  },
  info: {
    icon: Info,
    bgClass: 'bg-status-info/10',
    iconClass: 'text-status-info',
    borderClass: 'border-status-info/30',
    progressClass: 'bg-status-info',
  },
};

// =============================================================================
// Constants
// =============================================================================

/** Default auto-dismiss duration in milliseconds */
const DEFAULT_DURATION = 4000;

/** Animation duration for toast exit in milliseconds */
const EXIT_ANIMATION_DURATION = 200;

/** Progress bar update interval in milliseconds */
const PROGRESS_UPDATE_INTERVAL = 100;

/** Minimum valid duration to prevent timing issues */
const MIN_DURATION = 100;

// =============================================================================
// Toast Component
// =============================================================================

function Toast({ toast, onClose }: ToastProps): JSX.Element {
  const [isVisible, setIsVisible] = useState(false);
  const [isExiting, setIsExiting] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const [progress, setProgress] = useState(100);

  // Track closing state to prevent double-close race conditions
  const isClosingRef = useRef(false);
  // Track if component is still mounted to prevent state updates after unmount
  const isMountedRef = useRef(true);
  const closeTimeoutRef = useRef<number | null>(null);
  const intervalRef = useRef<number | null>(null);
  const deadlineRef = useRef<number | null>(null);
  const pauseStartedAtRef = useRef<number | null>(null);

  // Defensive: Validate variant and use fallback if invalid
  const variant = toast.variant in variantConfig ? toast.variant : 'info';
  const config = variantConfig[variant];
  const Icon = config.icon;

  // Defensive: Ensure duration is valid (non-negative number)
  const rawDuration = toast.duration ?? DEFAULT_DURATION;
  const duration = Number.isFinite(rawDuration) && rawDuration >= 0
    ? (rawDuration > 0 && rawDuration < MIN_DURATION ? MIN_DURATION : rawDuration)
    : DEFAULT_DURATION;

  // Defensive: Ensure createdAt is valid timestamp (allow 0 for tests with fake timers)
  const rawCreatedAt = toast.createdAt ?? Date.now();
  const createdAt = Number.isFinite(rawCreatedAt) && rawCreatedAt >= 0
    ? rawCreatedAt
    : Date.now();

  // Track mounted state for safe state updates
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // Animate in on mount
  useEffect(() => {
    const rafId = requestAnimationFrame(() => {
      if (isMountedRef.current) {
        setIsVisible(true);
      }
    });
    return () => cancelAnimationFrame(rafId);
  }, []);

  /**
   * Handle toast dismissal with exit animation.
   * Uses ref-based closing flag to prevent race conditions from:
   * - Multiple rapid clicks on close button
   * - Simultaneous auto-dismiss and manual close
   * - Undo action triggering close while already closing
   */
  const handleClose = useCallback(() => {
    // Prevent double-close race condition
    if (isClosingRef.current) return;
    isClosingRef.current = true;

    setIsExiting(true);

    // Clear any existing interval to stop progress updates
    if (intervalRef.current !== null) {
      window.clearInterval(intervalRef.current);
      intervalRef.current = null;
    }

    closeTimeoutRef.current = window.setTimeout(() => {
      onClose(toast.id);
    }, EXIT_ANIMATION_DURATION);
  }, [onClose, toast.id]);

  /**
   * Handle undo action with proper close sequencing.
   */
  const handleUndo = useCallback(() => {
    // Guard against calling undo during close animation
    if (isClosingRef.current) return;

    if (toast.undoAction) {
      try {
        toast.undoAction();
      } catch (error) {
        // Defensive: Log but don't crash if undo action fails
        console.error('Toast undo action failed:', error);
      }
      handleClose();
    }
  }, [toast, handleClose]);

  // Cleanup all timers on unmount
  useEffect(() => {
    return () => {
      if (closeTimeoutRef.current !== null) {
        window.clearTimeout(closeTimeoutRef.current);
        closeTimeoutRef.current = null;
      }
      if (intervalRef.current !== null) {
        window.clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, []);

  /**
   * Countdown timer with progress bar.
   * Features:
   * - Pause on hover (extends deadline by paused duration)
   * - Persistent toasts when duration=0
   * - Safe cleanup to prevent memory leaks
   * - Race condition prevention for auto-dismiss
   */
  useEffect(() => {
    // Skip countdown for persistent toasts
    if (duration === 0) return;

    // Reset closing state for new toast or remounted component
    isClosingRef.current = false;
    pauseStartedAtRef.current = null;
    deadlineRef.current = createdAt + duration;
    setProgress(100);

    const tick = () => {
      // Don't update if closing (prevents double-close)
      if (isClosingRef.current) return;

      const now = Date.now();
      const deadline = deadlineRef.current ?? now;
      const pauseStartedAt = pauseStartedAtRef.current;
      const effectiveNow = pauseStartedAt ?? now;
      const remainingMs = Math.max(0, deadline - effectiveNow);

      // Defensive: Avoid division by zero and NaN
      const newProgress = duration > 0 ? (remainingMs / duration) * 100 : 0;
      setProgress(Number.isFinite(newProgress) ? newProgress : 0);

      if (remainingMs <= 0) {
        handleClose();
      }
    };

    tick();
    intervalRef.current = window.setInterval(tick, PROGRESS_UPDATE_INTERVAL);

    return () => {
      if (intervalRef.current !== null) {
        window.clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [createdAt, duration, handleClose]);

  return (
    <div
      data-testid={`toast-${toast.id}`}
      className={`
        w-full max-w-80 rounded-lg border shadow-lg backdrop-blur overflow-hidden bg-surface-elevated
        ${config.bgClass} ${config.borderClass}
        transition-all duration-200 ease-out
        ${isVisible && !isExiting ? 'opacity-100 translate-x-0' : 'opacity-0 translate-x-4'}
      `}
      role="alert"
      aria-live="polite"
      onMouseEnter={() => {
        // Don't pause if already closing or duration is 0
        if (isClosingRef.current || duration === 0) return;

        setIsHovered(true);

        // Start pause tracking if not already paused
        if (pauseStartedAtRef.current === null) {
          pauseStartedAtRef.current = Date.now();
        }
      }}
      onMouseLeave={() => {
        // Don't resume if closing or duration is 0
        if (isClosingRef.current || duration === 0) return;

        setIsHovered(false);

        // Calculate paused duration and extend deadline
        const pauseStartedAt = pauseStartedAtRef.current;
        if (pauseStartedAt !== null) {
          const pausedMs = Date.now() - pauseStartedAt;
          // Defensive: Only extend if pausedMs is valid
          if (Number.isFinite(pausedMs) && pausedMs > 0 && deadlineRef.current !== null) {
            deadlineRef.current += pausedMs;
          }
          pauseStartedAtRef.current = null;
        }
      }}
    >
      <div className="flex items-start gap-3 px-4 py-3">
        <Icon className={`w-5 h-5 flex-shrink-0 mt-0.5 ${config.iconClass}`} />

        <div className="flex-1 min-w-0 overflow-hidden">
          <p className="text-sm text-text-primary break-words">{toast.message}</p>
        </div>

        {toast.undoAction && (
          <button
            onClick={handleUndo}
            className="text-sm font-medium text-text-primary hover:underline focus:outline-none focus:ring-2 focus:ring-border-focus/60 rounded px-2 py-1"
            aria-label={toast.undoLabel ?? 'Undo'}
          >
            {toast.undoLabel ?? 'Undo'}
          </button>
        )}

        <button
          onClick={handleClose}
          className="p-1 rounded hover:bg-surface-active text-text-muted hover:text-text-primary transition-colors focus:outline-none focus:ring-2 focus:ring-border-focus/60"
          aria-label="Dismiss notification"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Progress bar - only show for timed toasts */}
      {duration > 0 && (
        <div className="h-0.5 bg-surface-active" aria-hidden="true">
          <div
            className={`h-full transition-all ${config.progressClass}`}
            style={{
              // Defensive: Clamp progress to valid percentage range
              width: `${Math.max(0, Math.min(100, Number.isFinite(progress) ? progress : 0))}%`,
              transitionDuration: isHovered ? '0ms' : '100ms',
            }}
          />
        </div>
      )}
    </div>
  );
}

// =============================================================================
// Toast Container Component
// =============================================================================

/**
 * Container component for displaying multiple toasts.
 *
 * Features:
 * - Stacks toasts vertically
 * - Handles pointer events correctly (container is click-through)
 * - Validates toast data before rendering
 * - Limits maximum visible toasts to prevent UI overflow
 */
export function ToastContainer({ toasts, onClose }: ToastContainerProps): JSX.Element {
  // Defensive: Ensure toasts is a valid array
  const validToasts = Array.isArray(toasts) ? toasts : [];

  // Defensive: Filter out invalid toasts and limit display count
  const MAX_VISIBLE_TOASTS = 5;
  const displayToasts = validToasts
    .filter((toast): toast is ToastData => {
      // Validate required fields
      if (!toast || typeof toast !== 'object') return false;
      if (typeof toast.id !== 'string' || toast.id.length === 0) return false;
      if (typeof toast.message !== 'string') return false;
      if (!toast.variant || !(toast.variant in variantConfig)) return false;
      return true;
    })
    .slice(-MAX_VISIBLE_TOASTS); // Keep most recent toasts

  return (
    <div
      data-testid="toast-container"
      className="fixed bottom-4 right-4 left-4 sm:left-auto z-toast flex flex-col items-end gap-2 pointer-events-none"
      role="region"
      aria-label="Notifications"
    >
      {displayToasts.map((toast) => (
        <div key={toast.id} className="pointer-events-auto w-full sm:w-auto">
          <Toast toast={toast} onClose={onClose} />
        </div>
      ))}
    </div>
  );
}
