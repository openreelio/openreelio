/**
 * TauriLLMAdapter Tests
 *
 * Tests for the Tauri-based LLM adapter that bridges
 * to the backend AI gateway.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { TauriLLMAdapter, createTauriLLMAdapter } from './TauriLLMAdapter';
import type { LLMMessage } from '../../ports/ILLMClient';

// Mock Tauri invoke
const mockInvoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

describe('TauriLLMAdapter', () => {
  let adapter: TauriLLMAdapter;

  beforeEach(() => {
    mockInvoke.mockReset();
    adapter = createTauriLLMAdapter();
  });

  afterEach(() => {
    adapter.abort();
  });

  describe('provider', () => {
    it('should have correct provider name', () => {
      expect(adapter.provider).toBe('tauri');
    });
  });

  describe('isConfigured', () => {
    it('should return true when backend provider is configured', async () => {
      mockInvoke.mockResolvedValueOnce({
        isConfigured: true,
        isAvailable: true,
        currentModel: 'gpt-4',
      });

      // Must refresh status first to get the value from backend
      await adapter.refreshStatus();
      const configured = adapter.isConfigured();
      expect(configured).toBe(true);
    });

    it('should check backend status on first call', async () => {
      mockInvoke.mockResolvedValueOnce({
        isConfigured: true,
        isAvailable: true,
      });

      // Initial state before any check
      expect(adapter.isConfigured()).toBe(false);

      // After refresh
      await adapter.refreshStatus();
      expect(adapter.isConfigured()).toBe(true);
    });

    it('should attempt vault sync when status is not configured', async () => {
      mockInvoke
        .mockResolvedValueOnce({
          providerType: 'openai',
          isConfigured: false,
          isAvailable: false,
          currentModel: null,
          availableModels: [],
          errorMessage: 'not configured',
        })
        .mockResolvedValueOnce({
          providerType: 'openai',
          isConfigured: true,
          isAvailable: true,
          currentModel: 'gpt-4.1-mini',
          availableModels: ['gpt-4.1-mini'],
          errorMessage: null,
        });

      const status = await adapter.refreshStatus();

      expect(mockInvoke).toHaveBeenNthCalledWith(1, 'get_ai_provider_status');
      expect(mockInvoke).toHaveBeenNthCalledWith(2, 'sync_ai_from_vault');
      expect(status.isConfigured).toBe(true);
      expect(adapter.isConfigured()).toBe(true);
    });

    it('should return original status when vault sync fails', async () => {
      mockInvoke
        .mockResolvedValueOnce({
          providerType: 'openai',
          isConfigured: false,
          isAvailable: false,
          currentModel: null,
          availableModels: [],
          errorMessage: 'not configured',
        })
        .mockRejectedValueOnce(new Error('vault unavailable'));

      const status = await adapter.refreshStatus();

      expect(status.isConfigured).toBe(false);
      expect(adapter.isConfigured()).toBe(false);
    });
  });

  describe('complete', () => {
    it('should call backend chat_with_ai command', async () => {
      mockInvoke.mockResolvedValueOnce({
        message: 'Hello! How can I help you?',
        actions: null,
        needsConfirmation: false,
      });

      const messages: LLMMessage[] = [{ role: 'user', content: 'Hello' }];

      const result = await adapter.complete(messages);

      expect(mockInvoke).toHaveBeenCalledWith(
        'chat_with_ai',
        expect.objectContaining({
          messages: expect.arrayContaining([
            expect.objectContaining({ role: 'user', content: 'Hello' }),
          ]),
        }),
      );
      expect(result.content).toBe('Hello! How can I help you?');
      expect(result.finishReason).toBe('stop');
    });

    it('should include context in the request', async () => {
      mockInvoke.mockResolvedValueOnce({
        message: 'I see you have clips selected.',
        actions: null,
      });

      const messages: LLMMessage[] = [{ role: 'user', content: 'What do I have selected?' }];

      await adapter.complete(messages, {
        systemPrompt: 'You are a helpful assistant.',
      });

      expect(mockInvoke).toHaveBeenCalledWith(
        'chat_with_ai',
        expect.objectContaining({
          context: expect.any(Object),
        }),
      );
    });

    it('should handle backend errors', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('No provider configured'));

      const messages: LLMMessage[] = [{ role: 'user', content: 'Hello' }];

      await expect(adapter.complete(messages)).rejects.toThrow('No provider configured');
    });

    it('should return tool calls when response has actions', async () => {
      mockInvoke.mockResolvedValueOnce({
        message: 'I will split the clip at 5 seconds.',
        actions: [
          {
            commandType: 'SplitClip',
            params: { clipId: 'clip-1', atTimelineSec: 5 },
            description: 'Split clip at 5 seconds',
          },
        ],
        needsConfirmation: true,
      });

      const messages: LLMMessage[] = [{ role: 'user', content: 'Split the clip at 5 seconds' }];

      const result = await adapter.complete(messages);

      expect(result.content).toBe('I will split the clip at 5 seconds.');
      expect(result.finishReason).toBe('tool_call');
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls![0].name).toBe('SplitClip');
    });
  });

  describe('generateStream', () => {
    it('should yield content in chunks', async () => {
      mockInvoke.mockResolvedValueOnce({
        message: 'This is the complete response.',
        actions: null,
      });

      const messages: LLMMessage[] = [{ role: 'user', content: 'Hello' }];

      const chunks: string[] = [];
      for await (const chunk of adapter.generateStream(messages)) {
        chunks.push(chunk);
      }

      // Since backend doesn't support streaming, we simulate by chunking
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks.join('')).toBe('This is the complete response.');
    });

    it('should handle abort during stream', async () => {
      mockInvoke.mockImplementation(
        () =>
          new Promise((resolve) =>
            setTimeout(
              () =>
                resolve({
                  message: 'Long response',
                  actions: null,
                }),
              100,
            ),
          ),
      );

      const messages: LLMMessage[] = [{ role: 'user', content: 'Hello' }];

      const chunks: string[] = [];
      const generator = adapter.generateStream(messages);

      // Abort after starting
      setTimeout(() => adapter.abort(), 10);

      try {
        for await (const chunk of generator) {
          chunks.push(chunk);
        }
      } catch {
        // Expected to be aborted
      }

      // Should have been aborted
      expect(adapter.isGenerating()).toBe(false);
    });
  });

  describe('generateWithTools', () => {
    it('should call backend and yield events', async () => {
      mockInvoke.mockResolvedValueOnce({
        message: 'I found 2 clips.',
        actions: null,
      });

      const messages: LLMMessage[] = [{ role: 'user', content: 'List the clips' }];

      const events: unknown[] = [];
      for await (const event of adapter.generateWithTools(messages, [])) {
        events.push(event);
      }

      expect(events.some((e) => (e as { type: string }).type === 'text')).toBe(true);
      expect(events.some((e) => (e as { type: string }).type === 'done')).toBe(true);
    });

    it('should yield tool_call events when response has actions', async () => {
      mockInvoke.mockResolvedValueOnce({
        message: 'Splitting clip...',
        actions: [
          {
            commandType: 'SplitClip',
            params: { clipId: 'clip-1', atTimelineSec: 5 },
          },
        ],
      });

      const messages: LLMMessage[] = [{ role: 'user', content: 'Split at 5s' }];

      const events: unknown[] = [];
      for await (const event of adapter.generateWithTools(messages, [])) {
        events.push(event);
      }

      const toolCallEvent = events.find((e) => (e as { type: string }).type === 'tool_call');
      expect(toolCallEvent).toBeDefined();
      expect((toolCallEvent as { name: string }).name).toBe('SplitClip');
    });
  });

  describe('generateStructured', () => {
    it('should parse structured response from message', async () => {
      mockInvoke.mockResolvedValueOnce({
        text: JSON.stringify({
          understanding: 'User wants to split a clip',
          requirements: ['clipId', 'position'],
          uncertainties: [],
          approach: 'Use SplitClip command',
          needsMoreInfo: false,
        }),
        model: 'gpt-4',
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
        finishReason: 'stop',
      });

      const messages: LLMMessage[] = [{ role: 'user', content: 'Split the clip' }];

      const schema = {
        type: 'object',
        properties: {
          understanding: { type: 'string' },
          needsMoreInfo: { type: 'boolean' },
        },
      };

      const result = await adapter.generateStructured<{
        understanding: string;
        needsMoreInfo: boolean;
      }>(messages, schema);

      expect(result.understanding).toBe('User wants to split a clip');
      expect(result.needsMoreInfo).toBe(false);
    });

    it('should throw on invalid JSON response', async () => {
      mockInvoke.mockResolvedValueOnce({
        text: 'This is not JSON',
        model: 'gpt-4',
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
        finishReason: 'stop',
      });

      const messages: LLMMessage[] = [{ role: 'user', content: 'Hello' }];

      await expect(adapter.generateStructured(messages, { type: 'object' })).rejects.toThrow();
    });
  });

  describe('abort', () => {
    it('should stop ongoing generation', () => {
      adapter.abort();
      expect(adapter.isGenerating()).toBe(false);
    });
  });

  describe('isGenerating', () => {
    it('should return false initially', () => {
      expect(adapter.isGenerating()).toBe(false);
    });

    it('should return true during generation', async () => {
      mockInvoke.mockImplementation(
        () =>
          new Promise((resolve) =>
            setTimeout(
              () =>
                resolve({
                  message: 'Response',
                  actions: null,
                }),
              100,
            ),
          ),
      );

      const messages: LLMMessage[] = [{ role: 'user', content: 'Hello' }];

      const promise = adapter.complete(messages);

      // Check during generation
      await new Promise((r) => setTimeout(r, 10));
      expect(adapter.isGenerating()).toBe(true);

      await promise;
      expect(adapter.isGenerating()).toBe(false);
    });
  });

  describe('configuration', () => {
    it('should use custom context when provided', async () => {
      mockInvoke.mockResolvedValueOnce({
        message: 'Response',
        actions: null,
      });

      const customAdapter = createTauriLLMAdapter({
        defaultContext: {
          playheadPosition: 10,
          selectedClips: ['clip-1'],
        },
      });

      const messages: LLMMessage[] = [{ role: 'user', content: 'Hello' }];

      await customAdapter.complete(messages);

      expect(mockInvoke).toHaveBeenCalledWith(
        'chat_with_ai',
        expect.objectContaining({
          context: expect.objectContaining({
            playheadPosition: 10,
            selectedClips: ['clip-1'],
          }),
        }),
      );
    });

    it('should include preferred language in context when configured', async () => {
      mockInvoke.mockResolvedValueOnce({
        message: 'Response',
        actions: null,
      });

      const customAdapter = createTauriLLMAdapter({
        defaultContext: {
          preferredLanguage: 'ko',
        },
      });

      const messages: LLMMessage[] = [{ role: 'user', content: 'Hello' }];

      await customAdapter.complete(messages);

      expect(mockInvoke).toHaveBeenCalledWith(
        'chat_with_ai',
        expect.objectContaining({
          context: expect.objectContaining({
            preferredLanguage: 'ko',
          }),
        }),
      );
    });
  });
});
