import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useProjectStore } from '@/stores/projectStore';
import { insertAgentMediaClip } from './mediaInsertion';
import type { Asset, Command, CommandResult, Sequence, Track } from '@/types';

const originalExecuteCommand = useProjectStore.getState().executeCommand;
const originalUndo = useProjectStore.getState().undo;

function createTrack(id: string, kind: Track['kind'], name: string): Track {
  return {
    id,
    kind,
    name,
    clips: [],
    blendMode: 'normal',
    muted: false,
    locked: false,
    visible: true,
    volume: 1,
  };
}

function createVideoAsset(overrides: Partial<Asset> = {}): Asset {
  return {
    id: 'asset-video',
    kind: 'video',
    name: 'Interview',
    uri: '/project/media/interview.mp4',
    hash: 'hash-video',
    durationSec: 12,
    fileSize: 1024,
    importedAt: '2026-05-26T00:00:00.000Z',
    video: {
      width: 1920,
      height: 1080,
      fps: { num: 30, den: 1 },
      codec: 'h264',
      hasAlpha: false,
    },
    audio: {
      sampleRate: 48000,
      channels: 2,
      codec: 'aac',
    },
    license: {
      source: 'user',
      licenseType: 'unknown',
      allowedUse: [],
    },
    tags: [],
    proxyStatus: 'notNeeded',
    ...overrides,
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

  beforeEach(() => {
    executeCommand = vi.fn(async (command: Command): Promise<CommandResult> => {
      if (command.type === 'InsertClip') {
        return {
          opId: command.payload.trackId === 'audio-1' ? 'op-audio' : 'op-video',
          changes: [],
          createdIds: [command.payload.trackId === 'audio-1' ? 'clip-audio' : 'clip-video'],
          deletedIds: [],
        };
      }

      return {
        opId: `op-${command.type}`,
        changes: [],
        createdIds: [],
        deletedIds: [],
      };
    });

    const videoTrack = createTrack('video-1', 'video', 'Video 1');
    const audioTrack = createTrack('audio-1', 'audio', 'Audio 1');
    useProjectStore.setState({
      isLoaded: true,
      meta: {
        id: 'project-1',
        name: 'Project',
        path: '/project',
        createdAt: '2026-05-26T00:00:00.000Z',
        modifiedAt: '2026-05-26T00:00:00.000Z',
      },
      assets: new Map([['asset-video', createVideoAsset()]]),
      sequences: new Map([['seq-1', createSequence([videoTrack, audioTrack])]]),
      activeSequenceId: 'seq-1',
      executeCommand: executeCommand as unknown as (command: Command) => Promise<CommandResult>,
      undo: vi.fn(async () => ({ success: true, canUndo: false, canRedo: false })),
    });
  });

  afterEach(() => {
    useProjectStore.setState({
      isLoaded: false,
      meta: null,
      assets: new Map(),
      sequences: new Map(),
      activeSequenceId: null,
      executeCommand: originalExecuteCommand,
      undo: originalUndo,
    });
  });

  it('should insert video through visual track and mirror the source range to linked audio', async () => {
    const result = await insertAgentMediaClip({
      sequenceId: 'seq-1',
      trackId: 'video-1',
      assetId: 'asset-video',
      timelineStart: 2,
      sourceIn: 1,
      sourceOut: 5,
    });

    expect(result).toMatchObject({
      clipId: 'clip-video',
      durationSec: 4,
      linkedAudio: {
        trackId: 'audio-1',
        clipId: 'clip-audio',
        createdTrack: false,
      },
    });
    expect(executeCommand).toHaveBeenNthCalledWith(1, {
      type: 'InsertClip',
      payload: {
        sequenceId: 'seq-1',
        trackId: 'video-1',
        assetId: 'asset-video',
        timelineStart: 2,
        sourceIn: 1,
        sourceOut: 5,
      },
    });
    expect(executeCommand).toHaveBeenNthCalledWith(2, {
      type: 'InsertClip',
      payload: {
        sequenceId: 'seq-1',
        trackId: 'audio-1',
        assetId: 'asset-video',
        timelineStart: 2,
        sourceIn: 1,
        sourceOut: 5,
      },
    });
    expect(executeCommand).toHaveBeenNthCalledWith(3, {
      type: 'LinkClips',
      payload: {
        sequenceId: 'seq-1',
        clipRefs: [
          { trackId: 'video-1', clipId: 'clip-video' },
          { trackId: 'audio-1', clipId: 'clip-audio' },
        ],
      },
    });
    expect(executeCommand).toHaveBeenNthCalledWith(4, {
      type: 'SetClipMute',
      payload: {
        sequenceId: 'seq-1',
        trackId: 'video-1',
        clipId: 'clip-video',
        muted: true,
      },
    });
  });

  it('should reject accidental video insertion onto audio tracks before creating invisible preview clips', async () => {
    await expect(
      insertAgentMediaClip({
        sequenceId: 'seq-1',
        trackId: 'audio-1',
        assetId: 'asset-video',
        timelineStart: 0,
      }),
    ).rejects.toThrow('will not show in preview');

    expect(executeCommand).not.toHaveBeenCalled();
  });

  it('should reject invalid timeline starts before executing commands', async () => {
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

  it('should rollback already-applied media commands when linked audio insertion fails', async () => {
    const undo = vi.fn(async () => ({ success: true, canUndo: false, canRedo: false }));
    useProjectStore.setState({ undo });
    executeCommand
      .mockResolvedValueOnce({
        opId: 'op-video',
        changes: [],
        createdIds: ['clip-video'],
        deletedIds: [],
      })
      .mockRejectedValueOnce(new Error('linked audio insert failed'));

    await expect(
      insertAgentMediaClip({
        sequenceId: 'seq-1',
        trackId: 'video-1',
        assetId: 'asset-video',
        timelineStart: 2,
      }),
    ).rejects.toThrow('linked audio insert failed');

    expect(undo).toHaveBeenCalledTimes(1);
  });
});
