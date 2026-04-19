import { waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { DESKTOP_RUNTIME_TEST_FLAG } from '@/services/runtimeEnvironment';
import { useSettingsStore } from '@/stores/settingsStore';
import { useWorkspaceLayoutStore } from './workspaceLayoutStore';
import { cleanupTerminalSessions, useTerminalStore } from './terminalStore';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(),
}));

type EventHandler = (event: { payload: unknown }) => void;

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

describe('terminalStore', () => {
  const handlers = new Map<string, EventHandler>();

  beforeEach(async () => {
    handlers.clear();
    vi.clearAllMocks();
    globalThis[DESKTOP_RUNTIME_TEST_FLAG] = true;
    window.localStorage.clear();
    useWorkspaceLayoutStore.getState().resetLayout();
    useSettingsStore.setState((state) => ({
      ...state,
      settings: {
        ...state.settings,
        terminal: { defaultShellCommand: null },
      },
    }));

    vi.mocked(invoke).mockResolvedValue(null);
    vi.mocked(listen).mockImplementation(async (event, handler) => {
      handlers.set(String(event), handler as EventHandler);
      return () => {
        handlers.delete(String(event));
      };
    });

    await cleanupTerminalSessions();
  });

  afterEach(async () => {
    await cleanupTerminalSessions();
    globalThis[DESKTOP_RUNTIME_TEST_FLAG] = undefined;
  });

  it('should open the terminal in the bottom panel using the configured command line', async () => {
    useSettingsStore.setState((state) => ({
      ...state,
      settings: {
        ...state.settings,
        terminal: { defaultShellCommand: 'wsl.exe -d Ubuntu' },
      },
    }));

    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === 'start_terminal_session') {
        const payload = args as {
          input: { sessionId: string; shell: string; shellArgs: string[] };
        };
        expect(handlers.has(`terminal:session:${payload.input.sessionId}`)).toBe(true);
        expect(payload.input.shell).toBe('wsl.exe');
        expect(payload.input.shellArgs).toEqual(['-d', 'Ubuntu']);
        return {
          sessionId: payload.input.sessionId,
          cwd: '/workspace',
          shell: 'wsl.exe',
        };
      }

      return null;
    });

    const opened = await useTerminalStore.getState().openTerminal();
    const layout = useWorkspaceLayoutStore.getState().layout;
    const groupId = useTerminalStore.getState().groupOrder[0];
    const sessionId = groupId ? useTerminalStore.getState().groups[groupId]?.sessionIds[0] : null;
    const session = sessionId ? useTerminalStore.getState().sessions[sessionId] : null;

    expect(opened).toBe(true);
    expect(layout.zones.bottom.panelIds).toContain('terminal');
    expect(layout.zones.bottom.activePanelId).toBe('terminal');
    expect(layout.zones.bottom.collapsed).toBe(false);
    expect(session?.status).toBe('running');
    expect(session?.cwd).toBe('/workspace');
    expect(session?.shell).toBe('wsl.exe');
  });

  it('should launch Git Bash with parsed args from terminal settings', async () => {
    useSettingsStore.setState((state) => ({
      ...state,
      settings: {
        ...state.settings,
        terminal: {
          defaultShellCommand: '"C:\\Program Files\\Git\\bin\\bash.exe" --login -i',
        },
      },
    }));

    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === 'start_terminal_session') {
        const payload = args as {
          input: { sessionId: string; shell: string; shellArgs: string[] };
        };
        expect(payload.input.shell).toBe('C:\\Program Files\\Git\\bin\\bash.exe');
        expect(payload.input.shellArgs).toEqual(['--login', '-i']);
        return {
          sessionId: payload.input.sessionId,
          cwd: '/workspace',
          shell: 'C:\\Program Files\\Git\\bin\\bash.exe',
        };
      }

      return null;
    });

    const opened = await useTerminalStore.getState().openTerminal();
    expect(opened).toBe(true);
  });

  it('should add a second terminal tab when requested', async () => {
    let invocationCount = 0;
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === 'start_terminal_session') {
        invocationCount += 1;
        const payload = args as { input: { sessionId: string } };
        return {
          sessionId: payload.input.sessionId,
          cwd: `/workspace/${invocationCount}`,
          shell: '/bin/bash',
        };
      }

      return null;
    });

    await useTerminalStore.getState().openTerminal();
    const secondSessionId = await useTerminalStore.getState().createTerminal();
    const secondGroupId = useTerminalStore.getState().activeGroupId;

    expect(secondSessionId).not.toBeNull();
    expect(useTerminalStore.getState().groupOrder).toHaveLength(2);
    expect(secondGroupId).not.toBeNull();
    expect(useTerminalStore.getState().visibleSessionIds).toEqual([secondSessionId!]);
    expect(useTerminalStore.getState().sessions[secondSessionId!]?.cwd).toBe('/workspace/2');
  });

  it('should split the selected terminal only when explicitly requested', async () => {
    let invocationCount = 0;
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === 'start_terminal_session') {
        invocationCount += 1;
        const payload = args as { input: { sessionId: string } };
        return {
          sessionId: payload.input.sessionId,
          cwd: `/workspace/${invocationCount}`,
          shell: '/bin/bash',
        };
      }

      return null;
    });

    await useTerminalStore.getState().openTerminal();
    const firstGroupId = useTerminalStore.getState().groupOrder[0]!;
    const firstSessionId = useTerminalStore.getState().groups[firstGroupId]!.sessionIds[0]!;
    const splitSessionId = await useTerminalStore.getState().splitGroup(firstGroupId);

    expect(splitSessionId).not.toBeNull();
    expect(useTerminalStore.getState().groupOrder).toHaveLength(1);
    expect(useTerminalStore.getState().groups[firstGroupId]!.sessionIds).toEqual([
      firstSessionId,
      splitSessionId!,
    ]);
    expect(useTerminalStore.getState().visibleSessionIds).toEqual([
      firstSessionId,
      splitSessionId!,
    ]);
    expect(useTerminalStore.getState().activeGroupId).toBe(firstGroupId);
  });

  it('should close all split panes when the parent terminal tab is closed', async () => {
    let invocationCount = 0;
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === 'start_terminal_session') {
        invocationCount += 1;
        const payload = args as { input: { sessionId: string } };
        return {
          sessionId: payload.input.sessionId,
          cwd: `/workspace/${invocationCount}`,
          shell: '/bin/bash',
        };
      }

      return null;
    });

    await useTerminalStore.getState().openTerminal();
    const groupId = useTerminalStore.getState().groupOrder[0]!;
    await useTerminalStore.getState().splitGroup(groupId);

    const closed = await useTerminalStore.getState().closeGroup(groupId);

    expect(closed).toBe(true);
    expect(useTerminalStore.getState().groupOrder).toHaveLength(0);
    expect(useTerminalStore.getState().visibleSessionIds).toEqual([]);
  });

  it('should close all panes and restore the prior bottom panel state', async () => {
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === 'start_terminal_session') {
        const payload = args as { input: { sessionId: string } };
        return {
          sessionId: payload.input.sessionId,
          cwd: '/workspace',
          shell: '/bin/bash',
        };
      }

      return null;
    });

    await useTerminalStore.getState().openTerminal();
    await useTerminalStore.getState().createTerminal();
    const closed = await useTerminalStore.getState().closeTerminal();
    const layout = useWorkspaceLayoutStore.getState().layout;

    expect(closed).toBe(true);
    expect(useTerminalStore.getState().groupOrder).toHaveLength(0);
    expect(layout.zones.bottom.panelIds).not.toContain('terminal');
    expect(layout.zones.bottom.collapsed).toBe(true);
    expect(layout.zones.bottom.activePanelId).toBe('history');
  });

  it('should keep the terminal visible when backend close fails', async () => {
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === 'start_terminal_session') {
        const payload = args as { input: { sessionId: string } };
        return {
          sessionId: payload.input.sessionId,
          cwd: '/workspace',
          shell: '/bin/bash',
        };
      }

      if (command === 'close_terminal_session') {
        throw new Error('backend close failed');
      }

      return null;
    });

    await useTerminalStore.getState().openTerminal();

    const closed = await useTerminalStore.getState().closeTerminal();
    const layout = useWorkspaceLayoutStore.getState().layout;

    expect(closed).toBe(false);
    expect(useTerminalStore.getState().groupOrder).toHaveLength(1);
    expect(layout.zones.bottom.panelIds).toContain('terminal');
    expect(layout.zones.bottom.activePanelId).toBe('terminal');
    expect(layout.zones.bottom.collapsed).toBe(false);
  });

  it('should terminate all panes when the user switches away from the terminal tab', async () => {
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === 'start_terminal_session') {
        const payload = args as { input: { sessionId: string } };
        return {
          sessionId: payload.input.sessionId,
          cwd: '/workspace',
          shell: '/bin/bash',
        };
      }

      return null;
    });

    await useTerminalStore.getState().openTerminal();
    await useTerminalStore.getState().createTerminal();
    useWorkspaceLayoutStore.getState().setActivePanel('bottom', 'history');

    await waitFor(() => {
      expect(useTerminalStore.getState().groupOrder).toHaveLength(0);
      expect(useWorkspaceLayoutStore.getState().layout.zones.bottom.panelIds).not.toContain(
        'terminal',
      );
      expect(useWorkspaceLayoutStore.getState().layout.zones.bottom.activePanelId).toBe('history');
    });
  });

  it('should cancel a pane that is closed while the backend start is still in flight', async () => {
    const startDeferred = createDeferred<{ sessionId: string; cwd: string; shell: string }>();

    vi.mocked(invoke).mockImplementation((command, args) => {
      if (command === 'start_terminal_session') {
        const payload = args as { input: { sessionId: string } };
        return startDeferred.promise.then(() => ({
          sessionId: payload.input.sessionId,
          cwd: '/workspace',
          shell: '/bin/bash',
        }));
      }

      return Promise.resolve(null);
    });

    const createPromise = useTerminalStore.getState().createTerminal();
    await Promise.resolve();

    const pendingGroupId = useTerminalStore.getState().groupOrder[0]!;
    const pendingSessionId = useTerminalStore.getState().groups[pendingGroupId]!.sessionIds[0]!;
    const closePromise = useTerminalStore.getState().closeSession(pendingSessionId);
    startDeferred.resolve({ sessionId: 'ignored', cwd: '/workspace', shell: '/bin/bash' });

    const [createdSessionId, closed] = await Promise.all([createPromise, closePromise]);

    expect(createdSessionId).toBeNull();
    expect(closed).toBe(true);
    expect(useTerminalStore.getState().groupOrder).toHaveLength(0);
    expect(useWorkspaceLayoutStore.getState().layout.zones.bottom.panelIds).not.toContain(
      'terminal',
    );
    expect(vi.mocked(invoke)).toHaveBeenCalledWith('close_terminal_session', {
      input: { sessionId: expect.any(String) },
    });
  });
});
