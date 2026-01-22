/**
 * useToast Hook Tests
 *
 * Focuses on state correctness and destructive scenarios (burst traffic, caps, undo payload).
 */

import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, beforeEach } from 'vitest';
import { useToast, useToastStore } from './useToast';

describe('useToast', () => {
  beforeEach(() => {
    useToastStore.getState().clearToasts();
  });

  it('starts with an empty list', () => {
    const { result } = renderHook(() => useToast());
    expect(result.current.toasts).toEqual([]);
  });

  it('adds an info toast from a string', () => {
    const { result } = renderHook(() => useToast());

    act(() => {
      result.current.toast('Hello');
    });

    expect(result.current.toasts).toHaveLength(1);
    expect(result.current.toasts[0].message).toBe('Hello');
    expect(result.current.toasts[0].variant).toBe('info');
    expect(typeof result.current.toasts[0].createdAt).toBe('number');
  });

  it('adds a toast from options (including undo)', () => {
    const { result } = renderHook(() => useToast());
    const undoAction = () => undefined;

    act(() => {
      result.current.toast({
        message: 'Clip deleted',
        variant: 'success',
        duration: 5000,
        undoAction,
        undoLabel: 'Undo',
      });
    });

    expect(result.current.toasts).toHaveLength(1);
    expect(result.current.toasts[0].variant).toBe('success');
    expect(result.current.toasts[0].duration).toBe(5000);
    expect(result.current.toasts[0].undoAction).toBe(undoAction);
    expect(result.current.toasts[0].undoLabel).toBe('Undo');
  });

  it('creates persistent error toasts by default (duration=0)', () => {
    const { result } = renderHook(() => useToast());

    act(() => {
      result.current.showError('Something broke');
    });

    expect(result.current.toasts[0].variant).toBe('error');
    expect(result.current.toasts[0].duration).toBe(0);
  });

  it('caps toast list to prevent flooding', () => {
    const { result } = renderHook(() => useToast());

    act(() => {
      for (let i = 0; i < 100; i++) {
        result.current.showInfo(`Info ${i}`);
      }
    });

    expect(result.current.toasts).toHaveLength(5);
    expect(result.current.toasts[4].message).toBe('Info 99');
  });

  it('dismisses a specific toast by id', () => {
    const { result } = renderHook(() => useToast());
    let id = '';

    act(() => {
      id = result.current.toast('Dismiss me');
    });

    expect(result.current.toasts).toHaveLength(1);

    act(() => {
      result.current.dismissToast(id);
    });

    expect(result.current.toasts).toHaveLength(0);
  });

  it('shares a single store across hook instances', () => {
    const { result: a } = renderHook(() => useToast());
    const { result: b } = renderHook(() => useToast());

    act(() => {
      a.current.showSuccess('From A');
    });

    expect(a.current.toasts).toHaveLength(1);
    expect(b.current.toasts).toHaveLength(1);
    expect(b.current.toasts[0].message).toBe('From A');

    act(() => {
      b.current.clearAll();
    });

    expect(a.current.toasts).toHaveLength(0);
    expect(b.current.toasts).toHaveLength(0);
  });
});

describe('useToastStore', () => {
  beforeEach(() => {
    useToastStore.getState().clearToasts();
  });

  it('adds and removes toasts', () => {
    const id = useToastStore.getState().addToast({ message: 'X', variant: 'info' });
    expect(useToastStore.getState().toasts).toHaveLength(1);

    useToastStore.getState().removeToast(id);
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });
});

