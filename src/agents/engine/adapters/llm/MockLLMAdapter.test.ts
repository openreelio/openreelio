/**
 * MockLLMAdapter Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  MockLLMAdapter,
  createMockLLMAdapter,
  createMockLLMAdapterWithResponses,
} from './MockLLMAdapter';
import type { LLMMessage, LLMStreamEvent } from '../../ports/ILLMClient';

describe('MockLLMAdapter', () => {
  let adapter: MockLLMAdapter;

  const testMessages: LLMMessage[] = [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'Hello' },
  ];

  beforeEach(() => {
    adapter = createMockLLMAdapter();
  });

  describe('generateStream', () => {
    it('should stream content in chunks', async () => {
      adapter.setStreamResponse({ content: 'Hello world', chunkSize: 5 });

      const chunks: string[] = [];
      for await (const chunk of adapter.generateStream(testMessages)) {
        chunks.push(chunk);
      }

      expect(chunks.join('')).toBe('Hello world');
      expect(chunks.length).toBeGreaterThan(1);
    });

    it('should capture request', async () => {
      adapter.setStreamResponse({ content: 'Test' });

      for await (const chunk of adapter.generateStream(testMessages)) {
        void chunk;
      }

      const request = adapter.getLastRequest();
      expect(request).toBeDefined();
      expect(request?.type).toBe('stream');
      expect(request?.messages).toEqual(testMessages);
    });

    it('should throw error when configured', async () => {
      const error = new Error('API Error');
      adapter.setStreamResponse({ error });

      await expect(async () => {
        for await (const chunk of adapter.generateStream(testMessages)) {
          void chunk;
        }
      }).rejects.toThrow('API Error');
    });

    it('should handle abort', async () => {
      adapter.setStreamResponse({ content: 'A'.repeat(100), chunkSize: 1 });

      const chunks: string[] = [];
      const generator = adapter.generateStream(testMessages);

      for await (const chunk of generator) {
        chunks.push(chunk);
        if (chunks.length === 5) {
          adapter.abort();
        }
      }

      expect(chunks.length).toBeLessThan(100);
    });

    it('should set isGenerating during execution', async () => {
      adapter.setStreamResponse({ content: 'Test', delay: 10 });

      expect(adapter.isGenerating()).toBe(false);

      const promise = (async () => {
        for await (const chunk of adapter.generateStream(testMessages)) {
          void chunk;
          expect(adapter.isGenerating()).toBe(true);
        }
      })();

      await promise;

      expect(adapter.isGenerating()).toBe(false);
    });
  });

  describe('generateWithTools', () => {
    it('should emit text events', async () => {
      adapter.setToolsResponse({ content: 'Thinking...', chunkSize: 5 });

      const events: LLMStreamEvent[] = [];
      for await (const event of adapter.generateWithTools(testMessages, [])) {
        events.push(event);
      }

      const textEvents = events.filter((e) => e.type === 'text');
      expect(textEvents.length).toBeGreaterThan(0);
      expect(events[events.length - 1].type).toBe('done');
    });

    it('should emit tool call events', async () => {
      adapter.setToolsResponse({
        toolCalls: [
          { id: 'call-1', name: 'split_clip', args: { clipId: 'clip-1' } },
        ],
      });

      const events: LLMStreamEvent[] = [];
      for await (const event of adapter.generateWithTools(testMessages, [])) {
        events.push(event);
      }

      const toolCallEvents = events.filter((e) => e.type === 'tool_call');
      expect(toolCallEvents.length).toBe(1);
      expect((toolCallEvents[0] as any).name).toBe('split_clip');
    });

    it('should emit error event on error', async () => {
      adapter.setToolsResponse({ error: new Error('Tool error') });

      const events: LLMStreamEvent[] = [];
      for await (const event of adapter.generateWithTools(testMessages, [])) {
        events.push(event);
      }

      expect(events[0].type).toBe('error');
    });
  });

  describe('generateStructured', () => {
    it('should return structured response', async () => {
      const structured = { steps: [{ id: '1', tool: 'test' }] };
      adapter.setStructuredResponse({ structured });

      const result = await adapter.generateStructured(testMessages, {});

      expect(result).toEqual(structured);
    });

    it('should throw error when configured', async () => {
      adapter.setStructuredResponse({ error: new Error('Parse error') });

      await expect(
        adapter.generateStructured(testMessages, {})
      ).rejects.toThrow('Parse error');
    });

    it('should apply delay', async () => {
      adapter.setStructuredResponse({ structured: {}, delay: 50 });

      const start = Date.now();
      await adapter.generateStructured(testMessages, {});
      const duration = Date.now() - start;

      expect(duration).toBeGreaterThanOrEqual(45);
    });
  });

  describe('complete', () => {
    it('should return completion result', async () => {
      adapter.setCompleteResponse({ content: 'Response text' });

      const result = await adapter.complete(testMessages);

      expect(result.content).toBe('Response text');
      expect(result.finishReason).toBe('stop');
    });

    it('should return tool calls when present', async () => {
      adapter.setCompleteResponse({
        content: '',
        toolCalls: [{ id: 'call-1', name: 'test', args: {} }],
      });

      const result = await adapter.complete(testMessages);

      expect(result.finishReason).toBe('tool_call');
      expect(result.toolCalls).toHaveLength(1);
    });
  });

  describe('request capture', () => {
    it('should capture all requests', async () => {
      adapter.setStreamResponse({ content: 'a' });
      adapter.setCompleteResponse({ content: 'b' });

      for await (const chunk of adapter.generateStream(testMessages)) {
        void chunk;
      }
      await adapter.complete(testMessages);

      expect(adapter.getRequestCount()).toBe(2);
    });

    it('should clear requests', async () => {
      adapter.setStreamResponse({ content: 'a' });

      for await (const chunk of adapter.generateStream(testMessages)) {
        void chunk;
      }

      adapter.clearRequests();

      expect(adapter.getRequestCount()).toBe(0);
    });
  });

  describe('isConfigured', () => {
    it('should return true by default', () => {
      expect(adapter.isConfigured()).toBe(true);
    });

    it('should return configured value', () => {
      adapter.setConfigured(false);
      expect(adapter.isConfigured()).toBe(false);
    });
  });

  describe('reset', () => {
    it('should reset all state', async () => {
      adapter.setStreamResponse({ content: 'test' });

      for await (const chunk of adapter.generateStream(testMessages)) {
        void chunk;
      }

      adapter.reset();

      expect(adapter.getRequestCount()).toBe(0);

      // Should return empty after reset
      const chunks: string[] = [];
      for await (const chunk of adapter.generateStream(testMessages)) {
        chunks.push(chunk);
      }
      expect(chunks.join('')).toBe('');
    });
  });

  describe('factory functions', () => {
    it('should create adapter with responses', async () => {
      const mockAdapter = createMockLLMAdapterWithResponses({
        stream: { content: 'Streamed' },
        complete: { content: 'Completed' },
      });

      const chunks: string[] = [];
      for await (const chunk of mockAdapter.generateStream(testMessages)) {
        chunks.push(chunk);
      }
      expect(chunks.join('')).toBe('Streamed');

      const result = await mockAdapter.complete(testMessages);
      expect(result.content).toBe('Completed');
    });
  });
});
