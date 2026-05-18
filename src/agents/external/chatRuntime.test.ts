import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { persistPermissionAudit } from '@/agents/engine/core/permissionAudit';
import type { MessagePart } from '@/agents/engine/core/conversation';
import { usePermissionStore } from '@/stores/permissionStore';

import { ExternalAgentApprovalBroker } from './approvalBroker';
import {
  ExternalAgentChatRuntimeController,
  type ExternalAgentConversationGateway,
} from './chatRuntime';
import type { ExternalAgentSessionPersistence } from './sessionPersistence';
import type {
  ExternalAgentRuntimeAdapter,
  ExternalAgentRuntimeEvent,
  ExternalAgentRuntimeEventHandler,
  ExternalAgentSessionHandle,
} from './types';

vi.mock('@/agents/engine/core/permissionAudit', () => ({
  persistPermissionAudit: vi.fn(),
}));

class FakeConversationGateway implements ExternalAgentConversationGateway {
  activeSessionId: string | null = 'session-1';
  readonly messages = new Map<string, MessagePart[]>();
  readonly updateCalls: Array<{
    messageId: string;
    partIndex: number;
    update: Partial<MessagePart>;
  }> = [];
  readonly ensureSession = vi.fn(async () => this.activeSessionId);
  readonly finalizeMessage = vi.fn();
  private nextMessageId = 1;

  getActiveSessionId(): string | null {
    return this.activeSessionId;
  }

  startAssistantMessage(): string {
    const id = `assistant-${this.nextMessageId}`;
    this.nextMessageId += 1;
    this.messages.set(id, []);
    return id;
  }

  appendPart(messageId: string, part: MessagePart): void {
    this.messages.get(messageId)?.push(part);
  }

  updatePart(messageId: string, partIndex: number, update: Partial<MessagePart>): void {
    this.updateCalls.push({ messageId, partIndex, update });
    const parts = this.messages.get(messageId);
    const part = parts?.[partIndex];
    if (parts && part) {
      parts[partIndex] = { ...part, ...update } as MessagePart;
    }
  }

  getMessageParts(messageId: string): MessagePart[] | null {
    return this.messages.get(messageId) ?? null;
  }
}

class FakeExternalAgentAdapter implements ExternalAgentRuntimeAdapter {
  readonly id = 'codex' as const;
  readonly displayName = 'Codex';
  readonly startSession = vi.fn(async () => ({ sessionId: 'thr_123', runtimeId: this.id }));
  readonly resumeSession = vi.fn(async (input: { externalSessionId: string }) => ({
    sessionId: input.externalSessionId,
    runtimeId: this.id,
  }));
  readonly sendMessage = vi.fn(async () => undefined);
  readonly interrupt = vi.fn(async () => undefined);
  readonly shutdown = vi.fn(async () => undefined);
  private handler: ExternalAgentRuntimeEventHandler | null = null;

  async detect() {
    return {
      runtimeId: this.id,
      displayName: this.displayName,
      installStatus: 'installed' as const,
      authStatus: 'signed-in' as const,
      available: true,
      version: '1.0.0',
      reason: null,
    };
  }

  async authStatus() {
    return 'signed-in' as const;
  }

  async capabilities() {
    return {
      streamingEvents: true,
      interrupt: true,
      mcpClient: true,
      approvalAware: true,
      localAccountAuth: true,
      sessionResume: true,
      structuredToolCalls: true,
    };
  }

  subscribe(handler: ExternalAgentRuntimeEventHandler): () => void {
    this.handler = handler;
    return () => {
      this.handler = null;
    };
  }

  emit(event: ExternalAgentRuntimeEvent): void {
    this.handler?.(event);
  }
}

class FakeExternalAgentSessionPersistence implements ExternalAgentSessionPersistence {
  readonly load = vi.fn(
    async (): Promise<ExternalAgentSessionHandle | null> => this.nextLoadResult,
  );
  readonly save = vi.fn(async () => undefined);
  nextLoadResult: ExternalAgentSessionHandle | null = null;
}

describe('ExternalAgentChatRuntimeController', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    usePermissionStore.getState().loadDefaults();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should start an external session with project cwd and send user messages through the adapter', async () => {
    const conversation = new FakeConversationGateway();
    const adapter = new FakeExternalAgentAdapter();
    const states: string[] = [];
    const controller = new ExternalAgentChatRuntimeController({
      adapter,
      conversation,
      projectId: 'project-1',
      cwd: '/project',
      onStateChange: (state) => states.push(state.phase),
    });

    await controller.sendMessage('Inspect this timeline');

    expect(conversation.ensureSession).toHaveBeenCalledWith('codex');
    expect(adapter.startSession).toHaveBeenCalledWith({
      projectId: 'project-1',
      cwd: '/project',
    });
    expect(adapter.sendMessage).toHaveBeenCalledWith('thr_123', {
      content: 'Inspect this timeline',
      cwd: '/project',
    });
    expect(states).toContain('starting');
    expect(states).toContain('running');
  });

  it('should create a conversation session when no active session exists', async () => {
    const conversation = new FakeConversationGateway();
    conversation.activeSessionId = null;
    conversation.ensureSession.mockImplementationOnce(async () => {
      conversation.activeSessionId = 'session-created';
      return 'session-created';
    });
    const adapter = new FakeExternalAgentAdapter();
    const controller = new ExternalAgentChatRuntimeController({
      adapter,
      conversation,
      projectId: 'project-1',
    });

    await controller.sendMessage('Initialize session');

    expect(conversation.ensureSession).toHaveBeenCalledWith('codex');
    expect(adapter.startSession).toHaveBeenCalledWith({
      projectId: 'project-1',
      cwd: null,
    });
    expect(adapter.sendMessage).toHaveBeenCalledWith('thr_123', {
      content: 'Initialize session',
      cwd: null,
    });
  });

  it('should stream assistant deltas into the active assistant message and finalize on turn completion', async () => {
    const conversation = new FakeConversationGateway();
    const adapter = new FakeExternalAgentAdapter();
    const onComplete = vi.fn();
    const controller = new ExternalAgentChatRuntimeController({
      adapter,
      conversation,
      projectId: 'project-1',
      onComplete,
    });

    await controller.sendMessage('Add captions');
    adapter.emit({
      type: 'assistant_delta',
      runtimeId: 'codex',
      sessionId: 'thr_123',
      itemId: 'item_1',
      content: 'Caption',
    });
    adapter.emit({
      type: 'assistant_delta',
      runtimeId: 'codex',
      sessionId: 'thr_123',
      itemId: 'item_1',
      content: 's added.',
    });
    adapter.emit({
      type: 'turn_completed',
      runtimeId: 'codex',
      sessionId: 'thr_123',
      turnId: 'turn_1',
      status: 'completed',
    });

    expect(conversation.getMessageParts('assistant-1')).toEqual([
      { type: 'text', content: 'Captions added.' },
    ]);
    expect(conversation.finalizeMessage).toHaveBeenCalledWith('assistant-1');
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('should keep external runtime state isolated per conversation session', async () => {
    const conversation = new FakeConversationGateway();
    const adapter = new FakeExternalAgentAdapter();
    adapter.startSession
      .mockResolvedValueOnce({ sessionId: 'thr_session_1', runtimeId: 'codex' })
      .mockResolvedValueOnce({ sessionId: 'thr_session_2', runtimeId: 'codex' });
    const controller = new ExternalAgentChatRuntimeController({
      adapter,
      conversation,
      projectId: 'project-1',
    });

    await controller.sendMessage('Long task in session 1');
    expect(controller.getState('session-1')).toMatchObject({
      phase: 'running',
      isRunning: true,
    });

    conversation.activeSessionId = 'session-2';
    controller.refreshState();
    expect(controller.getState()).toMatchObject({
      phase: 'idle',
      isRunning: false,
    });

    await controller.sendMessage('Independent task in session 2');
    expect(controller.getState('session-2')).toMatchObject({
      phase: 'running',
      isRunning: true,
    });

    adapter.emit({
      type: 'turn_completed',
      runtimeId: 'codex',
      sessionId: 'thr_session_1',
      turnId: 'turn_1',
      status: 'completed',
    });

    expect(controller.getState('session-1')).toMatchObject({
      phase: 'completed',
      isRunning: false,
    });
    expect(controller.getState('session-2')).toMatchObject({
      phase: 'running',
      isRunning: true,
    });
  });

  it('should ignore runtime events for untracked external sessions', async () => {
    const conversation = new FakeConversationGateway();
    const adapter = new FakeExternalAgentAdapter();
    const controller = new ExternalAgentChatRuntimeController({
      adapter,
      conversation,
      projectId: 'project-1',
    });

    await controller.sendMessage('Start session');
    adapter.emit({
      type: 'assistant_delta',
      runtimeId: 'codex',
      sessionId: 'thr_wrong_session',
      itemId: 'item_1',
      content: 'This should be ignored',
    });

    expect(conversation.getMessageParts('assistant-1')).toEqual([]);
    expect(conversation.finalizeMessage).not.toHaveBeenCalled();
  });

  it('should interrupt the active external session', async () => {
    const conversation = new FakeConversationGateway();
    const adapter = new FakeExternalAgentAdapter();
    const controller = new ExternalAgentChatRuntimeController({
      adapter,
      conversation,
      projectId: 'project-1',
    });

    await controller.sendMessage('Long task');
    await controller.interrupt();

    expect(adapter.interrupt).toHaveBeenCalledWith('thr_123');
  });

  it('should resume a persisted external session instead of creating a duplicate runtime session', async () => {
    const conversation = new FakeConversationGateway();
    const adapter = new FakeExternalAgentAdapter();
    const sessionPersistence = new FakeExternalAgentSessionPersistence();
    sessionPersistence.nextLoadResult = {
      sessionId: 'thr_existing',
      runtimeId: 'codex',
      metadata: { openReelioToolProtocolVersion: 3 },
    };
    const controller = new ExternalAgentChatRuntimeController({
      adapter,
      conversation,
      projectId: 'project-1',
      cwd: '/project',
      sessionPersistence,
    });

    await controller.sendMessage('Continue the existing edit');

    expect(sessionPersistence.load).toHaveBeenCalledWith({
      projectId: 'project-1',
      conversationSessionId: 'session-1',
      runtimeId: 'codex',
    });
    expect(adapter.resumeSession).toHaveBeenCalledWith({
      projectId: 'project-1',
      externalSessionId: 'thr_existing',
      cwd: '/project',
    });
    expect(adapter.startSession).not.toHaveBeenCalled();
    expect(adapter.sendMessage).toHaveBeenCalledWith('thr_existing', {
      content: 'Continue the existing edit',
      cwd: '/project',
    });
    expect(sessionPersistence.save).not.toHaveBeenCalled();
  });

  it('should replace a stale external session link when runtime resume fails', async () => {
    const conversation = new FakeConversationGateway();
    const adapter = new FakeExternalAgentAdapter();
    adapter.resumeSession.mockRejectedValueOnce(new Error('thread not found'));
    const sessionPersistence = new FakeExternalAgentSessionPersistence();
    sessionPersistence.nextLoadResult = {
      sessionId: 'thr_stale',
      runtimeId: 'codex',
      metadata: { openReelioToolProtocolVersion: 3 },
    };
    const controller = new ExternalAgentChatRuntimeController({
      adapter,
      conversation,
      projectId: 'project-1',
      cwd: '/project',
      sessionPersistence,
    });

    await controller.sendMessage('Start over if needed');

    expect(adapter.resumeSession).toHaveBeenCalledWith({
      projectId: 'project-1',
      externalSessionId: 'thr_stale',
      cwd: '/project',
    });
    expect(adapter.startSession).toHaveBeenCalledWith({
      projectId: 'project-1',
      cwd: '/project',
    });
    expect(sessionPersistence.save).toHaveBeenCalledWith({
      projectId: 'project-1',
      conversationSessionId: 'session-1',
      runtimeId: 'codex',
      externalSession: { sessionId: 'thr_123', runtimeId: 'codex' },
      metadata: { source: 'appServer', openReelioToolProtocolVersion: 3 },
    });
    expect(adapter.sendMessage).toHaveBeenCalledWith('thr_123', {
      content: 'Start over if needed',
      cwd: '/project',
    });
  });

  it('should start a fresh Codex session when the persisted link predates OpenReelio dynamic tools', async () => {
    const conversation = new FakeConversationGateway();
    const adapter = new FakeExternalAgentAdapter();
    const sessionPersistence = new FakeExternalAgentSessionPersistence();
    sessionPersistence.nextLoadResult = { sessionId: 'thr_legacy', runtimeId: 'codex' };
    const controller = new ExternalAgentChatRuntimeController({
      adapter,
      conversation,
      projectId: 'project-1',
      cwd: '/project',
      sessionPersistence,
    });

    await controller.sendMessage('Use the current OpenReelio context');

    expect(adapter.resumeSession).not.toHaveBeenCalled();
    expect(adapter.startSession).toHaveBeenCalledWith({
      projectId: 'project-1',
      cwd: '/project',
    });
    expect(sessionPersistence.save).toHaveBeenCalledWith({
      projectId: 'project-1',
      conversationSessionId: 'session-1',
      runtimeId: 'codex',
      externalSession: { sessionId: 'thr_123', runtimeId: 'codex' },
      metadata: { source: 'appServer', openReelioToolProtocolVersion: 3 },
    });
  });

  it('should not persist a fresh external session link when the first turn cannot start', async () => {
    const conversation = new FakeConversationGateway();
    const adapter = new FakeExternalAgentAdapter();
    adapter.sendMessage.mockRejectedValueOnce(new Error('turn failed'));
    const sessionPersistence = new FakeExternalAgentSessionPersistence();
    const controller = new ExternalAgentChatRuntimeController({
      adapter,
      conversation,
      projectId: 'project-1',
      cwd: '/project',
      sessionPersistence,
    });

    await controller.sendMessage('This turn will fail');

    expect(adapter.startSession).toHaveBeenCalledWith({
      projectId: 'project-1',
      cwd: '/project',
    });
    expect(sessionPersistence.save).not.toHaveBeenCalled();
    expect(controller.getState().phase).toBe('failed');
  });

  it('should append a recoverable error part when the external turn fails', async () => {
    const conversation = new FakeConversationGateway();
    const adapter = new FakeExternalAgentAdapter();
    const onError = vi.fn();
    const controller = new ExternalAgentChatRuntimeController({
      adapter,
      conversation,
      projectId: 'project-1',
      onError,
    });

    await controller.sendMessage('Run out of quota');
    adapter.emit({
      type: 'turn_completed',
      runtimeId: 'codex',
      sessionId: 'thr_123',
      turnId: 'turn_1',
      status: 'failed',
      error: 'Usage limit exceeded',
    });

    expect(conversation.getMessageParts('assistant-1')).toEqual([
      {
        type: 'error',
        code: 'EXTERNAL_AGENT_ERROR',
        message: 'Usage limit exceeded',
        phase: 'external_agent',
        recoverable: true,
      },
    ]);
    expect(conversation.finalizeMessage).toHaveBeenCalledWith('assistant-1');
    expect(onError).toHaveBeenCalledWith(new Error('Usage limit exceeded'));
  });

  it('should keep tool calls intact when streaming file changes for the same item', async () => {
    const conversation = new FakeConversationGateway();
    const adapter = new FakeExternalAgentAdapter();
    const controller = new ExternalAgentChatRuntimeController({
      adapter,
      conversation,
      projectId: 'project-1',
    });

    await controller.sendMessage('Modify the timeline');
    adapter.emit({
      type: 'tool_started',
      runtimeId: 'codex',
      sessionId: 'thr_123',
      itemId: 'tool_1',
      tool: 'apply_patch',
      args: { file: 'src/App.tsx' },
      description: 'Patch App.tsx',
    });
    adapter.emit({
      type: 'file_change',
      runtimeId: 'codex',
      sessionId: 'thr_123',
      itemId: 'tool_1',
      diff: 'diff --git a/src/App.tsx b/src/App.tsx',
      files: ['src/App.tsx'],
    });
    adapter.emit({
      type: 'tool_completed',
      runtimeId: 'codex',
      sessionId: 'thr_123',
      itemId: 'tool_1',
      tool: 'apply_patch',
      success: true,
      durationMs: 42,
      result: { changed: true },
    });

    const parts = conversation.getMessageParts('assistant-1') ?? [];
    expect(parts).toHaveLength(3);
    expect(parts[0]).toMatchObject({
      type: 'tool_call',
      stepId: 'tool_1',
      status: 'completed',
      tool: 'apply_patch',
    });
    expect(parts[1]).toEqual({
      type: 'patch',
      diff: 'diff --git a/src/App.tsx b/src/App.tsx',
      files: ['src/App.tsx'],
    });
    expect(parts[2]).toMatchObject({
      type: 'tool_result',
      stepId: 'tool_1',
      tool: 'apply_patch',
      success: true,
    });
  });

  it('should shut down tracked runtime sessions when disposed', async () => {
    const conversation = new FakeConversationGateway();
    const adapter = new FakeExternalAgentAdapter();
    const controller = new ExternalAgentChatRuntimeController({
      adapter,
      conversation,
      projectId: 'project-1',
    });

    await controller.sendMessage('Start a session');
    controller.dispose();

    expect(adapter.shutdown).toHaveBeenCalledWith('thr_123');
  });

  it('should ignore runtime events after disposal', async () => {
    const conversation = new FakeConversationGateway();
    const adapter = new FakeExternalAgentAdapter();
    const controller = new ExternalAgentChatRuntimeController({
      adapter,
      conversation,
      projectId: 'project-1',
    });

    await controller.sendMessage('Start a session');
    controller.dispose();
    adapter.emit({
      type: 'assistant_delta',
      runtimeId: 'codex',
      sessionId: 'thr_123',
      itemId: 'item_1',
      content: 'Late arrival',
    });

    expect(conversation.getMessageParts('assistant-1')).toEqual([]);
    expect(conversation.finalizeMessage).not.toHaveBeenCalled();
  });

  it('should shut down tracked runtime sessions before switching adapters', async () => {
    const conversation = new FakeConversationGateway();
    const adapter = new FakeExternalAgentAdapter();
    const nextAdapter = new FakeExternalAgentAdapter();
    const controller = new ExternalAgentChatRuntimeController({
      adapter,
      conversation,
      projectId: 'project-1',
    });

    await controller.sendMessage('Start a session');
    controller.updateContext({
      adapter: nextAdapter,
      projectId: 'project-1',
    });

    expect(adapter.shutdown).toHaveBeenCalledWith('thr_123');
    expect(nextAdapter.shutdown).not.toHaveBeenCalled();
  });

  it('should surface Codex approval requests and resolve them through the broker', async () => {
    const conversation = new FakeConversationGateway();
    const adapter = new FakeExternalAgentAdapter();
    const approvalBroker = new ExternalAgentApprovalBroker({ timeoutMs: 0 });
    const controller = new ExternalAgentChatRuntimeController({
      adapter,
      conversation,
      projectId: 'project-1',
      approvalBroker,
    });

    await controller.sendMessage('Edit files');
    expect(conversation.getMessageParts('assistant-1')).toEqual([]);
    const decisionPromise = approvalBroker.requestDecision({
      id: 'codex:12',
      runtimeId: 'codex',
      sessionId: 'thr_123',
      turnId: 'turn_1',
      itemId: 'patch_1',
      requestId: 12,
      approvalType: 'file_change',
      tool: 'Codex file change',
      description: 'Approve Codex file changes',
      args: { grantRoot: '/project' },
      reason: null,
      requestedAt: 1000,
    });
    adapter.emit({
      type: 'approval_requested',
      runtimeId: 'codex',
      sessionId: 'thr_123',
      itemId: 'patch_1',
      requestId: 12,
      approvalType: 'file_change',
      tool: 'Codex file change',
      description: 'Approve Codex file changes',
      args: { grantRoot: '/project' },
    });
    expect(conversation.getMessageParts('assistant-1')).toHaveLength(1);

    expect(controller.getState().pendingToolPermissionRequest).toEqual({
      id: 'codex:12',
      tool: 'Codex file change',
      description: 'Approve Codex file changes',
      args: { grantRoot: '/project' },
      riskLevel: 'high',
    });

    controller.resolveApproval('acceptForSession');

    await expect(decisionPromise).resolves.toBe('acceptForSession');
    expect(conversation.updateCalls).toContainEqual({
      messageId: 'assistant-1',
      partIndex: 0,
      update: { status: 'approved' },
    });
    expect(conversation.getMessageParts('assistant-1')?.[0]).toMatchObject({
      status: 'approved',
    });
    expect(conversation.getMessageParts('assistant-1')).toEqual([
      {
        type: 'tool_approval',
        stepId: 'codex:12',
        tool: 'Codex file change',
        args: { grantRoot: '/project' },
        description: 'Approve Codex file changes',
        riskLevel: 'high',
        status: 'approved',
      },
    ]);
    expect(persistPermissionAudit).toHaveBeenCalledWith(
      'session-1',
      null,
      'codex:12',
      expect.objectContaining({
        subjectType: 'approval',
        subject: 'external_agent.codex.file_change.Codex file change',
        source: 'interactive_approval',
      }),
      'allow_always',
      'interactive_approval',
    );
    expect(
      usePermissionStore.getState().resolvePermission('external_agent_file_change', {
        grantRoot: '/project',
        approvalType: 'file_change',
        runtimeId: 'codex',
        externalTool: 'Codex file change',
      }),
    ).toBe('allow');
  });

  it('should surface broker-only OpenReelio approval requests as chat cards', async () => {
    const conversation = new FakeConversationGateway();
    const adapter = new FakeExternalAgentAdapter();
    const approvalBroker = new ExternalAgentApprovalBroker({ timeoutMs: 0 });
    const controller = new ExternalAgentChatRuntimeController({
      adapter,
      conversation,
      projectId: 'project-1',
      approvalBroker,
    });

    await controller.sendMessage('Apply the OpenReelio plan');
    const decisionPromise = approvalBroker.requestDecision({
      id: 'codex:openreelio-plan:99:shorts-cleanup-v1',
      runtimeId: 'codex',
      sessionId: 'thr_123',
      turnId: 'turn_1',
      itemId: 'plan_apply_1',
      requestId: 99,
      approvalType: 'openreelio_plan_apply',
      tool: 'OpenReelio plan apply',
      description: 'Apply approved shorts cleanup plan',
      args: { planId: 'shorts-cleanup-v1', stepCount: 42 },
      reason: null,
      requestedAt: 1000,
    });

    expect(controller.getState().pendingToolPermissionRequest).toEqual({
      id: 'codex:openreelio-plan:99:shorts-cleanup-v1',
      tool: 'OpenReelio plan apply',
      description: 'Apply approved shorts cleanup plan',
      args: { planId: 'shorts-cleanup-v1', stepCount: 42 },
      riskLevel: 'medium',
    });
    expect(conversation.getMessageParts('assistant-1')).toEqual([
      {
        type: 'tool_approval',
        stepId: 'codex:openreelio-plan:99:shorts-cleanup-v1',
        tool: 'OpenReelio plan apply',
        args: { planId: 'shorts-cleanup-v1', stepCount: 42 },
        description: 'Apply approved shorts cleanup plan',
        riskLevel: 'medium',
        status: 'pending',
      },
    ]);

    controller.resolveApproval('accept');

    await expect(decisionPromise).resolves.toBe('accept');
    expect(controller.getState().pendingToolPermissionRequest).toBeNull();
    expect(conversation.getMessageParts('assistant-1')?.[0]).toMatchObject({
      status: 'approved',
    });
  });

  it('should treat unknown approval types as high risk', async () => {
    const conversation = new FakeConversationGateway();
    const adapter = new FakeExternalAgentAdapter();
    const approvalBroker = new ExternalAgentApprovalBroker({ timeoutMs: 0 });
    const controller = new ExternalAgentChatRuntimeController({
      adapter,
      conversation,
      projectId: 'project-1',
      approvalBroker,
    });

    await controller.sendMessage('Inspect request');
    const decisionPromise = approvalBroker.requestDecision({
      id: 'codex:42',
      runtimeId: 'codex',
      sessionId: 'thr_123',
      turnId: 'turn_1',
      itemId: 'approval_unknown',
      requestId: 42,
      approvalType: 'unknown',
      tool: 'Codex approval',
      description: 'Unknown approval request',
      args: {},
      reason: null,
      requestedAt: 1000,
    });
    adapter.emit({
      type: 'approval_requested',
      runtimeId: 'codex',
      sessionId: 'thr_123',
      itemId: 'approval_unknown',
      requestId: 42,
      approvalType: 'unknown',
      tool: 'Codex approval',
      description: 'Unknown approval request',
      args: {},
    });

    expect(controller.getState().pendingToolPermissionRequest).toEqual({
      id: 'codex:42',
      tool: 'Codex approval',
      description: 'Unknown approval request',
      args: {},
      riskLevel: 'high',
    });
    expect(conversation.getMessageParts('assistant-1')).toEqual([
      {
        type: 'tool_approval',
        stepId: 'codex:42',
        tool: 'Codex approval',
        args: {},
        description: 'Unknown approval request',
        riskLevel: 'high',
        status: 'pending',
      },
    ]);

    controller.resolveApproval('decline');
    await expect(decisionPromise).resolves.toBe('decline');
    expect(controller.getState().pendingToolPermissionRequest).toBeNull();
    expect(conversation.getMessageParts('assistant-1')?.[0]).toMatchObject({
      status: 'denied',
    });
  });

  it('should mark approval parts denied when the user declines a request', async () => {
    const conversation = new FakeConversationGateway();
    const adapter = new FakeExternalAgentAdapter();
    const approvalBroker = new ExternalAgentApprovalBroker({ timeoutMs: 0 });
    const controller = new ExternalAgentChatRuntimeController({
      adapter,
      conversation,
      projectId: 'project-1',
      approvalBroker,
    });

    await controller.sendMessage('Edit files');
    const decisionPromise = approvalBroker.requestDecision({
      id: 'codex:12',
      runtimeId: 'codex',
      sessionId: 'thr_123',
      turnId: 'turn_1',
      itemId: 'patch_1',
      requestId: 12,
      approvalType: 'file_change',
      tool: 'Codex file change',
      description: 'Approve Codex file changes',
      args: { grantRoot: '/project' },
      reason: null,
      requestedAt: 1000,
    });
    adapter.emit({
      type: 'approval_requested',
      runtimeId: 'codex',
      sessionId: 'thr_123',
      itemId: 'patch_1',
      requestId: 12,
      approvalType: 'file_change',
      tool: 'Codex file change',
      description: 'Approve Codex file changes',
      args: { grantRoot: '/project' },
    });

    controller.resolveApproval('decline');

    await expect(decisionPromise).resolves.toBe('decline');
    expect(conversation.getMessageParts('assistant-1')?.[0]).toMatchObject({
      status: 'denied',
    });
    expect(persistPermissionAudit).toHaveBeenCalledWith(
      'session-1',
      null,
      'codex:12',
      expect.objectContaining({
        subjectType: 'approval',
        subject: 'external_agent.codex.file_change.Codex file change',
        source: 'interactive_approval',
      }),
      'deny',
      'interactive_approval',
    );
  });

  it('should mark approval parts denied when the request times out', async () => {
    const conversation = new FakeConversationGateway();
    const adapter = new FakeExternalAgentAdapter();
    const approvalBroker = new ExternalAgentApprovalBroker({ timeoutMs: 50 });
    const controller = new ExternalAgentChatRuntimeController({
      adapter,
      conversation,
      projectId: 'project-1',
      approvalBroker,
    });

    await controller.sendMessage('Edit files');
    vi.useFakeTimers();
    const decisionPromise = approvalBroker.requestDecision({
      id: 'codex:12',
      runtimeId: 'codex',
      sessionId: 'thr_123',
      turnId: 'turn_1',
      itemId: 'patch_1',
      requestId: 12,
      approvalType: 'file_change',
      tool: 'Codex file change',
      description: 'Approve Codex file changes',
      args: { grantRoot: '/project' },
      reason: null,
      requestedAt: 1000,
    });
    adapter.emit({
      type: 'approval_requested',
      runtimeId: 'codex',
      sessionId: 'thr_123',
      itemId: 'patch_1',
      requestId: 12,
      approvalType: 'file_change',
      tool: 'Codex file change',
      description: 'Approve Codex file changes',
      args: { grantRoot: '/project' },
    });

    vi.advanceTimersByTime(50);

    await expect(decisionPromise).resolves.toBe('decline');
    expect(controller.getState().pendingToolPermissionRequest).toBeNull();
    expect(conversation.getMessageParts('assistant-1')?.[0]).toMatchObject({
      status: 'denied',
    });
    expect(persistPermissionAudit).toHaveBeenCalledWith(
      'session-1',
      null,
      'codex:12',
      expect.objectContaining({
        subjectType: 'approval',
        subject: 'external_agent.codex.file_change.Codex file change',
        source: 'interactive_approval',
      }),
      'deny',
      'interactive_approval',
    );
  });
});
