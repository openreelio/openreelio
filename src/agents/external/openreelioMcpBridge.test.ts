import { invoke } from '@tauri-apps/api/core';
import { listen, type Event, type UnlistenFn } from '@tauri-apps/api/event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  OpenReelioMcpBridge,
  type OpenReelioMcpBridgeDependencies,
  type OpenReelioMcpCallEvent,
  type OpenReelioMcpCancelEvent,
  type OpenReelioMcpSessionContext,
} from './openreelioMcpBridge';
import type { OpenReelioAgentToolCallResult } from './adapters/openreelioCodexTools';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

// The tool handler listens for render events through the real Tauri event API;
// the bridge's own subscriptions are injected separately.
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(listen).mockReset();
});

type BridgeListen = NonNullable<OpenReelioMcpBridgeDependencies['listen']>;
type PayloadHandler = (event: Event<unknown>) => void;

const SESSION_CONTEXT: OpenReelioMcpSessionContext = {
  projectId: 'project-1',
  sessionId: 'server-1',
  cwd: '/workspace',
};

function makeEvent<T>(payload: T): Event<T> {
  return { event: 'e', id: 1, payload } as unknown as Event<T>;
}

/** Build a `listen` dependency that records the handler registered per event. */
function makeRecordingListen(store: Map<string, PayloadHandler>): {
  listen: BridgeListen;
  spy: ReturnType<typeof vi.fn>;
} {
  const spy = vi.fn((event: string, handler: PayloadHandler) => {
    store.set(event, handler);
    return Promise.resolve<UnlistenFn>(() => undefined);
  });
  return { listen: spy as unknown as BridgeListen, spy };
}

describe('OpenReelioMcpBridge', () => {
  it('should resolve registration only after the shared subscription is active', async () => {
    let activateSubscription!: (unlisten: UnlistenFn) => void;
    const subscription = new Promise<UnlistenFn>((resolve) => {
      activateSubscription = resolve;
    });
    const spy = vi.fn(() => subscription);
    const respond = vi.fn().mockResolvedValue(undefined);
    const bridge = new OpenReelioMcpBridge({
      listen: spy as unknown as BridgeListen,
      respond,
    });

    let resolved = false;
    const registration = bridge.registerMcpSession('server-1', SESSION_CONTEXT).then(() => {
      resolved = true;
    });

    await Promise.resolve();
    expect(resolved).toBe(false);

    activateSubscription(() => undefined);
    await registration;
    expect(resolved).toBe(true);
    expect(spy).toHaveBeenCalledWith('openreelio:mcp:call', expect.any(Function));
    expect(spy).toHaveBeenCalledWith('openreelio:mcp:cancel', expect.any(Function));
  });

  it('should answer a call for an unknown session so the tools/call never hangs', async () => {
    const store = new Map<string, PayloadHandler>();
    const { listen } = makeRecordingListen(store);
    const respond = vi.fn().mockResolvedValue(undefined);
    const bridge = new OpenReelioMcpBridge({ listen, respond });

    await bridge.registerMcpSession('server-1', SESSION_CONTEXT);
    const callHandler = store.get('openreelio:mcp:call');
    callHandler?.(
      makeEvent<OpenReelioMcpCallEvent>({
        callId: 'call-1',
        serverId: 'unknown-server',
        sessionId: null,
        tool: 'project_state',
        args: {},
      }),
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(respond).toHaveBeenCalledTimes(1);
    const [callId, response] = respond.mock.calls[0];
    expect(callId).toBe('call-1');
    expect(response.isError).toBe(true);
    expect(response.text).toContain('unknown-server');
  });

  it('should forward a tool result to the backend without an images field when there are none', async () => {
    const store = new Map<string, PayloadHandler>();
    const { listen } = makeRecordingListen(store);
    vi.mocked(invoke).mockResolvedValue(null);
    // No `respond` dependency: this exercises the real backend hand-off.
    const bridge = new OpenReelioMcpBridge({ listen });

    await bridge.registerMcpSession('server-1', SESSION_CONTEXT);
    store.get('openreelio:mcp:call')?.(
      makeEvent<OpenReelioMcpCallEvent>({
        callId: 'call-1',
        serverId: 'unknown-server',
        sessionId: null,
        tool: 'project_state',
        args: {},
      }),
    );
    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('respond_openreelio_mcp_call', expect.anything());
    });

    const [, args] = vi.mocked(invoke).mock.calls[0] as [string, { response: unknown }];
    expect(args.response).toEqual({ text: expect.any(String), isError: true });
    expect(args.response).not.toHaveProperty('images');
  });

  it('should forward the pictures a tool produced alongside its text', async () => {
    const store = new Map<string, PayloadHandler>();
    const { listen } = makeRecordingListen(store);
    vi.mocked(invoke).mockResolvedValue(null);
    const bridge = new OpenReelioMcpBridge({ listen });

    await bridge.registerMcpSession('server-1', SESSION_CONTEXT);
    // `defaultRespond` is private, so it is reached through the bridge's own
    // respond path with a result that carries images.
    const respond = (
      bridge as unknown as {
        respond: (callId: string, response: OpenReelioAgentToolCallResult) => Promise<void>;
      }
    ).respond;

    await respond('call-2', {
      text: '{"status":"ok"}',
      isError: false,
      images: [{ data: 'Zm9vYmFy', mimeType: 'image/jpeg' }],
    });

    expect(invoke).toHaveBeenCalledWith('respond_openreelio_mcp_call', {
      callId: 'call-2',
      response: {
        text: '{"status":"ok"}',
        isError: false,
        images: [{ data: 'Zm9vYmFy', mimeType: 'image/jpeg' }],
      },
    });
  });

  it('should stop a draft render the backend has stopped waiting for', async () => {
    const store = new Map<string, PayloadHandler>();
    const { listen: bridgeListen } = makeRecordingListen(store);
    const respond = vi.fn().mockResolvedValue(undefined);
    // The render never reports a terminal state: only the cancel path can end it.
    vi.mocked(listen).mockImplementation(() => Promise.resolve<UnlistenFn>(() => undefined));
    vi.mocked(invoke).mockImplementation((command: string) => {
      if (command === 'get_project_info') {
        return Promise.resolve({ id: 'project-1', name: 'Demo', path: '/workspace/demo' });
      }
      if (command === 'get_project_state') {
        return Promise.resolve({ activeSequenceId: 'seq-1', assets: [], sequences: [] });
      }
      if (command === 'render_range') {
        return Promise.resolve({ jobId: 'job-7', outputPath: 'ignored', status: 'started' });
      }
      if (command === 'cancel_render') {
        return Promise.resolve({ jobId: 'job-7', cancelled: true });
      }
      return Promise.reject(new Error(`unexpected command '${command}'`));
    });

    const bridge = new OpenReelioMcpBridge({ listen: bridgeListen, respond });
    await bridge.registerMcpSession('server-1', SESSION_CONTEXT);
    store.get('openreelio:mcp:call')?.(
      makeEvent<OpenReelioMcpCallEvent>({
        callId: 'call-render',
        serverId: 'server-1',
        sessionId: 'session-1',
        tool: 'render_proxy',
        args: { start: 0, end: 5 },
      }),
    );

    await vi.waitFor(() => {
      expect(vi.mocked(invoke).mock.calls.some(([name]) => name === 'render_range')).toBe(true);
    });

    store.get('openreelio:mcp:cancel')?.(
      makeEvent<OpenReelioMcpCancelEvent>({ callId: 'call-render', serverId: 'server-1' }),
    );

    await vi.waitFor(() => {
      expect(vi.mocked(invoke).mock.calls.some(([name]) => name === 'cancel_render')).toBe(true);
    });
    // Rust already answered Claude, so the late result is dropped rather than
    // sent to a call id the backend no longer knows.
    expect(respond).not.toHaveBeenCalled();
  });

  it('should ignore a cancel for a call that is no longer in flight', async () => {
    const store = new Map<string, PayloadHandler>();
    const { listen } = makeRecordingListen(store);
    const respond = vi.fn().mockResolvedValue(undefined);
    const bridge = new OpenReelioMcpBridge({ listen, respond });

    await bridge.registerMcpSession('server-1', SESSION_CONTEXT);
    const cancelHandler = store.get('openreelio:mcp:cancel');

    expect(() =>
      cancelHandler?.(
        makeEvent<OpenReelioMcpCancelEvent>({ callId: 'gone', serverId: 'server-1' }),
      ),
    ).not.toThrow();
    expect(respond).not.toHaveBeenCalled();
  });
});
