/**
 * useToast Hook
 *
 * Manages toast notification state and provides methods to show/dismiss toasts.
 */

import { create } from 'zustand';
import type { ToastData, ToastVariant } from '@/components/ui/Toast';

// =============================================================================
// Types
// =============================================================================

interface ToastStore {
  toasts: ToastData[];
  addToast: (message: string, variant: ToastVariant, duration?: number) => string;
  removeToast: (id: string) => void;
  clearToasts: () => void;
}

// =============================================================================
// Store
// =============================================================================

export const useToastStore = create<ToastStore>((set) => ({
  toasts: [],

  addToast: (message: string, variant: ToastVariant, duration?: number) => {
    const id = `toast-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    const toast: ToastData = { id, message, variant, duration };

    set((state) => ({
      toasts: [...state.toasts, toast],
    }));

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
  showToast: (message: string, variant?: ToastVariant, duration?: number) => string;
  showSuccess: (message: string, duration?: number) => string;
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
    showToast: (message: string, variant: ToastVariant = 'info', duration?: number) =>
      addToast(message, variant, duration),
    showSuccess: (message: string, duration?: number) =>
      addToast(message, 'success', duration),
    showError: (message: string, duration?: number) =>
      addToast(message, 'error', duration ?? 6000),
    showWarning: (message: string, duration?: number) =>
      addToast(message, 'warning', duration),
    showInfo: (message: string, duration?: number) =>
      addToast(message, 'info', duration),
    dismissToast: removeToast,
    clearAll: clearToasts,
  };
}
