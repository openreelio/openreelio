/**
 * Golden Scenario: Backend Atomic Execution
 *
 * Tests BackendToolExecutor with mock IPC, verifying:
 * - Multi-step plans are batched into a single execute_agent_plan IPC call
 * - Atomic rollback on step failure
 * - Correct result mapping from backend to ToolExecutionResult
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { BackendToolExecutor } from '../../adapters/tools/BackendToolExecutor';
import {
  createMockToolExecutor,
  type MockToolExecutor,
} from '../../adapters/tools/MockToolExecutor';
import type { ExecutionContext } from '../../ports/IToolExecutor';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

const mockInvoke = vi.mocked(invoke);

describe('Golden: backend-atomic', () => {
  let mockToolExecutor: MockToolExecutor;
  let backendExecutor: BackendToolExecutor;
  let executionContext: ExecutionContext;

  beforeEach(() => {
    vi.clearAllMocks();
    mockToolExecutor = createMockToolExecutor();

    // Register editing tools (category: 'clip' → backend route)
    mockToolExecutor.registerTool({
      info: {
        name: 'split_clip',
        description: 'Split a clip',
        category: 'clip',
        riskLevel: 'low',
        supportsUndo: true,
        parallelizable: false,
      },
      parameters: {
        type: 'object',
        properties: {
          clipId: { type: 'string' },
          splitTime: { type: 'number' },
        },
      },
      required: ['clipId', 'splitTime'],
      result: { success: true, data: { newClipId: 'clip-2' }, duration: 20 },
    });

    mockToolExecutor.registerTool({
      info: {
        name: 'move_clip',
        description: 'Move a clip',
        category: 'clip',
        riskLevel: 'low',
        supportsUndo: true,
        parallelizable: false,
      },
      parameters: {
        type: 'object',
        properties: {
          clipId: { type: 'string' },
          newPosition: { type: 'number' },
        },
      },
      required: ['clipId', 'newPosition'],
      result: { success: true, data: { moved: true }, duration: 15 },
    });

    mockToolExecutor.registerTool({
      info: {
        name: 'trim_clip',
        description: 'Trim a clip',
        category: 'clip',
        riskLevel: 'low',
        supportsUndo: true,
        parallelizable: false,
      },
      parameters: {
        type: 'object',
        properties: {
          clipId: { type: 'string' },
          newEndTime: { type: 'number' },
        },
      },
      required: ['clipId', 'newEndTime'],
      result: { success: true, data: { trimmed: true }, duration: 10 },
    });

    // Analysis tool (category: 'analysis' → frontend route)
    mockToolExecutor.registerTool({
      info: {
        name: 'get_timeline_info',
        description: 'Get timeline info',
        category: 'analysis',
        riskLevel: 'low',
        supportsUndo: false,
        parallelizable: true,
      },
      parameters: { type: 'object', properties: {} },
      result: { success: true, data: { trackCount: 3 }, duration: 5 },
    });

    backendExecutor = new BackendToolExecutor(mockToolExecutor);

    executionContext = {
      projectId: 'project-1',
      sequenceId: 'sequence-1',
      sessionId: 'session-golden-atomic',
    };
  });

  it('should batch 3 editing steps into a single execute_agent_plan IPC call', async () => {
    mockInvoke.mockResolvedValueOnce({
      planId: 'batch-1',
      success: true,
      totalSteps: 3,
      stepsCompleted: 3,
      stepResults: [
        { stepId: 'step-1', success: true, data: { newClipId: 'clip-2' }, durationMs: 20 },
        { stepId: 'step-2', success: true, data: { moved: true }, durationMs: 15 },
        { stepId: 'step-3', success: true, data: { trimmed: true }, durationMs: 10 },
      ],
      operationIds: ['op-1', 'op-2', 'op-3'],
      executionTimeMs: 45,
    });

    const result = await backendExecutor.executeBatch(
      {
        tools: [
          { name: 'split_clip', args: { clipId: 'clip-1', splitTime: 5 } },
          { name: 'move_clip', args: { clipId: 'clip-2', newPosition: 10 } },
          { name: 'trim_clip', args: { clipId: 'clip-2', newEndTime: 15 } },
        ],
        mode: 'sequential',
        stopOnError: true,
      },
      executionContext,
    );

    // All steps succeeded
    expect(result.success).toBe(true);
    expect(result.successCount).toBe(3);
    expect(result.failureCount).toBe(0);

    // Single IPC call containing all 3 steps
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockInvoke).toHaveBeenCalledWith('execute_agent_plan', {
      plan: expect.objectContaining({
        steps: [
          expect.objectContaining({ toolName: 'split_clip' }),
          expect.objectContaining({ toolName: 'move_clip' }),
          expect.objectContaining({ toolName: 'trim_clip' }),
        ],
      }),
    });

    // Verify individual results
    expect(result.results[0].result.data).toEqual({ newClipId: 'clip-2' });
    expect(result.results[1].result.data).toEqual({ moved: true });
    expect(result.results[2].result.data).toEqual({ trimmed: true });
  });

  it('should rollback all steps when IPC transaction fails', async () => {
    mockInvoke.mockRejectedValueOnce(new Error('Transaction rolled back: step 2 failed'));

    const result = await backendExecutor.executeBatch(
      {
        tools: [
          { name: 'split_clip', args: { clipId: 'clip-1', splitTime: 5 } },
          { name: 'move_clip', args: { clipId: 'clip-2', newPosition: 10 } },
          { name: 'trim_clip', args: { clipId: 'clip-2', newEndTime: 15 } },
        ],
        mode: 'sequential',
        stopOnError: true,
      },
      executionContext,
    );

    // All steps failed (atomic rollback)
    expect(result.success).toBe(false);
    expect(result.failureCount).toBe(3);
    expect(result.successCount).toBe(0);

    // Each result has the rollback error
    for (const r of result.results) {
      expect(r.result.success).toBe(false);
      expect(r.result.error).toContain('Batch execution error');
    }
  });

  it('should handle partial step failure reported by backend', async () => {
    mockInvoke.mockResolvedValueOnce({
      planId: 'batch-2',
      success: false,
      totalSteps: 3,
      stepsCompleted: 1,
      stepResults: [
        { stepId: 'step-1', success: true, data: { newClipId: 'clip-2' }, durationMs: 20 },
        { stepId: 'step-2', success: false, error: 'Clip not found', durationMs: 5 },
        { stepId: 'step-3', success: false, error: 'Step not executed', durationMs: 0 },
      ],
      operationIds: ['op-1'],
      errorMessage: 'Step 2 failed: Clip not found',
      executionTimeMs: 25,
    });

    const result = await backendExecutor.executeBatch(
      {
        tools: [
          { name: 'split_clip', args: { clipId: 'clip-1', splitTime: 5 } },
          { name: 'move_clip', args: { clipId: 'nonexistent', newPosition: 10 } },
          { name: 'trim_clip', args: { clipId: 'clip-2', newEndTime: 15 } },
        ],
        mode: 'sequential',
        stopOnError: true,
      },
      executionContext,
    );

    // Overall failure
    expect(result.success).toBe(false);
    expect(result.successCount).toBe(1);
    expect(result.failureCount).toBe(2);

    // Step 1 succeeded
    expect(result.results[0].result.success).toBe(true);
    // Step 2 failed
    expect(result.results[1].result.success).toBe(false);
    expect(result.results[1].result.error).toContain('Clip not found');
    // Step 3 was not executed
    expect(result.results[2].result.success).toBe(false);
  });

  it('should route mixed batch (editing + analysis) correctly', async () => {
    // Backend handles editing tools
    mockInvoke.mockResolvedValueOnce({
      planId: 'batch-3',
      success: true,
      totalSteps: 2,
      stepsCompleted: 2,
      stepResults: [
        { stepId: 'step-1', success: true, data: { newClipId: 'clip-2' }, durationMs: 20 },
        { stepId: 'step-2', success: true, data: { moved: true }, durationMs: 15 },
      ],
      operationIds: ['op-1', 'op-2'],
      executionTimeMs: 35,
    });

    const result = await backendExecutor.executeBatch(
      {
        tools: [
          { name: 'split_clip', args: { clipId: 'clip-1', splitTime: 5 } },
          { name: 'move_clip', args: { clipId: 'clip-2', newPosition: 10 } },
          { name: 'get_timeline_info', args: {} },
        ],
        mode: 'sequential',
        stopOnError: true,
      },
      executionContext,
    );

    expect(result.success).toBe(true);
    expect(result.successCount).toBe(3);

    // Backend IPC: only editing tools (split + move)
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockInvoke).toHaveBeenCalledWith('execute_agent_plan', {
      plan: expect.objectContaining({
        steps: expect.arrayContaining([
          expect.objectContaining({ toolName: 'split_clip' }),
          expect.objectContaining({ toolName: 'move_clip' }),
        ]),
      }),
    });

    // Frontend executor handled the analysis tool via its executeBatch
    // (MockToolExecutor.executeBatch internally calls execute, so the call IS recorded)
    expect(mockToolExecutor.wasToolCalled('get_timeline_info')).toBe(true);
  });
});
