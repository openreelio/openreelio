/**
 * Golden Scenario: Simple Split
 *
 * Tests deterministic fast-path execution for a simple "split at N seconds" command.
 * Validates that fast-path skips Think/Plan phases and executes a single tool call.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createAgenticEngine } from '../../AgenticEngine';
import type { AgentEvent, Observation, AgentContext } from '../../core/types';
import { createEmptyContext } from '../../core/types';
import { createMockLLMAdapter, type MockLLMAdapter } from '../../adapters/llm/MockLLMAdapter';
import {
  createMockToolExecutor,
  type MockToolExecutor,
} from '../../adapters/tools/MockToolExecutor';
import type { ExecutionContext } from '../../ports/IToolExecutor';

describe('Golden: simple-split', () => {
  let mockLLM: MockLLMAdapter;
  let mockToolExecutor: MockToolExecutor;
  let agentContext: AgentContext;
  let executionContext: ExecutionContext;

  beforeEach(() => {
    mockLLM = createMockLLMAdapter();
    mockToolExecutor = createMockToolExecutor();
    agentContext = createEmptyContext('project-1');
    agentContext.sequenceId = 'sequence-1';
    agentContext.selectedClips = ['clip-1'];
    agentContext.selectedTracks = ['track-1'];

    // Register split tool with args matching fast-path parser output
    mockToolExecutor.registerTool({
      info: {
        name: 'split_clip',
        description: 'Split a clip at a specific position',
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
        data: { newClipId: 'clip-2' },
        duration: 50,
      },
    });

    agentContext.availableTools = mockToolExecutor.getAvailableTools().map((t) => t.name);

    executionContext = {
      projectId: 'project-1',
      sequenceId: 'sequence-1',
      sessionId: 'session-golden-split',
    };
  });

  it('should execute fast-path for simple split command with single tool call', async () => {
    // Observation for the observe phase
    const observation: Observation = {
      goalAchieved: true,
      stateChanges: [{ type: 'clip_created', target: 'clip-2', details: { splitFrom: 'clip-1' } }],
      summary: 'Successfully split clip-1 at 5 seconds',
      confidence: 0.95,
      needsIteration: false,
    };

    // Fast-path only needs observation (skips Think/Plan)
    mockLLM.setStructuredResponse({ structured: observation });

    const engine = createAgenticEngine(mockLLM, mockToolExecutor, {
      enableFastPath: true,
      enableTracing: true,
    });

    const events: AgentEvent[] = [];
    const result = await engine.run(
      'Split clip at 5 seconds',
      agentContext,
      executionContext,
      (event) => events.push(event),
    );

    // Verify success
    expect(result.success).toBe(true);
    expect(result.iterations).toBe(1);

    // Verify single tool call
    expect(mockToolExecutor.getExecutionCount()).toBe(1);
    expect(mockToolExecutor.wasToolCalled('split_clip')).toBe(true);

    // Verify trace was generated
    if (result.trace) {
      expect(result.trace.fastPath).toBe(true);
      expect(result.trace.success).toBe(true);
    }
  });

  it('should produce equivalent tool calls for EN and KO split commands', async () => {
    const observation: Observation = {
      goalAchieved: true,
      stateChanges: [{ type: 'clip_created', target: 'clip-2' }],
      summary: 'Split completed',
      confidence: 0.95,
      needsIteration: false,
    };

    mockLLM.setStructuredResponse({ structured: observation });

    // EN: "Split clip at 5 seconds"
    const engineEN = createAgenticEngine(mockLLM, mockToolExecutor, {
      enableFastPath: true,
    });

    const resultEN = await engineEN.run(
      'Split clip at 5 seconds',
      agentContext,
      executionContext,
    );

    const enExecutions = mockToolExecutor.getCapturedExecutions();

    // Reset for KO
    mockToolExecutor.clearExecutions();
    mockLLM.clearRequests();

    // KO: "5초에서 클립 분할" — fast-path parser may or may not match Korean
    // If fast-path doesn't match, it falls back to full TPAO
    const engineKO = createAgenticEngine(mockLLM, mockToolExecutor, {
      enableFastPath: true,
    });

    // For KO fallback, provide full TPAO responses
    let callCount = 0;
    vi.spyOn(mockLLM, 'generateStructured').mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return {
          understanding: 'Split clip at 5 seconds',
          requirements: ['Clip ID', 'Position'],
          uncertainties: [],
          approach: 'Use split_clip tool',
          needsMoreInfo: false,
        };
      }
      if (callCount === 2) {
        return {
          goal: 'Split clip at 5 seconds',
          steps: [
            {
              id: 'step-1',
              tool: 'split_clip',
              args: {
                sequenceId: 'sequence-1',
                trackId: 'track-1',
                clipId: 'clip-1',
                splitTime: 5,
              },
              description: 'Split at 5s',
              riskLevel: 'low',
              estimatedDuration: 100,
            },
          ],
          estimatedTotalDuration: 100,
          requiresApproval: false,
          rollbackStrategy: 'Undo split',
        };
      }
      return observation;
    });

    const resultKO = await engineKO.run(
      '5초에서 클립 분할',
      agentContext,
      executionContext,
    );

    const koExecutions = mockToolExecutor.getCapturedExecutions();

    // Both should succeed
    expect(resultEN.success).toBe(true);
    expect(resultKO.success).toBe(true);

    // Both should call split_clip (regardless of fast-path vs full TPAO)
    expect(enExecutions.some((e) => e.toolName === 'split_clip')).toBe(true);
    expect(koExecutions.some((e) => e.toolName === 'split_clip')).toBe(true);
  });
});
