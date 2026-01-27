/**
 * Agent Interface Tests
 *
 * TDD tests for the base Agent interface and abstract class.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  AgentConfig,
  AgentMessage,
  AgentTool,
  AgentToolResult,
  AgentContext,
  AgentResponse,
  AgentStatus,
} from './Agent';
import { Agent } from './Agent';

// =============================================================================
// Mock Implementation for Testing
// =============================================================================

class TestAgent extends Agent {
  public processCount = 0;

  protected async processMessage(
    message: AgentMessage,
    // Context is required by interface but not used in test implementation
    context: AgentContext
  ): Promise<AgentResponse> {
    // Consume context to satisfy no-unused-vars rule
    void context;
    this.processCount++;
    return {
      message: {
        role: 'assistant',
        content: `Processed: ${message.content}`,
      },
      toolCalls: [],
      shouldContinue: false,
    };
  }

  protected async executeToolCall(
    _tool: AgentTool,
    args: Record<string, unknown>
  ): Promise<AgentToolResult> {
    return {
      success: true,
      result: { args },
    };
  }
}

// =============================================================================
// Tests
// =============================================================================

describe('Agent', () => {
  let agent: TestAgent;
  let config: AgentConfig;

  beforeEach(() => {
    config = {
      name: 'test-agent',
      description: 'A test agent for unit tests',
      maxIterations: 10,
      tools: [],
    };
    agent = new TestAgent(config);
  });

  describe('Construction', () => {
    it('creates an agent with the given config', () => {
      expect(agent.name).toBe('test-agent');
      expect(agent.description).toBe('A test agent for unit tests');
    });

    it('has idle status initially', () => {
      expect(agent.status).toBe('idle');
    });

    it('has empty conversation history initially', () => {
      expect(agent.conversationHistory).toEqual([]);
    });
  });

  describe('run()', () => {
    it('processes a simple message', async () => {
      const result = await agent.run('Hello, agent!');

      expect(result.message.role).toBe('assistant');
      expect(result.message.content).toContain('Processed');
    });

    it('adds messages to conversation history', async () => {
      await agent.run('First message');

      expect(agent.conversationHistory).toHaveLength(2);
      expect(agent.conversationHistory[0].role).toBe('user');
      expect(agent.conversationHistory[1].role).toBe('assistant');
    });

    it('sets status to processing during execution', async () => {
      let statusDuringRun: AgentStatus = 'idle';

      const originalProcess = agent['processMessage'].bind(agent);
      vi.spyOn(agent as any, 'processMessage').mockImplementation(
        async (...args: unknown[]) => {
          statusDuringRun = agent.status;
          return originalProcess(...(args as [AgentMessage, AgentContext]));
        }
      );

      await agent.run('Test');
      expect(statusDuringRun).toBe('processing');
    });

    it('sets status back to idle after completion', async () => {
      await agent.run('Test');
      expect(agent.status).toBe('idle');
    });

    it('sets status to error on failure', async () => {
      vi.spyOn(agent as any, 'processMessage').mockRejectedValue(
        new Error('Test error')
      );

      await expect(agent.run('Test')).rejects.toThrow('Test error');
      expect(agent.status).toBe('error');
    });

    it('respects maxIterations limit', async () => {
      const limitedConfig: AgentConfig = {
        ...config,
        maxIterations: 3,
      };
      const limitedAgent = new TestAgent(limitedConfig);

      // Mock to always request continuation
      vi.spyOn(limitedAgent as unknown as { processMessage: () => Promise<AgentResponse> }, 'processMessage').mockResolvedValue({
        message: { role: 'assistant', content: 'Continue' },
        toolCalls: [],
        shouldContinue: true,
      });

      await limitedAgent.run('Start');

      expect(limitedAgent.processCount).toBeLessThanOrEqual(3);
    });
  });

  describe('runWithContext()', () => {
    it('passes context to processMessage', async () => {
      const context: AgentContext = {
        projectId: 'proj_001',
        sequenceId: 'seq_001',
        selectedClipIds: ['clip_001'],
        playheadPosition: 5.5,
        timelineDuration: 120,
      };

      let receivedContext: AgentContext | null = null;
      const mockFn = vi.fn().mockImplementation(
        async (_msg: unknown, ctx: unknown) => {
          receivedContext = ctx as AgentContext;
          return {
            message: { role: 'assistant', content: 'OK' },
            toolCalls: [],
            shouldContinue: false,
          };
        }
      );
      vi.spyOn(agent as unknown as { processMessage: typeof mockFn }, 'processMessage').mockImplementation(mockFn);

      await agent.runWithContext('Test', context);

      expect(receivedContext).toEqual(context);
    });
  });

  describe('reset()', () => {
    it('clears conversation history', async () => {
      await agent.run('Message 1');
      await agent.run('Message 2');
      expect(agent.conversationHistory.length).toBeGreaterThan(0);

      agent.reset();
      expect(agent.conversationHistory).toEqual([]);
    });

    it('resets status to idle', async () => {
      vi.spyOn(agent as any, 'processMessage').mockRejectedValue(
        new Error('Test')
      );
      await expect(agent.run('Test')).rejects.toThrow();
      expect(agent.status).toBe('error');

      agent.reset();
      expect(agent.status).toBe('idle');
    });
  });

  describe('Tool Registration', () => {
    it('registers a tool', () => {
      const tool: AgentTool = {
        name: 'split_clip',
        description: 'Split a clip at the given position',
        parameters: {
          type: 'object',
          properties: {
            clipId: { type: 'string' },
            position: { type: 'number' },
          },
          required: ['clipId', 'position'],
        },
      };

      agent.registerTool(tool);
      expect(agent.tools).toContainEqual(tool);
    });

    it('prevents duplicate tool registration', () => {
      const tool: AgentTool = {
        name: 'split_clip',
        description: 'Split a clip',
        parameters: { type: 'object', properties: {} },
      };

      agent.registerTool(tool);
      agent.registerTool(tool);

      const toolCount = agent.tools.filter((t) => t.name === 'split_clip').length;
      expect(toolCount).toBe(1);
    });

    it('unregisters a tool', () => {
      const tool: AgentTool = {
        name: 'delete_clip',
        description: 'Delete a clip',
        parameters: { type: 'object', properties: {} },
      };

      agent.registerTool(tool);
      expect(agent.tools).toContainEqual(tool);

      agent.unregisterTool('delete_clip');
      expect(agent.tools).not.toContainEqual(tool);
    });
  });

  describe('Events', () => {
    it('emits onMessage when receiving assistant response', async () => {
      const onMessage = vi.fn();
      agent.on('message', onMessage);

      await agent.run('Hello');

      expect(onMessage).toHaveBeenCalled();
      const call = onMessage.mock.calls[0][0];
      expect(call.role).toBe('assistant');
    });

    it('emits onStatusChange when status changes', async () => {
      const onStatusChange = vi.fn();
      agent.on('statusChange', onStatusChange);

      await agent.run('Hello');

      expect(onStatusChange).toHaveBeenCalledWith('processing');
      expect(onStatusChange).toHaveBeenCalledWith('idle');
    });

    it('emits onToolCall when a tool is called', async () => {
      const tool: AgentTool = {
        name: 'test_tool',
        description: 'A test tool',
        parameters: { type: 'object', properties: {} },
      };
      agent.registerTool(tool);

      vi.spyOn(agent as any, 'processMessage').mockResolvedValueOnce({
        message: { role: 'assistant', content: 'Calling tool' },
        toolCalls: [{ name: 'test_tool', arguments: {} }],
        shouldContinue: true,
      }).mockResolvedValueOnce({
        message: { role: 'assistant', content: 'Done' },
        toolCalls: [],
        shouldContinue: false,
      });

      const onToolCall = vi.fn();
      agent.on('toolCall', onToolCall);

      await agent.run('Use the tool');

      expect(onToolCall).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'test_tool' })
      );
    });

    it('removes event listener with off()', async () => {
      const onMessage = vi.fn();
      agent.on('message', onMessage);
      agent.off('message', onMessage);

      await agent.run('Hello');

      expect(onMessage).not.toHaveBeenCalled();
    });
  });
});

describe('AgentMessage', () => {
  it('has correct structure for user message', () => {
    const message: AgentMessage = {
      role: 'user',
      content: 'Hello',
    };

    expect(message.role).toBe('user');
    expect(message.content).toBe('Hello');
  });

  it('has correct structure for assistant message', () => {
    const message: AgentMessage = {
      role: 'assistant',
      content: 'Hello back',
      toolCalls: [{ name: 'test', arguments: {} }],
    };

    expect(message.role).toBe('assistant');
    expect(message.toolCalls).toHaveLength(1);
  });

  it('has correct structure for system message', () => {
    const message: AgentMessage = {
      role: 'system',
      content: 'You are a helpful assistant',
    };

    expect(message.role).toBe('system');
  });

  it('has correct structure for tool result message', () => {
    const message: AgentMessage = {
      role: 'tool',
      content: JSON.stringify({ result: 'success' }),
      toolCallId: 'call_123',
    };

    expect(message.role).toBe('tool');
    expect(message.toolCallId).toBe('call_123');
  });
});
