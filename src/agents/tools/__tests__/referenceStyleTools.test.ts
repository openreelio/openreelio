/**
 * Integration tests for Reference Style Transfer agent tools.
 *
 * Verifies that the four reference-style tools (analyze_reference_video,
 * generate_style_document, compare_edit_structure, apply_editing_style) are
 * registered correctly and delegate to the right Tauri IPC commands with the
 * expected arguments.
 *
 * Mock strategy:
 * - @tauri-apps/api/core (invoke) is globally mocked by test/setup.ts
 * - All other modules (stores, registry) use real implementations
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { globalToolRegistry } from '@/agents';
import { initializeAgentSystem } from '@/stores/aiStore';
import { useProjectStore } from '@/stores/projectStore';
import type {
  AnalysisBundle,
  EditingStyleDocument,
  StylePlanResult,
  AgentPlanResult,
} from '@/bindings';

// ---------------------------------------------------------------------------
// Shared mock data factories
// ---------------------------------------------------------------------------

const mockedInvoke = invoke as ReturnType<typeof import('vitest').vi.fn>;

function makeAnalysisBundle(overrides: Partial<AnalysisBundle> = {}): AnalysisBundle {
  return {
    assetId: 'asset-ref-1',
    shots: [
      { startSec: 0, endSec: 2.5, confidence: 0.95 },
      { startSec: 2.5, endSec: 5.0, confidence: 0.92 },
      { startSec: 5.0, endSec: 8.0, confidence: 0.88 },
    ] as AnalysisBundle['shots'],
    transcript: null,
    audioProfile: {
      bpm: 120,
      spectralCentroidHz: 2000,
      loudnessProfile: [-18, -20, -15, -18, -22, -19, -17, -20],
      peakDb: -3,
      silenceRegions: [],
    },
    segments: [
      { startSec: 0, endSec: 5, segmentType: 'talk' as const, confidence: 0.85, features: null },
      {
        startSec: 5,
        endSec: 8,
        segmentType: 'performance' as const,
        confidence: 0.9,
        features: null,
      },
    ],
    frameAnalysis: null,
    metadata: {
      durationSec: 8.0,
      width: 1920,
      height: 1080,
      fps: 30,
      hasAudio: true,
      codec: 'h264',
    } as AnalysisBundle['metadata'],
    errors: {},
    analyzedAt: '2026-03-08T12:00:00Z',
    ...overrides,
  };
}

function makeEsd(overrides: Partial<EditingStyleDocument> = {}): EditingStyleDocument {
  return {
    id: 'esd-test-1',
    name: 'Test Style',
    sourceAssetId: 'asset-ref-1',
    createdAt: '2026-03-08T12:00:00Z',
    version: '1.0.0',
    rhythmProfile: {
      shotDurations: [2.5, 2.5, 3.0],
      meanDuration: 2.67,
      medianDuration: 2.5,
      stdDeviation: 0.24,
      minDuration: 2.5,
      maxDuration: 3.0,
      tempoClassification: 'moderate',
    },
    transitionInventory: {
      transitions: [],
      typeFrequency: { cut: 2 },
      dominantType: 'cut',
    },
    pacingCurve: [
      { normalizedPosition: 0.15, normalizedDuration: 0.83 },
      { normalizedPosition: 0.47, normalizedDuration: 0.83 },
      { normalizedPosition: 0.81, normalizedDuration: 1.0 },
    ],
    syncPoints: [],
    contentMap: [],
    cameraPatterns: [],
    ...overrides,
  } as EditingStyleDocument;
}

function makeStylePlanResult(overrides: Partial<StylePlanResult> = {}): StylePlanResult {
  return {
    plan: {
      id: 'plan-1',
      goal: 'Apply reference style to source',
      steps: [
        {
          id: 'step-1',
          toolName: 'split_clip',
          params: { clipId: 'c1', position: 2.5 },
          description: 'Split clip at 2.5s',
          riskLevel: 'low',
        },
        {
          id: 'step-2',
          toolName: 'split_clip',
          params: { clipId: 'c1', position: 5.0 },
          description: 'Split clip at 5.0s',
          riskLevel: 'low',
          dependsOn: ['step-1'],
        },
      ],
      approvalGranted: true,
    } as StylePlanResult['plan'],
    compatibilityScore: 0.85,
    warnings: [],
    ...overrides,
  };
}

function makeAgentPlanResult(overrides: Partial<AgentPlanResult> = {}): AgentPlanResult {
  return {
    planId: 'plan-1',
    success: true,
    totalSteps: 2,
    stepsCompleted: 2,
    stepResults: [],
    operationIds: ['op-1', 'op-2'],
    executionTimeMs: 150,
    errorMessage: null,
    rollbackReport: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe('Reference Style Transfer Tools', () => {
  beforeAll(() => {
    initializeAgentSystem();
  });

  beforeEach(() => {
    mockedInvoke.mockReset();
  });

  // =========================================================================
  // Registration
  // =========================================================================

  describe('Registration', () => {
    it('should register analyze_reference_video tool', () => {
      expect(globalToolRegistry.has('analyze_reference_video')).toBe(true);
      const tool = globalToolRegistry.get('analyze_reference_video');
      expect(tool).toBeDefined();
      expect(tool!.category).toBe('analysis');
    });

    it('should register generate_style_document tool', () => {
      expect(globalToolRegistry.has('generate_style_document')).toBe(true);
      const tool = globalToolRegistry.get('generate_style_document');
      expect(tool).toBeDefined();
      expect(tool!.category).toBe('analysis');
    });

    it('should register compare_edit_structure tool', () => {
      expect(globalToolRegistry.has('compare_edit_structure')).toBe(true);
      const tool = globalToolRegistry.get('compare_edit_structure');
      expect(tool).toBeDefined();
      expect(tool!.category).toBe('analysis');
    });

    it('should register apply_editing_style tool', () => {
      expect(globalToolRegistry.has('apply_editing_style')).toBe(true);
      const tool = globalToolRegistry.get('apply_editing_style');
      expect(tool).toBeDefined();
      expect(tool!.category).toBe('clip');
    });
  });

  // =========================================================================
  // analyze_reference_video
  // =========================================================================

  describe('analyze_reference_video', () => {
    it('should call analyze_video_full IPC with correct parameters', async () => {
      const bundle = makeAnalysisBundle();
      mockedInvoke.mockResolvedValueOnce(bundle);

      const result = await globalToolRegistry.execute('analyze_reference_video', {
        assetId: 'asset-ref-1',
      });

      expect(result.success).toBe(true);
      expect(mockedInvoke).toHaveBeenCalledWith('analyze_video_full', {
        assetId: 'asset-ref-1',
        options: expect.objectContaining({
          shots: true,
          transcript: true,
          audio: true,
          segments: true,
          visual: true,
        }),
      });
    });

    it('should return shot and segment counts from the analysis bundle', async () => {
      const bundle = makeAnalysisBundle();
      mockedInvoke.mockResolvedValueOnce(bundle);

      const result = await globalToolRegistry.execute('analyze_reference_video', {
        assetId: 'asset-ref-1',
      });

      expect(result.success).toBe(true);
      const data = result.result as Record<string, unknown>;
      expect(data.shotCount).toBe(3);
      expect(data.segmentCount).toBe(2);
      expect(data.hasAudioProfile).toBe(true);
      expect(data.hasTranscript).toBe(false);
      expect(data.errorCount).toBe(0);
    });

    it('should forward optional analysis flags', async () => {
      const bundle = makeAnalysisBundle();
      mockedInvoke.mockResolvedValueOnce(bundle);

      await globalToolRegistry.execute('analyze_reference_video', {
        assetId: 'asset-ref-1',
        shots: false,
        transcript: false,
        localOnly: true,
      });

      expect(mockedInvoke).toHaveBeenCalledWith('analyze_video_full', {
        assetId: 'asset-ref-1',
        options: expect.objectContaining({
          shots: false,
          transcript: false,
        }),
      });
    });

    it('should return error when assetId is missing', async () => {
      const result = await globalToolRegistry.execute('analyze_reference_video', {});

      expect(result.success).toBe(false);
      expect(result.error).toContain('assetId');
    });

    it('should return error when backend IPC fails', async () => {
      mockedInvoke.mockRejectedValueOnce(new Error('FFmpeg not found'));

      const result = await globalToolRegistry.execute('analyze_reference_video', {
        assetId: 'asset-ref-1',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('FFmpeg not found');
    });

    it('should report partial failures from the bundle errors field', async () => {
      const bundle = makeAnalysisBundle({
        errors: { visual: 'Vision API rate limit exceeded' },
      });
      mockedInvoke.mockResolvedValueOnce(bundle);

      const result = await globalToolRegistry.execute('analyze_reference_video', {
        assetId: 'asset-ref-1',
      });

      expect(result.success).toBe(true);
      const data = result.result as Record<string, unknown>;
      expect(data.errorCount).toBe(1);
      expect(data.summary as string).toContain('Partial failures: 1');
    });
  });

  // =========================================================================
  // generate_style_document
  // =========================================================================

  describe('generate_style_document', () => {
    it('should call list_esds, get_analysis_bundle, then generate_esd when no ESD exists yet', async () => {
      const bundle = makeAnalysisBundle();
      const esd = makeEsd();
      mockedInvoke
        .mockResolvedValueOnce([]) // list_esds
        .mockResolvedValueOnce(bundle) // get_analysis_bundle
        .mockResolvedValueOnce(esd); // generate_esd

      const result = await globalToolRegistry.execute('generate_style_document', {
        assetId: 'asset-ref-1',
      });

      expect(result.success).toBe(true);
      expect(mockedInvoke).toHaveBeenCalledWith('list_esds');
      expect(mockedInvoke).toHaveBeenCalledWith('get_analysis_bundle', {
        assetId: 'asset-ref-1',
      });
      expect(mockedInvoke).toHaveBeenCalledWith('generate_esd', {
        bundle: expect.objectContaining({ assetId: 'asset-ref-1' }),
      });
    });

    it('should return ESD summary with tempoClassification', async () => {
      const bundle = makeAnalysisBundle();
      const esd = makeEsd();
      mockedInvoke
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce(bundle)
        .mockResolvedValueOnce(esd);

      const result = await globalToolRegistry.execute('generate_style_document', {
        assetId: 'asset-ref-1',
      });

      expect(result.success).toBe(true);
      const data = result.result as Record<string, unknown>;
      expect(data.esdId).toBe('esd-test-1');
      expect(data.tempoClassification).toBe('moderate');
      expect(data.shotCount).toBe(3);
      expect(data.pacingPointCount).toBe(3);
      expect(data.analysisSource).toBe('cached');
    });

    it('should fall back to analyze_video_full when no cached bundle', async () => {
      const bundle = makeAnalysisBundle();
      const esd = makeEsd();
      mockedInvoke
        .mockResolvedValueOnce([]) // list_esds
        .mockResolvedValueOnce(null) // get_analysis_bundle returns null
        .mockResolvedValueOnce(bundle) // analyze_video_full fallback
        .mockResolvedValueOnce(esd); // generate_esd

      const result = await globalToolRegistry.execute('generate_style_document', {
        assetId: 'asset-ref-1',
      });

      expect(result.success).toBe(true);
      const data = result.result as Record<string, unknown>;
      expect(data.analysisSource).toBe('generated');
      expect(mockedInvoke).toHaveBeenCalledWith(
        'analyze_video_full',
        expect.objectContaining({ assetId: 'asset-ref-1' }),
      );
    });

    it('should reuse the latest existing ESD when one already exists for the asset', async () => {
      const esd = makeEsd({ id: 'esd-existing', name: 'Existing Style' });
      mockedInvoke
        .mockResolvedValueOnce([
          {
            id: 'esd-existing',
            name: 'Existing Style',
            sourceAssetId: 'asset-ref-1',
            createdAt: '2026-03-08T12:00:00Z',
            tempoClassification: 'moderate',
          },
        ])
        .mockResolvedValueOnce(esd);

      const result = await globalToolRegistry.execute('generate_style_document', {
        assetId: 'asset-ref-1',
      });

      expect(result.success).toBe(true);
      const data = result.result as Record<string, unknown>;
      expect(data.esdId).toBe('esd-existing');
      expect(data.analysisSource).toBe('existing_esd');
      expect(mockedInvoke).toHaveBeenCalledWith('list_esds');
      expect(mockedInvoke).toHaveBeenCalledWith('get_esd', { esdId: 'esd-existing' });
      expect(mockedInvoke).toHaveBeenCalledTimes(2);
    });

    it('should return error when assetId is missing', async () => {
      const result = await globalToolRegistry.execute('generate_style_document', {});

      expect(result.success).toBe(false);
      expect(result.error).toContain('assetId');
    });

    it('should return error when generate_esd IPC fails', async () => {
      const bundle = makeAnalysisBundle();
      mockedInvoke
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce(bundle)
        .mockRejectedValueOnce(new Error('ESD generation failed: insufficient data'));

      const result = await globalToolRegistry.execute('generate_style_document', {
        assetId: 'asset-ref-1',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('ESD generation failed: insufficient data');
    });
  });

  // =========================================================================
  // compare_edit_structure
  // =========================================================================

  describe('compare_edit_structure', () => {
    it('should call get_esd IPC and compute correlation', async () => {
      const esd = makeEsd();
      mockedInvoke.mockResolvedValueOnce(esd);

      // Set up projectStore with an active sequence containing clips.
      // sequences is a Map<string, Sequence>, and Clip uses place/range shapes.
      const defaultAudio = { volumeDb: 0, pan: 0, muted: false };
      const defaultTransform = {
        position: { x: 0, y: 0 },
        scale: { x: 1, y: 1 },
        rotationDeg: 0,
        anchor: { x: 0.5, y: 0.5 },
      };
      const sequences = new Map();
      sequences.set('seq-1', {
        id: 'seq-1',
        name: 'Main Sequence',
        format: {
          canvas: { width: 1920, height: 1080 },
          fps: { num: 30, den: 1 },
          audioSampleRate: 48000,
          audioChannels: 2,
        },
        markers: [],
        tracks: [
          {
            id: 'track-v1',
            kind: 'video',
            name: 'V1',
            visible: true,
            locked: false,
            muted: false,
            volume: 1.0,
            blendMode: 'normal',
            clips: [
              {
                id: 'clip-1',
                assetId: 'src-1',
                place: { timelineInSec: 0, durationSec: 2.5 },
                range: { sourceInSec: 0, sourceOutSec: 2.5 },
                transform: defaultTransform,
                opacity: 1,
                speed: 1.0,
                effects: [],
                audio: defaultAudio,
              },
              {
                id: 'clip-2',
                assetId: 'src-1',
                place: { timelineInSec: 2.5, durationSec: 2.5 },
                range: { sourceInSec: 2.5, sourceOutSec: 5.0 },
                transform: defaultTransform,
                opacity: 1,
                speed: 1.0,
                effects: [],
                audio: defaultAudio,
              },
              {
                id: 'clip-3',
                assetId: 'src-1',
                place: { timelineInSec: 5.0, durationSec: 3.0 },
                range: { sourceInSec: 5.0, sourceOutSec: 8.0 },
                transform: defaultTransform,
                opacity: 1,
                speed: 1.0,
                effects: [],
                audio: defaultAudio,
              },
            ],
          },
        ],
      });
      useProjectStore.setState({ activeSequenceId: 'seq-1', sequences });

      const result = await globalToolRegistry.execute('compare_edit_structure', {
        esdId: 'esd-test-1',
      });

      expect(result.success).toBe(true);
      expect(mockedInvoke).toHaveBeenCalledWith('get_esd', { esdId: 'esd-test-1' });
      const data = result.result as Record<string, unknown>;
      expect(data.esdId).toBe('esd-test-1');
      expect(data.referenceShots).toBe(3);
      expect(data.outputShots).toBe(3);
      expect(typeof data.correlation).toBe('number');
      expect(typeof data.correlationPercent).toBe('string');
    });

    it('should return error when ESD is not found', async () => {
      mockedInvoke.mockResolvedValueOnce(null);

      const result = await globalToolRegistry.execute('compare_edit_structure', {
        esdId: 'nonexistent',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('ESD not found');
    });

    it('should return error when no active timeline exists', async () => {
      const esd = makeEsd();
      mockedInvoke.mockResolvedValueOnce(esd);

      // Clear active sequence
      useProjectStore.setState({
        activeSequenceId: null,
        sequences: new Map(),
      });

      const result = await globalToolRegistry.execute('compare_edit_structure', {
        esdId: 'esd-test-1',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('No active timeline');
    });

    it('should return error when esdId is missing', async () => {
      const result = await globalToolRegistry.execute('compare_edit_structure', {});

      expect(result.success).toBe(false);
      expect(result.error).toContain('esdId');
    });
  });

  // =========================================================================
  // apply_editing_style
  // =========================================================================

  describe('apply_editing_style', () => {
    it('should call apply_editing_style and execute_agent_plan IPC commands', async () => {
      const stylePlan = makeStylePlanResult();
      const planResult = makeAgentPlanResult();
      mockedInvoke
        .mockResolvedValueOnce(stylePlan) // apply_editing_style
        .mockResolvedValueOnce(planResult) // execute_agent_plan
        .mockResolvedValue({}); // refreshProjectState calls

      const result = await globalToolRegistry.execute('apply_editing_style', {
        esdId: 'esd-test-1',
        sourceAssetId: 'source-1',
      });

      expect(result.success).toBe(true);
      expect(mockedInvoke).toHaveBeenCalledWith('apply_editing_style', {
        esdId: 'esd-test-1',
        sourceAssetId: 'source-1',
      });
      expect(mockedInvoke).toHaveBeenCalledWith('execute_agent_plan', {
        plan: stylePlan.plan,
      });
    });

    it('should return compatibilityScore and step counts', async () => {
      const stylePlan = makeStylePlanResult({ compatibilityScore: 0.92 });
      const planResult = makeAgentPlanResult({ stepsCompleted: 2, totalSteps: 2 });
      mockedInvoke
        .mockResolvedValueOnce(stylePlan)
        .mockResolvedValueOnce(planResult)
        .mockResolvedValue({});

      const result = await globalToolRegistry.execute('apply_editing_style', {
        esdId: 'esd-test-1',
        sourceAssetId: 'source-1',
      });

      expect(result.success).toBe(true);
      const data = result.result as Record<string, unknown>;
      expect(data.compatibilityScore).toBe(0.92);
      expect(data.planStepCount).toBe(2);
      expect(data.stepsCompleted).toBe(2);
      expect(data.operationIds).toEqual(['op-1', 'op-2']);
    });

    it('should return error when plan execution fails', async () => {
      const stylePlan = makeStylePlanResult();
      const failedResult = makeAgentPlanResult({
        success: false,
        stepsCompleted: 1,
        errorMessage: 'Clip not found for split',
      });
      mockedInvoke.mockResolvedValueOnce(stylePlan).mockResolvedValueOnce(failedResult);

      const result = await globalToolRegistry.execute('apply_editing_style', {
        esdId: 'esd-test-1',
        sourceAssetId: 'source-1',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Clip not found for split');
    });

    it('should include warnings from the style plan result', async () => {
      const stylePlan = makeStylePlanResult({
        warnings: ['Source is 30% shorter than reference'],
      });
      const planResult = makeAgentPlanResult();
      mockedInvoke
        .mockResolvedValueOnce(stylePlan)
        .mockResolvedValueOnce(planResult)
        .mockResolvedValue({});

      const result = await globalToolRegistry.execute('apply_editing_style', {
        esdId: 'esd-test-1',
        sourceAssetId: 'source-1',
      });

      expect(result.success).toBe(true);
      const data = result.result as Record<string, unknown>;
      expect(data.warnings).toEqual(['Source is 30% shorter than reference']);
      expect(data.summary as string).toContain('Warnings');
    });

    it('should return error when esdId is missing', async () => {
      const result = await globalToolRegistry.execute('apply_editing_style', {
        sourceAssetId: 'source-1',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('esdId');
    });

    it('should return error when sourceAssetId is missing', async () => {
      const result = await globalToolRegistry.execute('apply_editing_style', {
        esdId: 'esd-test-1',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('sourceAssetId');
    });

    it('should return error when backend IPC fails', async () => {
      mockedInvoke.mockRejectedValueOnce(new Error('ESD not found in storage'));

      const result = await globalToolRegistry.execute('apply_editing_style', {
        esdId: 'esd-test-1',
        sourceAssetId: 'source-1',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('ESD not found in storage');
    });
  });
});
