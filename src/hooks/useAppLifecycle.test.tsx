import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type CloseRequestedEvent = {
  preventDefault: () => void;
};

type CloseRequestedHandler = (event: CloseRequestedEvent) => void | Promise<void>;

const tauriMocks = vi.hoisted(() => {
  let closeRequestedHandler: CloseRequestedHandler | undefined;

  return {
    confirm: vi.fn(),
    destroy: vi.fn(),
    getCloseRequestedHandler: () => closeRequestedHandler,
    invoke: vi.fn(),
    isTauri: vi.fn(),
    onCloseRequested: vi.fn((handler: CloseRequestedHandler) => {
      closeRequestedHandler = handler;
      return Promise.resolve(vi.fn());
    }),
    resetCloseRequestedHandler: () => {
      closeRequestedHandler = undefined;
    },
    setCloseRequestedHandler: (handler: CloseRequestedHandler) => {
      closeRequestedHandler = handler;
    },
  };
});

vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: vi.fn((path: string) => `asset://localhost${path}`),
  invoke: tauriMocks.invoke,
  isTauri: tauriMocks.isTauri,
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: vi.fn(() => ({
    destroy: tauriMocks.destroy,
    onCloseRequested: tauriMocks.onCloseRequested,
  })),
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  confirm: tauriMocks.confirm,
}));

import { useProjectStore } from '@/stores/projectStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useMessageQueueStore } from '@/stores/messageQueueStore';
import { useAppLifecycle } from './useAppLifecycle';

const projectMeta = {
  id: 'project-1',
  name: 'Close Test',
  path: '/tmp/close-test.openreelio',
  createdAt: '2026-05-19T00:00:00.000Z',
  modifiedAt: '2026-05-19T00:00:00.000Z',
};

describe('useAppLifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tauriMocks.resetCloseRequestedHandler();
    tauriMocks.isTauri.mockReturnValue(true);
    tauriMocks.confirm.mockResolvedValue(true);
    tauriMocks.destroy.mockResolvedValue(undefined);
    tauriMocks.invoke.mockResolvedValue({
      error: null,
      projectSaved: true,
      workersShutdown: true,
    });
    tauriMocks.onCloseRequested.mockImplementation((handler: CloseRequestedHandler) => {
      tauriMocks.setCloseRequestedHandler(handler);
      return Promise.resolve(vi.fn());
    });

    useProjectStore.setState({
      isDirty: false,
      meta: null,
      saveProject: vi.fn().mockResolvedValue(undefined),
    });
    useSettingsStore.setState({
      flushPendingUpdates: vi.fn().mockResolvedValue(undefined),
    });
    useMessageQueueStore.setState({ queue: [] });
  });

  it('prevents the native close event and destroys the window after confirmed cleanup', async () => {
    const saveProject = vi.fn().mockResolvedValue(undefined);
    useProjectStore.setState({
      isDirty: true,
      meta: projectMeta,
      saveProject,
    });

    renderHook(() => useAppLifecycle());

    await waitFor(() => {
      expect(tauriMocks.onCloseRequested).toHaveBeenCalledTimes(1);
    });

    const closeRequestedHandler = tauriMocks.getCloseRequestedHandler();
    expect(closeRequestedHandler).toBeDefined();

    const event = { preventDefault: vi.fn() };
    await act(async () => {
      await closeRequestedHandler?.(event);
    });

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(tauriMocks.confirm).toHaveBeenCalledWith(
      'You have unsaved changes. Do you want to save before closing?',
      expect.objectContaining({
        cancelLabel: 'Close Without Saving',
        okLabel: 'Save and Close',
      }),
    );
    expect(saveProject).toHaveBeenCalledTimes(1);
    expect(tauriMocks.invoke).toHaveBeenCalledWith('app_cleanup');
    expect(tauriMocks.destroy).toHaveBeenCalledTimes(1);
  });
});
