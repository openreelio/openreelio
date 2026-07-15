import { describe, expect, it, vi } from 'vitest';

import type { JsonValue } from '@/bindings';

import { ClaudeCodeAdapter, type ClaudeStatusProbeResult } from './ClaudeCodeAdapter';
import type {
  ClaudeHeadlessExitInfo,
  ClaudeHeadlessTransport,
  CreateClaudeHeadlessTransportInput,
} from './ClaudeHeadlessTransport';

/**
 * Minimal in-memory stand-in for the Claude headless transport. Only the
 * surface the adapter touches is implemented; it lets tests drive the message
 * stream and observe writes/disposal without a live Tauri backend.
 */
class FakeTransport {
  readonly startResult = {
    serverId: '',
    eventName: '',
    command: 'claude',
    args: [] as string[],
    bridgeCwd: '',
    mcpUrl: '',
  };
  readonly sent: JsonValue[] = [];
  disposed = false;
  private readonly messageHandlers = new Set<(message: unknown) => void>();
  private readonly errorHandlers = new Set<(error: Error) => void>();
  private readonly exitHandlers = new Set<(info: ClaudeHeadlessExitInfo) => void>();

  constructor(serverId: string) {
    this.startResult.serverId = serverId;
    this.startResult.eventName = `claude:headless:${serverId}`;
  }

  send(message: JsonValue): Promise<void> {
    this.sent.push(message);
    return Promise.resolve();
  }

  onMessage(handler: (message: unknown) => void): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onError(handler: (error: Error) => void): () => void {
    this.errorHandlers.add(handler);
    return () => this.errorHandlers.delete(handler);
  }

  onExit(handler: (info: ClaudeHeadlessExitInfo) => void): () => void {
    this.exitHandlers.add(handler);
    return () => this.exitHandlers.delete(handler);
  }

  dispose(): Promise<void> {
    this.disposed = true;
    return Promise.resolve();
  }

  emitMessage(message: unknown): void {
    for (const handler of this.messageHandlers) {
      handler(message);
    }
  }

  emitError(error: Error): void {
    for (const handler of this.errorHandlers) {
      handler(error);
    }
  }

  emitExit(info: ClaudeHeadlessExitInfo = { exitCode: null, lastStderrLine: null }): void {
    for (const handler of this.exitHandlers) {
      handler(info);
    }
  }
}

const INSTALLED_PROBE: ClaudeStatusProbeResult = {
  installed: true,
  version: 'claude 1.2.0',
  authStatus: 'signed-in',
};

interface Harness {
  adapter: ClaudeCodeAdapter;
  transports: FakeTransport[];
  factoryInputs: CreateClaudeHeadlessTransportInput[];
  registerMcpSession: ReturnType<typeof vi.fn>;
  unregisterMcpSession: ReturnType<typeof vi.fn>;
}

function createHarness(): Harness {
  const transports: FakeTransport[] = [];
  const factoryInputs: CreateClaudeHeadlessTransportInput[] = [];
  let counter = 0;

  const transportFactory = (
    input: CreateClaudeHeadlessTransportInput,
  ): Promise<ClaudeHeadlessTransport> => {
    factoryInputs.push(input);
    counter += 1;
    const transport = new FakeTransport(`server-${counter}`);
    transports.push(transport);
    return Promise.resolve(transport as unknown as ClaudeHeadlessTransport);
  };

  const registerMcpSession = vi.fn().mockResolvedValue(undefined);
  const unregisterMcpSession = vi.fn();

  const adapter = new ClaudeCodeAdapter(() => Promise.resolve(INSTALLED_PROBE), {
    transportFactory,
    registerMcpSession,
    unregisterMcpSession,
  });

  return { adapter, transports, factoryInputs, registerMcpSession, unregisterMcpSession };
}

function lastTextContent(message: JsonValue | undefined): string | null {
  if (!message || typeof message !== 'object') {
    return null;
  }
  const inner = (message as { message?: { content?: Array<{ text?: string }> } }).message;
  return inner?.content?.[0]?.text ?? null;
}

describe('ClaudeCodeAdapter session lifecycle', () => {
  it('should send the first prompt from the frontend after registering the MCP session', async () => {
    const { adapter, transports, registerMcpSession } = createHarness();

    const handle = await adapter.startSession({
      projectId: 'project-1',
      cwd: '/workspace',
      prompt: 'edit my video',
    });

    expect(handle.sessionId).toBe('server-1');
    // The MCP session is registered under the stable OpenReelio session id.
    expect(registerMcpSession).toHaveBeenCalledWith(
      'server-1',
      expect.objectContaining({ sessionId: 'server-1', projectId: 'project-1' }),
    );
    // The initial prompt is written by the adapter (the backend no longer sends it).
    expect(lastTextContent(transports[0].sent[0])).toBe('edit my video');
  });

  it('should keep the session and resume after an interrupt so the next message continues', async () => {
    const { adapter, transports, factoryInputs, registerMcpSession, unregisterMcpSession } =
      createHarness();

    const handle = await adapter.startSession({ projectId: 'project-1', cwd: '/workspace' });
    // Claude reports its own session id via the init message.
    transports[0].emitMessage({
      type: 'system',
      subtype: 'init',
      session_id: 'claude-session-abc',
    });

    await adapter.interrupt(handle.sessionId);
    expect(transports[0].disposed).toBe(true);
    expect(unregisterMcpSession).toHaveBeenCalledWith('server-1');

    // The next message must not throw and should transparently resume.
    await adapter.sendMessage(handle.sessionId, { content: 'keep going' });

    expect(transports).toHaveLength(2);
    // The resumed transport carries Claude's captured session id.
    expect(factoryInputs[1].resumeSessionId).toBe('claude-session-abc');
    // MCP re-registered under the NEW server id but the SAME OpenReelio session id.
    expect(registerMcpSession).toHaveBeenLastCalledWith(
      'server-2',
      expect.objectContaining({ sessionId: 'server-1' }),
    );
    expect(lastTextContent(transports[1].sent.at(-1))).toBe('keep going');
  });

  it('should fall back to a fresh session when interrupt happens before init arrives', async () => {
    const { adapter, factoryInputs } = createHarness();

    const handle = await adapter.startSession({ projectId: 'project-1', cwd: '/workspace' });
    await adapter.interrupt(handle.sessionId);
    await adapter.sendMessage(handle.sessionId, { content: 'hello again' });

    // No init was seen, so resume uses null (a fresh Claude session).
    expect(factoryInputs[1].resumeSessionId).toBeNull();
  });

  it('should lazily recover when the process dies on its own', async () => {
    const { adapter, transports } = createHarness();

    const handle = await adapter.startSession({ projectId: 'project-1', cwd: '/workspace' });
    transports[0].emitMessage({ type: 'system', subtype: 'init', session_id: 'claude-xyz' });

    // Simulate an unexpected process exit surfaced as a transport error.
    transports[0].emitError(new Error('process exited'));
    await Promise.resolve();

    // The record survives; the next message respawns instead of throwing.
    await adapter.sendMessage(handle.sessionId, { content: 'after crash' });
    expect(transports).toHaveLength(2);
    expect(lastTextContent(transports[1].sent.at(-1))).toBe('after crash');
  });

  it('should stay silent and lazily respawn when the process exits while idle', async () => {
    const { adapter, transports } = createHarness();
    const errors: string[] = [];
    adapter.subscribe((event) => {
      if (event.type === 'error') {
        errors.push(event.message);
      }
    });

    const handle = await adapter.startSession({ projectId: 'project-1', cwd: '/workspace' });
    transports[0].emitMessage({ type: 'system', subtype: 'init', session_id: 'claude-idle' });

    // A benign process exit with no turn in flight must NOT surface an error.
    transports[0].emitExit();
    await Promise.resolve();

    expect(errors).toEqual([]);
    expect(transports[0].disposed).toBe(true);

    // The record survives, so the next message lazily resumes the session.
    await adapter.sendMessage(handle.sessionId, { content: 'still here' });
    expect(transports).toHaveLength(2);
    expect(lastTextContent(transports[1].sent.at(-1))).toBe('still here');
  });

  it('should surface a single error when the process exits mid-turn', async () => {
    const { adapter, transports } = createHarness();
    const errors: string[] = [];
    adapter.subscribe((event) => {
      if (event.type === 'error') {
        errors.push(event.message);
      }
    });

    const handle = await adapter.startSession({ projectId: 'project-1', cwd: '/workspace' });
    transports[0].emitMessage({ type: 'system', subtype: 'init', session_id: 'claude-live' });
    // An assistant message opens a turn (activeTurnId) that never completes.
    transports[0].emitMessage({
      type: 'assistant',
      message: { id: 'msg_1', role: 'assistant', content: [{ type: 'text', text: 'working' }] },
    });

    // A death mid-turn is a real failure and surfaces exactly one error.
    transports[0].emitExit({ exitCode: null, lastStderrLine: 'killed' });
    await Promise.resolve();

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/stopped unexpectedly/i);

    // The record still survives so the conversation can resume afterwards.
    await adapter.sendMessage(handle.sessionId, { content: 'retry' });
    expect(transports).toHaveLength(2);
  });

  it('should start a fresh session after a stale resume id fails to resume', async () => {
    const { adapter, transports, factoryInputs } = createHarness();
    const errors: string[] = [];
    adapter.subscribe((event) => {
      if (event.type === 'error') {
        errors.push(event.message);
      }
    });

    const handle = await adapter.startSession({ projectId: 'project-1', cwd: '/workspace' });
    // Claude reports its own session id, then the process dies.
    transports[0].emitMessage({ type: 'system', subtype: 'init', session_id: 'stale-abc' });
    transports[0].emitError(new Error('process exited'));
    await Promise.resolve();

    // The next message respawns as a RESUME carrying the captured id...
    await adapter.sendMessage(handle.sessionId, { content: 'continue' });
    expect(factoryInputs[1].resumeSessionId).toBe('stale-abc');

    // ...but the resume fails immediately (no messages, then error).
    transports[1].emitError(new Error('could not resume previous conversation'));
    await Promise.resolve();

    // A one-time "starting fresh" notice is surfaced.
    expect(errors.some((message) => /fresh session/i.test(message))).toBe(true);

    // The NEXT message spawns a FRESH session (stale resume id was cleared) and
    // succeeds rather than looping the same failing --resume id.
    await adapter.sendMessage(handle.sessionId, { content: 'retry' });
    expect(transports).toHaveLength(3);
    expect(factoryInputs[2].resumeSessionId).toBeNull();
    expect(lastTextContent(transports[2].sent.at(-1))).toBe('retry');
  });

  it('should throw after shutdown deletes the session record', async () => {
    const { adapter, unregisterMcpSession } = createHarness();

    const handle = await adapter.startSession({ projectId: 'project-1', cwd: '/workspace' });
    await adapter.shutdown(handle.sessionId);
    expect(unregisterMcpSession).toHaveBeenCalledWith('server-1');

    await expect(
      adapter.sendMessage(handle.sessionId, { content: 'too late' }),
    ).rejects.toThrow(/not active/);
  });
});
