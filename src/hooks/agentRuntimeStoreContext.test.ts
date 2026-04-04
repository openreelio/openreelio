import { describe, expect, it } from 'vitest';
import type { AgentContext } from '@/agents/engine/core/types';
import { buildAgentContextFromStoreSnapshots } from './agentRuntimeStoreContext';

describe('buildAgentContextFromStoreSnapshots', () => {
  it('should build a shared agent context from store snapshots', () => {
    const context = buildAgentContextFromStoreSnapshots(
      {
        currentTime: 12,
        duration: 90,
        selectedClipIds: ['clip-1'],
        selectedTrackIds: ['track-1'],
        activeSequenceId: 'sequence-1',
        projectStateVersion: 42,
        sequences: new Map([
          [
            'sequence-1',
            {
              tracks: [
                {
                  id: 'track-1',
                  name: 'Video Track',
                  kind: 'video',
                  clips: [
                    {
                      id: 'clip-1',
                      assetId: 'asset-1',
                      place: { timelineInSec: 0 },
                    },
                  ],
                },
              ],
            },
          ],
        ]),
        assets: new Map([
          ['asset-1', { id: 'asset-1', name: 'Intro', kind: 'video', durationSec: 5 }],
          ['asset-2', { id: 'asset-2', name: 'Music', kind: 'audio', durationSec: 30 }],
        ]),
        uiLanguage: 'en',
      },
      {
        projectId: 'project-123',
      } satisfies Partial<AgentContext>,
    );

    expect(context.projectId).toBe('project-123');
    expect(context.sequenceId).toBe('sequence-1');
    expect(context.playheadPosition).toBe(12);
    expect(context.timelineDuration).toBe(90);
    expect(context.selectedClips).toEqual(['clip-1']);
    expect(context.selectedTracks).toEqual(['track-1']);
    expect(context.availableAssets).toEqual([
      { id: 'asset-1', name: 'Intro', type: 'video', duration: 5 },
      { id: 'asset-2', name: 'Music', type: 'audio', duration: 30 },
    ]);
    expect(context.availableTracks).toEqual([
      { id: 'track-1', name: 'Video Track', type: 'video', clipCount: 1 },
    ]);
    expect(Array.isArray(context.availableTools)).toBe(true);
  });
});
