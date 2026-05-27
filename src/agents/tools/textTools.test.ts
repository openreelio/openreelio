import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { commands } from '@/bindings';
import { globalToolRegistry, type AgentContext } from '@/agents';
import { registerTextTools, unregisterTextTools } from './textTools';
import { useProjectStore } from '@/stores/projectStore';
import { TEXT_ASSET_PREFIX, type Clip, type Effect, type Sequence, type Track } from '@/types';

vi.mock('@/bindings', () => ({
  commands: {
    getAnnotation: vi.fn(),
  },
}));

vi.mock('@/stores/projectStore', () => ({
  useProjectStore: {
    getState: vi.fn(),
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
      sourceOutSec: 4,
    },
    place: {
      timelineInSec: 0,
      durationSec: 4,
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
    id: 'track-video-1',
    kind: 'video',
    name: 'Video 1',
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

function createTextEffect(overrides: Partial<Effect> = {}): Effect {
  return {
    id: 'effect-text-1',
    effectType: 'text_overlay',
    enabled: true,
    order: 0,
    keyframes: {},
    params: {
      text: 'Original Text',
      font_family: 'Inter',
      font_size: 48,
      font_weight: 500,
      color: '#FFFFFF',
      background_color: '#00000080',
      background_padding: 12,
      alignment: 'center',
      bold: false,
      italic: false,
      underline: false,
      line_height: 1.2,
      letter_spacing: 0,
      x: 0.4,
      y: 0.3,
      outline_color: '#000000',
      outline_width: 2,
      shadow_color: '#000000',
      shadow_x: 2,
      shadow_y: 3,
      shadow_blur: 4,
      rotation: 0,
      opacity: 1,
    },
    ...overrides,
  };
}

describe('textTools', () => {
  const executeCommandMock = vi.fn();

  beforeEach(() => {
    globalToolRegistry.clear();
    registerTextTools();
    vi.clearAllMocks();
    executeCommandMock.mockResolvedValue({
      opId: 'op-text',
      createdIds: ['clip-text-created'],
      deletedIds: [],
      changes: [],
    });
    vi.mocked(commands.getAnnotation).mockResolvedValue({
      status: 'ok',
      data: { annotation: null, status: 'notAnalyzed' },
    });
  });

  afterEach(() => {
    unregisterTextTools();
    globalToolRegistry.clear();
  });

  function mockProject(sequence: Sequence, effects: Effect[] = []): void {
    vi.mocked(useProjectStore.getState).mockReturnValue({
      isLoaded: true,
      meta: {
        id: 'project-1',
        name: 'Test Project',
      },
      activeSequenceId: sequence.id,
      sequences: new Map([[sequence.id, sequence]]),
      effects: new Map(effects.map((effect) => [effect.id, effect])),
      executeCommand: executeCommandMock,
      undo: vi.fn().mockResolvedValue({ success: true }),
    } as unknown as ReturnType<typeof useProjectStore.getState>);
  }

  function findExecutedCommand(commandType: string): { type: string; payload: unknown } {
    const command = executeCommandMock.mock.calls
      .map(([executedCommand]) => executedCommand as { type?: string; payload?: unknown })
      .find((executedCommand) => executedCommand.type === commandType);
    if (!command?.type) {
      throw new Error(`Expected ${commandType} command to be executed`);
    }

    return { type: command.type, payload: command.payload };
  }

  it('should add a styled text clip and auto-create a video text track when needed', async () => {
    mockProject(createSequence());
    executeCommandMock
      .mockResolvedValueOnce({
        opId: 'op-track',
        createdIds: ['track-video-created'],
        deletedIds: [],
        changes: [],
      })
      .mockResolvedValueOnce({
        opId: 'op-add',
        createdIds: ['clip-text-created', 'effect-text-created'],
        deletedIds: [],
        changes: [],
      })
      .mockResolvedValueOnce({
        opId: 'op-transform',
        createdIds: [],
        deletedIds: [],
        changes: [],
      });

    const tool = globalToolRegistry.get('add_text_clip');
    const result = await tool!.handler(
      {
        sequenceId: 'seq-1',
        text: 'Launch title',
        startTime: 1,
        duration: 3,
        preset: 'title',
        fontFamily: 'Inter',
        fontSize: 72,
        fontWeight: 800,
        color: '#112233',
        position: { xPercent: 25, yPercent: 35 },
        outlineColor: '#000000',
        outlineWidth: 3,
        shadowColor: '#00000099',
        shadowOffsetX: 4,
        shadowOffsetY: 5,
        shadowBlur: 6,
        transform: {
          scale: { x: 1.25, y: 1.1 },
          rotationDeg: -8,
        },
      },
      CTX,
    );

    expect(result.success).toBe(true);
    expect(executeCommandMock).toHaveBeenCalledTimes(3);
    expect(executeCommandMock.mock.calls[0][0]).toMatchObject({
      type: 'CreateTrack',
      payload: {
        sequenceId: 'seq-1',
        kind: 'video',
        name: 'Video 1',
      },
    });
    expect(executeCommandMock.mock.calls[1][0]).toMatchObject({
      type: 'AddTextClip',
      payload: {
        sequenceId: 'seq-1',
        trackId: 'track-video-created',
        timelineIn: 1,
        duration: 3,
        textData: {
          content: 'Launch title',
          style: {
            fontFamily: 'Inter',
            fontSize: 72,
            fontWeight: 800,
            color: '#112233',
          },
          position: { x: 0.25, y: 0.35 },
          outline: { color: '#000000', width: 3 },
          shadow: { color: '#00000099', offsetX: 4, offsetY: 5, blur: 6 },
        },
      },
    });
    expect(executeCommandMock.mock.calls[2][0]).toMatchObject({
      type: 'SetClipTransform',
      payload: {
        sequenceId: 'seq-1',
        trackId: 'track-video-created',
        clipId: 'clip-text-created',
        transform: {
          position: { x: 0.25, y: 0.35 },
          scale: { x: 1.25, y: 1.1 },
          rotationDeg: -8,
        },
      },
    });
  });

  it('should add editable text through an alias using the active sequence from context', async () => {
    mockProject(createSequence({ tracks: [createTrack()] }));

    const result = await globalToolRegistry.execute(
      'create_title',
      {
        content: 'Context title',
        startTime: 0.5,
        duration: 2.5,
        preset: 'title',
        position: { x: 0.5, y: 0.22 },
      },
      CTX,
    );

    expect(result.success).toBe(true);
    expect(executeCommandMock).toHaveBeenCalledTimes(1);
    expect(findExecutedCommand('AddTextClip')).toMatchObject({
      type: 'AddTextClip',
      payload: {
        sequenceId: 'seq-1',
        trackId: 'track-video-1',
        timelineIn: 0.5,
        duration: 2.5,
        textData: {
          content: 'Context title',
          position: { x: 0.5, y: 0.22 },
        },
      },
    });
  });

  it('should auto-place new subtitle-style text away from detected faces', async () => {
    const mediaClip = createClip({
      id: 'clip-video-1',
      assetId: 'asset-video-1',
      place: { timelineInSec: 0, durationSec: 8 },
      range: { sourceInSec: 0, sourceOutSec: 8 },
    });
    mockProject(createSequence({ tracks: [createTrack({ clips: [mediaClip] })] }));
    vi.mocked(commands.getAnnotation).mockResolvedValue({
      status: 'ok',
      data: {
        status: 'completed',
        annotation: {
          version: '1',
          assetId: 'asset-video-1',
          assetHash: 'hash',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
          analysis: {
            faces: {
              provider: 'google_cloud',
              analyzedAt: '2026-01-01T00:00:00Z',
              config: {},
              results: [
                {
                  timeSec: 1,
                  confidence: 0.95,
                  boundingBox: { left: 0.25, top: 0.72, width: 0.5, height: 0.2 },
                  emotions: [],
                },
              ],
            },
          },
        },
      },
    });
    executeCommandMock
      .mockResolvedValueOnce({
        opId: 'op-track',
        createdIds: ['track-video-created'],
        deletedIds: [],
        changes: [],
      })
      .mockResolvedValueOnce({
        opId: 'op-add',
        createdIds: ['clip-text-created', 'effect-text-created'],
        deletedIds: [],
        changes: [],
      });

    const tool = globalToolRegistry.get('add_text_clip');
    const result = await tool!.handler(
      {
        sequenceId: 'seq-1',
        text: 'Auto placed subtitle',
        startTime: 1,
        duration: 2,
        preset: 'subtitle',
      },
      CTX,
    );

    expect(result.success).toBe(true);
    expect(findExecutedCommand('AddTextClip')).toMatchObject({
      type: 'AddTextClip',
      payload: {
        textData: {
          position: { x: 0.5, y: expect.any(Number) },
        },
      },
    });
    const addPayload = findExecutedCommand('AddTextClip').payload as {
      textData: { position: { y: number } };
    };
    expect(addPayload.textData.position.y).toBeLessThan(0.3);
    expect(result.result).toMatchObject({
      placement: {
        candidate: 'upper_center',
        obstacleCount: 1,
      },
    });
  });

  it('should ignore hidden tracks and disabled clips when collecting placement obstacles', async () => {
    const hiddenClip = createClip({
      id: 'clip-hidden',
      assetId: 'asset-hidden',
      place: { timelineInSec: 0, durationSec: 8 },
      range: { sourceInSec: 0, sourceOutSec: 8 },
    });
    const disabledClip = createClip({
      id: 'clip-disabled',
      assetId: 'asset-disabled',
      enabled: false,
      place: { timelineInSec: 0, durationSec: 8 },
      range: { sourceInSec: 0, sourceOutSec: 8 },
    });
    mockProject(
      createSequence({
        tracks: [
          createTrack({ id: 'track-hidden', visible: false, clips: [hiddenClip] }),
          createTrack({ id: 'track-disabled', clips: [disabledClip] }),
          createTrack({ id: 'track-visible', clips: [] }),
        ],
      }),
    );

    const tool = globalToolRegistry.get('add_text_clip');
    const result = await tool!.handler(
      {
        sequenceId: 'seq-1',
        text: 'Visible placement',
        startTime: 1,
        duration: 2,
        preset: 'subtitle',
      },
      CTX,
    );

    expect(result.success).toBe(true);
    expect(commands.getAnnotation).not.toHaveBeenCalled();
  });

  it('should update text data and clip transform while preserving existing style fields', async () => {
    const textClip = createClip({
      id: 'clip-text-1',
      assetId: `${TEXT_ASSET_PREFIX}clip-text-1`,
      effects: ['effect-text-1'],
      transform: {
        position: { x: 0.4, y: 0.3 },
        scale: { x: 1, y: 1 },
        rotationDeg: 0,
        anchor: { x: 0.5, y: 0.5 },
      },
    });
    mockProject(
      createSequence({
        tracks: [createTrack({ clips: [textClip] })],
      }),
      [createTextEffect()],
    );

    const tool = globalToolRegistry.get('update_text_clip');
    const result = await tool!.handler(
      {
        sequenceId: 'seq-1',
        clipId: 'clip-text-1',
        text: 'Updated Text',
        fontSize: 64,
        color: '#AABBCC',
        outline: null,
        transform: {
          scale: { x: 1.5, y: 1.25 },
          rotationDeg: 15,
        },
      },
      CTX,
    );

    expect(result.success).toBe(true);
    expect(executeCommandMock).toHaveBeenCalledTimes(2);
    const updateCommand = executeCommandMock.mock.calls[0][0] as {
      type: string;
      payload: { textData: Record<string, unknown> };
    };
    expect(updateCommand.type).toBe('UpdateTextClip');
    expect(updateCommand.payload.textData).toMatchObject({
      content: 'Updated Text',
      style: {
        fontFamily: 'Inter',
        fontSize: 64,
        fontWeight: 500,
        color: '#AABBCC',
      },
      position: { x: 0.4, y: 0.3 },
      shadow: { color: '#000000', offsetX: 2, offsetY: 3, blur: 4 },
    });
    expect((updateCommand.payload.textData as { outline?: unknown }).outline).toBeUndefined();
    expect(executeCommandMock.mock.calls[1][0]).toMatchObject({
      type: 'SetClipTransform',
      payload: {
        sequenceId: 'seq-1',
        trackId: 'track-video-1',
        clipId: 'clip-text-1',
        transform: {
          position: { x: 0.4, y: 0.3 },
          scale: { x: 1.5, y: 1.25 },
          rotationDeg: 15,
        },
      },
    });
  });

  it('should preserve preview transform when styling a dragged text clip', async () => {
    const textClip = createClip({
      id: 'clip-text-1',
      assetId: `${TEXT_ASSET_PREFIX}clip-text-1`,
      effects: ['effect-text-1'],
      transform: {
        position: { x: 0.72, y: 0.64 },
        scale: { x: 1.4, y: 1.1 },
        rotationDeg: 18,
        anchor: { x: 0.5, y: 0.5 },
      },
    });
    mockProject(
      createSequence({
        tracks: [createTrack({ clips: [textClip] })],
      }),
      [createTextEffect()],
    );

    const tool = globalToolRegistry.get('update_text_clip');
    const result = await tool!.handler(
      {
        sequenceId: 'seq-1',
        clipId: 'clip-text-1',
        fontSize: 72,
      },
      CTX,
    );

    expect(result.success).toBe(true);
    expect(executeCommandMock).toHaveBeenCalledTimes(1);
    const updateCommand = executeCommandMock.mock.calls[0][0] as {
      type: string;
      payload: { textData: Record<string, unknown> };
    };
    expect(updateCommand.type).toBe('UpdateTextClip');
    expect(updateCommand.payload.textData).toMatchObject({
      style: {
        fontSize: 72,
      },
      position: { x: 0.72, y: 0.64 },
      rotation: 18,
    });
  });

  it('should list text clips with resolved editable style and transform data', async () => {
    const textClip = createClip({
      id: 'clip-text-1',
      assetId: `${TEXT_ASSET_PREFIX}clip-text-1`,
      effects: ['effect-text-1'],
    });
    mockProject(
      createSequence({
        tracks: [createTrack({ clips: [textClip, createClip({ id: 'clip-video-1' })] })],
      }),
      [createTextEffect()],
    );

    const tool = globalToolRegistry.get('list_text_clips');
    const result = await tool!.handler({ sequenceId: 'seq-1' }, CTX);

    expect(result.success).toBe(true);
    expect(result.result).toMatchObject({
      sequenceId: 'seq-1',
      count: 1,
      clips: [
        {
          clipId: 'clip-text-1',
          trackId: 'track-video-1',
          textData: {
            content: 'Original Text',
            style: {
              fontFamily: 'Inter',
              fontSize: 48,
              fontWeight: 500,
            },
            position: { x: 0.4, y: 0.3 },
          },
          transform: {
            position: { x: 0.5, y: 0.5 },
          },
        },
      ],
    });
    expect(executeCommandMock).not.toHaveBeenCalled();
  });

  it('should reject deleting non-text clips', async () => {
    mockProject(
      createSequence({
        tracks: [createTrack({ clips: [createClip({ id: 'clip-video-1' })] })],
      }),
    );

    const tool = globalToolRegistry.get('delete_text_clip');
    const result = await tool!.handler(
      {
        sequenceId: 'seq-1',
        clipId: 'clip-video-1',
      },
      CTX,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('not a text clip');
    expect(executeCommandMock).not.toHaveBeenCalled();
  });
});
