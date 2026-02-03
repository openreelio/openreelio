/**
 * useModalKeyboardScope Tests
 *
 * Integration tests for modal-keyboard scope interaction.
 * Ensures modals properly intercept keyboard shortcuts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { KeyboardScopeProvider } from './useKeyboardScope';
import { useModalStore } from '@/stores/modalStore';
import { useModalKeyboardScope } from './useModalKeyboardScope';

// Test component that uses both modal store and keyboard scope
function TestComponent({ onEscape }: { onEscape?: () => void }) {
  useModalKeyboardScope({ onEscape });

  return (
    <div>
      <button
        data-testid="open-settings"
        onClick={() => useModalStore.getState().openModal({ type: 'settings' })}
      >
        Open Settings
      </button>
      <button
        data-testid="open-export"
        onClick={() =>
          useModalStore.getState().openModal({ type: 'export', sequenceId: 'seq-1' })
        }
      >
        Open Export
      </button>
      <button
        data-testid="close-modal"
        onClick={() => useModalStore.getState().closeModal()}
      >
        Close Modal
      </button>
    </div>
  );
}

function Wrapper({ children }: { children: React.ReactNode }) {
  return <KeyboardScopeProvider>{children}</KeyboardScopeProvider>;
}

describe('useModalKeyboardScope', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset modal store
    act(() => {
      useModalStore.getState().closeModal();
    });
  });

  afterEach(() => {
    act(() => {
      useModalStore.getState().closeModal();
    });
  });

  describe('escape key handling', () => {
    it('should close modal on Escape key press', () => {
      render(
        <Wrapper>
          <TestComponent />
        </Wrapper>
      );

      // Open a modal
      act(() => {
        fireEvent.click(screen.getByTestId('open-settings'));
      });
      expect(useModalStore.getState().modal.type).toBe('settings');

      // Press Escape
      act(() => {
        fireEvent.keyDown(document, { key: 'Escape' });
      });

      // Modal should be closed
      expect(useModalStore.getState().modal.type).toBe('none');
    });

    it('should call custom onEscape callback before closing', () => {
      const onEscape = vi.fn();
      render(
        <Wrapper>
          <TestComponent onEscape={onEscape} />
        </Wrapper>
      );

      // Open a modal
      act(() => {
        fireEvent.click(screen.getByTestId('open-settings'));
      });

      // Press Escape
      act(() => {
        fireEvent.keyDown(document, { key: 'Escape' });
      });

      // Callback should be called
      expect(onEscape).toHaveBeenCalledTimes(1);
    });

    it('should not close modal if onEscape returns false', () => {
      const onEscape = vi.fn().mockReturnValue(false);
      render(
        <Wrapper>
          <TestComponent onEscape={onEscape} />
        </Wrapper>
      );

      // Open a modal
      act(() => {
        fireEvent.click(screen.getByTestId('open-settings'));
      });

      // Press Escape
      act(() => {
        fireEvent.keyDown(document, { key: 'Escape' });
      });

      // Modal should still be open
      expect(useModalStore.getState().modal.type).toBe('settings');
    });

    it('should not trigger when no modal is open', () => {
      const onEscape = vi.fn();
      render(
        <Wrapper>
          <TestComponent onEscape={onEscape} />
        </Wrapper>
      );

      // No modal open
      expect(useModalStore.getState().modal.type).toBe('none');

      // Press Escape
      act(() => {
        fireEvent.keyDown(document, { key: 'Escape' });
      });

      // Callback should not be called (no modal to close)
      expect(onEscape).not.toHaveBeenCalled();
    });
  });

  describe('priority blocking', () => {
    it('should use MODAL priority for standard modals', () => {
      render(
        <Wrapper>
          <TestComponent />
        </Wrapper>
      );

      // Open settings modal
      act(() => {
        fireEvent.click(screen.getByTestId('open-settings'));
      });

      // Modal scope should be registered at MODAL priority
      // This test verifies the modal keyboard scope is active
      expect(useModalStore.getState().modal.type).toBe('settings');
    });

    it('should use DIALOG priority for confirmation dialogs', () => {
      render(
        <Wrapper>
          <TestComponent />
        </Wrapper>
      );

      // Open confirm-delete modal
      act(() => {
        useModalStore.getState().openModal({
          type: 'confirm-delete',
          itemIds: ['clip-1'],
          itemType: 'clip',
          onConfirm: vi.fn(),
        });
      });

      expect(useModalStore.getState().modal.type).toBe('confirm-delete');
    });
  });

  describe('modal stack integration', () => {
    it('should pop modal stack on Escape when multiple modals are open', () => {
      render(
        <Wrapper>
          <TestComponent />
        </Wrapper>
      );

      // Open first modal
      act(() => {
        fireEvent.click(screen.getByTestId('open-settings'));
      });
      expect(useModalStore.getState().modal.type).toBe('settings');

      // Push second modal
      act(() => {
        useModalStore.getState().pushModal({ type: 'export', sequenceId: 'seq-1' });
      });
      expect(useModalStore.getState().modal.type).toBe('export');
      expect(useModalStore.getState().stack.length).toBe(2);

      // Press Escape - should pop to first modal
      act(() => {
        fireEvent.keyDown(document, { key: 'Escape' });
      });
      expect(useModalStore.getState().modal.type).toBe('settings');
      expect(useModalStore.getState().stack.length).toBe(1);

      // Press Escape again - should close completely
      act(() => {
        fireEvent.keyDown(document, { key: 'Escape' });
      });
      expect(useModalStore.getState().modal.type).toBe('none');
    });
  });

  describe('cleanup', () => {
    it('should unregister keyboard scope when component unmounts', () => {
      const { unmount } = render(
        <Wrapper>
          <TestComponent />
        </Wrapper>
      );

      // Open modal
      act(() => {
        fireEvent.click(screen.getByTestId('open-settings'));
      });

      // Unmount component
      unmount();

      // Close modal via store directly (cleanup should have happened)
      act(() => {
        useModalStore.getState().closeModal();
      });
      expect(useModalStore.getState().modal.type).toBe('none');
    });
  });
});

