import { describe, expect, it } from 'vitest';
import { createMemoryManagerAdapter } from './MemoryManagerAdapter';

describe('MemoryManagerAdapter', () => {
  it('stores and retrieves operation history', async () => {
    const memory = createMemoryManagerAdapter();

    await memory.recordOperation('split_clip', 'project-1');
    await memory.recordOperation('split_clip', 'project-1');
    await memory.recordOperation('move_clip', 'project-1');

    const frequent = await memory.getFrequentOperations(2);
    expect(frequent[0]).toMatchObject({ operation: 'split_clip', count: 2 });
    expect(frequent[1]).toMatchObject({ operation: 'move_clip', count: 1 });

    const projectMemory = await memory.getProjectMemory('project-1');
    expect(projectMemory?.commonOperations).toContain('split_clip');
    expect(projectMemory?.commonOperations).toContain('move_clip');
  });

  it('stores and retrieves corrections', async () => {
    const memory = createMemoryManagerAdapter();

    await memory.recordCorrection('cut at 5s', 'split at 5 seconds', 'timeline command');

    const corrections = await memory.getCorrections(10);
    expect(corrections).toHaveLength(1);
    expect(corrections[0]).toEqual({
      original: 'cut at 5s',
      corrected: 'split at 5 seconds',
      context: 'timeline command',
    });

    const searchResults = await memory.searchCorrections('cut at 5s', 5);
    expect(searchResults).toHaveLength(1);
  });

  it('merges user preferences and preserves custom keys', async () => {
    const memory = createMemoryManagerAdapter();

    await memory.setPreferences({
      language: 'en',
      defaultTransitionType: 'dissolve',
      custom: { captionStyle: 'clean' },
    });

    await memory.setPreferences({
      defaultVolume: 90,
      custom: { musicStyle: 'ambient' },
    });

    const preferences = await memory.getPreferences();
    expect(preferences.language).toBe('en');
    expect(preferences.defaultTransitionType).toBe('dissolve');
    expect(preferences.defaultVolume).toBe(90);
    expect(preferences.custom).toMatchObject({
      captionStyle: 'clean',
      musicStyle: 'ambient',
    });
  });
});
