/**
 * Golden Scenario: Destructive Approval
 *
 * Tests the human-in-the-loop approval flow for destructive operations.
 * Validates approval event sequence, grant/deny behavior, and tool execution gating.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createAgenticEngine } from '../../AgenticEngine';
import type { AgentEvent, Thought, Plan, Observation, AgentContext } from '../../core/types';
import { createEmptyContext } from '../../core/types';
import { createMockLLMAdapter, type MockLLMAdapter } from '../../adapters/llm/MockLLMAdapter';
import {
  createMockToolExecutorWithVideoTools,
  type MockToolExecutor,
} from '../../adapters/tools/MockToolExecutor';
import type { ExecutionContext } from '../../ports/IToolExecutor';

describe('Golden: destructive-approval', () => {
  let mockLLM: MockLLMAdapter;
  let mockToolExecutor: MockToolExecutor;
  let agentContext: AgentContext;
  let executionContext: ExecutionContext;

  const destructiveThought: Thought = {
    understanding: 'User wants to delete all clips from the timeline',
    requirements: ['Sequence ID', 'User confirmation'],
    uncertainties: [],
    approach: 'Call delete_all_clips with confirmation flag',
    needsMoreInfo: false,
  };

  const destructivePlan: Plan = {
    goal: 'Delete all clips from timeline',
    steps: [
      {
        id: 'step-1',
        tool: 'delete_all_clips',
        args: { sequenceId: 'sequence-1', confirm: true },
        description: 'Delete all clips (DESTRUCTIVE)',
        riskLevel: 'critical',
        estimatedDuration: 100,
      },
    ],
    estimatedTotalDuration: 100,
    requiresApproval: true,
    rollbackStrategy: 'Manual undo required',
  };

  const successObservation: Observation = {
    goalAchieved: true,
    stateChanges: [{ type: 'timeline_cleared', target: 'sequence-1' }],
    summary: 'All clips deleted from timeline',
    confidence: 1.0,
    needsIteration: false,
  };

  function setupLLMPhases(): void {
    let callCount = 0;
    vi.spyOn(mockLLM, 'generateStructured').mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return destructiveThought;
      if (callCount === 2) return destructivePlan;
      return successObservation;
    });
  }

  beforeEach(() => {
    mockLLM = createMockLLMAdapter();
    mockToolExecutor = createMockToolExecutorWithVideoTools();
    agentContext = createEmptyContext('project-1');
    agentContext.sequenceId = 'sequence-1';
    agentContext.availableTools = mockToolExecutor.getAvailableTools().map((t) => t.name);

    executionContext = {
      projectId: 'project-1',
      sequenceId: 'sequence-1',
      sessionId: 'session-golden-approval',
    };
  });

  it('should execute destructive tool after approval is granted', async () => {
    setupLLMPhases();

    const engine = createAgenticEngine(mockLLM, mockToolExecutor, {
      enableFastPath: false,
      approvalHandler: async (plan) => {
        // Verify plan metadata arrives at approval handler
        expect(plan.requiresApproval).toBe(true);
        expect(plan.steps[0].riskLevel).toBe('critical');
        return true; // Approve
      },
    });

    const events: AgentEvent[] = [];
    const result = await engine.run(
      'Delete all clips from the timeline',
      agentContext,
      executionContext,
      (event) => events.push(event),
    );

    // Tool should have executed after approval
    expect(result.success).toBe(true);
    expect(mockToolExecutor.wasToolCalled('delete_all_clips')).toBe(true);

    // Verify approval events in sequence
    const approvalRequired = events.find((e) => e.type === 'approval_required');
    const approvalResponse = events.find((e) => e.type === 'approval_response');
    expect(approvalRequired).toBeDefined();
    expect(approvalResponse).toBeDefined();
  });

  it('should abort without executing tool when approval is denied', async () => {
    setupLLMPhases();

    const engine = createAgenticEngine(mockLLM, mockToolExecutor, {
      enableFastPath: false,
      approvalHandler: async () => false, // Deny
    });

    const events: AgentEvent[] = [];
    const result = await engine.run(
      'Delete all clips from the timeline',
      agentContext,
      executionContext,
      (event) => events.push(event),
    );

    // Should fail with approval denied
    expect(result.success).toBe(false);
    expect(result.approvalDenied).toBe(true);

    // Tool should NOT have been called
    expect(mockToolExecutor.wasToolCalled('delete_all_clips')).toBe(false);

    // Approval-required event should still be emitted
    expect(events.some((e) => e.type === 'approval_required')).toBe(true);
  });

  it('should emit correct approval event sequence', async () => {
    setupLLMPhases();

    const engine = createAgenticEngine(mockLLM, mockToolExecutor, {
      enableFastPath: false,
      approvalHandler: async () => true,
    });

    const events: AgentEvent[] = [];
    await engine.run(
      'Delete all clips',
      agentContext,
      executionContext,
      (event) => events.push(event),
    );

    // Extract approval-related events in order
    const eventTypes = events.map((e) => e.type);
    const approvalReqIdx = eventTypes.indexOf('approval_required');
    const approvalResIdx = eventTypes.indexOf('approval_response');
    const execStartIdx = eventTypes.indexOf('execution_start');

    // approval_required must come before approval_response
    expect(approvalReqIdx).toBeLessThan(approvalResIdx);
    // execution_start must come after approval_response (tool gating)
    expect(approvalResIdx).toBeLessThan(execStartIdx);
  });
});
