/**
 * Chat Storage Service Tests
 *
 * TDD tests for chat message persistence.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  loadChatHistory,
  saveChatHistory,
  clearChatHistory,
  cleanupOldHistories,
  getStoredProjectIds,
  createDebouncedSaver,
} from './chatStorage';
import type { ChatMessage } from '@/stores/aiStore';

// =============================================================================
// Test Data
// =============================================================================

const createTestMessage = (
  id: string,
  role: 'user' | 'assistant' = 'user',
  content = 'Test message'
): ChatMessage => ({
  id,
  role,
  content,
  timestamp: new Date().toISOString(),
});

// =============================================================================
// Tests
// =============================================================================

describe('chatStorage', () => {
  beforeEach(() => {
    // Clear localStorage before each test
    localStorage.clear();
    vi.clearAllMocks();
  });

  describe('loadChatHistory', () => {
    it('returns empty array for non-existent project', () => {
      const messages = loadChatHistory('non_existent_project');
      expect(messages).toEqual([]);
    });

    it('returns empty array for empty projectId', () => {
      const messages = loadChatHistory('');
      expect(messages).toEqual([]);
    });

    it('loads saved messages correctly', () => {
      const testMessages: ChatMessage[] = [
        createTestMessage('msg_001', 'user', 'Hello'),
        createTestMessage('msg_002', 'assistant', 'Hi there!'),
      ];

      saveChatHistory('test_project', testMessages);
      const loaded = loadChatHistory('test_project');

      expect(loaded).toHaveLength(2);
      expect(loaded[0].id).toBe('msg_001');
      expect(loaded[1].id).toBe('msg_002');
    });

    it('handles corrupted data gracefully', () => {
      localStorage.setItem('openreelio_chat_history_corrupt', 'not valid json');
      const messages = loadChatHistory('corrupt');
      expect(messages).toEqual([]);
    });

    it('filters out invalid messages', () => {
      const data = {
        projectId: 'test',
        messages: [
          createTestMessage('valid', 'user', 'Valid'),
          { invalid: 'message' },
          null,
          createTestMessage('valid2', 'assistant', 'Also valid'),
        ],
        lastUpdated: new Date().toISOString(),
        version: 1,
      };

      localStorage.setItem(
        'openreelio_chat_history_test',
        JSON.stringify(data)
      );

      const messages = loadChatHistory('test');
      expect(messages).toHaveLength(2);
    });
  });

  describe('saveChatHistory', () => {
    it('saves messages to localStorage', () => {
      const testMessages = [createTestMessage('msg_001')];

      saveChatHistory('test_project', testMessages);

      const stored = localStorage.getItem('openreelio_chat_history_test_project');
      expect(stored).not.toBeNull();

      const data = JSON.parse(stored!);
      expect(data.messages).toHaveLength(1);
      expect(data.messages[0].id).toBe('msg_001');
    });

    it('does nothing for empty projectId', () => {
      saveChatHistory('', [createTestMessage('msg_001')]);
      expect(localStorage.length).toBe(0);
    });

    it('limits messages to MAX_MESSAGES_PER_PROJECT', () => {
      const manyMessages = Array.from({ length: 150 }, (_, i) =>
        createTestMessage(`msg_${i}`)
      );

      saveChatHistory('test_project', manyMessages);

      const loaded = loadChatHistory('test_project');
      expect(loaded.length).toBeLessThanOrEqual(100);
    });

    it('sanitizes projectId to prevent injection', () => {
      saveChatHistory('../../../etc/passwd', [createTestMessage('msg_001')]);

      // Should be sanitized to underscores
      // ../../../etc/passwd -> _________etc_passwd (9 underscores before etc, 1 before passwd)
      // Combined with prefix: openreelio_chat_history_ + _________etc_passwd
      const key = 'openreelio_chat_history__________etc_passwd';
      expect(localStorage.getItem(key)).not.toBeNull();
    });
  });

  describe('clearChatHistory', () => {
    it('removes chat history for project', () => {
      saveChatHistory('test_project', [createTestMessage('msg_001')]);
      expect(loadChatHistory('test_project')).toHaveLength(1);

      clearChatHistory('test_project');
      expect(loadChatHistory('test_project')).toEqual([]);
    });

    it('does nothing for empty projectId', () => {
      saveChatHistory('test_project', [createTestMessage('msg_001')]);
      clearChatHistory('');
      expect(loadChatHistory('test_project')).toHaveLength(1);
    });

    it('does nothing for non-existent project', () => {
      // Should not throw
      clearChatHistory('non_existent');
    });
  });

  describe('cleanupOldHistories', () => {
    it('removes histories older than 30 days', () => {
      // Create old history
      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - 31);

      const oldData = {
        projectId: 'old_project',
        messages: [createTestMessage('msg_001')],
        lastUpdated: oldDate.toISOString(),
        version: 1,
      };

      localStorage.setItem(
        'openreelio_chat_history_old_project',
        JSON.stringify(oldData)
      );

      // Create recent history
      saveChatHistory('recent_project', [createTestMessage('msg_002')]);

      cleanupOldHistories();

      expect(loadChatHistory('old_project')).toEqual([]);
      expect(loadChatHistory('recent_project')).toHaveLength(1);
    });

    it('removes corrupted entries', () => {
      localStorage.setItem('openreelio_chat_history_corrupt', 'not json');
      cleanupOldHistories();
      expect(localStorage.getItem('openreelio_chat_history_corrupt')).toBeNull();
    });
  });

  describe('getStoredProjectIds', () => {
    it('returns empty array when no histories exist', () => {
      expect(getStoredProjectIds()).toEqual([]);
    });

    it('returns project IDs with stored histories', () => {
      saveChatHistory('project_a', [createTestMessage('msg_001')]);
      saveChatHistory('project_b', [createTestMessage('msg_002')]);

      const ids = getStoredProjectIds();
      expect(ids).toContain('project_a');
      expect(ids).toContain('project_b');
    });

    it('ignores non-chat localStorage items', () => {
      localStorage.setItem('other_key', 'other_value');
      saveChatHistory('project_a', [createTestMessage('msg_001')]);

      const ids = getStoredProjectIds();
      expect(ids).toHaveLength(1);
      expect(ids).toContain('project_a');
    });
  });

  describe('createDebouncedSaver', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('debounces rapid saves', () => {
      const debouncedSave = createDebouncedSaver(100);

      debouncedSave('project', [createTestMessage('msg_001')]);
      debouncedSave('project', [createTestMessage('msg_001'), createTestMessage('msg_002')]);
      debouncedSave('project', [
        createTestMessage('msg_001'),
        createTestMessage('msg_002'),
        createTestMessage('msg_003'),
      ]);

      // Before timeout, nothing should be saved
      expect(loadChatHistory('project')).toEqual([]);

      // After timeout, only the last call should have saved
      vi.advanceTimersByTime(100);

      const loaded = loadChatHistory('project');
      expect(loaded).toHaveLength(3);
    });

    it('saves after delay', () => {
      const debouncedSave = createDebouncedSaver(500);

      debouncedSave('project', [createTestMessage('msg_001')]);

      // Before timeout
      vi.advanceTimersByTime(400);
      expect(loadChatHistory('project')).toEqual([]);

      // After timeout
      vi.advanceTimersByTime(100);
      expect(loadChatHistory('project')).toHaveLength(1);
    });
  });
});
