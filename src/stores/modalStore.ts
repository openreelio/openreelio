/**
 * Modal Store
 *
 * Type-safe modal state management using discriminated unions.
 * Inspired by Remotion's modal state pattern.
 *
 * Features:
 * - Discriminated union for exhaustive type checking
 * - Modal stack for nested modals (z-index management)
 * - Type-safe payload access
 * - Callback support for close/confirm actions
 *
 * @module stores/modalStore
 */

import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { devtools } from 'zustand/middleware';

// =============================================================================
// Modal State Types (Discriminated Union)
// =============================================================================

/** No modal open */
interface ModalNone {
  type: 'none';
}

/** Export dialog */
interface ModalExport {
  type: 'export';
  preset?: string;
  sequenceId?: string;
}

/** Application settings */
interface ModalSettings {
  type: 'settings';
  tab?: 'general' | 'shortcuts' | 'appearance' | 'playback' | 'ai' | 'advanced';
}

/** Project settings */
interface ModalProjectSettings {
  type: 'project-settings';
}

/** Keyboard shortcuts help */
interface ModalKeyboardShortcuts {
  type: 'keyboard-shortcuts';
}

/** Asset import dialog */
interface ModalAssetImport {
  type: 'asset-import';
  files?: File[];
}

/** Confirm delete dialog */
interface ModalConfirmDelete {
  type: 'confirm-delete';
  itemIds: string[];
  itemType: 'clip' | 'track' | 'asset' | 'sequence';
  onConfirm: () => void;
  message?: string;
}

/** Render queue panel */
interface ModalRenderQueue {
  type: 'render-queue';
}

/** AI prompt panel */
interface ModalAIPrompt {
  type: 'ai-prompt';
  context?: string;
  initialPrompt?: string;
}

/** About dialog */
interface ModalAbout {
  type: 'about';
}

/** New project dialog */
interface ModalNewProject {
  type: 'new-project';
}

/** Error overlay (critical errors) */
interface ModalError {
  type: 'error';
  error: Error;
  severity: 'warning' | 'error' | 'critical';
  title?: string;
  recoveryAction?: () => void;
  recoveryLabel?: string;
}

/**
 * Discriminated union of all modal types.
 * Add new modal types here for exhaustive type checking.
 */
export type ModalState =
  | ModalNone
  | ModalExport
  | ModalSettings
  | ModalProjectSettings
  | ModalKeyboardShortcuts
  | ModalAssetImport
  | ModalConfirmDelete
  | ModalRenderQueue
  | ModalAIPrompt
  | ModalAbout
  | ModalNewProject
  | ModalError;

/** Modal types that can be opened (excludes 'none') */
export type OpenableModal = Exclude<ModalState, ModalNone>;

/** Extract modal type string */
export type ModalType = ModalState['type'];

// =============================================================================
// Modal Options
// =============================================================================

/** Options when opening a modal */
interface ModalOptions {
  /** Callback when modal is closed */
  onClose?: () => void;
  /** Whether to allow closing by clicking outside */
  closeOnOutsideClick?: boolean;
  /** Whether to allow closing with Escape key */
  closeOnEscape?: boolean;
}

/** Entry in the modal stack */
interface ModalStackEntry {
  modal: ModalState;
  options?: ModalOptions;
}

// =============================================================================
// Store State & Actions
// =============================================================================

interface ModalStoreState {
  /** Current active modal (top of stack) */
  modal: ModalState;
  /** Modal stack for nested modals */
  stack: ModalStackEntry[];
  /** Whether any modal is currently open */
  isOpen: boolean;
  /** Options for the current modal */
  currentOptions?: ModalOptions;
}

interface ModalStoreActions {
  /** Open a modal (replaces current if any) */
  openModal: (modal: OpenableModal, options?: ModalOptions) => void;
  /** Close the current modal */
  closeModal: () => void;
  /** Close all modals */
  closeAll: () => void;
  /** Push a modal onto the stack (for nested modals) */
  pushModal: (modal: OpenableModal, options?: ModalOptions) => void;
  /** Pop the top modal from the stack */
  popModal: () => void;
  /** Get z-index for the current modal level */
  getZIndex: () => number;
  /** Check if a specific modal type is open */
  isModalOpen: <T extends ModalType>(type: T) => boolean;
}

export type ModalStore = ModalStoreState & ModalStoreActions;

// =============================================================================
// Constants
// =============================================================================

const BASE_Z_INDEX = 1000;
const Z_INDEX_INCREMENT = 10;

// =============================================================================
// Store Implementation
// =============================================================================

export const useModalStore = create<ModalStore>()(
  devtools(
    immer((set, get) => ({
      // Initial state
      modal: { type: 'none' } as ModalState,
      stack: [],
      isOpen: false,
      currentOptions: undefined,

      // Open modal (replaces current)
      openModal: (modal, options) => {
        set((state) => {
          // Clear stack and set new modal
          state.stack = [{ modal, options }];
          state.modal = modal;
          state.isOpen = true;
          state.currentOptions = options;
        });
      },

      // Close current modal
      closeModal: () => {
        // Capture callback reference before state update to avoid race conditions
        const optionsSnapshot = get().currentOptions;
        const onCloseCallback = optionsSnapshot?.onClose;

        set((state) => {
          if (state.stack.length > 1) {
            // Pop from stack and show previous
            state.stack.pop();
            const previous = state.stack[state.stack.length - 1];
            state.modal = previous.modal;
            state.currentOptions = previous.options;
          } else {
            // Close completely
            state.stack = [];
            state.modal = { type: 'none' };
            state.isOpen = false;
            state.currentOptions = undefined;
          }
        });

        // Call onClose callback AFTER state update completes
        // This ensures any new modals opened by the callback don't get clobbered
        if (onCloseCallback) {
          // Use queueMicrotask to ensure state update is flushed before callback
          queueMicrotask(() => {
            try {
              onCloseCallback();
            } catch (error) {
              console.error('Modal onClose callback threw error:', error);
            }
          });
        }
      },

      // Close all modals
      closeAll: () => {
        set((state) => {
          state.stack = [];
          state.modal = { type: 'none' };
          state.isOpen = false;
          state.currentOptions = undefined;
        });
      },

      // Push modal onto stack
      pushModal: (modal, options) => {
        set((state) => {
          state.stack.push({ modal, options });
          state.modal = modal;
          state.isOpen = true;
          state.currentOptions = options;
        });
      },

      // Pop modal from stack
      popModal: () => {
        // Capture callback reference before state update to avoid race conditions
        const optionsSnapshot = get().currentOptions;
        const onCloseCallback = optionsSnapshot?.onClose;

        set((state) => {
          if (state.stack.length > 1) {
            state.stack.pop();
            const previous = state.stack[state.stack.length - 1];
            state.modal = previous.modal;
            state.currentOptions = previous.options;
          } else if (state.stack.length === 1) {
            state.stack = [];
            state.modal = { type: 'none' };
            state.isOpen = false;
            state.currentOptions = undefined;
          }
        });

        // Call onClose callback AFTER state update completes
        if (onCloseCallback) {
          queueMicrotask(() => {
            try {
              onCloseCallback();
            } catch (error) {
              console.error('Modal onClose callback threw error:', error);
            }
          });
        }
      },

      // Get z-index for current modal level
      getZIndex: () => {
        const { stack } = get();
        return BASE_Z_INDEX + (stack.length - 1) * Z_INDEX_INCREMENT;
      },

      // Check if specific modal type is open
      isModalOpen: <T extends ModalType>(type: T) => {
        return get().modal.type === type;
      },
    })),
    { name: 'modal-store' }
  )
);

// =============================================================================
// Type Guards & Utilities
// =============================================================================

/**
 * Type guard to check if modal is of a specific type.
 * Enables type narrowing in conditional blocks.
 *
 * @example
 * ```typescript
 * const modal = useModalStore(state => state.modal);
 * if (isModalType(modal, 'export')) {
 *   console.log(modal.preset); // TypeScript knows preset exists
 * }
 * ```
 */
export function isModalType<T extends ModalType>(
  modal: ModalState,
  type: T
): modal is Extract<ModalState, { type: T }> {
  return modal.type === type;
}

/**
 * Get modal payload if it matches the expected type.
 * Returns null if modal type doesn't match.
 *
 * @example
 * ```typescript
 * const payload = getModalPayload(modal, 'export');
 * if (payload) {
 *   console.log(payload.preset);
 * }
 * ```
 */
export function getModalPayload<T extends ModalType>(
  modal: ModalState,
  type: T
): Extract<ModalState, { type: T }> | null {
  if (modal.type === type) {
    return modal as Extract<ModalState, { type: T }>;
  }
  return null;
}

/**
 * Render modal content based on type.
 * Uses exhaustive switch pattern for type safety.
 */
export function getModalInfo(modal: ModalState): { title: string; blocking: boolean } {
  switch (modal.type) {
    case 'none':
      return { title: '', blocking: false };
    case 'export':
      return { title: 'Export Video', blocking: true };
    case 'settings':
      return { title: 'Settings', blocking: false };
    case 'project-settings':
      return { title: 'Project Settings', blocking: false };
    case 'keyboard-shortcuts':
      return { title: 'Keyboard Shortcuts', blocking: false };
    case 'asset-import':
      return { title: 'Import Assets', blocking: true };
    case 'confirm-delete':
      return { title: `Delete ${modal.itemType}`, blocking: true };
    case 'render-queue':
      return { title: 'Render Queue', blocking: false };
    case 'ai-prompt':
      return { title: 'AI Assistant', blocking: false };
    case 'about':
      return { title: 'About OpenReelio', blocking: false };
    case 'new-project':
      return { title: 'New Project', blocking: true };
    case 'error':
      return { title: modal.title ?? 'Error', blocking: modal.severity === 'critical' };
    default: {
      // Exhaustive check - TypeScript will error if case is missing
      const _exhaustive: never = modal;
      return _exhaustive;
    }
  }
}

// =============================================================================
// Convenience Hooks
// =============================================================================

/**
 * Hook to open a specific modal type.
 * Returns a function that opens the modal with the given payload.
 */
export function useOpenModal() {
  const openModal = useModalStore((state) => state.openModal);
  return openModal;
}

/**
 * Hook to close the current modal.
 */
export function useCloseModal() {
  const closeModal = useModalStore((state) => state.closeModal);
  return closeModal;
}

/**
 * Hook to check if any modal is open.
 */
export function useIsModalOpen() {
  return useModalStore((state) => state.isOpen);
}

/**
 * Hook to get current modal with type checking.
 */
export function useCurrentModal<T extends ModalType>(type: T) {
  return useModalStore((state) => {
    if (state.modal.type === type) {
      return state.modal as Extract<ModalState, { type: T }>;
    }
    return null;
  });
}

export default useModalStore;
