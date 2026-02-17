/**
 * Planner Phase Tests
 *
 * Tests for the Plan phase of the agentic loop.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Planner, createPlanner } from './Planner';
import { createMockLLMAdapter, type MockLLMAdapter } from '../adapters/llm/MockLLMAdapter';
import { createMockToolExecutor, type MockToolExecutor } from '../adapters/tools/MockToolExecutor';
import {
  createLanguagePolicy,
  createEmptyContext,
  type AgentContext,
  type Thought,
  type Plan,
} from '../core/types';
import { PlanningTimeoutError, PlanValidationError } from '../core/errors';

describe('Planner', () => {
  let planner: Planner;
  let mockLLM: MockLLMAdapter;
  let mockToolExecutor: MockToolExecutor;
  let context: AgentContext;

  const sampleThought: Thought = {
    understanding: 'User wants to split a clip at 5 seconds',
    requirements: ['Clip ID', 'Position'],
    uncertainties: [],
    approach: 'Use split_clip tool at position 5',
    needsMoreInfo: false,
  };

  beforeEach(() => {
    mockLLM = createMockLLMAdapter();
    mockToolExecutor = createMockToolExecutor();
    planner = createPlanner(mockLLM, mockToolExecutor);
    context = createEmptyContext('project-1');

    // Register some tools for testing
    mockToolExecutor.registerTool({
      info: {
        name: 'split_clip',
        description: 'Split a clip at a position',
        category: 'editing',
        riskLevel: 'low',
        supportsUndo: true,
        parallelizable: false,
      },
      parameters: {
        type: 'object',
        properties: {
          clipId: { type: 'string' },
          position: { type: 'number' },
        },
      },
      required: ['clipId', 'position'],
    });

    mockToolExecutor.registerTool({
      info: {
        name: 'move_clip',
        description: 'Move a clip',
        category: 'editing',
        riskLevel: 'low',
        supportsUndo: true,
        parallelizable: false,
      },
      parameters: {
        type: 'object',
        properties: {
          clipId: { type: 'string' },
          position: { type: 'number' },
        },
      },
      required: ['clipId', 'position'],
    });

    mockToolExecutor.registerTool({
      info: {
        name: 'get_timeline_info',
        description: 'Get timeline info',
        category: 'analysis',
        riskLevel: 'low',
        supportsUndo: false,
        parallelizable: true,
      },
      parameters: {
        type: 'object',
        properties: {
          sequenceId: { type: 'string' },
        },
      },
      required: ['sequenceId'],
    });
  });

  describe('plan', () => {
    it('should generate a plan from a thought', async () => {
      const mockPlan: Plan = {
        goal: 'Split the clip at 5 seconds',
        steps: [
          {
            id: 'step-1',
            tool: 'split_clip',
            args: { clipId: 'clip-1', position: 5 },
            description: 'Split clip-1 at position 5',
            riskLevel: 'low',
            estimatedDuration: 100,
          },
        ],
        estimatedTotalDuration: 100,
        requiresApproval: false,
        rollbackStrategy: 'Use undo to reverse split',
      };

      mockLLM.setStructuredResponse({ structured: mockPlan });

      const result = await planner.plan(sampleThought, context);

      expect(result.goal).toBe('Split the clip at 5 seconds');
      expect(result.steps).toHaveLength(1);
      expect(result.steps[0].tool).toBe('split_clip');
    });

    it('should generate multi-step plan for complex tasks', async () => {
      const complexThought: Thought = {
        understanding: 'Cut first 5 seconds and move to end',
        requirements: ['Timeline info', 'Split capability', 'Move capability'],
        uncertainties: [],
        approach: 'Split at 5s, then move the portion to end',
        needsMoreInfo: false,
      };

      const mockPlan: Plan = {
        goal: 'Cut first 5 seconds and move to end',
        steps: [
          {
            id: 'step-1',
            tool: 'get_timeline_info',
            args: { sequenceId: 'seq-1' },
            description: 'Get timeline information',
            riskLevel: 'low',
            estimatedDuration: 50,
          },
          {
            id: 'step-2',
            tool: 'split_clip',
            args: { clipId: 'clip-1', position: 5 },
            description: 'Split clip at 5 seconds',
            riskLevel: 'low',
            estimatedDuration: 100,
            dependsOn: ['step-1'],
          },
          {
            id: 'step-3',
            tool: 'move_clip',
            args: { clipId: 'clip-1-split', position: 120 },
            description: 'Move split portion to end',
            riskLevel: 'low',
            estimatedDuration: 100,
            dependsOn: ['step-2'],
          },
        ],
        estimatedTotalDuration: 250,
        requiresApproval: false,
        rollbackStrategy: 'Undo all operations in reverse order',
      };

      mockLLM.setStructuredResponse({ structured: mockPlan });

      const result = await planner.plan(complexThought, context);

      expect(result.steps).toHaveLength(3);
      expect(result.steps[1].dependsOn).toContain('step-1');
      expect(result.steps[2].dependsOn).toContain('step-2');
    });

    it('should flag plan requiring approval for high risk tools', async () => {
      mockToolExecutor.registerTool({
        info: {
          name: 'delete_all_clips',
          description: 'Delete all clips',
          category: 'editing',
          riskLevel: 'critical',
          supportsUndo: true,
          parallelizable: false,
        },
        parameters: {},
      });

      const deleteThought: Thought = {
        understanding: 'Delete all clips from timeline',
        requirements: ['Confirmation'],
        uncertainties: [],
        approach: 'Use delete_all_clips',
        needsMoreInfo: false,
      };

      const mockPlan: Plan = {
        goal: 'Delete all clips',
        steps: [
          {
            id: 'step-1',
            tool: 'delete_all_clips',
            args: { confirm: true },
            description: 'Delete all clips from timeline',
            riskLevel: 'critical',
            estimatedDuration: 200,
          },
        ],
        estimatedTotalDuration: 200,
        requiresApproval: true,
        rollbackStrategy: 'Undo to restore clips',
      };

      mockLLM.setStructuredResponse({ structured: mockPlan });

      const result = await planner.plan(deleteThought, context);

      expect(result.requiresApproval).toBe(true);
    });

    it('should validate that all tools exist', async () => {
      const mockPlan: Plan = {
        goal: 'Invalid plan',
        steps: [
          {
            id: 'step-1',
            tool: 'nonexistent_tool',
            args: {},
            description: 'Use nonexistent tool',
            riskLevel: 'low',
            estimatedDuration: 100,
          },
        ],
        estimatedTotalDuration: 100,
        requiresApproval: false,
        rollbackStrategy: 'N/A',
      };

      mockLLM.setStructuredResponse({ structured: mockPlan });

      await expect(planner.plan(sampleThought, context)).rejects.toThrow(PlanValidationError);
    });

    it('should validate step dependencies are valid', async () => {
      const mockPlan: Plan = {
        goal: 'Invalid dependencies',
        steps: [
          {
            id: 'step-1',
            tool: 'split_clip',
            args: { clipId: 'clip-1', position: 5 },
            description: 'Split clip',
            riskLevel: 'low',
            estimatedDuration: 100,
            dependsOn: ['nonexistent-step'],
          },
        ],
        estimatedTotalDuration: 100,
        requiresApproval: false,
        rollbackStrategy: 'Undo',
      };

      mockLLM.setStructuredResponse({ structured: mockPlan });

      await expect(planner.plan(sampleThought, context)).rejects.toThrow(PlanValidationError);
    });

    it('should detect circular dependencies', async () => {
      const mockPlan: Plan = {
        goal: 'Circular dependencies',
        steps: [
          {
            id: 'step-1',
            tool: 'split_clip',
            args: { clipId: 'clip-1', position: 5 },
            description: 'Step 1',
            riskLevel: 'low',
            estimatedDuration: 100,
            dependsOn: ['step-2'],
          },
          {
            id: 'step-2',
            tool: 'move_clip',
            args: { clipId: 'clip-1', position: 10 },
            description: 'Step 2',
            riskLevel: 'low',
            estimatedDuration: 100,
            dependsOn: ['step-1'],
          },
        ],
        estimatedTotalDuration: 200,
        requiresApproval: false,
        rollbackStrategy: 'Undo',
      };

      mockLLM.setStructuredResponse({ structured: mockPlan });

      await expect(planner.plan(sampleThought, context)).rejects.toThrow(PlanValidationError);
    });

    it('should include thought context in LLM request', async () => {
      const mockPlan: Plan = {
        goal: 'Test plan',
        steps: [],
        estimatedTotalDuration: 0,
        requiresApproval: false,
        rollbackStrategy: 'N/A',
      };

      mockLLM.setStructuredResponse({ structured: mockPlan });

      await planner.plan(sampleThought, context);

      const request = mockLLM.getLastRequest();
      expect(request).toBeDefined();

      const messages = request?.messages ?? [];
      const hasThoughtContent = messages.some(
        (m) =>
          m.content.includes(sampleThought.understanding) ||
          m.content.includes(sampleThought.approach),
      );
      expect(hasThoughtContent).toBe(true);
    });

    it('should include available tools in context', async () => {
      const mockPlan: Plan = {
        goal: 'Test plan',
        steps: [],
        estimatedTotalDuration: 0,
        requiresApproval: false,
        rollbackStrategy: 'N/A',
      };

      mockLLM.setStructuredResponse({ structured: mockPlan });

      await planner.plan(sampleThought, context);

      const request = mockLLM.getLastRequest();
      const systemMessage = request?.messages.find((m) => m.role === 'system');

      expect(systemMessage?.content).toContain('split_clip');
      expect(systemMessage?.content).toContain('move_clip');
      expect(systemMessage?.content).toContain('source-aware analysis steps');
    });

    it('should include language policy instructions in planning prompt', async () => {
      const mockPlan: Plan = {
        goal: 'Plan with language policy',
        steps: [],
        estimatedTotalDuration: 0,
        requiresApproval: false,
        rollbackStrategy: 'N/A',
      };

      context.languagePolicy = createLanguagePolicy('en', {
        outputLanguage: 'ko',
        detectInputLanguage: true,
      });

      mockLLM.setStructuredResponse({ structured: mockPlan });

      await planner.plan(sampleThought, context);

      const request = mockLLM.getLastRequest();
      const systemMessage = request?.messages.find((m) => m.role === 'system');

      expect(systemMessage?.content).toContain('Language Policy:');
      expect(systemMessage?.content).toContain('Default output language: ko');
      expect(systemMessage?.content).toContain('Never translate tool names, IDs, argument keys');
    });
  });

  describe('planWithStreaming', () => {
    it('should emit progress events', async () => {
      mockLLM.setStreamResponse({
        content: 'Planning step by step...',
        chunkSize: 10,
      });

      const mockPlan: Plan = {
        goal: 'Test plan',
        steps: [
          {
            id: 'step-1',
            tool: 'split_clip',
            args: { clipId: 'clip-1', position: 5 },
            description: 'Split clip',
            riskLevel: 'low',
            estimatedDuration: 100,
          },
        ],
        estimatedTotalDuration: 100,
        requiresApproval: false,
        rollbackStrategy: 'Undo',
      };

      mockLLM.setStructuredResponse({ structured: mockPlan });

      const progressChunks: string[] = [];

      const result = await planner.planWithStreaming(sampleThought, context, (chunk) =>
        progressChunks.push(chunk),
      );

      expect(progressChunks.length).toBeGreaterThan(0);
      expect(result).toBeDefined();
    });
  });

  describe('conversation history', () => {
    it('should include history messages between system prompt and user input', async () => {
      const mockPlan: Plan = {
        goal: 'Move second half to end',
        steps: [
          {
            id: 'step-1',
            tool: 'move_clip',
            args: { clipId: 'clip_002', position: 30 },
            description: 'Move clip to end',
            riskLevel: 'low',
            estimatedDuration: 1000,
          },
        ],
        estimatedTotalDuration: 1000,
        requiresApproval: false,
        rollbackStrategy: 'Undo move',
      };

      mockLLM.setStructuredResponse({ structured: mockPlan });

      const history = [
        { role: 'user' as const, content: 'Split the clip at 5 seconds' },
        { role: 'assistant' as const, content: 'Done! Split clip_001 at 5s.' },
      ];

      await planner.plan(sampleThought, context, history);

      const request = mockLLM.getLastRequest();
      expect(request).toBeDefined();
      const messages = request!.messages;

      // System prompt first
      expect(messages[0].role).toBe('system');
      // Then history
      expect(messages[1].role).toBe('user');
      expect(messages[1].content).toBe('Split the clip at 5 seconds');
      expect(messages[2].role).toBe('assistant');
      expect(messages[2].content).toBe('Done! Split clip_001 at 5s.');
      // Then current planning input (the thought prompt)
      expect(messages[3].role).toBe('user');
    });

    it('should work without history (backward compatible)', async () => {
      const mockPlan: Plan = {
        goal: 'Test',
        steps: [],
        estimatedTotalDuration: 0,
        requiresApproval: false,
        rollbackStrategy: 'None',
      };
      mockLLM.setStructuredResponse({ structured: mockPlan });

      await planner.plan(sampleThought, context);

      const request = mockLLM.getLastRequest();
      expect(request!.messages).toHaveLength(2); // system + user
    });
  });

  describe('error handling', () => {
    it('should throw PlanningTimeoutError on timeout', async () => {
      const shortTimeoutPlanner = createPlanner(mockLLM, mockToolExecutor, {
        timeout: 10,
      });

      mockLLM.setStructuredResponse({
        structured: {
          goal: 'Test',
          steps: [],
          estimatedTotalDuration: 0,
          requiresApproval: false,
          rollbackStrategy: 'N/A',
        },
        delay: 100,
      });

      await expect(shortTimeoutPlanner.plan(sampleThought, context)).rejects.toThrow(
        PlanningTimeoutError,
      );
    });

    it('should throw PlanValidationError on malformed response', async () => {
      mockLLM.setStructuredResponse({
        structured: { invalid: 'response' },
      });

      await expect(planner.plan(sampleThought, context)).rejects.toThrow(PlanValidationError);
    });

    it('should throw on LLM error', async () => {
      mockLLM.setStructuredResponse({
        error: new Error('LLM API error'),
      });

      await expect(planner.plan(sampleThought, context)).rejects.toThrow();
    });
  });

  describe('abort', () => {
    it('should abort ongoing planning', async () => {
      mockLLM.setStructuredResponse({
        structured: {
          goal: 'Test',
          steps: [],
          estimatedTotalDuration: 0,
          requiresApproval: false,
          rollbackStrategy: 'N/A',
        },
        delay: 1000,
      });

      const promise = planner.plan(sampleThought, context);

      setTimeout(() => planner.abort(), 10);

      await expect(promise).rejects.toThrow();
    });
  });

  describe('configuration', () => {
    it('should use custom timeout', async () => {
      const customPlanner = createPlanner(mockLLM, mockToolExecutor, {
        timeout: 5000,
      });

      const mockPlan: Plan = {
        goal: 'Test plan',
        steps: [],
        estimatedTotalDuration: 0,
        requiresApproval: false,
        rollbackStrategy: 'N/A',
      };

      mockLLM.setStructuredResponse({ structured: mockPlan });

      const result = await customPlanner.plan(sampleThought, context);
      expect(result).toBeDefined();
    });

    it('should use custom max steps limit', async () => {
      const customPlanner = createPlanner(mockLLM, mockToolExecutor, {
        maxSteps: 2,
      });

      const mockPlan: Plan = {
        goal: 'Too many steps',
        steps: [
          {
            id: 'step-1',
            tool: 'split_clip',
            args: { clipId: 'c1', position: 1 },
            description: 'Step 1',
            riskLevel: 'low',
            estimatedDuration: 100,
          },
          {
            id: 'step-2',
            tool: 'split_clip',
            args: { clipId: 'c2', position: 2 },
            description: 'Step 2',
            riskLevel: 'low',
            estimatedDuration: 100,
          },
          {
            id: 'step-3',
            tool: 'split_clip',
            args: { clipId: 'c3', position: 3 },
            description: 'Step 3',
            riskLevel: 'low',
            estimatedDuration: 100,
          },
        ],
        estimatedTotalDuration: 300,
        requiresApproval: false,
        rollbackStrategy: 'Undo',
      };

      mockLLM.setStructuredResponse({ structured: mockPlan });

      await expect(customPlanner.plan(sampleThought, context)).rejects.toThrow(PlanValidationError);
    });
  });

  describe('plan optimization', () => {
    it('should identify parallelizable steps', async () => {
      mockToolExecutor.registerTool({
        info: {
          name: 'analyze_audio',
          description: 'Analyze audio',
          category: 'analysis',
          riskLevel: 'low',
          supportsUndo: false,
          parallelizable: true,
        },
        parameters: {},
      });

      const mockPlan: Plan = {
        goal: 'Analyze timeline',
        steps: [
          {
            id: 'step-1',
            tool: 'get_timeline_info',
            args: { sequenceId: 'seq-1' },
            description: 'Get timeline',
            riskLevel: 'low',
            estimatedDuration: 50,
          },
          {
            id: 'step-2',
            tool: 'analyze_audio',
            args: {},
            description: 'Analyze audio',
            riskLevel: 'low',
            estimatedDuration: 50,
          },
        ],
        estimatedTotalDuration: 50, // Parallel, so not 100
        requiresApproval: false,
        rollbackStrategy: 'N/A',
      };

      mockLLM.setStructuredResponse({ structured: mockPlan });

      const result = await planner.plan(sampleThought, context);

      // Both steps are parallelizable and have no dependencies
      const step1 = result.steps.find((s) => s.id === 'step-1');
      const step2 = result.steps.find((s) => s.id === 'step-2');

      expect(step1?.dependsOn).toBeUndefined();
      expect(step2?.dependsOn).toBeUndefined();
    });
  });

  describe('plan validation', () => {
    it('should validate plan has required fields', async () => {
      const mockPlan: Plan = {
        goal: 'Valid plan',
        steps: [
          {
            id: 'step-1',
            tool: 'split_clip',
            args: { clipId: 'clip-1', position: 5 },
            description: 'Split clip',
            riskLevel: 'low',
            estimatedDuration: 100,
          },
        ],
        estimatedTotalDuration: 100,
        requiresApproval: false,
        rollbackStrategy: 'Undo',
      };

      mockLLM.setStructuredResponse({ structured: mockPlan });

      const result = await planner.plan(sampleThought, context);

      expect(result.goal).toBeDefined();
      expect(result.steps).toBeInstanceOf(Array);
      expect(typeof result.requiresApproval).toBe('boolean');
      expect(result.rollbackStrategy).toBeDefined();
    });

    it('should validate each step has required fields', async () => {
      const mockPlan = {
        goal: 'Invalid step',
        steps: [
          {
            id: 'step-1',
            // missing tool
            args: {},
            description: 'Invalid',
            riskLevel: 'low',
            estimatedDuration: 100,
          },
        ],
        estimatedTotalDuration: 100,
        requiresApproval: false,
        rollbackStrategy: 'N/A',
      };

      mockLLM.setStructuredResponse({ structured: mockPlan });

      await expect(planner.plan(sampleThought, context)).rejects.toThrow(PlanValidationError);
    });

    it('should validate tool arguments against schema', async () => {
      const mockPlan: Plan = {
        goal: 'Invalid args',
        steps: [
          {
            id: 'step-1',
            tool: 'split_clip',
            args: { clipId: 'clip-1' }, // missing required 'position'
            description: 'Split without position',
            riskLevel: 'low',
            estimatedDuration: 100,
          },
        ],
        estimatedTotalDuration: 100,
        requiresApproval: false,
        rollbackStrategy: 'N/A',
      };

      mockLLM.setStructuredResponse({ structured: mockPlan });

      await expect(planner.plan(sampleThought, context)).rejects.toThrow(PlanValidationError);
    });
  });
});
