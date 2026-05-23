import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { globalToolRegistry, type ToolDefinition } from '@/agents/ToolRegistry';
import {
  registerGenerativeTimelineTools,
  unregisterGenerativeTimelineTools,
} from './generativeTimelineTools';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

const mockedInvoke = vi.mocked(invoke);

function registerStubTool(tool: ToolDefinition): void {
  globalToolRegistry.register(tool);
}

describe('generativeTimelineTools', () => {
  beforeEach(() => {
    globalToolRegistry.clear();
    mockedInvoke.mockReset();
    registerGenerativeTimelineTools();
  });

  afterEach(() => {
    unregisterGenerativeTimelineTools();
    globalToolRegistry.clear();
  });

  it('submits video generation with pending timeline placement metadata', async () => {
    const addMarker = vi.fn().mockResolvedValue({
      success: true,
      result: { createdIds: ['marker-1'] },
    });
    const generateVideo = vi.fn().mockResolvedValue({
      success: true,
      result: { jobId: 'job-1', estimatedCostCents: 12 },
    });

    registerStubTool({
      name: 'add_marker',
      description: 'add marker',
      category: 'timeline',
      parameters: { type: 'object' },
      handler: addMarker,
    });
    registerStubTool({
      name: 'generate_video',
      description: 'generate video',
      category: 'generation',
      parameters: { type: 'object' },
      handler: generateVideo,
    });

    const result = await globalToolRegistry.execute(
      'generate_timeline_media',
      {
        prompt: 'Cinematic neon street shot',
        mediaType: 'video',
        sequenceId: 'seq-1',
        trackId: 'video-1',
        timelineStart: 4,
      },
      {},
    );

    expect(result.success).toBe(true);
    expect(addMarker).toHaveBeenCalledWith(
      expect.objectContaining({
        sequenceId: 'seq-1',
        time: 4,
      }),
      expect.anything(),
    );
    expect(generateVideo).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'Cinematic neon street shot',
        placement: expect.objectContaining({
          sequenceId: 'seq-1',
          trackId: 'video-1',
          timelineStart: 4,
          markerId: 'marker-1',
        }),
      }),
      expect.anything(),
    );
    expect(result.result).toMatchObject({
      status: 'submitted',
      jobId: 'job-1',
      pendingTimeline: {
        markerId: 'marker-1',
      },
      nextAction: 'resolve_generation_job',
    });
  });

  it('uses active timeline context for pending placement when explicit args are omitted', async () => {
    const addMarker = vi.fn().mockResolvedValue({
      success: true,
      result: { createdIds: ['marker-from-context'] },
    });
    const generateVideo = vi.fn().mockResolvedValue({
      success: true,
      result: { jobId: 'job-context', estimatedCostCents: 18 },
    });

    registerStubTool({
      name: 'add_marker',
      description: 'add marker',
      category: 'timeline',
      parameters: { type: 'object' },
      handler: addMarker,
    });
    registerStubTool({
      name: 'generate_video',
      description: 'generate video',
      category: 'generation',
      parameters: { type: 'object' },
      handler: generateVideo,
    });

    const result = await globalToolRegistry.execute(
      'generate_timeline_media',
      {
        prompt: 'Wide establishing shot',
        mediaType: 'video',
      },
      {
        sequenceId: 'seq-active',
        selectedTrackIds: ['video-active'],
        playheadPosition: 12.5,
      },
    );

    expect(result.success).toBe(true);
    expect(addMarker).toHaveBeenCalledWith(
      expect.objectContaining({
        sequenceId: 'seq-active',
        time: 12.5,
      }),
      expect.anything(),
    );
    expect(generateVideo).toHaveBeenCalledWith(
      expect.objectContaining({
        placement: expect.objectContaining({
          sequenceId: 'seq-active',
          trackId: 'video-active',
          timelineStart: 12.5,
          markerId: 'marker-from-context',
        }),
      }),
      expect.anything(),
    );
  });

  it('rejects pending generation when no placement target is available', async () => {
    registerStubTool({
      name: 'generate_video',
      description: 'generate video',
      category: 'generation',
      parameters: { type: 'object' },
      handler: vi.fn().mockResolvedValue({
        success: true,
        result: { jobId: 'job-1', estimatedCostCents: 12 },
      }),
    });

    const result = await globalToolRegistry.execute('generate_timeline_media', {
      prompt: 'Shot without target track',
      mediaType: 'video',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('requires sequenceId and trackId');
  });

  it('treats unresolved generation status as a successful pending sync', async () => {
    registerStubTool({
      name: 'check_generation_status',
      description: 'check',
      category: 'generation',
      parameters: { type: 'object' },
      handler: vi.fn().mockResolvedValue({
        success: true,
        result: { status: 'processing', progress: 45, assetId: null },
      }),
    });

    const result = await globalToolRegistry.execute('resolve_generation_job', { jobId: 'job-1' });

    expect(result.success).toBe(true);
    expect(result.result).toMatchObject({
      status: 'processing',
      pending: true,
      progress: 45,
    });
  });

  it('returns failure for failed generation jobs instead of treating them as pending', async () => {
    registerStubTool({
      name: 'check_generation_status',
      description: 'check',
      category: 'generation',
      parameters: { type: 'object' },
      handler: vi.fn().mockResolvedValue({
        success: true,
        result: { status: 'failed', progress: 100, assetId: null, error: 'provider quota exceeded' },
      }),
    });

    const result = await globalToolRegistry.execute('resolve_generation_job', { jobId: 'job-1' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('provider quota exceeded');
    expect(result.result).toMatchObject({
      status: 'failed',
      pending: false,
    });
  });

  it('ranks usable sound candidates before blocked candidates', async () => {
    registerStubTool({
      name: 'search_stock_media',
      description: 'search stock',
      category: 'analysis',
      parameters: { type: 'object' },
      handler: vi.fn().mockResolvedValue({
        success: true,
        result: {
          assets: [
            {
              id: 'blocked',
              durationSec: 1,
              licensePolicy: { status: 'blocked', reasons: ['No commercial use'] },
            },
            {
              id: 'usable',
              durationSec: 2,
              licensePolicy: { status: 'allowed', reasons: [] },
            },
          ],
          policySummary: { allowed: 1, blocked: 1 },
        },
      }),
    });

    const result = await globalToolRegistry.execute('search_sound_for_scene', {
      sceneDescription: 'fast transition whoosh',
      durationSec: 2,
    });

    expect(result.success).toBe(true);
    expect(result.result).toMatchObject({
      recommendedCandidates: [expect.objectContaining({ id: 'usable' })],
      blockedCandidates: [expect.objectContaining({ id: 'blocked' })],
      nextAction: 'import_asset_candidate',
    });
  });

  it('imports approved stock candidates through the backend license gate', async () => {
    mockedInvoke.mockResolvedValue({
      assetId: 'asset-1',
      name: 'whoosh',
      localPath: '/project/.openreelio/imports/stock/whoosh.mp3',
      opId: 'op-1',
      licenseSnapshotPath: '/project/.openreelio/licenses/whoosh.json',
    });

    const result = await globalToolRegistry.execute('import_asset_candidate', {
      licenseAck: true,
      candidate: {
        name: 'whoosh',
        assetType: 'audio',
        provider: 'openverse',
        durationSec: 1.3,
        tags: ['whoosh'],
        license: {
          source: 'stock_provider',
          provider: 'Openverse',
          licenseType: 'cc0',
          allowedUse: ['commercial'],
        },
        licensePolicy: { status: 'allowed', reasons: [] },
        metadata: {
          downloadUrl: 'https://cdn.example/whoosh.mp3',
          providerUrl: 'https://openverse.org/audio/1',
        },
      },
    });

    expect(result.success).toBe(true);
    expect(mockedInvoke).toHaveBeenCalledWith('import_stock_media_asset', {
      sourceUrl: 'https://cdn.example/whoosh.mp3',
      name: 'whoosh',
      assetType: 'audio',
      provider: 'openverse',
      license: expect.objectContaining({ provider: 'Openverse' }),
      licenseAck: true,
      durationSec: 1.3,
      tags: ['whoosh'],
      providerUrl: 'https://openverse.org/audio/1',
    });
  });

  it('rejects stock candidate import without license acknowledgement', async () => {
    const result = await globalToolRegistry.execute('import_asset_candidate', {
      licenseAck: false,
      candidate: {
        name: 'whoosh',
        metadata: { downloadUrl: 'https://cdn.example/whoosh.mp3' },
      },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('licenseAck=true');
  });
});
