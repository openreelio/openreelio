import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { executeAgentCommand } from '@/agents/tools/commandExecutor';
import { insertAgentMediaClip } from '@/agents/tools/mediaInsertion';
import { useVideoGenStore, type VideoGenJob, type VideoGenPlacementRequest } from './videoGenStore';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('@/agents/tools/commandExecutor', () => ({
  executeAgentCommand: vi.fn(),
}));

vi.mock('@/agents/tools/mediaInsertion', () => ({
  insertAgentMediaClip: vi.fn(),
}));

const mockedInvoke = vi.mocked(invoke);
const mockedExecuteAgentCommand = vi.mocked(executeAgentCommand);
const mockedInsertAgentMediaClip = vi.mocked(insertAgentMediaClip);

function createJob(overrides: Partial<VideoGenJob> = {}): VideoGenJob {
  return {
    id: 'job-1',
    providerJobId: 'provider-job-1',
    prompt: 'Generate a shot',
    mode: 'text_to_video',
    quality: 'pro',
    durationSec: 6,
    status: 'downloading',
    progress: 100,
    estimatedCostCents: 10,
    actualCostCents: null,
    assetId: null,
    placement: null,
    placedClipId: null,
    placementError: null,
    error: null,
    createdAt: '2026-05-23T00:00:00.000Z',
    completedAt: null,
    ...overrides,
  };
}

describe('videoGenStore placement sync', () => {
  beforeEach(() => {
    mockedInvoke.mockReset();
    mockedExecuteAgentCommand.mockReset();
    mockedInsertAgentMediaClip.mockReset();
    useVideoGenStore.getState().stopPolling();
    useVideoGenStore.setState({
      jobs: new Map(),
      isPolling: false,
      pollingIntervalId: null,
      isPollInFlight: false,
      completionInFlight: new Set(),
    });
  });

  it('places generated assets on the timeline when placement metadata is present', async () => {
    useVideoGenStore.setState({
      jobs: new Map([
        [
          'job-1',
          createJob({
            placement: {
              sequenceId: 'seq-1',
              trackId: 'video-1',
              timelineStart: 3,
              markerId: 'marker-1',
              removeMarkerOnPlace: true,
            },
          }),
        ],
      ]),
    });

    mockedInvoke.mockImplementation(async (command) => {
      if (command === 'download_generated_video') return { outputPath: '/project/generated.mp4' };
      if (command === 'import_asset') return { id: 'asset-generated' };
      if (command === 'generate_asset_thumbnail') return null;
      throw new Error(`Unhandled invoke: ${command}`);
    });
    mockedInsertAgentMediaClip.mockResolvedValue({
      insertResult: {
        opId: 'op-insert',
        changes: [],
        createdIds: ['clip-generated'],
        deletedIds: [],
      },
      clipId: 'clip-generated',
      sequenceId: 'seq-1',
      trackId: 'video-1',
      assetId: 'asset-generated',
      timelineStart: 3,
      durationSec: 6,
    });
    mockedExecuteAgentCommand.mockImplementation(async (commandType) => ({
      opId: commandType === 'RemoveMarker' ? 'op-marker' : 'op-command',
      changes: [],
      createdIds: [],
      deletedIds: commandType === 'RemoveMarker' ? ['marker-1'] : [],
    }));

    await useVideoGenStore.getState().onJobCompleted('job-1');

    const job = useVideoGenStore.getState().getJob('job-1');
    expect(job).toMatchObject({
      status: 'completed',
      assetId: 'asset-generated',
      placedClipId: 'clip-generated',
      placementError: null,
    });
    expect(mockedInsertAgentMediaClip).toHaveBeenCalledWith({
      sequenceId: 'seq-1',
      trackId: 'video-1',
      assetId: 'asset-generated',
      timelineStart: 3,
    });
    expect(mockedExecuteAgentCommand).toHaveBeenCalledWith('RemoveMarker', {
      sequenceId: 'seq-1',
      markerId: 'marker-1',
    });
  });

  it('ignores malformed placement input during generation submission', async () => {
    mockedInvoke.mockImplementation(async (command) => {
      if (command === 'submit_video_generation') {
        return {
          jobId: 'backend-job-1',
          providerJobId: 'provider-job-1',
          estimatedCostCents: 10,
        };
      }
      throw new Error(`Unhandled invoke: ${command}`);
    });

    const jobId = await useVideoGenStore.getState().submitGeneration({
      prompt: 'Generate a shot',
      placement: 'invalid-placement' as unknown as VideoGenPlacementRequest,
    });

    const job = useVideoGenStore.getState().getJob(jobId);
    expect(job?.placement).toBeNull();
  });

  it('keeps the imported asset when automatic placement fails', async () => {
    useVideoGenStore.setState({
      jobs: new Map([
        [
          'job-1',
          createJob({
            placement: {
              sequenceId: 'seq-1',
              trackId: 'video-1',
              timelineStart: 3,
            },
          }),
        ],
      ]),
    });

    mockedInvoke.mockImplementation(async (command) => {
      if (command === 'download_generated_video') return { outputPath: '/project/generated.mp4' };
      if (command === 'import_asset') return { id: 'asset-generated' };
      if (command === 'generate_asset_thumbnail') return null;
      throw new Error(`Unhandled invoke: ${command}`);
    });
    mockedInsertAgentMediaClip.mockRejectedValue(new Error('track is locked'));

    await useVideoGenStore.getState().onJobCompleted('job-1');

    const job = useVideoGenStore.getState().getJob('job-1');
    expect(job).toMatchObject({
      status: 'completed',
      assetId: 'asset-generated',
      placedClipId: null,
      placementError: 'track is locked',
    });
  });
});
