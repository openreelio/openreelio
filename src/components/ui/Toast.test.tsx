/**
 * Toast UI Tests
 *
 * Verifies auto-dismiss timing behavior including hover pause and persistent errors.
 */

import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ToastContainer, type ToastData } from './Toast';

function renderSingleToast(toast: ToastData, onClose: (id: string) => void): void {
  render(<ToastContainer toasts={[toast]} onClose={onClose} />);
}

describe('Toast', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('auto-dismisses after duration', () => {
    const onClose = vi.fn();
    const toast: ToastData = {
      id: 't1',
      message: 'Hello',
      variant: 'info',
      duration: 1000,
      createdAt: Date.now(),
    };

    renderSingleToast(toast, onClose);

    // Not yet closed.
    act(() => vi.advanceTimersByTime(900));
    expect(onClose).not.toHaveBeenCalled();

    // Close triggers after countdown + exit animation (200ms).
    act(() => vi.advanceTimersByTime(400));
    expect(onClose).toHaveBeenCalledWith('t1');
  });

  it('pauses countdown while hovered', () => {
    const onClose = vi.fn();
    const toast: ToastData = {
      id: 't2',
      message: 'Hover me',
      variant: 'success',
      duration: 1000,
      createdAt: Date.now(),
    };

    renderSingleToast(toast, onClose);

    // Advance halfway.
    act(() => vi.advanceTimersByTime(500));

    const toastEl = screen.getByTestId('toast-t2');
    fireEvent.mouseEnter(toastEl);

    // While hovered, time should not advance the countdown to completion.
    act(() => vi.advanceTimersByTime(3000));
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.mouseLeave(toastEl);

    // Resume and finish (remaining ~500ms + exit animation).
    act(() => vi.advanceTimersByTime(900));
    expect(onClose).toHaveBeenCalledWith('t2');
  });

  it('does not auto-dismiss when duration is 0', () => {
    const onClose = vi.fn();
    const toast: ToastData = {
      id: 't3',
      message: 'Persistent',
      variant: 'error',
      duration: 0,
      createdAt: Date.now(),
    };

    renderSingleToast(toast, onClose);

    act(() => vi.advanceTimersByTime(60_000));
    expect(onClose).not.toHaveBeenCalled();
  });
});
