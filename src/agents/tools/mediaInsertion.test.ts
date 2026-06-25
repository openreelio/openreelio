import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useProjectStore } from '@/stores/projectStore';
import { insertAgentMediaClip } from './mediaInsertion';
import type { Clip, Command, CommandResult, Sequence, Track } from '@/types';

const originalExecuteCommand = useProjectStore.getState().executeCommand;

function createClip(id: string, linkGroupId?: string): Clip {
  return {
    id,
    assetId: 'asset-video',
    range: { sourceInSec: 1, sourceOutSec: 5 },
    place: { timelineInSec: 2, durationSec: 4 },
    transform: {
      position: { x: 0, y: 0 },
      scale: { x: 1, y: 1 },
      rotationDeg: 0,
      anchor: { x: 0.5, y: 0.5 },
    },
    opacity: 1,
    speed: 1,
    effects: [],
    audio: { volumeDb: 0, pan: 0, muted: false },
    linkGroupId,
  };
}

function createTrack(id: string, kind: Track['kind'], name: string, clips: Clip[] = []): Track {
  return {
    id,
    kind,
    name,
    clips,
    blendMode: 'normal',
    muted: false,
    locked: false,
    visible: true,
    volume: 1,
  };
}

function createSequence(tracks: Track[]): Sequence {
  return {
    id: 'seq-1',
    name: 'Main',
    format: {
      canvas: { width: 1920, height: 1080 },
      fps: { num: 30, den: 1 },
      audioSampleRate: 48000,
      audioChannels: 2,
    },
    tracks,
    markers: [],
  };
}

describe('insertAgentMediaClip', () => {
  let executeCommand: ReturnType<typeof vi.fn>;

  function setProjectSequence(tracks: Track[]): void {
    useProjectStore.setState({
      sequences: new Map([['seq-1', createSequence(tracks)]]),
    });
  }

  beforeEach(() => {
    executeCommand = vi.fn(
      async (): Promise<CommandResult> => ({
        opId: 'op-insert-media',
        changes: [],
        createdIds: ['clip-video', 'clip-audio'],
        deletedIds: [],
      }),
    );

    useProjectStore.setState({
      isLoaded: true,
      meta: {
        id: 'project-1',
        name: 'Project',
        path: '/project',
        createdAt: '2026-05-26T00:00:00.000Z',
        modifiedAt: '2026-05-26T00:00:00.000Z',
      },
      activeSequenceId: 'seq-1',
      executeCommand: executeCommand as unknown as (command: Command) => Promise<CommandResult>,
    });
    setProjectSequence([
      createTrack('video-1', 'video', 'Video 1', [createClip('clip-video', 'link-1')]),
      createTrack('audio-1', 'audio', 'Audio 1', [createClip('clip-audio', 'link-1')]),
    ]);
  });

  afterEach(() => {
    useProjectStore.setState({
      isLoaded: false,
      meta: null,
      sequences: new Map(),
      activeSequenceId: null,
      executeCommand: originalExecuteCommand,
    });
  });

  it('should dispatch a single InsertMedia command with the resolved payload', async () => {
    await insertAgentMediaClip({
      sequenceId: 'seq-1',
      trackId: 'video-1',
      assetId: 'asset-video',
      timelineStart: 2,
      sourceIn: 1,
      sourceOut: 5,
    });

    expect(executeCommand).toHaveBeenCalledTimes(1);
    expect(executeCommand).toHaveBeenCalledWith({
      type: 'InsertMedia',
      payload: {
        sequenceId: 'seq-1',
        trackId: 'video-1',
        assetId: 'asset-video',
        timelineStart: 2,
        sourceIn: 1,
        sourceOut: 5,
        audioOnly: false,
        autoExtractLinkedAudio: true,
      },
    });
  });

  it('should surface the primary clip and linked audio from refreshed state', async () => {
    const result = await insertAgentMediaClip({
      sequenceId: 'seq-1',
      trackId: 'video-1',
      assetId: 'asset-video',
      timelineStart: 2,
    });

    expect(result).toMatchObject({
      clipId: 'clip-video',
      sourceIn: 1,
      sourceOut: 5,
      durationSec: 4,
      linkedAudio: {
        trackId: 'audio-1',
        clipId: 'clip-audio',
        createdTrack: false,
      },
    });
  });

  it('should flag a newly created linked audio track when its id is in createdIds', async () => {
    executeCommand.mockResolvedValueOnce({
      opId: 'op-insert-media',
      changes: [],
      createdIds: ['clip-video', 'audio-2', 'clip-audio'],
      deletedIds: [],
    });
    setProjectSequence([
      createTrack('video-1', 'video', 'Video 1', [createClip('clip-video', 'link-1')]),
      createTrack('audio-2', 'audio', 'Audio 2', [createClip('clip-audio', 'link-1')]),
    ]);

    const result = await insertAgentMediaClip({
      sequenceId: 'seq-1',
      trackId: 'video-1',
      assetId: 'asset-video',
      timelineStart: 2,
    });

    expect(result.linkedAudio).toEqual({
      trackId: 'audio-2',
      clipId: 'clip-audio',
      createdTrack: true,
    });
  });

  it('should omit linked audio when the primary clip has no link group', async () => {
    executeCommand.mockResolvedValueOnce({
      opId: 'op-insert-media',
      changes: [],
      createdIds: ['clip-video'],
      deletedIds: [],
    });
    setProjectSequence([createTrack('video-1', 'video', 'Video 1', [createClip('clip-video')])]);

    const result = await insertAgentMediaClip({
      sequenceId: 'seq-1',
      trackId: 'video-1',
      assetId: 'asset-video',
      timelineStart: 2,
    });

    expect(result.linkedAudio).toBeUndefined();
  });

  it('should reject invalid timeline starts before dispatching any command', async () => {
    await expect(
      insertAgentMediaClip({
        sequenceId: 'seq-1',
        trackId: 'video-1',
        assetId: 'asset-video',
        timelineStart: Number.NaN,
      }),
    ).rejects.toThrow('timelineStart must be a finite non-negative number');

    expect(executeCommand).not.toHaveBeenCalled();
  });

  it('should reject invalid explicit source ranges before dispatching any command', async () => {
    await expect(
      insertAgentMediaClip({
        sequenceId: 'seq-1',
        trackId: 'video-1',
        assetId: 'asset-video',
        timelineStart: 2,
        sourceIn: -1,
      }),
    ).rejects.toThrow('sourceIn must be a finite non-negative number');

    expect(executeCommand).not.toHaveBeenCalled();
  });

  it('should reject InsertMedia responses without a primary clip id', async () => {
    executeCommand.mockResolvedValueOnce({
      opId: 'op-insert-media',
      changes: [],
      createdIds: [],
      deletedIds: [],
    });

    await expect(
      insertAgentMediaClip({
        sequenceId: 'seq-1',
        trackId: 'video-1',
        assetId: 'asset-video',
        timelineStart: 2,
      }),
    ).rejects.toThrow('InsertMedia did not return a created clip id');
  });

  it('should propagate backend validation errors from the InsertMedia command', async () => {
    executeCommand.mockRejectedValueOnce(new Error('will not show in preview'));

    await expect(
      insertAgentMediaClip({
        sequenceId: 'seq-1',
        trackId: 'audio-1',
        assetId: 'asset-video',
        timelineStart: 0,
      }),
    ).rejects.toThrow('will not show in preview');
  });
});
