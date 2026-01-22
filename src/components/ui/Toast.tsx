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
// Toast Component
// =============================================================================

function Toast({ toast, onClose }: ToastProps): JSX.Element {
  const [isVisible, setIsVisible] = useState(false);
  const [isExiting, setIsExiting] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const [progress, setProgress] = useState(100);
  const isClosingRef = useRef(false);
  const closeTimeoutRef = useRef<number | null>(null);
  const deadlineRef = useRef<number | null>(null);
  const pauseStartedAtRef = useRef<number | null>(null);

  const config = variantConfig[toast.variant];
  const Icon = config.icon;
  const duration = toast.duration ?? 4000;
  const createdAt = toast.createdAt ?? Date.now();

  // Animate in
  useEffect(() => {
    requestAnimationFrame(() => {
      setIsVisible(true);
    });
  }, []);

  const handleClose = useCallback(() => {
    if (isClosingRef.current) return;
    isClosingRef.current = true;
    setIsExiting(true);
    closeTimeoutRef.current = window.setTimeout(() => {
      onClose(toast.id);
    }, 200);
  }, [onClose, toast.id]);

  const handleUndo = useCallback(() => {
    if (toast.undoAction) {
      toast.undoAction();
      handleClose();
    }
  }, [toast, handleClose]);

  useEffect(() => {
    return () => {
      if (closeTimeoutRef.current !== null) {
        window.clearTimeout(closeTimeoutRef.current);
        closeTimeoutRef.current = null;
      }
    };
  }, []);

  // Countdown + progress bar (pause on hover, persistent on duration=0)
  useEffect(() => {
    if (duration === 0) return;

    isClosingRef.current = false;
    pauseStartedAtRef.current = null;
    deadlineRef.current = createdAt + duration;
    setProgress(100);

    const tick = () => {
      const now = Date.now();
      const deadline = deadlineRef.current ?? now;
      const pauseStartedAt = pauseStartedAtRef.current;
      const effectiveNow = pauseStartedAt ?? now;
      const remainingMs = Math.max(0, deadline - effectiveNow);
      setProgress((remainingMs / duration) * 100);
      if (remainingMs <= 0) {
        handleClose();
      }
    };

    tick();
    const intervalId = window.setInterval(tick, 100);
    return () => window.clearInterval(intervalId);
  }, [createdAt, duration, handleClose]);

  return (
    <div
      data-testid={`toast-${toast.id}`}
      className={`
        w-80 rounded-lg border shadow-lg backdrop-blur overflow-hidden bg-surface-elevated
        ${config.bgClass} ${config.borderClass}
        transition-all duration-200 ease-out
        ${isVisible && !isExiting ? 'opacity-100 translate-x-0' : 'opacity-0 translate-x-4'}
      `}
      role="alert"
      onMouseEnter={() => {
        setIsHovered(true);
        if (duration === 0) return;
        if (pauseStartedAtRef.current === null) {
          pauseStartedAtRef.current = Date.now();
        }
      }}
      onMouseLeave={() => {
        setIsHovered(false);
        if (duration === 0) return;

        const pauseStartedAt = pauseStartedAtRef.current;
        if (pauseStartedAt !== null) {
          const pausedMs = Date.now() - pauseStartedAt;
          if (deadlineRef.current !== null) {
            deadlineRef.current += pausedMs;
          }
          pauseStartedAtRef.current = null;
        }
      }}
    >
      <div className="flex items-start gap-3 px-4 py-3">
        <Icon className={`w-5 h-5 flex-shrink-0 mt-0.5 ${config.iconClass}`} />

        <div className="flex-1 min-w-0">
          <p className="text-sm text-text-primary">{toast.message}</p>
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

      {/* Progress bar */}
      {duration > 0 && (
        <div className="h-0.5 bg-surface-active">
          <div
            className={`h-full ${config.progressClass}`}
            style={{
              width: `${progress}%`,
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

export function ToastContainer({ toasts, onClose }: ToastContainerProps): JSX.Element {
  return (
    <div
      data-testid="toast-container"
      className="fixed bottom-4 right-4 z-toast flex flex-col gap-2 max-w-sm"
    >
      {toasts.map((toast) => (
        <Toast key={toast.id} toast={toast} onClose={onClose} />
      ))}
    </div>
  );
}
