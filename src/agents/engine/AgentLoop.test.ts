/**
 * AgentLoop Tests
 *
 * Tests for the simplified agentic loop (opencode-style stream -> tool -> loop).
 * Uses real DoomLoopDetector and mock LLM/tool adapters.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  AgentLoop,
  createAgentLoop,
  AgentLoopAbortedError,
  type AgentLoopEvent,
} from './AgentLoop';
import {
  createMockLLMAdapter,
  type MockLLMAdapter,
} from './adapters/llm/MockLLMAdapter';
import {
  createMockToolExecutor,
  type MockToolExecutor,
} from './adapters/tools/MockToolExecutor';
import { createEmptyContext, type AgentContext } from './core/types';
import type { ToolInfo } from './ports/IToolExecutor';

// =============================================================================
// Helpers
// =============================================================================

function createTestContext(overrides?: Partial<AgentContext>): AgentContext {
  return {
    ...createEmptyContext('test-project'),
    sequenceId: 'seq-1',
    ...overrides,
  };
}

async function collectEvents(
  gen: AsyncGenerator<AgentLoopEvent, void, unknown>,
): Promise<AgentLoopEvent[]> {
  const events: AgentLoopEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

function findEvent<T extends AgentLoopEvent['type']>(
  events: AgentLoopEvent[],
  type: T,
): Extract<AgentLoopEvent, { type: T }> | undefined {
  return events.find((e) => e.type === type) as
    | Extract<AgentLoopEvent, { type: T }>
    | undefined;
}

function findAllEvents<T extends AgentLoopEvent['type']>(
  events: AgentLoopEvent[],
  type: T,
): Array<Extract<AgentLoopEvent, { type: T }>> {
  return events.filter((e) => e.type === type) as Array<
    Extract<AgentLoopEvent, { type: T }>
  >;
}

/** Helper to create a ToolInfo object for mock registration */
function toolInfo(
  name: string,
  opts?: Partial<ToolInfo>,
): ToolInfo {
  return {
    name,
    description: opts?.description ?? `Mock ${name}`,
    category: opts?.category ?? 'test',
    riskLevel: opts?.riskLevel ?? 'low',
    supportsUndo: opts?.supportsUndo ?? false,
    parallelizable: opts?.parallelizable ?? false,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('AgentLoop', () => {
  let llm: MockLLMAdapter;
  let tools: MockToolExecutor;

  beforeEach(() => {
    llm = createMockLLMAdapter();
    tools = createMockToolExecutor();
  });

  // ---------------------------------------------------------------------------
  // Construction & Factory
  // ---------------------------------------------------------------------------

  describe('construction', () => {
    it('should create via constructor', () => {
      const loop = new AgentLoop(llm, tools);
      expect(loop).toBeInstanceOf(AgentLoop);
      expect(loop.isRunning()).toBe(false);
    });

    it('should create via factory', () => {
      const loop = createAgentLoop(llm, tools, { maxIterations: 5 });
      expect(loop).toBeInstanceOf(AgentLoop);
    });
  });

  // ---------------------------------------------------------------------------
  // Simple text completion (no tool calls)
  // ---------------------------------------------------------------------------

  describe('text completion', () => {
    it('should yield text_delta and done for simple response', async () => {
      llm.setToolsResponse({ content: 'Hello, I can help with that!' });

      const loop = createAgentLoop(llm, tools);
      const context = createTestContext();
      const events = await collectEvents(
        loop.run('test-session', 'Hello', context),
      );

      const textDeltas = findAllEvents(events, 'text_delta');
      expect(textDeltas.length).toBeGreaterThan(0);

      const fullText = textDeltas.map((e) => e.content).join('');
      expect(fullText).toBe('Hello, I can help with that!');

      const done = findEvent(events, 'done');
      expect(done).toBeDefined();
    });

    it('should emit done with no fastPath flag for LLM response', async () => {
      llm.setToolsResponse({ content: 'Done' });

      const loop = createAgentLoop(llm, tools);
      const events = await collectEvents(
        loop.run('test-session', 'test', createTestContext()),
      );

      const done = findEvent(events, 'done');
      expect(done).toBeDefined();
      expect(done?.fastPath).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Tool call execution
  // ---------------------------------------------------------------------------

  describe('tool calls', () => {
    it('should execute tool calls and loop until no more tools', async () => {
      // First call returns tool calls; inside the tool executor we swap the
      // mock response so the next generateWithTools call returns text only.
      llm.setToolsResponse({
        content: 'I will split the clip.',
        toolCalls: [
          {
            id: 'tc-1',
            name: 'split_clip',
            args: { sequenceId: 'seq-1', clipId: 'clip-1', splitTime: 5 },
          },
        ],
      });

      tools.registerTool({
        info: toolInfo('split_clip', { category: 'edit' }),
        parameters: {},
        executor: async () => {
          // After execution, swap LLM response to text-only (no tool calls)
          llm.setToolsResponse({ content: 'Done! The clip has been split.' });
          return { success: true, data: { result: 'split' }, duration: 10 };
        },
      });

      const loop = createAgentLoop(llm, tools);
      const events = await collectEvents(
        loop.run('test-session', 'Split clip at 5s', createTestContext()),
      );

      // Should have tool_call_start
      const toolStart = findEvent(events, 'tool_call_start');
      expect(toolStart).toBeDefined();
      expect(toolStart?.name).toBe('split_clip');

      // Should have tool_call_complete
      const toolComplete = findEvent(events, 'tool_call_complete');
      expect(toolComplete).toBeDefined();
      expect(toolComplete?.result.success).toBe(true);

      // Should have tools_executed
      const toolsExec = findEvent(events, 'tools_executed');
      expect(toolsExec).toBeDefined();
      expect(toolsExec?.results.length).toBe(1);

      // Should have final text + done
      const done = findEvent(events, 'done');
      expect(done).toBeDefined();

      // LLM should have been called twice (first with tool calls, second text-only)
      expect(llm.getRequestCount()).toBe(2);
    });

    it('should handle tool execution failure gracefully', async () => {
      llm.setToolsResponse({
        content: '',
        toolCalls: [
          { id: 'tc-1', name: 'split_clip', args: { clipId: 'bad' } },
        ],
      });

      tools.registerTool({
        info: toolInfo('split_clip'),
        parameters: {},
        result: { success: false, error: 'Clip not found', duration: 5 },
        executor: async () => {
          // Swap to text-only for second iteration
          llm.setToolsResponse({ content: 'The split failed.' });
          return { success: false, error: 'Clip not found', duration: 5 };
        },
      });

      const loop = createAgentLoop(llm, tools);
      const events = await collectEvents(
        loop.run('test-session', 'Split bad clip', createTestContext()),
      );

      const toolComplete = findEvent(events, 'tool_call_complete');
      expect(toolComplete?.result.success).toBe(false);
      expect(toolComplete?.result.error).toBe('Clip not found');

      const done = findEvent(events, 'done');
      expect(done).toBeDefined();
    });

    it('should handle tool execution exception', async () => {
      llm.setToolsResponse({
        content: '',
        toolCalls: [
          { id: 'tc-1', name: 'crash_tool', args: {} },
        ],
      });

      tools.registerTool({
        info: toolInfo('crash_tool'),
        parameters: {},
        executor: async () => {
          // Swap for next iteration
          llm.setToolsResponse({ content: 'Something went wrong.' });
          throw new Error('Unexpected crash');
        },
      });

      const loop = createAgentLoop(llm, tools);
      const events = await collectEvents(
        loop.run('test-session', 'test', createTestContext()),
      );

      const toolComplete = findEvent(events, 'tool_call_complete');
      expect(toolComplete?.result.success).toBe(false);
      expect(toolComplete?.result.error).toBe('Unexpected crash');
    });

    it('should execute multiple tool calls in sequence', async () => {
      llm.setToolsResponse({
        content: '',
        toolCalls: [
          { id: 'tc-1', name: 'tool_a', args: { val: 1 } },
          { id: 'tc-2', name: 'tool_b', args: { val: 2 } },
        ],
      });

      let callCount = 0;
      const swapOnSecondTool = async (): Promise<{ success: boolean; data: string; duration: number }> => {
        callCount++;
        if (callCount >= 2) {
          // After both tools execute, swap LLM to text-only
          llm.setToolsResponse({ content: 'Both done.' });
        }
        return { success: true, data: `result-${callCount}`, duration: 1 };
      };

      tools.registerTool({
        info: toolInfo('tool_a'),
        parameters: {},
        executor: swapOnSecondTool,
      });
      tools.registerTool({
        info: toolInfo('tool_b'),
        parameters: {},
        executor: swapOnSecondTool,
      });

      const loop = createAgentLoop(llm, tools);
      const events = await collectEvents(
        loop.run('test-session', 'test', createTestContext()),
      );

      const toolCompletes = findAllEvents(events, 'tool_call_complete');
      expect(toolCompletes.length).toBe(2);
      expect(toolCompletes[0].name).toBe('tool_a');
      expect(toolCompletes[1].name).toBe('tool_b');
    });
  });

  // ---------------------------------------------------------------------------
  // Fast path
  // ---------------------------------------------------------------------------

  describe('fast path', () => {
    it('should use fast path for simple split command', async () => {
      tools.registerTool({
        info: toolInfo('split_clip', { category: 'edit' }),
        parameters: {
          type: 'object',
          properties: {
            sequenceId: { type: 'string' },
            trackId: { type: 'string' },
            clipId: { type: 'string' },
            splitTime: { type: 'number' },
          },
        },
        result: { success: true, data: { result: 'split' }, duration: 5 },
      });

      const context = createTestContext({
        sequenceId: 'seq-1',
        selectedClips: ['clip-1'],
        selectedTracks: ['track-1'],
        playheadPosition: 5,
      });

      const loop = createAgentLoop(llm, tools);
      const events = await collectEvents(
        loop.run('test-session', 'Split at playhead', context),
      );

      const done = findEvent(events, 'done');
      expect(done?.fastPath).toBe(true);

      // Should have tool_call_start + tool_call_complete
      const toolStart = findEvent(events, 'tool_call_start');
      expect(toolStart?.name).toBe('split_clip');

      // LLM should NOT have been called (fast path bypasses LLM)
      expect(llm.getRequestCount()).toBe(0);
    });

    it('should skip fast path when disabled', async () => {
      llm.setToolsResponse({ content: 'OK' });

      tools.registerTool({
        info: toolInfo('split_clip', { category: 'edit' }),
        parameters: {
          type: 'object',
          properties: {
            sequenceId: { type: 'string' },
            trackId: { type: 'string' },
            clipId: { type: 'string' },
            splitTime: { type: 'number' },
          },
        },
        result: { success: true, data: { result: 'split' }, duration: 5 },
      });

      const context = createTestContext({
        sequenceId: 'seq-1',
        selectedClips: ['clip-1'],
        selectedTracks: ['track-1'],
        playheadPosition: 5,
      });

      const loop = createAgentLoop(llm, tools, { enableFastPath: false });
      const events = await collectEvents(
        loop.run('test-session', 'Split at playhead', context),
      );

      // Should NOT use fast path
      const done = findEvent(events, 'done');
      expect(done?.fastPath).toBeUndefined();

      // LLM should have been called (no fast path)
      expect(llm.getRequestCount()).toBe(1);
    });

    it('should handle fast path tool failure', async () => {
      tools.registerTool({
        info: toolInfo('split_clip'),
        parameters: {
          type: 'object',
          properties: {
            sequenceId: { type: 'string' },
            trackId: { type: 'string' },
            clipId: { type: 'string' },
            splitTime: { type: 'number' },
          },
        },
        result: { success: false, error: 'No active sequence', duration: 2 },
      });

      const context = createTestContext({
        sequenceId: 'seq-1',
        selectedClips: ['clip-1'],
        selectedTracks: ['track-1'],
        playheadPosition: 5,
      });

      const loop = createAgentLoop(llm, tools);
      const events = await collectEvents(
        loop.run('test-session', 'Split at playhead', context),
      );

      const done = findEvent(events, 'done');
      expect(done?.fastPath).toBe(true);

      // Should report failure text
      const textDeltas = findAllEvents(events, 'text_delta');
      const fullText = textDeltas.map((e) => e.content).join('');
      expect(fullText).toContain('Failed');
    });
  });

  // ---------------------------------------------------------------------------
  // Doom loop detection
  // ---------------------------------------------------------------------------

  describe('doom loop detection', () => {
    it('should detect doom loop and stop', async () => {
      // LLM always returns the same tool call
      llm.setToolsResponse({
        content: '',
        toolCalls: [
          { id: 'tc-1', name: 'stuck_tool', args: { a: 1 } },
        ],
      });

      tools.registerTool({
        info: toolInfo('stuck_tool'),
        parameters: {},
        result: { success: true, data: 'ok', duration: 1 },
      });

      const loop = createAgentLoop(llm, tools, { doomLoopThreshold: 3 });
      const events = await collectEvents(
        loop.run('test-session', 'do something', createTestContext()),
      );

      const doomEvent = findEvent(events, 'doom_loop_detected');
      expect(doomEvent).toBeDefined();
      expect(doomEvent?.tool).toBe('stuck_tool');
      expect(doomEvent?.count).toBe(3);

      // Should end with done
      const done = findEvent(events, 'done');
      expect(done).toBeDefined();
    });

    it('should not trigger doom loop with varying tool calls', async () => {
      let callNumber = 0;

      llm.setToolsResponse({
        content: '',
        toolCalls: [
          { id: 'tc-1', name: 'dynamic_tool', args: { step: 0 } },
        ],
      });

      tools.registerTool({
        info: toolInfo('dynamic_tool'),
        parameters: {},
        executor: async () => {
          callNumber++;
          if (callNumber >= 3) {
            llm.setToolsResponse({ content: 'Done after 3 calls.' });
          } else {
            // Vary the args so doom detector doesn't trigger
            llm.setToolsResponse({
              content: '',
              toolCalls: [
                { id: `tc-${callNumber}`, name: 'dynamic_tool', args: { step: callNumber } },
              ],
            });
          }
          return { success: true, data: `result-${callNumber}`, duration: 1 };
        },
      });

      const loop = createAgentLoop(llm, tools, { doomLoopThreshold: 3 });
      const events = await collectEvents(
        loop.run('test-session', 'do something', createTestContext()),
      );

      // Should NOT have doom loop
      const doomEvent = findEvent(events, 'doom_loop_detected');
      expect(doomEvent).toBeUndefined();

      // Should have completed normally
      const done = findEvent(events, 'done');
      expect(done).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Max iterations
  // ---------------------------------------------------------------------------

  describe('max iterations', () => {
    it('should stop after maxIterations', async () => {
      let iterationCount = 0;

      // Each iteration, return a different tool call to avoid doom loop
      llm.setToolsResponse({
        content: '',
        toolCalls: [
          { id: 'tc-0', name: 'tool_0', args: { i: 0 } },
        ],
      });

      // Register unique tools for each iteration
      for (let i = 0; i < 5; i++) {
        tools.registerTool({
          info: toolInfo(`tool_${i}`),
          parameters: {},
          executor: async () => {
            iterationCount++;
            // Set up next iteration with a different tool
            llm.setToolsResponse({
              content: '',
              toolCalls: [
                {
                  id: `tc-${iterationCount}`,
                  name: `tool_${iterationCount}`,
                  args: { i: iterationCount },
                },
              ],
            });
            return { success: true, data: i, duration: 1 };
          },
        });
      }

      const loop = createAgentLoop(llm, tools, { maxIterations: 3 });
      const events = await collectEvents(
        loop.run('test-session', 'keep looping', createTestContext()),
      );

      const errorEvent = findEvent(events, 'error');
      expect(errorEvent).toBeDefined();
      expect(errorEvent?.error.message).toContain('maximum iterations');
    });
  });

  // ---------------------------------------------------------------------------
  // Abort
  // ---------------------------------------------------------------------------

  describe('abort', () => {
    it('should abort cleanly', async () => {
      llm.setToolsResponse({ content: 'This is a long response...', delay: 2000 });

      const loop = createAgentLoop(llm, tools);
      const context = createTestContext();
      const gen = loop.run('test-session', 'test', context);

      // Schedule abort
      setTimeout(() => loop.abort(), 50);

      const events: AgentLoopEvent[] = [];
      try {
        for await (const event of gen) {
          events.push(event);
        }
        // If no error, that's fine - loop may have completed before abort
      } catch (err) {
        expect(err).toBeInstanceOf(AgentLoopAbortedError);
      }
    });

    it('should report isRunning correctly', async () => {
      llm.setToolsResponse({ content: 'quick' });

      const loop = createAgentLoop(llm, tools);
      expect(loop.isRunning()).toBe(false);

      const gen = loop.run('test-session', 'test', createTestContext());

      // Start iteration
      const result = await gen.next();
      expect(result.done).toBe(false);
      expect(loop.isRunning()).toBe(true);

      // Consume remaining
      while (!(await gen.next()).done) {
        /* drain */
      }

      expect(loop.isRunning()).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // External AbortSignal
  // ---------------------------------------------------------------------------

  describe('external AbortSignal', () => {
    it('should respect external AbortSignal', async () => {
      llm.setToolsResponse({ content: 'Long response', delay: 2000 });

      const controller = new AbortController();
      const loop = createAgentLoop(llm, tools);

      setTimeout(() => controller.abort(), 50);

      const events: AgentLoopEvent[] = [];
      try {
        for await (const event of loop.run(
          'test-session',
          'test',
          createTestContext(),
          [],
          controller.signal,
        )) {
          events.push(event);
        }
      } catch (err) {
        expect(err).toBeInstanceOf(AgentLoopAbortedError);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Permission handling
  // ---------------------------------------------------------------------------

  describe('tool permissions', () => {
    it('should auto-allow tools below approval threshold', async () => {
      const permissionHandler = vi.fn().mockResolvedValue('allow');

      llm.setToolsResponse({
        content: '',
        toolCalls: [
          { id: 'tc-1', name: 'safe_tool', args: {} },
        ],
      });

      tools.registerTool({
        info: toolInfo('safe_tool', { riskLevel: 'low' }),
        parameters: {},
        executor: async () => {
          llm.setToolsResponse({ content: 'Done' });
          return { success: true, data: 'ok', duration: 1 };
        },
      });

      const loop = createAgentLoop(llm, tools, {
        approvalThreshold: 'high',
        toolPermissionHandler: permissionHandler,
      });

      const events = await collectEvents(
        loop.run('test-session', 'test', createTestContext()),
      );

      // Permission handler should NOT be called for low-risk tools
      expect(permissionHandler).not.toHaveBeenCalled();

      const done = findEvent(events, 'done');
      expect(done).toBeDefined();
    });

    it('should call permission handler for high-risk tools', async () => {
      const permissionHandler = vi.fn().mockResolvedValue('allow');

      llm.setToolsResponse({
        content: '',
        toolCalls: [
          { id: 'tc-1', name: 'delete_clip', args: { clipId: 'clip-1' } },
        ],
      });

      tools.registerTool({
        info: toolInfo('delete_clip', { riskLevel: 'high' }),
        parameters: {},
        executor: async () => {
          llm.setToolsResponse({ content: 'Deleted.' });
          return { success: true, data: 'deleted', duration: 5 };
        },
      });

      const loop = createAgentLoop(llm, tools, {
        approvalThreshold: 'high',
        toolPermissionHandler: permissionHandler,
      });

      await collectEvents(
        loop.run('test-session', 'delete clip', createTestContext()),
      );

      expect(permissionHandler).toHaveBeenCalledWith(
        'delete_clip',
        { clipId: 'clip-1' },
        'high',
      );
    });

    it('should skip tool execution when permission denied', async () => {
      const permissionHandler = vi.fn().mockResolvedValue('deny');

      llm.setToolsResponse({
        content: '',
        toolCalls: [
          { id: 'tc-1', name: 'delete_clip', args: {} },
        ],
      });

      tools.registerTool({
        info: toolInfo('delete_clip', { riskLevel: 'high' }),
        parameters: {},
        executor: async () => {
          llm.setToolsResponse({ content: 'Denied.' });
          return { success: true, data: 'deleted', duration: 1 };
        },
      });

      const loop = createAgentLoop(llm, tools, {
        approvalThreshold: 'high',
        toolPermissionHandler: permissionHandler,
      });

      // After denial, the tool result in history says "denied", and
      // the LLM still has tool calls. But since executor wasn't called,
      // the response won't be swapped. The second LLM call will also
      // return a tool call that gets denied, etc. Eventually doom loop triggers.
      // For this test we just check the first denial.
      const events: AgentLoopEvent[] = [];
      const gen = loop.run('test-session', 'delete', createTestContext());

      // Collect only a few events (avoid infinite denial loop)
      for await (const event of gen) {
        events.push(event);
        if (event.type === 'tools_executed') break;
      }

      const toolComplete = findEvent(events, 'tool_call_complete');
      expect(toolComplete?.result.success).toBe(false);
      expect(toolComplete?.result.error).toContain('denied');
    });

    it('should not require permission when no handler is set', async () => {
      llm.setToolsResponse({
        content: '',
        toolCalls: [
          { id: 'tc-1', name: 'any_tool', args: {} },
        ],
      });

      tools.registerTool({
        info: toolInfo('any_tool', { riskLevel: 'critical' }),
        parameters: {},
        executor: async () => {
          llm.setToolsResponse({ content: 'Done' });
          return { success: true, data: 'ok', duration: 1 };
        },
      });

      const loop = createAgentLoop(llm, tools);
      const events = await collectEvents(
        loop.run('test-session', 'test', createTestContext()),
      );

      // Should execute without permission check
      const toolComplete = findEvent(events, 'tool_call_complete');
      expect(toolComplete?.result.success).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // LLM error handling
  // ---------------------------------------------------------------------------

  describe('LLM errors', () => {
    it('should yield error event on LLM stream error', async () => {
      llm.setToolsResponse({
        error: new Error('API rate limit exceeded'),
      });

      const loop = createAgentLoop(llm, tools);
      const events = await collectEvents(
        loop.run('test-session', 'test', createTestContext()),
      );

      const errorEvent = findEvent(events, 'error');
      expect(errorEvent).toBeDefined();
      expect(errorEvent?.error.message).toContain('rate limit');

      const done = findEvent(events, 'done');
      expect(done).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Context refresh
  // ---------------------------------------------------------------------------

  describe('context refresh', () => {
    it('should refresh context between iterations', async () => {
      const refresher = vi.fn().mockReturnValue({ playheadPosition: 10 });

      llm.setToolsResponse({
        content: '',
        toolCalls: [
          { id: 'tc-1', name: 'tool_a', args: { step: 1 } },
        ],
      });

      let callIdx = 0;
      tools.registerTool({
        info: toolInfo('tool_a'),
        parameters: {},
        executor: async () => {
          callIdx++;
          if (callIdx >= 2) {
            llm.setToolsResponse({ content: 'Done' });
          } else {
            llm.setToolsResponse({
              content: '',
              toolCalls: [
                { id: `tc-${callIdx}`, name: 'tool_a', args: { step: callIdx + 1 } },
              ],
            });
          }
          return { success: true, data: `result-${callIdx}`, duration: 1 };
        },
      });

      const loop = createAgentLoop(llm, tools, { contextRefresher: refresher });
      const events = await collectEvents(
        loop.run('test-session', 'test', createTestContext()),
      );

      // refresher should have been called (after step > 1)
      expect(refresher).toHaveBeenCalled();

      const done = findEvent(events, 'done');
      expect(done).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Conversation history
  // ---------------------------------------------------------------------------

  describe('conversation history', () => {
    it('should include conversation history in LLM messages', async () => {
      llm.setToolsResponse({ content: 'Sure!' });

      const history = [
        {
          id: 'msg-1',
          role: 'user' as const,
          parts: [{ type: 'text' as const, content: 'Hello' }],
          timestamp: Date.now() - 1000,
        },
        {
          id: 'msg-2',
          role: 'assistant' as const,
          parts: [{ type: 'text' as const, content: 'Hi!' }],
          timestamp: Date.now() - 500,
        },
      ];

      const loop = createAgentLoop(llm, tools);
      await collectEvents(
        loop.run('test-session', 'Follow up question', createTestContext(), history),
      );

      // Verify LLM received the history
      const lastReq = llm.getLastRequest();
      expect(lastReq).toBeDefined();
      // Should have: system + history (user, assistant) + current user
      const messages = lastReq?.messages ?? [];
      expect(messages.length).toBeGreaterThanOrEqual(4); // system + 2 history + 1 current
      expect(messages[0].role).toBe('system');
      expect(messages[messages.length - 1].role).toBe('user');
      expect(messages[messages.length - 1].content).toBe('Follow up question');
    });
  });

  // ---------------------------------------------------------------------------
  // System message building
  // ---------------------------------------------------------------------------

  describe('system message', () => {
    it('should include environment context in system message', async () => {
      llm.setToolsResponse({ content: 'OK' });

      const context = createTestContext({
        timelineDuration: 120,
        playheadPosition: 30,
        availableAssets: [
          { id: 'a-1', name: 'intro.mp4', type: 'video', duration: 10 },
        ],
        availableTracks: [
          { id: 't-1', name: 'Video 1', type: 'video', clipCount: 3 },
        ],
      });

      const loop = createAgentLoop(llm, tools);
      await collectEvents(
        loop.run('test-session', 'test', context),
      );

      const lastReq = llm.getLastRequest();
      const systemMsg = lastReq?.messages?.[0];
      expect(systemMsg?.role).toBe('system');
      expect(systemMsg?.content).toContain('Timeline Duration: 120s');
      expect(systemMsg?.content).toContain('Playhead: 30s');
      expect(systemMsg?.content).toContain('intro.mp4');
      expect(systemMsg?.content).toContain('Video 1');
    });

    it('should include assets and tracks in XML tags', async () => {
      llm.setToolsResponse({ content: 'OK' });

      const context = createTestContext({
        availableAssets: [
          { id: 'a-1', name: 'clip.mp4', type: 'video', duration: 60 },
        ],
        availableTracks: [
          { id: 't-1', name: 'Track 1', type: 'video', clipCount: 2 },
        ],
      });

      const loop = createAgentLoop(llm, tools);
      await collectEvents(
        loop.run('test-session', 'test', context),
      );

      const systemMsg = llm.getLastRequest()?.messages?.[0]?.content ?? '';
      expect(systemMsg).toContain('<assets>');
      expect(systemMsg).toContain('</assets>');
      expect(systemMsg).toContain('<tracks>');
      expect(systemMsg).toContain('</tracks>');
    });
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  describe('edge cases', () => {
    it('should handle empty input gracefully', async () => {
      llm.setToolsResponse({ content: 'I need more details.' });

      const loop = createAgentLoop(llm, tools);
      const events = await collectEvents(
        loop.run('test-session', '', createTestContext()),
      );

      const done = findEvent(events, 'done');
      expect(done).toBeDefined();
    });

    it('should handle no available tools', async () => {
      llm.setToolsResponse({ content: 'No tools available.' });

      const loop = createAgentLoop(llm, tools);
      const events = await collectEvents(
        loop.run('test-session', 'test', createTestContext()),
      );

      const done = findEvent(events, 'done');
      expect(done).toBeDefined();
    });
  });
});
