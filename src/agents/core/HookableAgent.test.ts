/**
 * Hookable Agent Tests
 *
 * Tests for HookableAgent hook integration.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  HookableAgent,
  type HookableAgentConfig,
} from './HookableAgent';
import type {
  AgentContext,
  AgentMessage,
  AgentResponse,
  AgentTool,
  AgentToolResult,
} from '../Agent';
import { HookManager } from './AgentHooks';

// =============================================================================
// Test Implementation
// =============================================================================

/**
 * Concrete implementation for testing.
 */
class TestHookableAgent extends HookableAgent {
  public processMessageFn = vi.fn<
    (message: AgentMessage, context: AgentContext) => Promise<AgentResponse>
  >();
  public executeToolCallFn = vi.fn<
    (tool: AgentTool, args: Record<string, unknown>) => Promise<AgentToolResult>
  >();

  constructor(config: Partial<HookableAgentConfig> = {}) {
    super({
      name: 'test-agent',
      description: 'Test hookable agent',
      ...config,
    });

    // Default implementations
    this.processMessageFn.mockResolvedValue({
      message: { role: 'assistant', content: 'Default response' },
      toolCalls: [],
      shouldContinue: false,
    });

    this.executeToolCallFn.mockResolvedValue({
      success: true,
      result: { executed: true },
    });
  }

  protected async processMessageImpl(
    message: AgentMessage,
    context: AgentContext
  ): Promise<AgentResponse> {
    return this.processMessageFn(message, context);
  }

  protected async executeToolCallImpl(
    tool: AgentTool,
    args: Record<string, unknown>
  ): Promise<AgentToolResult> {
    return this.executeToolCallFn(tool, args);
  }
}

// =============================================================================
// Tests
// =============================================================================

describe('HookableAgent', () => {
  let agent: TestHookableAgent;

  beforeEach(() => {
    agent = new TestHookableAgent();
  });

  describe('basic functionality', () => {
    it('should process messages without hooks', async () => {
      const response = await agent.run('Hello');

      expect(response.message.role).toBe('assistant');
      expect(agent.processMessageFn).toHaveBeenCalled();
    });

    it('should track turn numbers', async () => {
      expect(agent.getCurrentTurn()).toBe(0);

      await agent.run('First message');
      expect(agent.getCurrentTurn()).toBe(1);

      await agent.run('Second message');
      expect(agent.getCurrentTurn()).toBe(2);
    });

    it('should reset turn counter on reset', async () => {
      await agent.run('Message');
      expect(agent.getCurrentTurn()).toBe(1);

      agent.reset();
      expect(agent.getCurrentTurn()).toBe(0);
    });
  });

  describe('hook registration', () => {
    it('should return unsubscribe function for preToolUse', () => {
      const unsubscribe = agent.onPreToolUse(() => ({ shouldProceed: true }));
      expect(typeof unsubscribe).toBe('function');

      expect(agent.getHookManager().getHookCounts().preToolUse).toBe(1);
      unsubscribe();
      expect(agent.getHookManager().getHookCounts().preToolUse).toBe(0);
    });

    it('should return unsubscribe function for postToolUse', () => {
      const unsubscribe = agent.onPostToolUse(() => ({}));
      expect(typeof unsubscribe).toBe('function');
    });

    it('should return unsubscribe function for preMessage', () => {
      const unsubscribe = agent.onPreMessage(() => ({ shouldProceed: true }));
      expect(typeof unsubscribe).toBe('function');
    });

    it('should return unsubscribe function for postMessage', () => {
      const unsubscribe = agent.onPostMessage(() => ({}));
      expect(typeof unsubscribe).toBe('function');
    });

    it('should accept custom hook manager', () => {
      const customManager = new HookManager();
      const hookFn = vi.fn(() => ({ shouldProceed: true }));
      customManager.onPreToolUse(hookFn);

      const agentWithManager = new TestHookableAgent({
        hookManager: customManager,
      });

      expect(agentWithManager.getHookManager()).toBe(customManager);
    });
  });

  describe('preMessage hooks', () => {
    it('should execute preMessage hooks before processing', async () => {
      const hookFn = vi.fn(() => ({ shouldProceed: true }));
      agent.onPreMessage(hookFn);

      await agent.run('Test message');

      expect(hookFn).toHaveBeenCalledWith({
        content: 'Test message',
        turnNumber: 1,
      });
    });

    it('should block message when shouldProceed is false', async () => {
      agent.onPreMessage(() => ({
        shouldProceed: false,
        reason: 'Content blocked',
      }));

      const response = await agent.run('Blocked message');

      expect(response.message.content).toBe('Content blocked');
      expect(agent.processMessageFn).not.toHaveBeenCalled();
    });

    it('should pass modified content to processMessageImpl', async () => {
      agent.onPreMessage(() => ({
        shouldProceed: true,
        modifiedContent: 'Modified message',
      }));

      await agent.run('Original message');

      expect(agent.processMessageFn).toHaveBeenCalledWith(
        expect.objectContaining({ content: 'Modified message' }),
        expect.anything()
      );
    });
  });

  describe('postMessage hooks', () => {
    it('should execute postMessage hooks after processing', async () => {
      const hookFn = vi.fn(() => ({}));
      agent.onPostMessage(hookFn);

      agent.processMessageFn.mockResolvedValueOnce({
        message: { role: 'assistant', content: 'Response content' },
        toolCalls: [],
        shouldContinue: false,
      });

      await agent.run('User message');

      expect(hookFn).toHaveBeenCalledWith({
        userContent: 'User message',
        assistantContent: 'Response content',
        turnNumber: 1,
      });
    });

    it('should apply modified response content', async () => {
      agent.onPostMessage(() => ({
        modifiedContent: 'Modified response',
      }));

      const response = await agent.run('User message');

      expect(response.message.content).toBe('Modified response');
    });
  });

  describe('preToolUse hooks', () => {
    it('should execute hooks before tool calls', async () => {
      const hookFn = vi.fn(() => ({ shouldProceed: true }));
      agent.onPreToolUse(hookFn);

      const tool: AgentTool = {
        name: 'test_tool',
        description: 'Test tool',
        parameters: { type: 'object', properties: {} },
      };

      // Make processMessage return tool calls
      agent.processMessageFn.mockResolvedValueOnce({
        message: {
          role: 'assistant',
          content: 'Calling tool',
          toolCalls: [{ name: 'test_tool', arguments: { foo: 'bar' } }],
        },
        toolCalls: [{ name: 'test_tool', arguments: { foo: 'bar' }, id: 'call_1' }],
        shouldContinue: true,
      });

      // Register the tool
      agent.registerTool(tool);

      // Second response (after tool execution)
      agent.processMessageFn.mockResolvedValueOnce({
        message: { role: 'assistant', content: 'Done' },
        toolCalls: [],
        shouldContinue: false,
      });

      await agent.run('Use the tool');

      expect(hookFn).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: 'test_tool',
          args: { foo: 'bar' },
        })
      );
    });

    it('should block tool execution when shouldProceed is false', async () => {
      agent.onPreToolUse(() => ({
        shouldProceed: false,
        reason: 'Tool blocked',
      }));

      const tool: AgentTool = {
        name: 'blocked_tool',
        description: 'Blocked tool',
        parameters: { type: 'object', properties: {} },
      };

      agent.registerTool(tool);

      agent.processMessageFn.mockResolvedValueOnce({
        message: {
          role: 'assistant',
          content: 'Calling tool',
          toolCalls: [{ name: 'blocked_tool', arguments: {} }],
        },
        toolCalls: [{ name: 'blocked_tool', arguments: {}, id: 'call_1' }],
        shouldContinue: true,
      });

      agent.processMessageFn.mockResolvedValueOnce({
        message: { role: 'assistant', content: 'Done' },
        toolCalls: [],
        shouldContinue: false,
      });

      await agent.run('Use blocked tool');

      // Tool implementation should not have been called
      expect(agent.executeToolCallFn).not.toHaveBeenCalled();
    });

    it('should pass modified arguments to tool', async () => {
      agent.onPreToolUse((ctx) => ({
        shouldProceed: true,
        modifiedArgs: { ...ctx.args, injected: true },
      }));

      const tool: AgentTool = {
        name: 'test_tool',
        description: 'Test tool',
        parameters: { type: 'object', properties: {} },
      };

      agent.registerTool(tool);

      agent.processMessageFn.mockResolvedValueOnce({
        message: {
          role: 'assistant',
          content: 'Calling tool',
          toolCalls: [{ name: 'test_tool', arguments: { original: true } }],
        },
        toolCalls: [{ name: 'test_tool', arguments: { original: true }, id: 'call_1' }],
        shouldContinue: true,
      });

      agent.processMessageFn.mockResolvedValueOnce({
        message: { role: 'assistant', content: 'Done' },
        toolCalls: [],
        shouldContinue: false,
      });

      await agent.run('Use tool');

      expect(agent.executeToolCallFn).toHaveBeenCalledWith(
        tool,
        { original: true, injected: true }
      );
    });
  });

  describe('postToolUse hooks', () => {
    it('should execute hooks after tool calls', async () => {
      const hookFn = vi.fn(() => ({}));
      agent.onPostToolUse(hookFn);

      const tool: AgentTool = {
        name: 'test_tool',
        description: 'Test tool',
        parameters: { type: 'object', properties: {} },
      };

      agent.registerTool(tool);

      agent.processMessageFn.mockResolvedValueOnce({
        message: {
          role: 'assistant',
          content: 'Calling tool',
          toolCalls: [{ name: 'test_tool', arguments: {} }],
        },
        toolCalls: [{ name: 'test_tool', arguments: {}, id: 'call_1' }],
        shouldContinue: true,
      });

      agent.processMessageFn.mockResolvedValueOnce({
        message: { role: 'assistant', content: 'Done' },
        toolCalls: [],
        shouldContinue: false,
      });

      await agent.run('Use tool');

      expect(hookFn).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: 'test_tool',
          result: { success: true, result: { executed: true } },
        })
      );
    });

    it('should apply modified result from hook', async () => {
      agent.onPostToolUse(() => ({
        modifiedResult: { success: true, result: { modified: true } },
      }));

      const tool: AgentTool = {
        name: 'test_tool',
        description: 'Test tool',
        parameters: { type: 'object', properties: {} },
      };

      agent.registerTool(tool);

      agent.processMessageFn.mockResolvedValueOnce({
        message: {
          role: 'assistant',
          content: 'Calling tool',
          toolCalls: [{ name: 'test_tool', arguments: {} }],
        },
        toolCalls: [{ name: 'test_tool', arguments: {}, id: 'call_1' }],
        shouldContinue: true,
      });

      agent.processMessageFn.mockResolvedValueOnce({
        message: { role: 'assistant', content: 'Done' },
        toolCalls: [],
        shouldContinue: false,
      });

      await agent.run('Use tool');

      // Check that the modified result was passed to next processing
      // The tool result in conversation history should be modified
      const history = agent.conversationHistory;
      const toolResultMessage = history.find((m) => m.role === 'tool');
      expect(toolResultMessage).toBeDefined();
      if (toolResultMessage) {
        const parsedResult = JSON.parse(toolResultMessage.content);
        expect(parsedResult.result.modified).toBe(true);
      }
    });
  });

  describe('error handling', () => {
    it('should return error result when tool execution throws', async () => {
      agent.executeToolCallFn.mockRejectedValueOnce(new Error('Tool failed'));

      const tool: AgentTool = {
        name: 'failing_tool',
        description: 'Failing tool',
        parameters: { type: 'object', properties: {} },
      };

      agent.registerTool(tool);

      agent.processMessageFn.mockResolvedValueOnce({
        message: {
          role: 'assistant',
          content: 'Calling tool',
          toolCalls: [{ name: 'failing_tool', arguments: {} }],
        },
        toolCalls: [{ name: 'failing_tool', arguments: {}, id: 'call_1' }],
        shouldContinue: true,
      });

      agent.processMessageFn.mockResolvedValueOnce({
        message: { role: 'assistant', content: 'Done' },
        toolCalls: [],
        shouldContinue: false,
      });

      await agent.run('Use failing tool');

      // Check that error was captured in tool result
      const history = agent.conversationHistory;
      const toolResultMessage = history.find((m) => m.role === 'tool');
      expect(toolResultMessage).toBeDefined();
      if (toolResultMessage) {
        const parsedResult = JSON.parse(toolResultMessage.content);
        expect(parsedResult.success).toBe(false);
        expect(parsedResult.error).toBe('Tool failed');
      }
    });
  });
});
