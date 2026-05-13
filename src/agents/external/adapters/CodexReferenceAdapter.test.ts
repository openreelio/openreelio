import { invoke } from '@tauri-apps/api/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CodexReferenceAdapter } from './CodexReferenceAdapter';

const projectStoreMocks = vi.hoisted(() => ({
  refreshFromBackendMutation: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('@/stores/projectStore', () => ({
  useProjectStore: {
    getState: () => ({
      refreshFromBackendMutation: projectStoreMocks.refreshFromBackendMutation,
    }),
  },
}));

describe('CodexReferenceAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    projectStoreMocks.refreshFromBackendMutation.mockResolvedValue(1);
  });

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
    expect(appServerClient.startThread).toHaveBeenCalledWith(
      expect.objectContaining({
        serviceName: 'openreelio',
        cwd: '/project',
        model: 'gpt-5.4',
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user',
        sandbox: 'workspace-write',
        developerInstructions: expect.stringContaining('OpenReelio'),
        dynamicTools: expect.arrayContaining([
          expect.objectContaining({ namespace: 'openreelio', name: 'host_context' }),
          expect.objectContaining({ namespace: 'openreelio', name: 'command_execute' }),
        ]),
      }),
    );
    expect(appServerClient.startTurn).toHaveBeenCalledWith('thr_123', 'Inspect this timeline', {
      cwd: '/project',
      model: 'gpt-5.4',
      effort: 'medium',
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
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
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
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

    expect(appServerClient.resumeThread).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 'thr_existing',
        cwd: '/project',
        model: 'gpt-5.4',
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user',
        sandbox: 'workspace-write',
        developerInstructions: expect.stringContaining('OpenReelio'),
      }),
    );
    expect(appServerClient.startThread).not.toHaveBeenCalled();
    expect(appServerClient.startTurn).toHaveBeenCalledWith('thr_existing', 'Continue', {
      cwd: '/project',
      model: 'gpt-5.4',
      effort: 'medium',
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
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
    expect(appServerClient.startThread).toHaveBeenCalledWith(
      expect.objectContaining({
        serviceName: 'openreelio',
        cwd: '/project',
        model: 'gpt-5.4',
        developerInstructions: expect.stringContaining('OpenReelio'),
      }),
    );
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

  it('should answer OpenReelio dynamic host context calls from the active app project', async () => {
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
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === 'get_project_info') {
        return {
          id: 'project-1',
          name: 'Launch Cut',
          path: '/project',
          createdAt: '2026-05-13T00:00:00Z',
        };
      }
      if (command === 'get_project_state') {
        return {
          meta: {
            name: 'Launch Cut',
            version: '1',
            createdAt: '2026-05-13T00:00:00Z',
            modifiedAt: '2026-05-13T00:00:00Z',
            description: null,
            author: null,
          },
          assets: [],
          sequences: [],
          effects: [],
          activeSequenceId: null,
          textClips: [],
          isDirty: false,
        };
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    const adapter = new CodexReferenceAdapter(undefined, { appServerClient });

    await adapter.startSession({ projectId: 'project-1', cwd: '/project' });
    const respondToRequest = requestHandlers[0];
    if (!respondToRequest) {
      throw new Error('Expected Codex server request handler to be registered');
    }
    const response = await respondToRequest({
      id: 12,
      method: 'item/tool/call',
      params: {
        threadId: 'thr_123',
        turnId: 'turn_1',
        callId: 'tool_1',
        namespace: 'openreelio',
        tool: 'host_context',
        arguments: {},
      },
    });

    expect(response).toMatchObject({
      success: true,
      contentItems: [
        {
          type: 'inputText',
          text: expect.stringContaining('"appName": "OpenReelio"'),
        },
      ],
    });
    expect(response).toMatchObject({
      contentItems: [
        {
          text: expect.stringContaining('"projectName": "Launch Cut"'),
        },
      ],
    });
  });

  it('should require approval before executing an OpenReelio dynamic edit command', async () => {
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
    vi.mocked(invoke).mockResolvedValue({
      opId: 'op_1',
      createdIds: ['track_1'],
      deletedIds: [],
    });
    projectStoreMocks.refreshFromBackendMutation.mockResolvedValue(7);
    const approvalDecisionProvider = vi.fn().mockResolvedValue('accept');
    const adapter = new CodexReferenceAdapter(undefined, {
      appServerClient,
      approvalDecisionProvider,
    });

    await adapter.startSession({ projectId: 'project-1', cwd: '/project' });
    const respondToRequest = requestHandlers[0];
    if (!respondToRequest) {
      throw new Error('Expected Codex server request handler to be registered');
    }
    const response = await respondToRequest({
      id: 13,
      method: 'item/tool/call',
      params: {
        threadId: 'thr_123',
        turnId: 'turn_1',
        callId: 'tool_2',
        namespace: 'openreelio',
        tool: 'command_execute',
        arguments: {
          commandType: 'CreateTrack',
          payload: {
            sequenceId: 'seq_1',
            name: 'B-roll',
            kind: 'video',
          },
          reason: 'Add a B-roll track',
        },
      },
    });

    expect(approvalDecisionProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'codex:openreelio:13:tool_2',
        runtimeId: 'codex',
        sessionId: 'thr_123',
        turnId: 'turn_1',
        itemId: 'tool_2',
        requestId: 13,
        approvalType: 'command',
        tool: 'OpenReelio command',
        description: 'Add a B-roll track',
        args: expect.objectContaining({
          commandType: 'CreateTrack',
          projectId: 'project-1',
          cwd: '/project',
        }),
      }),
    );
    expect(invoke).toHaveBeenCalledWith('execute_command', {
      commandType: 'CreateTrack',
      payload: {
        sequenceId: 'seq_1',
        name: 'B-roll',
        kind: 'video',
      },
    });
    expect(projectStoreMocks.refreshFromBackendMutation).toHaveBeenCalled();
    expect(response).toMatchObject({
      success: true,
      contentItems: [
        {
          type: 'inputText',
          text: expect.stringContaining('"status": "ok"'),
        },
      ],
    });
    expect(response).toMatchObject({
      contentItems: [
        {
          text: expect.stringContaining('"stateVersion": 7'),
        },
      ],
    });
  });
});
