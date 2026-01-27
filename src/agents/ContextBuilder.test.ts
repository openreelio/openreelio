/**
 * Context Builder Tests
 *
 * TDD tests for building agent context from application state.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  ContextBuilder,
  buildAgentContext,
  AgentContextOptions,
} from './ContextBuilder';

// =============================================================================
// Mock Data
// =============================================================================

const mockProjectState = {
  activeSequenceId: 'seq_001',
  sequences: new Map([
    [
      'seq_001',
      {
        id: 'seq_001',
        name: 'Main Sequence',
        tracks: [
          {
            id: 'track_video_001',
            type: 'video',
            clips: [
              {
                id: 'clip_001',
                sourceId: 'asset_001',
                place: { timelineInSec: 0, durationSec: 10 },
              },
              {
                id: 'clip_002',
                sourceId: 'asset_002',
                place: { timelineInSec: 10, durationSec: 15 },
              },
            ],
          },
          {
            id: 'track_audio_001',
            type: 'audio',
            clips: [
              {
                id: 'clip_003',
                sourceId: 'asset_003',
                place: { timelineInSec: 5, durationSec: 20 },
              },
            ],
          },
        ],
      },
    ],
  ]),
  assets: new Map([
    ['asset_001', { id: 'asset_001', name: 'intro.mp4', type: 'video' }],
    ['asset_002', { id: 'asset_002', name: 'main.mp4', type: 'video' }],
    ['asset_003', { id: 'asset_003', name: 'music.mp3', type: 'audio' }],
  ]),
};

const mockTimelineState = {
  playhead: 5.5,
  selectedClipIds: ['clip_001', 'clip_002'],
  selectedTrackIds: ['track_video_001'],
  zoom: 1.0,
  scrollPosition: 0,
};

// =============================================================================
// Tests
// =============================================================================

describe('ContextBuilder', () => {
  let builder: ContextBuilder;

  beforeEach(() => {
    builder = new ContextBuilder();
  });

  describe('Basic Context Building', () => {
    it('creates an empty context by default', () => {
      const context = builder.build();

      expect(context).toBeDefined();
      expect(typeof context).toBe('object');
    });

    it('includes projectId when set', () => {
      const context = builder.withProjectId('proj_001').build();

      expect(context.projectId).toBe('proj_001');
    });

    it('includes sequenceId when set', () => {
      const context = builder.withSequenceId('seq_001').build();

      expect(context.sequenceId).toBe('seq_001');
    });

    it('includes playhead position when set', () => {
      const context = builder.withPlayheadPosition(5.5).build();

      expect(context.playheadPosition).toBe(5.5);
    });

    it('includes timeline duration when set', () => {
      const context = builder.withTimelineDuration(120).build();

      expect(context.timelineDuration).toBe(120);
    });
  });

  describe('Selection Context', () => {
    it('includes selected clip IDs', () => {
      const context = builder
        .withSelectedClips(['clip_001', 'clip_002'])
        .build();

      expect(context.selectedClipIds).toEqual(['clip_001', 'clip_002']);
    });

    it('includes selected track IDs', () => {
      const context = builder
        .withSelectedTracks(['track_001', 'track_002'])
        .build();

      expect(context.selectedTrackIds).toEqual(['track_001', 'track_002']);
    });
  });

  describe('Chaining', () => {
    it('supports method chaining', () => {
      const context = builder
        .withProjectId('proj_001')
        .withSequenceId('seq_001')
        .withPlayheadPosition(10)
        .withTimelineDuration(120)
        .withSelectedClips(['clip_001'])
        .withSelectedTracks(['track_001'])
        .build();

      expect(context.projectId).toBe('proj_001');
      expect(context.sequenceId).toBe('seq_001');
      expect(context.playheadPosition).toBe(10);
      expect(context.timelineDuration).toBe(120);
      expect(context.selectedClipIds).toEqual(['clip_001']);
      expect(context.selectedTrackIds).toEqual(['track_001']);
    });
  });

  describe('Metadata', () => {
    it('includes custom metadata', () => {
      const context = builder
        .withMetadata({
          customKey: 'customValue',
          anotherKey: 123,
        })
        .build();

      expect(context.metadata).toEqual({
        customKey: 'customValue',
        anotherKey: 123,
      });
    });

    it('merges metadata when called multiple times', () => {
      const context = builder
        .withMetadata({ key1: 'value1' })
        .withMetadata({ key2: 'value2' })
        .build();

      expect(context.metadata).toEqual({
        key1: 'value1',
        key2: 'value2',
      });
    });
  });

  describe('From Store State', () => {
    it('builds context from project state', () => {
      const context = builder.fromProjectState(mockProjectState).build();

      expect(context.sequenceId).toBe('seq_001');
    });

    it('builds context from timeline state', () => {
      const context = builder.fromTimelineState(mockTimelineState).build();

      expect(context.playheadPosition).toBe(5.5);
      expect(context.selectedClipIds).toEqual(['clip_001', 'clip_002']);
      expect(context.selectedTrackIds).toEqual(['track_video_001']);
    });

    it('calculates timeline duration from tracks', () => {
      const context = builder.fromProjectState(mockProjectState).build();

      // Max clip end: clip_003 ends at 5 + 20 = 25 seconds
      expect(context.timelineDuration).toBe(25);
    });

    it('combines multiple state sources', () => {
      const context = builder
        .fromProjectState(mockProjectState)
        .fromTimelineState(mockTimelineState)
        .build();

      expect(context.sequenceId).toBe('seq_001');
      expect(context.playheadPosition).toBe(5.5);
      expect(context.selectedClipIds).toEqual(['clip_001', 'clip_002']);
    });
  });

  describe('Clip Details', () => {
    it('includes detailed clip information when requested', () => {
      const context = builder
        .fromProjectState(mockProjectState)
        .fromTimelineState(mockTimelineState)
        .withClipDetails(true)
        .build();

      expect(context.metadata?.selectedClipDetails).toBeDefined();
      const details = context.metadata?.selectedClipDetails as Array<{
        id: string;
        sourceId: string;
        startTime: number;
        duration: number;
      }>;
      expect(details).toHaveLength(2);
      expect(details[0].id).toBe('clip_001');
    });

    it('does not include clip details by default', () => {
      const context = builder
        .fromProjectState(mockProjectState)
        .fromTimelineState(mockTimelineState)
        .build();

      expect(context.metadata?.selectedClipDetails).toBeUndefined();
    });
  });

  describe('Track Details', () => {
    it('includes track summary when requested', () => {
      const context = builder
        .fromProjectState(mockProjectState)
        .withTrackSummary(true)
        .build();

      expect(context.metadata?.trackSummary).toBeDefined();
      const summary = context.metadata?.trackSummary as Array<{
        id: string;
        type: string;
        clipCount: number;
      }>;
      expect(summary).toHaveLength(2);
      expect(summary[0].clipCount).toBe(2);
      expect(summary[1].clipCount).toBe(1);
    });
  });

  describe('Reset', () => {
    it('resets builder state', () => {
      builder
        .withProjectId('proj_001')
        .withSequenceId('seq_001');

      builder.reset();
      const context = builder.build();

      expect(context.projectId).toBeUndefined();
      expect(context.sequenceId).toBeUndefined();
    });
  });
});

describe('buildAgentContext', () => {
  it('builds context from options', () => {
    const options: AgentContextOptions = {
      projectState: mockProjectState,
      timelineState: mockTimelineState,
      includeClipDetails: true,
    };

    const context = buildAgentContext(options);

    expect(context.sequenceId).toBe('seq_001');
    expect(context.playheadPosition).toBe(5.5);
    expect(context.selectedClipIds).toEqual(['clip_001', 'clip_002']);
    expect(context.metadata?.selectedClipDetails).toBeDefined();
  });

  it('builds minimal context with no options', () => {
    const context = buildAgentContext({});

    expect(context).toBeDefined();
    expect(context.sequenceId).toBeUndefined();
  });
});
