/**
 * AgenticEngine Tests
 *
 * Tests for the main Agentic Engine orchestrator.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AgenticEngine, createAgenticEngine } from './AgenticEngine';
import type { AgentEvent } from './core/types';
import { createMockLLMAdapter, type MockLLMAdapter } from './adapters/llm/MockLLMAdapter';
import {
  createMockToolExecutorWithVideoTools,
  type MockToolExecutor,
} from './adapters/tools/MockToolExecutor';
import {
  createEmptyContext,
  type AgentContext,
  type Thought,
  type Plan,
  type Observation,
} from './core/types';
import type { ExecutionContext } from './ports/IToolExecutor';
import type { IMemoryStore } from './ports/IMemoryStore';
import { StepBudgetExceededError, ToolBudgetExceededError } from './core/errors';

function createMockMemoryStore(
  overrides: Partial<IMemoryStore> = {},
): IMemoryStore & { recordOperation: ReturnType<typeof vi.fn> } {
  const defaults: IMemoryStore = {
    storeConversation: async () => {},
    getConversation: async () => null,
    getRecentConversations: async () => [],
    deleteConversation: async () => {},
    recordOperation: async () => {},
    getFrequentOperations: async () => [],
    getRecentOperations: async () => [],
    recordCorrection: async () => {},
    getCorrections: async () => [],
    searchCorrections: async () => [],
    setPreferences: async () => {},
    getPreferences: async () => ({ custom: {} }),
    setPreference: async () => {},
    getPreference: async () => undefined,
    getProjectMemory: async () => null,
    updateProjectMemory: async () => {},
    clearAll: async () => {},
    clearProject: async () => {},
    pruneOld: async () => {},
    export: async () => ({}),
    import: async () => {},
  };

  return {
    ...defaults,
    ...overrides,
    recordOperation: vi.fn(overrides.recordOperation ?? defaults.recordOperation),
  };
}

describe('AgenticEngine', () => {
  let engine: AgenticEngine;
  let mockLLM: MockLLMAdapter;
  let mockToolExecutor: MockToolExecutor;
  let agentContext: AgentContext;
  let executionContext: ExecutionContext;

  // Default mock responses for a successful flow
  const mockThought: Thought = {
    understanding: 'User wants to split a clip at 5 seconds',
    requirements: ['Clip ID', 'Position'],
    uncertainties: [],
    approach: 'Use split_clip tool',
    needsMoreInfo: false,
  };

  const mockPlan: Plan = {
    goal: 'Split the clip at 5 seconds',
    steps: [
      {
        id: 'step-1',
        tool: 'split_clip',
        args: { clipId: 'clip-1', position: 5 },
        description: 'Split clip at position 5',
        riskLevel: 'low',
        estimatedDuration: 100,
      },
    ],
    estimatedTotalDuration: 100,
    requiresApproval: false,
    rollbackStrategy: 'Undo split',
  };

  const mockObservation: Observation = {
    goalAchieved: true,
    stateChanges: [
      {
        type: 'clip_created',
        target: 'clip-2',
        details: { splitFrom: 'clip-1' },
      },
    ],
    summary: 'Successfully split clip-1 at 5 seconds',
    confidence: 0.95,
    needsIteration: false,
  };

  beforeEach(() => {
    mockLLM = createMockLLMAdapter();
    mockToolExecutor = createMockToolExecutorWithVideoTools();
    engine = createAgenticEngine(mockLLM, mockToolExecutor);
    agentContext = createEmptyContext('project-1');
    agentContext.availableTools = mockToolExecutor.getAvailableTools().map((t) => t.name);

    executionContext = {
      projectId: 'project-1',
      sequenceId: 'sequence-1',
      sessionId: 'session-1',
    };
  });

  describe('run', () => {
    it('should complete a simple request successfully', async () => {
      // Setup mock responses for each phase
      mockLLM.setStructuredResponse({ structured: mockThought });

      // After think, set plan response
      let callCount = 0;
      vi.spyOn(mockLLM, 'generateStructured').mockImplementation(async () => {
        callCount++;
        if (callCount === 1) return mockThought;
        if (callCount === 2) return mockPlan;
        return mockObservation;
      });

      const result = await engine.run(
        'Split the clip at 5 seconds',
        agentContext,
        executionContext,
      );

      expect(result.success).toBe(true);
      expect(result.observation?.goalAchieved).toBe(true);
    });

    it('should use deterministic fast path for simple split command', async () => {
      agentContext.sequenceId = 'sequence-1';
      agentContext.selectedClips = ['clip-fast'];
      agentContext.selectedTracks = ['track-fast'];

      mockToolExecutor.registerTool({
        info: {
          name: 'split_clip',
          description: 'Split clip',
          category: 'editing',
          riskLevel: 'low',
          supportsUndo: true,
          parallelizable: false,
        },
        parameters: {
          type: 'object',
          properties: {
            sequenceId: { type: 'string' },
            trackId: { type: 'string' },
            clipId: { type: 'string' },
            splitTime: { type: 'number' },
          },
        },
        required: ['sequenceId', 'trackId', 'clipId', 'splitTime'],
        result: {
          success: true,
          data: { newClipId: 'clip-fast-2' },
          duration: 20,
        },
      });

      mockLLM.setStructuredResponse({ structured: mockObservation });

      const result = await engine.run('Split selected clip at 5s', agentContext, executionContext);

      expect(result.success).toBe(true);
      expect(
        mockToolExecutor.wasToolCalledWith('split_clip', {
          sequenceId: 'sequence-1',
          trackId: 'track-fast',
          clipId: 'clip-fast',
          splitTime: 5,
        }),
      ).toBe(true);

      const structuredRequests = mockLLM
        .getCapturedRequests()
        .filter((request) => request.type === 'structured');
      expect(structuredRequests).toHaveLength(1);
      expect(result.finalState.thought?.approach).toContain('fast path');
    });

    it('should resolve step-reference args for orchestration plans before downstream execution', async () => {
      mockToolExecutor.registerTool({
        info: {
          name: 'check_generation_status',
          description: 'Check generation status',
          category: 'analysis',
          riskLevel: 'low',
          supportsUndo: false,
          parallelizable: true,
        },
        parameters: {
          type: 'object',
          properties: {
            jobId: { type: 'string' },
          },
        },
        required: ['jobId'],
        result: {
          success: true,
          data: { assetId: 'asset-generated-42' },
          duration: 10,
        },
      });

      mockToolExecutor.registerTool({
        info: {
          name: 'insert_clip',
          description: 'Insert asset clip',
          category: 'editing',
          riskLevel: 'low',
          supportsUndo: true,
          parallelizable: false,
        },
        parameters: {
          type: 'object',
          properties: {
            sequenceId: { type: 'string' },
            trackId: { type: 'string' },
            assetId: { type: 'string' },
            timelineStart: { type: 'number' },
          },
        },
        required: ['sequenceId', 'trackId', 'assetId', 'timelineStart'],
        executor: async (args) => {
          if (typeof args.assetId !== 'string') {
            return { success: false, error: 'assetId must be string', duration: 10 };
          }

          return {
            success: true,
            data: { clipId: 'clip-generated', assetId: args.assetId },
            duration: 10,
          };
        },
      });

      const orchestrationThought: Thought = {
        understanding: 'Place generated video on timeline',
        requirements: ['Generated asset result', 'timeline insertion'],
        uncertainties: [],
        approach: 'Read generation output and insert the asset',
        needsMoreInfo: false,
      };

      const orchestrationPlan: Plan = {
        goal: 'Insert generated asset',
        steps: [
          {
            id: 'step-1',
            tool: 'check_generation_status',
            args: { jobId: 'job-42' },
            description: 'Load generation output',
            riskLevel: 'low',
            estimatedDuration: 50,
          },
          {
            id: 'step-2',
            tool: 'insert_clip',
            args: {
              sequenceId: 'sequence-1',
              trackId: 'track-1',
              assetId: { $fromStep: 'step-1', $path: 'data.assetId' },
              timelineStart: 0,
            },
            description: 'Insert generated asset',
            riskLevel: 'low',
            estimatedDuration: 100,
            dependsOn: ['step-1'],
          },
        ],
        estimatedTotalDuration: 150,
        requiresApproval: false,
        rollbackStrategy: 'Undo insert',
      };

      let callCount = 0;
      vi.spyOn(mockLLM, 'generateStructured').mockImplementation(async () => {
        callCount += 1;
        if (callCount === 1) return orchestrationThought;
        if (callCount === 2) return orchestrationPlan;
        return mockObservation;
      });

      const result = await engine.run(
        'Insert generated asset onto the timeline',
        agentContext,
        executionContext,
      );

      expect(result.success).toBe(true);
      expect(
        mockToolExecutor.wasToolCalledWith('insert_clip', {
          sequenceId: 'sequence-1',
          trackId: 'track-1',
          assetId: 'asset-generated-42',
          timelineStart: 0,
        }),
      ).toBe(true);
    });

    it('should emit events throughout the process', async () => {
      let callCount = 0;
      vi.spyOn(mockLLM, 'generateStructured').mockImplementation(async () => {
        callCount++;
        if (callCount === 1) return mockThought;
        if (callCount === 2) return mockPlan;
        return mockObservation;
      });

      const events: AgentEvent[] = [];

      await engine.run('Split the clip at 5 seconds', agentContext, executionContext, (event) =>
        events.push(event),
      );

      // Should have events for each phase
      expect(events.some((e) => e.type === 'session_start')).toBe(true);
      expect(events.some((e) => e.type === 'thinking_start')).toBe(true);
      expect(events.some((e) => e.type === 'thinking_complete')).toBe(true);
      expect(events.some((e) => e.type === 'planning_start')).toBe(true);
      expect(events.some((e) => e.type === 'planning_complete')).toBe(true);
      expect(events.some((e) => e.type === 'execution_start')).toBe(true);
      expect(events.some((e) => e.type === 'execution_complete')).toBe(true);
      expect(events.some((e) => e.type === 'observation_complete')).toBe(true);
      expect(events.some((e) => e.type === 'session_complete')).toBe(true);
    });

    it('should handle clarification needed', async () => {
      const clarificationThought: Thought = {
        understanding: 'User wants to do something with a clip',
        requirements: ['Specific action'],
        uncertainties: ['Which action?'],
        approach: 'Need clarification',
        needsMoreInfo: true,
        clarificationQuestion: 'What would you like to do with the clip?',
      };

      vi.spyOn(mockLLM, 'generateStructured').mockResolvedValue(clarificationThought);

      const events: AgentEvent[] = [];
      const result = await engine.run(
        'Do something with the clip',
        agentContext,
        executionContext,
        (event) => events.push(event),
      );

      expect(result.success).toBe(false);
      expect(result.needsClarification).toBe(true);
      expect(result.clarificationQuestion).toBeDefined();
      const clarificationEvent = events.find((e) => e.type === 'clarification_required');
      expect(clarificationEvent).toBeDefined();
      if (clarificationEvent?.type === 'clarification_required') {
        expect(clarificationEvent.question).toBe('What would you like to do with the clip?');
      }
    });

    it('should iterate when observation indicates need', async () => {
      const iteratingObservation: Observation = {
        goalAchieved: false,
        stateChanges: [],
        summary: 'Partial success, need to retry',
        confidence: 0.6,
        needsIteration: true,
        iterationReason: 'First attempt failed, retrying',
      };

      const finalObservation: Observation = {
        goalAchieved: true,
        stateChanges: [],
        summary: 'Success on retry',
        confidence: 0.9,
        needsIteration: false,
      };

      let callCount = 0;
      let observeCount = 0;
      vi.spyOn(mockLLM, 'generateStructured').mockImplementation(async () => {
        callCount += 1;
        const phaseIndex = callCount % 3;

        // 1: thinking, 2: planning, 0: observation
        if (phaseIndex === 1) return mockThought;
        if (phaseIndex === 2) return mockPlan;

        observeCount += 1;
        return observeCount === 1 ? iteratingObservation : finalObservation;
      });

      const events: AgentEvent[] = [];

      const result = await engine.run('Split the clip', agentContext, executionContext, (event) =>
        events.push(event),
      );

      expect(result.iterations).toBe(2);
      expect(events.some((e) => e.type === 'iteration_complete')).toBe(true);
    });

    it('should stop after max iterations', async () => {
      const alwaysIterateObservation: Observation = {
        goalAchieved: false,
        stateChanges: [],
        summary: 'Need to keep trying',
        confidence: 0.5,
        needsIteration: true,
        iterationReason: 'Not done yet',
      };

      vi.spyOn(mockLLM, 'generateStructured').mockImplementation(async () => {
        if (mockLLM.getRequestCount() % 3 === 1) return mockThought;
        if (mockLLM.getRequestCount() % 3 === 2) return mockPlan;
        return alwaysIterateObservation;
      });

      const maxIterEngine = createAgenticEngine(mockLLM, mockToolExecutor, {
        maxIterations: 2,
      });

      const result = await maxIterEngine.run('Split the clip', agentContext, executionContext);

      expect(result.success).toBe(false);
      expect(result.iterations).toBeLessThanOrEqual(2);
    });
  });

  describe('approval flow', () => {
    it('should request approval for high-risk operations', async () => {
      const highRiskPlan: Plan = {
        goal: 'Delete all clips',
        steps: [
          {
            id: 'step-1',
            tool: 'delete_all_clips',
            args: { sequenceId: 'seq-1', confirm: true },
            description: 'Delete all clips from timeline',
            riskLevel: 'critical',
            estimatedDuration: 100,
          },
        ],
        estimatedTotalDuration: 100,
        requiresApproval: true,
        rollbackStrategy: 'Undo deletion',
      };

      const deleteThought: Thought = {
        understanding: 'Delete all clips',
        requirements: ['Confirmation'],
        uncertainties: [],
        approach: 'Use delete_all_clips',
        needsMoreInfo: false,
      };

      let callCount = 0;
      vi.spyOn(mockLLM, 'generateStructured').mockImplementation(async () => {
        callCount++;
        if (callCount === 1) return deleteThought;
        if (callCount === 2) return highRiskPlan;
        return mockObservation;
      });

      const events: AgentEvent[] = [];

      // Engine should pause for approval
      const result = await engine.run('Delete all clips', agentContext, executionContext, (event) =>
        events.push(event),
      );

      // Should have emitted approval_required event
      expect(events.some((e) => e.type === 'approval_required')).toBe(true);
      expect(result.needsApproval).toBe(true);
    });

    it('should continue after approval granted', async () => {
      const highRiskPlan: Plan = {
        goal: 'Delete all clips',
        steps: [
          {
            id: 'step-1',
            tool: 'delete_all_clips',
            args: { sequenceId: 'seq-1', confirm: true },
            description: 'Delete all clips',
            riskLevel: 'critical',
            estimatedDuration: 100,
          },
        ],
        estimatedTotalDuration: 100,
        requiresApproval: true,
        rollbackStrategy: 'Undo',
      };

      let callCount = 0;
      vi.spyOn(mockLLM, 'generateStructured').mockImplementation(async () => {
        callCount++;
        if (callCount === 1)
          return {
            understanding: 'Delete',
            requirements: [],
            uncertainties: [],
            approach: 'Delete',
            needsMoreInfo: false,
          };
        if (callCount === 2) return highRiskPlan;
        return mockObservation;
      });

      // Create engine with auto-approve for testing
      const autoApproveEngine = createAgenticEngine(mockLLM, mockToolExecutor, {
        approvalHandler: async () => true,
      });

      const result = await autoApproveEngine.run(
        'Delete all clips',
        agentContext,
        executionContext,
      );

      // Should have completed after approval
      expect(result.success).toBe(true);
    });

    it('should abort when approval denied', async () => {
      const highRiskPlan: Plan = {
        goal: 'Delete all clips',
        steps: [
          {
            id: 'step-1',
            tool: 'delete_all_clips',
            args: { sequenceId: 'seq-1', confirm: true },
            description: 'Delete all clips',
            riskLevel: 'critical',
            estimatedDuration: 100,
          },
        ],
        estimatedTotalDuration: 100,
        requiresApproval: true,
        rollbackStrategy: 'Undo',
      };

      let callCount = 0;
      vi.spyOn(mockLLM, 'generateStructured').mockImplementation(async () => {
        callCount++;
        if (callCount === 1)
          return {
            understanding: 'Delete',
            requirements: [],
            uncertainties: [],
            approach: 'Delete',
            needsMoreInfo: false,
          };
        if (callCount === 2) return highRiskPlan;
        return mockObservation;
      });

      // Create engine that denies approval
      const denyApproveEngine = createAgenticEngine(mockLLM, mockToolExecutor, {
        approvalHandler: async () => false,
      });

      const result = await denyApproveEngine.run(
        'Delete all clips',
        agentContext,
        executionContext,
      );

      expect(result.success).toBe(false);
      expect(result.approvalDenied).toBe(true);
    });
  });

  describe('abort', () => {
    it('should abort running process', async () => {
      let aborted = false;
      // Track timers for deterministic cleanup
      const pendingTimers: ReturnType<typeof setInterval>[] = [];

      vi.spyOn(mockLLM, 'generateStructured').mockImplementation(async () => {
        return new Promise<Thought>((resolve, reject) => {
          const checkAbort = setInterval(() => {
            if (aborted) {
              clearInterval(checkAbort);
              reject(new Error('Aborted'));
            }
          }, 10);
          pendingTimers.push(checkAbort);

          const safetyTimer = setTimeout(() => {
            clearInterval(checkAbort);
            resolve(mockThought);
          }, 5000);
          pendingTimers.push(safetyTimer);
        });
      });

      // Override abort to set flag
      const originalAbort = mockLLM.abort.bind(mockLLM);
      vi.spyOn(mockLLM, 'abort').mockImplementation(() => {
        aborted = true;
        originalAbort();
      });

      const promise = engine.run('Split the clip', agentContext, executionContext);

      // Abort after short delay
      const abortTimer = setTimeout(() => engine.abort(), 50);
      pendingTimers.push(abortTimer);

      const result = await promise;

      // Clean up any remaining timers to prevent leaks
      for (const timer of pendingTimers) {
        clearTimeout(timer);
        clearInterval(timer);
      }

      expect(result.success).toBe(false);
      // May be aborted or error depending on timing
      expect(result.aborted || result.error !== undefined).toBe(true);
    });
  });

  describe('error handling', () => {
    it('should handle thinking phase error', async () => {
      vi.spyOn(mockLLM, 'generateStructured').mockRejectedValue(new Error('LLM API error'));

      const result = await engine.run('Split the clip', agentContext, executionContext);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should handle planning phase error', async () => {
      let callCount = 0;
      vi.spyOn(mockLLM, 'generateStructured').mockImplementation(async () => {
        callCount++;
        if (callCount === 1) return mockThought;
        throw new Error('Planning failed');
      });

      const result = await engine.run('Split the clip', agentContext, executionContext);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should handle execution phase error', async () => {
      let callCount = 0;
      vi.spyOn(mockLLM, 'generateStructured').mockImplementation(async () => {
        callCount++;
        if (callCount === 1) return mockThought;
        if (callCount === 2) return mockPlan;
        return mockObservation;
      });

      mockToolExecutor.setToolError('split_clip', new Error('Tool crashed'));

      const result = await engine.run('Split the clip', agentContext, executionContext);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should emit error events', async () => {
      vi.spyOn(mockLLM, 'generateStructured').mockRejectedValue(new Error('LLM error'));

      const events: AgentEvent[] = [];

      await engine.run('Split the clip', agentContext, executionContext, (event) =>
        events.push(event),
      );

      expect(events.some((e) => e.type === 'session_failed')).toBe(true);
    });
  });

  describe('state tracking', () => {
    it('should track iteration count', async () => {
      let callCount = 0;
      vi.spyOn(mockLLM, 'generateStructured').mockImplementation(async () => {
        callCount++;
        if (callCount === 1) return mockThought;
        if (callCount === 2) return mockPlan;
        return mockObservation;
      });

      const result = await engine.run('Split the clip', agentContext, executionContext);

      expect(result.iterations).toBe(1);
    });

    it('should track total duration', async () => {
      let callCount = 0;
      vi.spyOn(mockLLM, 'generateStructured').mockImplementation(async () => {
        // Add small delay to ensure measurable duration
        await new Promise((resolve) => setTimeout(resolve, 5));
        callCount++;
        if (callCount === 1) return mockThought;
        if (callCount === 2) return mockPlan;
        return mockObservation;
      });

      const result = await engine.run('Split the clip', agentContext, executionContext);

      expect(result.totalDuration).toBeGreaterThanOrEqual(0);
    });
  });

  describe('governance', () => {
    it('Given a two-step plan and one-step budget, When planning completes, Then run fails before execution', async () => {
      const planWithTwoSteps: Plan = {
        goal: 'Split then move',
        steps: [
          {
            id: 'step-1',
            tool: 'split_clip',
            args: { clipId: 'clip-1', position: 5 },
            description: 'Split clip at 5s',
            riskLevel: 'low',
            estimatedDuration: 100,
          },
          {
            id: 'step-2',
            tool: 'move_clip',
            args: { clipId: 'clip-1', position: 10 },
            description: 'Move split result',
            riskLevel: 'low',
            estimatedDuration: 100,
            dependsOn: ['step-1'],
          },
        ],
        estimatedTotalDuration: 200,
        requiresApproval: false,
        rollbackStrategy: 'Undo operations',
      };

      let callCount = 0;
      vi.spyOn(mockLLM, 'generateStructured').mockImplementation(async () => {
        callCount += 1;
        if (callCount === 1) return mockThought;
        if (callCount === 2) return planWithTwoSteps;
        return mockObservation;
      });

      const budgetEngine = createAgenticEngine(mockLLM, mockToolExecutor, {
        enableFastPath: false,
        maxStepsPerRun: 1,
      });

      const result = await budgetEngine.run('Split then move', agentContext, executionContext);

      expect(result.success).toBe(false);
      expect(result.error).toBeInstanceOf(StepBudgetExceededError);
      expect(mockToolExecutor.getExecutionCount()).toBe(0);
    });

    it('Given a destructive fast-path request, When guardrail is enabled, Then approval is required', async () => {
      agentContext.sequenceId = 'sequence-1';

      mockToolExecutor.registerTool({
        info: {
          name: 'delete_clips_in_range',
          description: 'Delete clips in range',
          category: 'editing',
          riskLevel: 'medium',
          supportsUndo: true,
          parallelizable: false,
        },
        parameters: {
          type: 'object',
          properties: {
            sequenceId: { type: 'string' },
            startTime: { type: 'number' },
            endTime: { type: 'number' },
          },
        },
        required: ['sequenceId', 'startTime', 'endTime'],
        result: {
          success: true,
          data: { deleted: 2 },
          duration: 15,
        },
      });

      const destructiveEngine = createAgenticEngine(mockLLM, mockToolExecutor);
      const result = await destructiveEngine.run(
        'Delete from 00:01 to 00:03',
        agentContext,
        executionContext,
      );

      expect(result.success).toBe(false);
      expect(result.needsApproval).toBe(true);
      expect(result.approvalDenied).toBe(true);
      expect(result.pendingPlan?.requiresApproval).toBe(true);
      expect(mockToolExecutor.wasToolCalled('delete_clips_in_range')).toBe(false);
    });

    it('Given a destructive fast-path request, When guardrail is disabled, Then execution proceeds', async () => {
      agentContext.sequenceId = 'sequence-1';

      mockToolExecutor.registerTool({
        info: {
          name: 'delete_clips_in_range',
          description: 'Delete clips in range',
          category: 'editing',
          riskLevel: 'medium',
          supportsUndo: true,
          parallelizable: false,
        },
        parameters: {
          type: 'object',
          properties: {
            sequenceId: { type: 'string' },
            startTime: { type: 'number' },
            endTime: { type: 'number' },
          },
        },
        required: ['sequenceId', 'startTime', 'endTime'],
        result: {
          success: true,
          data: { deleted: 2 },
          duration: 15,
        },
      });

      mockLLM.setStructuredResponse({ structured: mockObservation });

      const permissiveEngine = createAgenticEngine(mockLLM, mockToolExecutor, {
        requireApprovalForDestructiveActions: false,
      });

      const result = await permissiveEngine.run(
        'Delete from 00:01 to 00:03',
        agentContext,
        executionContext,
      );

      expect(result.success).toBe(true);
      expect(mockToolExecutor.wasToolCalled('delete_clips_in_range')).toBe(true);
    });

    it('Given retries and a single-call budget, When second attempt would execute, Then run fails with budget error', async () => {
      let attempts = 0;
      mockToolExecutor.registerTool({
        info: {
          name: 'flaky_budget_tool',
          description: 'Fails first then succeeds',
          category: 'editing',
          riskLevel: 'low',
          supportsUndo: true,
          parallelizable: false,
        },
        parameters: {
          type: 'object',
          properties: {},
          required: [],
        },
        executor: async () => {
          attempts += 1;
          if (attempts === 1) {
            return { success: false, error: 'Temporary', duration: 10 };
          }
          return { success: true, data: { ok: true }, duration: 10 };
        },
      });

      const thought: Thought = {
        understanding: 'Use flaky budget tool',
        requirements: [],
        uncertainties: [],
        approach: 'Execute one tool',
        needsMoreInfo: false,
      };

      const plan: Plan = {
        goal: 'Flaky tool operation',
        steps: [
          {
            id: 'step-1',
            tool: 'flaky_budget_tool',
            args: {},
            description: 'Run flaky tool',
            riskLevel: 'low',
            estimatedDuration: 20,
          },
        ],
        estimatedTotalDuration: 20,
        requiresApproval: false,
        rollbackStrategy: 'N/A',
      };

      let callCount = 0;
      vi.spyOn(mockLLM, 'generateStructured').mockImplementation(async () => {
        callCount += 1;
        if (callCount === 1) return thought;
        if (callCount === 2) return plan;
        return mockObservation;
      });

      const budgetEngine = createAgenticEngine(mockLLM, mockToolExecutor, {
        enableFastPath: false,
        maxRetries: 3,
        maxToolCallsPerRun: 1,
      });

      const result = await budgetEngine.run('Run flaky tool', agentContext, executionContext);

      expect(result.success).toBe(false);
      expect(result.error).toBeInstanceOf(ToolBudgetExceededError);
      expect(attempts).toBe(1);
    });

    it('Given an empty timeline and clip-targeted failure, When observer requests retries, Then engine stops retry loop immediately', async () => {
      agentContext.availableTracks = [
        {
          id: 'track-empty',
          name: 'Video 1',
          type: 'video',
          clipCount: 0,
        },
      ];

      mockToolExecutor.setToolResult('split_clip', {
        success: false,
        error: 'Clip not found',
        duration: 10,
      });

      const thought: Thought = {
        understanding: 'Split clip at 5 seconds',
        requirements: [],
        uncertainties: [],
        approach: 'Use split_clip',
        needsMoreInfo: false,
      };

      const plan: Plan = {
        goal: 'Split a clip',
        steps: [
          {
            id: 'step-1',
            tool: 'split_clip',
            args: { clipId: 'clip-missing', position: 5 },
            description: 'Split missing clip',
            riskLevel: 'low',
            estimatedDuration: 20,
          },
        ],
        estimatedTotalDuration: 20,
        requiresApproval: false,
        rollbackStrategy: 'N/A',
      };

      const loopingObservation: Observation = {
        goalAchieved: false,
        stateChanges: [],
        summary: 'Split failed, retrying with same approach',
        confidence: 0.5,
        needsIteration: true,
        iterationReason: 'Retry split operation',
      };

      let callCount = 0;
      vi.spyOn(mockLLM, 'generateStructured').mockImplementation(async () => {
        callCount += 1;
        if (callCount % 3 === 1) return thought;
        if (callCount % 3 === 2) return plan;
        return loopingObservation;
      });

      const guardedEngine = createAgenticEngine(mockLLM, mockToolExecutor, {
        enableFastPath: false,
        maxIterations: 5,
      });

      const result = await guardedEngine.run(
        'Split the clip at 5 seconds',
        agentContext,
        executionContext,
      );

      expect(result.success).toBe(false);
      expect(result.iterations).toBe(1);
      expect(result.observation?.needsIteration).toBe(false);
      expect(result.observation?.summary).toContain('Stopped automatic retries');
    });

    it('Given deterministic track-resolution failure, When observer keeps requesting retries, Then engine stops immediately', async () => {
      agentContext.availableTracks = [
        {
          id: 'track-1',
          name: 'Video 1',
          type: 'video',
          clipCount: 2,
        },
      ];

      mockToolExecutor.setToolResult('move_clip', {
        success: false,
        error: "Track 'track-999' not found",
        duration: 10,
      });

      const thought: Thought = {
        understanding: 'Move clip to another track',
        requirements: [],
        uncertainties: [],
        approach: 'Use move_clip',
        needsMoreInfo: false,
      };

      const plan: Plan = {
        goal: 'Move a clip',
        steps: [
          {
            id: 'step-1',
            tool: 'move_clip',
            args: { clipId: 'clip-1', position: 10 },
            description: 'Move clip to target track',
            riskLevel: 'low',
            estimatedDuration: 20,
          },
        ],
        estimatedTotalDuration: 20,
        requiresApproval: false,
        rollbackStrategy: 'N/A',
      };

      const loopingObservation: Observation = {
        goalAchieved: false,
        stateChanges: [],
        summary: 'Move failed, trying again',
        confidence: 0.6,
        needsIteration: true,
        iterationReason: 'Retry move operation',
      };

      let callCount = 0;
      vi.spyOn(mockLLM, 'generateStructured').mockImplementation(async () => {
        callCount += 1;
        if (callCount % 3 === 1) return thought;
        if (callCount % 3 === 2) return plan;
        return loopingObservation;
      });

      const guardedEngine = createAgenticEngine(mockLLM, mockToolExecutor, {
        enableFastPath: false,
        maxIterations: 4,
      });

      const result = await guardedEngine.run(
        'Move clip to another track',
        agentContext,
        executionContext,
      );

      expect(result.success).toBe(false);
      expect(result.iterations).toBe(1);
      expect(result.observation?.needsIteration).toBe(false);
      expect(result.observation?.summary).toContain('Stopped automatic retries');
    });

    it('Given partial execution and undoable history, When execution fails, Then rollback recovery is attempted', async () => {
      mockToolExecutor.registerTool({
        info: {
          name: 'undoable_edit',
          description: 'Edit with undo',
          category: 'editing',
          riskLevel: 'low',
          supportsUndo: true,
          parallelizable: false,
        },
        parameters: {
          type: 'object',
          properties: {},
          required: [],
        },
        result: {
          success: true,
          data: { edited: true },
          duration: 10,
          undoable: true,
          undoOperation: {
            tool: 'undo_edit',
            args: { target: 'clip-1' },
            description: 'Undo the edit',
          },
        },
      });

      mockToolExecutor.registerTool({
        info: {
          name: 'crash_edit',
          description: 'Crashes during execution',
          category: 'editing',
          riskLevel: 'low',
          supportsUndo: false,
          parallelizable: false,
        },
        parameters: {
          type: 'object',
          properties: {},
          required: [],
        },
        error: new Error('Crash during edit'),
      });

      mockToolExecutor.registerTool({
        info: {
          name: 'undo_edit',
          description: 'Undo prior edit',
          category: 'editing',
          riskLevel: 'low',
          supportsUndo: false,
          parallelizable: false,
        },
        parameters: {
          type: 'object',
          properties: {
            target: { type: 'string' },
          },
          required: ['target'],
        },
        result: {
          success: true,
          data: { reverted: true },
          duration: 8,
        },
      });

      const thought: Thought = {
        understanding: 'Run edit pipeline',
        requirements: [],
        uncertainties: [],
        approach: 'Apply edit then finish',
        needsMoreInfo: false,
      };

      const plan: Plan = {
        goal: 'Run undoable edit then crashing edit',
        steps: [
          {
            id: 'step-1',
            tool: 'undoable_edit',
            args: {},
            description: 'Apply undoable edit',
            riskLevel: 'low',
            estimatedDuration: 20,
          },
          {
            id: 'step-2',
            tool: 'crash_edit',
            args: {},
            description: 'This step crashes',
            riskLevel: 'low',
            estimatedDuration: 20,
            dependsOn: ['step-1'],
          },
        ],
        estimatedTotalDuration: 40,
        requiresApproval: false,
        rollbackStrategy: 'Undo prior edits',
      };

      let callCount = 0;
      vi.spyOn(mockLLM, 'generateStructured').mockImplementation(async () => {
        callCount += 1;
        if (callCount === 1) return thought;
        if (callCount === 2) return plan;
        return mockObservation;
      });

      const recoveryEngine = createAgenticEngine(mockLLM, mockToolExecutor, {
        enableFastPath: false,
      });

      const result = await recoveryEngine.run(
        'Run unstable edit pipeline',
        agentContext,
        executionContext,
      );

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('Crash during edit');
      expect(result.executionResults[0]?.completedSteps).toHaveLength(1);
      expect(result.executionResults[0]?.failedSteps).toHaveLength(1);
      expect(result.rollbackReport?.attempted).toBe(true);
      expect(result.rollbackReport?.attemptedCount).toBe(1);
      expect(result.rollbackReport?.succeededCount).toBe(1);
      expect(mockToolExecutor.wasToolCalled('undo_edit')).toBe(true);
      expect(result.summary?.failureReason).toContain('Crash during edit');
    });

    it('Given rollback is disabled, When execution fails, Then rollback is skipped', async () => {
      mockToolExecutor.registerTool({
        info: {
          name: 'undoable_edit',
          description: 'Edit with undo',
          category: 'editing',
          riskLevel: 'low',
          supportsUndo: true,
          parallelizable: false,
        },
        parameters: {
          type: 'object',
          properties: {},
          required: [],
        },
        result: {
          success: true,
          data: { edited: true },
          duration: 10,
          undoable: true,
          undoOperation: {
            tool: 'undo_edit',
            args: { target: 'clip-1' },
            description: 'Undo the edit',
          },
        },
      });

      mockToolExecutor.registerTool({
        info: {
          name: 'crash_edit',
          description: 'Crashes during execution',
          category: 'editing',
          riskLevel: 'low',
          supportsUndo: false,
          parallelizable: false,
        },
        parameters: {
          type: 'object',
          properties: {},
          required: [],
        },
        error: new Error('Crash during edit'),
      });

      const thought: Thought = {
        understanding: 'Run edit pipeline',
        requirements: [],
        uncertainties: [],
        approach: 'Apply edit then finish',
        needsMoreInfo: false,
      };

      const plan: Plan = {
        goal: 'Run undoable edit then crashing edit',
        steps: [
          {
            id: 'step-1',
            tool: 'undoable_edit',
            args: {},
            description: 'Apply undoable edit',
            riskLevel: 'low',
            estimatedDuration: 20,
          },
          {
            id: 'step-2',
            tool: 'crash_edit',
            args: {},
            description: 'This step crashes',
            riskLevel: 'low',
            estimatedDuration: 20,
            dependsOn: ['step-1'],
          },
        ],
        estimatedTotalDuration: 40,
        requiresApproval: false,
        rollbackStrategy: 'Undo prior edits',
      };

      let callCount = 0;
      vi.spyOn(mockLLM, 'generateStructured').mockImplementation(async () => {
        callCount += 1;
        if (callCount === 1) return thought;
        if (callCount === 2) return plan;
        return mockObservation;
      });

      const recoveryEngine = createAgenticEngine(mockLLM, mockToolExecutor, {
        enableFastPath: false,
        enableAutoRollbackOnFailure: false,
      });

      const result = await recoveryEngine.run(
        'Run unstable edit pipeline',
        agentContext,
        executionContext,
      );

      expect(result.success).toBe(false);
      expect(result.rollbackReport?.attempted).toBe(false);
      expect(result.rollbackReport?.reason).toContain('disabled');
      expect(mockToolExecutor.wasToolCalled('undo_edit')).toBe(false);
    });
  });

  describe('memory integration', () => {
    it('hydrates context from memory store and records executed operations', async () => {
      const memoryStore = createMockMemoryStore({
        getRecentOperations: async () => [
          {
            operation: 'trim_clip',
            count: 3,
            lastUsed: Date.now(),
          },
        ],
        getPreferences: async () => ({
          language: 'en',
          custom: {
            captionStyle: 'clean',
          },
        }),
        getCorrections: async () => [
          {
            original: 'cut at 5s',
            corrected: 'split at 5 seconds',
          },
        ],
      });

      let callCount = 0;
      vi.spyOn(mockLLM, 'generateStructured').mockImplementation(async () => {
        callCount += 1;
        if (callCount === 1) return mockThought;
        if (callCount === 2) return mockPlan;
        return mockObservation;
      });

      const memoryEngine = createAgenticEngine(mockLLM, mockToolExecutor, {
        enableFastPath: false,
        memoryStore,
      });

      const result = await memoryEngine.run(
        'Split the clip at 5 seconds',
        agentContext,
        executionContext,
      );

      expect(result.success).toBe(true);
      expect(result.finalState.context.recentOperations[0]?.operation).toBe('trim_clip');
      expect(result.finalState.context.userPreferences.captionStyle).toBe('clean');
      expect(result.finalState.context.corrections[0]?.original).toBe('cut at 5s');
      expect(memoryStore.recordOperation).toHaveBeenCalledWith('split_clip', 'project-1');
    });
  });

  describe('configuration', () => {
    it('should use custom timeout', async () => {
      const customEngine = createAgenticEngine(mockLLM, mockToolExecutor, {
        thinkingTimeout: 100,
      });

      // Setup slow response
      vi.spyOn(mockLLM, 'generateStructured').mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 500));
        return mockThought;
      });

      const result = await customEngine.run('Split the clip', agentContext, executionContext);

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('Thinking phase timed out');
    });
  });
});
