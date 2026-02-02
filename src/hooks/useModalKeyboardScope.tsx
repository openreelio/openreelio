/**
 * useModalKeyboardScope Hook
 *
 * Integrates modal store with keyboard scope system.
 * Provides proper keyboard shortcut handling for modals including:
 * - Escape key to close modals
 * - Priority-based shortcut blocking (modals block global shortcuts)
 * - Modal stack navigation
 *
 * @module hooks/useModalKeyboardScope
 */

import { useMemo, useCallback } from 'react';
import { useModalStore } from '@/stores/modalStore';
import {
  useRegisterShortcuts,
  SCOPE_PRIORITY,
  type ShortcutHandler,
} from './useKeyboardScope';

// =============================================================================
// Types
// =============================================================================

export interface UseModalKeyboardScopeOptions {
  /**
   * Custom callback when Escape is pressed on a modal.
   * Return `false` to prevent the modal from closing.
   */
  onEscape?: () => boolean | void;

  /**
   * Whether to automatically close the modal on Escape.
   * @default true
   */
  closeOnEscape?: boolean;
}

export interface UseModalKeyboardScopeReturn {
  /** Whether a modal is currently open */
  isModalOpen: boolean;
  /** The current modal type */
  modalType: string;
  /** Close the current modal */
  closeModal: () => void;
}

// =============================================================================
// Priority Mapping
// =============================================================================

/**
 * Determines the keyboard scope priority for a modal type.
 * Confirmation dialogs and error modals get higher priority.
 */
function getModalPriority(modalType: string): number {
  switch (modalType) {
    case 'error':
      return SCOPE_PRIORITY.CRITICAL;
    case 'confirm-delete':
      return SCOPE_PRIORITY.DIALOG;
    case 'none':
      return 0; // No scope needed
    default:
      return SCOPE_PRIORITY.MODAL;
  }
}

// =============================================================================
// Hook Implementation
// =============================================================================

/**
 * Hook that integrates modal state with keyboard scope system.
 *
 * Features:
 * - Automatically registers keyboard scope when modal opens
 * - Handles Escape key to close modals
 * - Supports modal stack (pops from stack before closing)
 * - Allows custom escape handling with prevention
 *
 * @example
 * ```tsx
 * function App() {
 *   useModalKeyboardScope({
 *     onEscape: () => {
 *       // Custom logic before close
 *       return true; // Allow close
 *     },
 *   });
 *
 *   return <ModalContainer />;
 * }
 * ```
 */
export function useModalKeyboardScope(
  options: UseModalKeyboardScopeOptions = {}
): UseModalKeyboardScopeReturn {
  const { onEscape, closeOnEscape = true } = options;

  // Get modal state
  const modal = useModalStore((state) => state.modal);
  const stack = useModalStore((state) => state.stack);
  const closeModal = useModalStore((state) => state.closeModal);
  const popModal = useModalStore((state) => state.popModal);

  // Determine if modal is open and its type
  const isModalOpen = modal.type !== 'none';
  const modalType = modal.type;
  const priority = getModalPriority(modalType);

  // Handle escape key
  const handleEscape: ShortcutHandler = useCallback(() => {
    // Only handle if modal is open
    if (!isModalOpen) return;

    // Call custom handler if provided
    if (onEscape) {
      const result = onEscape();
      // If handler returns false, don't close
      if (result === false) return;
    }

    // Close or pop modal
    if (closeOnEscape) {
      // If there's more than one modal in stack, pop instead of close
      if (stack.length > 1) {
        popModal();
      } else {
        closeModal();
      }
    }
  }, [isModalOpen, onEscape, closeOnEscape, stack.length, popModal, closeModal]);

  // Create shortcuts object (memoized to prevent re-registration)
  const shortcuts = useMemo<Record<string, ShortcutHandler>>(
    () => {
      const next: Record<string, ShortcutHandler> = {};
      if (isModalOpen) {
        next.escape = handleEscape;
      }
      return next;
    },
    [isModalOpen, handleEscape]
  );

  // Register shortcuts only when modal is open
  useRegisterShortcuts(
    `modal-${modalType}`,
    priority,
    shortcuts,
    { allowInInputs: false }
  );

  return {
    isModalOpen,
    modalType,
    closeModal,
  };
}

// =============================================================================
// Exports
// =============================================================================

export default useModalKeyboardScope;
