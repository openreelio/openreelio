import { invoke } from '@tauri-apps/api/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CodexReferenceAdapter } from './CodexReferenceAdapter';
import {
  isCodexDynamicToolCallOutputTextItem,
  type CodexDynamicToolCallResponse,
} from './CodexAppServerClient';

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
    vi.resetAllMocks();
    projectStoreMocks.refreshFromBackendMutation.mockResolvedValue(1);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
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

  it('should not mark signed-in Codex as available when app-server initialization fails', async () => {
    const adapter = new CodexReferenceAdapter(async () => ({
      installed: true,
      version: '0.130.0-alpha.5',
      authStatus: 'signed-in',
      appServerReady: false,
      reason: 'codex app-server exited before initialization: migration failed',
    }));

    await expect(adapter.detect()).resolves.toEqual({
      runtimeId: 'codex',
      displayName: 'Codex',
      installStatus: 'installed',
      authStatus: 'signed-in',
      available: false,
      version: '0.130.0-alpha.5',
      reason: 'codex app-server exited before initialization: migration failed',
    });
  });

  it('should use a fallback app-server unavailable reason when the probe omits details', async () => {
    const adapter = new CodexReferenceAdapter(async () => ({
      installed: true,
      version: '0.130.0-alpha.5',
      authStatus: 'signed-in',
      appServerReady: false,
    }));

    const status = await adapter.detect();

    expect(status.available).toBe(false);
    expect(status.reason).toBe('Codex app-server could not initialize');
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
        model: 'gpt-5.5',
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user',
        sandbox: 'read-only',
        developerInstructions: expect.stringContaining('OpenReelio'),
        dynamicTools: expect.arrayContaining([
          expect.objectContaining({ namespace: 'openreelio', name: 'host_context' }),
          expect.objectContaining({ namespace: 'openreelio', name: 'command_execute' }),
        ]),
      }),
    );
    const startThreadInput = appServerClient.startThread.mock.calls[0]?.[0] as any;
    const commandExecuteTool = startThreadInput.dynamicTools.find(
      (tool: any) => tool.name === 'command_execute',
    );
    expect(commandExecuteTool.inputSchema.properties.commandType.enum).toContain('CreateTrack');
    expect(commandExecuteTool.inputSchema.properties.commandType.enum).not.toContain('DeleteFile');
    expect(appServerClient.startTurn).toHaveBeenCalledWith('thr_123', 'Inspect this timeline', {
      cwd: '/project',
      model: 'gpt-5.5',
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
      model: 'gpt-5.5',
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
        model: 'gpt-5.5',
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user',
        sandbox: 'read-only',
        developerInstructions: expect.stringContaining('OpenReelio'),
      }),
    );
    expect(appServerClient.startThread).not.toHaveBeenCalled();
    expect(appServerClient.startTurn).toHaveBeenCalledWith('thr_existing', 'Continue', {
      cwd: '/project',
      model: 'gpt-5.5',
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
        model: 'gpt-5.5',
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
        approvalType: 'os_command',
        tool: 'Codex OS command',
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
    const hostContext = JSON.parse(getFirstTextContent(response));
    expect(hostContext).not.toHaveProperty('contextToken');
  });

  it('should route Codex dynamic tool calls when the namespace is null or omitted', async () => {
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

    const projectStateResponse = (await respondToRequest({
      id: 14,
      method: 'item/tool/call',
      params: {
        thread: { id: 'thr_123' },
        turnId: 'turn_1',
        callId: 'tool_project_state',
        namespace: null,
        tool: 'project_state',
        arguments: {},
      },
    })) as any;
    const commandSchemaResponse = (await respondToRequest({
      id: 15,
      method: 'item/tool/call',
      params: {
        threadId: 'thr_123',
        turnId: 'turn_1',
        callId: 'tool_command_schema',
        tool: 'openreelio.command_schema',
        input: '{}',
      },
    })) as any;

    expect(projectStateResponse.success).toBe(true);
    expect(getFirstTextContent(projectStateResponse)).toContain('"contextToken"');
    expect(getFirstTextContent(projectStateResponse)).toContain('"projectState"');
    expect(commandSchemaResponse.success).toBe(true);
    expect(getFirstTextContent(commandSchemaResponse)).toContain('"mutationTool"');
  });

  it('should issue context tokens from crypto random values when randomUUID is unavailable', async () => {
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
    const getRandomValues = vi.fn((array: Uint32Array) => {
      array.set([1, 35, 1295, 46655]);
      return array;
    });
    vi.stubGlobal('crypto', {
      randomUUID: undefined,
      getRandomValues,
    });
    vi.mocked(invoke).mockImplementation(async (command) => {
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
    const response = (await respondToRequest({
      id: 16,
      method: 'item/tool/call',
      params: {
        threadId: 'thr_123',
        turnId: 'turn_1',
        callId: 'tool_project_state',
        namespace: 'openreelio',
        tool: 'project_state',
        arguments: {},
      },
    })) as CodexDynamicToolCallResponse;

    const projectStateResponse = JSON.parse(getFirstTextContent(response));
    expect(projectStateResponse.contextToken).toMatch(/^orctx:\d+:0000001000000z00000zz0000zzz$/);
    expect(getRandomValues).toHaveBeenCalledWith(expect.any(Uint32Array));
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
          activeSequenceId: 'seq_1',
          textClips: [],
          isDirty: false,
        };
      }
      if (command === 'validate_command_payload') {
        return null;
      }
      if (command === 'execute_command') {
        return {
          opId: 'op_1',
          createdIds: ['track_1'],
          deletedIds: [],
        };
      }
      throw new Error(`Unexpected command: ${command}`);
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
    const contextResponse = (await respondToRequest({
      id: 12,
      method: 'item/tool/call',
      params: {
        threadId: 'thr_123',
        turnId: 'turn_1',
        callId: 'tool_1',
        namespace: 'openreelio',
        tool: 'project_state',
        arguments: {},
      },
    })) as any;
    const contextToken = JSON.parse(getFirstTextContent(contextResponse)).contextToken;

    const response = await respondToRequest({
      id: 13,
      method: 'item/tool/call',
      params: {
        threadId: 'thr_123',
        turnId: 'turn_1',
        callId: 'tool_2',
        tool: 'command_execute',
        arguments: {
          commandType: 'CreateTrack',
          payload: {
            sequenceId: 'seq_1',
            name: 'B-roll',
            kind: 'video',
          },
          reason: 'Add a B-roll track',
          contextToken,
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
        approvalType: 'openreelio_edit_command',
        tool: 'OpenReelio edit',
        description: 'Add a B-roll track',
        args: expect.objectContaining({
          commandType: 'CreateTrack',
          projectId: 'project-1',
          cwd: '/project',
        }),
      }),
    );
    expect(invoke).toHaveBeenCalledWith('validate_command_payload', {
      commandType: 'CreateTrack',
      payload: {
        sequenceId: 'seq_1',
        name: 'B-roll',
        kind: 'video',
      },
    });
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

  it('should validate, approve, token-gate, and atomically apply OpenReelio dynamic plans', async () => {
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
    const agentPlanResult = {
      planId: 'plan_1',
      success: true,
      totalSteps: 1,
      stepsCompleted: 1,
      stepResults: [],
      operationIds: ['op_1'],
      rollbackReport: null,
      errorMessage: null,
      executionTimeMs: 12,
    };
    vi.mocked(invoke).mockImplementation(async (command, args) => {
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
          activeSequenceId: 'seq_1',
          textClips: [],
          isDirty: false,
        };
      }
      if (command === 'validate_command_payload') {
        return null;
      }
      if (command === 'create_external_agent_approval_token') {
        return {
          token: 'grant-token',
          tokenId: 'grant-1',
          sessionId: 'thr_123',
          runId: null,
          planId: 'plan_1',
          projectId: 'project-1',
          runtimeId: 'codex',
          scopes: ['openreelio.plan.apply'],
          createdAt: 1,
          expiresAt: 2,
        };
      }
      if (command === 'consume_external_agent_approval_token') {
        return {
          valid: true,
          reason: null,
          grant: null,
        };
      }
      if (command === 'execute_agent_plan') {
        expect(args).toMatchObject({
          plan: {
            id: 'plan_1',
            approvalGranted: true,
            sessionId: 'thr_123',
          },
        });
        return agentPlanResult;
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    projectStoreMocks.refreshFromBackendMutation.mockResolvedValue(8);
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
    const contextResponse = (await respondToRequest({
      id: 30,
      method: 'item/tool/call',
      params: {
        threadId: 'thr_123',
        turnId: 'turn_1',
        callId: 'tool_context',
        namespace: 'openreelio',
        tool: 'project_state',
        arguments: {},
      },
    })) as any;
    const contextToken = JSON.parse(getFirstTextContent(contextResponse)).contextToken;

    const plan = {
      id: 'plan_1',
      goal: 'Add a B-roll track',
      approvalGranted: false,
      steps: [
        {
          id: 'step_1',
          toolName: 'CreateTrack',
          params: {
            sequenceId: 'seq_1',
            name: 'B-roll',
            kind: 'video',
          },
          description: 'Add a B-roll video track',
          riskLevel: 'medium',
        },
      ],
    };
    const response = (await respondToRequest({
      id: 31,
      method: 'item/tool/call',
      params: {
        threadId: 'thr_123',
        turnId: 'turn_1',
        callId: 'tool_plan_apply',
        namespace: 'openreelio',
        tool: 'plan_apply',
        arguments: {
          plan,
          reason: 'Apply a one-step B-roll track plan',
          contextToken,
        },
      },
    })) as any;

    expect(approvalDecisionProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalType: 'openreelio_plan_apply',
        tool: 'OpenReelio plan apply',
        description: 'Apply a one-step B-roll track plan',
        args: expect.objectContaining({
          planId: 'plan_1',
          stepCount: 1,
          projectId: 'project-1',
        }),
      }),
    );
    expect(invoke).toHaveBeenCalledWith('validate_command_payload', {
      commandType: 'CreateTrack',
      payload: {
        sequenceId: 'seq_1',
        name: 'B-roll',
        kind: 'video',
      },
    });
    expect(invoke).toHaveBeenCalledWith('create_external_agent_approval_token', {
      input: expect.objectContaining({
        sessionId: 'thr_123',
        planId: 'plan_1',
        projectId: 'project-1',
        runtimeId: 'codex',
        scopes: ['openreelio.plan.apply'],
      }),
    });
    expect(invoke).toHaveBeenCalledWith('consume_external_agent_approval_token', {
      input: expect.objectContaining({
        token: 'grant-token',
        sessionId: 'thr_123',
        planId: 'plan_1',
        projectId: 'project-1',
        runtimeId: 'codex',
        requiredScope: 'openreelio.plan.apply',
      }),
    });
    expect(invoke).toHaveBeenCalledWith(
      'execute_agent_plan',
      expect.objectContaining({
        plan: expect.objectContaining({
          id: 'plan_1',
          approvalGranted: true,
          sessionId: 'thr_123',
        }),
      }),
    );
    expect(projectStoreMocks.refreshFromBackendMutation).toHaveBeenCalled();
    expect(response.success).toBe(true);
    expect(getFirstTextContent(response)).toContain('"status": "ok"');
    expect(getFirstTextContent(response)).toContain('"tokenId": "grant-1"');
  });

  it('should reject OpenReelio dynamic plans with cyclic dependencies', async () => {
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

    await adapter.startSession({ projectId: 'project-1', cwd: '/project' });
    const respondToRequest = requestHandlers[0];
    if (!respondToRequest) {
      throw new Error('Expected Codex server request handler to be registered');
    }

    const response = (await respondToRequest({
      id: 32,
      method: 'item/tool/call',
      params: {
        threadId: 'thr_123',
        turnId: 'turn_1',
        callId: 'tool_plan_validate',
        namespace: 'openreelio',
        tool: 'plan_validate',
        arguments: {
          plan: {
            id: 'cyclic-plan',
            goal: 'Create an invalid dependency graph',
            steps: [
              {
                id: 'step_a',
                toolName: 'CreateTrack',
                params: { sequenceId: 'seq_1', name: 'A', kind: 'video' },
                dependsOn: ['step_b'],
              },
              {
                id: 'step_b',
                toolName: 'CreateTrack',
                params: { sequenceId: 'seq_1', name: 'B', kind: 'video' },
                dependsOn: ['step_a'],
              },
            ],
          },
        },
      },
    })) as any;

    expect(response.success).toBe(false);
    expect(getFirstTextContent(response)).toContain('"status": "error"');
    expect(getFirstTextContent(response)).toContain(
      'Plan contains cyclic dependency: step_a -> step_b -> step_a',
    );
    expect(invoke).not.toHaveBeenCalledWith('validate_command_payload', expect.anything());
  });

  it('should reject OpenReelio dynamic tool calls for unknown Codex sessions', async () => {
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

    await adapter.startSession({ projectId: 'project-1', cwd: '/project' });
    const respondToRequest = requestHandlers[0];
    if (!respondToRequest) {
      throw new Error('Expected Codex server request handler to be registered');
    }

    const response = (await respondToRequest({
      id: 20,
      method: 'item/tool/call',
      params: {
        threadId: 'thr_unknown',
        turnId: 'turn_unknown',
        callId: 'tool_unknown',
        namespace: 'openreelio',
        tool: 'host_context',
        arguments: {},
      },
    })) as any;

    expect(response.success).toBe(false);
    expect(getFirstTextContent(response)).toContain('not linked to an active OpenReelio session');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('should reject OpenReelio edit commands without a fresh project context token', async () => {
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

    await adapter.startSession({ projectId: 'project-1', cwd: '/project' });
    const respondToRequest = requestHandlers[0];
    if (!respondToRequest) {
      throw new Error('Expected Codex server request handler to be registered');
    }

    const response = (await respondToRequest({
      id: 24,
      method: 'item/tool/call',
      params: {
        threadId: 'thr_123',
        turnId: 'turn_1',
        callId: 'tool_without_context',
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
    })) as any;

    expect(response.success).toBe(false);
    expect(getFirstTextContent(response)).toContain('requires a fresh mutation contextToken');
    expect(approvalDecisionProvider).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('should validate OpenReelio command payloads before requesting approval', async () => {
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
          activeSequenceId: 'seq_1',
          textClips: [],
          isDirty: false,
        };
      }
      if (command === 'validate_command_payload') {
        throw new Error('Invalid command payload: missing field `sequenceId`');
      }
      throw new Error(`Unexpected command: ${command}`);
    });
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
    const contextResponse = (await respondToRequest({
      id: 26,
      method: 'item/tool/call',
      params: {
        threadId: 'thr_123',
        turnId: 'turn_1',
        callId: 'tool_context',
        namespace: 'openreelio',
        tool: 'project_state',
        arguments: {},
      },
    })) as any;
    const contextToken = JSON.parse(getFirstTextContent(contextResponse)).contextToken;

    const response = (await respondToRequest({
      id: 27,
      method: 'item/tool/call',
      params: {
        threadId: 'thr_123',
        turnId: 'turn_1',
        callId: 'tool_invalid_payload',
        namespace: 'openreelio',
        tool: 'command_execute',
        arguments: {
          commandType: 'CreateTrack',
          payload: {
            name: 'B-roll',
            kind: 'video',
          },
          reason: 'Add a B-roll track',
          contextToken,
        },
      },
    })) as any;

    expect(response.success).toBe(false);
    expect(getFirstTextContent(response)).toContain('invalid CreateTrack payload before approval');
    expect(approvalDecisionProvider).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith('validate_command_payload', {
      commandType: 'CreateTrack',
      payload: {
        name: 'B-roll',
        kind: 'video',
      },
    });
    expect(invoke).not.toHaveBeenCalledWith('execute_command', expect.anything());
  });

  it('should deny dangerous Codex OS command approvals before user approval', async () => {
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
    const handler = vi.fn();
    adapter.subscribe(handler);

    await adapter.startSession({ projectId: 'project-1', cwd: '/project' });
    const respondToRequest = requestHandlers[0];
    if (!respondToRequest) {
      throw new Error('Expected Codex server request handler to be registered');
    }

    const decision = await respondToRequest({
      id: 21,
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'thr_123',
        turnId: 'turn_1',
        itemId: 'cmd_unsafe',
        command: 'rm -rf .openreelio',
        cwd: '/project',
      },
    });

    expect(decision).toBe('decline');
    expect(approvalDecisionProvider).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'tool_started',
        runtimeId: 'codex',
        sessionId: 'thr_123',
        itemId: '_auto_denied:cmd_unsafe',
        tool: 'Codex OS command',
      }),
    );
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'tool_completed',
        runtimeId: 'codex',
        sessionId: 'thr_123',
        itemId: '_auto_denied:cmd_unsafe',
        tool: 'Codex OS command',
        success: false,
      }),
    );
    expect(handler.mock.calls.some(([event]) => event.type === 'approval_requested')).toBe(false);
  });

  it('should request approval for benign formatting commands', async () => {
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

    await adapter.startSession({ projectId: 'project-1', cwd: '/project' });
    const respondToRequest = requestHandlers[0];
    if (!respondToRequest) {
      throw new Error('Expected Codex server request handler to be registered');
    }

    const decision = await respondToRequest({
      id: 29,
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'thr_123',
        turnId: 'turn_1',
        itemId: 'cmd_format',
        command: 'npm run format',
        cwd: '/project',
      },
    });

    expect(decision).toBe('accept');
    expect(approvalDecisionProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalType: 'os_command',
        args: expect.objectContaining({ command: 'npm run format' }),
      }),
    );
  });

  it('should deny direct OpenReelio state file writes before user approval', async () => {
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

    await adapter.startSession({ projectId: 'project-1', cwd: '/project' });
    const respondToRequest = requestHandlers[0];
    if (!respondToRequest) {
      throw new Error('Expected Codex server request handler to be registered');
    }

    const decision = await respondToRequest({
      id: 25,
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'thr_123',
        turnId: 'turn_1',
        itemId: 'cmd_state_write',
        command: 'printf "{}" > .openreelio/project.state.json',
        cwd: '/project',
      },
    });

    expect(decision).toBe('decline');
    expect(approvalDecisionProvider).not.toHaveBeenCalled();
  });

  it('should reject invalid OpenReelio command_execute commands before approval', async () => {
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

    await adapter.startSession({ projectId: 'project-1', cwd: '/project' });
    const respondToRequest = requestHandlers[0];
    if (!respondToRequest) {
      throw new Error('Expected Codex server request handler to be registered');
    }

    const response = (await respondToRequest({
      id: 22,
      method: 'item/tool/call',
      params: {
        threadId: 'thr_123',
        turnId: 'turn_1',
        callId: 'tool_invalid',
        namespace: 'openreelio',
        tool: 'command_execute',
        arguments: {
          commandType: 'ShellDeleteEverything',
          payload: {},
          reason: 'Do something unsafe',
          contextToken: 'orctx:fake',
        },
      },
    })) as any;

    expect(response.success).toBe(false);
    expect(getFirstTextContent(response)).toContain('not in the supported command enum');
    expect(approvalDecisionProvider).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('should reject OpenReelio workspace filesystem commands through command_execute', async () => {
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

    await adapter.startSession({ projectId: 'project-1', cwd: '/project' });
    const respondToRequest = requestHandlers[0];
    if (!respondToRequest) {
      throw new Error('Expected Codex server request handler to be registered');
    }

    const response = (await respondToRequest({
      id: 23,
      method: 'item/tool/call',
      params: {
        threadId: 'thr_123',
        turnId: 'turn_1',
        callId: 'tool_file_delete',
        namespace: 'openreelio',
        tool: 'command_execute',
        arguments: {
          commandType: 'DeleteFile',
          payload: { path: 'media/source.mov' },
          reason: 'Delete a file',
          contextToken: 'orctx:fake',
        },
      },
    })) as any;

    expect(response.success).toBe(false);
    expect(getFirstTextContent(response)).toContain('Workspace filesystem commands');
    expect(approvalDecisionProvider).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });
});

function getFirstTextContent(response: unknown): string {
  const item = (response as CodexDynamicToolCallResponse).contentItems[0];
  if (!isCodexDynamicToolCallOutputTextItem(item)) {
    throw new Error('Expected first Codex dynamic tool response item to be inputText');
  }

  return item.text;
}
