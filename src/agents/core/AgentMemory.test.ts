/**
 * Agent Memory Tests
 *
 * Tests for short-term and long-term memory systems.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  MemoryManager,
  createMemoryManager,
} from './AgentMemory';
import type { AgentMessage, AgentContext } from '../Agent';

describe('MemoryManager', () => {
  let memory: MemoryManager;

  beforeEach(() => {
    memory = createMemoryManager();
  });

  describe('short-term memory', () => {
    const testMessages: AgentMessage[] = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' },
    ];

    const testContext: AgentContext = {
      projectId: 'proj_001',
      playheadPosition: 5.0,
    };

    it('should store conversation', () => {
      memory.storeConversation('conv_001', testMessages, testContext);

      const stored = memory.getConversation('conv_001');

      expect(stored).not.toBeNull();
      expect(stored?.conversationId).toBe('conv_001');
      expect(stored?.messages).toHaveLength(2);
      expect(stored?.context.projectId).toBe('proj_001');
    });

    it('should update existing conversation', () => {
      memory.storeConversation('conv_001', testMessages, testContext);

      const newMessages = [
        ...testMessages,
        { role: 'user' as const, content: 'Follow up' },
      ];

      memory.storeConversation('conv_001', newMessages, testContext, {
        updated: true,
      });

      const stored = memory.getConversation('conv_001');

      expect(stored?.messages).toHaveLength(3);
      expect(stored?.metadata.updated).toBe(true);
    });

    it('should preserve startedAt when updating', () => {
      memory.storeConversation('conv_001', testMessages, testContext);
      const firstStored = memory.getConversation('conv_001');
      const originalStartedAt = firstStored?.startedAt;

      // Wait a bit and update
      memory.storeConversation('conv_001', testMessages, testContext);
      const secondStored = memory.getConversation('conv_001');

      expect(secondStored?.startedAt).toBe(originalStartedAt);
      expect(secondStored?.lastUpdatedAt).toBeGreaterThanOrEqual(originalStartedAt!);
    });

    it('should return null for unknown conversation', () => {
      expect(memory.getConversation('unknown')).toBeNull();
    });

    it('should list all conversations', () => {
      memory.storeConversation('conv_001', testMessages, testContext);
      memory.storeConversation('conv_002', testMessages, testContext);
      memory.storeConversation('conv_003', testMessages, testContext);

      const list = memory.listConversations();

      expect(list).toHaveLength(3);
    });

    it('should clear specific conversation', () => {
      memory.storeConversation('conv_001', testMessages, testContext);
      memory.storeConversation('conv_002', testMessages, testContext);

      memory.clearConversation('conv_001');

      expect(memory.getConversation('conv_001')).toBeNull();
      expect(memory.getConversation('conv_002')).not.toBeNull();
    });

    it('should clear expired conversations', () => {
      const expiredMemory = createMemoryManager({
        shortTermExpiry: 100, // 100ms
      });

      expiredMemory.storeConversation('old', testMessages, testContext);

      // Manually set lastUpdatedAt to past
      const stored = expiredMemory.getConversation('old')!;
      (stored as { lastUpdatedAt: number }).lastUpdatedAt = Date.now() - 200;

      const cleared = expiredMemory.clearExpiredConversations();

      expect(cleared).toBe(1);
      expect(expiredMemory.getConversation('old')).toBeNull();
    });
  });

  describe('operation tracking', () => {
    it('should record operation', () => {
      memory.recordOperation('split_clip');
      memory.recordOperation('move_clip');

      const frequent = memory.getFrequentOperations();

      expect(frequent).toHaveLength(2);
      expect(frequent.some((op) => op.operation === 'split_clip')).toBe(true);
    });

    it('should increment count for repeated operations', () => {
      memory.recordOperation('split_clip');
      memory.recordOperation('split_clip');
      memory.recordOperation('split_clip');

      const frequent = memory.getFrequentOperations();
      const splitOp = frequent.find((op) => op.operation === 'split_clip');

      expect(splitOp?.count).toBe(3);
    });

    it('should sort by frequency', () => {
      memory.recordOperation('move_clip');
      memory.recordOperation('split_clip');
      memory.recordOperation('split_clip');
      memory.recordOperation('split_clip');
      memory.recordOperation('delete_clip');
      memory.recordOperation('delete_clip');

      const frequent = memory.getFrequentOperations();

      expect(frequent[0].operation).toBe('split_clip');
      expect(frequent[1].operation).toBe('delete_clip');
      expect(frequent[2].operation).toBe('move_clip');
    });

    it('should limit to max operations', () => {
      const limitedMemory = createMemoryManager({ maxOperations: 3 });

      for (let i = 0; i < 10; i++) {
        limitedMemory.recordOperation(`op_${i}`);
      }

      expect(limitedMemory.getFrequentOperations().length).toBeLessThanOrEqual(3);
    });

    it('should get recent operations', () => {
      vi.useFakeTimers();

      memory.recordOperation('old_op');
      memory.recordOperation('old_op');

      // Advance time so new_op has a later timestamp
      vi.advanceTimersByTime(100);
      memory.recordOperation('new_op');

      const recent = memory.getRecentOperations();

      vi.useRealTimers();

      expect(recent[0].operation).toBe('new_op');
    });
  });

  describe('corrections', () => {
    it('should record correction', () => {
      memory.recordCorrection('cut at 5s', 'split at 5 seconds');

      const corrections = memory.getCorrections();

      expect(corrections).toHaveLength(1);
      expect(corrections[0].original).toBe('cut at 5s');
      expect(corrections[0].corrected).toBe('split at 5 seconds');
    });

    it('should include context if provided', () => {
      memory.recordCorrection('delete', 'remove', 'When talking about clips');

      const corrections = memory.getCorrections();

      expect(corrections[0].context).toBe('When talking about clips');
    });

    it('should find relevant corrections', () => {
      memory.recordCorrection('cut', 'split');
      memory.recordCorrection('remove', 'delete');

      const relevant = memory.findRelevantCorrections('I want to cut the clip');

      expect(relevant).toHaveLength(1);
      expect(relevant[0].corrected).toBe('split');
    });

    it('should be case insensitive when finding corrections', () => {
      memory.recordCorrection('CUT', 'split');

      const relevant = memory.findRelevantCorrections('cut the video');

      expect(relevant).toHaveLength(1);
    });

    it('should limit corrections', () => {
      const limitedMemory = createMemoryManager({ maxCorrections: 3 });

      for (let i = 0; i < 5; i++) {
        limitedMemory.recordCorrection(`original_${i}`, `corrected_${i}`);
      }

      const corrections = limitedMemory.getCorrections();

      expect(corrections.length).toBeLessThanOrEqual(3);
      // Should keep most recent
      expect(corrections[corrections.length - 1].original).toBe('original_4');
    });
  });

  describe('preferences', () => {
    it('should set and get preference', () => {
      memory.setPreference('theme', 'dark');
      memory.setPreference('autoSave', true);

      expect(memory.getPreference<string>('theme')).toBe('dark');
      expect(memory.getPreference<boolean>('autoSave')).toBe(true);
    });

    it('should return default value if not set', () => {
      expect(memory.getPreference<number>('unknown', 42)).toBe(42);
      expect(memory.getPreference<number>('unknown')).toBeUndefined();
    });

    it('should get all preferences', () => {
      memory.setPreference('key1', 'value1');
      memory.setPreference('key2', 'value2');

      const all = memory.getAllPreferences();

      expect(all.key1).toBe('value1');
      expect(all.key2).toBe('value2');
    });
  });

  describe('project memory', () => {
    it('should create project memory on first access', () => {
      const projectMem = memory.getProjectMemory('proj_001');

      expect(projectMem.projectId).toBe('proj_001');
      expect(projectMem.frequentAssets).toEqual([]);
      expect(projectMem.notes).toEqual([]);
    });

    it('should return same project memory on subsequent access', () => {
      const first = memory.getProjectMemory('proj_001');
      first.notes.push('Test note');

      const second = memory.getProjectMemory('proj_001');

      expect(second.notes).toContain('Test note');
    });

    it('should record asset access', () => {
      memory.recordAssetAccess('proj_001', 'asset_001');
      memory.recordAssetAccess('proj_001', 'asset_002');
      memory.recordAssetAccess('proj_001', 'asset_001'); // Move to front

      const projectMem = memory.getProjectMemory('proj_001');

      expect(projectMem.frequentAssets[0]).toBe('asset_001');
      expect(projectMem.frequentAssets).toHaveLength(2);
    });

    it('should limit frequent assets', () => {
      for (let i = 0; i < 30; i++) {
        memory.recordAssetAccess('proj_001', `asset_${i}`);
      }

      const projectMem = memory.getProjectMemory('proj_001');

      expect(projectMem.frequentAssets.length).toBeLessThanOrEqual(20);
    });

    it('should add project notes', () => {
      memory.addProjectNote('proj_001', 'Note 1');
      memory.addProjectNote('proj_001', 'Note 2');

      const projectMem = memory.getProjectMemory('proj_001');

      expect(projectMem.notes).toContain('Note 1');
      expect(projectMem.notes).toContain('Note 2');
    });
  });

  describe('serialization', () => {
    it('should export and import long-term memory', () => {
      memory.setPreference('key', 'value');
      memory.recordOperation('test_op');
      memory.recordCorrection('orig', 'fixed');
      memory.addProjectNote('proj_001', 'Note');

      const exported = memory.exportLongTermMemory();

      const newMemory = createMemoryManager();
      newMemory.importLongTermMemory(exported);

      expect(newMemory.getPreference('key')).toBe('value');
      expect(newMemory.getFrequentOperations()[0].operation).toBe('test_op');
      expect(newMemory.getCorrections()[0].original).toBe('orig');
      expect(newMemory.getProjectMemory('proj_001').notes).toContain('Note');
    });

    it('should throw on invalid import data', () => {
      expect(() => {
        memory.importLongTermMemory('invalid json');
      }).toThrow('Failed to import');
    });
  });

  describe('cleanup', () => {
    const testMessages: AgentMessage[] = [{ role: 'user', content: 'Test' }];
    const testContext: AgentContext = {};

    it('should clear all memory', () => {
      memory.storeConversation('conv_001', testMessages, testContext);
      memory.setPreference('key', 'value');
      memory.recordOperation('op');

      memory.clearAll();

      expect(memory.getConversation('conv_001')).toBeNull();
      expect(memory.getPreference('key')).toBeUndefined();
      expect(memory.getFrequentOperations()).toHaveLength(0);
    });

    it('should clear only short-term', () => {
      memory.storeConversation('conv_001', testMessages, testContext);
      memory.setPreference('key', 'value');

      memory.clearShortTerm();

      expect(memory.getConversation('conv_001')).toBeNull();
      expect(memory.getPreference('key')).toBe('value');
    });

    it('should clear only long-term', () => {
      memory.storeConversation('conv_001', testMessages, testContext);
      memory.setPreference('key', 'value');

      memory.clearLongTerm();

      expect(memory.getConversation('conv_001')).not.toBeNull();
      expect(memory.getPreference('key')).toBeUndefined();
    });
  });
});
