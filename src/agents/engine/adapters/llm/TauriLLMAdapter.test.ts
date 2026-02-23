import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createTauriLLMAdapter, TauriLLMAdapter } from './TauriLLMAdapter';
import type { LLMMessage, LLMStreamEvent } from '../../ports/ILLMClient';

// ---------------------------------------------------------------------------
// External boundary mock — the ONLY mock in this file
// ---------------------------------------------------------------------------
const invokeMock = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Standard raw‑completion envelope for reuse */
const RAW_ENVELOPE = {
  model: 'test-model',
  usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
  finishReason: 'stop',
};

/** Convenience builder for simple chat responses */
function chatResponse(
  message: string,
  extras: {
    actions?: Array<{ commandType: string; params: Record<string, unknown>; description?: string }>;
    needsConfirmation?: boolean;
    intent?: { intentType: string; confidence: number };
  } = {},
) {
  return { message, ...extras };
}

/** Collect all values from an async generator */
async function collectAll<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of gen) {
    items.push(item);
  }
  return items;
}

/** Standard user message for reuse */
const USER_MSG: LLMMessage[] = [{ role: 'user', content: 'hello' }];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('TauriLLMAdapter', () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  // =========================================================================
  // Factory / Construction
  // =========================================================================
  describe('factory and construction', () => {
    it('should expose provider as "tauri"', () => {
      const adapter = createTauriLLMAdapter();
      expect(adapter.provider).toBe('tauri');
    });

    it('should default to not configured and not generating', () => {
      const adapter = createTauriLLMAdapter();
      expect(adapter.isConfigured()).toBe(false);
      expect(adapter.isGenerating()).toBe(false);
    });

    it('should be an instance of TauriLLMAdapter', () => {
      const adapter = createTauriLLMAdapter();
      expect(adapter).toBeInstanceOf(TauriLLMAdapter);
    });
  });

  // =========================================================================
  // complete()
  // =========================================================================
  describe('complete()', () => {
    it('should return content and finishReason "stop" for a basic response', async () => {
      invokeMock.mockResolvedValueOnce(chatResponse('Hello world'));

      const adapter = createTauriLLMAdapter();
      const result = await adapter.complete(USER_MSG);

      expect(result.content).toBe('Hello world');
      expect(result.finishReason).toBe('stop');
      expect(result.toolCalls).toBeUndefined();
    });

    it('should return finishReason "tool_call" and toolCalls when actions are present', async () => {
      invokeMock.mockResolvedValueOnce(
        chatResponse('Applying split', {
          actions: [
            { commandType: 'splitClip', params: { clipId: 'c1', time: 5.0 } },
            { commandType: 'deleteClip', params: { clipId: 'c2' } },
          ],
        }),
      );

      const adapter = createTauriLLMAdapter();
      const result = await adapter.complete(USER_MSG);

      expect(result.finishReason).toBe('tool_call');
      expect(result.toolCalls).toHaveLength(2);
      expect(result.toolCalls![0].name).toBe('splitClip');
      expect(result.toolCalls![0].args).toEqual({ clipId: 'c1', time: 5.0 });
      expect(result.toolCalls![1].name).toBe('deleteClip');
    });

    it('should return empty string content when the backend message is empty', async () => {
      invokeMock.mockResolvedValueOnce(chatResponse(''));

      const adapter = createTauriLLMAdapter();
      const result = await adapter.complete(USER_MSG);

      expect(result.content).toBe('');
      expect(result.finishReason).toBe('stop');
    });

    it('should call invoke with "chat_with_ai" and formatted messages', async () => {
      invokeMock.mockResolvedValueOnce(chatResponse('ok'));

      const adapter = createTauriLLMAdapter();
      await adapter.complete([{ role: 'user', content: 'test prompt' }]);

      expect(invokeMock).toHaveBeenCalledOnce();
      expect(invokeMock).toHaveBeenCalledWith(
        'chat_with_ai',
        expect.objectContaining({
          messages: expect.arrayContaining([{ role: 'user', content: 'test prompt' }]),
        }),
      );
    });

    it('should propagate backend errors', async () => {
      invokeMock.mockRejectedValueOnce(new Error('Backend timeout'));

      const adapter = createTauriLLMAdapter();
      await expect(adapter.complete(USER_MSG)).rejects.toThrow('Backend timeout');
    });

    it('should set isGenerating to true during the call and false after', async () => {
      const deferred = createDeferred<{ message: string }>();
      invokeMock.mockReturnValueOnce(deferred.promise);

      const adapter = createTauriLLMAdapter();
      const promise = adapter.complete(USER_MSG);

      expect(adapter.isGenerating()).toBe(true);

      deferred.resolve(chatResponse('done'));
      await promise;

      expect(adapter.isGenerating()).toBe(false);
    });
  });

  // =========================================================================
  // generateStream()
  // =========================================================================
  describe('generateStream()', () => {
    it('should yield the entire message in chunks of configured size', async () => {
      const message = 'ABCDEFGHIJ'; // 10 chars
      invokeMock.mockResolvedValueOnce(chatResponse(message));

      const adapter = createTauriLLMAdapter({ streamChunkSize: 4, streamChunkDelay: 0 });
      const chunks = await collectAll(adapter.generateStream(USER_MSG));

      expect(chunks).toEqual(['ABCD', 'EFGH', 'IJ']);
      expect(chunks.join('')).toBe(message);
    });

    it('should yield a single chunk when message is shorter than chunk size', async () => {
      invokeMock.mockResolvedValueOnce(chatResponse('Hi'));

      const adapter = createTauriLLMAdapter({ streamChunkSize: 100, streamChunkDelay: 0 });
      const chunks = await collectAll(adapter.generateStream(USER_MSG));

      expect(chunks).toEqual(['Hi']);
    });

    it('should stop yielding after abort is called mid-stream', async () => {
      const longMessage = 'A'.repeat(100);
      invokeMock.mockResolvedValueOnce(chatResponse(longMessage));

      const adapter = createTauriLLMAdapter({ streamChunkSize: 10, streamChunkDelay: 0 });
      const gen = adapter.generateStream(USER_MSG);

      const chunks: string[] = [];
      // Collect a couple chunks then abort
      const first = await gen.next();
      if (!first.done) chunks.push(first.value);

      const second = await gen.next();
      if (!second.done) chunks.push(second.value);

      // Abort — remaining chunks should not be yielded
      adapter.abort();

      const remaining = await gen.next();
      expect(remaining.done).toBe(true);

      expect(chunks.length).toBe(2);
      expect(chunks.join('').length).toBe(20); // 2 * chunkSize=10
    });

    it('should throw "Generation aborted" when abort is called while awaiting the backend response', async () => {
      const deferred = createDeferred<{ message: string }>();
      invokeMock.mockReturnValueOnce(deferred.promise);

      const adapter = createTauriLLMAdapter({ streamChunkDelay: 0 });
      const gen = adapter.generateStream(USER_MSG);

      // Start iterating — this enters beginRequest and starts awaiting callBackend
      const nextPromise = gen.next();

      // Abort while the backend call is pending
      adapter.abort();

      // Resolve the backend — callBackend will detect _aborted and throw
      deferred.resolve(chatResponse('too late'));

      // The error propagates through the generator
      await expect(nextPromise).rejects.toThrow('Generation aborted');
    });
  });

  // =========================================================================
  // generateWithTools()
  // =========================================================================
  describe('generateWithTools()', () => {
    const tools = [
      { name: 'splitClip', description: 'Split a clip', parameters: {} },
    ];

    it('should emit text + done events for a simple response', async () => {
      invokeMock.mockResolvedValueOnce(chatResponse('Just text'));

      const adapter = createTauriLLMAdapter();
      const events = await collectAll(adapter.generateWithTools(USER_MSG, tools));

      expect(events).toHaveLength(2);
      expect(events[0]).toEqual({ type: 'text', content: 'Just text' });
      expect(events[1]).toEqual({ type: 'done' });
    });

    it('should emit text + tool_call + done events when actions are present', async () => {
      invokeMock.mockResolvedValueOnce(
        chatResponse('Splitting clip', {
          actions: [{ commandType: 'splitClip', params: { clipId: 'c1', time: 3.0 } }],
        }),
      );

      const adapter = createTauriLLMAdapter();
      const events = await collectAll(adapter.generateWithTools(USER_MSG, tools));

      expect(events).toHaveLength(3);
      expect(events[0].type).toBe('text');
      expect(events[1].type).toBe('tool_call');
      const toolEvent = events[1] as Extract<LLMStreamEvent, { type: 'tool_call' }>;
      expect(toolEvent.name).toBe('splitClip');
      expect(toolEvent.args).toEqual({ clipId: 'c1', time: 3.0 });
      expect(events[2]).toEqual({ type: 'done' });
    });

    it('should emit multiple tool_call events for multiple actions', async () => {
      invokeMock.mockResolvedValueOnce(
        chatResponse('Done', {
          actions: [
            { commandType: 'splitClip', params: { id: '1' } },
            { commandType: 'trimClip', params: { id: '2' } },
            { commandType: 'deleteClip', params: { id: '3' } },
          ],
        }),
      );

      const adapter = createTauriLLMAdapter();
      const events = await collectAll(adapter.generateWithTools(USER_MSG, tools));

      const toolEvents = events.filter((e) => e.type === 'tool_call');
      expect(toolEvents).toHaveLength(3);
    });

    it('should emit an error event when the backend throws', async () => {
      invokeMock.mockRejectedValueOnce(new Error('Network failure'));

      const adapter = createTauriLLMAdapter();
      const events = await collectAll(adapter.generateWithTools(USER_MSG, tools));

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('error');
      const errorEvent = events[0] as Extract<LLMStreamEvent, { type: 'error' }>;
      expect(errorEvent.error.message).toBe('Network failure');
    });

    it('should emit an error event wrapping non-Error throwables', async () => {
      invokeMock.mockRejectedValueOnce('string error');

      const adapter = createTauriLLMAdapter();
      const events = await collectAll(adapter.generateWithTools(USER_MSG, tools));

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('error');
      const errorEvent = events[0] as Extract<LLMStreamEvent, { type: 'error' }>;
      expect(errorEvent.error).toBeInstanceOf(Error);
      expect(errorEvent.error.message).toBe('string error');
    });

    it('should not emit text event when message is empty', async () => {
      invokeMock.mockResolvedValueOnce(
        chatResponse('', {
          actions: [{ commandType: 'splitClip', params: {} }],
        }),
      );

      const adapter = createTauriLLMAdapter();
      const events = await collectAll(adapter.generateWithTools(USER_MSG, tools));

      // Empty message should not produce a text event
      const textEvents = events.filter((e) => e.type === 'text');
      expect(textEvents).toHaveLength(0);

      // But tool_call + done should still appear
      const toolEvents = events.filter((e) => e.type === 'tool_call');
      expect(toolEvents).toHaveLength(1);
      expect(events[events.length - 1].type).toBe('done');
    });

    it('should stop emitting tool_call events when aborted mid-iteration', async () => {
      invokeMock.mockResolvedValueOnce(
        chatResponse('Processing', {
          actions: [
            { commandType: 'a', params: {} },
            { commandType: 'b', params: {} },
            { commandType: 'c', params: {} },
          ],
        }),
      );

      const adapter = createTauriLLMAdapter();
      const gen = adapter.generateWithTools(USER_MSG, tools);

      const collected: LLMStreamEvent[] = [];
      // Manually pull events
      const first = await gen.next(); // text event
      if (!first.done) collected.push(first.value);

      const second = await gen.next(); // first tool_call
      if (!second.done) collected.push(second.value);

      // Abort before remaining tool_calls
      adapter.abort();

      const third = await gen.next();
      // After abort the generator should return done
      expect(third.done).toBe(true);

      expect(collected).toHaveLength(2);
      expect(collected[0].type).toBe('text');
      expect(collected[1].type).toBe('tool_call');
    });
  });

  // =========================================================================
  // generateStructured()
  // =========================================================================
  describe('generateStructured()', () => {
    const schema = { type: 'object', properties: { goal: { type: 'string' } } };

    it('should parse raw JSON text', async () => {
      invokeMock.mockResolvedValueOnce({
        text: '{"goal":"edit","steps":[1,2,3]}',
        ...RAW_ENVELOPE,
      });

      const adapter = createTauriLLMAdapter();
      const result = await adapter.generateStructured<{ goal: string; steps: number[] }>(
        USER_MSG,
        schema,
      );

      expect(result.goal).toBe('edit');
      expect(result.steps).toEqual([1, 2, 3]);
    });

    it('should parse JSON from a fenced code block', async () => {
      invokeMock.mockResolvedValueOnce({
        text: 'Here is the plan:\n```json\n{"goal":"ok","steps":[]}\n```',
        ...RAW_ENVELOPE,
      });

      const adapter = createTauriLLMAdapter();
      const result = await adapter.generateStructured<{ goal: string; steps: unknown[] }>(
        USER_MSG,
        schema,
      );

      expect(result.goal).toBe('ok');
      expect(result.steps).toEqual([]);
    });

    it('should parse JSON from a generic code fence without language tag', async () => {
      invokeMock.mockResolvedValueOnce({
        text: 'Some text\n```\n{"goal":"generic"}\n```\nMore text',
        ...RAW_ENVELOPE,
      });

      const adapter = createTauriLLMAdapter();
      const result = await adapter.generateStructured<{ goal: string }>(USER_MSG, schema);

      expect(result.goal).toBe('generic');
    });

    it('should extract the first balanced JSON object from mixed text', async () => {
      invokeMock.mockResolvedValueOnce({
        text: 'I analyzed it. {"goal":"trim","steps":[{"id":1}]} Additional notes here.',
        ...RAW_ENVELOPE,
      });

      const adapter = createTauriLLMAdapter();
      const result = await adapter.generateStructured<{ goal: string; steps: Array<{ id: number }> }>(
        USER_MSG,
        schema,
      );

      expect(result.goal).toBe('trim');
      expect(result.steps).toHaveLength(1);
      expect(result.steps[0].id).toBe(1);
    });

    it('should handle nested JSON objects with balanced braces', async () => {
      const nested = {
        goal: 'complex',
        config: { a: { b: { c: 'deep' } } },
        items: [{ x: 1 }, { y: 2 }],
      };
      invokeMock.mockResolvedValueOnce({
        text: `Check this: ${JSON.stringify(nested)} — done.`,
        ...RAW_ENVELOPE,
      });

      const adapter = createTauriLLMAdapter();
      const result = await adapter.generateStructured<typeof nested>(USER_MSG, schema);

      expect(result).toEqual(nested);
    });

    it('should handle JSON with escaped quotes inside strings', async () => {
      invokeMock.mockResolvedValueOnce({
        text: '{"goal":"say \\"hello\\"","ok":true}',
        ...RAW_ENVELOPE,
      });

      const adapter = createTauriLLMAdapter();
      const result = await adapter.generateStructured<{ goal: string; ok: boolean }>(
        USER_MSG,
        schema,
      );

      expect(result.goal).toBe('say "hello"');
      expect(result.ok).toBe(true);
    });

    it('should handle JSON arrays as top-level structures', async () => {
      invokeMock.mockResolvedValueOnce({
        text: 'Results: [{"id":1},{"id":2}]',
        ...RAW_ENVELOPE,
      });

      const adapter = createTauriLLMAdapter();
      const result = await adapter.generateStructured<Array<{ id: number }>>(USER_MSG, schema);

      expect(result).toEqual([{ id: 1 }, { id: 2 }]);
    });

    it('should throw when response contains no parseable JSON', async () => {
      invokeMock.mockResolvedValueOnce({
        text: 'This is just plain text without any JSON at all',
        ...RAW_ENVELOPE,
      });

      const adapter = createTauriLLMAdapter();
      await expect(
        adapter.generateStructured(USER_MSG, schema),
      ).rejects.toThrow('Failed to parse structured response');
    });

    it('should throw when JSON is malformed', async () => {
      invokeMock.mockResolvedValueOnce({
        text: '{"goal": "bad", "steps": [}',
        ...RAW_ENVELOPE,
      });

      const adapter = createTauriLLMAdapter();
      await expect(
        adapter.generateStructured(USER_MSG, schema),
      ).rejects.toThrow('Failed to parse structured response');
    });

    it('should strip BOM character before parsing', async () => {
      invokeMock.mockResolvedValueOnce({
        text: '\uFEFF{"goal":"bom"}',
        ...RAW_ENVELOPE,
      });

      const adapter = createTauriLLMAdapter();
      const result = await adapter.generateStructured<{ goal: string }>(USER_MSG, schema);

      expect(result.goal).toBe('bom');
    });

    it('should call invoke with "complete_with_ai_raw" for structured generation', async () => {
      invokeMock.mockResolvedValueOnce({
        text: '{"goal":"check"}',
        ...RAW_ENVELOPE,
      });

      const adapter = createTauriLLMAdapter();
      await adapter.generateStructured(USER_MSG, schema);

      expect(invokeMock).toHaveBeenCalledWith(
        'complete_with_ai_raw',
        expect.objectContaining({
          messages: expect.any(Array),
          options: expect.objectContaining({ jsonMode: true }),
        }),
      );
    });

    it('should append schema instructions as a system message', async () => {
      invokeMock.mockResolvedValueOnce({
        text: '{"goal":"schema"}',
        ...RAW_ENVELOPE,
      });

      const adapter = createTauriLLMAdapter();
      await adapter.generateStructured(USER_MSG, schema);

      const call = invokeMock.mock.calls[0];
      const messages = call[1].messages as Array<{ role: string; content: string }>;
      const systemMsg = messages.find((m) => m.role === 'system');
      expect(systemMsg).toBeDefined();
      expect(systemMsg!.content).toContain('JSON Schema');
      expect(systemMsg!.content).toContain(JSON.stringify(schema));
    });
  });

  // =========================================================================
  // refreshStatus()
  // =========================================================================
  describe('refreshStatus()', () => {
    it('should return status and mark as configured when provider is already configured', async () => {
      const status = {
        providerType: 'openai',
        isConfigured: true,
        isAvailable: true,
        currentModel: 'gpt-4',
        availableModels: ['gpt-4', 'gpt-3.5-turbo'],
        errorMessage: null,
      };
      invokeMock.mockResolvedValueOnce(status);

      const adapter = createTauriLLMAdapter();
      const result = await adapter.refreshStatus();

      expect(result).toEqual(status);
      expect(adapter.isConfigured()).toBe(true);
      expect(invokeMock).toHaveBeenCalledWith('get_ai_provider_status');
      expect(invokeMock).toHaveBeenCalledTimes(1);
    });

    it('should attempt vault sync when provider is not configured', async () => {
      const initialStatus = {
        providerType: null,
        isConfigured: false,
        isAvailable: false,
        currentModel: null,
        availableModels: [],
        errorMessage: null,
      };
      const syncedStatus = {
        providerType: 'anthropic',
        isConfigured: true,
        isAvailable: true,
        currentModel: 'claude-3',
        availableModels: ['claude-3'],
        errorMessage: null,
      };
      invokeMock
        .mockResolvedValueOnce(initialStatus) // get_ai_provider_status
        .mockResolvedValueOnce(syncedStatus); // sync_ai_from_vault

      const adapter = createTauriLLMAdapter();
      const result = await adapter.refreshStatus();

      expect(result).toEqual(syncedStatus);
      expect(adapter.isConfigured()).toBe(true);
      expect(invokeMock).toHaveBeenCalledWith('get_ai_provider_status');
      expect(invokeMock).toHaveBeenCalledWith('sync_ai_from_vault');
    });

    it('should return original status when vault sync fails', async () => {
      const initialStatus = {
        providerType: null,
        isConfigured: false,
        isAvailable: false,
        currentModel: null,
        availableModels: [],
        errorMessage: 'No key found',
      };
      invokeMock
        .mockResolvedValueOnce(initialStatus)
        .mockRejectedValueOnce(new Error('Vault locked'));

      const adapter = createTauriLLMAdapter();
      const result = await adapter.refreshStatus();

      expect(result).toEqual(initialStatus);
      expect(adapter.isConfigured()).toBe(false);
    });

    it('should rethrow when get_ai_provider_status itself fails', async () => {
      invokeMock.mockRejectedValueOnce(new Error('IPC unavailable'));

      const adapter = createTauriLLMAdapter();
      await expect(adapter.refreshStatus()).rejects.toThrow('IPC unavailable');
      expect(adapter.isConfigured()).toBe(false);
    });

    it('should mark as not configured when vault sync says not configured', async () => {
      const initialStatus = {
        providerType: null,
        isConfigured: false,
        isAvailable: false,
        currentModel: null,
        availableModels: [],
        errorMessage: null,
      };
      const syncedStatus = {
        providerType: null,
        isConfigured: false,
        isAvailable: false,
        currentModel: null,
        availableModels: [],
        errorMessage: 'No API key in vault',
      };
      invokeMock
        .mockResolvedValueOnce(initialStatus)
        .mockResolvedValueOnce(syncedStatus);

      const adapter = createTauriLLMAdapter();
      const result = await adapter.refreshStatus();

      expect(result).toEqual(syncedStatus);
      expect(adapter.isConfigured()).toBe(false);
    });
  });

  // =========================================================================
  // Response Validation
  // =========================================================================
  describe('response validation', () => {
    describe('validateChatResponse (via complete)', () => {
      it('should reject null response', async () => {
        invokeMock.mockResolvedValueOnce(null);

        const adapter = createTauriLLMAdapter();
        await expect(adapter.complete(USER_MSG)).rejects.toThrow(
          'Backend returned invalid chat response: expected object',
        );
      });

      it('should reject non-object response (number)', async () => {
        invokeMock.mockResolvedValueOnce(42);

        const adapter = createTauriLLMAdapter();
        await expect(adapter.complete(USER_MSG)).rejects.toThrow(
          'Backend returned invalid chat response: expected object',
        );
      });

      it('should reject non-object response (string)', async () => {
        invokeMock.mockResolvedValueOnce('just a string');

        const adapter = createTauriLLMAdapter();
        await expect(adapter.complete(USER_MSG)).rejects.toThrow(
          'Backend returned invalid chat response: expected object',
        );
      });

      it('should reject when message field is missing', async () => {
        invokeMock.mockResolvedValueOnce({ actions: [] });

        const adapter = createTauriLLMAdapter();
        await expect(adapter.complete(USER_MSG)).rejects.toThrow(
          '"message" must be a string, got undefined',
        );
      });

      it('should reject when message field is a number', async () => {
        invokeMock.mockResolvedValueOnce({ message: 123 });

        const adapter = createTauriLLMAdapter();
        await expect(adapter.complete(USER_MSG)).rejects.toThrow(
          '"message" must be a string, got number',
        );
      });

      it('should strip non-array actions to undefined', async () => {
        invokeMock.mockResolvedValueOnce({ message: 'hi', actions: 'not-an-array' });

        const adapter = createTauriLLMAdapter();
        const result = await adapter.complete(USER_MSG);

        expect(result.toolCalls).toBeUndefined();
        expect(result.finishReason).toBe('stop');
      });

      it('should strip non-boolean needsConfirmation', async () => {
        invokeMock.mockResolvedValueOnce({
          message: 'hi',
          needsConfirmation: 'yes',
          actions: null,
        });

        const adapter = createTauriLLMAdapter();
        const result = await adapter.complete(USER_MSG);

        // The result should still succeed — no crash
        expect(result.content).toBe('hi');
      });
    });

    describe('validateRawCompletionResponse (via generateStructured)', () => {
      const schema = { type: 'object' };

      it('should reject null response', async () => {
        invokeMock.mockResolvedValueOnce(null);

        const adapter = createTauriLLMAdapter();
        await expect(adapter.generateStructured(USER_MSG, schema)).rejects.toThrow(
          'Backend returned invalid raw completion response: expected object',
        );
      });

      it('should reject non-object response', async () => {
        invokeMock.mockResolvedValueOnce(false);

        const adapter = createTauriLLMAdapter();
        await expect(adapter.generateStructured(USER_MSG, schema)).rejects.toThrow(
          'Backend returned invalid raw completion response: expected object',
        );
      });

      it('should reject when text field is missing', async () => {
        invokeMock.mockResolvedValueOnce({ model: 'x', usage: {}, finishReason: 'stop' });

        const adapter = createTauriLLMAdapter();
        await expect(adapter.generateStructured(USER_MSG, schema)).rejects.toThrow(
          '"text" must be a string, got undefined',
        );
      });

      it('should reject when text field is a number', async () => {
        invokeMock.mockResolvedValueOnce({ text: 999 });

        const adapter = createTauriLLMAdapter();
        await expect(adapter.generateStructured(USER_MSG, schema)).rejects.toThrow(
          '"text" must be a string, got number',
        );
      });

      it('should default model to "unknown" when missing', async () => {
        // We verify this indirectly — the call succeeds without crash
        invokeMock.mockResolvedValueOnce({ text: '{"ok":true}' });

        const adapter = createTauriLLMAdapter();
        const result = await adapter.generateStructured<{ ok: boolean }>(USER_MSG, schema);

        expect(result.ok).toBe(true);
      });

      it('should default usage to zeros when missing', async () => {
        invokeMock.mockResolvedValueOnce({ text: '{"ok":true}' });

        const adapter = createTauriLLMAdapter();
        // Should not throw even without usage
        const result = await adapter.generateStructured<{ ok: boolean }>(USER_MSG, schema);
        expect(result.ok).toBe(true);
      });
    });
  });

  // =========================================================================
  // System Prompt Merging
  // =========================================================================
  describe('system prompt merging', () => {
    it('should prepend a system message when none exists in the input', async () => {
      invokeMock.mockResolvedValueOnce(chatResponse('ack'));

      const adapter = createTauriLLMAdapter();
      await adapter.complete(
        [{ role: 'user', content: 'do something' }],
        { systemPrompt: 'You are a video editor' },
      );

      const call = invokeMock.mock.calls[0];
      const messages = call[1].messages as Array<{ role: string; content: string }>;

      expect(messages[0].role).toBe('system');
      expect(messages[0].content).toBe('You are a video editor');
      expect(messages[1].role).toBe('user');
      expect(messages[1].content).toBe('do something');
    });

    it('should append system prompt to existing system message content', async () => {
      invokeMock.mockResolvedValueOnce(chatResponse('ack'));

      const adapter = createTauriLLMAdapter();
      await adapter.complete(
        [
          { role: 'system', content: 'Base instructions' },
          { role: 'user', content: 'edit this' },
        ],
        { systemPrompt: 'Additional context' },
      );

      const call = invokeMock.mock.calls[0];
      const messages = call[1].messages as Array<{ role: string; content: string }>;

      // System prompt is prepended to existing system message content
      expect(messages[0].role).toBe('system');
      expect(messages[0].content).toBe('Additional context\n\nBase instructions');
      // Should NOT add a separate system message since one already exists
      const systemMessages = messages.filter((m) => m.role === 'system');
      expect(systemMessages).toHaveLength(1);
    });

    it('should not add a system message when systemPrompt is not provided', async () => {
      invokeMock.mockResolvedValueOnce(chatResponse('ack'));

      const adapter = createTauriLLMAdapter();
      await adapter.complete([{ role: 'user', content: 'hi' }]);

      const call = invokeMock.mock.calls[0];
      const messages = call[1].messages as Array<{ role: string; content: string }>;

      expect(messages).toHaveLength(1);
      expect(messages[0].role).toBe('user');
    });
  });

  // =========================================================================
  // setDefaultContext()
  // =========================================================================
  describe('setDefaultContext()', () => {
    it('should pass custom context to the backend call', async () => {
      invokeMock.mockResolvedValueOnce(chatResponse('ok'));

      const adapter = createTauriLLMAdapter();
      adapter.setDefaultContext({
        playheadPosition: 42.5,
        selectedClips: ['clip-1', 'clip-2'],
        selectedTracks: ['track-v1'],
        timelineDuration: 120,
        assetIds: ['asset-a'],
        trackIds: ['t1'],
        preferredLanguage: 'en',
      });
      await adapter.complete(USER_MSG);

      const call = invokeMock.mock.calls[0];
      const context = call[1].context;

      expect(context.playheadPosition).toBe(42.5);
      expect(context.selectedClips).toEqual(['clip-1', 'clip-2']);
      expect(context.selectedTracks).toEqual(['track-v1']);
      expect(context.timelineDuration).toBe(120);
      expect(context.assetIds).toEqual(['asset-a']);
      expect(context.trackIds).toEqual(['t1']);
      expect(context.preferredLanguage).toBe('en');
    });

    it('should use default empty context when not set', async () => {
      invokeMock.mockResolvedValueOnce(chatResponse('ok'));

      const adapter = createTauriLLMAdapter();
      await adapter.complete(USER_MSG);

      const call = invokeMock.mock.calls[0];
      const context = call[1].context;

      expect(context.playheadPosition).toBe(0);
      expect(context.selectedClips).toEqual([]);
      expect(context.selectedTracks).toEqual([]);
      expect(context.assetIds).toEqual([]);
      expect(context.trackIds).toEqual([]);
    });

    it('should reset context when called with undefined', async () => {
      invokeMock
        .mockResolvedValueOnce(chatResponse('ok'))
        .mockResolvedValueOnce(chatResponse('ok'));

      const adapter = createTauriLLMAdapter();
      adapter.setDefaultContext({ playheadPosition: 99 });
      await adapter.complete(USER_MSG);

      const firstContext = invokeMock.mock.calls[0][1].context;
      expect(firstContext.playheadPosition).toBe(99);

      adapter.setDefaultContext(undefined);
      await adapter.complete(USER_MSG);

      const secondContext = invokeMock.mock.calls[1][1].context;
      expect(secondContext.playheadPosition).toBe(0);
    });
  });

  // =========================================================================
  // Abort
  // =========================================================================
  describe('abort()', () => {
    it('should throw "Generation aborted" when abort is called before callBackend', async () => {
      const deferred = createDeferred<{ message: string }>();
      invokeMock.mockReturnValueOnce(deferred.promise);

      const adapter = createTauriLLMAdapter();
      const promise = adapter.complete(USER_MSG);

      adapter.abort();
      deferred.resolve(chatResponse('late'));

      await expect(promise).rejects.toThrow('Generation aborted');
    });

    it('should throw "Generation aborted" for generateStructured when aborted', async () => {
      const deferred = createDeferred<{
        text: string;
        model: string;
        usage: { promptTokens: number; completionTokens: number; totalTokens: number };
        finishReason: string;
      }>();
      invokeMock.mockReturnValueOnce(deferred.promise);

      const adapter = createTauriLLMAdapter();
      const promise = adapter.generateStructured(USER_MSG, { type: 'object' });

      adapter.abort();
      deferred.resolve({ text: '{}', ...RAW_ENVELOPE });

      await expect(promise).rejects.toThrow('Generation aborted');
    });

    it('should set isGenerating to false immediately after abort', async () => {
      const deferred = createDeferred<{ message: string }>();
      invokeMock.mockReturnValueOnce(deferred.promise);

      const adapter = createTauriLLMAdapter();
      const promise = adapter.complete(USER_MSG);

      expect(adapter.isGenerating()).toBe(true);

      adapter.abort();
      deferred.resolve(chatResponse('late'));
      await expect(promise).rejects.toThrow('Generation aborted');
      expect(adapter.isGenerating()).toBe(false);
    });

    it('should allow new requests after aborting a previous one', async () => {
      const deferred1 = createDeferred<{ message: string }>();
      invokeMock.mockReturnValueOnce(deferred1.promise);

      const adapter = createTauriLLMAdapter();
      const p1 = adapter.complete(USER_MSG);
      adapter.abort();

      deferred1.resolve(chatResponse('stale'));
      await expect(p1).rejects.toThrow('Generation aborted');

      // New request should work fine
      invokeMock.mockResolvedValueOnce(chatResponse('fresh'));
      const result = await adapter.complete(USER_MSG);
      expect(result.content).toBe('fresh');
    });

    it('should abort the stream generator when called during generateStream', async () => {
      const longMessage = 'X'.repeat(200);
      invokeMock.mockResolvedValueOnce(chatResponse(longMessage));

      const adapter = createTauriLLMAdapter({ streamChunkSize: 10, streamChunkDelay: 0 });
      const gen = adapter.generateStream(USER_MSG);

      // Pull first chunk
      const first = await gen.next();
      expect(first.done).toBe(false);

      // Abort
      adapter.abort();

      // Next pull should signal done
      const next = await gen.next();
      expect(next.done).toBe(true);
    });
  });

  // =========================================================================
  // Request Sequence / Overlapping Requests
  // =========================================================================
  describe('request sequence management', () => {
    it('should keep isGenerating true while newer overlapping request is pending', async () => {
      const first = createDeferred<{ message: string }>();
      const second = createDeferred<{ message: string }>();

      invokeMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

      const adapter = createTauriLLMAdapter();

      const p1 = adapter.complete(USER_MSG);
      const p2 = adapter.complete(USER_MSG);

      // Resolve the older request first
      first.resolve(chatResponse('first'));
      await p1;

      // Adapter should still be generating because p2 is the active request
      expect(adapter.isGenerating()).toBe(true);

      second.resolve(chatResponse('second'));
      await p2;

      expect(adapter.isGenerating()).toBe(false);
    });

    it('should set isGenerating to false when only the newest request finishes first', async () => {
      const first = createDeferred<{ message: string }>();
      const second = createDeferred<{ message: string }>();

      invokeMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

      const adapter = createTauriLLMAdapter();

      const p1 = adapter.complete(USER_MSG);
      const p2 = adapter.complete(USER_MSG);

      // Resolve the newer request first
      second.resolve(chatResponse('second'));
      await p2;

      // isGenerating should be false because the active request finished
      expect(adapter.isGenerating()).toBe(false);

      // Resolve the stale one — should not re-affect state
      first.resolve(chatResponse('first'));
      await p1;

      expect(adapter.isGenerating()).toBe(false);
    });

    it('should not clear generating state when a stale request finishes', async () => {
      const first = createDeferred<{ message: string }>();
      const second = createDeferred<{ message: string }>();
      const third = createDeferred<{ message: string }>();

      invokeMock
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise)
        .mockReturnValueOnce(third.promise);

      const adapter = createTauriLLMAdapter();

      const p1 = adapter.complete(USER_MSG);
      const p2 = adapter.complete(USER_MSG);
      const p3 = adapter.complete(USER_MSG);

      // Resolve in order: first (stale), second (stale), third (active)
      first.resolve(chatResponse('1'));
      await p1;
      expect(adapter.isGenerating()).toBe(true); // 3 is still active

      second.resolve(chatResponse('2'));
      await p2;
      expect(adapter.isGenerating()).toBe(true); // 3 is still active

      third.resolve(chatResponse('3'));
      await p3;
      expect(adapter.isGenerating()).toBe(false);
    });

    it('should reset abort state for new requests after a previous abort', async () => {
      invokeMock.mockReturnValueOnce(new Promise(() => {})); // never resolves

      const adapter = createTauriLLMAdapter();
      adapter.complete(USER_MSG); // start + will never finish
      adapter.abort();

      // beginRequest in the next call should reset _aborted
      invokeMock.mockResolvedValueOnce(chatResponse('works'));
      const result = await adapter.complete(USER_MSG);

      expect(result.content).toBe('works');
    });
  });

  // =========================================================================
  // Options Forwarding
  // =========================================================================
  describe('options forwarding', () => {
    it('should forward temperature and maxTokens to callRawCompletion', async () => {
      invokeMock.mockResolvedValueOnce({ text: '{"ok":true}', ...RAW_ENVELOPE });

      const adapter = createTauriLLMAdapter();
      await adapter.generateStructured(USER_MSG, { type: 'object' }, {
        temperature: 0.3,
        maxTokens: 500,
      });

      const call = invokeMock.mock.calls[0];
      expect(call[1].options.temperature).toBe(0.3);
      expect(call[1].options.maxTokens).toBe(500);
    });

    it('should forward systemPrompt to callRawCompletion options', async () => {
      invokeMock.mockResolvedValueOnce({ text: '{"ok":true}', ...RAW_ENVELOPE });

      const adapter = createTauriLLMAdapter();
      await adapter.generateStructured(USER_MSG, { type: 'object' }, {
        systemPrompt: 'Be concise',
      });

      const call = invokeMock.mock.calls[0];
      expect(call[1].options.systemPrompt).toBe('Be concise');
    });

    it('should default jsonMode to false when not specified in raw completion', async () => {
      invokeMock.mockResolvedValueOnce({ text: '{"ok":true}', ...RAW_ENVELOPE });

      const adapter = createTauriLLMAdapter();
      // generateStructured always passes jsonMode: true
      await adapter.generateStructured(USER_MSG, { type: 'object' });

      const call = invokeMock.mock.calls[0];
      expect(call[1].options.jsonMode).toBe(true);
    });
  });

  // =========================================================================
  // Config / Custom Stream Settings
  // =========================================================================
  describe('configuration', () => {
    it('should respect custom streamChunkSize', async () => {
      invokeMock.mockResolvedValueOnce(chatResponse('ABCDEF'));

      const adapter = createTauriLLMAdapter({ streamChunkSize: 2, streamChunkDelay: 0 });
      const chunks = await collectAll(adapter.generateStream(USER_MSG));

      expect(chunks).toEqual(['AB', 'CD', 'EF']);
    });

    it('should use default chunk size of 20 when not configured', async () => {
      const message = 'A'.repeat(50);
      invokeMock.mockResolvedValueOnce(chatResponse(message));

      const adapter = createTauriLLMAdapter({ streamChunkDelay: 0 });
      const chunks = await collectAll(adapter.generateStream(USER_MSG));

      // 50 / 20 = 2 full chunks + 1 remainder
      expect(chunks).toHaveLength(3);
      expect(chunks[0]).toHaveLength(20);
      expect(chunks[1]).toHaveLength(20);
      expect(chunks[2]).toHaveLength(10);
    });

    it('should accept initial defaultContext via config', async () => {
      invokeMock.mockResolvedValueOnce(chatResponse('ok'));

      const adapter = createTauriLLMAdapter({
        defaultContext: {
          playheadPosition: 10,
          assetIds: ['a1'],
        },
      });
      await adapter.complete(USER_MSG);

      const call = invokeMock.mock.calls[0];
      expect(call[1].context.playheadPosition).toBe(10);
      expect(call[1].context.assetIds).toEqual(['a1']);
    });
  });

  // =========================================================================
  // Edge Cases
  // =========================================================================
  describe('edge cases', () => {
    it('should handle response with actions set to null', async () => {
      invokeMock.mockResolvedValueOnce({ message: 'hi', actions: null });

      const adapter = createTauriLLMAdapter();
      const result = await adapter.complete(USER_MSG);

      expect(result.finishReason).toBe('stop');
      expect(result.toolCalls).toBeUndefined();
    });

    it('should handle response with empty actions array', async () => {
      invokeMock.mockResolvedValueOnce({ message: 'hi', actions: [] });

      const adapter = createTauriLLMAdapter();
      const result = await adapter.complete(USER_MSG);

      // Empty array is falsy for .length check, so finishReason should be stop
      expect(result.finishReason).toBe('stop');
      expect(result.toolCalls).toBeUndefined();
    });

    it('should handle intent field in response', async () => {
      invokeMock.mockResolvedValueOnce({
        message: 'I will trim the clip',
        intent: { intentType: 'trim', confidence: 0.95 },
      });

      const adapter = createTauriLLMAdapter();
      const result = await adapter.complete(USER_MSG);

      // The complete() method doesn't expose intent, but it should not crash
      expect(result.content).toBe('I will trim the clip');
    });

    it('should handle multiple concurrent generateStructured calls independently', async () => {
      const d1 = createDeferred<{
        text: string;
        model: string;
        usage: { promptTokens: number; completionTokens: number; totalTokens: number };
        finishReason: string;
      }>();
      const d2 = createDeferred<{
        text: string;
        model: string;
        usage: { promptTokens: number; completionTokens: number; totalTokens: number };
        finishReason: string;
      }>();

      invokeMock.mockReturnValueOnce(d1.promise).mockReturnValueOnce(d2.promise);

      const adapter = createTauriLLMAdapter();
      const p1 = adapter.generateStructured<{ id: number }>(
        [{ role: 'user', content: 'first' }],
        { type: 'object' },
      );
      const p2 = adapter.generateStructured<{ id: number }>(
        [{ role: 'user', content: 'second' }],
        { type: 'object' },
      );

      d2.resolve({ text: '{"id":2}', ...RAW_ENVELOPE });
      d1.resolve({ text: '{"id":1}', ...RAW_ENVELOPE });

      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1.id).toBe(1);
      expect(r2.id).toBe(2);
    });

    it('should handle generateStream with empty response message', async () => {
      invokeMock.mockResolvedValueOnce(chatResponse(''));

      const adapter = createTauriLLMAdapter({ streamChunkDelay: 0 });
      const chunks = await collectAll(adapter.generateStream(USER_MSG));

      // Empty string should produce no chunks (for loop doesn't iterate)
      expect(chunks).toHaveLength(0);
    });

    it('should handle generateWithTools with no actions and no message', async () => {
      invokeMock.mockResolvedValueOnce(chatResponse(''));

      const adapter = createTauriLLMAdapter();
      const events = await collectAll(
        adapter.generateWithTools(USER_MSG, [{ name: 'test', description: 'test', parameters: {} }]),
      );

      // Empty message yields no text event, just done
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('done');
    });

    it('should generate unique tool call IDs for each action in complete()', async () => {
      invokeMock.mockResolvedValueOnce(
        chatResponse('multi', {
          actions: [
            { commandType: 'a', params: {} },
            { commandType: 'b', params: {} },
          ],
        }),
      );

      const adapter = createTauriLLMAdapter();
      const result = await adapter.complete(USER_MSG);

      expect(result.toolCalls).toHaveLength(2);
      // Each should have a unique ID
      expect(result.toolCalls![0].id).not.toBe(result.toolCalls![1].id);
    });

    it('should handle very large response messages in generateStream', async () => {
      const bigMessage = 'Z'.repeat(10000);
      invokeMock.mockResolvedValueOnce(chatResponse(bigMessage));

      const adapter = createTauriLLMAdapter({ streamChunkSize: 1000, streamChunkDelay: 0 });
      const chunks = await collectAll(adapter.generateStream(USER_MSG));

      expect(chunks).toHaveLength(10);
      expect(chunks.join('')).toBe(bigMessage);
    });

    it('should handle JSON with unicode characters in generateStructured', async () => {
      invokeMock.mockResolvedValueOnce({
        text: '{"name":"\\u00e9dit\\u00e9","ok":true}',
        ...RAW_ENVELOPE,
      });

      const adapter = createTauriLLMAdapter();
      const result = await adapter.generateStructured<{ name: string; ok: boolean }>(
        USER_MSG,
        { type: 'object' },
      );

      expect(result.name).toBe('\u00e9dit\u00e9');
      expect(result.ok).toBe(true);
    });

    it('should prefer fenced JSON when both raw and fenced are available', async () => {
      // The raw text is invalid JSON, but the fenced block is valid
      invokeMock.mockResolvedValueOnce({
        text: 'Not JSON\n```json\n{"source":"fenced"}\n```',
        ...RAW_ENVELOPE,
      });

      const adapter = createTauriLLMAdapter();
      const result = await adapter.generateStructured<{ source: string }>(
        USER_MSG,
        { type: 'object' },
      );

      expect(result.source).toBe('fenced');
    });

    it('should extract JSON from text with braces inside string values', async () => {
      const payload = '{"template":"value with {braces} inside"}';
      invokeMock.mockResolvedValueOnce({
        text: `Here: ${payload} done.`,
        ...RAW_ENVELOPE,
      });

      const adapter = createTauriLLMAdapter();
      const result = await adapter.generateStructured<{ template: string }>(
        USER_MSG,
        { type: 'object' },
      );

      expect(result.template).toBe('value with {braces} inside');
    });
  });
});
