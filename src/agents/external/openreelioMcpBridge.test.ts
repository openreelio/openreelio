import type { Event, UnlistenFn } from '@tauri-apps/api/event';
import { describe, expect, it, vi } from 'vitest';

import {
  OpenReelioMcpBridge,
  type OpenReelioMcpBridgeDependencies,
  type OpenReelioMcpCallEvent,
  type OpenReelioMcpCancelEvent,
  type OpenReelioMcpSessionContext,
} from './openreelioMcpBridge';

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
