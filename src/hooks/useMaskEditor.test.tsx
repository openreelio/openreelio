/**
 * useMaskEditor Hook Tests
 *
 * Covers mask editor behavior that depends on IPC payload shape validation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useMaskEditor } from './useMaskEditor';

const mockInvoke = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

const DEFAULT_OPTIONS = {
  clipId: 'clip-001',
  effectId: 'effect-001',
  sequenceId: 'seq-001',
  trackId: 'track-001',
} as const;

function createGradientMask(id = 'mask-gradient-001') {
  return {
    id,
    name: 'Gradient Mask',
    shape: {
      type: 'gradient' as const,
      start: { x: 0.2, y: 0.5 },
      end: { x: 0.8, y: 0.5 },
      gradientType: 'linear' as const,
    },
    inverted: false,
    feather: 0,
    opacity: 1,
    expansion: 0,
    blendMode: 'add' as const,
    enabled: true,
    locked: false,
  };
}

describe('useMaskEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should preserve fetched gradient masks from the backend', async () => {
    mockInvoke.mockResolvedValueOnce([createGradientMask()]);

    const { result } = renderHook(() =>
      useMaskEditor({
        ...DEFAULT_OPTIONS,
        fetchOnMount: true,
      })
    );

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
      expect(result.current.masks).toHaveLength(1);
    });

    expect(result.current.masks[0]?.shape.type).toBe('gradient');
    expect(mockInvoke).toHaveBeenCalledWith('get_effect_masks', {
      effectId: DEFAULT_OPTIONS.effectId,
    });
  });

  it('should create gradient masks through the shared editor hook', async () => {
    mockInvoke.mockResolvedValueOnce({ createdIds: ['mask-gradient-002'] });

    const { result } = renderHook(() => useMaskEditor(DEFAULT_OPTIONS));

    await act(async () => {
      await result.current.addMask('gradient');
    });

    expect(mockInvoke).toHaveBeenCalledWith('execute_command', {
      commandType: 'AddMask',
      payload: expect.objectContaining({
        effectId: DEFAULT_OPTIONS.effectId,
        shape: expect.objectContaining({
          type: 'gradient',
          gradientType: 'linear',
        }),
      }),
    });
    expect(result.current.masks[0]?.shape.type).toBe('gradient');
  });

  it('should preserve a fully drawn shape when creating a mask', async () => {
    mockInvoke.mockResolvedValueOnce({ createdIds: ['mask-drawn-001'] });

    const drawnShape = {
      type: 'rectangle' as const,
      x: 0.25,
      y: 0.35,
      width: 0.4,
      height: 0.2,
      cornerRadius: 0,
      rotation: 0,
    };

    const { result } = renderHook(() => useMaskEditor(DEFAULT_OPTIONS));

    await act(async () => {
      await result.current.addMask(drawnShape, 'Drawn Mask');
    });

    expect(mockInvoke).toHaveBeenCalledWith('execute_command', {
      commandType: 'AddMask',
      payload: expect.objectContaining({
        effectId: DEFAULT_OPTIONS.effectId,
        name: 'Drawn Mask',
        shape: drawnShape,
      }),
    });
    expect(result.current.masks[0]?.shape).toEqual(drawnShape);
  });

  it('should forward gradient shape updates to the backend', async () => {
    mockInvoke.mockResolvedValueOnce({ opId: 'op-001', changes: [] });

    const { result } = renderHook(() =>
      useMaskEditor({
        ...DEFAULT_OPTIONS,
        initialMasks: [createGradientMask('mask-gradient-003')],
      })
    );

    const updatedShape = {
      type: 'gradient' as const,
      start: { x: 0.3, y: 0.4 },
      end: { x: 0.9, y: 0.6 },
      gradientType: 'radial' as const,
    };

    await act(async () => {
      await result.current.updateMask('mask-gradient-003', { shape: updatedShape });
    });

    expect(mockInvoke).toHaveBeenCalledWith('execute_command', {
      commandType: 'UpdateMask',
      payload: {
        effectId: DEFAULT_OPTIONS.effectId,
        maskId: 'mask-gradient-003',
        shape: updatedShape,
      },
    });
    expect(result.current.masks[0]?.shape).toEqual(updatedShape);
  });
});
