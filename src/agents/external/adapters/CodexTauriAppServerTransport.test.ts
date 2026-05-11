import { describe, expect, it, vi } from 'vitest';

import {
  CodexTauriAppServerTransport,
  createCodexTauriAppServerClient,
  type CodexAppServerStreamEvent,
} from './CodexTauriAppServerTransport';

describe('CodexTauriAppServerTransport', () => {
  it('should start a backend app-server transport and subscribe to its event channel', async () => {
    const invokeCommand = vi.fn().mockResolvedValue({
      serverId: 'server-1',
      eventName: 'codex:app-server:server-1',
      command: 'codex',
      args: ['app-server'],
      cwd: '/project',
    });
    const listenEvent = vi.fn().mockResolvedValue(vi.fn());

    const transport = await CodexTauriAppServerTransport.start(
      { serverId: 'server-1', cwd: '/project' },
      { invoke: invokeCommand, listen: listenEvent },
    );

    expect(transport.startResult.serverId).toBe('server-1');
    expect(invokeCommand).toHaveBeenCalledWith('start_codex_app_server', {
      input: { serverId: 'server-1', cwd: '/project', model: null, reasoningEffort: null },
    });
    expect(listenEvent).toHaveBeenCalledWith('codex:app-server:server-1', expect.any(Function));
  });

  it('should write outgoing JSON-RPC messages through backend IPC', async () => {
    const invokeCommand = vi
      .fn()
      .mockResolvedValueOnce({
        serverId: 'server-1',
        eventName: 'codex:app-server:server-1',
        command: 'codex',
        args: ['app-server'],
        cwd: '/project',
      })
      .mockResolvedValueOnce(undefined);
    const listenEvent = vi.fn().mockResolvedValue(vi.fn());
    const transport = await CodexTauriAppServerTransport.start(
      {},
      { invoke: invokeCommand, listen: listenEvent },
    );

    await transport.send({ method: 'initialize', id: 1, params: {} });

    expect(invokeCommand).toHaveBeenLastCalledWith('write_codex_app_server_message', {
      input: {
        serverId: 'server-1',
        message: { method: 'initialize', id: 1, params: {} },
      },
    });
  });

  it('should forward backend message events to Codex app-server listeners', async () => {
    let listener: (event: { payload: CodexAppServerStreamEvent }) => void = () => undefined;
    const invokeCommand = vi.fn().mockResolvedValue({
      serverId: 'server-1',
      eventName: 'codex:app-server:server-1',
      command: 'codex',
      args: ['app-server'],
      cwd: '/project',
    });
    const listenEvent = vi.fn().mockImplementation(async (_eventName, handler) => {
      listener = handler;
      return vi.fn();
    });
    const transport = await CodexTauriAppServerTransport.start(
      {},
      { invoke: invokeCommand, listen: listenEvent },
    );
    const handler = vi.fn();
    transport.onMessage(handler);

    listener({
      payload: { type: 'message', message: { id: 1, result: {} } },
    });
    listener({
      payload: { type: 'stderr', text: 'debug line' },
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ id: 1, result: {} });
  });

  it('should stop the backend process when disposed by default', async () => {
    const unlisten = vi.fn();
    const invokeCommand = vi
      .fn()
      .mockResolvedValueOnce({
        serverId: 'server-1',
        eventName: 'codex:app-server:server-1',
        command: 'codex',
        args: ['app-server'],
        cwd: '/project',
      })
      .mockResolvedValueOnce(undefined);
    const listenEvent = vi.fn().mockResolvedValue(unlisten);
    const transport = await CodexTauriAppServerTransport.start(
      {},
      { invoke: invokeCommand, listen: listenEvent },
    );

    await transport.dispose();

    expect(unlisten).toHaveBeenCalled();
    expect(invokeCommand).toHaveBeenLastCalledWith('stop_codex_app_server', {
      input: { serverId: 'server-1' },
    });
  });

  it('should create a Codex app-server client using the Tauri transport', async () => {
    const invokeCommand = vi.fn().mockResolvedValue({
      serverId: 'server-1',
      eventName: 'codex:app-server:server-1',
      command: 'codex',
      args: ['app-server'],
      cwd: '/project',
    });
    const listenEvent = vi.fn().mockResolvedValue(vi.fn());

    const client = await createCodexTauriAppServerClient(
      { cwd: '/project' },
      { invoke: invokeCommand, listen: listenEvent },
    );

    expect(client).toBeDefined();
    expect(invokeCommand).toHaveBeenCalledWith('start_codex_app_server', {
      input: { serverId: null, cwd: '/project', model: null, reasoningEffort: null },
    });
  });

  it('should pass a Codex model override to the backend app-server process', async () => {
    const invokeCommand = vi.fn().mockResolvedValue({
      serverId: 'server-1',
      eventName: 'codex:app-server:server-1',
      command: 'codex',
      args: ['app-server', '-c', 'model="gpt-5.4"'],
      cwd: '/project',
    });
    const listenEvent = vi.fn().mockResolvedValue(vi.fn());

    await CodexTauriAppServerTransport.start(
      { cwd: '/project', model: 'gpt-5.4', reasoningEffort: 'high' },
      { invoke: invokeCommand, listen: listenEvent },
    );

    expect(invokeCommand).toHaveBeenCalledWith('start_codex_app_server', {
      input: { serverId: null, cwd: '/project', model: 'gpt-5.4', reasoningEffort: 'high' },
    });
  });
});
