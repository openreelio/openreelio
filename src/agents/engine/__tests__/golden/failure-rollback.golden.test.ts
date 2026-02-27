/**
 * Golden Scenario: Failure & Rollback
 *
 * Tests partial execution failure with rollback recovery.
 * Validates that step 1 succeeds, step 2 fails, and step 1 is rolled back
 * using the undo operation from its execution result.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createAgenticEngine } from '../../AgenticEngine';
import type { Thought, Plan, Observation, AgentContext } from '../../core/types';
import { createEmptyContext } from '../../core/types';
import { createMockLLMAdapter, type MockLLMAdapter } from '../../adapters/llm/MockLLMAdapter';
import {
  createMockToolExecutor,
  type MockToolExecutor,
} from '../../adapters/tools/MockToolExecutor';
import type { ExecutionContext } from '../../ports/IToolExecutor';

describe('Golden: failure-rollback', () => {
  let mockLLM: MockLLMAdapter;
  let mockToolExecutor: MockToolExecutor;
  let agentContext: AgentContext;
  let executionContext: ExecutionContext;

  beforeEach(() => {
    mockLLM = createMockLLMAdapter();
    mockToolExecutor = createMockToolExecutor();

    // Step 1: Undoable effect application (succeeds)
    mockToolExecutor.registerTool({
      info: {
        name: 'apply_effect',
        description: 'Apply a visual effect to a clip',
        category: 'editing',
        riskLevel: 'low',
        supportsUndo: true,
        parallelizable: false,
      },
      parameters: {
        type: 'object',
        properties: {
          clipId: { type: 'string' },
          effectType: { type: 'string' },
        },
      },
      required: ['clipId', 'effectType'],
      result: {
        success: true,
        data: { effectId: 'effect-blur-1' },
        duration: 30,
        undoable: true,
        undoOperation: {
          tool: 'remove_effect',
          args: { effectId: 'effect-blur-1' },
          description: 'Remove the applied blur effect',
        },
      },
    });

    // Step 2: Failing render step (crashes)
    mockToolExecutor.registerTool({
      info: {
        name: 'export_clip',
        description: 'Export clip to file',
        category: 'rendering',
        riskLevel: 'low',
        supportsUndo: false,
        parallelizable: false,
      },
      parameters: {
        type: 'object',
        properties: {
          clipId: { type: 'string' },
          format: { type: 'string' },
        },
      },
      required: ['clipId', 'format'],
      error: new Error('Export failed: unsupported codec h265'),
    });

    // Step 3: Never reached (depends on step-2)
    mockToolExecutor.registerTool({
      info: {
        name: 'upload_result',
        description: 'Upload exported file',
        category: 'utility',
        riskLevel: 'low',
        supportsUndo: false,
        parallelizable: false,
      },
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
      },
      required: ['path'],
      result: {
        success: true,
        data: { url: 'https://example.com/video.mp4' },
        duration: 100,
      },
    });

    // Undo tool (for rollback)
    mockToolExecutor.registerTool({
      info: {
        name: 'remove_effect',
        description: 'Remove an effect from a clip',
        category: 'editing',
        riskLevel: 'low',
        supportsUndo: false,
        parallelizable: false,
      },
      parameters: {
        type: 'object',
        properties: {
          effectId: { type: 'string' },
        },
      },
      required: ['effectId'],
      result: {
        success: true,
        data: { removed: true },
        duration: 15,
      },
    });

    agentContext = createEmptyContext('project-1');
    agentContext.sequenceId = 'sequence-1';
    agentContext.selectedClips = ['clip-1'];
    agentContext.availableTools = mockToolExecutor.getAvailableTools().map((t) => t.name);

    executionContext = {
      projectId: 'project-1',
      sequenceId: 'sequence-1',
      sessionId: 'session-golden-rollback',
    };
  });

  it('should rollback step 1 when step 2 fails in a 3-step plan', async () => {
    const thought: Thought = {
      understanding: 'Apply effect, export, and upload',
      requirements: ['Clip ID', 'Effect type', 'Export format'],
      uncertainties: [],
      approach: 'Apply blur effect, export as h265, then upload',
      needsMoreInfo: false,
    };

    const plan: Plan = {
      goal: 'Apply effect, export, and upload the result',
      steps: [
        {
          id: 'step-1',
          tool: 'apply_effect',
          args: { clipId: 'clip-1', effectType: 'blur' },
          description: 'Apply blur effect to clip',
          riskLevel: 'low',
          estimatedDuration: 50,
        },
        {
          id: 'step-2',
          tool: 'export_clip',
          args: { clipId: 'clip-1', format: 'h265' },
          description: 'Export clip (this will fail)',
          riskLevel: 'low',
          estimatedDuration: 500,
          dependsOn: ['step-1'],
        },
        {
          id: 'step-3',
          tool: 'upload_result',
          args: { path: { $fromStep: 'step-2', $path: 'data.outputPath' } },
          description: 'Upload exported file',
          riskLevel: 'low',
          estimatedDuration: 200,
          dependsOn: ['step-2'],
        },
      ],
      estimatedTotalDuration: 750,
      requiresApproval: false,
      rollbackStrategy: 'Remove effect if downstream steps fail',
    };

    const failureObservation: Observation = {
      goalAchieved: false,
      stateChanges: [],
      summary: 'Export failed; effect has been rolled back',
      confidence: 0.8,
      needsIteration: false,
    };

    let callCount = 0;
    vi.spyOn(mockLLM, 'generateStructured').mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return thought;
      if (callCount === 2) return plan;
      return failureObservation;
    });

    const engine = createAgenticEngine(mockLLM, mockToolExecutor, {
      enableFastPath: false,
      enableAutoRollbackOnFailure: true,
      maxRollbackSteps: 10,
    });

    const result = await engine.run(
      'Apply blur effect, export clip, and upload',
      agentContext,
      executionContext,
    );

    // Verify overall failure
    expect(result.success).toBe(false);
    expect(result.error?.message).toContain('Export failed');

    // Verify step 1 completed, step 2 failed
    expect(result.executionResults[0]?.completedSteps).toHaveLength(1);
    expect(result.executionResults[0]?.failedSteps).toHaveLength(1);

    // Step 3 should NOT have been attempted (depends on failed step-2)
    expect(mockToolExecutor.wasToolCalled('upload_result')).toBe(false);

    // Verify rollback occurred
    expect(result.rollbackReport?.attempted).toBe(true);
    expect(result.rollbackReport?.attemptedCount).toBe(1);
    expect(result.rollbackReport?.succeededCount).toBe(1);

    // Verify undo tool called with correct args from undoOperation
    expect(mockToolExecutor.wasToolCalled('remove_effect')).toBe(true);
    expect(mockToolExecutor.wasToolCalledWith('remove_effect', {
      effectId: 'effect-blur-1',
    })).toBe(true);

    // Verify execution order: apply_effect → export_clip (fail) → remove_effect (rollback)
    const executions = mockToolExecutor.getCapturedExecutions();
    const toolOrder = executions.map((e) => e.toolName);
    expect(toolOrder.indexOf('apply_effect')).toBeLessThan(toolOrder.indexOf('export_clip'));
    expect(toolOrder.indexOf('export_clip')).toBeLessThan(toolOrder.indexOf('remove_effect'));
  });

  it('should report rollback in session summary on failure', async () => {
    const thought: Thought = {
      understanding: 'Apply effect and export',
      requirements: [],
      uncertainties: [],
      approach: 'Apply then export',
      needsMoreInfo: false,
    };

    const plan: Plan = {
      goal: 'Apply effect and export',
      steps: [
        {
          id: 'step-1',
          tool: 'apply_effect',
          args: { clipId: 'clip-1', effectType: 'blur' },
          description: 'Apply blur',
          riskLevel: 'low',
          estimatedDuration: 50,
        },
        {
          id: 'step-2',
          tool: 'export_clip',
          args: { clipId: 'clip-1', format: 'h265' },
          description: 'Export (fails)',
          riskLevel: 'low',
          estimatedDuration: 500,
          dependsOn: ['step-1'],
        },
      ],
      estimatedTotalDuration: 550,
      requiresApproval: false,
      rollbackStrategy: 'Remove effect on failure',
    };

    let callCount = 0;
    vi.spyOn(mockLLM, 'generateStructured').mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return thought;
      if (callCount === 2) return plan;
      return {
        goalAchieved: false,
        stateChanges: [],
        summary: 'Failed with rollback',
        confidence: 0.7,
        needsIteration: false,
      };
    });

    const engine = createAgenticEngine(mockLLM, mockToolExecutor, {
      enableFastPath: false,
      enableAutoRollbackOnFailure: true,
    });

    const result = await engine.run(
      'Apply blur and export',
      agentContext,
      executionContext,
    );

    expect(result.success).toBe(false);
    expect(result.summary?.failureReason).toContain('Export failed');
    expect(result.rollbackReport?.candidateCount).toBeGreaterThanOrEqual(1);
  });
});
