/**
 * Agent Test Harness
 *
 * A diagnostic tool for testing agent behavior from the command line.
 * Designed for use by Claude Code (or any external agent) to reproduce
 * QA issues, verify fixes, and run regression scenarios.
 *
 * Modes (set via HARNESS_MODE env var):
 *   playbook  - Test which orchestration playbook matches a given Thought
 *   tools     - Inspect registered tools and check availability
 *   tool-exec - Execute a specific tool with mock backend
 *   scenarios - Run all pre-defined QA regression scenarios
 *
 * Usage:
 *   ./scripts/agent-harness/cli.sh playbook '{"understanding":"...","requirements":[...],"approach":"..."}'
 *   ./scripts/agent-harness/cli.sh tools
 *   ./scripts/agent-harness/cli.sh tool-exec auto_transcribe '{"assetId":"test"}'
 *   ./scripts/agent-harness/cli.sh scenarios
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { buildOrchestrationPlaybook } from '@/agents/engine/core/orchestrationPlaybooks';
import { createEmptyContext } from '@/agents/engine/core/types';
import type { Thought, AgentContext } from '@/agents/engine/core/types';
import type { IToolExecutor } from '@/agents/engine/ports/IToolExecutor';
import type {
  ToolInfo,
  ToolExecutionResult,
  BatchExecutionResult,
  ValidationResult,
} from '@/agents/engine/ports/IToolExecutor';
import type { RiskLevel } from '@/agents/engine/core/types';
import { globalToolRegistry } from '@/agents/ToolRegistry';
import { registerCaptionTools, unregisterCaptionTools } from '@/agents/tools/captionTools';
import { registerMediaAnalysisTools } from '@/agents/tools/mediaAnalysisTools';
import { registerAnalysisTools } from '@/agents/tools/analysisTools';

// =============================================================================
// Environment Configuration
// =============================================================================

const HARNESS_MODE = process.env.HARNESS_MODE ?? 'scenarios';
const HARNESS_INPUT = process.env.HARNESS_INPUT
  ? JSON.parse(process.env.HARNESS_INPUT)
  : null;

// =============================================================================
// Output Helpers
// =============================================================================

function printSection(title: string, data: unknown): void {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ${title}`);
  console.log('='.repeat(60));
  console.log(JSON.stringify(data, null, 2));
}

// =============================================================================
// Mock Factories
// =============================================================================

/** All tool names that playbooks may reference */
const ALL_PLAYBOOK_TOOLS = [
  // auto_caption
  'auto_transcribe',
  'add_captions_from_transcription',
  // music_bed
  'get_unused_assets',
  'insert_clip',
  'adjust_volume',
  // broll_music_subtitles
  'add_caption',
  // generate_and_place
  'generate_video',
  'check_generation_status',
  // stock_media_search
  'search_stock_media',
  // reference_style_transfer
  'analyze_reference_video',
  'generate_style_document',
  'apply_editing_style',
  // analysis
  'analyze_asset',
  'analyze_workspace_video',
  'get_analysis_status',
  'get_asset_annotation',
];

function createMockToolExecutor(toolNames: string[]): IToolExecutor {
  return {
    execute: async (): Promise<ToolExecutionResult> => ({
      success: true,
      duration: 1,
      undoable: false,
    }),
    executeBatch: async (): Promise<BatchExecutionResult> => ({
      success: true,
      results: [],
      totalDuration: 1,
      successCount: 0,
      failureCount: 0,
    }),
    getAvailableTools: (): ToolInfo[] =>
      toolNames.map((name) => ({
        name,
        description: name,
        category: 'utility',
        riskLevel: 'low' as RiskLevel,
        supportsUndo: false,
        parallelizable: false,
      })),
    getToolDefinition: () => null,
    validateArgs: (): ValidationResult => ({ valid: true, errors: [] }),
    hasTool: (name: string) => toolNames.includes(name),
    getToolsByCategory: () => new Map(),
    getToolsByRisk: () => [],
  };
}

function createTestContext(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    ...createEmptyContext('test-project'),
    sequenceId: 'seq-1',
    playheadPosition: 10,
    timelineDuration: 120,
    availableTracks: [
      { id: 'track-v1', name: 'Video 1', type: 'video', clipCount: 1 },
      { id: 'track-a1', name: 'Audio 1', type: 'audio', clipCount: 1 },
    ],
    availableAssets: [
      { id: 'asset-v1', name: 'video.mp4', type: 'video', duration: 60 },
      { id: 'asset-a1', name: 'audio.mp3', type: 'audio', duration: 120 },
    ],
    ...overrides,
  };
}

function createThought(input: {
  understanding: string;
  requirements: string[];
  approach: string;
  uncertainties?: string[];
}): Thought {
  return {
    understanding: input.understanding,
    requirements: input.requirements,
    approach: input.approach,
    uncertainties: input.uncertainties ?? [],
    needsMoreInfo: false,
  };
}

/** Run playbook matching and return structured diagnostic result */
function diagnosePlaybook(
  thought: Thought,
  context?: Partial<AgentContext>,
  toolNames?: string[],
): {
  matched: boolean;
  playbookId: string | null;
  confidence: number | null;
  goal: string | null;
  stepCount: number;
  steps: Array<{ id: string; tool: string; description: string }>;
  thought: { understanding: string; requirements: string[]; approach: string };
} {
  const ctx = createTestContext(context);
  const executor = createMockToolExecutor(toolNames ?? ALL_PLAYBOOK_TOOLS);
  const match = buildOrchestrationPlaybook(thought, ctx, executor);

  return {
    matched: match !== null,
    playbookId: match?.id ?? null,
    confidence: match?.confidence ?? null,
    goal: match?.plan.goal ?? null,
    stepCount: match?.plan.steps.length ?? 0,
    steps:
      match?.plan.steps.map((s) => ({
        id: s.id,
        tool: s.tool,
        description: s.description,
      })) ?? [],
    thought: {
      understanding: thought.understanding,
      requirements: thought.requirements,
      approach: thought.approach,
    },
  };
}

// =============================================================================
// Mode: Playbook Diagnostic
// =============================================================================

describe('Playbook Diagnostic', () => {
  const skip = HARNESS_MODE !== 'playbook' && HARNESS_MODE !== 'all';

  it('diagnoses playbook matching from CLI input', () => {
    if (skip || !HARNESS_INPUT?.thought) return;

    const thought = createThought(HARNESS_INPUT.thought);
    const result = diagnosePlaybook(
      thought,
      HARNESS_INPUT.context,
      HARNESS_INPUT.tools,
    );

    printSection('PLAYBOOK DIAGNOSTIC', result);

    // Non-assertion: just output. The user reads the result.
    expect(result).toBeDefined();
  });
});

// =============================================================================
// Mode: Tool Diagnostic
// =============================================================================

describe('Tool Diagnostic', () => {
  const skip = HARNESS_MODE !== 'tools' && HARNESS_MODE !== 'tool-exec' && HARNESS_MODE !== 'all';

  beforeAll(() => {
    if (skip) return;
    // Register tools so we can inspect them
    registerCaptionTools();
    registerMediaAnalysisTools();
    registerAnalysisTools();
  });

  it('lists registered tools', () => {
    if (skip && HARNESS_MODE !== 'all') return;

    const tools = globalToolRegistry.listAll();
    const grouped = new Map<string, string[]>();
    for (const tool of tools) {
      const list = grouped.get(tool.category) ?? [];
      list.push(tool.name);
      grouped.set(tool.category, list);
    }

    const result = {
      totalCount: tools.length,
      categories: Object.fromEntries(grouped),
      tools: tools.map((t) => ({
        name: t.name,
        category: t.category,
        description: t.description.slice(0, 100),
        hasIsAvailable: !!t.isAvailable,
      })),
    };

    printSection('REGISTERED TOOLS', result);
    expect(tools.length).toBeGreaterThan(0);
  });

  it('checks specific tool details', () => {
    if (HARNESS_MODE !== 'tools' || !HARNESS_INPUT?.toolName) return;

    const toolName = HARNESS_INPUT.toolName;
    const tool = globalToolRegistry.get(toolName);

    const result = {
      name: toolName,
      registered: !!tool,
      category: tool?.category ?? null,
      description: tool?.description ?? null,
      parameters: tool?.parameters ?? null,
      hasIsAvailable: !!tool?.isAvailable,
    };

    printSection(`TOOL: ${toolName}`, result);
    expect(result).toBeDefined();
  });
});

// =============================================================================
// Mode: Tool Execution Diagnostic
// =============================================================================

describe('Tool Execution Diagnostic', () => {
  const skip = HARNESS_MODE !== 'tool-exec';

  beforeAll(() => {
    if (skip) return;
    registerCaptionTools();
    registerMediaAnalysisTools();
    registerAnalysisTools();
  });

  it('executes tool with mock backend', async () => {
    if (skip || !HARNESS_INPUT?.toolName) return;

    const toolName = HARNESS_INPUT.toolName;
    const args = HARNESS_INPUT.args ?? {};

    // Configure mock IPC responses
    const mockResponses: Record<string, unknown> = {
      is_transcription_available: false,
      transcribe_asset: { error: 'mock: whisper not available' },
      ...HARNESS_INPUT.mockIpc,
    };

    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd in mockResponses) {
        return mockResponses[cmd];
      }
      return undefined;
    });

    const tool = globalToolRegistry.get(toolName);
    if (!tool) {
      printSection(`TOOL EXEC: ${toolName}`, { error: `Tool '${toolName}' not registered` });
      return;
    }

    const execResult = await globalToolRegistry.execute(toolName, args, {});

    printSection(`TOOL EXEC: ${toolName}`, {
      tool: toolName,
      args,
      result: execResult,
      mockIpcCalls: vi.mocked(invoke).mock.calls.map((c) => c[0]),
    });

    expect(execResult).toBeDefined();
  });
});

// =============================================================================
// Mode: QA Scenarios (Regression Suite)
// =============================================================================

describe('QA Scenarios', () => {
  const skip = HARNESS_MODE !== 'scenarios' && HARNESS_MODE !== 'all';

  // -------------------------------------------------------------------------
  // QA-001: Lyrics analysis should not be hijacked by auto_caption
  // Reported: User asked for audio+visual lyrics analysis, agent only tried
  // audio transcription via auto_caption playbook, failed on whisper
  // -------------------------------------------------------------------------
  it('QA-001: multi-modal analysis bypasses auto_caption playbook', () => {
    if (skip) return;

    const thought = createThought({
      understanding: 'Extract and identify lyrics from the video on the timeline by analyzing both audio and visual content',
      requirements: [
        'Identify clips on the timeline',
        'Transcribe audio to get lyrics from speech',
        'Analyze video frames to detect on-screen lyrics (OCR)',
      ],
      approach: 'Use speech-to-text for audio and visual frame analysis for on-screen text',
    });

    const result = diagnosePlaybook(thought);

    printSection('QA-001: Multi-modal lyrics analysis', result);

    // auto_caption should NOT match because requirements go beyond captioning scope
    expect(result.playbookId).not.toBe('auto_caption');
  });

  // -------------------------------------------------------------------------
  // QA-001b: Same scenario in Korean
  // -------------------------------------------------------------------------
  it('QA-001b: Korean lyrics analysis bypasses auto_caption', () => {
    if (skip) return;

    const thought = createThought({
      understanding: '타임라인 영상의 음성과 화면에서 가사를 분석하여 가사 내용을 알려주기',
      requirements: [
        '타임라인 클립 식별',
        '음성 인식으로 가사 추출',
        '화면 텍스트 분석으로 가사 감지',
      ],
      approach: '음성 인식과 화면 분석을 병행하여 가사를 추출',
    });

    const result = diagnosePlaybook(thought);

    printSection('QA-001b: Korean lyrics analysis', result);

    expect(result.playbookId).not.toBe('auto_caption');
  });

  // -------------------------------------------------------------------------
  // QA-002: Pure caption request should still match auto_caption
  // -------------------------------------------------------------------------
  it('QA-002: pure caption request matches auto_caption', () => {
    if (skip) return;

    const thought = createThought({
      understanding: 'Add subtitles to the video on the timeline',
      requirements: ['audio transcription', 'caption creation'],
      approach: 'Transcribe the audio and add caption clips',
    });

    const result = diagnosePlaybook(thought);

    printSection('QA-002: Pure caption request', result);

    expect(result.playbookId).toBe('auto_caption');
    expect(result.stepCount).toBe(2);
  });

  // -------------------------------------------------------------------------
  // QA-003: Multi-analysis (shots + transcription + objects) should not lock
  // into any narrow playbook
  // -------------------------------------------------------------------------
  it('QA-003: multi-analysis request bypasses narrow playbooks', () => {
    if (skip) return;

    const thought = createThought({
      understanding: 'Analyze this video for scene changes, dialogue, and objects',
      requirements: [
        'Shot boundary detection',
        'Audio transcription',
        'Object recognition in key frames',
      ],
      approach: 'Run multi-modal analysis pipeline with shots, transcript, and objects',
    });

    const result = diagnosePlaybook(thought);

    printSection('QA-003: Multi-analysis request', result);

    // Should NOT match auto_caption (requirements go beyond captioning)
    expect(result.playbookId).not.toBe('auto_caption');
  });

  // -------------------------------------------------------------------------
  // QA-004: auto_transcribe returns actionable error when whisper unavailable
  // -------------------------------------------------------------------------
  it('QA-004: auto_transcribe returns actionable alternatives when whisper unavailable', async () => {
    if (skip) return;

    registerCaptionTools();

    // Mock: whisper not available
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'is_transcription_available') return false;
      return undefined;
    });

    const result = await globalToolRegistry.execute('auto_transcribe', { assetId: 'test-asset' }, {});

    printSection('QA-004: auto_transcribe without whisper', result);

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    // Error should mention alternatives, not just "rebuild with --features whisper"
    expect(result.error).toContain('analyze_asset');
    expect(result.error).toContain('transcript');
    expect(result.error).toContain('textOcr');

    unregisterCaptionTools();
  });

  // -------------------------------------------------------------------------
  // QA-005: auto_transcribe succeeds when whisper IS available
  // -------------------------------------------------------------------------
  it('QA-005: auto_transcribe proceeds when whisper is available', async () => {
    if (skip) return;

    registerCaptionTools();

    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'is_transcription_available') return true;
      if (cmd === 'transcribe_asset') {
        return {
          language: 'en',
          segments: [{ startTime: 0, endTime: 5, text: 'Hello world' }],
          duration: 5,
          fullText: 'Hello world',
        };
      }
      return undefined;
    });

    const result = await globalToolRegistry.execute('auto_transcribe', { assetId: 'test-asset' }, {});

    printSection('QA-005: auto_transcribe with whisper', result);

    expect(result.success).toBe(true);

    unregisterCaptionTools();
  });

  // -------------------------------------------------------------------------
  // QA-007: "Create captions for the video" should NOT be hijacked by
  // generate_and_place playbook despite containing create/video/timeline keywords
  // -------------------------------------------------------------------------
  it('QA-007: caption request with create+video+timeline keywords avoids generate_and_place', () => {
    if (skip) return;

    const thought = createThought({
      understanding: 'Create captions for the video on the timeline',
      requirements: ['captions', 'transcription'],
      approach: 'Transcribe audio and add subtitle clips',
    });

    const result = diagnosePlaybook(thought);

    printSection('QA-007: Caption request with overlapping keywords (EN)', result);

    expect(result.playbookId).not.toBe('generate_and_place');
  });

  // -------------------------------------------------------------------------
  // QA-008: Korean caption request "이 영상에 자막을 만들어서 추가해줘" should
  // NOT be hijacked by generate_and_place (만들=create, 영상=video, 추가=add)
  // -------------------------------------------------------------------------
  it('QA-008: Korean caption request avoids generate_and_place', () => {
    if (skip) return;

    const thought = createThought({
      understanding: '이 영상에 자막을 만들어서 추가해줘',
      requirements: ['자막 생성', '음성 인식'],
      approach: '음성 인식 후 자막 추가',
    });

    const result = diagnosePlaybook(thought);

    printSection('QA-008: Korean caption request with overlapping keywords', result);

    expect(result.playbookId).not.toBe('generate_and_place');
  });

  // -------------------------------------------------------------------------
  // QA-006: Korean auto-caption keyword "음성 인식" still works for pure requests
  // -------------------------------------------------------------------------
  it('QA-006: Korean 음성 인식 matches auto_caption for pure requests', () => {
    if (skip) return;

    const thought = createThought({
      understanding: '음성 인식으로 자막을 추가해주세요',
      requirements: ['음성 인식', '자막 추가'],
      approach: '음성 인식 후 caption 생성',
    });

    const result = diagnosePlaybook(thought);

    printSection('QA-006: Korean auto-caption', result);

    expect(result.playbookId).toBe('auto_caption');
  });
});
