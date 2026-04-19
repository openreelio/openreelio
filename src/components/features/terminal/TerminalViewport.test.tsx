import { act, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DESKTOP_RUNTIME_TEST_FLAG } from '@/services/runtimeEnvironment';
import {
  cleanupTerminalSessions,
  useTerminalStore,
  type TerminalSessionRecord,
} from '@/stores/terminalStore';
import { TerminalViewport } from './TerminalViewport';

const { invokeMock, terminalInstances } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  terminalInstances: [] as unknown[],
}));

interface MockTerminalLike {
  cols: number;
  rows: number;
  write: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
  open: ReturnType<typeof vi.fn>;
  loadAddon: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  scrollToBottom: ReturnType<typeof vi.fn>;
  onData: ReturnType<typeof vi.fn>;
}

class MockResizeObserver {
  observe = vi.fn();
  disconnect = vi.fn();
}

function getTerminalInstances(): MockTerminalLike[] {
  return terminalInstances as MockTerminalLike[];
}

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 120;
    rows = 32;
    write = vi.fn();
    focus = vi.fn();
    open = vi.fn();
    loadAddon = vi.fn();
    dispose = vi.fn();
    scrollToBottom = vi.fn();
    onData = vi.fn(() => ({ dispose: vi.fn() }));

    constructor() {
      terminalInstances.push(this);
    }
  },
}));

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit = vi.fn();
  },
}));

vi.mock('@xterm/xterm/css/xterm.css', () => ({}));

function createSession(overrides: Partial<TerminalSessionRecord> = {}): TerminalSessionRecord {
  return {
    id: 'session-1',
    shell: '/bin/bash',
    cwd: '/workspace',
    status: 'running',
    buffer: [{ id: 10, data: 'alpha\r\n' }],
    scrollbackBytes: 7,
    exitCode: null,
    nextChunkId: 10,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('TerminalViewport', () => {
  beforeEach(async () => {
    getTerminalInstances().length = 0;
    invokeMock.mockReset().mockResolvedValue(undefined);
    globalThis[DESKTOP_RUNTIME_TEST_FLAG] = true;
    globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;
    await act(async () => {
      await cleanupTerminalSessions();
    });
  });

  afterEach(async () => {
    await act(async () => {
      await cleanupTerminalSessions();
    });
    globalThis[DESKTOP_RUNTIME_TEST_FLAG] = undefined;
  });

  it('should continue rendering new output after older chunks are pruned from scrollback', async () => {
    act(() => {
      useTerminalStore.setState({
        sessions: { 'session-1': createSession() },
        groups: {
          'group-1': {
            id: 'group-1',
            sessionIds: ['session-1'],
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        },
        groupOrder: ['group-1'],
        activeGroupId: 'group-1',
        visibleSessionIds: ['session-1'],
        openingSessionIds: [],
        lastError: null,
      });
    });

    render(<TerminalViewport sessionId="session-1" />);

    await waitFor(() => {
      expect(getTerminalInstances()).toHaveLength(1);
      expect(getTerminalInstances()[0].write).toHaveBeenCalledWith('alpha\r\n');
    });

    act(() => {
      useTerminalStore.setState((state) => ({
        ...state,
        sessions: {
          ...state.sessions,
          'session-1': {
            ...state.sessions['session-1']!,
            buffer: [{ id: 11, data: 'beta\r\n' }],
            scrollbackBytes: 6,
            nextChunkId: 11,
            updatedAt: '2026-01-01T00:00:02.000Z',
          },
        },
      }));
    });

    await waitFor(() => {
      expect(getTerminalInstances()[0].write).toHaveBeenLastCalledWith('beta\r\n');
      expect(getTerminalInstances()[0].write).toHaveBeenCalledTimes(2);
    });
  });
});
