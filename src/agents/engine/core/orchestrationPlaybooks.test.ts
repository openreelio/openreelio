import { describe, expect, it } from 'vitest';
import { createEmptyContext, type AgentContext, type Thought } from './types';
import { buildOrchestrationPlaybook } from './orchestrationPlaybooks';
import type { IToolExecutor } from '../ports/IToolExecutor';
import type { ValidationResult } from './types';

function createToolExecutor(toolNames: string[]): IToolExecutor {
  const hasTool = (name: string): boolean => toolNames.includes(name);

  return {
    execute: async () => ({ success: true, duration: 1, undoable: false }),
    executeBatch: async () => ({
      success: true,
      results: [],
      totalDuration: 1,
      successCount: 0,
      failureCount: 0,
    }),
    getAvailableTools: () =>
      toolNames.map((name) => ({
        name,
        description: name,
        category: 'utility',
        riskLevel: 'low',
        supportsUndo: false,
        parallelizable: false,
      })),
    getToolDefinition: () => null,
    validateArgs: (): ValidationResult => ({ valid: true, errors: [] }),
    hasTool,
    getToolsByCategory: () => new Map(),
    getToolsByRisk: () => [],
  };
}

function createContext(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    ...createEmptyContext('project-1'),
    sequenceId: 'sequence-1',
    playheadPosition: 12,
    timelineDuration: 90,
    availableTracks: [
      {
        id: 'track-video-1',
        name: 'Video 1',
        type: 'video',
        clipCount: 0,
      },
      {
        id: 'track-audio-1',
        name: 'Audio 1',
        type: 'audio',
        clipCount: 0,
      },
    ],
    availableAssets: [
      {
        id: 'asset-video-fallback',
        name: 'broll.mp4',
        type: 'video',
        duration: 8,
      },
      {
        id: 'asset-audio-fallback',
        name: 'bed.mp3',
        type: 'audio',
        duration: 30,
      },
    ],
    ...overrides,
  };
}

describe('buildOrchestrationPlaybook', () => {
  it('creates B-roll/music/subtitles playbook with step references', () => {
    const thought: Thought = {
      understanding: 'Please add B-roll with background music and subtitles',
      requirements: ['B-roll', 'music', 'subtitles'],
      uncertainties: [],
      approach: 'Use one orchestration flow',
      needsMoreInfo: false,
    };

    const toolExecutor = createToolExecutor([
      'get_unused_assets',
      'insert_clip',
      'add_caption',
      'adjust_volume',
    ]);
    const match = buildOrchestrationPlaybook(thought, createContext(), toolExecutor);

    expect(match).not.toBeNull();
    expect(match?.id).toBe('broll_music_subtitles');
    expect(match?.plan.steps.map((step) => step.id)).toContain('playbook_insert_broll_clip');

    const insertBrollStep = match?.plan.steps.find(
      (step) => step.id === 'playbook_insert_broll_clip',
    );
    expect(insertBrollStep?.args.assetId).toMatchObject({
      $fromStep: 'playbook_get_unused_video',
      $path: 'data[0].id',
      $default: 'asset-video-fallback',
    });
  });

  it('creates generate-and-place playbook with approval requirement', () => {
    const thought: Thought = {
      understanding: 'Generate a video and insert it on timeline at playhead',
      requirements: ['ai generation', 'timeline insertion'],
      uncertainties: [],
      approach: 'Generate then place',
      needsMoreInfo: false,
    };

    const toolExecutor = createToolExecutor([
      'generate_video',
      'check_generation_status',
      'insert_clip',
    ]);
    const match = buildOrchestrationPlaybook(thought, createContext(), toolExecutor);

    expect(match).not.toBeNull();
    expect(match?.id).toBe('generate_and_place');
    expect(match?.plan.requiresApproval).toBe(true);

    const statusStep = match?.plan.steps.find(
      (step) => step.id === 'playbook_check_generation_status',
    );
    expect(statusStep?.args.jobId).toMatchObject({
      $fromStep: 'playbook_generate_video',
      $path: 'data.jobId',
    });
  });

  it('returns null when required tracks/tools are missing', () => {
    const thought: Thought = {
      understanding: 'Add B-roll, music, and subtitles',
      requirements: [],
      uncertainties: [],
      approach: 'Orchestrate',
      needsMoreInfo: false,
    };

    const context = createContext({
      availableTracks: [],
    });
    const toolExecutor = createToolExecutor(['get_unused_assets', 'insert_clip', 'add_caption']);
    const match = buildOrchestrationPlaybook(thought, context, toolExecutor);

    expect(match).toBeNull();
  });

  it('should match stock media search playbook for "find stock footage"', () => {
    const thought: Thought = {
      understanding: 'Find stock footage of nature landscapes',
      requirements: ['stock footage', 'nature'],
      uncertainties: [],
      approach: 'Search stock media references',
      needsMoreInfo: false,
    };

    const toolExecutor = createToolExecutor(['search_stock_media']);
    const match = buildOrchestrationPlaybook(thought, createContext(), toolExecutor);

    expect(match).not.toBeNull();
    expect(match?.id).toBe('stock_media_search');
    expect(match?.confidence).toBe(0.84);
    expect(match?.plan.steps).toHaveLength(1);
    expect(match?.plan.steps[0].tool).toBe('search_stock_media');
  });

  it('should not auto-match stock media search for "add b-roll" without explicit search intent', () => {
    const thought: Thought = {
      understanding: 'Add b-roll of city skyline',
      requirements: ['b-roll'],
      uncertainties: [],
      approach: 'Search and add b-roll footage of city skyline',
      needsMoreInfo: false,
    };

    const toolExecutor = createToolExecutor(['search_stock_media']);
    const match = buildOrchestrationPlaybook(thought, createContext(), toolExecutor);

    expect(match).toBeNull();
  });

  it('should return a search-only playbook for stock media discovery', () => {
    const thought: Thought = {
      understanding: 'Search for stock video of ocean waves',
      requirements: ['stock video'],
      uncertainties: [],
      approach: 'Find stock footage of ocean waves',
      needsMoreInfo: false,
    };

    const toolExecutor = createToolExecutor(['search_stock_media']);
    const match = buildOrchestrationPlaybook(thought, createContext(), toolExecutor);

    expect(match).not.toBeNull();
    expect(match?.id).toBe('stock_media_search');
    expect(match?.plan.goal).toContain('Find stock video references');
    expect(match?.plan.rollbackStrategy).toContain('No timeline changes');
  });

  it('should not match stock media playbook when search_stock_media tool is missing', () => {
    const thought: Thought = {
      understanding: 'Find stock footage of nature',
      requirements: ['stock footage'],
      uncertainties: [],
      approach: 'Search and insert',
      needsMoreInfo: false,
    };

    const toolExecutor = createToolExecutor(['insert_clip']);
    const match = buildOrchestrationPlaybook(thought, createContext(), toolExecutor);

    expect(match?.id).not.toBe('stock_media_search');
  });

  it('should not match generate_and_place when intent is captioning (English)', () => {
    const thought: Thought = {
      understanding: 'Create captions for the video on the timeline',
      requirements: ['captions', 'transcription'],
      uncertainties: [],
      approach: 'Transcribe audio and add subtitle clips',
      needsMoreInfo: false,
    };

    const toolExecutor = createToolExecutor([
      'generate_video',
      'check_generation_status',
      'insert_clip',
      'auto_transcribe',
      'add_captions_from_transcription',
    ]);
    const match = buildOrchestrationPlaybook(thought, createContext(), toolExecutor);

    // "Create" + "video" + "timeline" triggers generate_and_place keywords,
    // but requirements are within caption scope → should yield to auto_caption
    expect(match?.id).not.toBe('generate_and_place');
    expect(match?.id).toBe('auto_caption');
  });

  it('should not match generate_and_place when intent is captioning (Korean)', () => {
    const thought: Thought = {
      understanding: '이 영상에 자막을 만들어서 추가해줘',
      requirements: ['자막 생성', '음성 인식'],
      uncertainties: [],
      approach: '음성 인식 후 자막 추가',
      needsMoreInfo: false,
    };

    const toolExecutor = createToolExecutor([
      'generate_video',
      'check_generation_status',
      'insert_clip',
      'auto_transcribe',
      'add_captions_from_transcription',
    ]);
    const match = buildOrchestrationPlaybook(thought, createContext(), toolExecutor);

    expect(match?.id).not.toBe('generate_and_place');
    expect(match?.id).toBe('auto_caption');
  });

  it('should still match generate_and_place when requirements indicate generation', () => {
    const thought: Thought = {
      understanding: 'Create an AI-generated video clip and place it on the timeline',
      requirements: ['ai video generation', 'timeline insertion'],
      uncertainties: [],
      approach: 'Generate then place',
      needsMoreInfo: false,
    };

    const toolExecutor = createToolExecutor([
      'generate_video',
      'check_generation_status',
      'insert_clip',
    ]);
    const match = buildOrchestrationPlaybook(thought, createContext(), toolExecutor);

    expect(match?.id).toBe('generate_and_place');
  });

  it('should match auto-caption playbook for "add captions"', () => {
    const thought: Thought = {
      understanding: 'Add captions to the timeline',
      requirements: ['captions', 'transcription'],
      uncertainties: [],
      approach: 'Auto-caption using speech-to-text',
      needsMoreInfo: false,
    };

    const toolExecutor = createToolExecutor(['auto_transcribe', 'add_captions_from_transcription']);
    const match = buildOrchestrationPlaybook(thought, createContext(), toolExecutor);

    expect(match).not.toBeNull();
    expect(match?.id).toBe('auto_caption');
    expect(match?.confidence).toBe(0.91);
    expect(match?.plan.steps).toHaveLength(2);
    expect(match?.plan.steps[0].tool).toBe('auto_transcribe');
    expect(match?.plan.steps[1].tool).toBe('add_captions_from_transcription');
  });

  it('should chain auto-caption steps with step references for segments', () => {
    const thought: Thought = {
      understanding: 'Generate subtitles for this video',
      requirements: ['subtitles'],
      uncertainties: [],
      approach: 'Transcribe audio then create subtitle clips',
      needsMoreInfo: false,
    };

    const toolExecutor = createToolExecutor(['auto_transcribe', 'add_captions_from_transcription']);
    const match = buildOrchestrationPlaybook(thought, createContext(), toolExecutor);

    expect(match).not.toBeNull();

    const captionStep = match?.plan.steps.find((step) => step.id === 'playbook_add_captions');
    expect(captionStep?.args.segments).toMatchObject({
      $fromStep: 'playbook_auto_transcribe',
      $path: 'data.segments',
    });
    expect(captionStep?.dependsOn).toContain('playbook_auto_transcribe');
  });

  it('should match auto-caption for "auto-caption" keyword', () => {
    const thought: Thought = {
      understanding: 'Auto-caption this clip',
      requirements: ['auto-caption'],
      uncertainties: [],
      approach: 'Use auto-captioning',
      needsMoreInfo: false,
    };

    const toolExecutor = createToolExecutor(['auto_transcribe', 'add_captions_from_transcription']);
    const match = buildOrchestrationPlaybook(thought, createContext(), toolExecutor);

    expect(match).not.toBeNull();
    expect(match?.id).toBe('auto_caption');
  });

  it('should not match auto-caption when tools are missing', () => {
    const thought: Thought = {
      understanding: 'Add captions to the timeline',
      requirements: ['captions'],
      uncertainties: [],
      approach: 'Transcribe and add',
      needsMoreInfo: false,
    };

    const toolExecutor = createToolExecutor(['add_caption']);
    const match = buildOrchestrationPlaybook(thought, createContext(), toolExecutor);

    expect(match?.id).not.toBe('auto_caption');
  });

  it('should not match auto-caption when requirements go beyond captioning scope', () => {
    const thought: Thought = {
      understanding: 'Analyze lyrics from audio and visual content on the timeline',
      requirements: ['transcription', 'visual frame analysis', 'on-screen text detection'],
      uncertainties: [],
      approach: 'Transcribe audio via speech-to-text and detect on-screen text via OCR',
      needsMoreInfo: false,
    };

    const toolExecutor = createToolExecutor(['auto_transcribe', 'add_captions_from_transcription']);
    const match = buildOrchestrationPlaybook(thought, createContext(), toolExecutor);

    // "visual frame analysis" and "on-screen text detection" are outside caption
    // scope, so the playbook should yield to let the LLM plan a multi-modal approach
    expect(match?.id).not.toBe('auto_caption');
  });

  it('should not match auto-caption when requirements include non-captioning analysis', () => {
    const thought: Thought = {
      understanding: 'Identify what is being said and shown in this video',
      requirements: ['speech-to-text transcription', 'shot boundary detection', 'object recognition'],
      uncertainties: [],
      approach: 'Run multi-modal analysis pipeline',
      needsMoreInfo: false,
    };

    const toolExecutor = createToolExecutor(['auto_transcribe', 'add_captions_from_transcription']);
    const match = buildOrchestrationPlaybook(thought, createContext(), toolExecutor);

    // "shot boundary detection" and "object recognition" are beyond caption scope
    expect(match?.id).not.toBe('auto_caption');
  });

  it('should still match auto-caption when all requirements are within caption scope', () => {
    const thought: Thought = {
      understanding: 'Transcribe the audio and add subtitles',
      requirements: ['audio transcription', 'subtitle creation'],
      uncertainties: [],
      approach: 'Speech-to-text then add caption clips',
      needsMoreInfo: false,
    };

    const toolExecutor = createToolExecutor(['auto_transcribe', 'add_captions_from_transcription']);
    const match = buildOrchestrationPlaybook(thought, createContext(), toolExecutor);

    // Both requirements match caption scope patterns, so playbook should match
    expect(match?.id).toBe('auto_caption');
  });

  it('should match music bed playbook for "add background music"', () => {
    const thought: Thought = {
      understanding: 'Add background music to the timeline',
      requirements: ['background music'],
      uncertainties: [],
      approach: 'Insert music bed and adjust volume',
      needsMoreInfo: false,
    };

    const toolExecutor = createToolExecutor(['get_unused_assets', 'insert_clip', 'adjust_volume']);
    const match = buildOrchestrationPlaybook(thought, createContext(), toolExecutor);

    expect(match).not.toBeNull();
    expect(match?.id).toBe('music_bed');
    expect(match?.confidence).toBe(0.89);
    expect(match?.plan.steps).toHaveLength(3);
    expect(match?.plan.steps[0].tool).toBe('get_unused_assets');
    expect(match?.plan.steps[1].tool).toBe('insert_clip');
    expect(match?.plan.steps[2].tool).toBe('adjust_volume');
  });

  it('should set music bed volume to background level', () => {
    const thought: Thought = {
      understanding: 'Add music bed',
      requirements: ['music'],
      uncertainties: [],
      approach: 'Insert music bed audio',
      needsMoreInfo: false,
    };

    const toolExecutor = createToolExecutor(['get_unused_assets', 'insert_clip', 'adjust_volume']);
    const match = buildOrchestrationPlaybook(thought, createContext(), toolExecutor);

    expect(match).not.toBeNull();
    const volumeStep = match?.plan.steps.find((step) => step.id === 'playbook_set_volume');
    expect(volumeStep?.args.volume).toBe(25);
    expect(volumeStep?.args.clipId).toMatchObject({
      $fromStep: 'playbook_insert_music',
      $path: 'data.clipId',
    });
    expect(volumeStep?.dependsOn).toContain('playbook_insert_music');
  });

  it('should duck only the inserted music clip in the combined b-roll playbook', () => {
    const thought: Thought = {
      understanding: 'Add b-roll with background music and subtitles',
      requirements: ['b-roll', 'music', 'subtitles'],
      uncertainties: [],
      approach: 'Full orchestration',
      needsMoreInfo: false,
    };

    const toolExecutor = createToolExecutor([
      'get_unused_assets',
      'insert_clip',
      'add_caption',
      'adjust_volume',
    ]);
    const match = buildOrchestrationPlaybook(thought, createContext(), toolExecutor);

    const duckStep = match?.plan.steps.find((step) => step.id === 'playbook_duck_music_bed');
    expect(duckStep?.args.clipId).toMatchObject({
      $fromStep: 'playbook_insert_music_bed',
      $path: 'data.clipId',
    });
  });

  it('should not match music bed when no audio track available', () => {
    const thought: Thought = {
      understanding: 'Add background music',
      requirements: ['background music'],
      uncertainties: [],
      approach: 'Insert music',
      needsMoreInfo: false,
    };

    const context = createContext({
      availableTracks: [{ id: 'track-video-1', name: 'Video 1', type: 'video', clipCount: 0 }],
      availableAssets: [],
    });
    const toolExecutor = createToolExecutor(['get_unused_assets', 'insert_clip', 'adjust_volume']);
    const match = buildOrchestrationPlaybook(thought, context, toolExecutor);

    expect(match?.id).not.toBe('music_bed');
  });

  it('should prefer broll_music_subtitles over stock_media when all three keywords match', () => {
    const thought: Thought = {
      understanding: 'Add stock b-roll with background music and subtitles',
      requirements: ['b-roll', 'music', 'subtitles'],
      uncertainties: [],
      approach: 'Full orchestration',
      needsMoreInfo: false,
    };

    const toolExecutor = createToolExecutor([
      'search_stock_media',
      'get_unused_assets',
      'insert_clip',
      'add_caption',
      'adjust_volume',
    ]);
    const match = buildOrchestrationPlaybook(thought, createContext(), toolExecutor);

    expect(match).not.toBeNull();
    expect(match?.id).toBe('broll_music_subtitles');
  });
});

describe('reference_style_transfer playbook', () => {
  it('should match "edit like" trigger phrase', () => {
    const thought: Thought = {
      understanding: 'Edit like this reference video',
      requirements: ['style transfer'],
      uncertainties: [],
      approach: 'Analyze reference and apply editing style',
      needsMoreInfo: false,
    };

    const toolExecutor = createToolExecutor([
      'analyze_reference_video',
      'generate_style_document',
      'apply_editing_style',
    ]);
    const match = buildOrchestrationPlaybook(thought, createContext(), toolExecutor);

    expect(match).not.toBeNull();
    expect(match?.id).toBe('reference_style_transfer');
    expect(match?.confidence).toBe(0.88);
  });

  it('should match "match the style" trigger phrase', () => {
    const thought: Thought = {
      understanding: 'Match the style of the concert video',
      requirements: ['style matching'],
      uncertainties: [],
      approach: 'Apply reference editing style',
      needsMoreInfo: false,
    };

    const toolExecutor = createToolExecutor([
      'analyze_reference_video',
      'generate_style_document',
      'apply_editing_style',
    ]);
    const match = buildOrchestrationPlaybook(thought, createContext(), toolExecutor);

    expect(match).not.toBeNull();
    expect(match?.id).toBe('reference_style_transfer');
    expect(match?.confidence).toBe(0.88);
  });

  it('should match Korean trigger "편집 스타일"', () => {
    const thought: Thought = {
      understanding: '이 영상의 편집 스타일을 적용해 주세요',
      requirements: ['편집 스타일'],
      uncertainties: [],
      approach: '참조 영상 분석 후 스타일 적용',
      needsMoreInfo: false,
    };

    const toolExecutor = createToolExecutor([
      'analyze_reference_video',
      'generate_style_document',
      'apply_editing_style',
    ]);
    const match = buildOrchestrationPlaybook(thought, createContext(), toolExecutor);

    expect(match).not.toBeNull();
    expect(match?.id).toBe('reference_style_transfer');
  });

  it('should create 3-step chain with correct dependencies', () => {
    const thought: Thought = {
      understanding: 'Apply editing style from the reference clip',
      requirements: ['style transfer'],
      uncertainties: [],
      approach: 'Analyze and transfer editing style',
      needsMoreInfo: false,
    };

    const toolExecutor = createToolExecutor([
      'analyze_reference_video',
      'generate_style_document',
      'apply_editing_style',
    ]);
    const match = buildOrchestrationPlaybook(thought, createContext(), toolExecutor);

    expect(match).not.toBeNull();
    expect(match?.plan.steps).toHaveLength(3);

    // Step 1: analyze_reference_video (no dependencies)
    const analyzeStep = match?.plan.steps[0];
    expect(analyzeStep?.id).toBe('playbook_analyze_reference');
    expect(analyzeStep?.tool).toBe('analyze_reference_video');
    expect(analyzeStep?.dependsOn).toBeUndefined();

    // Step 2: generate_style_document (depends on step 1)
    const generateStep = match?.plan.steps[1];
    expect(generateStep?.id).toBe('playbook_generate_esd');
    expect(generateStep?.tool).toBe('generate_style_document');
    expect(generateStep?.dependsOn).toContain('playbook_analyze_reference');
    expect(generateStep?.args.assetId).toMatchObject({
      $fromStep: 'playbook_analyze_reference',
      $path: 'data.assetId',
      $default: 'asset-video-fallback',
    });

    // Step 3: apply_editing_style (depends on step 2)
    const applyStep = match?.plan.steps[2];
    expect(applyStep?.id).toBe('playbook_apply_style');
    expect(applyStep?.tool).toBe('apply_editing_style');
    expect(applyStep?.dependsOn).toContain('playbook_generate_esd');
    expect(applyStep?.args.esdId).toMatchObject({
      $fromStep: 'playbook_generate_esd',
      $path: 'data.esdId',
      $default: '',
    });
  });

  it('should choose reference and source assets from prompt mentions when both are named', () => {
    const thought: Thought = {
      understanding: 'Apply editing from Source Montage.mp4 to Summer Concert.mp4',
      requirements: ['style transfer'],
      uncertainties: [],
      approach: 'Transfer the pacing from Source Montage.mp4 onto Summer Concert.mp4',
      needsMoreInfo: false,
    };

    const context = createContext({
      availableAssets: [
        { id: 'asset-source', name: 'Summer Concert.mp4', type: 'video', duration: 180 },
        { id: 'asset-reference', name: 'Source Montage.mp4', type: 'video', duration: 45 },
      ],
    });
    const toolExecutor = createToolExecutor([
      'analyze_reference_video',
      'generate_style_document',
      'apply_editing_style',
    ]);

    const match = buildOrchestrationPlaybook(thought, context, toolExecutor);

    expect(match).not.toBeNull();
    const analyzeStep = match?.plan.steps[0];
    const applyStep = match?.plan.steps.at(-1);
    expect(analyzeStep?.args.assetId).toBe('asset-reference');
    expect(applyStep?.args.sourceAssetId).toBe('asset-source');
  });

  it('should reuse the latest style document for last-analysis prompts', () => {
    const thought: Thought = {
      understanding: 'Apply the editing style from my last analysis to My Footage.mp4',
      requirements: ['style transfer', 'last analysis'],
      uncertainties: [],
      approach: 'Reuse the previous ESD and apply it to the source footage',
      needsMoreInfo: false,
    };

    const context = createContext({
      availableAssets: [
        { id: 'asset-reference', name: 'Reference Cut.mp4', type: 'video', duration: 60 },
        { id: 'asset-source', name: 'My Footage.mp4', type: 'video', duration: 90 },
      ],
    });
    const toolExecutor = createToolExecutor([
      'analyze_reference_video',
      'generate_style_document',
      'apply_editing_style',
    ]);

    const match = buildOrchestrationPlaybook(thought, context, toolExecutor);

    expect(match).not.toBeNull();
    expect(match?.id).toBe('reference_style_transfer');
    expect(match?.plan.steps).toHaveLength(2);
    expect(match?.plan.steps[0].tool).toBe('generate_style_document');
    expect(match?.plan.steps[0].id).toBe('playbook_generate_esd');
    expect(match?.plan.steps[1].tool).toBe('apply_editing_style');
    expect(match?.plan.steps[1].dependsOn).toContain('playbook_generate_esd');
    expect(match?.plan.steps.some((step) => step.tool === 'analyze_reference_video')).toBe(false);
  });

  it('should match "same editing as" and "apply editing from" trigger phrases', () => {
    const toolExecutor = createToolExecutor([
      'analyze_reference_video',
      'generate_style_document',
      'apply_editing_style',
    ]);

    const sameEditingThought: Thought = {
      understanding: 'Use the same editing as the trailer reference',
      requirements: ['style transfer'],
      uncertainties: [],
      approach: 'Transfer the reference pacing and transitions',
      needsMoreInfo: false,
    };
    const applyEditingThought: Thought = {
      understanding: 'Apply editing from the concert reference to my footage',
      requirements: ['style transfer'],
      uncertainties: [],
      approach: 'Analyze the reference and apply it',
      needsMoreInfo: false,
    };

    expect(buildOrchestrationPlaybook(sameEditingThought, createContext(), toolExecutor)?.id).toBe(
      'reference_style_transfer',
    );
    expect(buildOrchestrationPlaybook(applyEditingThought, createContext(), toolExecutor)?.id).toBe(
      'reference_style_transfer',
    );
  });

  it('should not match unrelated queries', () => {
    const thought: Thought = {
      understanding: 'Trim the clip at 5 seconds',
      requirements: ['trim'],
      uncertainties: [],
      approach: 'Split and remove',
      needsMoreInfo: false,
    };

    const toolExecutor = createToolExecutor([
      'analyze_reference_video',
      'generate_style_document',
      'apply_editing_style',
    ]);
    const match = buildOrchestrationPlaybook(thought, createContext(), toolExecutor);

    expect(match).toBeNull();
  });

  it('should not match when required tools are unavailable', () => {
    const thought: Thought = {
      understanding: 'Edit like this reference video',
      requirements: ['style transfer'],
      uncertainties: [],
      approach: 'Analyze reference and apply editing style',
      needsMoreInfo: false,
    };

    const toolExecutor = createToolExecutor(['insert_clip', 'adjust_volume']);
    const match = buildOrchestrationPlaybook(thought, createContext(), toolExecutor);

    expect(match).toBeNull();
  });
});
