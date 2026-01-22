/**
 * useToast Hook (Production Grade)
 *
 * Manages toast notification state with queueing, auto-dismissal limits,
 * and robust undo support.
 */

import { create } from 'zustand';
import type { ToastData, ToastVariant } from '@/components/ui/Toast';

// =============================================================================
// Constants
// =============================================================================

const MAX_TOASTS = 5;
const DEFAULT_DURATION = 4000;

// =============================================================================
// Types
// =============================================================================

export interface ToastOptions {
  message: string;
  variant?: ToastVariant;
  duration?: number;
  undoAction?: () => void;
  undoLabel?: string;
}

interface ToastStore {
  toasts: ToastData[];
  addToast: (options: ToastOptions) => string;
  removeToast: (id: string) => void;
  clearToasts: () => void;
}

function createToastId(): string {
  // Prefer cryptographically strong IDs when available to avoid collisions during bursts.
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `toast-${crypto.randomUUID()}`;
  }

  const now = Date.now();
  const random = Math.random().toString(36).slice(2);
  return `toast-${now}-${random}`;
}

// =============================================================================
// Store
// =============================================================================

export const useToastStore = create<ToastStore>((set) => ({
  toasts: [],

  addToast: (options: ToastOptions) => {
    const id = createToastId();

    const toast: ToastData = {
      id,
      message: options.message,
      variant: options.variant ?? 'info',
      duration: Math.max(0, options.duration ?? DEFAULT_DURATION),
      undoAction: options.undoAction,
      undoLabel: options.undoLabel ?? 'Undo',
      createdAt: Date.now(),
    };

    set((state) => {
      // Enforce max toasts limit (remove oldest)
      const currentToasts = state.toasts;
      const newToasts =
        currentToasts.length >= MAX_TOASTS
          ? [...currentToasts.slice(1), toast]
          : [...currentToasts, toast];

      return { toasts: newToasts };
    });

    return id;
  },

  removeToast: (id: string) => {
    set((state) => ({
      toasts: state.toasts.filter((t) => t.id !== id),
    }));
  },

  clearToasts: () => {
    set({ toasts: [] });
  },
}));

// =============================================================================
// Hook
// =============================================================================

export interface UseToastReturn {
  toasts: ToastData[];
  toast: (options: ToastOptions | string) => string;
  showSuccess: (message: string, duration?: number, undoAction?: () => void) => string;
  showError: (message: string, duration?: number) => string;
  showWarning: (message: string, duration?: number) => string;
  showInfo: (message: string, duration?: number) => string;
  dismissToast: (id: string) => void;
  clearAll: () => void;
}

export function useToast(): UseToastReturn {
  const { toasts, addToast, removeToast, clearToasts } = useToastStore();

  return {
    toasts,

    toast: (options: ToastOptions | string) => {
      if (typeof options === 'string') {
        return addToast({ message: options, variant: 'info' });
      }
      return addToast(options);
    },

    showSuccess: (message: string, duration?: number, undoAction?: () => void) =>
      addToast({
        message,
        variant: 'success',
        duration: duration ?? DEFAULT_DURATION,
        undoAction,
      }),

    showError: (message: string, duration?: number) =>
      addToast({
        message,
        variant: 'error',
        duration: duration ?? 0, // 0 = persistent for errors
      }),

    showWarning: (message: string, duration?: number) =>
      addToast({
        message,
        variant: 'warning',
        duration: duration ?? DEFAULT_DURATION,
      }),

    showInfo: (message: string, duration?: number) =>
      addToast({
        message,
        variant: 'info',
        duration: duration ?? DEFAULT_DURATION,
      }),

    dismissToast: removeToast,
    clearAll: clearToasts,
  };
}
