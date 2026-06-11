import { invoke } from '@tauri-apps/api/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { insertAgentMediaClip } from '@/agents/tools/mediaInsertion';
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

vi.mock('@/agents/tools/mediaInsertion', () => ({
  insertAgentMediaClip: vi.fn(),
}));

describe('CodexReferenceAdapter', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    projectStoreMocks.refreshFromBackendMutation.mockResolvedValue(1);
    vi.mocked(insertAgentMediaClip).mockReset();
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
      runtimeSource: null,
      codexHome: null,
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

  it('should mark signed-in Codex available without starting the app-server probe', async () => {
    const appServerClientFactory = vi.fn();
    const adapter = new CodexReferenceAdapter(
      async () => ({
        installed: true,
        version: '0.130.0-alpha.5',
        authStatus: 'signed-in',
      }),
      { appServerClientFactory },
    );

    await expect(adapter.detect()).resolves.toEqual({
      runtimeId: 'codex',
      displayName: 'Codex',
      installStatus: 'installed',
      authStatus: 'signed-in',
      available: true,
      version: '0.130.0-alpha.5',
      reason: null,
      runtimeSource: null,
      codexHome: null,
    });
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
        model: 'gpt-5.5',
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user',
        sandbox: 'read-only',
        developerInstructions: expect.stringContaining('OpenReelio'),
        dynamicTools: expect.arrayContaining([
          expect.objectContaining({ namespace: 'openreelio', name: 'host_context' }),
          expect.objectContaining({ namespace: 'openreelio', name: 'clip_analyze' }),
          expect.objectContaining({ namespace: 'openreelio', name: 'clip_describe' }),
          expect.objectContaining({ namespace: 'openreelio', name: 'semantic_edit_plan' }),
          expect.objectContaining({ namespace: 'openreelio', name: 'transcription_status' }),
          expect.objectContaining({ namespace: 'openreelio', name: 'transcription_install_model' }),
          expect.objectContaining({ namespace: 'openreelio', name: 'transcription_generate' }),
          expect.objectContaining({ namespace: 'openreelio', name: 'stock_media_search' }),
          expect.objectContaining({ namespace: 'openreelio', name: 'stock_media_import' }),
          expect.objectContaining({ namespace: 'openreelio', name: 'media_insert' }),
          expect.objectContaining({ namespace: 'openreelio', name: 'command_execute' }),
        ]),
      }),
    );
    const startThreadInput = appServerClient.startThread.mock.calls[0]?.[0] as any;
    const commandExecuteTool = startThreadInput.dynamicTools.find(
      (tool: any) => tool.name === 'command_execute',
    );
    expect(commandExecuteTool.inputSchema.properties.commandType.enum).toContain('CreateTrack');
    expect(commandExecuteTool.inputSchema.properties.commandType.enum).toContain('AddTextClip');
    expect(commandExecuteTool.inputSchema.properties.commandType.enum).toContain(
      'ImportGeneratedCaptions',
    );
    expect(commandExecuteTool.inputSchema.properties.commandType.enum).not.toContain('DeleteFile');
    const stockSearchTool = startThreadInput.dynamicTools.find(
      (tool: any) => tool.name === 'stock_media_search',
    );
    expect(stockSearchTool.inputSchema.properties.assetType.enum).toEqual([
      'video',
      'image',
      'audio',
    ]);
    const clipAnalyzeTool = startThreadInput.dynamicTools.find(
      (tool: any) => tool.name === 'clip_analyze',
    );
    expect(clipAnalyzeTool.inputSchema.required).toEqual(['clipId']);
    expect(clipAnalyzeTool.inputSchema.properties.mode.enum).toEqual(['representative', 'dense']);
    const clipDescribeTool = startThreadInput.dynamicTools.find(
      (tool: any) => tool.name === 'clip_describe',
    );
    expect(clipDescribeTool.inputSchema.properties.maxFrames.type).toBe('number');
    expect(clipDescribeTool.inputSchema.properties.allowCloud.type).toBe('boolean');
    const semanticEditPlanTool = startThreadInput.dynamicTools.find(
      (tool: any) => tool.name === 'semantic_edit_plan',
    );
    expect(semanticEditPlanTool.inputSchema.properties.action.enum).toContain('highlight');
    expect(startThreadInput.developerInstructions).toContain('openreelio.clip_describe');
    expect(startThreadInput.developerInstructions).toContain('openreelio.semantic_edit_plan');
    expect(appServerClient.startTurn).toHaveBeenCalledWith('thr_123', 'Inspect this timeline', {
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
      model: 'gpt-5.5',
      effort: 'medium',
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
    });
    expect(appServerClient.interruptTurn).toHaveBeenCalledWith('thr_123', 'turn_2');
    expect(appServerClient.unsubscribeThread).toHaveBeenCalledWith('thr_123');
  });

  it('should steer an active Codex turn instead of starting a queued follow-up turn', async () => {
    const appServerClient = {
      startThread: vi.fn().mockResolvedValue({ id: 'thr_123' }),
      startTurn: vi.fn().mockResolvedValue({ id: 'turn_1', status: 'inProgress' }),
      steerTurn: vi.fn().mockResolvedValue({ turnId: 'turn_1' }),
      interruptTurn: vi.fn().mockResolvedValue(undefined),
      unsubscribeThread: vi.fn().mockResolvedValue(undefined),
    };
    const adapter = new CodexReferenceAdapter(undefined, { appServerClient });
    const session = await adapter.startSession({ projectId: 'project-1' });

    await adapter.sendMessage(session.sessionId, { content: 'Add captions', cwd: '/project' });
    await adapter.sendMessage(session.sessionId, {
      content: 'Actually keep them in the lower third',
      cwd: '/project',
    });
    await adapter.interrupt(session.sessionId);

    expect(appServerClient.startTurn).toHaveBeenCalledTimes(1);
    expect(appServerClient.steerTurn).toHaveBeenCalledWith(
      'thr_123',
      'turn_1',
      'Actually keep them in the lower third',
    );
    expect(appServerClient.interruptTurn).toHaveBeenCalledWith('thr_123', 'turn_1');
  });

  it('should start a new Codex turn after a terminal failure notification', async () => {
    const notificationHandlers: Array<(notification: any) => void> = [];
    const appServerClient = {
      startThread: vi.fn().mockResolvedValue({ id: 'thr_123' }),
      startTurn: vi
        .fn()
        .mockResolvedValueOnce({ id: 'turn_1', status: 'inProgress' })
        .mockResolvedValueOnce({ id: 'turn_2', status: 'inProgress' }),
      steerTurn: vi.fn().mockResolvedValue({ turnId: 'turn_1' }),
      interruptTurn: vi.fn(),
      unsubscribeThread: vi.fn(),
      onNotification: vi.fn((handler: (notification: any) => void) => {
        notificationHandlers.push(handler);
        return vi.fn();
      }),
    };
    const adapter = new CodexReferenceAdapter(undefined, { appServerClient });

    const session = await adapter.startSession({
      projectId: 'project-1',
      prompt: 'Initial request',
    });
    const emitNotification = notificationHandlers[0];
    if (!emitNotification) {
      throw new Error('Expected Codex notification handler to be registered');
    }

    emitNotification({
      method: 'turn/failed',
      params: {
        threadId: 'thr_123',
        turn: { id: 'turn_1', status: 'failed' },
      },
    });
    await adapter.sendMessage(session.sessionId, { content: 'Try again', cwd: '/project' });

    expect(appServerClient.startTurn).toHaveBeenCalledTimes(2);
    expect(appServerClient.startTurn).toHaveBeenLastCalledWith('thr_123', 'Try again', {
      model: 'gpt-5.5',
      effort: 'medium',
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
    });
    expect(appServerClient.steerTurn).not.toHaveBeenCalled();
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
        model: 'gpt-5.5',
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user',
        sandbox: 'read-only',
        developerInstructions: expect.stringContaining('OpenReelio'),
      }),
    );
    expect(appServerClient.startThread).not.toHaveBeenCalled();
    expect(appServerClient.startTurn).toHaveBeenCalledWith('thr_existing', 'Continue', {
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
      if (command === 'get_annotation') {
        return {
          status: 'completed',
          annotation: {
            version: '1',
            assetId: 'asset-1',
            assetHash: 'hash',
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
            analysis: {
              faces: {
                provider: 'google_cloud',
                analyzedAt: '2026-01-01T00:00:00Z',
                config: {},
                results: [],
              },
            },
          },
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
      if (command === 'get_annotation') {
        return {
          status: 'completed',
          annotation: {
            version: '1',
            assetId: 'asset-1',
            assetHash: 'hash',
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
            analysis: {
              faces: {
                provider: 'google_cloud',
                analyzedAt: '2026-01-01T00:00:00Z',
                config: {},
                results: [],
              },
            },
          },
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
    const annotationResponse = (await respondToRequest({
      id: 16,
      method: 'item/tool/call',
      params: {
        threadId: 'thr_123',
        turnId: 'turn_1',
        callId: 'tool_annotation_read',
        tool: 'openreelio.annotation_read',
        input: '{"assetId":"asset-1"}',
      },
    })) as any;

    expect(projectStateResponse.success).toBe(true);
    expect(getFirstTextContent(projectStateResponse)).toContain('"contextToken"');
    expect(getFirstTextContent(projectStateResponse)).toContain('"projectState"');
    expect(commandSchemaResponse.success).toBe(true);
    expect(getFirstTextContent(commandSchemaResponse)).toContain('"mutationTool"');
    expect(getFirstTextContent(commandSchemaResponse)).toContain('"ImportGeneratedCaptions"');
    expect(getFirstTextContent(commandSchemaResponse)).toContain('"AddTextClip"');
    expect(getFirstTextContent(commandSchemaResponse)).toContain('"textWorkflows"');
    expect(getFirstTextContent(commandSchemaResponse)).toContain('"SetClipTransform"');
    expect(getFirstTextContent(commandSchemaResponse)).toContain('"SetClipMotionKeyframes"');
    expect(getFirstTextContent(commandSchemaResponse)).toContain('"SetTimeRemap"');
    expect(getFirstTextContent(commandSchemaResponse)).toContain('"SetClipSlowMotionInterpolation"');
    expect(getFirstTextContent(commandSchemaResponse)).toContain('"speedAndTime"');
    expect(getFirstTextContent(commandSchemaResponse)).toContain('openreelio.transcription_status');
    expect(getFirstTextContent(commandSchemaResponse)).toContain(
      'openreelio.transcription_install_model',
    );
    expect(getFirstTextContent(commandSchemaResponse)).toContain(
      'openreelio.transcription_generate',
    );
    expect(getFirstTextContent(commandSchemaResponse)).toContain('"vertical_1080"');
    expect(getFirstTextContent(commandSchemaResponse)).toContain('"1080x1920"');
    expect(annotationResponse.success).toBe(true);
    expect(getFirstTextContent(annotationResponse)).toContain('"analysisStatus"');
    expect(getFirstTextContent(annotationResponse)).toContain('"asset-1"');
  });

  it('should generate transcript segments and remap them to a timeline clip', async () => {
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
          assets: [{ id: 'asset-1', name: 'dialogue.mp4', kind: 'video' }],
          sequences: [
            {
              id: 'seq-1',
              name: 'Main',
              tracks: [
                {
                  id: 'track-1',
                  name: 'V1',
                  kind: 'video',
                  clips: [
                    {
                      id: 'clip-1',
                      assetId: 'asset-1',
                      range: { sourceInSec: 5, sourceOutSec: 10 },
                      place: { timelineInSec: 20, durationSec: 5 },
                      speed: 1,
                    },
                  ],
                },
              ],
            },
          ],
          effects: [],
          activeSequenceId: 'seq-1',
          textClips: [],
          isDirty: false,
        };
      }
      if (command === 'is_transcription_available') {
        return true;
      }
      if (command === 'get_transcription_status') {
        return {
          featureAvailable: true,
          ready: true,
          modelsDir: '/models/whisper',
          defaultModel: 'base',
          installedCount: 1,
          models: [
            {
              id: 'base',
              displayName: 'Base',
              filename: 'ggml-base.bin',
              installed: true,
              path: '/models/whisper/ggml-base.bin',
              sizeBytes: 1,
              isDefault: true,
              recommended: true,
              downloadUrl:
                'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin',
              estimatedSizeBytes: 148000000,
              source: 'ggerganov/whisper.cpp',
              license: 'MIT',
            },
          ],
        };
      }
      if (command === 'transcribe_asset') {
        return {
          language: 'ko',
          duration: 12,
          fullText: 'before clip words after',
          segments: [
            { startTime: 1, endTime: 3, text: 'before' },
            { startTime: 4, endTime: 7, text: 'clip words' },
            { startTime: 8, endTime: 11, text: 'after' },
          ],
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
      id: 18,
      method: 'item/tool/call',
      params: {
        threadId: 'thr_123',
        turnId: 'turn_1',
        callId: 'tool_transcription_generate',
        tool: 'openreelio.transcription_generate',
        arguments: {
          assetId: 'asset-1',
          sequenceId: 'seq-1',
          trackId: 'track-1',
          clipId: 'clip-1',
          language: 'ko',
          model: 'base',
        },
      },
    })) as any;
    const text = getFirstTextContent(response);

    expect(response.success).toBe(true);
    expect(text).toContain('"timelineSegmentCount": 2');
    expect(text).toContain('"timelineCaptionSegments"');
    expect(text).toContain('"startSec": 20');
    expect(text).toContain('"sourceStartSec": 5');
    expect(invoke).toHaveBeenCalledWith('transcribe_asset', {
      assetId: 'asset-1',
      options: { language: 'ko', translate: false, model: 'base' },
    });
  });

  it('should expose clip-local analysis and semantic edit planning through the Codex bridge', async () => {
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
      if (command === 'sample_clip_frames') {
        return {
          source: 'generated',
          bundle: {
            fingerprint: 'clip-analysis-fp',
            sequenceId: 'seq-1',
            trackId: 'video-1',
            clipId: 'clip-highlight',
            assetId: 'asset-1',
            samples: [
              {
                id: 'sample-1',
                index: 0,
                timelineSec: 2.25,
                sourceSec: 10,
                extractionStatus: 'ready',
                imagePath: '/tmp/openreelio/sample-1.jpg',
              },
              {
                id: 'sample-2',
                index: 1,
                timelineSec: 2.75,
                sourceSec: 10.5,
                extractionStatus: 'ready',
                imagePath: '/tmp/openreelio/sample-2.jpg',
              },
            ],
            mapping: {
              timelineInSec: 2.25,
              timelineOutSec: 3.25,
              sourceInSec: 10,
              sourceOutSec: 11,
              speed: 1,
            },
            quality: { status: 'ready', score: 1, warnings: [] },
            errors: [],
          },
        };
      }
      if (command === 'describe_timeline_clip') {
        return {
          source: 'generated',
          bundle: {
            perceptionFingerprint: 'perception-fp',
            clipFingerprint: 'clip-analysis-fp',
            sequenceId: 'seq-1',
            trackId: 'video-1',
            clipId: 'clip-highlight',
            assetId: 'asset-1',
            observations: [
              {
                sampleId: 'sample-1',
                timelineSec: 2.25,
                sourceSec: 10,
                summary: 'A surprised reaction starts as the subject turns toward camera.',
                labels: ['surprised face', 'reaction'],
                confidence: 0.92,
              },
            ],
            quality: { status: 'ready', score: 0.92, warnings: [] },
            errors: [],
          },
        };
      }
      if (command === 'plan_semantic_clip_edit') {
        return {
          planId: 'semantic-plan-1',
          perceptionFingerprint: 'perception-fp',
          clipFingerprint: 'clip-analysis-fp',
          sequenceId: 'seq-1',
          trackId: 'video-1',
          clipId: 'clip-highlight',
          assetId: 'asset-1',
          query: 'surprised face',
          action: 'highlight',
          ranges: [
            {
              id: 'range-1',
              startSec: 2.2,
              endSec: 2.8,
              confidence: 0.92,
              observations: ['sample-1'],
              commandDrafts: [
                {
                  commandType: 'AddEffect',
                  payload: { effectKind: 'brightnessContrast' },
                  reason: 'Highlight the reaction beat.',
                },
              ],
            },
          ],
          quality: {
            status: 'ready',
            score: 0.92,
            matchedSampleCount: 1,
            rangeCount: 1,
            warnings: [],
            recommendedActions: [],
          },
          summary: 'Matched one reaction beat.',
          createdAt: '2026-05-29T04:00:00Z',
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

    const analysisResponse = (await respondToRequest({
      id: 40,
      method: 'item/tool/call',
      params: {
        threadId: 'thr_123',
        turnId: 'turn_1',
        callId: 'tool_clip_analyze',
        namespace: 'openreelio',
        tool: 'clip_analyze',
        arguments: {
          sequenceId: 'seq-1',
          trackId: 'video-1',
          clipId: 'clip-highlight',
          targetIntervalSec: 0.1,
          maxSamples: 6,
          rangeStartSec: 2.25,
          rangeEndSec: 3.25,
        },
      },
    })) as any;
    const perceptionResponse = (await respondToRequest({
      id: 41,
      method: 'item/tool/call',
      params: {
        threadId: 'thr_123',
        turnId: 'turn_1',
        callId: 'tool_clip_describe',
        namespace: 'openreelio',
        tool: 'clip_describe',
        arguments: {
          sequenceId: 'seq-1',
          trackId: 'video-1',
          clipId: 'clip-highlight',
          targetIntervalSec: 0.1,
          maxSamples: 6,
          maxFrames: 4,
        },
      },
    })) as any;
    const planResponse = (await respondToRequest({
      id: 42,
      method: 'item/tool/call',
      params: {
        threadId: 'thr_123',
        turnId: 'turn_1',
        callId: 'tool_semantic_plan',
        namespace: 'openreelio',
        tool: 'semantic_edit_plan',
        arguments: {
          perceptionFingerprint: 'perception-fp',
          query: 'surprised face',
          action: 'highlight',
          paddingSec: 0.05,
          effectStrength: -0.2,
          includeCommandDrafts: true,
          includeSpatialTargets: true,
        },
      },
    })) as any;

    expect(analysisResponse.success).toBe(true);
    expect(getFirstTextContent(analysisResponse)).toContain('"sampleCount": 2');
    expect(getFirstTextContent(analysisResponse)).toContain('"readySampleCount": 2');
    expect(perceptionResponse.success).toBe(true);
    expect(getFirstTextContent(perceptionResponse)).toContain('"perceptionFingerprint"');
    expect(getFirstTextContent(perceptionResponse)).toContain('"perception-fp"');
    expect(planResponse.success).toBe(true);
    expect(getFirstTextContent(planResponse)).toContain('"rangeCount": 1');
    expect(getFirstTextContent(planResponse)).toContain('"semantic-plan-1"');
    expect(invoke).toHaveBeenCalledWith(
      'describe_timeline_clip',
      expect.objectContaining({
        analysisOptions: expect.objectContaining({
          mode: 'dense',
          targetIntervalSec: 0.1,
          maxSamples: 6,
          includeEdges: true,
          forceRefresh: false,
        }),
        perceptionOptions: expect.objectContaining({
          detail: 'low',
          maxFrames: 4,
          reuseSourceAnalysis: true,
          allowCloud: false,
          includeContactSheet: false,
          forceRefresh: false,
        }),
      }),
    );
    expect(invoke).toHaveBeenCalledWith(
      'plan_semantic_clip_edit',
      expect.objectContaining({
        perceptionFingerprint: 'perception-fp',
        query: 'surprised face',
        action: 'highlight',
        options: expect.objectContaining({
          paddingSec: 0.05,
          effectStrength: -0.2,
          includeCommandDrafts: true,
          includeSpatialTargets: true,
        }),
      }),
    );
  });

  it('should resolve clip analysis targets on the active timeline when sequence or track IDs are stale', async () => {
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
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === 'get_project_state') {
        return {
          meta: { name: 'Project' },
          activeSequenceId: 'seq-active',
          assets: [],
          sequences: [
            {
              id: 'seq-active',
              name: 'Active Timeline',
              tracks: [
                {
                  id: 'video-active',
                  name: 'Video 1',
                  kind: 'video',
                  clips: [{ id: 'clip-target', assetId: 'asset-1' }],
                  locked: false,
                  muted: false,
                  visible: true,
                },
              ],
              markers: [],
            },
          ],
          isDirty: false,
        };
      }
      if (command === 'sample_clip_frames') {
        expect(args).toMatchObject({
          sequenceId: 'seq-active',
          trackId: 'video-active',
          clipId: 'clip-target',
        });
        return {
          source: 'cache',
          bundle: {
            fingerprint: 'fp-active',
            sequenceId: 'seq-active',
            trackId: 'video-active',
            clipId: 'clip-target',
            assetId: 'asset-1',
            samples: [],
            mapping: {},
            quality: { status: 'ready', score: 1, warnings: [] },
            errors: [],
          },
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
      id: 43,
      method: 'item/tool/call',
      params: {
        threadId: 'thr_123',
        turnId: 'turn_1',
        callId: 'tool_clip_analyze_active',
        namespace: 'openreelio',
        tool: 'clip_analyze',
        arguments: {
          sequenceId: 'seq-stale',
          trackId: 'track-stale',
          clipId: 'clip-target',
        },
      },
    })) as any;

    expect(response.success).toBe(true);
    expect(getFirstTextContent(response)).toContain('active_sequence_defaulted');
    expect(getFirstTextContent(response)).toContain('clip_track_resolved');
  });

  it('should expose stock media search through the Codex bridge', async () => {
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
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === 'search_stock_media') {
        expect(args).toEqual({
          query: 'funny whoosh',
          assetType: 'audio',
          limit: 3,
        });
        return [
          {
            id: 'freesound-1',
            name: 'Funny Whoosh',
            assetType: 'audio',
            thumbnail: null,
            durationSec: 1.2,
            sizeBytes: null,
            tags: ['whoosh'],
            provider: 'freesound',
            license: { licenseType: 'cc_0' },
            licensePolicy: {
              status: 'allowed',
              requiredActions: ['license_snapshot_required'],
              reasons: ['License is allowed under the current policy context.'],
            },
            metadata: {},
          },
        ];
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
        callId: 'tool_stock_search',
        namespace: 'openreelio',
        tool: 'stock_media_search',
        arguments: {
          query: 'funny whoosh',
          assetType: 'audio',
          limit: 3,
        },
      },
    })) as any;

    expect(response.success).toBe(true);
    expect(getFirstTextContent(response)).toContain('"requiresImport": true');
    expect(getFirstTextContent(response)).toContain('"freesound-1"');
    expect(getFirstTextContent(response)).toContain('"allowed"');
  });

  it('should import a selected stock media candidate through the Codex bridge after approval', async () => {
    const requestHandlers: Array<(request: any) => unknown> = [];
    const approvalDecisionProvider = vi.fn().mockResolvedValue('accept');
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
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === 'get_project_state') {
        return {
          meta: { name: 'Project' },
          activeSequenceId: null,
          assets: [],
          sequences: [],
          isDirty: false,
        };
      }
      if (command === 'import_stock_media_asset') {
        expect(args).toEqual({
          sourceUrl: 'https://cdn.freesound.org/previews/351/351256_2247456-hq.mp3',
          name: 'Deep Whoosh #1',
          assetType: 'audio',
          provider: 'openverse',
          license: {
            source: 'stockProvider',
            provider: 'Openverse (freesound)',
            licenseType: 'cc0',
            allowedUse: ['personal', 'commercial', 'modification'],
          },
          licenseAck: true,
          durationSec: 3.155,
          tags: ['whoosh', 'sfx'],
          providerUrl: 'https://freesound.org/people/Kinoton/sounds/351256',
        });
        return {
          assetId: 'asset_sfx',
          name: 'Deep-Whoosh-1',
          localPath: '/project/.openreelio/imports/stock/deep-whoosh.mp3',
          opId: 'op_import',
          licenseSnapshotPath: '/project/.openreelio/licenses/deep-whoosh.license.json',
        };
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    const adapter = new CodexReferenceAdapter(undefined, {
      appServerClient,
      approvalDecisionProvider,
    });

    await adapter.startSession({ projectId: 'project-1', cwd: '/project' });
    const respondToRequest = requestHandlers[0];
    if (!respondToRequest) {
      throw new Error('Expected Codex server request handler to be registered');
    }

    const assetsResponse = (await respondToRequest({
      id: 17,
      method: 'item/tool/call',
      params: {
        threadId: 'thr_123',
        turnId: 'turn_1',
        callId: 'tool_assets',
        namespace: 'openreelio',
        tool: 'assets_list',
        arguments: {},
      },
    })) as any;
    const contextToken = JSON.parse(getFirstTextContent(assetsResponse)).contextToken;

    const response = (await respondToRequest({
      id: 18,
      method: 'item/tool/call',
      params: {
        threadId: 'thr_123',
        turnId: 'turn_1',
        callId: 'tool_stock_import',
        namespace: 'openreelio',
        tool: 'stock_media_import',
        arguments: {
          sourceUrl: 'https://cdn.freesound.org/previews/351/351256_2247456-hq.mp3',
          name: 'Deep Whoosh #1',
          assetType: 'audio',
          provider: 'openverse',
          license: {
            source: 'stockProvider',
            provider: 'Openverse (freesound)',
            licenseType: 'cc0',
            allowedUse: ['personal', 'commercial', 'modification'],
          },
          licenseAck: true,
          durationSec: 3.155,
          tags: ['whoosh', 'sfx'],
          providerUrl: 'https://freesound.org/people/Kinoton/sounds/351256',
          reason: 'Import a CC0 whoosh SFX from Openverse for cut transitions.',
          contextToken,
        },
      },
    })) as any;

    expect(response.success).toBe(true);
    expect(getFirstTextContent(response)).toContain('"asset_sfx"');
    expect(approvalDecisionProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalType: 'openreelio_edit_command',
        tool: 'OpenReelio edit',
        args: expect.objectContaining({
          commandType: 'ImportAsset',
          payload: expect.objectContaining({
            uri: 'https://cdn.freesound.org/previews/351/351256_2247456-hq.mp3',
            provider: 'openverse',
            assetType: 'audio',
          }),
        }),
      }),
    );
    expect(projectStoreMocks.refreshFromBackendMutation).toHaveBeenCalled();
  });

  it('should place media through the Codex bridge using the drag-and-drop parity path', async () => {
    const requestHandlers: Array<(request: any) => unknown> = [];
    const approvalDecisionProvider = vi.fn().mockResolvedValue('accept');
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
          meta: { name: 'Project' },
          activeSequenceId: 'seq-1',
          assets: [],
          sequences: [],
          isDirty: false,
        };
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    vi.mocked(insertAgentMediaClip).mockResolvedValue({
      insertResult: {
        opId: 'op-video',
        changes: [],
        createdIds: ['clip-video'],
        deletedIds: [],
      },
      clipId: 'clip-video',
      sequenceId: 'seq-1',
      trackId: 'video-1',
      assetId: 'asset-video',
      timelineStart: 4,
      sourceIn: 1,
      sourceOut: 6,
      durationSec: 5,
      linkedAudio: {
        trackId: 'audio-1',
        clipId: 'clip-audio',
        createdTrack: false,
      },
    });
    projectStoreMocks.refreshFromBackendMutation.mockResolvedValue(11);
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
      id: 19,
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
      id: 20,
      method: 'item/tool/call',
      params: {
        threadId: 'thr_123',
        turnId: 'turn_1',
        callId: 'tool_media_insert',
        namespace: 'openreelio',
        tool: 'media_insert',
        arguments: {
          sequenceId: 'seq-1',
          trackId: 'video-1',
          assetId: 'asset-video',
          timelineStart: 4,
          sourceIn: 1,
          sourceOut: 6,
          reason: 'Place the selected interview range on the timeline.',
          contextToken,
        },
      },
    })) as any;

    expect(response.success).toBe(true);
    expect(approvalDecisionProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalType: 'openreelio_edit_command',
        tool: 'OpenReelio edit',
        args: expect.objectContaining({
          commandType: 'MediaInsert',
          payload: expect.objectContaining({
            sequenceId: 'seq-1',
            trackId: 'video-1',
            assetId: 'asset-video',
            sourceIn: 1,
            sourceOut: 6,
          }),
        }),
      }),
    );
    expect(insertAgentMediaClip).toHaveBeenCalledWith({
      sequenceId: 'seq-1',
      trackId: 'video-1',
      assetId: 'asset-video',
      timelineStart: 4,
      sourceIn: 1,
      sourceOut: 6,
      audioOnly: false,
      autoExtractLinkedAudio: undefined,
    });
    expect(getFirstTextContent(response)).toContain('drag-and-drop parity path');
    expect(getFirstTextContent(response)).toContain('"clip-audio"');
    expect(getFirstTextContent(response)).toContain('"stateVersion": 11');
  });

  it('should default media insertion to the active sequence and base video track', async () => {
    const requestHandlers: Array<(request: any) => unknown> = [];
    const approvalDecisionProvider = vi.fn().mockResolvedValue('accept');
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
          meta: { name: 'Project' },
          activeSequenceId: 'seq-active',
          assets: [{ id: 'asset-video', kind: 'video', name: 'Interview' }],
          sequences: [
            {
              id: 'seq-active',
              name: 'Active Timeline',
              tracks: [
                {
                  id: 'overlay-top',
                  name: 'Text Overlay',
                  kind: 'overlay',
                  clips: [],
                  locked: false,
                  muted: false,
                  visible: true,
                },
                {
                  id: 'video-base',
                  name: 'Video 1',
                  kind: 'video',
                  clips: [],
                  isBaseTrack: true,
                  locked: false,
                  muted: false,
                  visible: true,
                },
              ],
              markers: [],
            },
            {
              id: 'seq-inactive',
              name: 'Old Cut',
              tracks: [{ id: 'old-video', name: 'Video 1', kind: 'video', clips: [] }],
              markers: [],
            },
          ],
          isDirty: false,
        };
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    vi.mocked(insertAgentMediaClip).mockResolvedValue({
      insertResult: {
        opId: 'op-video',
        changes: [],
        createdIds: ['clip-video'],
        deletedIds: [],
      },
      clipId: 'clip-video',
      sequenceId: 'seq-active',
      trackId: 'video-base',
      assetId: 'asset-video',
      timelineStart: 2,
      sourceIn: undefined,
      sourceOut: undefined,
      durationSec: 5,
    });
    projectStoreMocks.refreshFromBackendMutation.mockResolvedValue(13);
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
      id: 201,
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
      id: 202,
      method: 'item/tool/call',
      params: {
        threadId: 'thr_123',
        turnId: 'turn_1',
        callId: 'tool_media_insert_active',
        namespace: 'openreelio',
        tool: 'media_insert',
        arguments: {
          sequenceId: 'seq-inactive',
          trackId: 'old-video',
          assetId: 'asset-video',
          timelineStart: 2,
          reason: 'Place this media on the current timeline.',
          contextToken,
        },
      },
    })) as any;

    expect(response.success).toBe(true);
    expect(insertAgentMediaClip).toHaveBeenCalledWith(
      expect.objectContaining({
        sequenceId: 'seq-active',
        trackId: 'video-base',
        assetId: 'asset-video',
      }),
    );
    expect(approvalDecisionProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        args: expect.objectContaining({
          payload: expect.objectContaining({
            sequenceId: 'seq-active',
            trackId: 'video-base',
          }),
        }),
      }),
    );
    expect(getFirstTextContent(response)).toContain('active_sequence_defaulted');
    expect(getFirstTextContent(response)).toContain('main_video_track_defaulted');
  });

  it('should route command_execute InsertClip approvals through the media insert surface', async () => {
    const requestHandlers: Array<(request: any) => unknown> = [];
    const approvalDecisionProvider = vi.fn().mockResolvedValue('accept');
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
          meta: { name: 'Project' },
          activeSequenceId: 'seq-1',
          assets: [],
          sequences: [],
          isDirty: false,
        };
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    vi.mocked(insertAgentMediaClip).mockResolvedValue({
      insertResult: {
        opId: 'op-video',
        changes: [],
        createdIds: ['clip-video'],
        deletedIds: [],
      },
      clipId: 'clip-video',
      sequenceId: 'seq-1',
      trackId: 'video-1',
      assetId: 'asset-video',
      timelineStart: 4,
      sourceIn: 1,
      sourceOut: 6,
      durationSec: 5,
    });
    projectStoreMocks.refreshFromBackendMutation.mockResolvedValue(12);
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
      id: 21,
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
      id: 22,
      method: 'item/tool/call',
      params: {
        threadId: 'thr_123',
        turnId: 'turn_1',
        callId: 'tool_insert_clip',
        namespace: 'openreelio',
        tool: 'command_execute',
        arguments: {
          commandType: 'InsertClip',
          payload: {
            sequenceId: 'seq-1',
            trackId: 'video-1',
            assetId: 'asset-video',
            timelineStart: 4,
            sourceIn: 1,
            sourceOut: 6,
          },
          reason: 'Place the selected interview range on the timeline.',
          contextToken,
        },
      },
    })) as any;

    expect(response.success).toBe(true);
    expect(approvalDecisionProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalType: 'openreelio_edit_command',
        args: expect.objectContaining({
          commandType: 'MediaInsert',
          payload: expect.objectContaining({
            sequenceId: 'seq-1',
            trackId: 'video-1',
            assetId: 'asset-video',
          }),
        }),
      }),
    );
    expect(invoke).not.toHaveBeenCalledWith('validate_command_payload', expect.anything());
    expect(insertAgentMediaClip).toHaveBeenCalledWith({
      sequenceId: 'seq-1',
      trackId: 'video-1',
      assetId: 'asset-video',
      timelineStart: 4,
      sourceIn: 1,
      sourceOut: 6,
      audioOnly: false,
      autoExtractLinkedAudio: undefined,
    });
    expect(getFirstTextContent(response)).toContain('drag-and-drop parity path');
    expect(getFirstTextContent(response)).toContain('"stateVersion": 12');
  });

  it('should reject stock media search without a query before invoking Tauri', async () => {
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
      id: 17,
      method: 'item/tool/call',
      params: {
        threadId: 'thr_123',
        turnId: 'turn_1',
        callId: 'tool_stock_search_missing_query',
        namespace: 'openreelio',
        tool: 'stock_media_search',
        arguments: {
          query: '   ',
          assetType: 'video',
          limit: 5,
        },
      },
    })) as any;

    expect(response.success).toBe(false);
    expect(getFirstTextContent(response)).toContain('OpenReelio stock_media_search requires query');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('should reject unsupported stock media asset types before invoking Tauri', async () => {
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
      id: 18,
      method: 'item/tool/call',
      params: {
        threadId: 'thr_123',
        turnId: 'turn_1',
        callId: 'tool_stock_search_invalid_type',
        namespace: 'openreelio',
        tool: 'stock_media_search',
        arguments: {
          query: 'city rain',
          assetType: 'document',
          limit: 5,
        },
      },
    })) as any;

    expect(response.success).toBe(false);
    expect(getFirstTextContent(response)).toContain(
      'OpenReelio stock media assetType must be one of video, image, or audio',
    );
    expect(invoke).not.toHaveBeenCalled();
  });

  it('should normalize fractional stock media limits before invoking Tauri', async () => {
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
    vi.mocked(invoke).mockResolvedValue([]);
    const adapter = new CodexReferenceAdapter(undefined, { appServerClient });

    await adapter.startSession({ projectId: 'project-1', cwd: '/project' });
    const respondToRequest = requestHandlers[0];
    if (!respondToRequest) {
      throw new Error('Expected Codex server request handler to be registered');
    }

    const response = (await respondToRequest({
      id: 18,
      method: 'item/tool/call',
      params: {
        threadId: 'thr_123',
        turnId: 'turn_1',
        callId: 'tool_stock_search_fractional_limit',
        namespace: 'openreelio',
        tool: 'stock_media_search',
        arguments: {
          query: 'city rain',
          assetType: 'video',
          limit: 3.9,
        },
      },
    })) as any;

    expect(response.success).toBe(true);
    expect(invoke).toHaveBeenCalledWith('search_stock_media', {
      query: 'city rain',
      assetType: 'video',
      limit: 3,
    });
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
    vi.mocked(invoke).mockImplementation(async (command, args) => {
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
      if (command === 'create_external_agent_approval_token') {
        return {
          token: 'grant-token-command',
          tokenId: 'grant-command-1',
          sessionId: 'thr_123',
          runId: null,
          planId: 'codex-command-thr_123-13',
          projectId: 'project-1',
          runtimeId: 'codex',
          scopes: ['openreelio.plan.apply'],
          createdAt: 1,
          expiresAt: 2,
        };
      }
      if (command === 'execute_agent_plan') {
        expect(args).toMatchObject({
          plan: {
            id: 'codex-command-thr_123-13',
            goal: 'Add a B-roll track',
            approvalGranted: true,
            approvalProof: {
              token: 'grant-token-command',
              tokenId: 'grant-command-1',
              projectId: 'project-1',
              runtimeId: 'codex',
              requiredScope: 'openreelio.plan.apply',
            },
            sessionId: 'thr_123',
            steps: [
              {
                id: 'step-1',
                toolName: 'CreateTrack',
                params: {
                  sequenceId: 'seq_1',
                  name: 'B-roll',
                  kind: 'video',
                  position: 0,
                },
                description: 'Add a B-roll track',
                riskLevel: 'medium',
                dependsOn: [],
                optional: false,
              },
            ],
          },
        });
        return {
          planId: 'codex-command-thr_123-13',
          success: true,
          totalSteps: 1,
          stepsCompleted: 1,
          stepResults: [
            {
              stepId: 'step-1',
              success: true,
              data: { createdIds: ['track_1'] },
              durationMs: 1,
              operationId: 'op_1',
            },
          ],
          operationIds: ['op_1'],
          rollbackReport: null,
          errorMessage: null,
          executionTimeMs: 1,
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
        position: 0,
      },
    });
    expect(invoke).toHaveBeenCalledWith('create_external_agent_approval_token', {
      input: expect.objectContaining({
        sessionId: 'thr_123',
        planId: 'codex-command-thr_123-13',
        projectId: 'project-1',
        runtimeId: 'codex',
        scopes: ['openreelio.plan.apply'],
      }),
    });
    expect(invoke).toHaveBeenCalledWith(
      'execute_agent_plan',
      expect.objectContaining({
        plan: expect.objectContaining({
          id: 'codex-command-thr_123-13',
          approvalGranted: true,
          approvalProof: expect.objectContaining({
            token: 'grant-token-command',
            tokenId: 'grant-command-1',
            projectId: 'project-1',
            runtimeId: 'codex',
          }),
          sessionId: 'thr_123',
        }),
      }),
    );
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

  it('should default text overlays to the active sequence top visual track', async () => {
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
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === 'get_project_state') {
        return {
          meta: { name: 'Launch Cut' },
          assets: [],
          sequences: [
            {
              id: 'seq-active',
              name: 'Active Timeline',
              tracks: [
                {
                  id: 'text-top',
                  name: 'Text Overlay',
                  kind: 'overlay',
                  clips: [],
                  locked: false,
                  muted: false,
                  visible: true,
                },
                {
                  id: 'video-base',
                  name: 'Video 1',
                  kind: 'video',
                  clips: [{ id: 'clip-base', assetId: 'asset-video' }],
                  isBaseTrack: true,
                  locked: false,
                  muted: false,
                  visible: true,
                },
              ],
              markers: [],
            },
            {
              id: 'seq-inactive',
              name: 'Inactive Timeline',
              tracks: [{ id: 'old-video', name: 'Video 1', kind: 'video', clips: [] }],
              markers: [],
            },
          ],
          effects: [],
          activeSequenceId: 'seq-active',
          textClips: [],
          isDirty: false,
        };
      }
      if (command === 'validate_command_payload') {
        expect(args).toMatchObject({
          commandType: 'AddTextClip',
          payload: {
            sequenceId: 'seq-active',
            trackId: 'text-top',
          },
        });
        return null;
      }
      if (command === 'create_external_agent_approval_token') {
        return {
          token: 'grant-token-text',
          tokenId: 'grant-text-1',
          sessionId: 'thr_123',
          runId: null,
          planId: 'codex-command-thr_123-302',
          projectId: 'project-1',
          runtimeId: 'codex',
          scopes: ['openreelio.plan.apply'],
          createdAt: 1,
          expiresAt: 2,
        };
      }
      if (command === 'execute_agent_plan') {
        expect(args).toMatchObject({
          plan: {
            steps: [
              {
                toolName: 'AddTextClip',
                params: {
                  sequenceId: 'seq-active',
                  trackId: 'text-top',
                },
              },
            ],
          },
        });
        return {
          planId: 'codex-command-thr_123-302',
          success: true,
          totalSteps: 1,
          stepsCompleted: 1,
          stepResults: [],
          operationIds: ['op_text'],
          rollbackReport: null,
          errorMessage: null,
          executionTimeMs: 1,
        };
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    projectStoreMocks.refreshFromBackendMutation.mockResolvedValue(14);
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
      id: 301,
      method: 'item/tool/call',
      params: {
        threadId: 'thr_123',
        turnId: 'turn_1',
        callId: 'tool_context',
        namespace: 'openreelio',
        tool: 'timeline_snapshot',
        arguments: {},
      },
    })) as any;
    const contextToken = JSON.parse(getFirstTextContent(contextResponse)).contextToken;

    const response = (await respondToRequest({
      id: 302,
      method: 'item/tool/call',
      params: {
        threadId: 'thr_123',
        turnId: 'turn_1',
        callId: 'tool_add_text',
        namespace: 'openreelio',
        tool: 'command_execute',
        arguments: {
          commandType: 'AddTextClip',
          payload: {
            sequenceId: 'seq-inactive',
            trackId: 'old-video',
            timelineIn: 1,
            duration: 2,
            textData: {
              content: 'Current timeline caption',
              style: { fontSize: 64, color: { r: 255, g: 255, b: 255, a: 255 } },
              position: { x: 0.5, y: 0.82 },
              opacity: 1,
            },
          },
          reason: 'Add visible text to this timeline.',
          contextToken,
        },
      },
    })) as any;

    expect(response.success).toBe(true);
    expect(approvalDecisionProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        args: expect.objectContaining({
          commandType: 'AddTextClip',
          payload: expect.objectContaining({
            sequenceId: 'seq-active',
            trackId: 'text-top',
          }),
        }),
      }),
    );
    expect(getFirstTextContent(response)).toContain('active_sequence_defaulted');
    expect(getFirstTextContent(response)).toContain('text_overlay_track_defaulted');
  });

  it('should normalize raw plan InsertClip media to a preview-compatible video track', async () => {
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
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === 'get_project_state') {
        return {
          meta: { name: 'Project' },
          activeSequenceId: 'seq-active',
          assets: [{ id: 'asset-video', kind: 'video', name: 'Interview' }],
          sequences: [
            {
              id: 'seq-active',
              name: 'Active Timeline',
              tracks: [
                {
                  id: 'overlay-track',
                  name: 'Overlay 1',
                  kind: 'overlay',
                  clips: [],
                  locked: false,
                  muted: false,
                  visible: true,
                },
                {
                  id: 'video-base',
                  name: 'Video 1',
                  kind: 'video',
                  clips: [],
                  isBaseTrack: true,
                  locked: false,
                  muted: false,
                  visible: true,
                },
              ],
              markers: [],
            },
          ],
          effects: [],
          textClips: [],
          isDirty: false,
        };
      }
      if (command === 'validate_command_payload') {
        expect(args).toMatchObject({
          commandType: 'InsertClip',
          payload: {
            sequenceId: 'seq-active',
            trackId: 'video-base',
            assetId: 'asset-video',
            timelineStart: 0,
          },
        });
        return null;
      }
      if (command === 'create_external_agent_approval_token') {
        return {
          token: 'grant-token-insert',
          tokenId: 'grant-insert-1',
          sessionId: 'thr_123',
          runId: null,
          planId: 'plan_insert_media',
          projectId: 'project-1',
          runtimeId: 'codex',
          scopes: ['openreelio.plan.apply'],
          createdAt: 1,
          expiresAt: 2,
        };
      }
      if (command === 'execute_agent_plan') {
        expect(args).toMatchObject({
          plan: {
            steps: [
              {
                toolName: 'InsertClip',
                params: {
                  sequenceId: 'seq-active',
                  trackId: 'video-base',
                  assetId: 'asset-video',
                  timelineStart: 0,
                },
              },
            ],
          },
        });
        return {
          planId: 'plan_insert_media',
          success: true,
          totalSteps: 1,
          stepsCompleted: 1,
          stepResults: [],
          operationIds: ['op_insert'],
          rollbackReport: null,
          errorMessage: null,
          executionTimeMs: 1,
        };
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    projectStoreMocks.refreshFromBackendMutation.mockResolvedValue(15);
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
      id: 401,
      method: 'item/tool/call',
      params: {
        threadId: 'thr_123',
        turnId: 'turn_1',
        callId: 'tool_context',
        namespace: 'openreelio',
        tool: 'timeline_snapshot',
        arguments: {},
      },
    })) as any;
    const contextToken = JSON.parse(getFirstTextContent(contextResponse)).contextToken;

    const response = (await respondToRequest({
      id: 402,
      method: 'item/tool/call',
      params: {
        threadId: 'thr_123',
        turnId: 'turn_1',
        callId: 'tool_plan_insert_media',
        namespace: 'openreelio',
        tool: 'plan_apply',
        arguments: {
          plan: {
            id: 'plan_insert_media',
            goal: 'Place media on the current edit',
            steps: [
              {
                id: 'insert_video',
                toolName: 'InsertClip',
                params: {
                  sequenceId: 'seq-active',
                  trackId: 'overlay-track',
                  assetId: 'asset-video',
                  timelineStart: 0,
                },
              },
            ],
          },
          reason: 'Place video on the current edit',
          contextToken,
        },
      },
    })) as any;

    expect(response.success).toBe(true);
    expect(getFirstTextContent(response)).toContain('main_video_track_defaulted');
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
      if (command === 'execute_agent_plan') {
        expect(args).toMatchObject({
          plan: {
            id: 'plan_1',
            approvalGranted: true,
            approvalProof: {
              token: 'grant-token',
              tokenId: 'grant-1',
              projectId: 'project-1',
              runtimeId: 'codex',
              requiredScope: 'openreelio.plan.apply',
            },
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
        position: 0,
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
    expect(invoke).toHaveBeenCalledWith(
      'execute_agent_plan',
      expect.objectContaining({
        plan: expect.objectContaining({
          id: 'plan_1',
          approvalGranted: true,
          approvalProof: expect.objectContaining({
            token: 'grant-token',
            tokenId: 'grant-1',
            projectId: 'project-1',
            runtimeId: 'codex',
          }),
          sessionId: 'thr_123',
        }),
      }),
    );
    expect(projectStoreMocks.refreshFromBackendMutation).toHaveBeenCalled();
    expect(response.success).toBe(true);
    expect(getFirstTextContent(response)).toContain('"status": "ok"');
    expect(getFirstTextContent(response)).toContain('"tokenId": "grant-1"');
  });

  it('should retry OpenReelio plan execution once when the approval proof is rejected before any step runs', async () => {
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
    let approvalTokenRequestCount = 0;
    let executePlanRequestCount = 0;
    const executePlanArgs: any[] = [];

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
        approvalTokenRequestCount += 1;
        return {
          token: `grant-token-${approvalTokenRequestCount}`,
          tokenId: `grant-${approvalTokenRequestCount}`,
          sessionId: 'thr_123',
          runId: null,
          planId: 'plan_retry',
          projectId: 'project-1',
          runtimeId: 'codex',
          scopes: ['openreelio.plan.apply'],
          createdAt: 1,
          expiresAt: 2,
        };
      }
      if (command === 'execute_agent_plan') {
        executePlanRequestCount += 1;
        executePlanArgs.push(args);

        if (executePlanRequestCount === 1) {
          return {
            planId: 'plan_retry',
            success: false,
            totalSteps: 1,
            stepsCompleted: 0,
            stepResults: [],
            operationIds: [],
            rollbackReport: null,
            errorMessage: 'approvalToken is invalid or expired',
            executionTimeMs: 1,
          };
        }

        return {
          planId: 'plan_retry',
          success: true,
          totalSteps: 1,
          stepsCompleted: 1,
          stepResults: [],
          operationIds: ['op_1'],
          rollbackReport: null,
          errorMessage: null,
          executionTimeMs: 3,
        };
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    projectStoreMocks.refreshFromBackendMutation.mockResolvedValue(9);
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
      id: 40,
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
      id: 'plan_retry',
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
      id: 41,
      method: 'item/tool/call',
      params: {
        threadId: 'thr_123',
        turnId: 'turn_1',
        callId: 'tool_plan_apply_retry',
        namespace: 'openreelio',
        tool: 'plan_apply',
        arguments: {
          plan,
          reason: 'Apply a one-step B-roll track plan',
          contextToken,
        },
      },
    })) as any;

    expect(approvalTokenRequestCount).toBe(2);
    expect(executePlanRequestCount).toBe(2);
    expect(executePlanArgs[0]).toMatchObject({
      plan: {
        approvalProof: {
          token: 'grant-token-1',
          tokenId: 'grant-1',
        },
      },
    });
    expect(executePlanArgs[1]).toMatchObject({
      plan: {
        approvalProof: {
          token: 'grant-token-2',
          tokenId: 'grant-2',
        },
      },
    });
    expect(response.success).toBe(true);
    expect(getFirstTextContent(response)).toContain('"status": "ok"');
    expect(getFirstTextContent(response)).toContain('"tokenId": "grant-2"');
    expect(getFirstTextContent(response)).toContain('"retried": true');
    expect(getFirstTextContent(response)).toContain('"initialTokenId": "grant-1"');
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

  it('should surface state-aware caption track validation errors before plan approval', async () => {
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
      if (command === 'validate_command_payload') {
        throw new Error(
          'ImportGeneratedCaptions requires a caption track, but track video_1 is Video',
        );
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

    const response = (await respondToRequest({
      id: 33,
      method: 'item/tool/call',
      params: {
        threadId: 'thr_123',
        turnId: 'turn_1',
        callId: 'tool_plan_validate_caption_track',
        namespace: 'openreelio',
        tool: 'plan_validate',
        arguments: {
          plan: {
            id: 'caption-plan',
            goal: 'Import generated captions',
            steps: [
              {
                id: 'import_captions',
                toolName: 'ImportGeneratedCaptions',
                params: {
                  sequenceId: 'seq_1',
                  trackId: 'video_1',
                  segments: [{ startSec: 0, endSec: 1, text: 'Caption' }],
                },
              },
            ],
          },
        },
      },
    })) as any;

    expect(response.success).toBe(false);
    expect(getFirstTextContent(response)).toContain('"status": "error"');
    expect(getFirstTextContent(response)).toContain('requires a caption track');
    expect(approvalDecisionProvider).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith('validate_command_payload', {
      commandType: 'ImportGeneratedCaptions',
      payload: {
        sequenceId: 'seq_1',
        trackId: 'video_1',
        segments: [{ startSec: 0, endSec: 1, text: 'Caption' }],
      },
    });
    expect(invoke).not.toHaveBeenCalledWith(
      'create_external_agent_approval_token',
      expect.anything(),
    );
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
        throw new Error('Invalid command payload: track name is reserved');
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
        sequenceId: 'seq_1',
        name: 'B-roll',
        kind: 'video',
        position: 0,
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
