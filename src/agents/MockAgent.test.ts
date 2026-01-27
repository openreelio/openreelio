/**
 * Mock Agent Integration Tests
 *
 * Integration tests using a mock LLM agent to verify the full agent workflow.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MockAgent } from './MockAgent';
import { ToolRegistry, ToolHandler } from './ToolRegistry';
import { ContextBuilder } from './ContextBuilder';
import type { AgentContext } from './Agent';

// =============================================================================
// Test Helpers
// =============================================================================

const createTimelineTools = (registry: ToolRegistry): void => {
  const splitClipHandler: ToolHandler = vi.fn().mockImplementation(async () => ({
    success: true,
    result: { newClipIds: ['clip_new_1', 'clip_new_2'] },
  }));

  const deleteClipHandler: ToolHandler = vi.fn().mockImplementation(async (args) => ({
    success: true,
    result: { deletedClipId: args.clipId },
  }));

  const trimClipHandler: ToolHandler = vi.fn().mockImplementation(async (args) => ({
    success: true,
    result: { trimmedClipId: args.clipId },
  }));

  registry.registerMany([
    {
      name: 'split_clip',
      description: 'Split a clip at the given position',
      category: 'timeline',
      parameters: {
        type: 'object',
        properties: {
          clipId: { type: 'string' },
          position: { type: 'number' },
        },
        required: ['clipId', 'position'],
      },
      handler: splitClipHandler,
    },
    {
      name: 'delete_clip',
      description: 'Delete a clip from the timeline',
      category: 'timeline',
      parameters: {
        type: 'object',
        properties: {
          clipId: { type: 'string' },
        },
        required: ['clipId'],
      },
      handler: deleteClipHandler,
    },
    {
      name: 'trim_clip',
      description: 'Trim a clip to the specified start and end times',
      category: 'timeline',
      parameters: {
        type: 'object',
        properties: {
          clipId: { type: 'string' },
          startTime: { type: 'number' },
          endTime: { type: 'number' },
        },
        required: ['clipId', 'startTime', 'endTime'],
      },
      handler: trimClipHandler,
    },
  ]);
};

// =============================================================================
// Tests
// =============================================================================

describe('MockAgent Integration', () => {
  let agent: MockAgent;
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
    createTimelineTools(registry);

    agent = new MockAgent({
      name: 'test-agent',
      description: 'Test agent for integration tests',
      tools: registry.toAgentTools(),
      maxIterations: 5,
    });
  });

  describe('Simple Message Processing', () => {
    it('processes a simple message without tool calls', async () => {
      agent.setMockResponse({
        content: 'Hello! How can I help you with your video editing?',
        toolCalls: [],
      });

      const result = await agent.run('Hello');

      expect(result.message.content).toBe('Hello! How can I help you with your video editing?');
      expect(result.toolCalls).toHaveLength(0);
    });

    it('maintains conversation history', async () => {
      agent.setMockResponse({
        content: 'Response 1',
        toolCalls: [],
      });
      await agent.run('Message 1');

      agent.setMockResponse({
        content: 'Response 2',
        toolCalls: [],
      });
      await agent.run('Message 2');

      expect(agent.conversationHistory).toHaveLength(4);
      expect(agent.conversationHistory[0].content).toBe('Message 1');
      expect(agent.conversationHistory[1].content).toBe('Response 1');
      expect(agent.conversationHistory[2].content).toBe('Message 2');
      expect(agent.conversationHistory[3].content).toBe('Response 2');
    });
  });

  describe('Tool Execution', () => {
    it('executes a single tool call', async () => {
      // First response with tool call
      agent.setMockResponses([
        {
          content: 'I will split the clip for you.',
          toolCalls: [
            { name: 'split_clip', arguments: { clipId: 'clip_001', position: 5.0 } },
          ],
        },
        {
          content: 'Done! I have split the clip at 5 seconds.',
          toolCalls: [],
        },
      ]);

      const result = await agent.run('Split the clip at 5 seconds');

      expect(result.message.content).toBe('Done! I have split the clip at 5 seconds.');
    });

    it('executes multiple tool calls in sequence', async () => {
      agent.setMockResponses([
        {
          content: 'I will split and then delete the second part.',
          toolCalls: [
            { name: 'split_clip', arguments: { clipId: 'clip_001', position: 5.0 } },
          ],
        },
        {
          content: 'Now deleting the second part.',
          toolCalls: [
            { name: 'delete_clip', arguments: { clipId: 'clip_new_2' } },
          ],
        },
        {
          content: 'Done! I have split the clip and deleted the second part.',
          toolCalls: [],
        },
      ]);

      await agent.run('Split the clip at 5 seconds and delete the second part');

      expect(agent.executedToolCalls).toHaveLength(2);
      expect(agent.executedToolCalls[0].name).toBe('split_clip');
      expect(agent.executedToolCalls[1].name).toBe('delete_clip');
    });

    it('handles tool execution errors gracefully', async () => {
      // Register a failing tool
      registry.unregister('split_clip');
      registry.register({
        name: 'split_clip',
        description: 'Split a clip',
        category: 'timeline',
        parameters: { type: 'object', properties: {} },
        handler: vi.fn().mockResolvedValue({
          success: false,
          error: 'Clip not found',
        }),
      });

      agent = new MockAgent({
        name: 'test-agent',
        description: 'Test agent',
        tools: registry.toAgentTools(),
      });

      agent.setMockResponses([
        {
          content: 'I will try to split the clip.',
          toolCalls: [
            { name: 'split_clip', arguments: { clipId: 'nonexistent' } },
          ],
        },
        {
          content: 'I encountered an error: the clip was not found.',
          toolCalls: [],
        },
      ]);

      const result = await agent.run('Split the clip');

      expect(result.message.content).toContain('error');
    });
  });

  describe('Context Handling', () => {
    it('receives context in processing', async () => {
      const context: AgentContext = {
        projectId: 'proj_001',
        sequenceId: 'seq_001',
        selectedClipIds: ['clip_001'],
        playheadPosition: 10.5,
        timelineDuration: 120,
      };

      agent.setMockResponse({
        content: 'I see you have clip_001 selected.',
        toolCalls: [],
      });

      await agent.runWithContext('What clips are selected?', context);

      expect(agent.lastReceivedContext).toEqual(context);
    });

    it('uses context in tool execution', async () => {
      const context: AgentContext = {
        selectedClipIds: ['clip_001'],
        playheadPosition: 5.0,
      };

      agent.setMockResponses([
        {
          content: 'Splitting at playhead position.',
          toolCalls: [
            { name: 'split_clip', arguments: { clipId: 'clip_001', position: 5.0 } },
          ],
        },
        {
          content: 'Done!',
          toolCalls: [],
        },
      ]);

      await agent.runWithContext('Split the selected clip at playhead', context);

      const splitCall = agent.executedToolCalls.find((c) => c.name === 'split_clip');
      expect(splitCall?.arguments.position).toBe(5.0);
    });
  });

  describe('Event Emission', () => {
    it('emits message events', async () => {
      const messageHandler = vi.fn();
      agent.on('message', messageHandler);

      agent.setMockResponse({
        content: 'Test response',
        toolCalls: [],
      });

      await agent.run('Test');

      expect(messageHandler).toHaveBeenCalledWith(
        expect.objectContaining({ content: 'Test response' })
      );
    });

    it('emits toolCall events', async () => {
      const toolCallHandler = vi.fn();
      agent.on('toolCall', toolCallHandler);

      agent.setMockResponses([
        {
          content: 'Executing tool',
          toolCalls: [{ name: 'split_clip', arguments: { clipId: 'c1', position: 5 } }],
        },
        { content: 'Done', toolCalls: [] },
      ]);

      await agent.run('Split');

      expect(toolCallHandler).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'split_clip' })
      );
    });

    it('emits statusChange events', async () => {
      const statusHandler = vi.fn();
      agent.on('statusChange', statusHandler);

      agent.setMockResponse({ content: 'OK', toolCalls: [] });
      await agent.run('Test');

      expect(statusHandler).toHaveBeenCalledWith('processing');
      expect(statusHandler).toHaveBeenCalledWith('idle');
    });
  });

  describe('Iteration Limiting', () => {
    it('respects maxIterations for tool loops', async () => {
      // Create an agent that always wants to call more tools
      agent = new MockAgent({
        name: 'looping-agent',
        description: 'An agent that loops',
        tools: registry.toAgentTools(),
        maxIterations: 3,
      });

      // All responses request continuation
      agent.setMockResponses([
        { content: 'Step 1', toolCalls: [{ name: 'split_clip', arguments: { clipId: 'c1', position: 1 } }] },
        { content: 'Step 2', toolCalls: [{ name: 'split_clip', arguments: { clipId: 'c2', position: 2 } }] },
        { content: 'Step 3', toolCalls: [{ name: 'split_clip', arguments: { clipId: 'c3', position: 3 } }] },
        { content: 'Step 4', toolCalls: [{ name: 'split_clip', arguments: { clipId: 'c4', position: 4 } }] },
        { content: 'Step 5', toolCalls: [] },
      ]);

      await agent.run('Do many things');

      // Should stop at maxIterations (3)
      expect(agent.executedToolCalls.length).toBeLessThanOrEqual(3);
    });
  });

  describe('Reset Behavior', () => {
    it('clears state on reset', async () => {
      agent.setMockResponse({ content: 'Response', toolCalls: [] });
      await agent.run('Message');

      expect(agent.conversationHistory.length).toBeGreaterThan(0);

      agent.reset();

      expect(agent.conversationHistory).toHaveLength(0);
      expect(agent.status).toBe('idle');
    });
  });

  describe('Full Workflow Integration', () => {
    it('completes a full edit workflow', async () => {
      const context = new ContextBuilder()
        .withProjectId('proj_001')
        .withSequenceId('seq_001')
        .withPlayheadPosition(10)
        .withSelectedClips(['clip_001'])
        .withTimelineDuration(60)
        .build();

      agent.setMockResponses([
        {
          content: 'I will split the selected clip at the playhead position and trim the second part.',
          toolCalls: [
            { name: 'split_clip', arguments: { clipId: 'clip_001', position: 10 } },
          ],
        },
        {
          content: 'Now trimming the second clip.',
          toolCalls: [
            { name: 'trim_clip', arguments: { clipId: 'clip_new_2', startTime: 10, endTime: 15 } },
          ],
        },
        {
          content: 'All done! I have split the clip at 10 seconds and trimmed the second part to 5 seconds.',
          toolCalls: [],
        },
      ]);

      const result = await agent.runWithContext(
        'Split the clip at the playhead and trim the second part to 5 seconds',
        context
      );

      expect(result.message.content).toContain('done');
      expect(agent.executedToolCalls).toHaveLength(2);
      expect(agent.executedToolCalls[0].name).toBe('split_clip');
      expect(agent.executedToolCalls[1].name).toBe('trim_clip');
    });
  });
});
