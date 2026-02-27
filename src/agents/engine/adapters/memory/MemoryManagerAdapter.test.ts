import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryManagerAdapter } from './MemoryManagerAdapter';
import { commands } from '@/bindings';

vi.mock('@/bindings', () => {
  // Shared in-memory store simulating the SQLite backend
  const store = new Map<string, Record<string, unknown>>();

  return {
    commands: {
      saveAgentMemory: vi.fn(
        async (
          id: string,
          projectId: string,
          category: string,
          key: string,
          value: string,
          ttlSeconds: number | null,
        ) => {
          const now = Date.now();
          const existing = store.get(id) as Record<string, unknown> | undefined;
          store.set(id, {
            id,
            projectId,
            category,
            key,
            value,
            createdAt: (existing?.createdAt as number) ?? now,
            updatedAt: now,
            ttlSeconds,
          });
          return { status: 'ok', data: null };
        },
      ),
      getAgentMemory: vi.fn(async (projectId: string, category: string) => {
        const entries = Array.from(store.values())
          .filter((e) => e.projectId === projectId && e.category === category)
          .sort(
            (a, b) => (b.updatedAt as number) - (a.updatedAt as number),
          );
        return { status: 'ok', data: entries };
      }),
      deleteAgentMemory: vi.fn(async (id: string) => {
        store.delete(id);
        return { status: 'ok', data: null };
      }),
      clearAgentMemory: vi.fn(
        async (projectId: string, category: string | null) => {
          let cleared = 0;
          for (const [key, entry] of store.entries()) {
            if (
              entry.projectId === projectId &&
              (category === null || entry.category === category)
            ) {
              store.delete(key);
              cleared++;
            }
          }
          return { status: 'ok', data: cleared };
        },
      ),
    },
    _clearMockStore: () => store.clear(),
  };
});

describe('MemoryManagerAdapter', () => {
  beforeEach(() => {
    // Reset mock implementations and clear data
    vi.clearAllMocks();
    // Clear the in-memory store by calling clearAgentMemory for our sentinel
    // Actually just call the _clearMockStore exported by our mock
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ===========================================================================
  // Normal IPC path
  // ===========================================================================

  it('records and retrieves operations via IPC', async () => {
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

  it('records and retrieves corrections via IPC', async () => {
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

  it('merges user preferences via IPC and preserves custom keys', async () => {
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

  it('clears all memory via IPC', async () => {
    const memory = createMemoryManagerAdapter();

    await memory.recordOperation('split_clip');
    await memory.recordCorrection('a', 'b');
    await memory.setPreference('lang', 'en');

    await memory.clearAll();

    const ops = await memory.getRecentOperations();
    expect(ops).toHaveLength(0);

    const corrections = await memory.getCorrections();
    expect(corrections).toHaveLength(0);
  });

  // ===========================================================================
  // Fallback on IPC failure
  // ===========================================================================

  it('falls back to in-memory storage on IPC failure', async () => {
    vi.mocked(commands.saveAgentMemory).mockResolvedValueOnce({
      status: 'error',
      error: 'Connection refused',
    });

    const memory = createMemoryManagerAdapter();

    // First call triggers fallback
    await memory.recordOperation('split_clip');

    // Subsequent calls use fallback (no more IPC)
    await memory.recordOperation('split_clip');
    await memory.recordOperation('move_clip');

    const frequent = await memory.getFrequentOperations(2);
    expect(frequent).toHaveLength(2);
    expect(frequent[0]).toMatchObject({ operation: 'split_clip', count: 2 });
    expect(frequent[1]).toMatchObject({ operation: 'move_clip', count: 1 });
  });

  it('falls back for corrections when IPC fails', async () => {
    vi.mocked(commands.saveAgentMemory).mockResolvedValueOnce({
      status: 'error',
      error: 'Connection refused',
    });

    const memory = createMemoryManagerAdapter();

    await memory.recordCorrection('old', 'new', 'context');
    const corrections = await memory.getCorrections();
    expect(corrections).toHaveLength(1);
    expect(corrections[0]).toMatchObject({
      original: 'old',
      corrected: 'new',
      context: 'context',
    });
  });

  it('falls back for preferences when IPC fails', async () => {
    vi.mocked(commands.saveAgentMemory).mockResolvedValueOnce({
      status: 'error',
      error: 'Connection refused',
    });

    const memory = createMemoryManagerAdapter();

    await memory.setPreference('language', 'ko');
    const lang = await memory.getPreference<string>('language');
    expect(lang).toBe('ko');
  });
});
