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
      bridgeCwd: '/openreelio-app-data/codex/bridge',
    });
    const listenEvent = vi.fn().mockResolvedValue(vi.fn());

    const transport = await CodexTauriAppServerTransport.start(
      { serverId: 'server-1', projectPath: '/project' },
      { invoke: invokeCommand, listen: listenEvent },
    );

    expect(transport.startResult.serverId).toBe('server-1');
    expect(invokeCommand).toHaveBeenCalledWith('start_codex_app_server', {
      input: {
        serverId: 'server-1',
        projectPath: '/project',
        model: null,
        reasoningEffort: null,
      },
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
        bridgeCwd: '/openreelio-app-data/codex/bridge',
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
      bridgeCwd: '/openreelio-app-data/codex/bridge',
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

  it('should surface backend stderr and exit events as transport errors', async () => {
    let listener: (event: { payload: CodexAppServerStreamEvent }) => void = () => undefined;
    const invokeCommand = vi.fn().mockResolvedValue({
      serverId: 'server-1',
      eventName: 'codex:app-server:server-1',
      command: 'codex',
      args: ['app-server'],
      bridgeCwd: '/openreelio-app-data/codex/bridge',
    });
    const listenEvent = vi.fn().mockImplementation(async (_eventName, handler) => {
      listener = handler;
      return vi.fn();
    });
    const transport = await CodexTauriAppServerTransport.start(
      {},
      { invoke: invokeCommand, listen: listenEvent },
    );
    const errorHandler = vi.fn();
    transport.onError(errorHandler);

    listener({
      payload: { type: 'stderr', text: 'failed to initialize sqlite state db' },
    });
    listener({
      payload: { type: 'exit', exitCode: 1 },
    });

    expect(errorHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('failed to initialize sqlite state db'),
      }),
    );
  });

  it('should surface backend stream error events as transport errors', async () => {
    let listener: (event: { payload: CodexAppServerStreamEvent }) => void = () => undefined;
    const invokeCommand = vi.fn().mockResolvedValue({
      serverId: 'server-1',
      eventName: 'codex:app-server:server-1',
      command: 'codex',
      args: ['app-server'],
      bridgeCwd: '/openreelio-app-data/codex/bridge',
    });
    const listenEvent = vi.fn().mockImplementation(async (_eventName, handler) => {
      listener = handler;
      return vi.fn();
    });
    const transport = await CodexTauriAppServerTransport.start(
      {},
      { invoke: invokeCommand, listen: listenEvent },
    );
    const errorHandler = vi.fn();
    transport.onError(errorHandler);

    listener({
      payload: { type: 'error', message: 'Malformed app-server JSON' },
    });

    expect(errorHandler).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Malformed app-server JSON' }),
    );
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
        bridgeCwd: '/openreelio-app-data/codex/bridge',
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
      bridgeCwd: '/openreelio-app-data/codex/bridge',
    });
    const listenEvent = vi.fn().mockResolvedValue(vi.fn());

    const client = await createCodexTauriAppServerClient(
      { projectPath: '/project' },
      { invoke: invokeCommand, listen: listenEvent },
    );

    expect(client).toBeDefined();
    expect(invokeCommand).toHaveBeenCalledWith('start_codex_app_server', {
      input: {
        // The client now derives a server id so it can subscribe to the stream
        // event channel before the backend spawns the process.
        serverId: expect.any(String),
        projectPath: '/project',
        model: null,
        reasoningEffort: null,
      },
    });
  });

  it('should pass a Codex model override to the backend app-server process', async () => {
    const invokeCommand = vi.fn().mockResolvedValue({
      serverId: 'server-1',
      eventName: 'codex:app-server:server-1',
      command: 'codex',
      args: ['app-server', '-c', 'model="gpt-5.4"'],
      bridgeCwd: '/openreelio-app-data/codex/bridge',
    });
    const listenEvent = vi.fn().mockResolvedValue(vi.fn());

    await CodexTauriAppServerTransport.start(
      { projectPath: '/project', model: 'gpt-5.4', reasoningEffort: 'high' },
      { invoke: invokeCommand, listen: listenEvent },
    );

    expect(invokeCommand).toHaveBeenCalledWith('start_codex_app_server', {
      input: {
        serverId: expect.any(String),
        projectPath: '/project',
        model: 'gpt-5.4',
        reasoningEffort: 'high',
      },
    });
  });

  it('should subscribe to the stream channel before starting the backend process', async () => {
    const order: string[] = [];
    const invokeCommand = vi.fn().mockImplementation(async (command: string) => {
      order.push(`invoke:${command}`);
      return {
        serverId: 'server-1',
        eventName: 'codex:app-server:server-1',
        command: 'codex',
        args: ['app-server'],
        bridgeCwd: '/openreelio-app-data/codex/bridge',
      };
    });
    const listenEvent = vi.fn().mockImplementation(async () => {
      order.push('listen');
      return vi.fn();
    });

    await CodexTauriAppServerTransport.start(
      { serverId: 'server-1' },
      { invoke: invokeCommand, listen: listenEvent },
    );

    // The listener must be attached before the backend spawns the process so
    // early stderr/exit events cannot be dropped.
    expect(order[0]).toBe('listen');
    expect(order).toContain('invoke:start_codex_app_server');
    expect(order.indexOf('listen')).toBeLessThan(
      order.indexOf('invoke:start_codex_app_server'),
    );
  });

  it('should replay events that arrive before a consumer registers', async () => {
    let listener: (event: { payload: CodexAppServerStreamEvent }) => void = () => undefined;
    const invokeCommand = vi.fn().mockImplementation(async () => {
      // Simulate the backend emitting an early message before start() resolves
      // (the readers are spawned before the command returns).
      listener({ payload: { type: 'message', message: { id: 1, result: { ready: true } } } });
      return {
        serverId: 'server-1',
        eventName: 'codex:app-server:server-1',
        command: 'codex',
        args: ['app-server'],
        bridgeCwd: '/openreelio-app-data/codex/bridge',
      };
    });
    const listenEvent = vi.fn().mockImplementation(async (_eventName, handler) => {
      listener = handler;
      return vi.fn();
    });

    const transport = await CodexTauriAppServerTransport.start(
      { serverId: 'server-1' },
      { invoke: invokeCommand, listen: listenEvent },
    );

    const handler = vi.fn();
    transport.onMessage(handler);

    // The early message must be replayed to the late-registering consumer.
    expect(handler).toHaveBeenCalledWith({ id: 1, result: { ready: true } });
  });

  it('should replay early errors that arrive before an error consumer registers', async () => {
    let listener: (event: { payload: CodexAppServerStreamEvent }) => void = () => undefined;
    const invokeCommand = vi.fn().mockImplementation(async () => {
      // Simulate startup diagnostics that arrive before start() resolves and
      // before the consumer has a chance to attach onError.
      listener({ payload: { type: 'error', message: 'Early failure' } });
      listener({ payload: { type: 'exit', exitCode: 1 } });
      return {
        serverId: 'server-1',
        eventName: 'codex:app-server:server-1',
        command: 'codex',
        args: ['app-server'],
        bridgeCwd: '/openreelio-app-data/codex/bridge',
      };
    });
    const listenEvent = vi.fn().mockImplementation(async (_eventName, handler) => {
      listener = handler;
      return vi.fn();
    });

    const transport = await CodexTauriAppServerTransport.start(
      { serverId: 'server-1' },
      { invoke: invokeCommand, listen: listenEvent },
    );

    const errorHandler = vi.fn();
    transport.onError(errorHandler);

    expect(errorHandler).toHaveBeenCalledTimes(2);
    expect(errorHandler).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ message: 'Early failure' }),
    );
    expect(errorHandler).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ message: 'Codex app-server exited with exit code 1.' }),
    );
  });
});
