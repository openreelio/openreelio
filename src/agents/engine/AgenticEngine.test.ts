/**
 * AgenticEngine Tests
 *
 * Tests for the main Agentic Engine orchestrator.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AgenticEngine, createAgenticEngine } from './AgenticEngine';
import type { AgentEvent } from './core/types';
import {
  createMockLLMAdapter,
  type MockLLMAdapter,
} from './adapters/llm/MockLLMAdapter';
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
    agentContext.availableTools = mockToolExecutor
      .getAvailableTools()
      .map((t) => t.name);

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
        executionContext
      );

      expect(result.success).toBe(true);
      expect(result.observation?.goalAchieved).toBe(true);
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

      await engine.run(
        'Split the clip at 5 seconds',
        agentContext,
        executionContext,
        (event) => events.push(event)
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

      const result = await engine.run(
        'Do something with the clip',
        agentContext,
        executionContext
      );

      expect(result.success).toBe(false);
      expect(result.needsClarification).toBe(true);
      expect(result.clarificationQuestion).toBeDefined();
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

      const result = await engine.run(
        'Split the clip',
        agentContext,
        executionContext,
        (event) => events.push(event)
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

      const result = await maxIterEngine.run(
        'Split the clip',
        agentContext,
        executionContext
      );

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
      const result = await engine.run(
        'Delete all clips',
        agentContext,
        executionContext,
        (event) => events.push(event)
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
      const autoApproveEngine = createAgenticEngine(
        mockLLM,
        mockToolExecutor,
        {
          approvalHandler: async () => true,
        }
      );

      const result = await autoApproveEngine.run(
        'Delete all clips',
        agentContext,
        executionContext
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
      const denyApproveEngine = createAgenticEngine(
        mockLLM,
        mockToolExecutor,
        {
          approvalHandler: async () => false,
        }
      );

      const result = await denyApproveEngine.run(
        'Delete all clips',
        agentContext,
        executionContext
      );

      expect(result.success).toBe(false);
      expect(result.approvalDenied).toBe(true);
    });
  });

  describe('abort', () => {
    it('should abort running process', async () => {
      let aborted = false;

      vi.spyOn(mockLLM, 'generateStructured').mockImplementation(async () => {
        return new Promise<Thought>((resolve, reject) => {
          // Check for abort periodically
          const checkAbort = setInterval(() => {
            if (aborted) {
              clearInterval(checkAbort);
              reject(new Error('Aborted'));
            }
          }, 10);
          // Timeout safety
          setTimeout(() => {
            clearInterval(checkAbort);
            resolve(mockThought);
          }, 5000);
        });
      });

      // Override abort to set flag
      const originalAbort = mockLLM.abort.bind(mockLLM);
      vi.spyOn(mockLLM, 'abort').mockImplementation(() => {
        aborted = true;
        originalAbort();
      });

      const promise = engine.run(
        'Split the clip',
        agentContext,
        executionContext
      );

      // Abort after short delay
      setTimeout(() => engine.abort(), 50);

      const result = await promise;

      expect(result.success).toBe(false);
      // May be aborted or error depending on timing
      expect(result.aborted || result.error !== undefined).toBe(true);
    });
  });

  describe('error handling', () => {
    it('should handle thinking phase error', async () => {
      vi.spyOn(mockLLM, 'generateStructured').mockRejectedValue(
        new Error('LLM API error')
      );

      const result = await engine.run(
        'Split the clip',
        agentContext,
        executionContext
      );

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

      const result = await engine.run(
        'Split the clip',
        agentContext,
        executionContext
      );

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

      const result = await engine.run(
        'Split the clip',
        agentContext,
        executionContext
      );

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should emit error events', async () => {
      vi.spyOn(mockLLM, 'generateStructured').mockRejectedValue(
        new Error('LLM error')
      );

      const events: AgentEvent[] = [];

      await engine.run(
        'Split the clip',
        agentContext,
        executionContext,
        (event) => events.push(event)
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

      const result = await engine.run(
        'Split the clip',
        agentContext,
        executionContext
      );

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

      const result = await engine.run(
        'Split the clip',
        agentContext,
        executionContext
      );

      expect(result.totalDuration).toBeGreaterThanOrEqual(0);
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

      const result = await customEngine.run(
        'Split the clip',
        agentContext,
        executionContext
      );

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('Thinking phase timed out');
    });
  });
});
