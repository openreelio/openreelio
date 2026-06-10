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
  },
}));

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
