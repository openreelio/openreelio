import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { globalToolRegistry, type AgentContext } from '@/agents';
import { registerCaptionTools, unregisterCaptionTools } from './captionTools';
import { useProjectStore } from '@/stores/projectStore';
import type { Clip, Sequence, Track } from '@/types';

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

  beforeAll(() => {
    registerCaptionTools();
  });

  afterAll(() => {
    unregisterCaptionTools();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    executeCommandMock.mockResolvedValue({
      opId: 'op-caption',
      success: true,
      createdIds: ['cap-created'],
      deletedIds: [],
      changes: [],
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
        color: { r: 17, g: 34, b: 51, a: 204 },
        backgroundColor: { r: 0, g: 0, b: 0, a: 102 },
      },
      position: {
        type: 'preset',
        vertical: 'top',
        marginPercent: 5,
      },
    });

    expect((command.payload.style as Record<string, unknown>).position).toBeUndefined();
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
});
