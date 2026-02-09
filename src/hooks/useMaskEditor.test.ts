/**
 * useMaskEditor Hook Tests
 *
 * TDD: RED phase - Writing tests first
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useMaskEditor } from './useMaskEditor';
import type { Mask, MaskShape } from '@/types';

// =============================================================================
// Mocks
// =============================================================================

const mockInvoke = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

// =============================================================================
// Test Fixtures
// =============================================================================

const createMockMask = (id: string, shape: MaskShape['type'] = 'rectangle'): Mask => ({
  id,
  name: `Mask ${id}`,
  shape:
    shape === 'rectangle'
      ? { type: 'rectangle', x: 0.5, y: 0.5, width: 0.5, height: 0.5, cornerRadius: 0, rotation: 0 }
      : shape === 'ellipse'
        ? { type: 'ellipse', x: 0.5, y: 0.5, radiusX: 0.25, radiusY: 0.25, rotation: 0 }
        : shape === 'polygon'
          ? { type: 'polygon', points: [{ x: 0.3, y: 0.3 }, { x: 0.7, y: 0.3 }, { x: 0.5, y: 0.7 }] }
          : { type: 'bezier', points: [], closed: true },
  inverted: false,
  feather: 0,
  opacity: 1,
  expansion: 0,
  blendMode: 'add',
  enabled: true,
  locked: false,
});

// =============================================================================
// Test Suite
// =============================================================================

describe('useMaskEditor', () => {
  const mockClipId = 'clip-123';
  const mockEffectId = 'effect-456';
  const mockSequenceId = 'seq-789';
  const mockTrackId = 'track-001';

  beforeEach(() => {
    vi.clearAllMocks();
    mockInvoke.mockResolvedValue({ success: true, createdIds: ['mask-new'] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ===========================================================================
  // Initialization Tests
  // ===========================================================================

  describe('initialization', () => {
    it('should initialize with empty masks and no selection', () => {
      const { result } = renderHook(() =>
        useMaskEditor({
          clipId: mockClipId,
          effectId: mockEffectId,
          sequenceId: mockSequenceId,
          trackId: mockTrackId,
        })
      );

      expect(result.current.masks).toEqual([]);
      expect(result.current.selectedMaskId).toBeNull();
      expect(result.current.activeTool).toBe('rectangle');
    });

    it('should initialize with provided masks', () => {
      const initialMasks = [createMockMask('mask-1'), createMockMask('mask-2')];

      const { result } = renderHook(() =>
        useMaskEditor({
          clipId: mockClipId,
          effectId: mockEffectId,
          sequenceId: mockSequenceId,
          trackId: mockTrackId,
          initialMasks,
        })
      );

      expect(result.current.masks).toHaveLength(2);
      expect(result.current.masks[0].id).toBe('mask-1');
    });

    it('should fetch masks when fetchOnMount is true', async () => {
      const mockMasks = [createMockMask('mask-fetched')];
      mockInvoke.mockResolvedValueOnce(mockMasks);

      const { result } = renderHook(() =>
        useMaskEditor({
          clipId: mockClipId,
          effectId: mockEffectId,
          sequenceId: mockSequenceId,
          trackId: mockTrackId,
          fetchOnMount: true,
        })
      );

      await waitFor(() => {
        expect(result.current.masks).toHaveLength(1);
      });

      expect(mockInvoke).toHaveBeenCalledWith('get_effect_masks', {
        effectId: mockEffectId,
      });
    });
  });

  // ===========================================================================
  // Tool Selection Tests
  // ===========================================================================

  describe('setActiveTool', () => {
    it('should change active tool to ellipse', () => {
      const { result } = renderHook(() =>
        useMaskEditor({
          clipId: mockClipId,
          effectId: mockEffectId,
          sequenceId: mockSequenceId,
          trackId: mockTrackId,
        })
      );

      act(() => {
        result.current.setActiveTool('ellipse');
      });

      expect(result.current.activeTool).toBe('ellipse');
    });

    it('should change active tool to polygon', () => {
      const { result } = renderHook(() =>
        useMaskEditor({
          clipId: mockClipId,
          effectId: mockEffectId,
          sequenceId: mockSequenceId,
          trackId: mockTrackId,
        })
      );

      act(() => {
        result.current.setActiveTool('polygon');
      });

      expect(result.current.activeTool).toBe('polygon');
    });

    it('should change active tool to bezier', () => {
      const { result } = renderHook(() =>
        useMaskEditor({
          clipId: mockClipId,
          effectId: mockEffectId,
          sequenceId: mockSequenceId,
          trackId: mockTrackId,
        })
      );

      act(() => {
        result.current.setActiveTool('bezier');
      });

      expect(result.current.activeTool).toBe('bezier');
    });

    it('should support select tool', () => {
      const { result } = renderHook(() =>
        useMaskEditor({
          clipId: mockClipId,
          effectId: mockEffectId,
          sequenceId: mockSequenceId,
          trackId: mockTrackId,
        })
      );

      act(() => {
        result.current.setActiveTool('select');
      });

      expect(result.current.activeTool).toBe('select');
    });
  });

  // ===========================================================================
  // Mask Selection Tests
  // ===========================================================================

  describe('selection', () => {
    it('should select a mask by id', () => {
      const initialMasks = [createMockMask('mask-1'), createMockMask('mask-2')];

      const { result } = renderHook(() =>
        useMaskEditor({
          clipId: mockClipId,
          effectId: mockEffectId,
          sequenceId: mockSequenceId,
          trackId: mockTrackId,
          initialMasks,
        })
      );

      act(() => {
        result.current.selectMask('mask-2');
      });

      expect(result.current.selectedMaskId).toBe('mask-2');
    });

    it('should deselect when clicking same mask', () => {
      const initialMasks = [createMockMask('mask-1')];

      const { result } = renderHook(() =>
        useMaskEditor({
          clipId: mockClipId,
          effectId: mockEffectId,
          sequenceId: mockSequenceId,
          trackId: mockTrackId,
          initialMasks,
        })
      );

      act(() => {
        result.current.selectMask('mask-1');
      });

      expect(result.current.selectedMaskId).toBe('mask-1');

      act(() => {
        result.current.selectMask('mask-1');
      });

      expect(result.current.selectedMaskId).toBeNull();
    });

    it('should clear selection with clearSelection', () => {
      const initialMasks = [createMockMask('mask-1')];

      const { result } = renderHook(() =>
        useMaskEditor({
          clipId: mockClipId,
          effectId: mockEffectId,
          sequenceId: mockSequenceId,
          trackId: mockTrackId,
          initialMasks,
        })
      );

      act(() => {
        result.current.selectMask('mask-1');
      });

      expect(result.current.selectedMaskId).toBe('mask-1');

      act(() => {
        result.current.clearSelection();
      });

      expect(result.current.selectedMaskId).toBeNull();
    });

    it('should return selected mask object', () => {
      const initialMasks = [createMockMask('mask-1'), createMockMask('mask-2')];

      const { result } = renderHook(() =>
        useMaskEditor({
          clipId: mockClipId,
          effectId: mockEffectId,
          sequenceId: mockSequenceId,
          trackId: mockTrackId,
          initialMasks,
        })
      );

      act(() => {
        result.current.selectMask('mask-2');
      });

      expect(result.current.selectedMask).toBeDefined();
      expect(result.current.selectedMask?.id).toBe('mask-2');
    });
  });

  // ===========================================================================
  // Add Mask Tests
  // ===========================================================================

  describe('addMask', () => {
    it('should add a rectangle mask', async () => {
      const { result } = renderHook(() =>
        useMaskEditor({
          clipId: mockClipId,
          effectId: mockEffectId,
          sequenceId: mockSequenceId,
          trackId: mockTrackId,
        })
      );

      await act(async () => {
        await result.current.addMask('rectangle');
      });

      expect(mockInvoke).toHaveBeenCalledWith('execute_command', {
        commandType: 'AddMask',
        payload: expect.objectContaining({
          effectId: mockEffectId,
          shape: expect.objectContaining({ type: 'rectangle' }),
        }),
      });
    });

    it('should add an ellipse mask', async () => {
      const { result } = renderHook(() =>
        useMaskEditor({
          clipId: mockClipId,
          effectId: mockEffectId,
          sequenceId: mockSequenceId,
          trackId: mockTrackId,
        })
      );

      await act(async () => {
        await result.current.addMask('ellipse');
      });

      expect(mockInvoke).toHaveBeenCalledWith('execute_command', {
        commandType: 'AddMask',
        payload: expect.objectContaining({
          shape: expect.objectContaining({ type: 'ellipse' }),
        }),
      });
    });

    it('should auto-select newly added mask', async () => {
      mockInvoke.mockResolvedValueOnce({ success: true, createdIds: ['mask-new-123'] });

      const { result } = renderHook(() =>
        useMaskEditor({
          clipId: mockClipId,
          effectId: mockEffectId,
          sequenceId: mockSequenceId,
          trackId: mockTrackId,
        })
      );

      await act(async () => {
        await result.current.addMask('rectangle');
      });

      await waitFor(() => {
        expect(result.current.selectedMaskId).toBe('mask-new-123');
      });
    });

    it('should generate default name for new mask', async () => {
      const initialMasks = [createMockMask('mask-1')];

      const { result } = renderHook(() =>
        useMaskEditor({
          clipId: mockClipId,
          effectId: mockEffectId,
          sequenceId: mockSequenceId,
          trackId: mockTrackId,
          initialMasks,
        })
      );

      await act(async () => {
        await result.current.addMask('rectangle');
      });

      expect(mockInvoke).toHaveBeenCalledWith('execute_command', {
        commandType: 'AddMask',
        payload: expect.objectContaining({
          name: 'Mask 2',
        }),
      });
    });
  });

  // ===========================================================================
  // Update Mask Tests
  // ===========================================================================

  describe('updateMask', () => {
    it('should update mask properties', async () => {
      const initialMasks = [createMockMask('mask-1')];

      const { result } = renderHook(() =>
        useMaskEditor({
          clipId: mockClipId,
          effectId: mockEffectId,
          sequenceId: mockSequenceId,
          trackId: mockTrackId,
          initialMasks,
        })
      );

      await act(async () => {
        await result.current.updateMask('mask-1', { feather: 0.5 });
      });

      expect(mockInvoke).toHaveBeenCalledWith('execute_command', {
        commandType: 'UpdateMask',
        payload: {
          effectId: mockEffectId,
          maskId: 'mask-1',
          feather: 0.5,
        },
      });
    });

    it('should update local state optimistically', async () => {
      const initialMasks = [createMockMask('mask-1')];

      const { result } = renderHook(() =>
        useMaskEditor({
          clipId: mockClipId,
          effectId: mockEffectId,
          sequenceId: mockSequenceId,
          trackId: mockTrackId,
          initialMasks,
        })
      );

      act(() => {
        result.current.updateMaskLocal('mask-1', { feather: 0.7 });
      });

      expect(result.current.masks[0].feather).toBe(0.7);
    });

    it('should not update locked mask', async () => {
      const lockedMask = { ...createMockMask('mask-1'), locked: true };

      const { result } = renderHook(() =>
        useMaskEditor({
          clipId: mockClipId,
          effectId: mockEffectId,
          sequenceId: mockSequenceId,
          trackId: mockTrackId,
          initialMasks: [lockedMask],
        })
      );

      await act(async () => {
        await result.current.updateMask('mask-1', { feather: 0.5 });
      });

      // Should not call IPC for locked mask
      expect(mockInvoke).not.toHaveBeenCalledWith('execute_command', expect.any(Object));
    });

    it('should only send whitelisted update fields to backend', async () => {
      const initialMasks = [createMockMask('mask-1')];

      const { result } = renderHook(() =>
        useMaskEditor({
          clipId: mockClipId,
          effectId: mockEffectId,
          sequenceId: mockSequenceId,
          trackId: mockTrackId,
          initialMasks,
        })
      );

      await act(async () => {
        await result.current.updateMask('mask-1', {
          id: 'forbidden-id',
          feather: 0.4,
        } as Partial<Mask>);
      });

      expect(mockInvoke).toHaveBeenCalledWith('execute_command', {
        commandType: 'UpdateMask',
        payload: {
          effectId: mockEffectId,
          maskId: 'mask-1',
          feather: 0.4,
        },
      });
    });
  });

  // ===========================================================================
  // Delete Mask Tests
  // ===========================================================================

  describe('deleteMask', () => {
    it('should delete selected mask', async () => {
      const initialMasks = [createMockMask('mask-1'), createMockMask('mask-2')];

      const { result } = renderHook(() =>
        useMaskEditor({
          clipId: mockClipId,
          effectId: mockEffectId,
          sequenceId: mockSequenceId,
          trackId: mockTrackId,
          initialMasks,
        })
      );

      act(() => {
        result.current.selectMask('mask-1');
      });

      await act(async () => {
        await result.current.deleteMask('mask-1');
      });

      expect(mockInvoke).toHaveBeenCalledWith('execute_command', {
        commandType: 'RemoveMask',
        payload: {
          effectId: mockEffectId,
          maskId: 'mask-1',
        },
      });
    });

    it('should clear selection after deleting selected mask', async () => {
      const initialMasks = [createMockMask('mask-1')];

      const { result } = renderHook(() =>
        useMaskEditor({
          clipId: mockClipId,
          effectId: mockEffectId,
          sequenceId: mockSequenceId,
          trackId: mockTrackId,
          initialMasks,
        })
      );

      act(() => {
        result.current.selectMask('mask-1');
      });

      await act(async () => {
        await result.current.deleteMask('mask-1');
      });

      expect(result.current.selectedMaskId).toBeNull();
    });

    it('should not delete locked mask', async () => {
      const lockedMask = { ...createMockMask('mask-1'), locked: true };

      const { result } = renderHook(() =>
        useMaskEditor({
          clipId: mockClipId,
          effectId: mockEffectId,
          sequenceId: mockSequenceId,
          trackId: mockTrackId,
          initialMasks: [lockedMask],
        })
      );

      await act(async () => {
        await result.current.deleteMask('mask-1');
      });

      expect(mockInvoke).not.toHaveBeenCalledWith('execute_command', expect.any(Object));
    });
  });

  // ===========================================================================
  // Toggle Enabled/Locked Tests
  // ===========================================================================

  describe('toggleEnabled', () => {
    it('should toggle mask visibility', async () => {
      const initialMasks = [createMockMask('mask-1')];

      const { result } = renderHook(() =>
        useMaskEditor({
          clipId: mockClipId,
          effectId: mockEffectId,
          sequenceId: mockSequenceId,
          trackId: mockTrackId,
          initialMasks,
        })
      );

      await act(async () => {
        await result.current.toggleEnabled('mask-1');
      });

      expect(mockInvoke).toHaveBeenCalledWith('execute_command', {
        commandType: 'UpdateMask',
        payload: {
          effectId: mockEffectId,
          maskId: 'mask-1',
          enabled: false,
        },
      });
    });
  });

  describe('toggleLocked', () => {
    it('should toggle mask lock state', async () => {
      const initialMasks = [createMockMask('mask-1')];

      const { result } = renderHook(() =>
        useMaskEditor({
          clipId: mockClipId,
          effectId: mockEffectId,
          sequenceId: mockSequenceId,
          trackId: mockTrackId,
          initialMasks,
        })
      );

      await act(async () => {
        await result.current.toggleLocked('mask-1');
      });

      expect(mockInvoke).toHaveBeenCalledWith('execute_command', {
        commandType: 'UpdateMask',
        payload: {
          effectId: mockEffectId,
          maskId: 'mask-1',
          locked: true,
        },
      });
    });

    it('should allow unlocking a locked mask', async () => {
      // Critical test: toggleLocked must work on locked masks to enable unlock
      const lockedMask = { ...createMockMask('mask-1'), locked: true };

      const { result } = renderHook(() =>
        useMaskEditor({
          clipId: mockClipId,
          effectId: mockEffectId,
          sequenceId: mockSequenceId,
          trackId: mockTrackId,
          initialMasks: [lockedMask],
        })
      );

      await act(async () => {
        const success = await result.current.toggleLocked('mask-1');
        expect(success).toBe(true);
      });

      expect(mockInvoke).toHaveBeenCalledWith('execute_command', {
        commandType: 'UpdateMask',
        payload: {
          effectId: mockEffectId,
          maskId: 'mask-1',
          locked: false,
        },
      });
    });
  });

  // ===========================================================================
  // Reorder Tests
  // ===========================================================================

  describe('reorderMasks', () => {
    it('should reorder masks', () => {
      const initialMasks = [
        createMockMask('mask-1'),
        createMockMask('mask-2'),
        createMockMask('mask-3'),
      ];

      const { result } = renderHook(() =>
        useMaskEditor({
          clipId: mockClipId,
          effectId: mockEffectId,
          sequenceId: mockSequenceId,
          trackId: mockTrackId,
          initialMasks,
        })
      );

      act(() => {
        result.current.reorderMasks(0, 2); // Move first to last
      });

      expect(result.current.masks[0].id).toBe('mask-2');
      expect(result.current.masks[1].id).toBe('mask-3');
      expect(result.current.masks[2].id).toBe('mask-1');
    });
  });

  // ===========================================================================
  // Error Handling Tests
  // ===========================================================================

  describe('error handling', () => {
    it('should handle add mask error', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('Add failed'));

      const { result } = renderHook(() =>
        useMaskEditor({
          clipId: mockClipId,
          effectId: mockEffectId,
          sequenceId: mockSequenceId,
          trackId: mockTrackId,
        })
      );

      await act(async () => {
        await result.current.addMask('rectangle');
      });

      expect(result.current.error).toBe('Add failed');
    });

    it('should clear error', () => {
      const { result } = renderHook(() =>
        useMaskEditor({
          clipId: mockClipId,
          effectId: mockEffectId,
          sequenceId: mockSequenceId,
          trackId: mockTrackId,
        })
      );

      act(() => {
        result.current.clearError();
      });

      expect(result.current.error).toBeNull();
    });
  });

  // ===========================================================================
  // Edge Case & Destructive Tests
  // ===========================================================================

  describe('edge cases and destructive scenarios', () => {
    it('should handle rapid add/delete operations', async () => {
      mockInvoke
        .mockResolvedValueOnce({ success: true, createdIds: ['mask-1'] })
        .mockResolvedValueOnce({ success: true, createdIds: ['mask-2'] })
        .mockResolvedValueOnce({ success: true })
        .mockResolvedValueOnce({ success: true, createdIds: ['mask-3'] });

      const { result } = renderHook(() =>
        useMaskEditor({
          clipId: mockClipId,
          effectId: mockEffectId,
          sequenceId: mockSequenceId,
          trackId: mockTrackId,
        })
      );

      // Rapid operations
      await act(async () => {
        await result.current.addMask('rectangle');
        await result.current.addMask('ellipse');
      });

      expect(result.current.masks.length).toBe(2);

      await act(async () => {
        await result.current.deleteMask('mask-1');
        await result.current.addMask('polygon');
      });

      // Should have 2 masks (added 3, deleted 1)
      expect(result.current.masks.length).toBe(2);
    });

    it('should handle concurrent update operations', async () => {
      const initialMasks = [createMockMask('mask-1')];

      const { result } = renderHook(() =>
        useMaskEditor({
          clipId: mockClipId,
          effectId: mockEffectId,
          sequenceId: mockSequenceId,
          trackId: mockTrackId,
          initialMasks,
        })
      );

      let updatePromises: Promise<boolean>[] = [];
      await act(async () => {
        // Start multiple updates concurrently
        updatePromises = [
          result.current.updateMask('mask-1', { feather: 0.1 }),
          result.current.updateMask('mask-1', { feather: 0.2 }),
          result.current.updateMask('mask-1', { feather: 0.3 }),
        ];
        await Promise.all(updatePromises);
      });

      // Should complete without crashing
      expect(result.current.error).toBeNull();
    });

    it('should handle delete of non-existent mask', async () => {
      const { result } = renderHook(() =>
        useMaskEditor({
          clipId: mockClipId,
          effectId: mockEffectId,
          sequenceId: mockSequenceId,
          trackId: mockTrackId,
        })
      );

      await act(async () => {
        const success = await result.current.deleteMask('non-existent-id');
        expect(success).toBe(false);
      });

      // Should not trigger IPC call
      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it('should handle update of non-existent mask', async () => {
      const { result } = renderHook(() =>
        useMaskEditor({
          clipId: mockClipId,
          effectId: mockEffectId,
          sequenceId: mockSequenceId,
          trackId: mockTrackId,
        })
      );

      await act(async () => {
        const success = await result.current.updateMask('non-existent-id', { feather: 0.5 });
        expect(success).toBe(false);
      });
    });

    it('should handle selection of deleted mask gracefully', async () => {
      const initialMasks = [createMockMask('mask-1')];

      const { result } = renderHook(() =>
        useMaskEditor({
          clipId: mockClipId,
          effectId: mockEffectId,
          sequenceId: mockSequenceId,
          trackId: mockTrackId,
          initialMasks,
        })
      );

      // Select the mask
      act(() => {
        result.current.selectMask('mask-1');
      });

      expect(result.current.selectedMaskId).toBe('mask-1');

      // Delete the selected mask
      await act(async () => {
        await result.current.deleteMask('mask-1');
      });

      // Selection should be cleared
      expect(result.current.selectedMaskId).toBeNull();
      expect(result.current.selectedMask).toBeNull();
    });

    it('should handle network failure during fetch', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('Network error'));

      const { result } = renderHook(() =>
        useMaskEditor({
          clipId: mockClipId,
          effectId: mockEffectId,
          sequenceId: mockSequenceId,
          trackId: mockTrackId,
          fetchOnMount: true,
        })
      );

      await waitFor(() => {
        expect(result.current.error).toBe('Network error');
      });

      // Should have empty masks
      expect(result.current.masks).toEqual([]);
    });

    it('should discard malformed masks from fetch response', async () => {
      mockInvoke.mockResolvedValueOnce([
        createMockMask('valid-mask'),
        { invalid: true },
        { id: 'missing-shape', name: 'Broken' },
      ]);

      const { result } = renderHook(() =>
        useMaskEditor({
          clipId: mockClipId,
          effectId: mockEffectId,
          sequenceId: mockSequenceId,
          trackId: mockTrackId,
          fetchOnMount: true,
        })
      );

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.masks).toHaveLength(1);
      expect(result.current.masks[0].id).toBe('valid-mask');
    });

    it('should preserve locked mask protection', async () => {
      const lockedMask = { ...createMockMask('mask-1'), locked: true };

      const { result } = renderHook(() =>
        useMaskEditor({
          clipId: mockClipId,
          effectId: mockEffectId,
          sequenceId: mockSequenceId,
          trackId: mockTrackId,
          initialMasks: [lockedMask],
        })
      );

      // Attempt to update locked mask (should fail)
      await act(async () => {
        const success = await result.current.updateMask('mask-1', { feather: 0.9 });
        expect(success).toBe(false);
      });

      // Attempt to delete locked mask (should fail)
      await act(async () => {
        const success = await result.current.deleteMask('mask-1');
        expect(success).toBe(false);
      });

      // Mask should still exist
      expect(result.current.masks.length).toBe(1);
    });

    it('should handle reorder with invalid indices', () => {
      const initialMasks = [
        createMockMask('mask-1'),
        createMockMask('mask-2'),
      ];

      const { result } = renderHook(() =>
        useMaskEditor({
          clipId: mockClipId,
          effectId: mockEffectId,
          sequenceId: mockSequenceId,
          trackId: mockTrackId,
          initialMasks,
        })
      );

      // Out of bounds reorder - should not crash
      act(() => {
        result.current.reorderMasks(0, 100);
      });

      // Invalid reorder is ignored to avoid state corruption
      expect(result.current.masks.map((m) => m.id)).toEqual(['mask-1', 'mask-2']);
    });
  });
});
