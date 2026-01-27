/**
 * VideoEditingAgent Tests
 *
 * Tests for the AI-powered video editing agent.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { VideoEditingAgent } from './VideoEditingAgent';
import { globalToolRegistry } from './ToolRegistry';
import type { AgentContext } from './Agent';

// Mock Tauri API
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

import { invoke } from '@tauri-apps/api/core';

const mockInvoke = vi.mocked(invoke);

describe('VideoEditingAgent', () => {
  let agent: VideoEditingAgent;

  beforeEach(() => {
    vi.clearAllMocks();
    globalToolRegistry.clear();

    agent = new VideoEditingAgent({
      name: 'test-agent',
      description: 'Test video editing agent',
    });
  });

  afterEach(() => {
    agent.reset();
  });

  describe('constructor', () => {
    it('should create agent with default configuration', () => {
      expect(agent.name).toBe('test-agent');
      expect(agent.description).toBe('Test video editing agent');
      expect(agent.status).toBe('idle');
    });

    it('should have system prompt for video editing', () => {
      const agentWithPrompt = new VideoEditingAgent({
        name: 'test',
        description: 'test',
        systemPrompt: 'Custom system prompt',
      });
      expect(agentWithPrompt).toBeDefined();
    });
  });

  describe('processMessage', () => {
    it('should call backend to generate edit script', async () => {
      const mockEditScript = {
        intent: 'Split clip at playhead',
        commands: [
          {
            commandType: 'SplitClip',
            params: { clipId: 'clip1', time: 5.0 },
            description: 'Split clip at 5 seconds',
          },
        ],
        requires: [],
        qcRules: [],
        risk: { copyright: 'none', nsfw: 'none' },
        explanation: 'I will split the selected clip at the current playhead position.',
      };

      mockInvoke.mockResolvedValueOnce(mockEditScript);

      const response = await agent.run('Split the clip at the playhead');

      expect(mockInvoke).toHaveBeenCalledWith(
        'generate_edit_script_with_ai',
        expect.objectContaining({
          intent: 'Split the clip at the playhead',
        })
      );
      expect(response.message.content).toContain('split');
    });

    it('should fall back to local intent analysis on AI failure', async () => {
      const mockLocalScript = {
        intent: 'Split clip',
        commands: [{ commandType: 'SplitClip', params: {} }],
        requires: [],
        qcRules: [],
        risk: { copyright: 'none', nsfw: 'none' },
        explanation: 'Split command generated locally.',
      };

      // First call fails (AI), second succeeds (local)
      mockInvoke
        .mockRejectedValueOnce(new Error('AI service unavailable'))
        .mockResolvedValueOnce(mockLocalScript);

      const response = await agent.run('Split the clip');

      expect(mockInvoke).toHaveBeenCalledTimes(2);
      expect(response.message.content).toBeDefined();
    });

    it('should pass context to backend', async () => {
      const mockEditScript = {
        intent: 'Move clip',
        commands: [],
        requires: [],
        qcRules: [],
        risk: { copyright: 'none', nsfw: 'none' },
        explanation: 'Moving clip.',
      };

      mockInvoke.mockResolvedValueOnce(mockEditScript);

      const context: AgentContext = {
        projectId: 'proj_001',
        sequenceId: 'seq_001',
        selectedClipIds: ['clip_001'],
        playheadPosition: 10.5,
      };

      await agent.runWithContext('Move the selected clip', context);

      expect(mockInvoke).toHaveBeenCalledWith(
        'generate_edit_script_with_ai',
        expect.objectContaining({
          context: expect.objectContaining({
            selectedClips: ['clip_001'],
            playheadPosition: 10.5,
          }),
        })
      );
    });
  });

  describe('executeToolCall', () => {
    beforeEach(() => {
      // Register a test tool
      globalToolRegistry.register({
        name: 'move_clip',
        description: 'Move a clip to a new position',
        category: 'clip',
        parameters: {
          type: 'object',
          properties: {
            clipId: { type: 'string', description: 'The clip ID' },
            newPosition: { type: 'number', description: 'New position in seconds' },
          },
          required: ['clipId', 'newPosition'],
        },
        handler: async (args) => {
          // Simulate IPC call
          await invoke('execute_command', {
            command: {
              type: 'MoveClip',
              payload: args,
            },
          });
          return { success: true, result: { moved: true } };
        },
      });

      // Reload tools from registry
      agent = new VideoEditingAgent({
        name: 'test-agent',
        description: 'Test',
        tools: globalToolRegistry.toAgentTools(),
      });
    });

    it('should execute tool calls through registry', async () => {
      mockInvoke.mockResolvedValue({ success: true });

      const result = await globalToolRegistry.execute('move_clip', {
        clipId: 'clip_001',
        newPosition: 15.0,
      });

      expect(result.success).toBe(true);
      expect(mockInvoke).toHaveBeenCalledWith('execute_command', {
        command: {
          type: 'MoveClip',
          payload: { clipId: 'clip_001', newPosition: 15.0 },
        },
      });
    });

    it('should return error for missing required parameters', async () => {
      const result = await globalToolRegistry.execute('move_clip', {
        clipId: 'clip_001',
        // missing newPosition
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Missing required parameter');
    });

    it('should return error for unknown tool', async () => {
      const result = await globalToolRegistry.execute('unknown_tool', {});

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });
  });

  describe('event handling', () => {
    it('should emit message events', async () => {
      const mockEditScript = {
        intent: 'Test',
        commands: [],
        requires: [],
        qcRules: [],
        risk: { copyright: 'none', nsfw: 'none' },
        explanation: 'Test response',
      };

      mockInvoke.mockResolvedValueOnce(mockEditScript);

      const messages: string[] = [];
      agent.on('message', (msg: { content: string }) => {
        messages.push(msg.content);
      });

      await agent.run('Test message');

      expect(messages.length).toBeGreaterThan(0);
    });

    it('should emit statusChange events', async () => {
      const mockEditScript = {
        intent: 'Test',
        commands: [],
        requires: [],
        qcRules: [],
        risk: { copyright: 'none', nsfw: 'none' },
        explanation: 'Test',
      };

      mockInvoke.mockResolvedValueOnce(mockEditScript);

      const statuses: string[] = [];
      agent.on('statusChange', (status: string) => {
        statuses.push(status);
      });

      await agent.run('Test');

      expect(statuses).toContain('processing');
      expect(statuses).toContain('idle');
    });

    it('should emit error events on failure', async () => {
      mockInvoke
        .mockRejectedValueOnce(new Error('AI failed'))
        .mockRejectedValueOnce(new Error('Fallback failed'));

      const errors: Error[] = [];
      agent.on('error', (err: Error) => {
        errors.push(err);
      });

      await expect(agent.run('Test')).rejects.toThrow();
      expect(errors.length).toBe(1);
    });
  });

  describe('conversation history', () => {
    it('should maintain conversation history', async () => {
      const mockEditScript = {
        intent: 'Test',
        commands: [],
        requires: [],
        qcRules: [],
        risk: { copyright: 'none', nsfw: 'none' },
        explanation: 'Response 1',
      };

      mockInvoke.mockResolvedValue(mockEditScript);

      await agent.run('First message');
      await agent.run('Second message');

      const history = agent.conversationHistory;
      expect(history.length).toBe(4); // 2 user + 2 assistant messages
      expect(history[0].role).toBe('user');
      expect(history[1].role).toBe('assistant');
    });

    it('should clear history on reset', async () => {
      const mockEditScript = {
        intent: 'Test',
        commands: [],
        requires: [],
        qcRules: [],
        risk: { copyright: 'none', nsfw: 'none' },
        explanation: 'Test',
      };

      mockInvoke.mockResolvedValue(mockEditScript);

      await agent.run('Test message');
      expect(agent.conversationHistory.length).toBeGreaterThan(0);

      agent.reset();
      expect(agent.conversationHistory.length).toBe(0);
    });
  });

  describe('tool calls in response', () => {
    it('should handle tool calls from AI response', async () => {
      // Register tool
      globalToolRegistry.register({
        name: 'split_clip',
        description: 'Split a clip at a time',
        category: 'clip',
        parameters: {
          type: 'object',
          properties: {
            clipId: { type: 'string' },
            time: { type: 'number' },
          },
          required: ['clipId', 'time'],
        },
        handler: async () => ({ success: true, result: { split: true } }),
      });

      agent = new VideoEditingAgent({
        name: 'test',
        description: 'test',
        tools: globalToolRegistry.toAgentTools(),
      });

      // First response with tool call, second response without
      const mockEditScriptWithTool = {
        intent: 'Split clip',
        commands: [
          {
            commandType: 'split_clip',
            params: { clipId: 'clip_001', time: 5.0 },
          },
        ],
        requires: [],
        qcRules: [],
        risk: { copyright: 'none', nsfw: 'none' },
        explanation: 'Splitting clip at 5 seconds.',
        toolCalls: [
          {
            name: 'split_clip',
            arguments: { clipId: 'clip_001', time: 5.0 },
          },
        ],
      };

      const mockFinalResponse = {
        intent: 'Done',
        commands: [],
        requires: [],
        qcRules: [],
        risk: { copyright: 'none', nsfw: 'none' },
        explanation: 'Clip has been split.',
      };

      mockInvoke
        .mockResolvedValueOnce(mockEditScriptWithTool)
        .mockResolvedValueOnce(mockFinalResponse);

      const response = await agent.run('Split the clip at 5 seconds');

      expect(response.message.content).toBeDefined();
    });
  });
});
