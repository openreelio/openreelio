/**
 * Tests for Compaction - Two-Tier Context Management
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  Compaction,
  PRUNE_PROTECT_TOKENS,
  PRUNE_MINIMUM_TOKENS,
  COMPACT_THRESHOLD,
  CHARS_PER_TOKEN,
} from './compaction';
import type { ConversationMessage, TokenUsage } from './conversation';
import {
  createUserMessage,
  createAssistantMessage,
  createTextPart,
  createThinkingPart,
  createToolCallPart,
  createToolResultPart,
  createErrorPart,
} from './conversation';
import { MockLLMAdapter, createMockLLMAdapter } from '../adapters/llm/MockLLMAdapter';
import type { Thought, PlanStep } from './types';

// =============================================================================
// Test Fixtures
// =============================================================================

function createTestThought(): Thought {
  return {
    understanding: 'User wants to split the clip at 5 seconds',
    requirements: ['Find the clip on the timeline'],
    uncertainties: [],
    approach: 'Use split_clip tool',
    needsMoreInfo: false,
  };
}

function createTestStep(overrides?: Partial<PlanStep>): PlanStep {
  return {
    id: 's1',
    tool: 'split_clip',
    args: { clipId: 'clip_001', position: 5 },
    description: 'Split clip at 5 seconds',
    riskLevel: 'medium',
    estimatedDuration: 1000,
    ...overrides,
  };
}

/**
 * Build a message with a tool_result containing a given amount of data.
 */
function createToolResultMessage(dataPayload: unknown): ConversationMessage {
  const msg = createAssistantMessage();
  msg.parts = [
    createToolResultPart('s1', 'get_timeline_info', true, 100, dataPayload),
  ];
  return msg;
}

/**
 * Build a message with a thinking part.
 */
function createThinkingMessage(): ConversationMessage {
  const msg = createAssistantMessage();
  msg.parts = [createThinkingPart(createTestThought())];
  return msg;
}

/**
 * Build a user message with enough text to fill roughly `targetTokens` tokens.
 */
function createPaddedUserMessage(targetTokens: number): ConversationMessage {
  const charCount = targetTokens * CHARS_PER_TOKEN;
  const msg = createUserMessage('x'.repeat(charCount));
  return msg;
}

/**
 * Build a minimal conversation for testing.
 */
function createMinimalConversation(): ConversationMessage[] {
  return [
    createUserMessage('Split the clip at 5 seconds'),
    createToolResultMessage({ tracks: [{ id: 't1', clips: ['c1', 'c2', 'c3'] }] }),
    createUserMessage('Now trim the first clip'),
  ];
}

// =============================================================================
// Tests
// =============================================================================

describe('Compaction', () => {
  beforeEach(() => {
    vi.stubGlobal('crypto', {
      randomUUID: vi.fn().mockReturnValue('test-uuid'),
    });
  });

  // ===========================================================================
  // estimateTokens
  // ===========================================================================

  describe('estimateTokens', () => {
    it('should return 0 for empty array', () => {
      expect(Compaction.estimateTokens([])).toBe(0);
    });

    it('should estimate tokens based on character count', () => {
      const msg = createUserMessage('Hello world'); // 11 chars
      const tokens = Compaction.estimateTokens([msg]);
      expect(tokens).toBe(Math.ceil(11 / CHARS_PER_TOKEN));
    });

    it('should sum tokens across multiple messages', () => {
      const msg1 = createUserMessage('Hello'); // 5 chars
      const msg2 = createUserMessage('World'); // 5 chars
      const tokens = Compaction.estimateTokens([msg1, msg2]);
      expect(tokens).toBe(Math.ceil(10 / CHARS_PER_TOKEN));
    });

    it('should account for tool_result data in estimation', () => {
      const smallData = { ok: true };
      const bigData = { tracks: Array(100).fill({ id: 'track', clips: ['a', 'b', 'c'] }) };

      const smallMsg = createToolResultMessage(smallData);
      const bigMsg = createToolResultMessage(bigData);

      const smallTokens = Compaction.estimateTokens([smallMsg]);
      const bigTokens = Compaction.estimateTokens([bigMsg]);

      expect(bigTokens).toBeGreaterThan(smallTokens);
    });

    it('should account for thinking parts in estimation', () => {
      const withThinking = createThinkingMessage();
      const withoutThinking = createUserMessage('short');

      const thinkingTokens = Compaction.estimateTokens([withThinking]);
      const textTokens = Compaction.estimateTokens([withoutThinking]);

      expect(thinkingTokens).toBeGreaterThan(textTokens);
    });

    it('should handle messages with tool_call parts', () => {
      const msg = createAssistantMessage();
      msg.parts = [createToolCallPart(createTestStep())];
      const tokens = Compaction.estimateTokens([msg]);
      expect(tokens).toBeGreaterThan(0);
    });

    it('should handle messages with error parts', () => {
      const msg = createAssistantMessage();
      msg.parts = [createErrorPart('TIMEOUT', 'Operation timed out', 'executing', true)];
      const tokens = Compaction.estimateTokens([msg]);
      expect(tokens).toBeGreaterThan(0);
    });

    it('should handle messages with no parts', () => {
      const msg = createAssistantMessage(); // empty parts
      const tokens = Compaction.estimateTokens([msg]);
      expect(tokens).toBe(0);
    });
  });

  // ===========================================================================
  // shouldPrune
  // ===========================================================================

  describe('shouldPrune', () => {
    it('should return false for empty array', () => {
      expect(Compaction.shouldPrune([])).toBe(false);
    });

    it('should return false when below minimum token threshold', () => {
      const msg = createUserMessage('Short message');
      expect(Compaction.shouldPrune([msg])).toBe(false);
    });

    it('should return true when at or above minimum token threshold', () => {
      const msg = createPaddedUserMessage(PRUNE_MINIMUM_TOKENS);
      expect(Compaction.shouldPrune([msg])).toBe(true);
    });

    it('should return true when multiple messages exceed threshold together', () => {
      const half = PRUNE_MINIMUM_TOKENS / 2 + 1;
      const messages = [
        createPaddedUserMessage(half),
        createPaddedUserMessage(half),
      ];
      expect(Compaction.shouldPrune(messages)).toBe(true);
    });
  });

  // ===========================================================================
  // shouldCompact
  // ===========================================================================

  describe('shouldCompact', () => {
    it('should return false when usage is below threshold', () => {
      const usage: TokenUsage = { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 };
      expect(Compaction.shouldCompact(usage, 100_000)).toBe(false);
    });

    it('should return true when usage exceeds threshold', () => {
      const usage: TokenUsage = { promptTokens: 80_000, completionTokens: 8000, totalTokens: 88_000 };
      expect(Compaction.shouldCompact(usage, 100_000)).toBe(true);
    });

    it('should return true at exactly the threshold', () => {
      const contextLimit = 100_000;
      const threshold = contextLimit * COMPACT_THRESHOLD; // 85_000
      const usage: TokenUsage = { promptTokens: threshold, completionTokens: 0, totalTokens: threshold };
      expect(Compaction.shouldCompact(usage, contextLimit)).toBe(true);
    });

    it('should return false when contextLimit is 0', () => {
      const usage: TokenUsage = { promptTokens: 100, completionTokens: 0, totalTokens: 100 };
      expect(Compaction.shouldCompact(usage, 0)).toBe(false);
    });

    it('should return false when contextLimit is negative', () => {
      const usage: TokenUsage = { promptTokens: 100, completionTokens: 0, totalTokens: 100 };
      expect(Compaction.shouldCompact(usage, -1000)).toBe(false);
    });
  });

  // ===========================================================================
  // prune
  // ===========================================================================

  describe('prune', () => {
    it('should return empty result for empty messages', () => {
      const result = Compaction.prune([]);
      expect(result.messages).toEqual([]);
      expect(result.prunedCount).toBe(0);
      expect(result.estimatedTokensSaved).toBe(0);
    });

    it('should not mutate the original messages array', () => {
      const bigData = { items: Array(500).fill('verbose data payload') };
      const original = [
        createToolResultMessage(bigData),
        createPaddedUserMessage(PRUNE_PROTECT_TOKENS + 100),
      ];

      // Deep-snapshot the original tool_result data before pruning.
      const originalData = JSON.parse(
        JSON.stringify((original[0].parts[0] as { data: unknown }).data),
      );

      Compaction.prune(original);

      // Original should be untouched.
      expect((original[0].parts[0] as { data: unknown }).data).toEqual(originalData);
    });

    it('should protect recent messages within the token budget', () => {
      // Create an old message with tool data and a recent protected message.
      const bigData = { tracks: Array(200).fill({ id: 'track', clips: ['a', 'b'] }) };
      const oldMsg = createToolResultMessage(bigData);
      const recentMsg = createPaddedUserMessage(PRUNE_PROTECT_TOKENS - 100);

      const messages = [oldMsg, recentMsg];
      const result = Compaction.prune(messages);

      // The old message's tool_result data should be pruned.
      const toolResult = result.messages[0].parts[0] as { type: string; data: unknown };
      expect(toolResult.data).toBe('[pruned]');

      // The recent message should be untouched (its text preserved).
      const recentText = result.messages[1].parts[0] as { type: string; content: string };
      expect(recentText.content.length).toBe((PRUNE_PROTECT_TOKENS - 100) * CHARS_PER_TOKEN);
    });

    it('should replace tool_result data with [pruned] for old messages', () => {
      const messages = [
        createToolResultMessage({ verbose: 'data', nested: { deep: true } }),
        createPaddedUserMessage(PRUNE_PROTECT_TOKENS + 100),
      ];

      const result = Compaction.prune(messages);

      const toolPart = result.messages[0].parts[0] as { data: unknown };
      expect(toolPart.data).toBe('[pruned]');
      expect(result.prunedCount).toBeGreaterThanOrEqual(1);
    });

    it('should remove thinking parts from old messages', () => {
      const messages = [
        createThinkingMessage(),
        createPaddedUserMessage(PRUNE_PROTECT_TOKENS + 100),
      ];

      const result = Compaction.prune(messages);

      // The thinking part should be removed entirely.
      const oldMsg = result.messages[0];
      const thinkingParts = oldMsg.parts.filter((p) => p.type === 'thinking');
      expect(thinkingParts).toHaveLength(0);
      expect(result.prunedCount).toBeGreaterThanOrEqual(1);
    });

    it('should not prune tool_result data that is already [pruned]', () => {
      const msg = createAssistantMessage();
      msg.parts = [createToolResultPart('s1', 'test_tool', true, 50, '[pruned]')];

      const messages = [msg, createPaddedUserMessage(PRUNE_PROTECT_TOKENS + 100)];
      const result = Compaction.prune(messages);

      const toolPart = result.messages[0].parts[0] as { data: unknown };
      expect(toolPart.data).toBe('[pruned]');
      // Already-pruned should not count again.
      expect(result.prunedCount).toBe(0);
    });

    it('should not prune tool_result with undefined data', () => {
      const msg = createAssistantMessage();
      msg.parts = [createToolResultPart('s1', 'test_tool', false, 50, undefined, 'Error occurred')];

      const messages = [msg, createPaddedUserMessage(PRUNE_PROTECT_TOKENS + 100)];
      const result = Compaction.prune(messages);

      const toolPart = result.messages[0].parts[0] as { data: unknown };
      expect(toolPart.data).toBeUndefined();
    });

    it('should preserve non-tool, non-thinking parts in old messages', () => {
      const msg = createAssistantMessage();
      msg.parts = [
        createTextPart('I will help you edit the video.'),
        createThinkingPart(createTestThought()),
        createToolCallPart(createTestStep()),
        createToolResultPart('s1', 'split_clip', true, 100, { clipId: 'new_clip' }),
        createErrorPart('WARN', 'Minor warning', 'observing', true),
      ];

      const messages = [msg, createPaddedUserMessage(PRUNE_PROTECT_TOKENS + 100)];
      const result = Compaction.prune(messages);

      const prunedMsg = result.messages[0];
      const types = prunedMsg.parts.map((p) => p.type);

      // Thinking should be removed; text, tool_call, tool_result, error should remain.
      expect(types).toContain('text');
      expect(types).toContain('tool_call');
      expect(types).toContain('tool_result');
      expect(types).toContain('error');
      expect(types).not.toContain('thinking');
    });

    it('should report estimated tokens saved', () => {
      const bigData = { payload: 'x'.repeat(10_000) };
      const messages = [
        createToolResultMessage(bigData),
        createPaddedUserMessage(PRUNE_PROTECT_TOKENS + 100),
      ];

      const result = Compaction.prune(messages);
      expect(result.estimatedTokensSaved).toBeGreaterThan(0);
    });

    it('should handle all messages being within the protect window', () => {
      const messages = [
        createUserMessage('Hello'),
        createUserMessage('World'),
      ];

      const result = Compaction.prune(messages);

      // Nothing to prune when everything is protected.
      expect(result.prunedCount).toBe(0);
      expect(result.estimatedTokensSaved).toBe(0);
      expect(result.messages).toHaveLength(2);
    });

    it('should handle a single message', () => {
      const msg = createUserMessage('Just one message');
      const result = Compaction.prune([msg]);
      expect(result.messages).toHaveLength(1);
      expect(result.prunedCount).toBe(0);
    });

    it('should prune multiple old tool results across multiple messages', () => {
      const messages = [
        createToolResultMessage({ data1: 'a'.repeat(500) }),
        createToolResultMessage({ data2: 'b'.repeat(500) }),
        createThinkingMessage(),
        createPaddedUserMessage(PRUNE_PROTECT_TOKENS + 100),
      ];

      const result = Compaction.prune(messages);

      // Two tool_results + one thinking part = 3 pruned items.
      expect(result.prunedCount).toBe(3);

      // Verify both tool results are pruned.
      const msg0ToolPart = result.messages[0].parts[0] as { data: unknown };
      const msg1ToolPart = result.messages[1].parts[0] as { data: unknown };
      expect(msg0ToolPart.data).toBe('[pruned]');
      expect(msg1ToolPart.data).toBe('[pruned]');

      // Thinking message should have its thinking part removed.
      const thinkingMsgParts = result.messages[2].parts;
      expect(thinkingMsgParts.filter((p) => p.type === 'thinking')).toHaveLength(0);
    });
  });

  // ===========================================================================
  // compact
  // ===========================================================================

  describe('compact', () => {
    let mockLLM: MockLLMAdapter;

    beforeEach(() => {
      mockLLM = createMockLLMAdapter();
    });

    it('should return empty result for empty messages', async () => {
      const result = await Compaction.compact([], mockLLM, 100_000);
      expect(result.messages).toEqual([]);
      expect(result.summary).toBe('');
      expect(result.originalMessageCount).toBe(0);
      expect(result.estimatedTokensSaved).toBe(0);
    });

    it('should produce a single system message with the summary', async () => {
      mockLLM.setCompleteResponse({
        content: '## Goal\nEdit the video\n\n## Accomplished\n- Split clip at 5s',
      });

      const messages = createMinimalConversation();
      const result = await Compaction.compact(messages, mockLLM, 100_000);

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].role).toBe('system');
      expect(result.messages[0].parts[0]).toMatchObject({
        type: 'text',
        content: expect.stringContaining('[Conversation Summary]'),
      });
    });

    it('should include the LLM summary in the result', async () => {
      const summaryText = '## Goal\nTrim the timeline\n\n## In Progress\nRendering export';
      mockLLM.setCompleteResponse({ content: summaryText });

      const messages = createMinimalConversation();
      const result = await Compaction.compact(messages, mockLLM, 100_000);

      expect(result.summary).toBe(summaryText);
      expect(result.messages[0].parts[0]).toMatchObject({
        type: 'text',
        content: expect.stringContaining(summaryText),
      });
    });

    it('should report the original message count', async () => {
      mockLLM.setCompleteResponse({ content: 'Summary' });

      const messages = createMinimalConversation();
      const result = await Compaction.compact(messages, mockLLM, 100_000);

      expect(result.originalMessageCount).toBe(messages.length);
    });

    it('should report estimated tokens saved', async () => {
      mockLLM.setCompleteResponse({ content: 'Short summary' });

      const messages = [
        createUserMessage('x'.repeat(10_000)),
        createToolResultMessage({ big: 'y'.repeat(10_000) }),
        createUserMessage('z'.repeat(10_000)),
      ];

      const result = await Compaction.compact(messages, mockLLM, 100_000);

      expect(result.estimatedTokensSaved).toBeGreaterThan(0);
    });

    it('should send the conversation transcript to the LLM', async () => {
      mockLLM.setCompleteResponse({ content: 'Summary here' });

      const messages = [
        createUserMessage('Split clip at 5s'),
        createAssistantMessage(),
      ];
      messages[1].parts = [createTextPart('I will split the clip now.')];

      await Compaction.compact(messages, mockLLM, 100_000);

      const request = mockLLM.getLastRequest();
      expect(request).toBeDefined();
      expect(request!.type).toBe('complete');
      expect(request!.messages).toHaveLength(2); // system prompt + user transcript

      // The system message should contain the summary prompt template.
      expect(request!.messages[0].role).toBe('system');
      expect(request!.messages[0].content).toContain('video editing assistant');

      // The user message should contain the transcript.
      expect(request!.messages[1].role).toBe('user');
      expect(request!.messages[1].content).toContain('Split clip at 5s');
      expect(request!.messages[1].content).toContain('I will split the clip now.');
    });

    it('should use conservative generation options', async () => {
      mockLLM.setCompleteResponse({ content: 'Summary' });

      await Compaction.compact(createMinimalConversation(), mockLLM, 100_000);

      const request = mockLLM.getLastRequest();
      expect(request!.options).toBeDefined();
      expect(request!.options!.temperature).toBe(0.3);
      expect(request!.options!.maxTokens).toBeLessThanOrEqual(2048);
    });

    it('should cap maxTokens at 10% of context limit', async () => {
      mockLLM.setCompleteResponse({ content: 'Summary' });

      await Compaction.compact(createMinimalConversation(), mockLLM, 8000);

      const request = mockLLM.getLastRequest();
      // 10% of 8000 = 800, which is less than 2048, so it should be 800.
      expect(request!.options!.maxTokens).toBe(800);
    });

    it('should propagate LLM errors', async () => {
      mockLLM.setCompleteResponse({ error: new Error('API rate limit exceeded') });

      await expect(
        Compaction.compact(createMinimalConversation(), mockLLM, 100_000),
      ).rejects.toThrow('API rate limit exceeded');
    });

    it('should handle single-message conversations', async () => {
      mockLLM.setCompleteResponse({ content: 'User asked a question.' });

      const result = await Compaction.compact(
        [createUserMessage('What tools are available?')],
        mockLLM,
        100_000,
      );

      expect(result.messages).toHaveLength(1);
      expect(result.originalMessageCount).toBe(1);
    });

    it('should handle messages with multiple part types', async () => {
      mockLLM.setCompleteResponse({ content: 'Complex conversation summary' });

      const assistantMsg = createAssistantMessage();
      assistantMsg.parts = [
        createTextPart('Let me help.'),
        createThinkingPart(createTestThought()),
        createToolCallPart(createTestStep()),
        createToolResultPart('s1', 'split_clip', true, 100, { clipId: 'new_clip' }),
      ];

      const messages = [
        createUserMessage('Split the clip'),
        assistantMsg,
        createUserMessage('Great, now trim it'),
      ];

      const result = await Compaction.compact(messages, mockLLM, 100_000);
      expect(result.messages).toHaveLength(1);
      expect(result.summary).toBe('Complex conversation summary');
    });
  });

  // ===========================================================================
  // Integration: prune then compact
  // ===========================================================================

  describe('prune + compact integration', () => {
    let mockLLM: MockLLMAdapter;

    beforeEach(() => {
      mockLLM = createMockLLMAdapter();
    });

    it('should allow pruning before compaction for maximum savings', async () => {
      mockLLM.setCompleteResponse({ content: 'Pruned and compacted summary' });

      const messages = [
        createToolResultMessage({ huge: 'x'.repeat(5000) }),
        createThinkingMessage(),
        createToolResultMessage({ another: 'y'.repeat(5000) }),
        createPaddedUserMessage(PRUNE_PROTECT_TOKENS + 100),
      ];

      // Step 1: Prune.
      const pruneResult = Compaction.prune(messages);
      expect(pruneResult.prunedCount).toBeGreaterThan(0);
      expect(pruneResult.estimatedTokensSaved).toBeGreaterThan(0);

      // Step 2: Compact the pruned messages.
      const compactResult = await Compaction.compact(
        pruneResult.messages,
        mockLLM,
        100_000,
      );
      expect(compactResult.messages).toHaveLength(1);
      expect(compactResult.summary).toBe('Pruned and compacted summary');
    });
  });

  // ===========================================================================
  // Constants validation
  // ===========================================================================

  describe('constants', () => {
    it('should have sensible default values', () => {
      expect(PRUNE_PROTECT_TOKENS).toBe(40_000);
      expect(PRUNE_MINIMUM_TOKENS).toBe(20_000);
      expect(COMPACT_THRESHOLD).toBe(0.85);
      expect(CHARS_PER_TOKEN).toBe(4);
    });

    it('should have protect window larger than minimum prune threshold', () => {
      expect(PRUNE_PROTECT_TOKENS).toBeGreaterThan(PRUNE_MINIMUM_TOKENS);
    });

    it('should have compact threshold between 0 and 1', () => {
      expect(COMPACT_THRESHOLD).toBeGreaterThan(0);
      expect(COMPACT_THRESHOLD).toBeLessThanOrEqual(1);
    });
  });
});
