import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listen } from '@tauri-apps/api/event';

import { createTauriLLMAdapter, TauriLLMAdapter } from './TauriLLMAdapter';
import type { LLMMessage, LLMStreamEvent } from '../../ports/ILLMClient';

// ---------------------------------------------------------------------------
// External boundary mocks -- Tauri IPC + Event system
// ---------------------------------------------------------------------------
const invokeMock = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

/**
 * Simulates the Tauri event system (`listen`).
 *
 * Each call to `listen(eventName, handler)` registers the handler so
 * tests can later push events via `emitTauriEvent(eventName, payload)`.
 * The returned `unlisten` function deregisters the handler.
 */
type TauriEventHandler = (event: { payload: unknown }) => void;
const eventHandlers = new Map<string, Set<TauriEventHandler>>();

function emitTauriEvent(eventName: string, payload: unknown): void {
  const handlers = eventHandlers.get(eventName);
  if (handlers) {
    for (const handler of handlers) {
      handler({ payload });
    }
  }
}

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (eventName: string, handler: TauriEventHandler) => {
    if (!eventHandlers.has(eventName)) {
      eventHandlers.set(eventName, new Set());
    }
    eventHandlers.get(eventName)!.add(handler);

    // Return an unlisten function
    return () => {
      eventHandlers.get(eventName)?.delete(handler);
    };
  }),
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

/** Standard raw-completion envelope for reuse */
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

/**
 * Helper: find the stream ID from the most recent invoke('stream_ai_completion') call.
 * The adapter uses crypto.randomUUID() so we extract it from the captured args.
 */
function getStreamId(): string {
  const streamCall = invokeMock.mock.calls.find(
    (call: unknown[]) => call[0] === 'stream_ai_completion',
  );
  if (!streamCall) {
    throw new Error('No stream_ai_completion call found');
  }
  return streamCall[1].streamId as string;
}

/**
 * Wait for the generator to start executing (invoke + listen setup).
 * The generator body starts running on the first `.next()` call, but
 * `collectAll` / manual `.next()` only drives one step at a time.
 * We need microtask flushes so the invoke + listen calls inside the
 * generator body can complete before we try to emit events.
 */
async function tick(count = 3): Promise<void> {
  for (let i = 0; i < count; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

/**
 * Helper: emit a sequence of streaming events for a given stream ID.
 * Emits each event with a microtask yield between them so the async
 * generator can process them sequentially.
 */
async function emitStreamEvents(
  streamId: string,
  events: Array<Record<string, unknown>>,
): Promise<void> {
  for (const event of events) {
    emitTauriEvent(`ai_stream_${streamId}`, event);
    await new Promise((r) => setTimeout(r, 0));
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('TauriLLMAdapter', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    eventHandlers.clear();
    // Default: stream_ai_completion returns immediately (fire-and-forget)
    invokeMock.mockImplementation((command: string) => {
      if (command === 'stream_ai_completion') {
        return Promise.resolve();
      }
      if (command === 'abort_ai_stream') {
        return Promise.resolve();
      }
      // Other commands (chat_with_ai, etc.) should be explicitly mocked per-test
      return Promise.reject(new Error(`Unmocked invoke: ${command}`));
    });
  });

  afterEach(() => {
    eventHandlers.clear();
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
      invokeMock.mockImplementation((command: string) => {
        if (command === 'chat_with_ai') return Promise.resolve(chatResponse('Hello world'));
        return Promise.resolve();
      });

      const adapter = createTauriLLMAdapter();
      const result = await adapter.complete(USER_MSG);

      expect(result.content).toBe('Hello world');
      expect(result.finishReason).toBe('stop');
      expect(result.toolCalls).toBeUndefined();
    });

    it('should return finishReason "tool_call" and toolCalls when actions are present', async () => {
      invokeMock.mockImplementation((command: string) => {
        if (command === 'chat_with_ai') {
          return Promise.resolve(
            chatResponse('Applying split', {
              actions: [
                { commandType: 'splitClip', params: { clipId: 'c1', time: 5.0 } },
                { commandType: 'deleteClip', params: { clipId: 'c2' } },
              ],
            }),
          );
        }
        return Promise.resolve();
      });

      const adapter = createTauriLLMAdapter();
      const result = await adapter.complete(USER_MSG);

      expect(result.finishReason).toBe('tool_call');
      expect(result.toolCalls).toHaveLength(2);
      expect(result.toolCalls![0].name).toBe('splitClip');
      expect(result.toolCalls![0].args).toEqual({ clipId: 'c1', time: 5.0 });
      expect(result.toolCalls![1].name).toBe('deleteClip');
    });

    it('should return empty string content when the backend message is empty', async () => {
      invokeMock.mockImplementation((command: string) => {
        if (command === 'chat_with_ai') return Promise.resolve(chatResponse(''));
        return Promise.resolve();
      });

      const adapter = createTauriLLMAdapter();
      const result = await adapter.complete(USER_MSG);

      expect(result.content).toBe('');
      expect(result.finishReason).toBe('stop');
    });

    it('should call invoke with "chat_with_ai" and formatted messages', async () => {
      invokeMock.mockImplementation((command: string) => {
        if (command === 'chat_with_ai') return Promise.resolve(chatResponse('ok'));
        return Promise.resolve();
      });

      const adapter = createTauriLLMAdapter();
      await adapter.complete([{ role: 'user', content: 'test prompt' }]);

      const chatCalls = invokeMock.mock.calls.filter((c: unknown[]) => c[0] === 'chat_with_ai');
      expect(chatCalls).toHaveLength(1);
      expect(chatCalls[0][1]).toEqual(
        expect.objectContaining({
          messages: expect.arrayContaining([{ role: 'user', content: 'test prompt' }]),
        }),
      );
    });

    it('should propagate backend errors', async () => {
      invokeMock.mockImplementation((command: string) => {
        if (command === 'chat_with_ai') return Promise.reject(new Error('Backend timeout'));
        return Promise.resolve();
      });

      const adapter = createTauriLLMAdapter();
      await expect(adapter.complete(USER_MSG)).rejects.toThrow('Backend timeout');
    });

    it('should set isGenerating to true during the call and false after', async () => {
      const deferred = createDeferred<{ message: string }>();
      invokeMock.mockImplementation((command: string) => {
        if (command === 'chat_with_ai') return deferred.promise;
        return Promise.resolve();
      });

      const adapter = createTauriLLMAdapter();
      const promise = adapter.complete(USER_MSG);

      expect(adapter.isGenerating()).toBe(true);

      deferred.resolve(chatResponse('done'));
      await promise;

      expect(adapter.isGenerating()).toBe(false);
    });
  });

  // =========================================================================
  // generateStream() -- real streaming via Tauri events
  // =========================================================================
  describe('generateStream()', () => {
    it('should subscribe before invoking the backend stream command', async () => {
      const adapter = createTauriLLMAdapter();
      const collectPromise = collectAll(adapter.generateStream(USER_MSG));

      await tick();

      const streamInvokeIndex = invokeMock.mock.calls.findIndex(
        (c: unknown[]) => c[0] === 'stream_ai_completion',
      );
      expect(streamInvokeIndex).toBeGreaterThanOrEqual(0);

      const listenMock = vi.mocked(listen);
      expect(listenMock).toHaveBeenCalled();

      const listenOrder = listenMock.mock.invocationCallOrder[0];
      const invokeOrder = invokeMock.mock.invocationCallOrder[streamInvokeIndex];
      expect(listenOrder).toBeLessThan(invokeOrder);

      const streamId = getStreamId();
      emitTauriEvent(`ai_stream_${streamId}`, { type: 'done', finishReason: 'stop' });
      await collectPromise;
    });

    it('should yield text deltas from backend stream events', async () => {
      const adapter = createTauriLLMAdapter();

      // Start consuming in the background (this triggers the generator body)
      const collectPromise = collectAll(adapter.generateStream(USER_MSG));

      // Wait for the generator to invoke + listen
      await tick();

      const streamId = getStreamId();

      // Emit events
      await emitStreamEvents(streamId, [
        { type: 'textDelta', content: 'Hello' },
        { type: 'textDelta', content: ' world' },
        { type: 'done', finishReason: 'stop' },
      ]);

      const chunks = await collectPromise;

      expect(chunks).toEqual(['Hello', ' world']);
      expect(chunks.join('')).toBe('Hello world');
    });

    it('should yield a single chunk for a single text delta', async () => {
      const adapter = createTauriLLMAdapter();
      const collectPromise = collectAll(adapter.generateStream(USER_MSG));

      await tick();
      const streamId = getStreamId();

      await emitStreamEvents(streamId, [
        { type: 'textDelta', content: 'Hi' },
        { type: 'done', finishReason: 'stop' },
      ]);

      const chunks = await collectPromise;
      expect(chunks).toEqual(['Hi']);
    });

    it('should reject when stream command invoke fails immediately', async () => {
      invokeMock.mockImplementation((command: string) => {
        if (command === 'stream_ai_completion') {
          return Promise.reject(new Error('command not found'));
        }
        return Promise.resolve();
      });

      const adapter = createTauriLLMAdapter();
      await expect(collectAll(adapter.generateStream(USER_MSG))).rejects.toThrow(
        'command not found',
      );
    });

    it('should stop yielding after abort is called mid-stream', async () => {
      const adapter = createTauriLLMAdapter();
      const gen = adapter.generateStream(USER_MSG);

      // Drive the first .next() to start the generator body
      const firstPromise = gen.next();
      await tick();
      const streamId = getStreamId();

      // Emit first chunk
      emitTauriEvent(`ai_stream_${streamId}`, { type: 'textDelta', content: 'chunk1' });
      await tick();

      const first = await firstPromise;
      expect(first.done).toBe(false);
      expect(first.value).toBe('chunk1');

      // Abort before next chunk arrives
      adapter.abort();

      const next = await gen.next();
      expect(next.done).toBe(true);
    });

    it('should throw when backend emits an error event', async () => {
      const adapter = createTauriLLMAdapter();
      const gen = adapter.generateStream(USER_MSG);

      // Drive the generator
      const nextPromise = gen.next();
      await tick();
      const streamId = getStreamId();

      emitTauriEvent(`ai_stream_${streamId}`, {
        type: 'error',
        message: 'Provider rate limited',
      });

      await expect(nextPromise).rejects.toThrow('Provider rate limited');
    });

    it('should ignore reasoning deltas in text-only streaming mode', async () => {
      const adapter = createTauriLLMAdapter();
      const collectPromise = collectAll(adapter.generateStream(USER_MSG));

      await tick();
      const streamId = getStreamId();

      await emitStreamEvents(streamId, [
        { type: 'reasoningDelta', content: 'thinking...' },
        { type: 'textDelta', content: 'result' },
        { type: 'done', finishReason: 'stop' },
      ]);

      const chunks = await collectPromise;
      expect(chunks).toEqual(['result']);
    });

    it('should call invoke with "stream_ai_completion" and correct parameters', async () => {
      const adapter = createTauriLLMAdapter();
      const collectPromise = collectAll(
        adapter.generateStream(USER_MSG, {
          systemPrompt: 'Be helpful',
          maxTokens: 100,
          temperature: 0.5,
        }),
      );

      await tick();
      const streamId = getStreamId();

      // Finish the stream
      emitTauriEvent(`ai_stream_${streamId}`, { type: 'done', finishReason: 'stop' });
      await collectPromise;

      const streamCalls = invokeMock.mock.calls.filter(
        (c: unknown[]) => c[0] === 'stream_ai_completion',
      );
      expect(streamCalls).toHaveLength(1);

      const args = streamCalls[0][1];
      expect(args.streamId).toBe(streamId);
      expect(args.systemPrompt).toBe('Be helpful');
      expect(args.options.maxTokens).toBe(100);
      expect(args.options.temperature).toBe(0.5);
    });

    it('should set isGenerating during streaming and clear after done', async () => {
      const adapter = createTauriLLMAdapter();
      const collectPromise = collectAll(adapter.generateStream(USER_MSG));

      await tick();
      expect(adapter.isGenerating()).toBe(true);

      const streamId = getStreamId();
      emitTauriEvent(`ai_stream_${streamId}`, { type: 'done', finishReason: 'stop' });

      await collectPromise;

      expect(adapter.isGenerating()).toBe(false);
    });
  });

  // =========================================================================
  // generateWithTools() -- real streaming via Tauri events
  // =========================================================================
  describe('generateWithTools()', () => {
    const tools = [{ name: 'splitClip', description: 'Split a clip', parameters: {} }];

    it('should emit text + done events for a simple response', async () => {
      const adapter = createTauriLLMAdapter();
      const collectPromise = collectAll(adapter.generateWithTools(USER_MSG, tools));

      await tick();
      const streamId = getStreamId();

      await emitStreamEvents(streamId, [
        { type: 'textDelta', content: 'Just text' },
        { type: 'done', finishReason: 'stop' },
      ]);

      const events = await collectPromise;

      expect(events).toHaveLength(2);
      expect(events[0]).toEqual({ type: 'text', content: 'Just text' });
      expect(events[1]).toEqual({ type: 'done', usage: undefined });
    });

    it('should emit text + tool_call + done events when tool calls arrive', async () => {
      const adapter = createTauriLLMAdapter();
      const collectPromise = collectAll(adapter.generateWithTools(USER_MSG, tools));

      await tick();
      const streamId = getStreamId();

      await emitStreamEvents(streamId, [
        { type: 'textDelta', content: 'Splitting clip' },
        { type: 'toolCallStart', id: 'tc_1', name: 'splitClip' },
        { type: 'toolCallDelta', id: 'tc_1', argsChunk: '{"clipId":' },
        { type: 'toolCallDelta', id: 'tc_1', argsChunk: '"c1","time":3.0}' },
        {
          type: 'toolCallComplete',
          id: 'tc_1',
          name: 'splitClip',
          argsJson: '{"clipId":"c1","time":3.0}',
        },
        { type: 'done', finishReason: 'stop' },
      ]);

      const events = await collectPromise;

      expect(events).toHaveLength(3);
      expect(events[0].type).toBe('text');
      expect(events[1].type).toBe('tool_call');
      const toolEvent = events[1] as Extract<LLMStreamEvent, { type: 'tool_call' }>;
      expect(toolEvent.name).toBe('splitClip');
      expect(toolEvent.args).toEqual({ clipId: 'c1', time: 3.0 });
      expect(events[2].type).toBe('done');
    });

    it('should assemble tool_call from start + delta when complete is not emitted', async () => {
      const adapter = createTauriLLMAdapter();
      const collectPromise = collectAll(adapter.generateWithTools(USER_MSG, tools));

      await tick();
      const streamId = getStreamId();

      await emitStreamEvents(streamId, [
        { type: 'toolCallStart', id: 'tc_1', name: 'splitClip' },
        { type: 'toolCallDelta', id: 'tc_1', argsChunk: '{"clipId":"c1","time":3.0}' },
        { type: 'done', finishReason: 'stop' },
      ]);

      const events = await collectPromise;
      const toolEvent = events.find((e) => e.type === 'tool_call') as Extract<
        LLMStreamEvent,
        { type: 'tool_call' }
      >;

      expect(toolEvent).toBeDefined();
      expect(toolEvent.id).toBe('tc_1');
      expect(toolEvent.name).toBe('splitClip');
      expect(toolEvent.args).toEqual({ clipId: 'c1', time: 3.0 });
      expect(events[events.length - 1].type).toBe('done');
    });

    it('should emit multiple tool_call events for multiple tool calls', async () => {
      const adapter = createTauriLLMAdapter();
      const collectPromise = collectAll(adapter.generateWithTools(USER_MSG, tools));

      await tick();
      const streamId = getStreamId();

      await emitStreamEvents(streamId, [
        { type: 'toolCallComplete', id: 'tc_1', name: 'splitClip', argsJson: '{"id":"1"}' },
        { type: 'toolCallComplete', id: 'tc_2', name: 'trimClip', argsJson: '{"id":"2"}' },
        { type: 'toolCallComplete', id: 'tc_3', name: 'deleteClip', argsJson: '{"id":"3"}' },
        { type: 'done', finishReason: 'stop' },
      ]);

      const events = await collectPromise;

      const toolEvents = events.filter((e) => e.type === 'tool_call');
      expect(toolEvents).toHaveLength(3);
    });

    it('should emit an error event when backend emits an error stream event', async () => {
      const adapter = createTauriLLMAdapter();
      const collectPromise = collectAll(adapter.generateWithTools(USER_MSG, tools));

      await tick();
      const streamId = getStreamId();

      emitTauriEvent(`ai_stream_${streamId}`, {
        type: 'error',
        message: 'Network failure',
      });

      const events = await collectPromise;

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('error');
      const errorEvent = events[0] as Extract<LLMStreamEvent, { type: 'error' }>;
      expect(errorEvent.error.message).toBe('Network failure');
    });

    it('should include usage in done event when usage event precedes it', async () => {
      const adapter = createTauriLLMAdapter();
      const collectPromise = collectAll(adapter.generateWithTools(USER_MSG, tools));

      await tick();
      const streamId = getStreamId();

      await emitStreamEvents(streamId, [
        { type: 'textDelta', content: 'hello' },
        { type: 'usage', inputTokens: 50, outputTokens: 25 },
        { type: 'done', finishReason: 'stop' },
      ]);

      const events = await collectPromise;

      const doneEvent = events.find((e) => e.type === 'done') as Extract<
        LLMStreamEvent,
        { type: 'done' }
      >;
      expect(doneEvent).toBeDefined();
      expect(doneEvent.usage).toEqual({ inputTokens: 50, outputTokens: 25 });
    });

    it('should not emit text event when no text deltas arrive', async () => {
      const adapter = createTauriLLMAdapter();
      const collectPromise = collectAll(adapter.generateWithTools(USER_MSG, tools));

      await tick();
      const streamId = getStreamId();

      await emitStreamEvents(streamId, [
        { type: 'toolCallComplete', id: 'tc_1', name: 'splitClip', argsJson: '{}' },
        { type: 'done', finishReason: 'stop' },
      ]);

      const events = await collectPromise;

      const textEvents = events.filter((e) => e.type === 'text');
      expect(textEvents).toHaveLength(0);

      const toolEvents = events.filter((e) => e.type === 'tool_call');
      expect(toolEvents).toHaveLength(1);
      expect(events[events.length - 1].type).toBe('done');
    });

    it('should stop emitting when aborted mid-iteration', async () => {
      const adapter = createTauriLLMAdapter();
      const gen = adapter.generateWithTools(USER_MSG, tools);

      // Drive the generator by requesting the first event
      const firstPromise = gen.next();
      await tick();
      const streamId = getStreamId();

      // Emit first event
      emitTauriEvent(`ai_stream_${streamId}`, { type: 'textDelta', content: 'Processing' });
      await tick();

      const first = await firstPromise;
      expect(first.done).toBe(false);
      expect(first.value).toEqual({ type: 'text', content: 'Processing' });

      // Abort before more events
      adapter.abort();

      const next = await gen.next();
      expect(next.done).toBe(true);
    });

    it('should handle malformed argsJson gracefully by defaulting to empty object', async () => {
      const adapter = createTauriLLMAdapter();
      const collectPromise = collectAll(adapter.generateWithTools(USER_MSG, tools));

      await tick();
      const streamId = getStreamId();

      await emitStreamEvents(streamId, [
        {
          type: 'toolCallComplete',
          id: 'tc_1',
          name: 'badTool',
          argsJson: '{invalid json',
        },
        { type: 'done', finishReason: 'stop' },
      ]);

      const events = await collectPromise;

      const toolEvent = events.find((e) => e.type === 'tool_call') as Extract<
        LLMStreamEvent,
        { type: 'tool_call' }
      >;
      expect(toolEvent).toBeDefined();
      expect(toolEvent.args).toEqual({});
    });
  });

  // =========================================================================
  // generateStructured()
  // =========================================================================
  describe('generateStructured()', () => {
    const schema = { type: 'object', properties: { goal: { type: 'string' } } };

    it('should parse raw JSON text', async () => {
      invokeMock.mockImplementation((command: string) => {
        if (command === 'complete_with_ai_raw') {
          return Promise.resolve({
            text: '{"goal":"edit","steps":[1,2,3]}',
            ...RAW_ENVELOPE,
          });
        }
        return Promise.resolve();
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
      invokeMock.mockImplementation((command: string) => {
        if (command === 'complete_with_ai_raw') {
          return Promise.resolve({
            text: 'Here is the plan:\n```json\n{"goal":"ok","steps":[]}\n```',
            ...RAW_ENVELOPE,
          });
        }
        return Promise.resolve();
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
      invokeMock.mockImplementation((command: string) => {
        if (command === 'complete_with_ai_raw') {
          return Promise.resolve({
            text: 'Some text\n```\n{"goal":"generic"}\n```\nMore text',
            ...RAW_ENVELOPE,
          });
        }
        return Promise.resolve();
      });

      const adapter = createTauriLLMAdapter();
      const result = await adapter.generateStructured<{ goal: string }>(USER_MSG, schema);

      expect(result.goal).toBe('generic');
    });

    it('should extract the first balanced JSON object from mixed text', async () => {
      invokeMock.mockImplementation((command: string) => {
        if (command === 'complete_with_ai_raw') {
          return Promise.resolve({
            text: 'I analyzed it. {"goal":"trim","steps":[{"id":1}]} Additional notes here.',
            ...RAW_ENVELOPE,
          });
        }
        return Promise.resolve();
      });

      const adapter = createTauriLLMAdapter();
      const result = await adapter.generateStructured<{
        goal: string;
        steps: Array<{ id: number }>;
      }>(USER_MSG, schema);

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
      invokeMock.mockImplementation((command: string) => {
        if (command === 'complete_with_ai_raw') {
          return Promise.resolve({
            text: `Check this: ${JSON.stringify(nested)} — done.`,
            ...RAW_ENVELOPE,
          });
        }
        return Promise.resolve();
      });

      const adapter = createTauriLLMAdapter();
      const result = await adapter.generateStructured<typeof nested>(USER_MSG, schema);

      expect(result).toEqual(nested);
    });

    it('should handle JSON with escaped quotes inside strings', async () => {
      invokeMock.mockImplementation((command: string) => {
        if (command === 'complete_with_ai_raw') {
          return Promise.resolve({
            text: '{"goal":"say \\"hello\\"","ok":true}',
            ...RAW_ENVELOPE,
          });
        }
        return Promise.resolve();
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
      invokeMock.mockImplementation((command: string) => {
        if (command === 'complete_with_ai_raw') {
          return Promise.resolve({
            text: 'Results: [{"id":1},{"id":2}]',
            ...RAW_ENVELOPE,
          });
        }
        return Promise.resolve();
      });

      const adapter = createTauriLLMAdapter();
      const result = await adapter.generateStructured<Array<{ id: number }>>(USER_MSG, schema);

      expect(result).toEqual([{ id: 1 }, { id: 2 }]);
    });

    it('should throw when response contains no parseable JSON', async () => {
      invokeMock.mockImplementation((command: string) => {
        if (command === 'complete_with_ai_raw') {
          return Promise.resolve({
            text: 'This is just plain text without any JSON at all',
            ...RAW_ENVELOPE,
          });
        }
        return Promise.resolve();
      });

      const adapter = createTauriLLMAdapter();
      await expect(adapter.generateStructured(USER_MSG, schema)).rejects.toThrow(
        'Failed to parse structured response',
      );
    });

    it('should throw when JSON is malformed', async () => {
      invokeMock.mockImplementation((command: string) => {
        if (command === 'complete_with_ai_raw') {
          return Promise.resolve({
            text: '{"goal": "bad", "steps": [}',
            ...RAW_ENVELOPE,
          });
        }
        return Promise.resolve();
      });

      const adapter = createTauriLLMAdapter();
      await expect(adapter.generateStructured(USER_MSG, schema)).rejects.toThrow(
        'Failed to parse structured response',
      );
    });

    it('should strip BOM character before parsing', async () => {
      invokeMock.mockImplementation((command: string) => {
        if (command === 'complete_with_ai_raw') {
          return Promise.resolve({
            text: '\uFEFF{"goal":"bom"}',
            ...RAW_ENVELOPE,
          });
        }
        return Promise.resolve();
      });

      const adapter = createTauriLLMAdapter();
      const result = await adapter.generateStructured<{ goal: string }>(USER_MSG, schema);

      expect(result.goal).toBe('bom');
    });

    it('should call invoke with "complete_with_ai_raw" for structured generation', async () => {
      invokeMock.mockImplementation((command: string) => {
        if (command === 'complete_with_ai_raw') {
          return Promise.resolve({
            text: '{"goal":"check"}',
            ...RAW_ENVELOPE,
          });
        }
        return Promise.resolve();
      });

      const adapter = createTauriLLMAdapter();
      await adapter.generateStructured(USER_MSG, schema);

      const rawCalls = invokeMock.mock.calls.filter(
        (c: unknown[]) => c[0] === 'complete_with_ai_raw',
      );
      expect(rawCalls).toHaveLength(1);
      expect(rawCalls[0][1]).toEqual(
        expect.objectContaining({
          messages: expect.any(Array),
          options: expect.objectContaining({ jsonMode: true }),
        }),
      );
    });

    it('should append schema instructions as a system message', async () => {
      invokeMock.mockImplementation((command: string) => {
        if (command === 'complete_with_ai_raw') {
          return Promise.resolve({
            text: '{"goal":"schema"}',
            ...RAW_ENVELOPE,
          });
        }
        return Promise.resolve();
      });

      const adapter = createTauriLLMAdapter();
      await adapter.generateStructured(USER_MSG, schema);

      const rawCalls = invokeMock.mock.calls.filter(
        (c: unknown[]) => c[0] === 'complete_with_ai_raw',
      );
      const messages = rawCalls[0][1].messages as Array<{ role: string; content: string }>;
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
      invokeMock.mockImplementation((command: string) => {
        if (command === 'get_ai_provider_status') return Promise.resolve(status);
        return Promise.resolve();
      });

      const adapter = createTauriLLMAdapter();
      const result = await adapter.refreshStatus();

      expect(result).toEqual(status);
      expect(adapter.isConfigured()).toBe(true);
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
      invokeMock.mockImplementation((command: string) => {
        if (command === 'get_ai_provider_status') return Promise.resolve(initialStatus);
        if (command === 'sync_ai_from_vault') return Promise.resolve(syncedStatus);
        return Promise.resolve();
      });

      const adapter = createTauriLLMAdapter();
      const result = await adapter.refreshStatus();

      expect(result).toEqual(syncedStatus);
      expect(adapter.isConfigured()).toBe(true);
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
      invokeMock.mockImplementation((command: string) => {
        if (command === 'get_ai_provider_status') return Promise.resolve(initialStatus);
        if (command === 'sync_ai_from_vault') return Promise.reject(new Error('Vault locked'));
        return Promise.resolve();
      });

      const adapter = createTauriLLMAdapter();
      const result = await adapter.refreshStatus();

      expect(result).toEqual(initialStatus);
      expect(adapter.isConfigured()).toBe(false);
    });

    it('should rethrow when get_ai_provider_status itself fails', async () => {
      invokeMock.mockImplementation((command: string) => {
        if (command === 'get_ai_provider_status')
          return Promise.reject(new Error('IPC unavailable'));
        return Promise.resolve();
      });

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
      invokeMock.mockImplementation((command: string) => {
        if (command === 'get_ai_provider_status') return Promise.resolve(initialStatus);
        if (command === 'sync_ai_from_vault') return Promise.resolve(syncedStatus);
        return Promise.resolve();
      });

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
        invokeMock.mockImplementation((command: string) => {
          if (command === 'chat_with_ai') return Promise.resolve(null);
          return Promise.resolve();
        });

        const adapter = createTauriLLMAdapter();
        await expect(adapter.complete(USER_MSG)).rejects.toThrow(
          'Backend returned invalid chat response: expected object',
        );
      });

      it('should reject non-object response (number)', async () => {
        invokeMock.mockImplementation((command: string) => {
          if (command === 'chat_with_ai') return Promise.resolve(42);
          return Promise.resolve();
        });

        const adapter = createTauriLLMAdapter();
        await expect(adapter.complete(USER_MSG)).rejects.toThrow(
          'Backend returned invalid chat response: expected object',
        );
      });

      it('should reject non-object response (string)', async () => {
        invokeMock.mockImplementation((command: string) => {
          if (command === 'chat_with_ai') return Promise.resolve('just a string');
          return Promise.resolve();
        });

        const adapter = createTauriLLMAdapter();
        await expect(adapter.complete(USER_MSG)).rejects.toThrow(
          'Backend returned invalid chat response: expected object',
        );
      });

      it('should reject when message field is missing', async () => {
        invokeMock.mockImplementation((command: string) => {
          if (command === 'chat_with_ai') return Promise.resolve({ actions: [] });
          return Promise.resolve();
        });

        const adapter = createTauriLLMAdapter();
        await expect(adapter.complete(USER_MSG)).rejects.toThrow(
          '"message" must be a string, got undefined',
        );
      });

      it('should reject when message field is a number', async () => {
        invokeMock.mockImplementation((command: string) => {
          if (command === 'chat_with_ai') return Promise.resolve({ message: 123 });
          return Promise.resolve();
        });

        const adapter = createTauriLLMAdapter();
        await expect(adapter.complete(USER_MSG)).rejects.toThrow(
          '"message" must be a string, got number',
        );
      });

      it('should strip non-array actions to undefined', async () => {
        invokeMock.mockImplementation((command: string) => {
          if (command === 'chat_with_ai')
            return Promise.resolve({ message: 'hi', actions: 'not-an-array' });
          return Promise.resolve();
        });

        const adapter = createTauriLLMAdapter();
        const result = await adapter.complete(USER_MSG);

        expect(result.toolCalls).toBeUndefined();
        expect(result.finishReason).toBe('stop');
      });

      it('should strip non-boolean needsConfirmation', async () => {
        invokeMock.mockImplementation((command: string) => {
          if (command === 'chat_with_ai') {
            return Promise.resolve({
              message: 'hi',
              needsConfirmation: 'yes',
              actions: null,
            });
          }
          return Promise.resolve();
        });

        const adapter = createTauriLLMAdapter();
        const result = await adapter.complete(USER_MSG);

        expect(result.content).toBe('hi');
      });
    });

    describe('validateRawCompletionResponse (via generateStructured)', () => {
      const schema = { type: 'object' };

      it('should reject null response', async () => {
        invokeMock.mockImplementation((command: string) => {
          if (command === 'complete_with_ai_raw') return Promise.resolve(null);
          return Promise.resolve();
        });

        const adapter = createTauriLLMAdapter();
        await expect(adapter.generateStructured(USER_MSG, schema)).rejects.toThrow(
          'Backend returned invalid raw completion response: expected object',
        );
      });

      it('should reject non-object response', async () => {
        invokeMock.mockImplementation((command: string) => {
          if (command === 'complete_with_ai_raw') return Promise.resolve(false);
          return Promise.resolve();
        });

        const adapter = createTauriLLMAdapter();
        await expect(adapter.generateStructured(USER_MSG, schema)).rejects.toThrow(
          'Backend returned invalid raw completion response: expected object',
        );
      });

      it('should reject when text field is missing', async () => {
        invokeMock.mockImplementation((command: string) => {
          if (command === 'complete_with_ai_raw') {
            return Promise.resolve({ model: 'x', usage: {}, finishReason: 'stop' });
          }
          return Promise.resolve();
        });

        const adapter = createTauriLLMAdapter();
        await expect(adapter.generateStructured(USER_MSG, schema)).rejects.toThrow(
          '"text" must be a string, got undefined',
        );
      });

      it('should reject when text field is a number', async () => {
        invokeMock.mockImplementation((command: string) => {
          if (command === 'complete_with_ai_raw') return Promise.resolve({ text: 999 });
          return Promise.resolve();
        });

        const adapter = createTauriLLMAdapter();
        await expect(adapter.generateStructured(USER_MSG, schema)).rejects.toThrow(
          '"text" must be a string, got number',
        );
      });

      it('should default model to "unknown" when missing', async () => {
        invokeMock.mockImplementation((command: string) => {
          if (command === 'complete_with_ai_raw') return Promise.resolve({ text: '{"ok":true}' });
          return Promise.resolve();
        });

        const adapter = createTauriLLMAdapter();
        const result = await adapter.generateStructured<{ ok: boolean }>(USER_MSG, schema);

        expect(result.ok).toBe(true);
      });

      it('should default usage to zeros when missing', async () => {
        invokeMock.mockImplementation((command: string) => {
          if (command === 'complete_with_ai_raw') return Promise.resolve({ text: '{"ok":true}' });
          return Promise.resolve();
        });

        const adapter = createTauriLLMAdapter();
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
      invokeMock.mockImplementation((command: string) => {
        if (command === 'chat_with_ai') return Promise.resolve(chatResponse('ack'));
        return Promise.resolve();
      });

      const adapter = createTauriLLMAdapter();
      await adapter.complete([{ role: 'user', content: 'do something' }], {
        systemPrompt: 'You are a video editor',
      });

      const chatCalls = invokeMock.mock.calls.filter((c: unknown[]) => c[0] === 'chat_with_ai');
      const messages = chatCalls[0][1].messages as Array<{ role: string; content: string }>;

      expect(messages[0].role).toBe('system');
      expect(messages[0].content).toBe('You are a video editor');
      expect(messages[1].role).toBe('user');
      expect(messages[1].content).toBe('do something');
    });

    it('should append system prompt to existing system message content', async () => {
      invokeMock.mockImplementation((command: string) => {
        if (command === 'chat_with_ai') return Promise.resolve(chatResponse('ack'));
        return Promise.resolve();
      });

      const adapter = createTauriLLMAdapter();
      await adapter.complete(
        [
          { role: 'system', content: 'Base instructions' },
          { role: 'user', content: 'edit this' },
        ],
        { systemPrompt: 'Additional context' },
      );

      const chatCalls = invokeMock.mock.calls.filter((c: unknown[]) => c[0] === 'chat_with_ai');
      const messages = chatCalls[0][1].messages as Array<{ role: string; content: string }>;

      // System prompt is prepended to existing system message content
      expect(messages[0].role).toBe('system');
      expect(messages[0].content).toBe('Additional context\n\nBase instructions');
      // Should NOT add a separate system message since one already exists
      const systemMessages = messages.filter((m) => m.role === 'system');
      expect(systemMessages).toHaveLength(1);
    });

    it('should not add a system message when systemPrompt is not provided', async () => {
      invokeMock.mockImplementation((command: string) => {
        if (command === 'chat_with_ai') return Promise.resolve(chatResponse('ack'));
        return Promise.resolve();
      });

      const adapter = createTauriLLMAdapter();
      await adapter.complete([{ role: 'user', content: 'hi' }]);

      const chatCalls = invokeMock.mock.calls.filter((c: unknown[]) => c[0] === 'chat_with_ai');
      const messages = chatCalls[0][1].messages as Array<{ role: string; content: string }>;

      expect(messages).toHaveLength(1);
      expect(messages[0].role).toBe('user');
    });
  });

  // =========================================================================
  // setDefaultContext()
  // =========================================================================
  describe('setDefaultContext()', () => {
    it('should pass custom context to the backend call', async () => {
      invokeMock.mockImplementation((command: string) => {
        if (command === 'chat_with_ai') return Promise.resolve(chatResponse('ok'));
        return Promise.resolve();
      });

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

      const chatCalls = invokeMock.mock.calls.filter((c: unknown[]) => c[0] === 'chat_with_ai');
      const context = chatCalls[0][1].context;

      expect(context.playheadPosition).toBe(42.5);
      expect(context.selectedClips).toEqual(['clip-1', 'clip-2']);
      expect(context.selectedTracks).toEqual(['track-v1']);
      expect(context.timelineDuration).toBe(120);
      expect(context.assetIds).toEqual(['asset-a']);
      expect(context.trackIds).toEqual(['t1']);
      expect(context.preferredLanguage).toBe('en');
    });

    it('should use default empty context when not set', async () => {
      invokeMock.mockImplementation((command: string) => {
        if (command === 'chat_with_ai') return Promise.resolve(chatResponse('ok'));
        return Promise.resolve();
      });

      const adapter = createTauriLLMAdapter();
      await adapter.complete(USER_MSG);

      const chatCalls = invokeMock.mock.calls.filter((c: unknown[]) => c[0] === 'chat_with_ai');
      const context = chatCalls[0][1].context;

      expect(context.playheadPosition).toBe(0);
      expect(context.selectedClips).toEqual([]);
      expect(context.selectedTracks).toEqual([]);
      expect(context.assetIds).toEqual([]);
      expect(context.trackIds).toEqual([]);
    });

    it('should reset context when called with undefined', async () => {
      invokeMock.mockImplementation((command: string) => {
        if (command === 'chat_with_ai') return Promise.resolve(chatResponse('ok'));
        return Promise.resolve();
      });

      const adapter = createTauriLLMAdapter();
      adapter.setDefaultContext({ playheadPosition: 99 });
      await adapter.complete(USER_MSG);

      const firstChatCalls = invokeMock.mock.calls.filter(
        (c: unknown[]) => c[0] === 'chat_with_ai',
      );
      expect(firstChatCalls[0][1].context.playheadPosition).toBe(99);

      adapter.setDefaultContext(undefined);
      await adapter.complete(USER_MSG);

      const allChatCalls = invokeMock.mock.calls.filter((c: unknown[]) => c[0] === 'chat_with_ai');
      expect(allChatCalls[1][1].context.playheadPosition).toBe(0);
    });
  });

  // =========================================================================
  // Abort
  // =========================================================================
  describe('abort()', () => {
    it('should throw "Generation aborted" when abort is called before callBackend resolves', async () => {
      const deferred = createDeferred<{ message: string }>();
      invokeMock.mockImplementation((command: string) => {
        if (command === 'chat_with_ai') return deferred.promise;
        return Promise.resolve();
      });

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
      invokeMock.mockImplementation((command: string) => {
        if (command === 'complete_with_ai_raw') return deferred.promise;
        return Promise.resolve();
      });

      const adapter = createTauriLLMAdapter();
      const promise = adapter.generateStructured(USER_MSG, { type: 'object' });

      adapter.abort();
      deferred.resolve({ text: '{}', ...RAW_ENVELOPE });

      await expect(promise).rejects.toThrow('Generation aborted');
    });

    it('should set isGenerating to false immediately after abort', async () => {
      const deferred = createDeferred<{ message: string }>();
      invokeMock.mockImplementation((command: string) => {
        if (command === 'chat_with_ai') return deferred.promise;
        return Promise.resolve();
      });

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
      let callCount = 0;
      invokeMock.mockImplementation((command: string) => {
        if (command === 'chat_with_ai') {
          callCount++;
          if (callCount === 1) return deferred1.promise;
          return Promise.resolve(chatResponse('fresh'));
        }
        return Promise.resolve();
      });

      const adapter = createTauriLLMAdapter();
      const p1 = adapter.complete(USER_MSG);
      adapter.abort();

      deferred1.resolve(chatResponse('stale'));
      await expect(p1).rejects.toThrow('Generation aborted');

      // New request should work fine
      const result = await adapter.complete(USER_MSG);
      expect(result.content).toBe('fresh');
    });

    it('should abort the stream generator when called during generateStream', async () => {
      const adapter = createTauriLLMAdapter();
      const gen = adapter.generateStream(USER_MSG);

      // Drive the generator
      const firstPromise = gen.next();
      await tick();
      const streamId = getStreamId();

      // Emit first chunk
      emitTauriEvent(`ai_stream_${streamId}`, { type: 'textDelta', content: 'first' });
      await tick();

      const first = await firstPromise;
      expect(first.done).toBe(false);

      // Abort
      adapter.abort();

      // Next pull should signal done
      const next = await gen.next();
      expect(next.done).toBe(true);
    });

    it('should invoke abort_ai_stream on the backend when aborting a stream', async () => {
      const adapter = createTauriLLMAdapter();
      const gen = adapter.generateStream(USER_MSG);

      // Drive the generator to start it
      const firstPromise = gen.next();
      await tick();
      const streamId = getStreamId();

      adapter.abort();

      // Emit done to allow generator to finish cleanly
      emitTauriEvent(`ai_stream_${streamId}`, { type: 'done', finishReason: 'stop' });

      // Finish the generator
      await firstPromise;
      // Drain any remaining
      const rest = await gen.next();
      expect(rest.done).toBe(true);

      // Verify backend abort was called
      const abortCalls = invokeMock.mock.calls.filter((c: unknown[]) => c[0] === 'abort_ai_stream');
      expect(abortCalls).toHaveLength(1);
      expect(abortCalls[0][1].streamId).toBe(streamId);
    });
  });

  // =========================================================================
  // Request Sequence / Overlapping Requests
  // =========================================================================
  describe('request sequence management', () => {
    it('should keep isGenerating true while newer overlapping request is pending', async () => {
      const first = createDeferred<{ message: string }>();
      const second = createDeferred<{ message: string }>();
      let callCount = 0;

      invokeMock.mockImplementation((command: string) => {
        if (command === 'chat_with_ai') {
          callCount++;
          return callCount === 1 ? first.promise : second.promise;
        }
        return Promise.resolve();
      });

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
      let callCount = 0;

      invokeMock.mockImplementation((command: string) => {
        if (command === 'chat_with_ai') {
          callCount++;
          return callCount === 1 ? first.promise : second.promise;
        }
        return Promise.resolve();
      });

      const adapter = createTauriLLMAdapter();

      const p1 = adapter.complete(USER_MSG);
      const p2 = adapter.complete(USER_MSG);

      // Resolve the newer request first
      second.resolve(chatResponse('second'));
      await p2;

      // isGenerating should be false because the active request finished
      expect(adapter.isGenerating()).toBe(false);

      // Resolve the stale one
      first.resolve(chatResponse('first'));
      await p1;

      expect(adapter.isGenerating()).toBe(false);
    });

    it('should not clear generating state when a stale request finishes', async () => {
      const first = createDeferred<{ message: string }>();
      const second = createDeferred<{ message: string }>();
      const third = createDeferred<{ message: string }>();
      let callCount = 0;

      invokeMock.mockImplementation((command: string) => {
        if (command === 'chat_with_ai') {
          callCount++;
          if (callCount === 1) return first.promise;
          if (callCount === 2) return second.promise;
          return third.promise;
        }
        return Promise.resolve();
      });

      const adapter = createTauriLLMAdapter();

      const p1 = adapter.complete(USER_MSG);
      const p2 = adapter.complete(USER_MSG);
      const p3 = adapter.complete(USER_MSG);

      first.resolve(chatResponse('1'));
      await p1;
      expect(adapter.isGenerating()).toBe(true);

      second.resolve(chatResponse('2'));
      await p2;
      expect(adapter.isGenerating()).toBe(true);

      third.resolve(chatResponse('3'));
      await p3;
      expect(adapter.isGenerating()).toBe(false);
    });

    it('should reset abort state for new requests after a previous abort', async () => {
      let callCount = 0;
      invokeMock.mockImplementation((command: string) => {
        if (command === 'chat_with_ai') {
          callCount++;
          if (callCount === 1) return new Promise(() => {}); // never resolves
          return Promise.resolve(chatResponse('works'));
        }
        return Promise.resolve();
      });

      const adapter = createTauriLLMAdapter();
      adapter.complete(USER_MSG); // start + will never finish
      adapter.abort();

      // beginRequest in the next call should reset _aborted
      const result = await adapter.complete(USER_MSG);

      expect(result.content).toBe('works');
    });
  });

  // =========================================================================
  // Options Forwarding
  // =========================================================================
  describe('options forwarding', () => {
    it('should forward temperature and maxTokens to callRawCompletion', async () => {
      invokeMock.mockImplementation((command: string) => {
        if (command === 'complete_with_ai_raw') {
          return Promise.resolve({ text: '{"ok":true}', ...RAW_ENVELOPE });
        }
        return Promise.resolve();
      });

      const adapter = createTauriLLMAdapter();
      await adapter.generateStructured(
        USER_MSG,
        { type: 'object' },
        {
          temperature: 0.3,
          maxTokens: 500,
        },
      );

      const rawCalls = invokeMock.mock.calls.filter(
        (c: unknown[]) => c[0] === 'complete_with_ai_raw',
      );
      expect(rawCalls[0][1].options.temperature).toBe(0.3);
      expect(rawCalls[0][1].options.maxTokens).toBe(500);
    });

    it('should forward systemPrompt to callRawCompletion options', async () => {
      invokeMock.mockImplementation((command: string) => {
        if (command === 'complete_with_ai_raw') {
          return Promise.resolve({ text: '{"ok":true}', ...RAW_ENVELOPE });
        }
        return Promise.resolve();
      });

      const adapter = createTauriLLMAdapter();
      await adapter.generateStructured(
        USER_MSG,
        { type: 'object' },
        {
          systemPrompt: 'Be concise',
        },
      );

      const rawCalls = invokeMock.mock.calls.filter(
        (c: unknown[]) => c[0] === 'complete_with_ai_raw',
      );
      expect(rawCalls[0][1].options.systemPrompt).toBe('Be concise');
    });

    it('should default jsonMode to true for generateStructured', async () => {
      invokeMock.mockImplementation((command: string) => {
        if (command === 'complete_with_ai_raw') {
          return Promise.resolve({ text: '{"ok":true}', ...RAW_ENVELOPE });
        }
        return Promise.resolve();
      });

      const adapter = createTauriLLMAdapter();
      await adapter.generateStructured(USER_MSG, { type: 'object' });

      const rawCalls = invokeMock.mock.calls.filter(
        (c: unknown[]) => c[0] === 'complete_with_ai_raw',
      );
      expect(rawCalls[0][1].options.jsonMode).toBe(true);
    });
  });

  // =========================================================================
  // Configuration
  // =========================================================================
  describe('configuration', () => {
    it('should accept initial defaultContext via config', async () => {
      invokeMock.mockImplementation((command: string) => {
        if (command === 'chat_with_ai') return Promise.resolve(chatResponse('ok'));
        return Promise.resolve();
      });

      const adapter = createTauriLLMAdapter({
        defaultContext: {
          playheadPosition: 10,
          assetIds: ['a1'],
        },
      });
      await adapter.complete(USER_MSG);

      const chatCalls = invokeMock.mock.calls.filter((c: unknown[]) => c[0] === 'chat_with_ai');
      expect(chatCalls[0][1].context.playheadPosition).toBe(10);
      expect(chatCalls[0][1].context.assetIds).toEqual(['a1']);
    });
  });

  // =========================================================================
  // Edge Cases
  // =========================================================================
  describe('edge cases', () => {
    it('should handle response with actions set to null', async () => {
      invokeMock.mockImplementation((command: string) => {
        if (command === 'chat_with_ai') return Promise.resolve({ message: 'hi', actions: null });
        return Promise.resolve();
      });

      const adapter = createTauriLLMAdapter();
      const result = await adapter.complete(USER_MSG);

      expect(result.finishReason).toBe('stop');
      expect(result.toolCalls).toBeUndefined();
    });

    it('should handle response with empty actions array', async () => {
      invokeMock.mockImplementation((command: string) => {
        if (command === 'chat_with_ai') return Promise.resolve({ message: 'hi', actions: [] });
        return Promise.resolve();
      });

      const adapter = createTauriLLMAdapter();
      const result = await adapter.complete(USER_MSG);

      expect(result.finishReason).toBe('stop');
      expect(result.toolCalls).toBeUndefined();
    });

    it('should handle intent field in response', async () => {
      invokeMock.mockImplementation((command: string) => {
        if (command === 'chat_with_ai') {
          return Promise.resolve({
            message: 'I will trim the clip',
            intent: { intentType: 'trim', confidence: 0.95 },
          });
        }
        return Promise.resolve();
      });

      const adapter = createTauriLLMAdapter();
      const result = await adapter.complete(USER_MSG);

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
      let callCount = 0;

      invokeMock.mockImplementation((command: string) => {
        if (command === 'complete_with_ai_raw') {
          callCount++;
          return callCount === 1 ? d1.promise : d2.promise;
        }
        return Promise.resolve();
      });

      const adapter = createTauriLLMAdapter();
      const p1 = adapter.generateStructured<{ id: number }>([{ role: 'user', content: 'first' }], {
        type: 'object',
      });
      const p2 = adapter.generateStructured<{ id: number }>([{ role: 'user', content: 'second' }], {
        type: 'object',
      });

      d2.resolve({ text: '{"id":2}', ...RAW_ENVELOPE });
      d1.resolve({ text: '{"id":1}', ...RAW_ENVELOPE });

      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1.id).toBe(1);
      expect(r2.id).toBe(2);
    });

    it('should handle generateStream with no text deltas before done', async () => {
      const adapter = createTauriLLMAdapter();
      const collectPromise = collectAll(adapter.generateStream(USER_MSG));

      await tick();
      const streamId = getStreamId();

      emitTauriEvent(`ai_stream_${streamId}`, { type: 'done', finishReason: 'stop' });

      const chunks = await collectPromise;
      expect(chunks).toHaveLength(0);
    });

    it('should handle generateWithTools with no events before done', async () => {
      const adapter = createTauriLLMAdapter();
      const collectPromise = collectAll(
        adapter.generateWithTools(USER_MSG, [
          { name: 'test', description: 'test', parameters: {} },
        ]),
      );

      await tick();
      const streamId = getStreamId();

      emitTauriEvent(`ai_stream_${streamId}`, { type: 'done', finishReason: 'stop' });

      const events = await collectPromise;
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('done');
    });

    it('should generate unique tool call IDs for each action in complete()', async () => {
      invokeMock.mockImplementation((command: string) => {
        if (command === 'chat_with_ai') {
          return Promise.resolve(
            chatResponse('multi', {
              actions: [
                { commandType: 'a', params: {} },
                { commandType: 'b', params: {} },
              ],
            }),
          );
        }
        return Promise.resolve();
      });

      const adapter = createTauriLLMAdapter();
      const result = await adapter.complete(USER_MSG);

      expect(result.toolCalls).toHaveLength(2);
      expect(result.toolCalls![0].id).not.toBe(result.toolCalls![1].id);
    });

    it('should handle many rapid text deltas in generateStream', async () => {
      const adapter = createTauriLLMAdapter();
      const collectPromise = collectAll(adapter.generateStream(USER_MSG));

      await tick();
      const streamId = getStreamId();

      // Emit many chunks rapidly
      const deltas = Array.from({ length: 100 }, (_, i) => ({
        type: 'textDelta',
        content: `chunk${i}`,
      }));
      await emitStreamEvents(streamId, [...deltas, { type: 'done', finishReason: 'stop' }]);

      const chunks = await collectPromise;

      expect(chunks).toHaveLength(100);
      expect(chunks[0]).toBe('chunk0');
      expect(chunks[99]).toBe('chunk99');
    });

    it('should handle JSON with unicode characters in generateStructured', async () => {
      invokeMock.mockImplementation((command: string) => {
        if (command === 'complete_with_ai_raw') {
          return Promise.resolve({
            text: '{"name":"\\u00e9dit\\u00e9","ok":true}',
            ...RAW_ENVELOPE,
          });
        }
        return Promise.resolve();
      });

      const adapter = createTauriLLMAdapter();
      const result = await adapter.generateStructured<{ name: string; ok: boolean }>(USER_MSG, {
        type: 'object',
      });

      expect(result.name).toBe('\u00e9dit\u00e9');
      expect(result.ok).toBe(true);
    });

    it('should prefer fenced JSON when both raw and fenced are available', async () => {
      invokeMock.mockImplementation((command: string) => {
        if (command === 'complete_with_ai_raw') {
          return Promise.resolve({
            text: 'Not JSON\n```json\n{"source":"fenced"}\n```',
            ...RAW_ENVELOPE,
          });
        }
        return Promise.resolve();
      });

      const adapter = createTauriLLMAdapter();
      const result = await adapter.generateStructured<{ source: string }>(USER_MSG, {
        type: 'object',
      });

      expect(result.source).toBe('fenced');
    });

    it('should extract JSON from text with braces inside string values', async () => {
      const payload = '{"template":"value with {braces} inside"}';
      invokeMock.mockImplementation((command: string) => {
        if (command === 'complete_with_ai_raw') {
          return Promise.resolve({
            text: `Here: ${payload} done.`,
            ...RAW_ENVELOPE,
          });
        }
        return Promise.resolve();
      });

      const adapter = createTauriLLMAdapter();
      const result = await adapter.generateStructured<{ template: string }>(USER_MSG, {
        type: 'object',
      });

      expect(result.template).toBe('value with {braces} inside');
    });

    // =======================================================================
    // JSON Repair — truncated responses
    // =======================================================================

    describe('truncated response repair', () => {
      const schema = { type: 'object', properties: { goal: { type: 'string' } } };

      it('should repair a response truncated mid-string value', async () => {
        // Simulates LLM running out of tokens mid-string
        invokeMock.mockImplementation((command: string) => {
          if (command === 'complete_with_ai_raw') {
            return Promise.resolve({
              text: '{"goal":"Keep only the odd-numbered 1-second seg',
              model: 'test-model',
              usage: { promptTokens: 100, completionTokens: 1800, totalTokens: 1900 },
              finishReason: 'max_tokens',
            });
          }
          return Promise.resolve();
        });

        const adapter = createTauriLLMAdapter();
        const result = await adapter.generateStructured<{ goal: string }>(USER_MSG, schema);

        expect(result.goal).toBe('Keep only the odd-numbered 1-second seg');
      });

      it('should repair a response truncated mid-array', async () => {
        invokeMock.mockImplementation((command: string) => {
          if (command === 'complete_with_ai_raw') {
            return Promise.resolve({
              text: '{"goal":"test","steps":[{"id":"s1"},{"id":"s2"}',
              model: 'test-model',
              usage: { promptTokens: 100, completionTokens: 1200, totalTokens: 1300 },
              finishReason: 'length',
            });
          }
          return Promise.resolve();
        });

        const adapter = createTauriLLMAdapter();
        const result = await adapter.generateStructured<{
          goal: string;
          steps: Array<{ id: string }>;
        }>(USER_MSG, schema);

        expect(result.goal).toBe('test');
        expect(result.steps).toHaveLength(2);
      });

      it('should repair a response truncated mid-nested-object', async () => {
        invokeMock.mockImplementation((command: string) => {
          if (command === 'complete_with_ai_raw') {
            return Promise.resolve({
              text: '{"goal":"cut","steps":[{"id":"s1","args":{"clipId":"abc"',
              model: 'test-model',
              usage: { promptTokens: 50, completionTokens: 500, totalTokens: 550 },
              finishReason: 'max_tokens',
            });
          }
          return Promise.resolve();
        });

        const adapter = createTauriLLMAdapter();
        const result = await adapter.generateStructured<{
          goal: string;
          steps: Array<{ id: string; args: { clipId: string } }>;
        }>(USER_MSG, schema);

        expect(result.goal).toBe('cut');
        expect(result.steps[0].args.clipId).toBe('abc');
      });

      it('should repair a response with trailing comma before truncation', async () => {
        invokeMock.mockImplementation((command: string) => {
          if (command === 'complete_with_ai_raw') {
            return Promise.resolve({
              text: '{"goal":"trim","items":["a","b",',
              model: 'test-model',
              usage: { promptTokens: 50, completionTokens: 100, totalTokens: 150 },
              finishReason: 'max_tokens',
            });
          }
          return Promise.resolve();
        });

        const adapter = createTauriLLMAdapter();
        const result = await adapter.generateStructured<{ goal: string; items: string[] }>(
          USER_MSG,
          schema,
        );

        expect(result.goal).toBe('trim');
        expect(result.items).toEqual(['a', 'b']);
      });

      it('should include truncation hint in error when repair also fails', async () => {
        // Completely garbled truncation that can't be repaired to valid JSON
        invokeMock.mockImplementation((command: string) => {
          if (command === 'complete_with_ai_raw') {
            return Promise.resolve({
              text: 'This is not JSON at all and was truncated',
              model: 'test-model',
              usage: { promptTokens: 50, completionTokens: 100, totalTokens: 150 },
              finishReason: 'max_tokens',
            });
          }
          return Promise.resolve();
        });

        const adapter = createTauriLLMAdapter();
        await expect(adapter.generateStructured(USER_MSG, schema)).rejects.toThrow(
          'response was truncated by token limit',
        );
      });

      it('should log warning to console when finishReason is max_tokens', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        invokeMock.mockImplementation((command: string) => {
          if (command === 'complete_with_ai_raw') {
            return Promise.resolve({
              text: '{"goal":"ok"}',
              model: 'test-model',
              usage: { promptTokens: 100, completionTokens: 1800, totalTokens: 1900 },
              finishReason: 'max_tokens',
            });
          }
          return Promise.resolve();
        });

        const adapter = createTauriLLMAdapter();
        await adapter.generateStructured<{ goal: string }>(USER_MSG, schema);

        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('Structured response truncated'),
        );

        warnSpy.mockRestore();
      });
    });
  });

  // =========================================================================
  // repairTruncatedJson() — unit tests
  // =========================================================================
  describe('repairTruncatedJson()', () => {
    let adapter: TauriLLMAdapter;

    beforeEach(() => {
      adapter = createTauriLLMAdapter();
    });

    it('should return null for already-balanced JSON', () => {
      expect(adapter.repairTruncatedJson('{"a":1}')).toBeNull();
    });

    it('should return null when no JSON object is present', () => {
      expect(adapter.repairTruncatedJson('just plain text')).toBeNull();
    });

    it('should close an unterminated string', () => {
      const repaired = adapter.repairTruncatedJson('{"goal":"hello world');
      expect(repaired).not.toBeNull();
      expect(JSON.parse(repaired!)).toEqual({ goal: 'hello world' });
    });

    it('should close unterminated string and open object', () => {
      const repaired = adapter.repairTruncatedJson('{"a":"val","b":"oth');
      expect(repaired).not.toBeNull();
      const parsed = JSON.parse(repaired!);
      expect(parsed.a).toBe('val');
      expect(parsed.b).toBe('oth');
    });

    it('should close nested objects and arrays', () => {
      const repaired = adapter.repairTruncatedJson('{"a":[{"b":1},{"c":2}');
      expect(repaired).not.toBeNull();
      const parsed = JSON.parse(repaired!);
      expect(parsed.a).toEqual([{ b: 1 }, { c: 2 }]);
    });

    it('should handle escaped quotes inside strings', () => {
      const repaired = adapter.repairTruncatedJson('{"a":"say \\"hi\\"","b":"tru');
      expect(repaired).not.toBeNull();
      const parsed = JSON.parse(repaired!);
      expect(parsed.a).toBe('say "hi"');
      expect(parsed.b).toBe('tru');
    });

    it('should strip trailing comma before closing', () => {
      const repaired = adapter.repairTruncatedJson('{"items":[1,2,');
      expect(repaired).not.toBeNull();
      const parsed = JSON.parse(repaired!);
      expect(parsed.items).toEqual([1, 2]);
    });

    it('should handle deeply nested truncation', () => {
      const repaired = adapter.repairTruncatedJson('{"a":{"b":{"c":{"d":"deep');
      expect(repaired).not.toBeNull();
      const parsed = JSON.parse(repaired!);
      expect(parsed.a.b.c.d).toBe('deep');
    });

    it('should handle Korean text in truncated string', () => {
      const repaired = adapter.repairTruncatedJson(
        '{"goal":"홀수 초수의 영상만 남기고 짝수 초수를 제거',
      );
      expect(repaired).not.toBeNull();
      const parsed = JSON.parse(repaired!);
      expect(parsed.goal).toBe('홀수 초수의 영상만 남기고 짝수 초수를 제거');
    });

    it('should handle the exact error case from the bug report', () => {
      const truncated =
        '{ "goal": "Keep only the odd-numbered 1-second segments (0-1s, 2-3s, 4-5s, etc.) and remove the even-numbered segments (1-2s, 3-4s,';
      const repaired = adapter.repairTruncatedJson(truncated);
      expect(repaired).not.toBeNull();
      const parsed = JSON.parse(repaired!);
      expect(parsed.goal).toContain('odd-numbered 1-second segments');
    });
  });
});
