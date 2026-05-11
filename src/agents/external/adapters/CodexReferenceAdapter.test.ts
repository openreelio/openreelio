import { describe, expect, it } from 'vitest';
import { vi } from 'vitest';

import { CodexReferenceAdapter } from './CodexReferenceAdapter';

describe('CodexReferenceAdapter', () => {
  it('should expose app-server and MCP capabilities without starting Codex', async () => {
    const adapter = new CodexReferenceAdapter(async () => ({
      installed: true,
      version: '0.50.0',
      authStatus: 'signed-in',
    }));

    await expect(adapter.capabilities()).resolves.toEqual({
      streamingEvents: true,
      interrupt: true,
      mcpClient: true,
      approvalAware: true,
      localAccountAuth: true,
      sessionResume: true,
      structuredToolCalls: true,
    });
  });

  it('should map a missing Codex executable to an unavailable runtime status', async () => {
    const adapter = new CodexReferenceAdapter(async () => ({
      installed: false,
      authStatus: 'unknown',
      reason: 'codex executable not found',
    }));

    await expect(adapter.detect()).resolves.toEqual({
      runtimeId: 'codex',
      displayName: 'Codex',
      installStatus: 'missing',
      authStatus: 'unknown',
      available: false,
      version: null,
      reason: 'codex executable not found',
    });
  });

  it('should not mark signed-out Codex as available', async () => {
    const appServerClientFactory = vi.fn();
    const adapter = new CodexReferenceAdapter(
      async () => ({
        installed: true,
        version: '0.50.0',
        authStatus: 'signed-out',
      }),
      { appServerClientFactory },
    );

    const status = await adapter.detect();

    expect(status.available).toBe(false);
    expect(status.reason).toBe('Codex is not authenticated');
    expect(appServerClientFactory).not.toHaveBeenCalled();
  });

  it('should start an app-server thread and optional first turn when connected', async () => {
    const appServerClient = {
      startThread: vi.fn().mockResolvedValue({ id: 'thr_123' }),
      startTurn: vi.fn().mockResolvedValue({ id: 'turn_1', status: 'inProgress' }),
      interruptTurn: vi.fn(),
      unsubscribeThread: vi.fn(),
    };
    const adapter = new CodexReferenceAdapter(
      async () => ({
        installed: true,
        version: '0.50.0',
        authStatus: 'signed-in',
      }),
      { appServerClient },
    );

    await expect(
      adapter.startSession({
        projectId: 'project-1',
        prompt: 'Inspect this timeline',
        cwd: '/project',
      }),
    ).resolves.toEqual({ sessionId: 'thr_123', runtimeId: 'codex' });
    expect(appServerClient.startThread).toHaveBeenCalledWith({
      serviceName: 'openreelio',
      cwd: '/project',
      model: 'gpt-5.4',
    });
    expect(appServerClient.startTurn).toHaveBeenCalledWith('thr_123', 'Inspect this timeline', {
      cwd: '/project',
      model: 'gpt-5.4',
      effort: 'medium',
    });
  });

  it('should send follow-up messages through turn/start and track interruptable turns', async () => {
    const appServerClient = {
      startThread: vi.fn().mockResolvedValue({ id: 'thr_123' }),
      startTurn: vi.fn().mockResolvedValue({ id: 'turn_2', status: 'inProgress' }),
      interruptTurn: vi.fn().mockResolvedValue(undefined),
      unsubscribeThread: vi.fn().mockResolvedValue(undefined),
    };
    const adapter = new CodexReferenceAdapter(undefined, { appServerClient });
    const session = await adapter.startSession({ projectId: 'project-1' });

    await adapter.sendMessage(session.sessionId, { content: 'Add captions', cwd: '/project' });
    await adapter.interrupt(session.sessionId);
    await adapter.shutdown(session.sessionId);

    expect(appServerClient.startTurn).toHaveBeenCalledWith('thr_123', 'Add captions', {
      cwd: '/project',
      model: 'gpt-5.4',
      effort: 'medium',
    });
    expect(appServerClient.interruptTurn).toHaveBeenCalledWith('thr_123', 'turn_2');
    expect(appServerClient.unsubscribeThread).toHaveBeenCalledWith('thr_123');
  });

  it('should resume a persisted Codex thread before sending a follow-up message', async () => {
    const appServerClient = {
      startThread: vi.fn(),
      resumeThread: vi.fn().mockResolvedValue({ id: 'thr_existing', name: 'Existing chat' }),
      startTurn: vi.fn().mockResolvedValue({ id: 'turn_3', status: 'inProgress' }),
      interruptTurn: vi.fn(),
      unsubscribeThread: vi.fn(),
    };
    const adapter = new CodexReferenceAdapter(undefined, { appServerClient });

    await expect(
      adapter.resumeSession({
        projectId: 'project-1',
        externalSessionId: 'thr_existing',
        cwd: '/project',
      }),
    ).resolves.toEqual({ sessionId: 'thr_existing', runtimeId: 'codex' });
    await adapter.sendMessage('thr_existing', { content: 'Continue', cwd: '/project' });

    expect(appServerClient.resumeThread).toHaveBeenCalledWith({
      threadId: 'thr_existing',
      cwd: '/project',
      model: 'gpt-5.4',
    });
    expect(appServerClient.startThread).not.toHaveBeenCalled();
    expect(appServerClient.startTurn).toHaveBeenCalledWith('thr_existing', 'Continue', {
      cwd: '/project',
      model: 'gpt-5.4',
      effort: 'medium',
    });
  });

  it('should lazily create a backend-backed app-server client only when starting a session', async () => {
    const appServerClient = {
      startThread: vi.fn().mockResolvedValue({ id: 'thr_lazy' }),
      startTurn: vi.fn().mockResolvedValue({ id: 'turn_lazy', status: 'inProgress' }),
      interruptTurn: vi.fn(),
      unsubscribeThread: vi.fn(),
    };
    const appServerClientFactory = vi.fn().mockResolvedValue(appServerClient);
    const adapter = new CodexReferenceAdapter(
      async () => ({
        installed: true,
        version: '0.50.0',
        authStatus: 'signed-in',
      }),
      { appServerClientFactory },
    );

    await adapter.detect();
    expect(appServerClientFactory).not.toHaveBeenCalled();

    await expect(
      adapter.startSession({ projectId: 'project-1', cwd: '/project' }),
    ).resolves.toEqual({
      sessionId: 'thr_lazy',
      runtimeId: 'codex',
    });
    expect(appServerClientFactory).toHaveBeenCalledTimes(1);
    expect(appServerClientFactory).toHaveBeenCalledWith({
      projectId: 'project-1',
      cwd: '/project',
    });
    expect(appServerClient.startThread).toHaveBeenCalledWith({
      serviceName: 'openreelio',
      cwd: '/project',
      model: 'gpt-5.4',
    });
  });

  it('should forward app-server notifications as external runtime events', async () => {
    const notificationHandlers: Array<(notification: any) => void> = [];
    const appServerClient = {
      startThread: vi.fn().mockResolvedValue({ id: 'thr_123' }),
      startTurn: vi.fn().mockResolvedValue({ id: 'turn_1', status: 'inProgress' }),
      interruptTurn: vi.fn(),
      unsubscribeThread: vi.fn(),
      onNotification: vi.fn((handler: (notification: any) => void) => {
        notificationHandlers.push(handler);
        return vi.fn();
      }),
    };
    const adapter = new CodexReferenceAdapter(undefined, { appServerClient });
    const handler = vi.fn();
    adapter.subscribe(handler);

    await adapter.startSession({ projectId: 'project-1' });
    const emitNotification = notificationHandlers[0];
    if (!emitNotification) {
      throw new Error('Expected Codex notification handler to be registered');
    }
    emitNotification({
      method: 'item/agentMessage/delta',
      params: { threadId: 'thr_123', itemId: 'item_1', delta: 'Ready' },
    });

    expect(handler).toHaveBeenCalledWith({
      type: 'assistant_delta',
      runtimeId: 'codex',
      sessionId: 'thr_123',
      itemId: 'item_1',
      content: 'Ready',
    });
  });

  it('should conservatively decline unmanaged Codex approval requests', async () => {
    const requestHandlers: Array<(request: any) => unknown> = [];
    const appServerClient = {
      startThread: vi.fn().mockResolvedValue({ id: 'thr_123' }),
      startTurn: vi.fn().mockResolvedValue({ id: 'turn_1', status: 'inProgress' }),
      interruptTurn: vi.fn(),
      unsubscribeThread: vi.fn(),
      onServerRequest: vi.fn((handler: (request: any) => unknown) => {
        requestHandlers.push(handler);
        return vi.fn();
      }),
    };
    const adapter = new CodexReferenceAdapter(undefined, { appServerClient });
    const handler = vi.fn();
    adapter.subscribe(handler);

    await adapter.startSession({ projectId: 'project-1' });
    const respondToRequest = requestHandlers[0];
    if (!respondToRequest) {
      throw new Error('Expected Codex server request handler to be registered');
    }
    const decision = await respondToRequest({
      id: 10,
      method: 'item/fileChange/requestApproval',
      params: { threadId: 'thr_123', itemId: 'patch_1', reason: 'Apply patch' },
    });

    expect(decision).toBe('decline');
    expect(handler).toHaveBeenCalledWith({
      type: 'approval_requested',
      runtimeId: 'codex',
      sessionId: 'thr_123',
      itemId: 'patch_1',
      requestId: 10,
      approvalType: 'file_change',
      reason: 'Apply patch',
      tool: 'Codex file change',
      description: 'Apply patch',
      args: {},
    });
  });

  it('should resolve Codex approval requests through a scoped decision provider', async () => {
    const requestHandlers: Array<(request: any) => unknown> = [];
    const appServerClient = {
      startThread: vi.fn().mockResolvedValue({ id: 'thr_123' }),
      startTurn: vi.fn().mockResolvedValue({ id: 'turn_1', status: 'inProgress' }),
      interruptTurn: vi.fn(),
      unsubscribeThread: vi.fn(),
      onServerRequest: vi.fn((handler: (request: any) => unknown) => {
        requestHandlers.push(handler);
        return vi.fn();
      }),
    };
    const approvalDecisionProvider = vi.fn().mockResolvedValue('accept');
    const adapter = new CodexReferenceAdapter(undefined, {
      appServerClient,
      approvalDecisionProvider,
    });

    await adapter.startSession({ projectId: 'project-1' });
    const respondToRequest = requestHandlers[0];
    if (!respondToRequest) {
      throw new Error('Expected Codex server request handler to be registered');
    }
    const decision = await respondToRequest({
      id: 11,
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'thr_123',
        turnId: 'turn_1',
        itemId: 'cmd_1',
        command: 'npm test',
        cwd: '/project',
      },
    });

    expect(decision).toBe('accept');
    expect(approvalDecisionProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'codex:11',
        runtimeId: 'codex',
        sessionId: 'thr_123',
        turnId: 'turn_1',
        itemId: 'cmd_1',
        requestId: 11,
        approvalType: 'command',
        tool: 'Codex command',
        description: 'Run npm test',
        args: expect.objectContaining({
          command: 'npm test',
          cwd: '/project',
        }),
      }),
    );
  });
});
