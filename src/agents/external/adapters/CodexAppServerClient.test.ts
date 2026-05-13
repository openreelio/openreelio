import { describe, expect, it, vi } from 'vitest';

import {
  CodexAppServerClient,
  type CodexAppServerIncomingMessage,
  type CodexAppServerOutgoingMessage,
  type CodexAppServerTransport,
} from './CodexAppServerClient';

class MockCodexTransport implements CodexAppServerTransport {
  readonly sent: CodexAppServerOutgoingMessage[] = [];
  readonly send = vi.fn(async (message: CodexAppServerOutgoingMessage) => {
    this.sent.push(message);
  });

  private handler: ((message: CodexAppServerIncomingMessage) => void) | null = null;

  onMessage(handler: (message: CodexAppServerIncomingMessage) => void): () => void {
    this.handler = handler;
    return () => {
      this.handler = null;
    };
  }

  receive(message: CodexAppServerIncomingMessage): void {
    this.handler?.(message);
  }
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function waitForSent(transport: MockCodexTransport, count: number): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (transport.sent.length >= count) {
      return;
    }
    await flushPromises();
  }

  throw new Error(`Expected ${count} sent message(s), received ${transport.sent.length}`);
}

describe('CodexAppServerClient', () => {
  it('initializes before starting a thread and emits initialized notification', async () => {
    const transport = new MockCodexTransport();
    const client = new CodexAppServerClient(transport, {
      clientInfo: { name: 'openreelio', title: 'OpenReelio', version: '0.1.0' },
    });

    const threadPromise = client.startThread({ cwd: '/project', model: 'gpt-5.4' });

    expect(transport.sent[0]).toEqual({
      method: 'initialize',
      id: 1,
      params: {
        clientInfo: { name: 'openreelio', title: 'OpenReelio', version: '0.1.0' },
        capabilities: { experimentalApi: true },
      },
    });

    transport.receive({ id: 1, result: {} });
    await waitForSent(transport, 3);

    expect(transport.sent[1]).toEqual({ method: 'initialized', params: {} });
    expect(transport.sent[2]).toEqual({
      method: 'thread/start',
      id: 2,
      params: {
        cwd: '/project',
        model: 'gpt-5.4',
        serviceName: 'openreelio',
      },
    });

    transport.receive({ id: 2, result: { thread: { id: 'thr_123' } } });
    await expect(threadPromise).resolves.toEqual({ id: 'thr_123' });
  });

  it('initializes with a protocol-compatible default clientInfo version', async () => {
    const transport = new MockCodexTransport();
    const client = new CodexAppServerClient(transport);

    const initPromise = client.initialize();

    expect(transport.sent[0]).toEqual({
      method: 'initialize',
      id: 1,
      params: {
        clientInfo: { name: 'openreelio', title: 'OpenReelio', version: '0.1.0' },
        capabilities: { experimentalApi: true },
      },
    });

    transport.receive({ id: 1, result: {} });
    await expect(initPromise).resolves.toBeUndefined();
  });

  it('starts a turn with text input for the target thread', async () => {
    const transport = new MockCodexTransport();
    const client = new CodexAppServerClient(transport);
    const initPromise = client.initialize();
    transport.receive({ id: 1, result: {} });
    await initPromise;

    const turnPromise = client.startTurn('thr_123', 'Trim the intro', {
      approvalPolicy: 'unlessTrusted',
    });
    await waitForSent(transport, 3);

    expect(transport.sent[2]).toEqual({
      method: 'turn/start',
      id: 2,
      params: {
        threadId: 'thr_123',
        input: [{ type: 'text', text: 'Trim the intro' }],
        approvalPolicy: 'unlessTrusted',
      },
    });

    transport.receive({
      id: 2,
      result: {
        turn: { id: 'turn_456', status: 'inProgress', items: [], error: null },
      },
    });
    await expect(turnPromise).resolves.toEqual({
      id: 'turn_456',
      status: 'inProgress',
      items: [],
      error: null,
    });
  });

  it('resumes a stored thread before starting later turns', async () => {
    const transport = new MockCodexTransport();
    const client = new CodexAppServerClient(transport);
    const initPromise = client.initialize();
    transport.receive({ id: 1, result: {} });
    await initPromise;

    const resumePromise = client.resumeThread({
      threadId: 'thr_123',
      cwd: '/project',
    });
    await waitForSent(transport, 3);

    expect(transport.sent[2]).toEqual({
      method: 'thread/resume',
      id: 2,
      params: {
        threadId: 'thr_123',
        cwd: '/project',
      },
    });

    transport.receive({ id: 2, result: { thread: { id: 'thr_123', name: 'Existing chat' } } });
    await expect(resumePromise).resolves.toEqual({ id: 'thr_123', name: 'Existing chat' });
  });

  it('fans out app-server notifications to host listeners', () => {
    const transport = new MockCodexTransport();
    const client = new CodexAppServerClient(transport);
    const handler = vi.fn();
    client.onNotification(handler);

    transport.receive({
      method: 'item/agentMessage/delta',
      params: { threadId: 'thr_123', delta: 'Done' },
    });

    expect(handler).toHaveBeenCalledWith({
      method: 'item/agentMessage/delta',
      params: { threadId: 'thr_123', delta: 'Done' },
    });
  });

  it('responds to server-initiated app-server requests', async () => {
    const transport = new MockCodexTransport();
    const client = new CodexAppServerClient(transport);
    const handler = vi.fn().mockResolvedValue('decline');
    client.onServerRequest(handler);

    transport.receive({
      id: 50,
      method: 'item/fileChange/requestApproval',
      params: { threadId: 'thr_123', itemId: 'item_1' },
    });
    await waitForSent(transport, 1);

    expect(handler).toHaveBeenCalledWith({
      id: 50,
      method: 'item/fileChange/requestApproval',
      params: { threadId: 'thr_123', itemId: 'item_1' },
    });
    expect(transport.sent[0]).toEqual({ id: 50, result: 'decline' });
  });

  it('returns a JSON-RPC error when no server request handler exists', async () => {
    const transport = new MockCodexTransport();
    new CodexAppServerClient(transport);

    transport.receive({
      id: 51,
      method: 'item/tool/call',
      params: { threadId: 'thr_123' },
    });
    await waitForSent(transport, 1);

    expect(transport.sent[0]).toEqual({
      id: 51,
      error: {
        code: -32601,
        message: 'Unsupported Codex app-server request: item/tool/call',
      },
    });
  });

  it('rejects when app-server returns a JSON-RPC error', async () => {
    const transport = new MockCodexTransport();
    const client = new CodexAppServerClient(transport);
    const threadPromise = client.startThread();

    transport.receive({ id: 1, result: {} });
    await waitForSent(transport, 3);
    transport.receive({
      id: 2,
      error: { code: -32000, message: 'Not authenticated' },
    });

    await expect(threadPromise).rejects.toThrow('Not authenticated');
  });

  it('normalizes JSON-RPC model compatibility errors before surfacing them', async () => {
    const transport = new MockCodexTransport();
    const client = new CodexAppServerClient(transport);
    const threadPromise = client.startThread();

    transport.receive({ id: 1, result: {} });
    await waitForSent(transport, 3);
    transport.receive({
      id: 2,
      error: {
        code: -32000,
        message: JSON.stringify({
          type: 'error',
          status: 400,
          error: {
            type: 'invalid_request_error',
            message:
              "The 'gpt-5.5' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again.",
          },
        }),
      },
    });

    await expect(threadPromise).rejects.toThrow('Codex model gpt-5.5 requires a newer Codex CLI');
  });

  it('sends turn interrupt for active turns', async () => {
    const transport = new MockCodexTransport();
    const client = new CodexAppServerClient(transport);
    const initPromise = client.initialize();
    transport.receive({ id: 1, result: {} });
    await initPromise;

    const interruptPromise = client.interruptTurn('thr_123', 'turn_456');
    await waitForSent(transport, 3);

    expect(transport.sent[2]).toEqual({
      method: 'turn/interrupt',
      id: 2,
      params: { threadId: 'thr_123', turnId: 'turn_456' },
    });
    transport.receive({ id: 2, result: {} });

    await expect(interruptPromise).resolves.toBeUndefined();
  });
});
