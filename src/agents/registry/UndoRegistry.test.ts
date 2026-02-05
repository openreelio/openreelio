/**
 * Undo Registry Tests
 *
 * Tests for undo operation management.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  UndoRegistry,
  createUndoRegistry,
  moveClipUndoGenerator,
  deleteClipUndoGenerator,
  insertClipUndoGenerator,
  type UndoGenerator,
  type UndoOperation,
} from './UndoRegistry';

describe('UndoRegistry', () => {
  let registry: UndoRegistry;

  beforeEach(() => {
    registry = createUndoRegistry();
  });

  describe('generator registration', () => {
    it('should register a generator', () => {
      const generator: UndoGenerator = () => null;
      registry.registerGenerator('test_tool', generator);
      expect(registry.hasGenerator('test_tool')).toBe(true);
    });

    it('should unregister a generator', () => {
      const generator: UndoGenerator = () => null;
      registry.registerGenerator('test_tool', generator);
      registry.unregisterGenerator('test_tool');
      expect(registry.hasGenerator('test_tool')).toBe(false);
    });

    it('should return false for unregistered tools', () => {
      expect(registry.hasGenerator('unknown_tool')).toBe(false);
    });
  });

  describe('execution recording', () => {
    it('should record execution and return undo operation', () => {
      const generator: UndoGenerator = (toolName, args, result) => ({
        id: 'undo_001',
        toolName,
        originalArgs: args,
        originalResult: result,
        timestamp: Date.now(),
        description: 'Test undo',
        inverseOperation: { toolName: 'inverse_tool', args: {} },
      });

      registry.registerGenerator('test_tool', generator);

      const undoOp = registry.recordExecution(
        'test_tool',
        { foo: 'bar' },
        { success: true, result: { data: 'test' } }
      );

      expect(undoOp).not.toBeNull();
      expect(undoOp?.toolName).toBe('test_tool');
    });

    it('should not record failed executions', () => {
      const generator = vi.fn(() => ({
        id: 'undo_001',
        toolName: 'test_tool',
        originalArgs: {},
        originalResult: { success: false },
        timestamp: Date.now(),
        description: 'Test',
        inverseOperation: { toolName: 'inverse', args: {} },
      }));

      registry.registerGenerator('test_tool', generator);

      const undoOp = registry.recordExecution(
        'test_tool',
        {},
        { success: false, error: 'Failed' }
      );

      expect(undoOp).toBeNull();
      expect(generator).not.toHaveBeenCalled();
    });

    it('should not record if no generator exists', () => {
      const undoOp = registry.recordExecution(
        'unknown_tool',
        {},
        { success: true }
      );

      expect(undoOp).toBeNull();
    });

    it('should handle generator returning null', () => {
      registry.registerGenerator('test_tool', () => null);

      const undoOp = registry.recordExecution(
        'test_tool',
        {},
        { success: true }
      );

      expect(undoOp).toBeNull();
      expect(registry.canUndo()).toBe(false);
    });

    it('should handle generator throwing error', () => {
      registry.registerGenerator('test_tool', () => {
        throw new Error('Generator error');
      });

      const undoOp = registry.recordExecution(
        'test_tool',
        {},
        { success: true }
      );

      expect(undoOp).toBeNull();
    });
  });

  describe('undo stack operations', () => {
    const createTestUndo = (id: string): UndoOperation => ({
      id,
      toolName: 'test_tool',
      originalArgs: {},
      originalResult: { success: true },
      timestamp: Date.now(),
      description: 'Test undo',
      inverseOperation: { toolName: 'inverse', args: {} },
    });

    beforeEach(() => {
      registry.registerGenerator('test_tool', (toolName) => createTestUndo(toolName));
    });

    it('should report canUndo correctly', () => {
      expect(registry.canUndo()).toBe(false);

      registry.recordExecution('test_tool', {}, { success: true });
      expect(registry.canUndo()).toBe(true);
    });

    it('should report undo count correctly', () => {
      expect(registry.getUndoCount()).toBe(0);

      registry.recordExecution('test_tool', {}, { success: true });
      expect(registry.getUndoCount()).toBe(1);

      registry.recordExecution('test_tool', {}, { success: true });
      expect(registry.getUndoCount()).toBe(2);
    });

    it('should peek without removing', () => {
      registry.registerGenerator('test_tool', () => createTestUndo('peek_test'));
      registry.recordExecution('test_tool', {}, { success: true });

      const peeked = registry.peekUndo();
      expect(peeked?.id).toBe('peek_test');
      expect(registry.getUndoCount()).toBe(1);
    });

    it('should pop and remove from stack', () => {
      registry.registerGenerator('test_tool', () => createTestUndo('pop_test'));
      registry.recordExecution('test_tool', {}, { success: true });

      const popped = registry.popUndo();
      expect(popped?.id).toBe('pop_test');
      expect(registry.canUndo()).toBe(false);
    });

    it('should return null when popping empty stack', () => {
      expect(registry.popUndo()).toBeNull();
    });

    it('should return null when peeking empty stack', () => {
      expect(registry.peekUndo()).toBeNull();
    });

    it('should maintain LIFO order', () => {
      let counter = 0;
      registry.registerGenerator('test_tool', () => createTestUndo(`undo_${++counter}`));

      registry.recordExecution('test_tool', {}, { success: true });
      registry.recordExecution('test_tool', {}, { success: true });
      registry.recordExecution('test_tool', {}, { success: true });

      expect(registry.popUndo()?.id).toBe('undo_3');
      expect(registry.popUndo()?.id).toBe('undo_2');
      expect(registry.popUndo()?.id).toBe('undo_1');
    });

    it('should get history in reverse order (most recent first)', () => {
      let counter = 0;
      registry.registerGenerator('test_tool', () => createTestUndo(`undo_${++counter}`));

      registry.recordExecution('test_tool', {}, { success: true });
      registry.recordExecution('test_tool', {}, { success: true });
      registry.recordExecution('test_tool', {}, { success: true });

      const history = registry.getUndoHistory();
      expect(history[0].id).toBe('undo_3');
      expect(history[1].id).toBe('undo_2');
      expect(history[2].id).toBe('undo_1');
    });

    it('should clear undo stack', () => {
      registry.recordExecution('test_tool', {}, { success: true });
      registry.recordExecution('test_tool', {}, { success: true });

      registry.clearUndoStack();
      expect(registry.canUndo()).toBe(false);
      expect(registry.getUndoCount()).toBe(0);
    });
  });

  describe('max history limit', () => {
    it('should trim old entries when exceeding max history', () => {
      const registryWithLimit = createUndoRegistry({ maxHistory: 3 });
      let counter = 0;
      registryWithLimit.registerGenerator('test_tool', () => ({
        id: `undo_${++counter}`,
        toolName: 'test_tool',
        originalArgs: {},
        originalResult: { success: true },
        timestamp: Date.now(),
        description: 'Test',
        inverseOperation: { toolName: 'inverse', args: {} },
      }));

      // Add 5 entries
      for (let i = 0; i < 5; i++) {
        registryWithLimit.recordExecution('test_tool', {}, { success: true });
      }

      // Should only have 3 most recent
      expect(registryWithLimit.getUndoCount()).toBe(3);

      const history = registryWithLimit.getUndoHistory();
      expect(history[0].id).toBe('undo_5');
      expect(history[1].id).toBe('undo_4');
      expect(history[2].id).toBe('undo_3');
    });
  });
});

describe('Standard Undo Generators', () => {
  describe('moveClipUndoGenerator', () => {
    it('should generate undo for move with original position in result', () => {
      const undoOp = moveClipUndoGenerator(
        'move_clip',
        {
          sequenceId: 'seq_001',
          trackId: 'track_001',
          clipId: 'clip_001',
          newTimelineIn: 10,
        },
        {
          success: true,
          result: { originalTimelineIn: 5, originalTrackId: 'track_001' },
        }
      );

      expect(undoOp).not.toBeNull();
      expect(undoOp?.inverseOperation.toolName).toBe('move_clip');
      expect(undoOp?.inverseOperation.args.newTimelineIn).toBe(5);
    });

    it('should return null if original position not in result', () => {
      const undoOp = moveClipUndoGenerator(
        'move_clip',
        { clipId: 'clip_001', newTimelineIn: 10 },
        { success: true, result: {} }
      );

      expect(undoOp).toBeNull();
    });

    it('should handle track change', () => {
      const undoOp = moveClipUndoGenerator(
        'move_clip',
        {
          sequenceId: 'seq_001',
          trackId: 'track_002',
          clipId: 'clip_001',
          newTimelineIn: 10,
        },
        {
          success: true,
          result: { originalTimelineIn: 5, originalTrackId: 'track_001' },
        }
      );

      expect(undoOp?.inverseOperation.args.trackId).toBe('track_001');
      expect(undoOp?.inverseOperation.args.newTrackId).toBe('track_002');
    });
  });

  describe('deleteClipUndoGenerator', () => {
    it('should generate undo for delete with clip data in result', () => {
      const undoOp = deleteClipUndoGenerator(
        'delete_clip',
        {
          sequenceId: 'seq_001',
          trackId: 'track_001',
          clipId: 'clip_001',
        },
        {
          success: true,
          result: {
            assetId: 'asset_001',
            timelineIn: 5,
            sourceIn: 0,
            sourceOut: 10,
          },
        }
      );

      expect(undoOp).not.toBeNull();
      expect(undoOp?.inverseOperation.toolName).toBe('insert_clip');
      expect(undoOp?.inverseOperation.args.assetId).toBe('asset_001');
      expect(undoOp?.inverseOperation.args.timelineStart).toBe(5);
    });

    it('should return null if clip data not in result', () => {
      const undoOp = deleteClipUndoGenerator(
        'delete_clip',
        { clipId: 'clip_001' },
        { success: true, result: {} }
      );

      expect(undoOp).toBeNull();
    });
  });

  describe('insertClipUndoGenerator', () => {
    it('should generate undo for insert with clip id in result', () => {
      const undoOp = insertClipUndoGenerator(
        'insert_clip',
        {
          sequenceId: 'seq_001',
          trackId: 'track_001',
          assetId: 'asset_001',
          timelineStart: 0,
        },
        {
          success: true,
          result: { clipId: 'new_clip_001' },
        }
      );

      expect(undoOp).not.toBeNull();
      expect(undoOp?.inverseOperation.toolName).toBe('delete_clip');
      expect(undoOp?.inverseOperation.args.clipId).toBe('new_clip_001');
    });

    it('should return null if clip id not in result', () => {
      const undoOp = insertClipUndoGenerator(
        'insert_clip',
        { assetId: 'asset_001' },
        { success: true, result: {} }
      );

      expect(undoOp).toBeNull();
    });
  });
});
