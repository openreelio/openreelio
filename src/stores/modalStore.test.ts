/**
 * Modal Store Tests
 *
 * Tests for the discriminated union-based modal state management system.
 * Following TDD methodology - tests written first.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  useModalStore,
  type ModalState,
  isModalType,
  getModalPayload,
} from './modalStore';

describe('modalStore', () => {
  beforeEach(() => {
    // Reset store state before each test
    act(() => {
      useModalStore.getState().closeAll();
    });
  });

  // ===========================================================================
  // Basic Modal Operations
  // ===========================================================================

  describe('basic operations', () => {
    it('should start with no modal open', () => {
      const { result } = renderHook(() => useModalStore());
      expect(result.current.modal.type).toBe('none');
      expect(result.current.isOpen).toBe(false);
    });

    it('should open a modal with correct type', () => {
      const { result } = renderHook(() => useModalStore());

      act(() => {
        result.current.openModal({ type: 'export', preset: 'youtube-1080p' });
      });

      expect(result.current.modal.type).toBe('export');
      expect(result.current.isOpen).toBe(true);
    });

    it('should close modal and return to none state', () => {
      const { result } = renderHook(() => useModalStore());

      act(() => {
        result.current.openModal({ type: 'export' });
      });
      expect(result.current.isOpen).toBe(true);

      act(() => {
        result.current.closeModal();
      });
      expect(result.current.modal.type).toBe('none');
      expect(result.current.isOpen).toBe(false);
    });

    it('should replace current modal when opening another', () => {
      const { result } = renderHook(() => useModalStore());

      act(() => {
        result.current.openModal({ type: 'export' });
      });
      expect(result.current.modal.type).toBe('export');

      act(() => {
        result.current.openModal({ type: 'settings', tab: 'general' });
      });
      expect(result.current.modal.type).toBe('settings');
    });
  });

  // ===========================================================================
  // Modal Type Checking
  // ===========================================================================

  describe('type checking', () => {
    it('should correctly identify modal type with isModalType', () => {
      const { result } = renderHook(() => useModalStore());

      act(() => {
        result.current.openModal({ type: 'export', preset: 'prores' });
      });

      expect(isModalType(result.current.modal, 'export')).toBe(true);
      expect(isModalType(result.current.modal, 'settings')).toBe(false);
      expect(isModalType(result.current.modal, 'none')).toBe(false);
    });

    it('should return true for none type when no modal is open', () => {
      const { result } = renderHook(() => useModalStore());
      expect(isModalType(result.current.modal, 'none')).toBe(true);
    });
  });

  // ===========================================================================
  // Type-Safe Payload Access
  // ===========================================================================

  describe('payload access', () => {
    it('should access export modal payload correctly', () => {
      const { result } = renderHook(() => useModalStore());

      act(() => {
        result.current.openModal({
          type: 'export',
          preset: 'youtube-4k',
          sequenceId: 'seq-123',
        });
      });

      const modal = result.current.modal;
      if (modal.type === 'export') {
        expect(modal.preset).toBe('youtube-4k');
        expect(modal.sequenceId).toBe('seq-123');
      } else {
        throw new Error('Expected export modal');
      }
    });

    it('should access settings modal payload correctly', () => {
      const { result } = renderHook(() => useModalStore());

      act(() => {
        result.current.openModal({ type: 'settings', tab: 'shortcuts' });
      });

      const modal = result.current.modal;
      if (modal.type === 'settings') {
        expect(modal.tab).toBe('shortcuts');
      } else {
        throw new Error('Expected settings modal');
      }
    });

    it('should access confirm-delete modal payload correctly', () => {
      const { result } = renderHook(() => useModalStore());

      act(() => {
        result.current.openModal({
          type: 'confirm-delete',
          itemIds: ['clip-1', 'clip-2'],
          itemType: 'clip',
          onConfirm: vi.fn(),
        });
      });

      const modal = result.current.modal;
      if (modal.type === 'confirm-delete') {
        expect(modal.itemIds).toEqual(['clip-1', 'clip-2']);
        expect(modal.itemType).toBe('clip');
        expect(typeof modal.onConfirm).toBe('function');
      } else {
        throw new Error('Expected confirm-delete modal');
      }
    });

    it('should use getModalPayload helper safely', () => {
      const { result } = renderHook(() => useModalStore());

      act(() => {
        result.current.openModal({ type: 'export', preset: 'twitter' });
      });

      const payload = getModalPayload(result.current.modal, 'export');
      expect(payload?.preset).toBe('twitter');

      const wrongPayload = getModalPayload(result.current.modal, 'settings');
      expect(wrongPayload).toBeNull();
    });
  });

  // ===========================================================================
  // Modal Stack (Z-Index Management)
  // ===========================================================================

  describe('modal stack', () => {
    it('should push modal to stack', () => {
      const { result } = renderHook(() => useModalStore());

      act(() => {
        result.current.pushModal({ type: 'export' });
      });
      expect(result.current.stack.length).toBe(1);

      act(() => {
        result.current.pushModal({ type: 'confirm-delete', itemIds: ['1'], itemType: 'clip', onConfirm: vi.fn() });
      });
      expect(result.current.stack.length).toBe(2);
      expect(result.current.modal.type).toBe('confirm-delete');
    });

    it('should pop modal from stack and restore previous', () => {
      const { result } = renderHook(() => useModalStore());

      act(() => {
        result.current.pushModal({ type: 'settings', tab: 'general' });
      });
      act(() => {
        result.current.pushModal({ type: 'confirm-delete', itemIds: ['1'], itemType: 'track', onConfirm: vi.fn() });
      });

      expect(result.current.modal.type).toBe('confirm-delete');

      act(() => {
        result.current.popModal();
      });

      expect(result.current.modal.type).toBe('settings');
      expect(result.current.stack.length).toBe(1);
    });

    it('should close all modals with closeAll', () => {
      const { result } = renderHook(() => useModalStore());

      act(() => {
        result.current.pushModal({ type: 'settings', tab: 'general' });
        result.current.pushModal({ type: 'export' });
      });
      expect(result.current.stack.length).toBe(2);

      act(() => {
        result.current.closeAll();
      });

      expect(result.current.stack.length).toBe(0);
      expect(result.current.modal.type).toBe('none');
      expect(result.current.isOpen).toBe(false);
    });

    it('should get correct z-index for modal', () => {
      const { result } = renderHook(() => useModalStore());
      const baseZIndex = 1000;

      act(() => {
        result.current.pushModal({ type: 'settings', tab: 'general' });
      });
      expect(result.current.getZIndex()).toBe(baseZIndex);

      act(() => {
        result.current.pushModal({ type: 'confirm-delete', itemIds: ['1'], itemType: 'clip', onConfirm: vi.fn() });
      });
      expect(result.current.getZIndex()).toBe(baseZIndex + 10);
    });
  });

  // ===========================================================================
  // Modal Callbacks
  // ===========================================================================

  describe('callbacks', () => {
    it('should call onClose callback when closing modal', async () => {
      const { result } = renderHook(() => useModalStore());
      const onClose = vi.fn();

      act(() => {
        result.current.openModal({ type: 'export' }, { onClose });
      });

      act(() => {
        result.current.closeModal();
      });

      // onClose is called via queueMicrotask, so wait for it
      await vi.waitFor(() => {
        expect(onClose).toHaveBeenCalledTimes(1);
      });
    });

    it('should call onConfirm in confirm-delete modal', () => {
      const { result } = renderHook(() => useModalStore());
      const onConfirm = vi.fn();

      act(() => {
        result.current.openModal({
          type: 'confirm-delete',
          itemIds: ['clip-1'],
          itemType: 'clip',
          onConfirm,
        });
      });

      // Simulate confirmation
      const modal = result.current.modal;
      if (modal.type === 'confirm-delete') {
        modal.onConfirm();
      }

      expect(onConfirm).toHaveBeenCalledTimes(1);
    });
  });

  // ===========================================================================
  // All Modal Types
  // ===========================================================================

  describe('all modal types', () => {
    const modalCases: Array<{ name: string; modal: ModalState }> = [
      { name: 'none', modal: { type: 'none' } },
      { name: 'export', modal: { type: 'export', preset: 'youtube-1080p' } },
      { name: 'settings', modal: { type: 'settings', tab: 'general' } },
      { name: 'project-settings', modal: { type: 'project-settings' } },
      { name: 'keyboard-shortcuts', modal: { type: 'keyboard-shortcuts' } },
      { name: 'asset-import', modal: { type: 'asset-import', files: [] } },
      {
        name: 'confirm-delete',
        modal: {
          type: 'confirm-delete',
          itemIds: ['1'],
          itemType: 'clip',
          onConfirm: vi.fn(),
        },
      },
      { name: 'render-queue', modal: { type: 'render-queue' } },
      { name: 'ai-prompt', modal: { type: 'ai-prompt', context: 'test' } },
      { name: 'about', modal: { type: 'about' } },
      { name: 'new-project', modal: { type: 'new-project' } },
      {
        name: 'error',
        modal: {
          type: 'error',
          error: new Error('Test'),
          severity: 'error',
        },
      },
    ];

    it.each(modalCases)('should handle $name modal correctly', ({ modal }) => {
      const { result } = renderHook(() => useModalStore());

      if (modal.type === 'none') {
        expect(result.current.modal.type).toBe('none');
        return;
      }

      act(() => {
        result.current.openModal(modal as Exclude<ModalState, { type: 'none' }>);
      });

      expect(result.current.modal.type).toBe(modal.type);
      expect(result.current.isOpen).toBe(true);
    });
  });

  // ===========================================================================
  // Exhaustive Switch Pattern
  // ===========================================================================

  describe('exhaustive switch pattern', () => {
    it('should support exhaustive switch on modal type', () => {
      const { result } = renderHook(() => useModalStore());

      act(() => {
        result.current.openModal({ type: 'settings', tab: 'general' });
      });

      const modal = result.current.modal;

      // This function demonstrates exhaustive type checking
      const getModalTitle = (m: ModalState): string => {
        switch (m.type) {
          case 'none':
            return '';
          case 'export':
            return 'Export Video';
          case 'settings':
            return `Settings - ${m.tab}`;
          case 'project-settings':
            return 'Project Settings';
          case 'keyboard-shortcuts':
            return 'Keyboard Shortcuts';
          case 'asset-import':
            return 'Import Assets';
          case 'confirm-delete':
            return `Delete ${m.itemType}`;
          case 'render-queue':
            return 'Render Queue';
          case 'ai-prompt':
            return 'AI Assistant';
          case 'about':
            return 'About';
          case 'new-project':
            return 'New Project';
          case 'error':
            return 'Error';
          default: {
            // TypeScript will error if any case is not handled
            const _exhaustive: never = m;
            return _exhaustive;
          }
        }
      };

      expect(getModalTitle(modal)).toBe('Settings - general');
    });
  });
});
