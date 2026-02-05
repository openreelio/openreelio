/**
 * Context Compactor Tests
 *
 * Tests for conversation history compaction.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ContextCompactor,
  createContextCompactor,
  defaultSummarizer,
} from './ContextCompactor';
import type { AgentMessage } from '../Agent';

// Helper to create test messages
function createMessages(count: number): AgentMessage[] {
  const messages: AgentMessage[] = [];
  for (let i = 0; i < count; i++) {
    messages.push({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `Message ${i + 1}`,
    });
  }
  return messages;
}

describe('ContextCompactor', () => {
  let compactor: ContextCompactor;

  beforeEach(() => {
    compactor = createContextCompactor({
      maxMessages: 10,
      summarizeCount: 5,
      preserveRecent: 3,
    });
  });

  describe('configuration', () => {
    it('should use default config when not provided', () => {
      const defaultCompactor = createContextCompactor();
      const config = defaultCompactor.getConfig();

      expect(config.maxMessages).toBe(50);
      expect(config.summarizeCount).toBe(30);
      expect(config.preserveRecent).toBe(10);
    });

    it('should accept custom config', () => {
      const config = compactor.getConfig();

      expect(config.maxMessages).toBe(10);
      expect(config.summarizeCount).toBe(5);
      expect(config.preserveRecent).toBe(3);
    });

    it('should throw if preserveRecent >= maxMessages', () => {
      expect(() => {
        createContextCompactor({
          maxMessages: 10,
          preserveRecent: 10,
        });
      }).toThrow('preserveRecent must be less than maxMessages');
    });

    it('should throw if summarizeCount too large', () => {
      expect(() => {
        createContextCompactor({
          maxMessages: 10,
          summarizeCount: 9,
          preserveRecent: 3,
        });
      }).toThrow('summarizeCount too large');
    });
  });

  describe('shouldCompact', () => {
    it('should return false when below threshold', () => {
      const messages = createMessages(5);
      expect(compactor.shouldCompact(messages)).toBe(false);
    });

    it('should return false at exact threshold', () => {
      const messages = createMessages(10);
      expect(compactor.shouldCompact(messages)).toBe(false);
    });

    it('should return true above threshold', () => {
      const messages = createMessages(11);
      expect(compactor.shouldCompact(messages)).toBe(true);
    });
  });

  describe('compact', () => {
    it('should not compact when below threshold', async () => {
      const messages = createMessages(5);
      const { messages: result, result: compactionResult } = await compactor.compact(messages);

      expect(compactionResult.compacted).toBe(false);
      expect(result).toEqual(messages);
      expect(compactionResult.originalCount).toBe(5);
      expect(compactionResult.newCount).toBe(5);
    });

    it('should compact when above threshold', async () => {
      const messages = createMessages(15);
      const { messages: result, result: compactionResult } = await compactor.compact(messages);

      expect(compactionResult.compacted).toBe(true);
      expect(result.length).toBeLessThan(15);
      expect(compactionResult.summarizedCount).toBe(5);
    });

    it('should preserve recent messages', async () => {
      const messages = createMessages(15);
      const { messages: result } = await compactor.compact(messages);

      // Last 3 messages should be preserved
      const originalRecent = messages.slice(-3);
      const compactedRecent = result.slice(-3);

      expect(compactedRecent).toEqual(originalRecent);
    });

    it('should add summary message', async () => {
      const messages = createMessages(15);
      const { messages: result, result: compactionResult } = await compactor.compact(messages);

      // Should have a system message with summary
      const summaryMessage = result.find(
        (m) => m.role === 'system' && m.content.includes('Summary')
      );

      expect(summaryMessage).toBeDefined();
      expect(compactionResult.summary).toBeDefined();
    });

    it('should use custom summarizer', async () => {
      const customSummarizer = vi.fn(() => 'Custom summary');
      const customCompactor = createContextCompactor({
        maxMessages: 10,
        summarizeCount: 5,
        preserveRecent: 3,
        summarizer: customSummarizer,
      });

      const messages = createMessages(15);
      const { result: compactionResult } = await customCompactor.compact(messages);

      expect(customSummarizer).toHaveBeenCalled();
      expect(compactionResult.summary).toBe('Custom summary');
    });

    it('should track compaction history', async () => {
      const messages = createMessages(15);
      await compactor.compact(messages);

      const history = compactor.getCompactionHistory();
      expect(history).toHaveLength(1);
      expect(history[0].messageCount).toBe(5);
    });
  });

  describe('compactTo', () => {
    it('should not compact when already at target', async () => {
      const messages = createMessages(5);
      const { messages: result, result: compactionResult } = await compactor.compactTo(messages, 10);

      expect(compactionResult.compacted).toBe(false);
      expect(result).toEqual(messages);
    });

    it('should compact to target size', async () => {
      const messages = createMessages(20);
      const { messages: result, result: compactionResult } = await compactor.compactTo(messages, 5);

      expect(compactionResult.compacted).toBe(true);
      expect(result.length).toBeLessThanOrEqual(5);
    });

    it('should preserve most recent when compacting to small size', async () => {
      const messages = createMessages(10);
      // Mark last message distinctly
      messages[9].content = 'LAST MESSAGE';

      const { messages: result } = await compactor.compactTo(messages, 3);

      expect(result[result.length - 1].content).toBe('LAST MESSAGE');
    });
  });

  describe('statistics', () => {
    it('should calculate message stats', () => {
      const messages: AgentMessage[] = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there' },
        { role: 'user', content: 'How are you?' },
        { role: 'tool', content: '{"result": "ok"}' },
      ];

      const stats = compactor.getStats(messages);

      expect(stats.totalMessages).toBe(4);
      expect(stats.byRole.user).toBe(2);
      expect(stats.byRole.assistant).toBe(1);
      expect(stats.byRole.tool).toBe(1);
      expect(stats.needsCompaction).toBe(false);
    });

    it('should estimate tokens', () => {
      const messages: AgentMessage[] = [
        { role: 'user', content: 'Hello world' }, // ~11 chars
        { role: 'assistant', content: 'Hi there!' }, // ~9 chars
      ];

      const tokens = compactor.estimateTokens(messages);
      // ~20 chars / 4 = 5 tokens
      expect(tokens).toBe(5);
    });

    it('should track total summarized messages', async () => {
      const messages1 = createMessages(15);
      await compactor.compact(messages1);

      const messages2 = createMessages(15);
      await compactor.compact(messages2);

      expect(compactor.getTotalSummarized()).toBe(10); // 5 + 5
    });

    it('should clear history', async () => {
      const messages = createMessages(15);
      await compactor.compact(messages);

      compactor.clearHistory();

      expect(compactor.getCompactionHistory()).toHaveLength(0);
      expect(compactor.getTotalSummarized()).toBe(0);
    });
  });
});

describe('defaultSummarizer', () => {
  it('should create summary from messages', () => {
    const messages: AgentMessage[] = [
      { role: 'user', content: 'First user message' },
      { role: 'assistant', content: 'First assistant response' },
      { role: 'user', content: 'Second user message' },
      { role: 'tool', content: '{"success": true}' },
    ];

    const summary = defaultSummarizer(messages);

    expect(summary).toContain('Conversation Summary');
    expect(summary).toContain('User requests');
    expect(summary).toContain('Assistant responses');
    expect(summary).toContain('Tool calls');
  });

  it('should truncate long messages', () => {
    const longContent = 'x'.repeat(200);
    const messages: AgentMessage[] = [{ role: 'user', content: longContent }];

    const summary = defaultSummarizer(messages);

    expect(summary).toContain('...');
    expect(summary.length).toBeLessThan(longContent.length);
  });

  it('should indicate when there are more messages', () => {
    const messages: AgentMessage[] = [
      { role: 'user', content: 'Message 1' },
      { role: 'user', content: 'Message 2' },
      { role: 'user', content: 'Message 3' },
      { role: 'user', content: 'Message 4' },
      { role: 'user', content: 'Message 5' },
    ];

    const summary = defaultSummarizer(messages);

    expect(summary).toContain('... and 2 more');
  });
});
