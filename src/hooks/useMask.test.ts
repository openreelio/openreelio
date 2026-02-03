/**
 * useMask Hook Tests
 *
 * Tests for mask (Power Windows) CRUD operations.
 * Follows TDD approach - tests written first.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useMask, createRectangleMask, createEllipseMask, createPolygonMask, createBezierMask } from './useMask';
import { invoke } from '@tauri-apps/api/core';

// =============================================================================
// Mocks
// =============================================================================

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('@/stores/projectStore', () => ({
  useProjectStore: vi.fn((selector) => {
    const mockState = {
      activeSequenceId: 'seq_001',
    };
    return selector ? selector(mockState) : mockState;
  }),
}));

const mockInvoke = invoke as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

// =============================================================================
// Shape Factory Tests
// =============================================================================

describe('Mask Shape Factories', () => {
  describe('createRectangleMask', () => {
    it('creates rectangle mask with default values', () => {
      const shape = createRectangleMask();

      expect(shape.type).toBe('rectangle');
      expect(shape.x).toBe(0.5);
      expect(shape.y).toBe(0.5);
      expect(shape.width).toBe(0.5);
      expect(shape.height).toBe(0.5);
      expect(shape.cornerRadius).toBe(0);
      expect(shape.rotation).toBe(0);
    });

    it('creates rectangle mask with custom values', () => {
      const shape = createRectangleMask(0.3, 0.4, 0.6, 0.8);

      expect(shape.type).toBe('rectangle');
      expect(shape.x).toBe(0.3);
      expect(shape.y).toBe(0.4);
      expect(shape.width).toBe(0.6);
      expect(shape.height).toBe(0.8);
    });
  });

  describe('createEllipseMask', () => {
    it('creates ellipse mask with default values', () => {
      const shape = createEllipseMask();

      expect(shape.type).toBe('ellipse');
      expect(shape.x).toBe(0.5);
      expect(shape.y).toBe(0.5);
      expect(shape.radiusX).toBe(0.25);
      expect(shape.radiusY).toBe(0.25);
      expect(shape.rotation).toBe(0);
    });

    it('creates ellipse mask with custom values', () => {
      const shape = createEllipseMask(0.2, 0.8, 0.3, 0.4);

      expect(shape.type).toBe('ellipse');
      expect(shape.x).toBe(0.2);
      expect(shape.y).toBe(0.8);
      expect(shape.radiusX).toBe(0.3);
      expect(shape.radiusY).toBe(0.4);
    });
  });

  describe('createPolygonMask', () => {
    it('creates polygon mask with provided points', () => {
      const points = [
        { x: 0.2, y: 0.2 },
        { x: 0.8, y: 0.2 },
        { x: 0.5, y: 0.8 },
      ];
      const shape = createPolygonMask(points);

      expect(shape.type).toBe('polygon');
      expect(shape.points).toEqual(points);
    });

    it('creates polygon mask with default triangle if no points provided', () => {
      const shape = createPolygonMask();

      expect(shape.type).toBe('polygon');
      expect(shape.points).toHaveLength(3);
    });
  });

  describe('createBezierMask', () => {
    it('creates bezier mask with provided points', () => {
      const points = [
        { anchor: { x: 0.2, y: 0.2 }, handleOut: { x: 0.3, y: 0.1 } },
        { anchor: { x: 0.8, y: 0.8 }, handleIn: { x: 0.7, y: 0.9 } },
      ];
      const shape = createBezierMask(points, false);

      expect(shape.type).toBe('bezier');
      if (shape.type === 'bezier') {
        expect(shape.points).toEqual(points);
        expect(shape.closed).toBe(false);
      }
    });

    it('creates bezier mask with default curve if no points provided', () => {
      const shape = createBezierMask();

      expect(shape.type).toBe('bezier');
      if (shape.type === 'bezier') {
        expect(shape.points).toHaveLength(2);
        expect(shape.closed).toBe(true);
      }
    });

    it('creates open bezier path when closed is false', () => {
      const shape = createBezierMask(undefined, false);

      expect(shape.type).toBe('bezier');
      if (shape.type === 'bezier') {
        expect(shape.closed).toBe(false);
      }
    });
  });
});

// =============================================================================
// useMask Hook Tests
// =============================================================================

describe('useMask', () => {
  describe('addMask', () => {
    it('calls invoke with AddMask command', async () => {
      mockInvoke.mockResolvedValue({ opId: 'op_001', createdIds: ['mask_001'] });

      const { result } = renderHook(() => useMask());

      const shape = createRectangleMask();

      await act(async () => {
        await result.current.addMask({
          sequenceId: 'seq_001',
          trackId: 'track_001',
          clipId: 'clip_001',
          effectId: 'effect_001',
          shape,
        });
      });

      expect(mockInvoke).toHaveBeenCalledWith('execute_command', {
        commandType: 'AddMask',
        payload: expect.objectContaining({
          sequenceId: 'seq_001',
          trackId: 'track_001',
          clipId: 'clip_001',
          effectId: 'effect_001',
          shape,
        }),
      });
    });

    it('returns created mask ID on success', async () => {
      mockInvoke.mockResolvedValue({ opId: 'op_001', createdIds: ['mask_new'] });

      const { result } = renderHook(() => useMask());

      let maskId: string | null = null;
      await act(async () => {
        maskId = await result.current.addMask({
          sequenceId: 'seq_001',
          trackId: 'track_001',
          clipId: 'clip_001',
          effectId: 'effect_001',
          shape: createRectangleMask(),
        });
      });

      expect(maskId).toBe('mask_new');
    });

    it('returns null on failure', async () => {
      mockInvoke.mockRejectedValue(new Error('Add mask failed'));

      const { result } = renderHook(() => useMask());

      let maskId: string | null = 'initial';
      await act(async () => {
        maskId = await result.current.addMask({
          sequenceId: 'seq_001',
          trackId: 'track_001',
          clipId: 'clip_001',
          effectId: 'effect_001',
          shape: createRectangleMask(),
        });
      });

      expect(maskId).toBeNull();
    });

    it('sets isAdding state while adding', async () => {
      let resolvePromise: (value: unknown) => void;
      const promise = new Promise((resolve) => {
        resolvePromise = resolve;
      });
      mockInvoke.mockReturnValue(promise);

      const { result } = renderHook(() => useMask());

      act(() => {
        result.current.addMask({
          sequenceId: 'seq_001',
          trackId: 'track_001',
          clipId: 'clip_001',
          effectId: 'effect_001',
          shape: createRectangleMask(),
        });
      });

      expect(result.current.isAdding).toBe(true);

      await act(async () => {
        resolvePromise!({ opId: 'op_001', createdIds: ['mask_001'] });
        await promise;
      });

      expect(result.current.isAdding).toBe(false);
    });

    it('includes optional parameters when provided', async () => {
      mockInvoke.mockResolvedValue({ opId: 'op_001', createdIds: ['mask_001'] });

      const { result } = renderHook(() => useMask());

      await act(async () => {
        await result.current.addMask({
          sequenceId: 'seq_001',
          trackId: 'track_001',
          clipId: 'clip_001',
          effectId: 'effect_001',
          shape: createRectangleMask(),
          name: 'My Mask',
          feather: 0.5,
          inverted: true,
        });
      });

      expect(mockInvoke).toHaveBeenCalledWith('execute_command', {
        commandType: 'AddMask',
        payload: expect.objectContaining({
          name: 'My Mask',
          feather: 0.5,
          inverted: true,
        }),
      });
    });
  });

  describe('updateMask', () => {
    it('calls invoke with UpdateMask command', async () => {
      mockInvoke.mockResolvedValue({ opId: 'op_002' });

      const { result } = renderHook(() => useMask());

      await act(async () => {
        await result.current.updateMask({
          effectId: 'effect_001',
          maskId: 'mask_001',
          feather: 0.3,
          opacity: 0.8,
        });
      });

      expect(mockInvoke).toHaveBeenCalledWith('execute_command', {
        commandType: 'UpdateMask',
        payload: expect.objectContaining({
          effectId: 'effect_001',
          maskId: 'mask_001',
          feather: 0.3,
          opacity: 0.8,
        }),
      });
    });

    it('returns true on success', async () => {
      mockInvoke.mockResolvedValue({ opId: 'op_002' });

      const { result } = renderHook(() => useMask());

      let success = false;
      await act(async () => {
        success = await result.current.updateMask({
          effectId: 'effect_001',
          maskId: 'mask_001',
          feather: 0.3,
        });
      });

      expect(success).toBe(true);
    });

    it('returns false on failure', async () => {
      mockInvoke.mockRejectedValue(new Error('Update failed'));

      const { result } = renderHook(() => useMask());

      let success = true;
      await act(async () => {
        success = await result.current.updateMask({
          effectId: 'effect_001',
          maskId: 'mask_001',
          feather: 0.3,
        });
      });

      expect(success).toBe(false);
    });

    it('sets isUpdating state while updating', async () => {
      let resolvePromise: (value: unknown) => void;
      const promise = new Promise((resolve) => {
        resolvePromise = resolve;
      });
      mockInvoke.mockReturnValue(promise);

      const { result } = renderHook(() => useMask());

      act(() => {
        result.current.updateMask({
          effectId: 'effect_001',
          maskId: 'mask_001',
          feather: 0.3,
        });
      });

      expect(result.current.isUpdating).toBe(true);

      await act(async () => {
        resolvePromise!({ opId: 'op_002' });
        await promise;
      });

      expect(result.current.isUpdating).toBe(false);
    });

    it('updates shape when provided', async () => {
      mockInvoke.mockResolvedValue({ opId: 'op_002' });

      const { result } = renderHook(() => useMask());

      const newShape = createEllipseMask(0.6, 0.6, 0.4, 0.3);

      await act(async () => {
        await result.current.updateMask({
          effectId: 'effect_001',
          maskId: 'mask_001',
          shape: newShape,
        });
      });

      expect(mockInvoke).toHaveBeenCalledWith('execute_command', {
        commandType: 'UpdateMask',
        payload: expect.objectContaining({
          shape: newShape,
        }),
      });
    });

    it('updates blend mode when provided', async () => {
      mockInvoke.mockResolvedValue({ opId: 'op_002' });

      const { result } = renderHook(() => useMask());

      await act(async () => {
        await result.current.updateMask({
          effectId: 'effect_001',
          maskId: 'mask_001',
          blendMode: 'subtract',
        });
      });

      expect(mockInvoke).toHaveBeenCalledWith('execute_command', {
        commandType: 'UpdateMask',
        payload: expect.objectContaining({
          blendMode: 'subtract',
        }),
      });
    });
  });

  describe('removeMask', () => {
    it('calls invoke with RemoveMask command', async () => {
      mockInvoke.mockResolvedValue({ opId: 'op_003' });

      const { result } = renderHook(() => useMask());

      await act(async () => {
        await result.current.removeMask({
          effectId: 'effect_001',
          maskId: 'mask_001',
        });
      });

      expect(mockInvoke).toHaveBeenCalledWith('execute_command', {
        commandType: 'RemoveMask',
        payload: {
          effectId: 'effect_001',
          maskId: 'mask_001',
        },
      });
    });

    it('returns true on success', async () => {
      mockInvoke.mockResolvedValue({ opId: 'op_003' });

      const { result } = renderHook(() => useMask());

      let success = false;
      await act(async () => {
        success = await result.current.removeMask({
          effectId: 'effect_001',
          maskId: 'mask_001',
        });
      });

      expect(success).toBe(true);
    });

    it('returns false on failure', async () => {
      mockInvoke.mockRejectedValue(new Error('Remove failed'));

      const { result } = renderHook(() => useMask());

      let success = true;
      await act(async () => {
        success = await result.current.removeMask({
          effectId: 'effect_001',
          maskId: 'mask_001',
        });
      });

      expect(success).toBe(false);
    });

    it('sets isRemoving state while removing', async () => {
      let resolvePromise: (value: unknown) => void;
      const promise = new Promise((resolve) => {
        resolvePromise = resolve;
      });
      mockInvoke.mockReturnValue(promise);

      const { result } = renderHook(() => useMask());

      act(() => {
        result.current.removeMask({
          effectId: 'effect_001',
          maskId: 'mask_001',
        });
      });

      expect(result.current.isRemoving).toBe(true);

      await act(async () => {
        resolvePromise!({ opId: 'op_003' });
        await promise;
      });

      expect(result.current.isRemoving).toBe(false);
    });
  });

  describe('error handling', () => {
    it('sets error on addMask failure', async () => {
      mockInvoke.mockRejectedValue(new Error('Add mask failed'));

      const { result } = renderHook(() => useMask());

      await act(async () => {
        await result.current.addMask({
          sequenceId: 'seq_001',
          trackId: 'track_001',
          clipId: 'clip_001',
          effectId: 'effect_001',
          shape: createRectangleMask(),
        });
      });

      expect(result.current.error).toBe('Add mask failed');
    });

    it('sets error on updateMask failure', async () => {
      mockInvoke.mockRejectedValue(new Error('Update mask failed'));

      const { result } = renderHook(() => useMask());

      await act(async () => {
        await result.current.updateMask({
          effectId: 'effect_001',
          maskId: 'mask_001',
          feather: 0.5,
        });
      });

      expect(result.current.error).toBe('Update mask failed');
    });

    it('sets error on removeMask failure', async () => {
      mockInvoke.mockRejectedValue(new Error('Remove mask failed'));

      const { result } = renderHook(() => useMask());

      await act(async () => {
        await result.current.removeMask({
          effectId: 'effect_001',
          maskId: 'mask_001',
        });
      });

      expect(result.current.error).toBe('Remove mask failed');
    });

    it('clears error with clearError', async () => {
      mockInvoke.mockRejectedValue(new Error('Some error'));

      const { result } = renderHook(() => useMask());

      await act(async () => {
        await result.current.addMask({
          sequenceId: 'seq_001',
          trackId: 'track_001',
          clipId: 'clip_001',
          effectId: 'effect_001',
          shape: createRectangleMask(),
        });
      });

      expect(result.current.error).toBe('Some error');

      act(() => {
        result.current.clearError();
      });

      expect(result.current.error).toBeNull();
    });

    it('clears error on successful operation', async () => {
      mockInvoke
        .mockRejectedValueOnce(new Error('First error'))
        .mockResolvedValueOnce({ opId: 'op_001', createdIds: ['mask_001'] });

      const { result } = renderHook(() => useMask());

      // First call fails
      await act(async () => {
        await result.current.addMask({
          sequenceId: 'seq_001',
          trackId: 'track_001',
          clipId: 'clip_001',
          effectId: 'effect_001',
          shape: createRectangleMask(),
        });
      });

      expect(result.current.error).toBe('First error');

      // Second call succeeds
      await act(async () => {
        await result.current.addMask({
          sequenceId: 'seq_001',
          trackId: 'track_001',
          clipId: 'clip_001',
          effectId: 'effect_001',
          shape: createRectangleMask(),
        });
      });

      expect(result.current.error).toBeNull();
    });
  });
});
