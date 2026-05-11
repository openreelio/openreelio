import {
  createErrorPart,
  createReasoningPart,
  createTextPart,
  createToolResultPart,
  type MessagePart,
} from '@/agents/engine/core/conversation';
import { persistPermissionAudit } from '@/agents/engine/core/permissionAudit';
import type { RiskLevel } from '@/agents/engine/core/types';
import { useConversationStore } from '@/stores/conversationStore';

import type { ExternalAgentApprovalBroker } from './approvalBroker';
import type { ExternalAgentSessionPersistence } from './sessionPersistence';
import type {
  ExternalAgentApprovalDecision,
  ExternalAgentApprovalRequest,
  ExternalAgentRuntimeAdapter,
  ExternalAgentRuntimeEvent,
  ExternalAgentSessionHandle,
} from './types';

export type ExternalAgentChatPhase =
  | 'idle'
  | 'starting'
  | 'running'
  | 'completed'
  | 'failed'
  | 'aborted';

export interface ExternalAgentChatRuntimeState {
  phase: ExternalAgentChatPhase;
  isRunning: boolean;
  error: Error | null;
  startedTools: number;
  completedTools: number;
  latestIteration: number;
  pendingToolPermissionRequest: {
    id: string;
    tool: string;
    args: Record<string, unknown>;
    description: string;
    riskLevel: RiskLevel;
  } | null;
}

export interface ExternalAgentConversationGateway {
  getActiveSessionId(): string | null;
  ensureSession(agent?: string): Promise<string | null>;
  startAssistantMessage(sessionId?: string): string;
  appendPart(messageId: string, part: MessagePart): void;
  updatePart(messageId: string, partIndex: number, update: Partial<MessagePart>): void;
  finalizeMessage(messageId: string): void;
  getMessageParts(messageId: string): MessagePart[] | null;
}

export interface ExternalAgentChatRuntimeControllerOptions {
  adapter: ExternalAgentRuntimeAdapter;
  conversation: ExternalAgentConversationGateway;
  projectId: string | null;
  cwd?: string | null;
  enabled?: boolean;
  approvalBroker?: ExternalAgentApprovalBroker;
  sessionPersistence?: ExternalAgentSessionPersistence;
  onStateChange?: (state: ExternalAgentChatRuntimeState) => void;
  onComplete?: () => void;
  onAbort?: () => void;
  onError?: (error: Error) => void;
}

const INITIAL_STATE: ExternalAgentChatRuntimeState = {
  phase: 'idle',
  isRunning: false,
  error: null,
  startedTools: 0,
  completedTools: 0,
  latestIteration: 0,
  pendingToolPermissionRequest: null,
};

export class ExternalAgentChatRuntimeController {
  private projectId: string | null;
  private cwd: string | null;
  private enabled: boolean;
  private state = INITIAL_STATE;
  private readonly sessionByConversationSessionId = new Map<string, ExternalAgentSessionHandle>();
  private readonly messageIdByExternalSessionId = new Map<string, string>();
  private readonly textDeltaMessages = new Set<string>();
  private readonly itemPartIndex = new Map<string, number>();
  private readonly approvalPartIndex = new Map<string, { messageId: string; partIndex: number }>();
  private readonly conversationSessionsPendingPersistence = new Set<string>();
  private activeConversationSessionId: string | null = null;
  private unsubscribe: (() => void) | null = null;
  private unsubscribeApprovalBroker: (() => void) | null = null;
  private callbacks: Pick<
    ExternalAgentChatRuntimeControllerOptions,
    'onStateChange' | 'onComplete' | 'onAbort' | 'onError'
  >;

  constructor(private readonly options: ExternalAgentChatRuntimeControllerOptions) {
    this.projectId = options.projectId;
    this.cwd = options.cwd ?? null;
    this.enabled = options.enabled ?? true;
    this.callbacks = {
      onStateChange: options.onStateChange,
      onComplete: options.onComplete,
      onAbort: options.onAbort,
      onError: options.onError,
    };
    this.unsubscribe = options.adapter.subscribe?.((event) => this.handleEvent(event)) ?? null;
    this.unsubscribeApprovalBroker =
      options.approvalBroker?.subscribe((snapshot) => {
        this.setState({
          pendingToolPermissionRequest: snapshot.pending
            ? mapApprovalRequestToPermissionRequest(snapshot.pending)
            : null,
        });
      }) ?? null;
  }

  updateContext(input: {
    adapter?: ExternalAgentRuntimeAdapter;
    projectId: string | null;
    cwd?: string | null;
    enabled?: boolean;
    onComplete?: () => void;
    onAbort?: () => void;
    onError?: (error: Error) => void;
  }): void {
    if (input.adapter && input.adapter !== this.options.adapter) {
      this.unsubscribe?.();
      this.options.adapter = input.adapter;
      this.unsubscribe = input.adapter.subscribe?.((event) => this.handleEvent(event)) ?? null;
      this.sessionByConversationSessionId.clear();
      this.messageIdByExternalSessionId.clear();
      this.activeConversationSessionId = null;
    }

    this.projectId = input.projectId;
    this.cwd = input.cwd ?? null;
    this.enabled = input.enabled ?? true;
    this.callbacks = {
      ...this.callbacks,
      onComplete: input.onComplete,
      onAbort: input.onAbort,
      onError: input.onError,
    };
  }

  getState(): ExternalAgentChatRuntimeState {
    return this.state;
  }

  async sendMessage(content: string): Promise<void> {
    if (!this.enabled) {
      this.fail(new Error('External agent runtime is not ready'));
      return;
    }

    if (!this.projectId) {
      this.fail(new Error('Open a project before starting an external agent session'));
      return;
    }

    this.setState({
      phase: 'starting',
      isRunning: true,
      error: null,
    });

    const conversationSessionId = await this.options.conversation.ensureSession(
      this.options.adapter.id,
    );
    if (!conversationSessionId) {
      this.fail(new Error('Unable to create an OpenReelio AI session'));
      return;
    }

    try {
      const externalSession = await this.ensureExternalSession(conversationSessionId);
      this.activeConversationSessionId = conversationSessionId;
      this.messageIdByExternalSessionId.set(
        externalSession.sessionId,
        this.options.conversation.startAssistantMessage(conversationSessionId),
      );
      this.setState({ phase: 'running', isRunning: true, error: null });
      await this.options.adapter.sendMessage(externalSession.sessionId, {
        content,
        cwd: this.cwd,
      });
      await this.persistExternalSessionAfterTurnStart(conversationSessionId, externalSession);
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async interrupt(): Promise<void> {
    const activeSessionId = this.activeConversationSessionId;
    const externalSession = activeSessionId
      ? this.sessionByConversationSessionId.get(activeSessionId)
      : null;

    if (!externalSession) {
      this.finishActiveMessage('aborted');
      return;
    }

    try {
      await this.options.adapter.interrupt(externalSession.sessionId);
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  dispose(): void {
    this.options.approvalBroker?.declineAll();
    this.unsubscribe?.();
    this.unsubscribeApprovalBroker?.();
    this.unsubscribe = null;
    this.unsubscribeApprovalBroker = null;
  }

  resolveApproval(decision: ExternalAgentApprovalDecision): void {
    const pending = this.options.approvalBroker?.getSnapshot().pending ?? null;
    if (!pending) {
      return;
    }

    this.persistApprovalDecision(pending, decision);
    this.updateApprovalPartStatus(pending.id, decision === 'decline' || decision === 'cancel');
    this.options.approvalBroker?.resolve(pending.id, decision);
  }

  private async ensureExternalSession(
    conversationSessionId: string,
  ): Promise<ExternalAgentSessionHandle> {
    const existing = this.sessionByConversationSessionId.get(conversationSessionId);
    if (existing) {
      return existing;
    }

    const persisted = await this.loadPersistedExternalSession(conversationSessionId);
    if (persisted && this.options.adapter.resumeSession) {
      try {
        const resumed = await this.options.adapter.resumeSession({
          projectId: this.projectId ?? 'unknown',
          externalSessionId: persisted.sessionId,
          cwd: this.cwd,
        });
        this.sessionByConversationSessionId.set(conversationSessionId, resumed);
        return resumed;
      } catch {
        // Fall through to starting a fresh runtime session and replacing the stale link.
      }
    }

    const session = await this.options.adapter.startSession({
      projectId: this.projectId ?? 'unknown',
      cwd: this.cwd,
    });
    this.sessionByConversationSessionId.set(conversationSessionId, session);
    this.conversationSessionsPendingPersistence.add(conversationSessionId);
    return session;
  }

  private async loadPersistedExternalSession(
    conversationSessionId: string,
  ): Promise<ExternalAgentSessionHandle | null> {
    if (!this.options.sessionPersistence || !this.projectId) {
      return null;
    }

    return this.options.sessionPersistence.load({
      projectId: this.projectId,
      conversationSessionId,
      runtimeId: this.options.adapter.id,
    });
  }

  private async saveExternalSession(
    conversationSessionId: string,
    externalSession: ExternalAgentSessionHandle,
  ): Promise<void> {
    if (!this.options.sessionPersistence || !this.projectId) {
      return;
    }

    await this.options.sessionPersistence.save({
      projectId: this.projectId,
      conversationSessionId,
      runtimeId: this.options.adapter.id,
      externalSession,
      metadata: { source: 'appServer' },
    });
  }

  private async persistExternalSessionAfterTurnStart(
    conversationSessionId: string,
    externalSession: ExternalAgentSessionHandle,
  ): Promise<void> {
    if (!this.conversationSessionsPendingPersistence.has(conversationSessionId)) {
      return;
    }

    await this.saveExternalSession(conversationSessionId, externalSession);
    this.conversationSessionsPendingPersistence.delete(conversationSessionId);
  }

  private handleEvent(event: ExternalAgentRuntimeEvent): void {
    switch (event.type) {
      case 'assistant_delta':
        this.updateTrailingPart(event.sessionId, 'text', event.content);
        break;

      case 'assistant_completed':
        this.handleAssistantCompleted(event);
        break;

      case 'reasoning_delta':
        this.updateTrailingPart(event.sessionId, 'reasoning', event.content);
        break;

      case 'tool_started':
        this.handleToolStarted(event);
        break;

      case 'tool_completed':
        this.handleToolCompleted(event);
        break;

      case 'file_change':
        this.handleFileChange(event);
        break;

      case 'approval_requested':
        this.handleApprovalRequest(event);
        break;

      case 'turn_started':
        this.setState({ phase: 'running', isRunning: true, error: null });
        break;

      case 'turn_completed':
        this.handleTurnCompleted(event);
        break;

      case 'error':
        this.fail(new Error(event.message), event.sessionId ?? undefined);
        break;
    }
  }

  private handleAssistantCompleted(
    event: Extract<ExternalAgentRuntimeEvent, { type: 'assistant_completed' }>,
  ): void {
    const messageId = this.messageIdByExternalSessionId.get(event.sessionId);
    if (!messageId || !event.content || this.textDeltaMessages.has(messageId)) {
      return;
    }

    this.options.conversation.appendPart(messageId, createTextPart(event.content));
  }

  private handleToolStarted(
    event: Extract<ExternalAgentRuntimeEvent, { type: 'tool_started' }>,
  ): void {
    const messageId = this.messageIdByExternalSessionId.get(event.sessionId);
    if (!messageId) {
      return;
    }

    const partIndex = this.options.conversation.getMessageParts(messageId)?.length ?? 0;
    this.options.conversation.appendPart(messageId, {
      type: 'tool_call',
      stepId: event.itemId,
      tool: event.tool,
      args: event.args ?? {},
      description: event.description,
      riskLevel: inferRiskLevel(event.tool),
      status: 'running',
      startedAt: Date.now(),
    });
    this.itemPartIndex.set(this.itemKey(event.sessionId, event.itemId), partIndex);
    this.setState({
      startedTools: this.state.startedTools + 1,
      latestIteration: this.state.latestIteration + 1,
    });
  }

  private handleToolCompleted(
    event: Extract<ExternalAgentRuntimeEvent, { type: 'tool_completed' }>,
  ): void {
    const messageId = this.messageIdByExternalSessionId.get(event.sessionId);
    if (!messageId) {
      return;
    }

    this.updateIndexedPart(event.sessionId, event.itemId, {
      status: event.success ? 'completed' : 'failed',
    });
    this.options.conversation.appendPart(
      messageId,
      createToolResultPart(
        event.itemId,
        event.tool,
        event.success,
        event.durationMs ?? 0,
        event.result,
        event.error ?? undefined,
      ),
    );
    this.setState({ completedTools: this.state.completedTools + 1 });
  }

  private handleFileChange(
    event: Extract<ExternalAgentRuntimeEvent, { type: 'file_change' }>,
  ): void {
    const messageId = this.messageIdByExternalSessionId.get(event.sessionId);
    if (!messageId) {
      return;
    }

    const key = this.itemKey(event.sessionId, event.itemId);
    const existingIndex = this.itemPartIndex.get(key);
    const patch = {
      type: 'patch' as const,
      diff: event.diff,
      files: event.files,
    };

    if (existingIndex !== undefined) {
      this.options.conversation.updatePart(messageId, existingIndex, patch);
      return;
    }

    const partIndex = this.options.conversation.getMessageParts(messageId)?.length ?? 0;
    this.options.conversation.appendPart(messageId, patch);
    this.itemPartIndex.set(key, partIndex);
  }

  private handleApprovalRequest(
    event: Extract<ExternalAgentRuntimeEvent, { type: 'approval_requested' }>,
  ): void {
    const messageId = this.messageIdByExternalSessionId.get(event.sessionId);
    if (!messageId) {
      return;
    }

    const parts = this.options.conversation.getMessageParts(messageId) ?? [];
    const partIndex = parts.length;
    const approvalId = `codex:${event.requestId}`;
    const existingIndex = parts.findIndex(
      (part) => part.type === 'tool_approval' && part.stepId === approvalId,
    );
    if (existingIndex >= 0) {
      this.approvalPartIndex.set(approvalId, { messageId, partIndex: existingIndex });
      return;
    }

    this.options.conversation.appendPart(messageId, {
      type: 'tool_approval',
      stepId: approvalId,
      tool: event.tool ?? formatApprovalTool(event.approvalType),
      args: event.args ?? {},
      description: event.description ?? event.reason ?? 'Approve Codex request',
      riskLevel: inferApprovalRiskLevel(event.approvalType),
      status: 'pending',
    });
    this.approvalPartIndex.set(approvalId, { messageId, partIndex });
  }

  private handleTurnCompleted(
    event: Extract<ExternalAgentRuntimeEvent, { type: 'turn_completed' }>,
  ): void {
    if (event.status === 'failed') {
      const error = new Error(event.error ?? 'Codex turn failed');
      this.fail(error, event.sessionId);
      return;
    }

    const phase = event.status === 'interrupted' ? 'aborted' : 'completed';
    this.finishActiveMessage(phase, event.sessionId);
  }

  private updateTrailingPart(
    externalSessionId: string,
    type: 'text' | 'reasoning',
    appendContent: string,
  ): void {
    const messageId = this.messageIdByExternalSessionId.get(externalSessionId);
    if (!messageId) {
      return;
    }

    const parts = this.options.conversation.getMessageParts(messageId) ?? [];
    const lastIndex = parts.length - 1;
    const lastPart = lastIndex >= 0 ? parts[lastIndex] : null;

    if (!lastPart || lastPart.type !== type) {
      this.options.conversation.appendPart(
        messageId,
        type === 'text' ? createTextPart(appendContent) : createReasoningPart(appendContent),
      );
    } else {
      this.options.conversation.updatePart(messageId, lastIndex, {
        content: lastPart.content + appendContent,
      });
    }

    if (type === 'text') {
      this.textDeltaMessages.add(messageId);
    }
  }

  private updateIndexedPart(
    externalSessionId: string,
    itemId: string,
    update: Partial<MessagePart>,
  ): void {
    const messageId = this.messageIdByExternalSessionId.get(externalSessionId);
    const partIndex = this.itemPartIndex.get(this.itemKey(externalSessionId, itemId));
    if (!messageId || partIndex === undefined) {
      return;
    }

    this.options.conversation.updatePart(messageId, partIndex, update);
  }

  private fail(error: Error, externalSessionId?: string): void {
    const messageId = externalSessionId
      ? this.messageIdByExternalSessionId.get(externalSessionId)
      : this.getActiveMessageId();

    if (messageId) {
      this.options.conversation.appendPart(
        messageId,
        createErrorPart('EXTERNAL_AGENT_ERROR', error.message, 'external_agent', true),
      );
      this.options.conversation.finalizeMessage(messageId);
    }

    this.setState({ phase: 'failed', isRunning: false, error });
    this.callbacks.onError?.(error);
  }

  private finishActiveMessage(
    phase: 'completed' | 'aborted',
    externalSessionId?: string | null,
  ): void {
    const messageId = externalSessionId
      ? this.messageIdByExternalSessionId.get(externalSessionId)
      : this.getActiveMessageId();

    if (messageId) {
      this.options.conversation.finalizeMessage(messageId);
    }

    this.setState({ phase, isRunning: false, error: null });
    if (phase === 'aborted') {
      this.callbacks.onAbort?.();
    } else {
      this.callbacks.onComplete?.();
    }
  }

  private getActiveMessageId(): string | null {
    for (const session of this.sessionByConversationSessionId.values()) {
      const messageId = this.messageIdByExternalSessionId.get(session.sessionId);
      if (messageId) {
        return messageId;
      }
    }
    return null;
  }

  private setState(update: Partial<ExternalAgentChatRuntimeState>): void {
    this.state = {
      ...this.state,
      ...update,
    };
    this.callbacks.onStateChange?.(this.state);
  }

  private itemKey(sessionId: string, itemId: string): string {
    return `${sessionId}:${itemId}`;
  }

  private updateApprovalPartStatus(requestId: string, denied: boolean): void {
    const target = this.approvalPartIndex.get(requestId);
    if (target) {
      this.options.conversation.updatePart(target.messageId, target.partIndex, {
        status: denied ? 'denied' : 'approved',
      });
      this.approvalPartIndex.delete(requestId);
      return;
    }

    const activeMessageId = this.getActiveMessageId();
    const parts = activeMessageId
      ? this.options.conversation.getMessageParts(activeMessageId)
      : null;
    const fallbackIndex =
      parts?.findIndex((part) => part.type === 'tool_approval' && part.stepId === requestId) ?? -1;

    if (activeMessageId && fallbackIndex >= 0) {
      this.options.conversation.updatePart(activeMessageId, fallbackIndex, {
        status: denied ? 'denied' : 'approved',
      });
    }
  }

  private persistApprovalDecision(
    request: ExternalAgentApprovalRequest,
    decision: ExternalAgentApprovalDecision,
  ): void {
    const sessionId =
      this.activeConversationSessionId ?? this.options.conversation.getActiveSessionId();
    const action = mapApprovalDecisionToAuditAction(decision);
    persistPermissionAudit(
      sessionId,
      null,
      request.id,
      {
        subjectType: 'approval',
        subject: `external_agent.${request.runtimeId}.${request.approvalType}.${request.tool}`,
        matchedPattern: null,
        matchedScope: null,
        source: 'interactive_approval',
      },
      action,
      'interactive_approval',
    );
  }
}

export function createConversationStoreExternalAgentGateway(): ExternalAgentConversationGateway {
  return {
    getActiveSessionId: () => useConversationStore.getState().activeSessionId,
    ensureSession: (agent?: string) => useConversationStore.getState().ensureSession(agent),
    startAssistantMessage: (sessionId?: string) =>
      useConversationStore.getState().startAssistantMessage(sessionId),
    appendPart: (messageId: string, part: MessagePart) =>
      useConversationStore.getState().appendPart(messageId, part),
    updatePart: (messageId: string, partIndex: number, update: Partial<MessagePart>) =>
      useConversationStore.getState().updatePart(messageId, partIndex, update),
    finalizeMessage: (messageId: string) =>
      useConversationStore.getState().finalizeMessage(messageId),
    getMessageParts: (messageId: string) =>
      useConversationStore
        .getState()
        .activeConversation?.messages.find((message) => message.id === messageId)?.parts ?? null,
  };
}

function inferRiskLevel(tool: string): RiskLevel {
  if (tool === 'commandExecution' || tool.includes('write') || tool.includes('delete')) {
    return 'high';
  }

  return 'medium';
}

function inferApprovalRiskLevel(
  approvalType: Extract<ExternalAgentRuntimeEvent, { type: 'approval_requested' }>['approvalType'],
): RiskLevel {
  if (approvalType === 'command') {
    return 'critical';
  }
  if (approvalType === 'file_change') {
    return 'high';
  }
  return 'medium';
}

function formatApprovalTool(
  approvalType: Extract<ExternalAgentRuntimeEvent, { type: 'approval_requested' }>['approvalType'],
): string {
  if (approvalType === 'command') {
    return 'Codex command';
  }
  if (approvalType === 'file_change') {
    return 'Codex file change';
  }
  return 'Codex approval';
}

function mapApprovalRequestToPermissionRequest(request: ExternalAgentApprovalRequest): {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  description: string;
  riskLevel: RiskLevel;
} {
  return {
    id: request.id,
    tool: request.tool,
    args: request.args,
    description: request.description,
    riskLevel: inferApprovalRiskLevel(request.approvalType),
  };
}

function mapApprovalDecisionToAuditAction(
  decision: ExternalAgentApprovalDecision,
): 'allow' | 'allow_always' | 'deny' {
  if (decision === 'acceptForSession') {
    return 'allow_always';
  }
  if (decision === 'accept') {
    return 'allow';
  }
  return 'deny';
}
