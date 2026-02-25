/**
 * Environment Context Builder Tests
 */

import { describe, it, expect } from 'vitest';
import {
  buildEnvironmentContext,
  buildAssetContext,
  buildTrackContext,
  buildSelectionContext,
  buildToolsContext,
  buildFullEnvironmentPrompt,
} from './environment';
import { createEmptyContext } from '../core/types';

function makeContext(overrides: Record<string, unknown> = {}) {
  const base = createEmptyContext('test-project');
  return { ...base, ...overrides };
}

describe('buildEnvironmentContext', () => {
  it('should include project ID and basic metrics', () => {
    const ctx = makeContext({
      timelineDuration: 120,
      playheadPosition: 30.5,
    });
    const result = buildEnvironmentContext(ctx);

    expect(result).toContain('<environment>');
    expect(result).toContain('</environment>');
    expect(result).toContain('Project: test-project');
    expect(result).toContain('Timeline Duration: 2:00.00');
    expect(result).toContain('Playhead: 0:30.50');
  });

  it('should handle zero duration', () => {
    const ctx = makeContext();
    const result = buildEnvironmentContext(ctx);
    expect(result).toContain('Timeline Duration: 0:00.00');
  });
});

describe('buildAssetContext', () => {
  it('should return null when no assets', () => {
    const ctx = makeContext({ availableAssets: [] });
    expect(buildAssetContext(ctx)).toBeNull();
  });

  it('should list assets with details', () => {
    const ctx = makeContext({
      availableAssets: [
        { id: 'a1', name: 'Intro.mp4', type: 'video', duration: 15 },
        { id: 'a2', name: 'Music.mp3', type: 'audio', duration: 180 },
      ],
    });
    const result = buildAssetContext(ctx);

    expect(result).toContain('<assets>');
    expect(result).toContain('Intro.mp4');
    expect(result).toContain('video');
    expect(result).toContain('[id: a1]');
    expect(result).toContain('Music.mp3');
    expect(result).toContain('</assets>');
  });

  it('should truncate to maxItems', () => {
    const assets = Array.from({ length: 25 }, (_, i) => ({
      id: `a${i}`,
      name: `Asset${i}.mp4`,
      type: 'video' as const,
      duration: 10,
    }));
    const ctx = makeContext({ availableAssets: assets });
    const result = buildAssetContext(ctx, 5)!;

    expect(result).toContain('Asset0.mp4');
    expect(result).toContain('Asset4.mp4');
    expect(result).not.toContain('Asset5.mp4');
    expect(result).toContain('... and 20 more assets');
  });
});

describe('buildTrackContext', () => {
  it('should return null when no tracks', () => {
    const ctx = makeContext({ availableTracks: [] });
    expect(buildTrackContext(ctx)).toBeNull();
  });

  it('should list tracks with details', () => {
    const ctx = makeContext({
      availableTracks: [
        { id: 't1', name: 'Video 1', type: 'video', clipCount: 5 },
        { id: 't2', name: 'Audio 1', type: 'audio', clipCount: 3 },
      ],
    });
    const result = buildTrackContext(ctx);

    expect(result).toContain('<tracks>');
    expect(result).toContain('Video 1');
    expect(result).toContain('5 clips');
    expect(result).toContain('Audio 1');
    expect(result).toContain('</tracks>');
  });
});

describe('buildSelectionContext', () => {
  it('should return null when no selection', () => {
    const ctx = makeContext({ selectedClips: [] });
    expect(buildSelectionContext(ctx)).toBeNull();
  });

  it('should list selected clip IDs', () => {
    const ctx = makeContext({ selectedClips: ['c1', 'c2'] });
    const result = buildSelectionContext(ctx);

    expect(result).toContain('<selection>');
    expect(result).toContain('Clip: c1');
    expect(result).toContain('Clip: c2');
    expect(result).toContain('</selection>');
  });
});

describe('buildToolsContext', () => {
  it('should return null when no tools', () => {
    const ctx = makeContext({ availableTools: [] });
    expect(buildToolsContext(ctx)).toBeNull();
  });

  it('should list available tools', () => {
    const ctx = makeContext({ availableTools: ['split_clip', 'trim_clip'] });
    const result = buildToolsContext(ctx);

    expect(result).toContain('<available_tools>');
    expect(result).toContain('split_clip');
    expect(result).toContain('trim_clip');
    expect(result).toContain('</available_tools>');
  });
});

describe('buildFullEnvironmentPrompt', () => {
  it('should combine all sections', () => {
    const ctx = makeContext({
      timelineDuration: 60,
      playheadPosition: 10,
      availableAssets: [{ id: 'a1', name: 'Test.mp4', type: 'video' }],
      availableTracks: [{ id: 't1', name: 'Track 1', type: 'video', clipCount: 2 }],
      selectedClips: ['c1'],
      availableTools: ['split_clip'],
    });
    const result = buildFullEnvironmentPrompt(ctx);

    expect(result).toContain('<environment>');
    expect(result).toContain('<assets>');
    expect(result).toContain('<tracks>');
    expect(result).toContain('<selection>');
    expect(result).toContain('<available_tools>');
  });

  it('should omit empty sections', () => {
    const ctx = makeContext();
    const result = buildFullEnvironmentPrompt(ctx);

    expect(result).toContain('<environment>');
    expect(result).not.toContain('<assets>');
    expect(result).not.toContain('<tracks>');
    expect(result).not.toContain('<selection>');
  });
});
