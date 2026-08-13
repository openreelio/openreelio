/**
 * Feature: External edit safety (frontend contract)
 *
 * Covers the store half of the contract: the app must notice when another
 * process edited the open project and must offer a rebuild-from-disk rather
 * than silently continuing on stale state.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listen } from '@tauri-apps/api/event';
import {
  useProjectStore,
  setupProxyEventListeners,
  cleanupProxyEventListeners,
  _resetCommandQueueForTesting,
} from './projectStore';
import {
  createMockProjectMeta,
  createMockProjectState,
  createMockSequence,
  getMockedInvoke,
  mockTauriCommands,
  resetTauriMocks,
} from '@/test/mocks/tauri';
import {
  EXTERNAL_CHANGE_DETECTED_CODE,
  PROJECT_EXTERNAL_CHANGE_EVENT,
} from '@/utils/externalChange';

type EventHandler = (event: { payload: unknown }) => void;

function resetProjectStore(): void {
  useProjectStore.setState({
    isLoaded: false,
    isLoading: false,
    isDirty: false,
    meta: null,
    assets: new Map(),
    sequences: new Map(),
    effects: new Map(),
    activeSequenceId: null,
    sequenceNavigationStack: [],
    selectedAssetId: null,
    proxyJobIdsByAssetId: {},
    error: null,
    stateVersion: 0,
    externalChange: null,
    isReloadingFromDisk: false,
  });
}

describe('projectStore external change handling', () => {
  beforeEach(() => {
    resetTauriMocks();
    _resetCommandQueueForTesting();
    resetProjectStore();
  });

  describe('markExternalChange', () => {
    it('should set the banner flag when a project is open', () => {
      useProjectStore.setState({ isLoaded: true });

      useProjectStore.getState().markExternalChange({ source: 'watcher', opCount: 7 });

      expect(useProjectStore.getState().externalChange).toEqual({ source: 'watcher', opCount: 7 });
    });

    it('should ignore the signal when no project is open', () => {
      useProjectStore.getState().markExternalChange({ source: 'watcher', opCount: 7 });

      expect(useProjectStore.getState().externalChange).toBeNull();
    });

    it('should clear the flag when dismissed', () => {
      useProjectStore.setState({ isLoaded: true });
      useProjectStore.getState().markExternalChange({ source: 'watcher', opCount: 2 });

      useProjectStore.getState().dismissExternalChange();

      expect(useProjectStore.getState().externalChange).toBeNull();
    });
  });

  describe('executeCommand', () => {
    it('should raise the external-change flag when the backend refuses the command', async () => {
      useProjectStore.setState({ isLoaded: true });
      mockTauriCommands({
        execute_command: () => {
          throw new Error(
            `${EXTERNAL_CHANGE_DETECTED_CODE}: the project operation log changed on disk ` +
              'outside this session (expected 3 operations, found 5). Reload the project to continue.',
          );
        },
      });

      await expect(
        useProjectStore.getState().executeCommand({ type: 'SplitClip', payload: {} }),
      ).rejects.toThrow(EXTERNAL_CHANGE_DETECTED_CODE);

      expect(useProjectStore.getState().externalChange).toEqual({ source: 'command' });
    });

    it('should raise the flag when undo is refused by the guard', async () => {
      useProjectStore.setState({ isLoaded: true });
      mockTauriCommands({
        undo: () => {
          throw new Error(`${EXTERNAL_CHANGE_DETECTED_CODE}: the project changed on disk`);
        },
      });

      await expect(useProjectStore.getState().undo()).rejects.toThrow(
        EXTERNAL_CHANGE_DETECTED_CODE,
      );

      expect(useProjectStore.getState().externalChange).toEqual({ source: 'command' });
    });

    it('should raise the flag when saving is refused by the guard', async () => {
      useProjectStore.setState({ isLoaded: true });
      mockTauriCommands({
        save_project: () => {
          throw new Error(`${EXTERNAL_CHANGE_DETECTED_CODE}: the project changed on disk`);
        },
      });

      await expect(useProjectStore.getState().saveProject()).rejects.toThrow(
        EXTERNAL_CHANGE_DETECTED_CODE,
      );

      expect(useProjectStore.getState().externalChange).toEqual({ source: 'command' });
    });

    it('should not raise the flag for ordinary command failures', async () => {
      useProjectStore.setState({ isLoaded: true });
      mockTauriCommands({
        execute_command: () => {
          throw new Error('Clip not found: clip_001');
        },
      });

      await expect(
        useProjectStore.getState().executeCommand({ type: 'SplitClip', payload: {} }),
      ).rejects.toThrow('Clip not found');

      expect(useProjectStore.getState().externalChange).toBeNull();
    });
  });

  describe('reloadProjectFromDisk', () => {
    it('should rebuild from disk and clear the flag', async () => {
      const sequence = createMockSequence({ id: 'seq_reloaded' });
      useProjectStore.setState({ isLoaded: true, isDirty: true });
      useProjectStore.getState().markExternalChange({ source: 'watcher', opCount: 9 });

      mockTauriCommands({
        reload_project_from_disk: createMockProjectMeta({ name: 'Reloaded Project' }),
        get_project_state: createMockProjectState({
          sequences: [sequence],
          activeSequenceId: 'seq_reloaded',
        }),
      });

      await useProjectStore.getState().reloadProjectFromDisk();

      const invokeMock = getMockedInvoke();
      expect(invokeMock).toHaveBeenCalledWith('reload_project_from_disk');

      const state = useProjectStore.getState();
      expect(state.externalChange).toBeNull();
      expect(state.isReloadingFromDisk).toBe(false);
      expect(state.isDirty).toBe(false);
      expect(state.meta?.name).toBe('Reloaded Project');
      expect(state.sequences.has('seq_reloaded')).toBe(true);
      expect(state.activeSequenceId).toBe('seq_reloaded');
    });

    it('should keep the flag raised when the reload fails', async () => {
      useProjectStore.setState({ isLoaded: true });
      useProjectStore.getState().markExternalChange({ source: 'watcher', opCount: 9 });

      mockTauriCommands({
        reload_project_from_disk: () => {
          throw new Error('No project open');
        },
      });

      await expect(useProjectStore.getState().reloadProjectFromDisk()).rejects.toThrow(
        'No project open',
      );

      const state = useProjectStore.getState();
      expect(state.externalChange).toEqual({ source: 'watcher', opCount: 9 });
      expect(state.isReloadingFromDisk).toBe(false);
      expect(state.error).toBe('No project open');
    });
  });

  describe('project:external-change listener', () => {
    const handlers = new Map<string, EventHandler>();

    beforeEach(() => {
      handlers.clear();
      (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
      vi.mocked(listen).mockImplementation(async (event, handler) => {
        handlers.set(String(event), handler as EventHandler);
        return () => {
          handlers.delete(String(event));
        };
      });
    });

    afterEach(async () => {
      await cleanupProxyEventListeners();
      delete (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    });

    it('should raise the flag when the backend reports an external change', async () => {
      useProjectStore.setState({ isLoaded: true });
      await setupProxyEventListeners();

      handlers.get(PROJECT_EXTERNAL_CHANGE_EVENT)?.({
        payload: { opCount: 11, expectedOpCount: 8, relativePath: '.openreelio/state/ops.jsonl' },
      });

      expect(useProjectStore.getState().externalChange).toEqual({
        source: 'watcher',
        opCount: 11,
      });
    });

    it('should ignore malformed payloads', async () => {
      useProjectStore.setState({ isLoaded: true });
      await setupProxyEventListeners();

      handlers.get(PROJECT_EXTERNAL_CHANGE_EVENT)?.({ payload: { opCount: 'lots' } });

      expect(useProjectStore.getState().externalChange).toBeNull();
    });
  });
});
