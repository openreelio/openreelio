import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { globalToolRegistry, type AgentContext } from '@/agents';
import { registerCaptionTools, unregisterCaptionTools } from './captionTools';
import { useProjectStore } from '@/stores/projectStore';
import { readWorkspaceDocumentFromBackend } from '@/services/workspaceGateway';
import { commands, type AssetAnnotation } from '@/bindings';
import type { Clip, Sequence, Track } from '@/types';

vi.mock('@/stores/projectStore', () => ({
  useProjectStore: {
    getState: vi.fn(),
  },
}));

vi.mock('@/services/workspaceGateway', () => ({
  readWorkspaceDocumentFromBackend: vi.fn(),
}));

vi.mock('@/bindings', () => ({
  commands: {
    analyzeAsset: vi.fn(),
    getAvailableProviders: vi.fn(),
    getTranscriptionStatus: vi.fn(),
    transcribeSequence: vi.fn(),
    downloadWhisperModel: vi.fn(),
  },
}));

/**
 * Build a transcription status with the given installed/weak default model and
 * an optional recommended large-v3-turbo-q5_0 entry. Keeps the per-test status
 * fixtures concise.
 */
function buildTranscriptionStatus(options: {
  defaultModel: string;
  installedWeak: string;
  recommendedInstalled: boolean;
}): {
  status: 'ok';
  data: import('@/bindings').TranscriptionStatusDto;
} {
  const models: import('@/bindings').TranscriptionModelDto[] = [
    {
      id: options.installedWeak,
      displayName: 'Weak',
      filename: `ggml-${options.installedWeak}.bin`,
      installed: true,
      path: `/models/ggml-${options.installedWeak}.bin`,
      sizeBytes: 100,
      isDefault: options.defaultModel === options.installedWeak,
      recommended: false,
      downloadUrl: 'https://example.com/weak',
      estimatedSizeBytes: 100,
      source: 'upstream',
      license: 'MIT',
    },
    {
      id: 'large-v3-turbo-q5_0',
      displayName: 'Large v3 Turbo Q5',
      filename: 'ggml-large-v3-turbo-q5_0.bin',
      installed: options.recommendedInstalled,
      path: '/models/ggml-large-v3-turbo-q5_0.bin',
      sizeBytes: options.recommendedInstalled ? 574000000 : null,
      isDefault: false,
      recommended: true,
      downloadUrl: 'https://example.com/turbo',
      estimatedSizeBytes: 574000000,
      source: 'upstream',
      license: 'MIT',
    },
  ];
  return {
    status: 'ok',
    data: {
      featureAvailable: true,
      ready: true,
      modelsDir: '/models',
      defaultModel: options.defaultModel,
      installedCount: models.filter((model) => model.installed).length,
      models,
    },
  };
}

const CTX: AgentContext = {
  projectId: 'project-1',
  sequenceId: 'seq-1',
};

function createClip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: 'clip-1',
    assetId: 'asset-1',
    range: {
      sourceInSec: 0,
      sourceOutSec: 3,
    },
    place: {
      timelineInSec: 0,
      durationSec: 3,
    },
    transform: {
      position: { x: 0.5, y: 0.5 },
      scale: { x: 1, y: 1 },
      rotationDeg: 0,
      anchor: { x: 0.5, y: 0.5 },
    },
    opacity: 1,
    speed: 1,
    effects: [],
    audio: {
      volumeDb: 0,
      pan: 0,
      muted: false,
    },
    ...overrides,
  };
}

function createTrack(overrides: Partial<Track> = {}): Track {
  return {
    id: 'track-1',
    kind: 'video',
    name: 'Track 1',
    clips: [],
    blendMode: 'normal',
    muted: false,
    locked: false,
    visible: true,
    volume: 1,
    ...overrides,
  };
}

function createSequence(overrides: Partial<Sequence> = {}): Sequence {
  return {
    id: 'seq-1',
    name: 'Main Sequence',
    format: {
      canvas: { width: 1920, height: 1080 },
      fps: { num: 30, den: 1 },
      audioSampleRate: 48000,
      audioChannels: 2,
    },
    tracks: [],
    markers: [],
    ...overrides,
  };
}

describe('captionTools', () => {
  const executeCommandMock = vi.fn();

  beforeEach(() => {
    globalToolRegistry.clear();
    registerCaptionTools();
    vi.clearAllMocks();
    vi.mocked(readWorkspaceDocumentFromBackend).mockResolvedValue({
      relativePath: 'captions/example.srt',
      content: '1\n00:00:00,000 --> 00:00:02,000\nHello world\n',
      sizeBytes: 42,
      modifiedAtUnixSec: 1,
    });
    executeCommandMock.mockResolvedValue({
      opId: 'op-caption',
      success: true,
      createdIds: ['cap-created'],
      deletedIds: [],
      changes: [],
    });
    vi.mocked(commands.getAvailableProviders).mockResolvedValue({
      status: 'ok',
      data: [],
    });
    // Default: local Whisper status unavailable so auto_transcribe takes the
    // analysis-provider fallback path. Individual tests override as needed.
    vi.mocked(commands.getTranscriptionStatus).mockResolvedValue({
      status: 'error',
      error: 'Local Whisper is not available in this build.',
    });

    const sequence = createSequence({
      tracks: [
        createTrack({
          id: 'track-video-1',
          kind: 'video',
          clips: [createClip({ id: 'clip-video-1', assetId: 'asset-video-1' })],
        }),
        createTrack({
          id: 'track-caption-1',
          kind: 'caption',
          clips: [createClip({ id: 'cap-001', assetId: 'caption', label: 'hello caption' })],
        }),
      ],
    });

    vi.mocked(useProjectStore.getState).mockReturnValue({
      isLoaded: true,
      meta: {
        id: 'project-1',
        name: 'Test Project',
      },
      sequences: new Map([[sequence.id, sequence]]),
      executeCommand: executeCommandMock,
    } as unknown as ReturnType<typeof useProjectStore.getState>);
  });

  afterEach(() => {
    unregisterCaptionTools();
    globalToolRegistry.clear();
  });

  it('should send parsed color and top-level position in style_caption', async () => {
    const tool = globalToolRegistry.get('style_caption');
    expect(tool).toBeDefined();

    const result = await tool!.handler(
      {
        sequenceId: 'seq-1',
        captionId: 'cap-001',
        color: '#112233CC',
        backgroundColor: '#00000066',
        position: 'top',
        fontSize: 42,
        fontWeight: 700,
        italic: true,
        outlineColor: '#445566',
        outlineWidth: 3,
        shadowColor: '#00000099',
        shadowOffsetX: 4,
        shadowOffsetY: 6,
        lineHeight: 1.4,
      },
      CTX,
    );

    expect(result.success).toBe(true);
    expect(executeCommandMock).toHaveBeenCalledTimes(1);

    const command = executeCommandMock.mock.calls[0][0] as {
      type: string;
      payload: Record<string, unknown>;
    };

    expect(command.type).toBe('UpdateCaption');
    expect(command.payload).toMatchObject({
      sequenceId: 'seq-1',
      trackId: 'track-caption-1',
      captionId: 'cap-001',
      style: {
        fontSize: 42,
        fontWeight: 700,
        italic: true,
        color: { r: 17, g: 34, b: 51, a: 204 },
        backgroundColor: { r: 0, g: 0, b: 0, a: 102 },
        outlineColor: { r: 68, g: 85, b: 102, a: 255 },
        outlineWidth: 3,
        shadowColor: { r: 0, g: 0, b: 0, a: 153 },
        shadowOffsetX: 4,
        shadowOffsetY: 6,
        lineHeight: 1.4,
      },
      position: {
        type: 'preset',
        vertical: 'top',
        marginPercent: 5,
      },
    });

    expect((command.payload.style as Record<string, unknown>).position).toBeUndefined();
  });

  it('should send custom position objects in style_caption', async () => {
    const tool = globalToolRegistry.get('style_caption');
    expect(tool).toBeDefined();

    const result = await tool!.handler(
      {
        sequenceId: 'seq-1',
        captionId: 'cap-001',
        xPercent: 42,
        yPercent: 84,
      },
      CTX,
    );

    expect(result.success).toBe(true);

    const command = executeCommandMock.mock.calls[0][0] as {
      type: string;
      payload: Record<string, unknown>;
    };

    expect(command.payload.position).toEqual({
      type: 'custom',
      xPercent: 42,
      yPercent: 84,
    });
  });

  it('should reject invalid caption color in style_caption', async () => {
    const tool = globalToolRegistry.get('style_caption');
    expect(tool).toBeDefined();

    const result = await tool!.handler(
      {
        sequenceId: 'seq-1',
        captionId: 'cap-001',
        color: 'not-a-hex-color',
      },
      CTX,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid caption color');
    expect(executeCommandMock).not.toHaveBeenCalled();
  });

  it('should reject add_caption when explicit track is not a caption track', async () => {
    const tool = globalToolRegistry.get('add_caption');
    expect(tool).toBeDefined();

    const result = await tool!.handler(
      {
        sequenceId: 'seq-1',
        trackId: 'track-video-1',
        text: 'Caption text',
        startTime: 1,
        endTime: 2,
      },
      CTX,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('not a caption track');
    expect(executeCommandMock).not.toHaveBeenCalled();
  });

  it('should skip invalid transcription segments and report skipped count', async () => {
    const tool = globalToolRegistry.get('add_captions_from_transcription');
    expect(tool).toBeDefined();

    const result = await tool!.handler(
      {
        sequenceId: 'seq-1',
        segments: [
          { startTime: 0, endTime: 2, text: 'Hello world' },
          { startTime: 3, endTime: 3, text: 'bad segment' },
          { startTime: 4, endTime: 5, text: '   ' },
        ],
      },
      CTX,
    );

    expect(result.success).toBe(true);
    expect(executeCommandMock).toHaveBeenCalledTimes(1);
    expect(result.result).toMatchObject({
      captionCount: 1,
      skippedSegmentCount: 2,
    });
  });

  function setSequenceWithSourceClip(clipOverrides: Partial<Clip>): void {
    const sequence = createSequence({
      tracks: [
        createTrack({
          id: 'track-video-1',
          kind: 'video',
          clips: [createClip({ id: 'src-clip', assetId: 'asset-video-1', ...clipOverrides })],
        }),
        createTrack({
          id: 'track-caption-1',
          kind: 'caption',
          clips: [],
        }),
      ],
    });
    vi.mocked(useProjectStore.getState).mockReturnValue({
      isLoaded: true,
      meta: { id: 'project-1', name: 'Test Project' },
      sequences: new Map([[sequence.id, sequence]]),
      executeCommand: executeCommandMock,
    } as unknown as ReturnType<typeof useProjectStore.getState>);
  }

  it('should map source-relative segments to timeline time when clipId is provided (constant speed)', async () => {
    const tool = globalToolRegistry.get('add_captions_from_transcription');
    expect(tool).toBeDefined();

    // Clip places source [10, 16] at timeline 4s, speed 1.
    setSequenceWithSourceClip({
      range: { sourceInSec: 10, sourceOutSec: 16 },
      place: { timelineInSec: 4, durationSec: 6 },
      speed: 1,
    });

    const result = await tool!.handler(
      {
        sequenceId: 'seq-1',
        clipId: 'src-clip',
        segments: [
          { startTime: 10, endTime: 12, text: 'First' },
          { startTime: 13, endTime: 15, text: 'Second' },
        ],
      },
      CTX,
    );

    expect(result.success).toBe(true);
    expect(executeCommandMock).toHaveBeenCalledTimes(1);
    expect(executeCommandMock.mock.calls[0][0]).toMatchObject({
      type: 'ImportGeneratedCaptions',
      payload: {
        sequenceId: 'seq-1',
        trackId: 'track-caption-1',
        // timelineInSec(4) + (source - sourceInSec(10)) / speed(1)
        segments: [
          { startSec: 4, endSec: 6, text: 'First' },
          { startSec: 7, endSec: 9, text: 'Second' },
        ],
      },
    });
  });

  it('should account for clip speed when mapping source segments to timeline', async () => {
    const tool = globalToolRegistry.get('add_captions_from_transcription');
    expect(tool).toBeDefined();

    // Speed 2: 4s of source maps to 2s of timeline.
    setSequenceWithSourceClip({
      range: { sourceInSec: 0, sourceOutSec: 8 },
      place: { timelineInSec: 1, durationSec: 4 },
      speed: 2,
    });

    const result = await tool!.handler(
      {
        sequenceId: 'seq-1',
        clipId: 'src-clip',
        segments: [{ startTime: 4, endTime: 8, text: 'Fast' }],
      },
      CTX,
    );

    expect(result.success).toBe(true);
    // timelineInSec(1) + (4 - 0) / 2 = 3 ; (8 - 0) / 2 = 4 -> timeline end 5
    expect(executeCommandMock.mock.calls[0][0]).toMatchObject({
      type: 'ImportGeneratedCaptions',
      payload: {
        segments: [{ startSec: 3, endSec: 5, text: 'Fast' }],
      },
    });
  });

  it('should account for reversed clips when mapping source segments to timeline', async () => {
    const tool = globalToolRegistry.get('add_captions_from_transcription');
    expect(tool).toBeDefined();

    // Reversed source [0, 10] starts playback at source 10 on timeline 20.
    setSequenceWithSourceClip({
      range: { sourceInSec: 0, sourceOutSec: 10 },
      place: { timelineInSec: 20, durationSec: 10 },
      speed: 1,
      reverse: true,
    });

    const result = await tool!.handler(
      {
        sequenceId: 'seq-1',
        clipId: 'src-clip',
        segments: [{ startTime: 8, endTime: 10, text: 'Reverse start' }],
      },
      CTX,
    );

    expect(result.success).toBe(true);
    expect(executeCommandMock.mock.calls[0][0]).toMatchObject({
      type: 'ImportGeneratedCaptions',
      payload: {
        segments: [{ startSec: 20, endSec: 22, text: 'Reverse start' }],
      },
    });
  });

  it('should reject mapping for clips with an active time remap curve', async () => {
    const tool = globalToolRegistry.get('add_captions_from_transcription');
    expect(tool).toBeDefined();

    setSequenceWithSourceClip({
      range: { sourceInSec: 0, sourceOutSec: 10 },
      place: { timelineInSec: 0, durationSec: 10 },
      speed: 1,
      timeRemap: {
        keyframes: [
          { timelineTime: 0, sourceTime: 0, interpolation: 'linear' },
          { timelineTime: 10, sourceTime: 5, interpolation: 'linear' },
        ],
      },
    });

    const result = await tool!.handler(
      {
        sequenceId: 'seq-1',
        clipId: 'src-clip',
        segments: [{ startTime: 1, endTime: 2, text: 'Remapped' }],
      },
      CTX,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('time remap');
    expect(result.error).toContain('auto_transcribe_sequence');
    expect(executeCommandMock).not.toHaveBeenCalled();
  });

  it('should drop out-of-range source segments and report them in skippedSegmentCount', async () => {
    const tool = globalToolRegistry.get('add_captions_from_transcription');
    expect(tool).toBeDefined();

    setSequenceWithSourceClip({
      range: { sourceInSec: 5, sourceOutSec: 10 },
      place: { timelineInSec: 0, durationSec: 5 },
      speed: 1,
    });

    const result = await tool!.handler(
      {
        sequenceId: 'seq-1',
        clipId: 'src-clip',
        segments: [
          { startTime: 2, endTime: 4, text: 'Before range' },
          { startTime: 6, endTime: 7, text: 'In range' },
          { startTime: 11, endTime: 12, text: 'After range' },
        ],
      },
      CTX,
    );

    expect(result.success).toBe(true);
    expect(result.result).toMatchObject({
      captionCount: 1,
      skippedSegmentCount: 2,
    });
    expect(executeCommandMock.mock.calls[0][0]).toMatchObject({
      type: 'ImportGeneratedCaptions',
      payload: {
        // timelineInSec(0) + (6 - 5) = 1 ; (7 - 5) = 2
        segments: [{ startSec: 1, endSec: 2, text: 'In range' }],
      },
    });
  });

  it('should pass segment times through unchanged when clipId is omitted', async () => {
    const tool = globalToolRegistry.get('add_captions_from_transcription');
    expect(tool).toBeDefined();

    const result = await tool!.handler(
      {
        sequenceId: 'seq-1',
        segments: [
          { startTime: 10, endTime: 12, text: 'Raw one' },
          { startTime: 13, endTime: 15, text: 'Raw two' },
        ],
      },
      CTX,
    );

    expect(result.success).toBe(true);
    expect(executeCommandMock.mock.calls[0][0]).toMatchObject({
      type: 'ImportGeneratedCaptions',
      payload: {
        segments: [
          { startSec: 10, endSec: 12, text: 'Raw one' },
          { startSec: 13, endSec: 15, text: 'Raw two' },
        ],
      },
    });
  });

  it('should forward style and position to ImportGeneratedCaptions', async () => {
    const tool = globalToolRegistry.get('add_captions_from_transcription');
    expect(tool).toBeDefined();

    const result = await tool!.handler(
      {
        sequenceId: 'seq-1',
        segments: [{ startTime: 0, endTime: 2, text: 'Styled caption' }],
        style: { fontFamily: 'Arial', fontSize: 48 },
        position: 'bottom',
      },
      CTX,
    );

    expect(result.success).toBe(true);
    expect(executeCommandMock.mock.calls[0][0]).toMatchObject({
      type: 'ImportGeneratedCaptions',
      payload: {
        style: { fontFamily: 'Arial', fontSize: 48 },
        position: { type: 'preset', vertical: 'bottom', marginPercent: 5 },
      },
    });
  });

  it('should omit style and position from ImportGeneratedCaptions when not provided', async () => {
    const tool = globalToolRegistry.get('add_captions_from_transcription');
    expect(tool).toBeDefined();

    const result = await tool!.handler(
      {
        sequenceId: 'seq-1',
        segments: [{ startTime: 0, endTime: 2, text: 'Plain caption' }],
      },
      CTX,
    );

    expect(result.success).toBe(true);
    const payload = executeCommandMock.mock.calls[0][0].payload as Record<string, unknown>;
    expect(payload.style).toBeUndefined();
    expect(payload.position).toBeUndefined();
  });

  it('should return track defaults and an existing caption style from get_caption_style', async () => {
    const tool = globalToolRegistry.get('get_caption_style');
    expect(tool).toBeDefined();

    const styledSequence = createSequence({
      tracks: [
        createTrack({
          id: 'track-caption-1',
          kind: 'caption',
          captionLanguage: 'en',
          clips: [
            createClip({
              id: 'cap-styled',
              assetId: 'caption',
              label: 'styled caption',
              captionStyle: {
                fontFamily: 'Roboto',
                fontSize: 36,
                fontWeight: 'normal',
                color: { r: 255, g: 200, b: 0, a: 255 },
                outlineColor: { r: 0, g: 0, b: 0, a: 255 },
                outlineWidth: 3,
                shadowOffset: 2,
                alignment: 'center',
                italic: false,
                underline: false,
              },
              captionPosition: { type: 'preset', vertical: 'bottom', marginPercent: 8 },
            }),
          ],
        }),
      ],
    });
    vi.mocked(useProjectStore.getState).mockReturnValue({
      isLoaded: true,
      meta: { id: 'project-1', name: 'Test Project' },
      sequences: new Map([[styledSequence.id, styledSequence]]),
      executeCommand: executeCommandMock,
    } as unknown as ReturnType<typeof useProjectStore.getState>);

    const result = await tool!.handler({ sequenceId: 'seq-1' }, CTX);

    expect(result.success).toBe(true);
    expect(result.result).toMatchObject({
      sequenceId: 'seq-1',
      trackId: 'track-caption-1',
      language: 'en',
      trackDefaultStyle: { fontFamily: 'Arial', fontSize: 48 },
      trackDefaultPosition: { type: 'preset', vertical: 'bottom', marginPercent: 5 },
      existingCaption: {
        captionId: 'cap-styled',
        styleOverride: { fontFamily: 'Roboto', fontSize: 36 },
        positionOverride: { type: 'preset', vertical: 'bottom', marginPercent: 8 },
      },
      captionCount: 1,
    });
  });

  it('should report no existing caption when the track is empty in get_caption_style', async () => {
    const tool = globalToolRegistry.get('get_caption_style');
    expect(tool).toBeDefined();

    const emptySequence = createSequence({
      tracks: [createTrack({ id: 'track-caption-1', kind: 'caption', clips: [] })],
    });
    vi.mocked(useProjectStore.getState).mockReturnValue({
      isLoaded: true,
      meta: { id: 'project-1', name: 'Test Project' },
      sequences: new Map([[emptySequence.id, emptySequence]]),
      executeCommand: executeCommandMock,
    } as unknown as ReturnType<typeof useProjectStore.getState>);

    const result = await tool!.handler({ sequenceId: 'seq-1' }, CTX);

    expect(result.success).toBe(true);
    expect(result.result).toMatchObject({
      trackId: 'track-caption-1',
      existingCaption: null,
      captionCount: 0,
    });
  });

  it('should reject transcription batches when all segments are invalid', async () => {
    const tool = globalToolRegistry.get('add_captions_from_transcription');
    expect(tool).toBeDefined();

    const result = await tool!.handler(
      {
        sequenceId: 'seq-1',
        segments: [
          { startTime: 2, endTime: 1, text: 'bad timing' },
          { startTime: Number.NaN, endTime: 3, text: 'NaN start' },
        ],
      },
      CTX,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('No valid segments provided');
    expect(executeCommandMock).not.toHaveBeenCalled();
  });

  it('should report generated caption import failures without partial caption rollback', async () => {
    const tool = globalToolRegistry.get('add_captions_from_transcription');
    expect(tool).toBeDefined();

    executeCommandMock.mockRejectedValueOnce(new Error('Caption overlap detected'));

    const result = await tool!.handler(
      {
        sequenceId: 'seq-1',
        segments: [
          { startTime: 0, endTime: 2, text: 'Intro' },
          { startTime: 2, endTime: 4, text: 'Outro' },
        ],
      },
      CTX,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Caption overlap detected');
    expect(executeCommandMock).toHaveBeenCalledTimes(1);
    expect(executeCommandMock.mock.calls[0][0]).toMatchObject({
      type: 'ImportGeneratedCaptions',
      payload: {
        sequenceId: 'seq-1',
        trackId: 'track-caption-1',
        segments: [
          { startSec: 0, endSec: 2, text: 'Intro' },
          { startSec: 2, endSec: 4, text: 'Outro' },
        ],
      },
    });
  });

  it('should import captions from a workspace subtitle file', async () => {
    const tool = globalToolRegistry.get('import_captions_from_file');
    expect(tool).toBeDefined();

    executeCommandMock.mockResolvedValueOnce({
      opId: 'op-caption-import',
      success: true,
      createdIds: ['cap-101', 'cap-102'],
      deletedIds: [],
      changes: [],
    });

    vi.mocked(readWorkspaceDocumentFromBackend).mockResolvedValueOnce({
      relativePath: 'captions/example.vtt',
      content:
        'WEBVTT\n\n00:00:00.000 --> 00:00:01.500\nFirst line\n\n00:00:02.000 --> 00:00:03.000\nSecond line\n',
      sizeBytes: 96,
      modifiedAtUnixSec: 1,
    });

    const result = await tool!.handler(
      {
        sequenceId: 'seq-1',
        relativePath: 'captions/example.vtt',
      },
      CTX,
    );

    expect(result.success).toBe(true);
    expect(readWorkspaceDocumentFromBackend).toHaveBeenCalledWith('captions/example.vtt');
    expect(result.result).toMatchObject({
      format: 'vtt',
      relativePath: 'captions/example.vtt',
      trackId: 'track-caption-1',
      captionCount: 2,
    });
  });

  it('should preserve imported speaker metadata and set caption track language', async () => {
    const tool = globalToolRegistry.get('import_captions_from_file');
    expect(tool).toBeDefined();

    executeCommandMock
      .mockResolvedValueOnce({
        opId: 'op-caption-import',
        success: true,
        createdIds: ['cap-101'],
        deletedIds: [],
        changes: [],
      })
      .mockResolvedValueOnce({
        opId: 'op-caption-language',
        success: true,
        createdIds: [],
        deletedIds: [],
        changes: [],
      });

    vi.mocked(readWorkspaceDocumentFromBackend).mockResolvedValueOnce({
      relativePath: 'captions/interview.vtt',
      content: 'WEBVTT\n\n00:00:00.000 --> 00:00:01.500\n<v Alice><i>Hello</i></v>\n',
      sizeBytes: 72,
      modifiedAtUnixSec: 1,
    });

    const result = await tool!.handler(
      {
        sequenceId: 'seq-1',
        relativePath: 'captions/interview.vtt',
        language: 'KO_kr',
      },
      CTX,
    );

    expect(result.success).toBe(true);
    expect(executeCommandMock).toHaveBeenCalledWith({
      type: 'ImportGeneratedCaptions',
      payload: {
        sequenceId: 'seq-1',
        trackId: 'track-caption-1',
        segments: [
          { startSec: 0, endSec: 1.5, text: 'Hello', speaker: 'Alice', language: 'ko-kr' },
        ],
        replaceExisting: false,
      },
    });
    expect(executeCommandMock).toHaveBeenCalledWith({
      type: 'SetCaptionTrackLanguage',
      payload: {
        sequenceId: 'seq-1',
        trackId: 'track-caption-1',
        language: 'ko-kr',
      },
    });
  });

  it('should remove a newly created caption track when batch creation fails', async () => {
    const tool = globalToolRegistry.get('add_captions_from_transcription');
    expect(tool).toBeDefined();

    const sequenceWithoutCaptionTrack = createSequence({
      tracks: [
        createTrack({
          id: 'track-video-1',
          kind: 'video',
          clips: [createClip({ id: 'clip-video-1', assetId: 'asset-video-1' })],
        }),
      ],
    });
    vi.mocked(useProjectStore.getState).mockReturnValue({
      isLoaded: true,
      meta: {
        id: 'project-1',
        name: 'Test Project',
      },
      sequences: new Map([[sequenceWithoutCaptionTrack.id, sequenceWithoutCaptionTrack]]),
      executeCommand: executeCommandMock,
    } as unknown as ReturnType<typeof useProjectStore.getState>);

    executeCommandMock
      .mockResolvedValueOnce({
        opId: 'op-track-create',
        success: true,
        createdIds: ['track-caption-created'],
        deletedIds: [],
        changes: [],
      })
      .mockRejectedValueOnce(new Error('caption import failed'))
      .mockResolvedValueOnce({
        opId: 'op-track-rollback',
        success: true,
        createdIds: [],
        deletedIds: ['track-caption-created'],
        changes: [],
      });

    const result = await tool!.handler(
      {
        sequenceId: 'seq-1',
        segments: [
          { startTime: 0, endTime: 1, text: 'First line' },
          { startTime: 1, endTime: 2, text: 'Second line' },
        ],
      },
      CTX,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('caption import failed');
    expect(executeCommandMock).toHaveBeenCalledTimes(3);
    expect(executeCommandMock.mock.calls[0][0]).toMatchObject({ type: 'CreateTrack' });
    expect(executeCommandMock.mock.calls[1][0]).toMatchObject({
      type: 'ImportGeneratedCaptions',
      payload: {
        sequenceId: 'seq-1',
        trackId: 'track-caption-created',
        segments: [
          { startSec: 0, endSec: 1, text: 'First line' },
          { startSec: 1, endSec: 2, text: 'Second line' },
        ],
      },
    });
    expect(executeCommandMock.mock.calls[2][0]).toMatchObject({
      type: 'DeleteTrack',
      payload: {
        sequenceId: 'seq-1',
        trackId: 'track-caption-created',
      },
    });
  });

  it('should fall back to a configured transcript analysis provider when local transcription is unavailable', async () => {
    const tool = globalToolRegistry.get('auto_transcribe');
    expect(tool).toBeDefined();

    vi.mocked(invoke).mockResolvedValueOnce(false);
    vi.mocked(commands.getAvailableProviders).mockResolvedValueOnce({
      status: 'ok',
      data: [
        {
          provider: 'google_cloud',
          supportedTypes: ['transcript'],
          requiresNetwork: true,
          hasCost: true,
          description: 'Google Cloud transcript analysis',
        },
      ],
    });
    vi.mocked(commands.analyzeAsset).mockResolvedValueOnce({
      status: 'ok',
      data: {
        annotation: {} as AssetAnnotation,
        response: {
          totalCostCents: 12,
          transcript: {
            provider: 'google_cloud',
            analyzedAt: '2026-05-19T00:00:00.000Z',
            config: null,
            costCents: 12,
            results: [
              {
                startSec: 0,
                endSec: 1.5,
                text: 'Hello from provider',
                confidence: 0.94,
                language: 'en',
              },
            ],
          },
        },
      },
    });

    const result = await tool!.handler({ assetId: 'asset-video-1' }, CTX);

    expect(result.success).toBe(true);
    expect(commands.analyzeAsset).toHaveBeenCalledWith({
      assetId: 'asset-video-1',
      provider: 'google_cloud',
      analysisTypes: ['transcript'],
    });
    expect(result.result).toMatchObject({
      mode: 'analysis',
      provider: 'google_cloud',
      segmentCount: 1,
      segments: [{ startTime: 0, endTime: 1.5, text: 'Hello from provider' }],
      fullText: 'Hello from provider',
    });
  });

  it('should auto-install the recommended model when only a weak default is present and no model is chosen', async () => {
    const tool = globalToolRegistry.get('auto_transcribe');
    expect(tool).toBeDefined();

    // Weak default (`small`) installed; recommended model NOT installed; caller
    // did not choose a model -> hard-enforce: download recommended first, then
    // transcribe with it.
    vi.mocked(commands.getTranscriptionStatus).mockResolvedValueOnce(
      buildTranscriptionStatus({
        defaultModel: 'small',
        installedWeak: 'small',
        recommendedInstalled: false,
      }),
    );
    vi.mocked(commands.downloadWhisperModel).mockResolvedValueOnce({
      status: 'ok',
      data: {} as import('@/bindings').TranscriptionModelDto,
    });
    vi.mocked(invoke).mockResolvedValueOnce({
      language: 'ko',
      segments: [{ startTime: 0, endTime: 1, text: '가사' }],
      duration: 1,
      fullText: '가사',
    });

    const result = await tool!.handler({ assetId: 'asset-video-1' }, CTX);

    expect(result.success).toBe(true);
    expect(commands.downloadWhisperModel).toHaveBeenCalledWith('large-v3-turbo-q5_0', false);
    expect(result.result).toMatchObject({
      mode: 'sync',
      model: 'large-v3-turbo-q5_0',
      autoInstalledModel: 'large-v3-turbo-q5_0',
    });
    // The transcription must run with the recommended model, not the weak one.
    expect(invoke).toHaveBeenCalledWith(
      'transcribe_asset',
      expect.objectContaining({
        options: expect.objectContaining({ model: 'large-v3-turbo-q5_0' }),
      }),
    );
  });

  it('should transcribe with the recommended model without downloading when it is already installed', async () => {
    const tool = globalToolRegistry.get('auto_transcribe');
    expect(tool).toBeDefined();

    // Weak default but recommended model already installed -> switch to it, no download.
    vi.mocked(commands.getTranscriptionStatus).mockResolvedValueOnce(
      buildTranscriptionStatus({
        defaultModel: 'small',
        installedWeak: 'small',
        recommendedInstalled: true,
      }),
    );
    vi.mocked(invoke).mockResolvedValueOnce({
      language: 'ko',
      segments: [{ startTime: 0, endTime: 1, text: '가사' }],
      duration: 1,
      fullText: '가사',
    });

    const result = await tool!.handler({ assetId: 'asset-video-1' }, CTX);

    expect(result.success).toBe(true);
    expect(commands.downloadWhisperModel).not.toHaveBeenCalled();
    expect(result.result).toMatchObject({ mode: 'sync', model: 'large-v3-turbo-q5_0' });
    expect(result.result).not.toHaveProperty('autoInstalledModel');
    expect(invoke).toHaveBeenCalledWith(
      'transcribe_asset',
      expect.objectContaining({
        options: expect.objectContaining({ model: 'large-v3-turbo-q5_0' }),
      }),
    );
  });

  it('should honor an explicit weak model choice without downloading or overriding', async () => {
    const tool = globalToolRegistry.get('auto_transcribe');
    expect(tool).toBeDefined();

    vi.mocked(commands.getTranscriptionStatus).mockResolvedValueOnce(
      buildTranscriptionStatus({
        defaultModel: 'small',
        installedWeak: 'small',
        recommendedInstalled: false,
      }),
    );
    vi.mocked(invoke).mockResolvedValueOnce({
      language: 'en',
      segments: [{ startTime: 0, endTime: 1, text: 'hello' }],
      duration: 1,
      fullText: 'hello',
    });

    const result = await tool!.handler({ assetId: 'asset-video-1', model: 'small' }, CTX);

    expect(result.success).toBe(true);
    expect(commands.downloadWhisperModel).not.toHaveBeenCalled();
    expect(result.result).toMatchObject({ mode: 'sync', model: 'small' });
    expect(result.result).not.toHaveProperty('autoInstalledModel');
    expect(invoke).toHaveBeenCalledWith(
      'transcribe_asset',
      expect.objectContaining({
        options: expect.objectContaining({ model: 'small' }),
      }),
    );
  });

  it('should fall back to the weak model with a warning when the recommended download fails', async () => {
    const tool = globalToolRegistry.get('auto_transcribe');
    expect(tool).toBeDefined();

    vi.mocked(commands.getTranscriptionStatus).mockResolvedValueOnce(
      buildTranscriptionStatus({
        defaultModel: 'small',
        installedWeak: 'small',
        recommendedInstalled: false,
      }),
    );
    vi.mocked(commands.downloadWhisperModel).mockRejectedValueOnce(new Error('network down'));
    vi.mocked(invoke).mockResolvedValueOnce({
      language: 'ko',
      segments: [{ startTime: 0, endTime: 1, text: '가사' }],
      duration: 1,
      fullText: '가사',
    });

    const result = await tool!.handler({ assetId: 'asset-video-1' }, CTX);

    expect(result.success).toBe(true);
    expect(commands.downloadWhisperModel).toHaveBeenCalledWith('large-v3-turbo-q5_0', false);
    // Transcription still runs, but with the original weak model.
    expect(result.result).toMatchObject({ mode: 'sync', model: 'small' });
    expect(result.result).not.toHaveProperty('autoInstalledModel');
    const warning = (result.result as { warning?: string }).warning;
    expect(warning).toContain('large-v3-turbo-q5_0');
    expect(warning).toContain('could not be installed');
    expect(invoke).toHaveBeenCalledWith(
      'transcribe_asset',
      expect.objectContaining({
        options: expect.objectContaining({ model: 'small' }),
      }),
    );
  });

  it('should explain unavailable auto transcription when no transcript provider is configured', async () => {
    const tool = globalToolRegistry.get('auto_transcribe');
    expect(tool).toBeDefined();

    vi.mocked(invoke).mockResolvedValueOnce(false);
    vi.mocked(commands.getAvailableProviders).mockResolvedValueOnce({
      status: 'ok',
      data: [
        {
          provider: 'ffmpeg',
          supportedTypes: ['shots'],
          requiresNetwork: false,
          hasCost: false,
          description: 'Local shot analysis',
        },
      ],
    });

    const result = await tool!.handler({ assetId: 'asset-video-1' }, CTX);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Local transcription (Whisper) is not available');
    expect(result.error).toContain('No transcript-capable analysis provider is configured');
    expect(result.error).toContain('analyze_asset');
    expect(result.error).toContain('transcript');
    expect(result.error).toContain('textOcr');
    expect(commands.analyzeAsset).not.toHaveBeenCalled();
  });
});
