import { describe, expect, it } from 'vitest';

import {
  ClaudeHeadlessTransport,
  type ClaudeHeadlessExitInfo,
  type ClaudeHeadlessStartResult,
  type ClaudeHeadlessStreamEvent,
  type ClaudeHeadlessTransportDependencies,
} from './ClaudeHeadlessTransport';

const START_RESULT: ClaudeHeadlessStartResult = {
  serverId: 'test-server',
  eventName: 'claude:headless:test-server',
  command: 'claude',
  args: [],
  bridgeCwd: '',
  mcpUrl: '',
};

interface TransportHarness {
  transport: ClaudeHeadlessTransport;
  emit: (event: ClaudeHeadlessStreamEvent) => void;
}

/**
 * Start a transport wired to an injectable fake `listen`, exposing an `emit`
 * that pushes raw stream events through the same path the Tauri bridge uses.
 */
async function startHarness(): Promise<TransportHarness> {
  let emitter: ((event: ClaudeHeadlessStreamEvent) => void) | null = null;
  const deps: ClaudeHeadlessTransportDependencies = {
    start: () => Promise.resolve(START_RESULT),
    write: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    listen: (_event, handler) => {
      emitter = (event) => handler({ payload: event } as Parameters<typeof handler>[0]);
      return Promise.resolve(() => {
        emitter = null;
      });
    },
  };

  const transport = await ClaudeHeadlessTransport.start(
    { serverId: 'test-server', authMode: 'subscription', tools: [] },
    deps,
    { autoStopOnDispose: false },
  );

  return {
    transport,
    emit: (event) => {
      if (!emitter) {
        throw new Error('stream listener was not attached');
      }
      emitter(event);
    },
  };
}

describe('ClaudeHeadlessTransport terminal signals', () => {
  it('should deliver a process exit to onExit and never to onError', async () => {
    const { transport, emit } = await startHarness();
    const exits: ClaudeHeadlessExitInfo[] = [];
    const errors: Error[] = [];
    transport.onExit((info) => exits.push(info));
    transport.onError((error) => errors.push(error));

    emit({ type: 'exit', exitCode: null });

    expect(errors).toEqual([]);
    expect(exits).toEqual([{ exitCode: null, lastStderrLine: null }]);
  });

  it('should carry the exit code and the last stderr line to onExit', async () => {
    const { transport, emit } = await startHarness();
    const exits: ClaudeHeadlessExitInfo[] = [];
    transport.onExit((info) => exits.push(info));

    emit({ type: 'stderr', text: 'permission denied' });
    emit({ type: 'exit', exitCode: 1 });

    expect(exits).toEqual([{ exitCode: 1, lastStderrLine: 'permission denied' }]);
  });

  it('should deliver a genuine reader error to onError and never to onExit', async () => {
    const { transport, emit } = await startHarness();
    const exits: ClaudeHeadlessExitInfo[] = [];
    const errors: Error[] = [];
    transport.onExit((info) => exits.push(info));
    transport.onError((error) => errors.push(error));

    emit({ type: 'error', message: 'reader failed' });

    expect(exits).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toBe('reader failed');
  });

  it('should buffer an exit that arrives before onExit registers and replay it', async () => {
    const { transport, emit } = await startHarness();
    // Exit arrives before any consumer subscribes.
    emit({ type: 'exit', exitCode: 0 });

    const exits: ClaudeHeadlessExitInfo[] = [];
    transport.onExit((info) => exits.push(info));

    expect(exits).toEqual([{ exitCode: 0, lastStderrLine: null }]);
  });
});
