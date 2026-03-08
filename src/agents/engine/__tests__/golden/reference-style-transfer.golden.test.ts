/**
 * Golden Scenario: Reference Style Transfer
 *
 * Tests the reference_style_transfer playbook which chains 3 steps:
 * 1. analyze_reference_video - Analyze reference video for editing style patterns
 * 2. generate_style_document - Generate ESD from analysis results (depends on step 1)
 * 3. apply_editing_style - Apply reference style to source footage via DTW (depends on step 2)
 *
 * NOTE: The Planner detects a matching orchestration playbook from the Thought
 * content and SKIPS the LLM call for plan generation.  This means only 2
 * `generateStructured` calls happen (Think + Observe), not 3.
 *
 * Validates $fromStep reference resolution across all 3 chained steps,
 * sequential execution order due to dependencies, and final compatibility scoring.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createAgenticEngine } from '../../AgenticEngine';
import type { AgentEvent, Thought, Observation, AgentContext } from '../../core/types';
import { createEmptyContext } from '../../core/types';
import { createMockLLMAdapter, type MockLLMAdapter } from '../../adapters/llm/MockLLMAdapter';
import {
  createMockToolExecutor,
  type MockToolExecutor,
} from '../../adapters/tools/MockToolExecutor';
import type { ExecutionContext } from '../../ports/IToolExecutor';

describe('Golden: reference-style-transfer', () => {
  let mockLLM: MockLLMAdapter;
  let mockToolExecutor: MockToolExecutor;
  let agentContext: AgentContext;
  let executionContext: ExecutionContext;

  // Shared mock data ----------------------------------------------------------

  const thought: Thought = {
    understanding:
      'Transfer editing style from a reference video to source footage using analysis, ESD generation, and DTW-based style application',
    requirements: [
      'Reference video asset (IU Concert.mp4)',
      'Source footage asset (My Footage.mp4)',
      'Analysis pipeline for shot/segment detection',
    ],
    uncertainties: [],
    approach:
      'Analyze reference video, generate ESD from analysis, then apply editing style to source footage',
    needsMoreInfo: false,
  };

  const observation: Observation = {
    goalAchieved: true,
    stateChanges: [
      { type: 'analysis_complete', target: 'ref-asset-1' },
      { type: 'esd_created', target: 'esd-uuid-1' },
      { type: 'style_applied', target: 'source-asset-1' },
    ],
    summary:
      'Reference style transfer complete. Compatibility score: 0.82. 7 editing steps applied to source footage.',
    confidence: 0.92,
    needsIteration: false,
  };

  // Setup ---------------------------------------------------------------------

  beforeEach(() => {
    mockLLM = createMockLLMAdapter();
    mockToolExecutor = createMockToolExecutor();

    // 1. analyze_reference_video
    mockToolExecutor.registerTool({
      info: {
        name: 'analyze_reference_video',
        description: 'Analyze reference video for editing style patterns',
        category: 'analysis',
        riskLevel: 'low',
        supportsUndo: false,
        parallelizable: false,
      },
      parameters: {
        type: 'object',
        properties: {
          assetId: { type: 'string' },
        },
      },
      required: ['assetId'],
      result: {
        success: true,
        data: {
          assetId: 'ref-asset-1',
          shotCount: 5,
          segmentCount: 3,
          hasAudioProfile: true,
          hasTranscript: false,
        },
        duration: 5000,
      },
    });

    // 2. generate_style_document
    mockToolExecutor.registerTool({
      info: {
        name: 'generate_style_document',
        description: 'Generate Editing Style Document from analysis results',
        category: 'analysis',
        riskLevel: 'low',
        supportsUndo: false,
        parallelizable: false,
      },
      parameters: {
        type: 'object',
        properties: {
          assetId: { type: 'string' },
          name: { type: 'string' },
        },
      },
      required: ['assetId'],
      executor: async (args) => {
        if (typeof args.assetId !== 'string') {
          return { success: false, error: 'assetId must be a resolved string', duration: 5 };
        }
        return {
          success: true,
          data: {
            esdId: 'esd-uuid-1',
            name: 'Reference Style',
            tempoClassification: 'moderate',
            shotCount: 5,
            pacingPointCount: 5,
          },
          duration: 3000,
        };
      },
    });

    // 3. apply_editing_style
    mockToolExecutor.registerTool({
      info: {
        name: 'apply_editing_style',
        description: 'Apply reference editing style to source footage with DTW-aligned cuts',
        category: 'editing',
        riskLevel: 'medium',
        supportsUndo: true,
        parallelizable: false,
      },
      parameters: {
        type: 'object',
        properties: {
          esdId: { type: 'string' },
          sourceAssetId: { type: 'string' },
        },
      },
      required: ['esdId', 'sourceAssetId'],
      executor: async (args) => {
        if (typeof args.esdId !== 'string' || args.esdId === '') {
          return {
            success: false,
            error: 'esdId must be a resolved non-empty string',
            duration: 5,
          };
        }
        return {
          success: true,
          data: {
            compatibilityScore: 0.82,
            stepsExecuted: 7,
            warnings: ['Source duration is 1.5x longer than reference'],
          },
          duration: 2000,
        };
      },
    });

    agentContext = createEmptyContext('project-1');
    agentContext.sequenceId = 'sequence-1';
    agentContext.availableTools = mockToolExecutor.getAvailableTools().map((t) => t.name);
    agentContext.availableAssets = [
      { id: 'ref-asset-1', name: 'IU Concert.mp4', type: 'video', duration: 180 },
      { id: 'source-asset-1', name: 'My Footage.mp4', type: 'video', duration: 270 },
    ];
    agentContext.availableTracks = [
      { id: 'video-1', name: 'Video 1', type: 'video', clipCount: 1 },
    ];

    executionContext = {
      projectId: 'project-1',
      sequenceId: 'sequence-1',
      sessionId: 'session-golden-ref-style',
    };
  });

  /**
   * Helper: mock LLM for playbook flow (2 calls: Think + Observe).
   * The Planner skips the LLM call because the orchestration playbook matches.
   */
  function mockLLMForPlaybook(): { assertCallCount: (n: number) => void } {
    let callCount = 0;
    vi.spyOn(mockLLM, 'generateStructured').mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return thought;
      return observation;
    });
    return {
      assertCallCount: (n: number): void => {
        expect(callCount).toBe(n);
      },
    };
  }

  it('should execute reference style transfer playbook with 3 chained steps', async () => {
    const llmTracker = mockLLMForPlaybook();

    const engine = createAgenticEngine(mockLLM, mockToolExecutor, {
      enableFastPath: false,
      enableTracing: true,
    });

    const events: AgentEvent[] = [];
    const result = await engine.run(
      'Apply the editing style from IU Concert.mp4 to My Footage.mp4',
      agentContext,
      executionContext,
      (event) => events.push(event),
    );

    // Verify success
    expect(result.success).toBe(true);

    // Verify all 3 tools executed
    const executions = mockToolExecutor.getCapturedExecutions();
    expect(executions).toHaveLength(3);

    // Verify execution order: analyze -> generate -> apply (sequential due to dependencies)
    expect(executions[0].toolName).toBe('analyze_reference_video');
    expect(executions[1].toolName).toBe('generate_style_document');
    expect(executions[2].toolName).toBe('apply_editing_style');

    // Verify the generated playbook plan keeps the expected chain structure
    expect(result.finalState.plan?.steps.map((step) => step.tool)).toEqual([
      'analyze_reference_video',
      'generate_style_document',
      'apply_editing_style',
    ]);
    expect(result.finalState.plan?.steps[1].args.assetId).toMatchObject({
      $fromStep: 'playbook_analyze_reference',
      $path: 'data.assetId',
      $default: 'ref-asset-1',
    });
    expect(result.finalState.plan?.steps[2].args.esdId).toMatchObject({
      $fromStep: 'playbook_generate_esd',
      $path: 'data.esdId',
      $default: '',
    });

    // Verify step references resolved: generate_style_document got assetId='ref-asset-1'
    expect(executions[1].args.assetId).toBe('ref-asset-1');

    // Verify step references resolved: apply_editing_style got esdId='esd-uuid-1'
    expect(executions[2].args.esdId).toBe('esd-uuid-1');
    expect(executions[2].args.sourceAssetId).toBe('source-asset-1');

    // Verify LLM was called exactly twice (Think + Observe; Planner uses playbook)
    llmTracker.assertCallCount(2);

    // Verify trace shows non-fast-path execution
    if (result.trace) {
      expect(result.trace.success).toBe(true);
      expect(result.trace.fastPath).toBe(false);
    }
  });

  it('should include compatibility score in final observation', async () => {
    mockLLMForPlaybook();

    const engine = createAgenticEngine(mockLLM, mockToolExecutor, {
      enableFastPath: false,
      enableTracing: true,
    });

    const events: AgentEvent[] = [];
    const result = await engine.run(
      'Apply the editing style from IU Concert.mp4 to My Footage.mp4',
      agentContext,
      executionContext,
      (event) => events.push(event),
    );

    // Verify the observation is present and goal was achieved
    expect(result.observation).toBeDefined();
    expect(result.observation!.goalAchieved).toBe(true);
    expect(result.observation!.confidence).toBe(0.92);

    // Verify the observation summary mentions compatibility
    expect(result.observation!.summary).toContain('Compatibility score');

    // Verify state changes include style_applied
    const styleChange = result.observation!.stateChanges.find((sc) => sc.type === 'style_applied');
    expect(styleChange).toBeDefined();
    expect(styleChange!.target).toBe('source-asset-1');
  });

  it('should resolve step references across all 3 steps correctly', async () => {
    // Track args received by each tool for precise verification
    const receivedArgs: Record<string, Record<string, unknown>> = {};

    // Override tool executors to capture resolved args
    mockToolExecutor.registerTool({
      info: {
        name: 'analyze_reference_video',
        description: 'Analyze reference video for editing style patterns',
        category: 'analysis',
        riskLevel: 'low',
        supportsUndo: false,
        parallelizable: false,
      },
      parameters: {
        type: 'object',
        properties: {
          assetId: { type: 'string' },
        },
      },
      required: ['assetId'],
      executor: async (args) => {
        receivedArgs['analyze_reference_video'] = { ...args };
        // Verify assetId is a plain string, not a $fromStep object
        expect(typeof args.assetId).toBe('string');
        expect(args.assetId).toBe('ref-asset-1');
        return {
          success: true,
          data: {
            assetId: 'ref-asset-1',
            shotCount: 5,
            segmentCount: 3,
            hasAudioProfile: true,
            hasTranscript: false,
          },
          duration: 5000,
        };
      },
    });

    mockToolExecutor.registerTool({
      info: {
        name: 'generate_style_document',
        description: 'Generate Editing Style Document from analysis results',
        category: 'analysis',
        riskLevel: 'low',
        supportsUndo: false,
        parallelizable: false,
      },
      parameters: {
        type: 'object',
        properties: {
          assetId: { type: 'string' },
          name: { type: 'string' },
        },
      },
      required: ['assetId'],
      executor: async (args) => {
        receivedArgs['generate_style_document'] = { ...args };
        // Verify assetId was resolved from step 1 (should be 'ref-asset-1', not an object)
        expect(typeof args.assetId).toBe('string');
        expect(args.assetId).toBe('ref-asset-1');
        return {
          success: true,
          data: {
            esdId: 'esd-uuid-1',
            name: 'Reference Style',
            tempoClassification: 'moderate',
            shotCount: 5,
            pacingPointCount: 5,
          },
          duration: 3000,
        };
      },
    });

    mockToolExecutor.registerTool({
      info: {
        name: 'apply_editing_style',
        description: 'Apply reference editing style to source footage with DTW-aligned cuts',
        category: 'editing',
        riskLevel: 'medium',
        supportsUndo: true,
        parallelizable: false,
      },
      parameters: {
        type: 'object',
        properties: {
          esdId: { type: 'string' },
          sourceAssetId: { type: 'string' },
        },
      },
      required: ['esdId', 'sourceAssetId'],
      executor: async (args) => {
        receivedArgs['apply_editing_style'] = { ...args };
        // Verify esdId was resolved from step 2 (should be 'esd-uuid-1', not an object)
        expect(typeof args.esdId).toBe('string');
        expect(args.esdId).toBe('esd-uuid-1');
        // Verify sourceAssetId is a literal (no step reference)
        expect(args.sourceAssetId).toBe('source-asset-1');
        return {
          success: true,
          data: {
            compatibilityScore: 0.82,
            stepsExecuted: 7,
            warnings: ['Source duration is 1.5x longer than reference'],
          },
          duration: 2000,
        };
      },
    });

    // Re-populate availableTools after re-registering
    agentContext.availableTools = mockToolExecutor.getAvailableTools().map((t) => t.name);

    mockLLMForPlaybook();

    const engine = createAgenticEngine(mockLLM, mockToolExecutor, {
      enableFastPath: false,
      enableTracing: true,
    });

    const events: AgentEvent[] = [];
    const result = await engine.run(
      'Apply the editing style from IU Concert.mp4 to My Footage.mp4',
      agentContext,
      executionContext,
      (event) => events.push(event),
    );

    // Verify success
    expect(result.success).toBe(true);

    // Verify all 3 tools were called with resolved args
    expect(receivedArgs['analyze_reference_video']).toBeDefined();
    expect(receivedArgs['analyze_reference_video'].assetId).toBe('ref-asset-1');

    expect(receivedArgs['generate_style_document']).toBeDefined();
    expect(receivedArgs['generate_style_document'].assetId).toBe('ref-asset-1');

    expect(receivedArgs['apply_editing_style']).toBeDefined();
    expect(receivedArgs['apply_editing_style'].esdId).toBe('esd-uuid-1');
    expect(receivedArgs['apply_editing_style'].sourceAssetId).toBe('source-asset-1');
  });
});
