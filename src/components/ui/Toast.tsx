/**
 * Toast Component
 *
 * Displays notification messages with auto-dismiss and different variants.
 */

import { useEffect, useState, useCallback } from 'react';
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
}> = {
  success: {
    icon: CheckCircle,
    bgClass: 'bg-green-900/90',
    iconClass: 'text-green-400',
    borderClass: 'border-green-500/50',
  },
  error: {
    icon: AlertCircle,
    bgClass: 'bg-red-900/90',
    iconClass: 'text-red-400',
    borderClass: 'border-red-500/50',
  },
  warning: {
    icon: AlertTriangle,
    bgClass: 'bg-yellow-900/90',
    iconClass: 'text-yellow-400',
    borderClass: 'border-yellow-500/50',
  },
  info: {
    icon: Info,
    bgClass: 'bg-blue-900/90',
    iconClass: 'text-blue-400',
    borderClass: 'border-blue-500/50',
  },
};

// =============================================================================
// Toast Component
// =============================================================================

function Toast({ toast, onClose }: ToastProps): JSX.Element {
  const [isVisible, setIsVisible] = useState(false);
  const [isExiting, setIsExiting] = useState(false);
  const config = variantConfig[toast.variant];
  const Icon = config.icon;

  // Animate in
  useEffect(() => {
    requestAnimationFrame(() => {
      setIsVisible(true);
    });
  }, []);

  const handleClose = useCallback(() => {
    setIsExiting(true);
    setTimeout(() => {
      onClose(toast.id);
    }, 200);
  }, [onClose, toast.id]);

  // Auto dismiss
  useEffect(() => {
    const duration = toast.duration ?? 4000;
    const timer = setTimeout(() => {
      handleClose();
    }, duration);

    return () => clearTimeout(timer);
  }, [toast.duration, handleClose]);

  return (
    <div
      data-testid={`toast-${toast.id}`}
      className={`
        flex items-center gap-3 px-4 py-3 rounded-lg border shadow-lg backdrop-blur
        ${config.bgClass} ${config.borderClass}
        transition-all duration-200 ease-out
        ${isVisible && !isExiting ? 'opacity-100 translate-x-0' : 'opacity-0 translate-x-4'}
      `}
      role="alert"
    >
      <Icon className={`w-5 h-5 flex-shrink-0 ${config.iconClass}`} />
      <p className="flex-1 text-sm text-white">{toast.message}</p>
      <button
        onClick={handleClose}
        className="p-1 rounded hover:bg-white/10 text-white/70 hover:text-white transition-colors"
        aria-label="Dismiss notification"
      >
        <X className="w-4 h-4" />
      </button>
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
      className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm"
    >
      {toasts.map((toast) => (
        <Toast key={toast.id} toast={toast} onClose={onClose} />
      ))}
    </div>
  );
}
