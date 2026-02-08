/**
 * Thinker Phase Tests
 *
 * Tests for the Think phase of the agentic loop.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Thinker, createThinker } from './Thinker';
import {
  createMockLLMAdapter,
  type MockLLMAdapter,
} from '../adapters/llm/MockLLMAdapter';
import {
  createEmptyContext,
  type AgentContext,
  type Thought,
} from '../core/types';
import { ThinkingTimeoutError, UnderstandingError } from '../core/errors';

describe('Thinker', () => {
  let thinker: Thinker;
  let mockLLM: MockLLMAdapter;
  let context: AgentContext;

  beforeEach(() => {
    mockLLM = createMockLLMAdapter();
    thinker = createThinker(mockLLM);
    context = createEmptyContext('project-1');
    context.availableTools = ['split_clip', 'move_clip', 'delete_clip'];
  });

  describe('think', () => {
    it('should analyze clear user intent', async () => {
      mockLLM.setStructuredResponse({
        structured: {
          understanding: 'User wants to split a clip at 5 seconds',
          requirements: ['Need clip ID', 'Need position'],
          uncertainties: [],
          approach: 'Use split_clip tool at position 5',
          needsMoreInfo: false,
        } as Thought,
      });

      const result = await thinker.think(
        'Split the clip at 5 seconds',
        context
      );

      expect(result.understanding).toContain('split');
      expect(result.needsMoreInfo).toBe(false);
      expect(result.uncertainties).toHaveLength(0);
    });

    it('should identify uncertainties in ambiguous input', async () => {
      mockLLM.setStructuredResponse({
        structured: {
          understanding: 'User wants to do something with a clip',
          requirements: ['Clip identification', 'Action type'],
          uncertainties: ['Which clip?', 'What action?'],
          approach: 'Need to clarify with user',
          needsMoreInfo: true,
          clarificationQuestion: 'Which clip would you like me to work with?',
        } as Thought,
      });

      const result = await thinker.think('Do something with the clip', context);

      expect(result.needsMoreInfo).toBe(true);
      expect(result.uncertainties.length).toBeGreaterThan(0);
      expect(result.clarificationQuestion).toBeDefined();
    });

    it('should include requirements for complex tasks', async () => {
      mockLLM.setStructuredResponse({
        structured: {
          understanding: 'User wants to cut first 5 seconds and move to end',
          requirements: [
            'Timeline information',
            'First clip identification',
            'Split capability',
            'Move capability',
          ],
          uncertainties: [],
          approach: 'Split at 5s, then move the split portion to end',
          needsMoreInfo: false,
        } as Thought,
      });

      const result = await thinker.think(
        'Cut the first 5 seconds and move it to the end',
        context
      );

      expect(result.requirements.length).toBeGreaterThanOrEqual(2);
    });

    it('should pass context to LLM', async () => {
      mockLLM.setStructuredResponse({
        structured: {
          understanding: 'test',
          requirements: [],
          uncertainties: [],
          approach: 'test',
          needsMoreInfo: false,
        } as Thought,
      });

      context.selectedClips = ['clip-1', 'clip-2'];
      context.playheadPosition = 10.5;

      await thinker.think('test input', context);

      const request = mockLLM.getLastRequest();
      expect(request).toBeDefined();

      // Check that context is included in messages
      const systemMessage = request?.messages.find((m) => m.role === 'system');
      expect(systemMessage?.content).toContain('clip-1');
      expect(systemMessage?.content).toContain('10.5');
    });

    it('should include available tools in context', async () => {
      mockLLM.setStructuredResponse({
        structured: {
          understanding: 'test',
          requirements: [],
          uncertainties: [],
          approach: 'test',
          needsMoreInfo: false,
        } as Thought,
      });

      await thinker.think('test input', context);

      const request = mockLLM.getLastRequest();
      const systemMessage = request?.messages.find((m) => m.role === 'system');

      expect(systemMessage?.content).toContain('split_clip');
      expect(systemMessage?.content).toContain('move_clip');
    });
  });

  describe('thinkWithStreaming', () => {
    it('should emit progress events', async () => {
      mockLLM.setStreamResponse({
        content: 'Analyzing user intent...',
        chunkSize: 10,
      });

      mockLLM.setStructuredResponse({
        structured: {
          understanding: 'test',
          requirements: [],
          uncertainties: [],
          approach: 'test',
          needsMoreInfo: false,
        } as Thought,
      });

      const progressChunks: string[] = [];

      const result = await thinker.thinkWithStreaming(
        'test input',
        context,
        (chunk) => progressChunks.push(chunk)
      );

      expect(progressChunks.length).toBeGreaterThan(0);
      expect(result).toBeDefined();
    });
  });

  describe('error handling', () => {
    it('should throw ThinkingTimeoutError on timeout', async () => {
      const shortTimeoutThinker = createThinker(mockLLM, { timeout: 10 });

      mockLLM.setStructuredResponse({
        structured: {
          understanding: 'test',
          requirements: [],
          uncertainties: [],
          approach: 'test',
          needsMoreInfo: false,
        },
        delay: 100,
      });

      await expect(
        shortTimeoutThinker.think('test', context)
      ).rejects.toThrow(ThinkingTimeoutError);
    });

    it('should throw UnderstandingError on LLM error', async () => {
      mockLLM.setStructuredResponse({
        error: new Error('LLM API error'),
      });

      await expect(thinker.think('test', context)).rejects.toThrow(
        UnderstandingError
      );
    });

    it('should handle malformed LLM response', async () => {
      mockLLM.setStructuredResponse({
        structured: { invalid: 'response' },
      });

      await expect(thinker.think('test', context)).rejects.toThrow();
    });
  });

  describe('abort', () => {
    it('should abort ongoing thinking', async () => {
      mockLLM.setStructuredResponse({
        structured: {
          understanding: 'test',
          requirements: [],
          uncertainties: [],
          approach: 'test',
          needsMoreInfo: false,
        },
        delay: 1000,
      });

      const promise = thinker.think('test', context);

      // Abort after short delay
      setTimeout(() => thinker.abort(), 10);

      await expect(promise).rejects.toThrow();
    });
  });

  describe('configuration', () => {
    it('should use custom timeout', async () => {
      const customThinker = createThinker(mockLLM, { timeout: 5000 });

      mockLLM.setStructuredResponse({
        structured: {
          understanding: 'test',
          requirements: [],
          uncertainties: [],
          approach: 'test',
          needsMoreInfo: false,
        },
      });

      const result = await customThinker.think('test', context);
      expect(result).toBeDefined();
    });

    it('should use custom system prompt', async () => {
      const customThinker = createThinker(mockLLM, {
        systemPromptOverride: 'Custom system prompt',
      });

      mockLLM.setStructuredResponse({
        structured: {
          understanding: 'test',
          requirements: [],
          uncertainties: [],
          approach: 'test',
          needsMoreInfo: false,
        },
      });

      await customThinker.think('test', context);

      const request = mockLLM.getLastRequest();
      const systemMessage = request?.messages.find((m) => m.role === 'system');
      expect(systemMessage?.content).toContain('Custom system prompt');
    });
  });

  describe('conversation history', () => {
    it('should include history messages between system prompt and user input', async () => {
      mockLLM.setStructuredResponse({
        structured: {
          understanding: 'Follow-up to previous request',
          requirements: [],
          uncertainties: [],
          approach: 'Continue previous work',
          needsMoreInfo: false,
        } as Thought,
      });

      const history = [
        { role: 'user' as const, content: 'Split the clip at 5 seconds' },
        { role: 'assistant' as const, content: 'Done! I split clip_001 at 5s.' },
      ];

      await thinker.think('Now move the second half to the end', context, history);

      const request = mockLLM.getLastRequest();
      expect(request).toBeDefined();
      const messages = request!.messages;

      // System prompt first
      expect(messages[0].role).toBe('system');
      // Then history
      expect(messages[1].role).toBe('user');
      expect(messages[1].content).toBe('Split the clip at 5 seconds');
      expect(messages[2].role).toBe('assistant');
      expect(messages[2].content).toBe('Done! I split clip_001 at 5s.');
      // Then current input
      expect(messages[3].role).toBe('user');
      expect(messages[3].content).toBe('Now move the second half to the end');
    });

    it('should work without history (backward compatible)', async () => {
      mockLLM.setStructuredResponse({
        structured: {
          understanding: 'test',
          requirements: [],
          uncertainties: [],
          approach: 'test',
          needsMoreInfo: false,
        } as Thought,
      });

      await thinker.think('test', context);

      const request = mockLLM.getLastRequest();
      expect(request!.messages).toHaveLength(2); // system + user
    });

    it('should handle empty history array', async () => {
      mockLLM.setStructuredResponse({
        structured: {
          understanding: 'test',
          requirements: [],
          uncertainties: [],
          approach: 'test',
          needsMoreInfo: false,
        } as Thought,
      });

      await thinker.think('test', context, []);

      const request = mockLLM.getLastRequest();
      expect(request!.messages).toHaveLength(2); // system + user
    });
  });

  describe('thought validation', () => {
    it('should validate thought has required fields', async () => {
      mockLLM.setStructuredResponse({
        structured: {
          understanding: 'Valid understanding',
          requirements: ['req1'],
          uncertainties: [],
          approach: 'Valid approach',
          needsMoreInfo: false,
        } as Thought,
      });

      const result = await thinker.think('test', context);

      expect(result.understanding).toBeDefined();
      expect(result.requirements).toBeInstanceOf(Array);
      expect(result.uncertainties).toBeInstanceOf(Array);
      expect(result.approach).toBeDefined();
      expect(typeof result.needsMoreInfo).toBe('boolean');
    });

    it('should have clarification question when needsMoreInfo is true', async () => {
      mockLLM.setStructuredResponse({
        structured: {
          understanding: 'Unclear',
          requirements: [],
          uncertainties: ['What clip?'],
          approach: 'Need clarification',
          needsMoreInfo: true,
          clarificationQuestion: 'Which clip?',
        } as Thought,
      });

      const result = await thinker.think('do something', context);

      expect(result.needsMoreInfo).toBe(true);
      expect(result.clarificationQuestion).toBeDefined();
    });
  });
});
