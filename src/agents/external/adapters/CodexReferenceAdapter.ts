import { invoke } from '@tauri-apps/api/core';

import type {
  AgentUserMessage,
  ExternalAgentApprovalDecisionProvider,
  ExternalAgentApprovalRequest,
  ExternalAgentAuthStatus,
  ExternalAgentRuntimeAdapter,
  ExternalAgentRuntimeCapabilities,
  ExternalAgentRuntimeEventHandler,
  ExternalAgentRuntimeStatus,
  ExternalAgentSessionHandle,
  ResumeAgentSessionInput,
  StartAgentSessionInput,
} from '../types';
import type {
  CodexAppServerClient,
  CodexDynamicToolCallResponse,
  CodexAppServerNotification,
  CodexAppServerRequest,
  CodexJsonObject,
  CodexTurn,
} from './CodexAppServerClient';
import { mapCodexNotificationToExternalEvents } from './CodexNotificationMapper';
import { createCodexTauriAppServerClient } from './CodexTauriAppServerTransport';
import {
  OPENREELIO_CODEX_DYNAMIC_TOOLS,
  buildOpenReelioCodexDeveloperInstructions,
  handleOpenReelioCodexDynamicToolCall,
  type OpenReelioCodexSessionContext,
} from './openreelioCodexTools';

export interface CodexStatusProbeResult {
  installed: boolean;
  version?: string | null;
  authStatus: ExternalAgentAuthStatus;
  reason?: string | null;
}

export type CodexStatusProbe = () => Promise<CodexStatusProbeResult>;

type CodexAppServerClientPort = Pick<
  CodexAppServerClient,
  'startThread' | 'startTurn' | 'interruptTurn' | 'unsubscribeThread'
> &
  Partial<Pick<CodexAppServerClient, 'resumeThread' | 'onNotification' | 'onServerRequest'>>;

interface CodexSessionState {
  threadId: string;
  lastTurnId: string | null;
  projectId: string;
  cwd: string | null;
}

export interface CodexReferenceAdapterOptions {
  appServerClient?: CodexAppServerClientPort;
  appServerClientFactory?: (input?: StartAgentSessionInput) => Promise<CodexAppServerClientPort>;
  approvalDecisionProvider?: ExternalAgentApprovalDecisionProvider;
  model?: string;
  reasoningEffort?: string;
}

const DEFAULT_CODEX_APP_SERVER_MODEL = 'gpt-5.4';
const DEFAULT_CODEX_REASONING_EFFORT = 'medium';

const CODEX_CAPABILITIES: ExternalAgentRuntimeCapabilities = {
  streamingEvents: true,
  interrupt: true,
  mcpClient: true,
  approvalAware: true,
  localAccountAuth: true,
  sessionResume: true,
  structuredToolCalls: true,
};

export class CodexReferenceAdapter implements ExternalAgentRuntimeAdapter {
  readonly id = 'codex' as const;
  readonly displayName = 'Codex';
  private readonly sessions = new Map<string, CodexSessionState>();
  private readonly turnSessionIds = new Map<string, string>();
  private readonly runtimeEventHandlers = new Set<ExternalAgentRuntimeEventHandler>();
  private readonly attachedClients = new Set<CodexAppServerClientPort>();
  private appServerClientPromise: Promise<CodexAppServerClientPort> | null = null;

  constructor(
    private readonly probeStatus: CodexStatusProbe = defaultCodexStatusProbe,
    private readonly options: CodexReferenceAdapterOptions = {},
  ) {}

  async detect(): Promise<ExternalAgentRuntimeStatus> {
    const probe = await this.probeStatus();
    const installStatus = probe.installed ? 'installed' : 'missing';
    const authenticated = probe.authStatus === 'signed-in' || probe.authStatus === 'api-key';
    const available = probe.installed && authenticated;

    return {
      runtimeId: this.id,
      displayName: this.displayName,
      installStatus,
      authStatus: probe.authStatus,
      available,
      version: probe.version ?? null,
      reason: available ? null : (probe.reason ?? this.defaultUnavailableReason(probe)),
    };
  }

  async authStatus(): Promise<ExternalAgentAuthStatus> {
    return (await this.detect()).authStatus;
  }

  async capabilities(): Promise<ExternalAgentRuntimeCapabilities> {
    return CODEX_CAPABILITIES;
  }

  subscribe(handler: ExternalAgentRuntimeEventHandler): () => void {
    this.runtimeEventHandlers.add(handler);
    return () => this.runtimeEventHandlers.delete(handler);
  }

  async startSession(input: StartAgentSessionInput): Promise<ExternalAgentSessionHandle> {
    const client = await this.getAppServerClient(input);
    const thread = await client.startThread({
      serviceName: 'openreelio',
      cwd: input.cwd ?? undefined,
      model: this.resolveModel(),
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      sandbox: 'workspace-write',
      developerInstructions: this.buildDeveloperInstructions(input),
      dynamicTools: OPENREELIO_CODEX_DYNAMIC_TOOLS,
    });
    const sessionId = thread.id;
    this.sessions.set(sessionId, {
      threadId: thread.id,
      lastTurnId: null,
      projectId: input.projectId,
      cwd: input.cwd ?? null,
    });

    if (input.prompt?.trim()) {
      const turn = await client.startTurn(thread.id, input.prompt, {
        cwd: input.cwd ?? undefined,
        model: this.resolveModel(),
        effort: this.resolveReasoningEffort(),
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user',
      });
      this.rememberTurn(sessionId, turn);
    }

    return { sessionId, runtimeId: this.id };
  }

  async resumeSession(input: ResumeAgentSessionInput): Promise<ExternalAgentSessionHandle> {
    const client = await this.getAppServerClient({
      projectId: input.projectId,
      cwd: input.cwd,
    });
    if (!client.resumeThread) {
      throw new Error('Codex app-server client does not support thread resume');
    }

    const thread = await client.resumeThread({
      threadId: input.externalSessionId,
      cwd: input.cwd ?? undefined,
      model: this.resolveModel(),
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      sandbox: 'workspace-write',
      developerInstructions: this.buildDeveloperInstructions(input),
    });
    this.sessions.set(thread.id, {
      threadId: thread.id,
      lastTurnId: null,
      projectId: input.projectId,
      cwd: input.cwd ?? null,
    });

    return { sessionId: thread.id, runtimeId: this.id };
  }

  async sendMessage(sessionId: string, message: AgentUserMessage): Promise<void> {
    const client = await this.getAppServerClient();
    const session = this.requireSession(sessionId);
    session.cwd = message.cwd ?? session.cwd;
    const turn = await client.startTurn(session.threadId, message.content, {
      cwd: message.cwd ?? undefined,
      model: this.resolveModel(),
      effort: this.resolveReasoningEffort(),
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
    });
    this.rememberTurn(sessionId, turn);
  }

  async interrupt(sessionId: string): Promise<void> {
    const client = await this.getAppServerClient();
    const session = this.requireSession(sessionId);
    if (!session.lastTurnId) {
      throw new Error(`Codex session ${sessionId} has no active turn to interrupt`);
    }

    await client.interruptTurn(session.threadId, session.lastTurnId);
  }

  async shutdown(sessionId: string): Promise<void> {
    const client = await this.getAppServerClient();
    const session = this.requireSession(sessionId);
    await client.unsubscribeThread(session.threadId);
    this.sessions.delete(sessionId);
    if (session.lastTurnId) {
      this.turnSessionIds.delete(session.lastTurnId);
    }
  }

  private defaultUnavailableReason(probe: CodexStatusProbeResult): string {
    if (!probe.installed) {
      return 'codex executable not found';
    }

    if (probe.authStatus === 'signed-out' || probe.authStatus === 'unknown') {
      return 'Codex is not authenticated';
    }

    if (probe.authStatus === 'error') {
      return 'Codex authentication status could not be read';
    }

    return 'Codex is unavailable';
  }

  private async getAppServerClient(
    input?: StartAgentSessionInput,
  ): Promise<CodexAppServerClientPort> {
    if (this.options.appServerClient) {
      this.attachClientHandlers(this.options.appServerClient);
      return this.options.appServerClient;
    }

    if (!this.appServerClientPromise) {
      const factory =
        this.options.appServerClientFactory ??
        ((factoryInput?: StartAgentSessionInput) =>
          createCodexTauriAppServerClient({
            cwd: factoryInput?.cwd ?? null,
            model: this.resolveModel(),
            reasoningEffort: this.resolveReasoningEffort(),
          }));
      this.appServerClientPromise = factory(input);
    }

    const client = await this.appServerClientPromise;
    this.attachClientHandlers(client);
    return client;
  }

  private requireSession(sessionId: string): CodexSessionState {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Codex session ${sessionId} is not active`);
    }

    return session;
  }

  private resolveModel(): string {
    return this.options.model?.trim() || DEFAULT_CODEX_APP_SERVER_MODEL;
  }

  private resolveReasoningEffort(): string {
    return this.options.reasoningEffort?.trim() || DEFAULT_CODEX_REASONING_EFFORT;
  }

  private buildDeveloperInstructions(context: OpenReelioCodexSessionContext): string {
    return buildOpenReelioCodexDeveloperInstructions({
      projectId: context.projectId,
      cwd: context.cwd ?? null,
    });
  }

  private rememberTurn(sessionId: string, turn: CodexTurn): void {
    const session = this.requireSession(sessionId);
    session.lastTurnId = turn.id;
    this.turnSessionIds.set(turn.id, sessionId);
  }

  private attachClientHandlers(client: CodexAppServerClientPort): void {
    if (this.attachedClients.has(client)) {
      return;
    }

    client.onNotification?.((notification) => this.handleNotification(notification));
    client.onServerRequest?.((request) => this.handleServerRequest(request));
    this.attachedClients.add(client);
  }

  private handleNotification(notification: CodexAppServerNotification): void {
    this.rememberTurnFromNotification(notification);
    const sessionId = this.resolveSessionIdFromParams(notification.params);
    const events = mapCodexNotificationToExternalEvents({
      notification,
      runtimeId: this.id,
      sessionId,
    });

    for (const event of events) {
      for (const handler of this.runtimeEventHandlers) {
        handler(event);
      }
    }
  }

  private async handleServerRequest(request: CodexAppServerRequest): Promise<unknown> {
    const sessionId = this.resolveSessionIdFromParams(request.params);
    const dynamicToolResponse = await this.handleDynamicToolRequest(request, sessionId);
    if (dynamicToolResponse) {
      return dynamicToolResponse;
    }

    if (request.method.endsWith('/requestApproval')) {
      const approvalRequest = this.toApprovalRequest(request, sessionId);
      for (const handler of this.runtimeEventHandlers) {
        handler({
          type: 'approval_requested',
          runtimeId: this.id,
          sessionId: approvalRequest.sessionId,
          itemId: approvalRequest.itemId,
          requestId: approvalRequest.requestId,
          approvalType: approvalRequest.approvalType,
          reason: approvalRequest.reason,
          tool: approvalRequest.tool,
          description: approvalRequest.description,
          args: approvalRequest.args,
        });
      }

      return this.options.approvalDecisionProvider
        ? await this.options.approvalDecisionProvider(approvalRequest)
        : 'decline';
    }

    throw new Error(`Unsupported Codex app-server request: ${request.method}`);
  }

  private async handleDynamicToolRequest(
    request: CodexAppServerRequest,
    sessionId: string | null,
  ): Promise<CodexDynamicToolCallResponse | null> {
    const params = request.params ?? {};
    const resolvedSessionId = sessionId ?? getString(params, 'threadId') ?? 'unknown';
    const session = this.sessions.get(resolvedSessionId);
    return await handleOpenReelioCodexDynamicToolCall(request, {
      runtimeId: this.id,
      sessionId: resolvedSessionId,
      projectId: session?.projectId ?? 'unknown',
      cwd: session?.cwd ?? getString(params, 'cwd'),
      approvalDecisionProvider: this.options.approvalDecisionProvider,
    });
  }

  private toApprovalRequest(
    request: CodexAppServerRequest,
    sessionId: string | null,
  ): ExternalAgentApprovalRequest {
    const params = request.params ?? {};
    const approvalType = request.method.includes('fileChange')
      ? 'file_change'
      : request.method.includes('commandExecution')
        ? 'command'
        : 'unknown';
    const itemId = getString(params, 'itemId');
    const turnId = getString(params, 'turnId');
    const command = getString(params, 'command');
    const cwd = getString(params, 'cwd');
    const reason = getString(params, 'reason');
    const grantRoot = getString(params, 'grantRoot');
    const tool =
      approvalType === 'file_change'
        ? 'Codex file change'
        : approvalType === 'command'
          ? 'Codex command'
          : 'Codex approval';
    const description =
      reason ??
      (approvalType === 'file_change'
        ? 'Approve Codex file changes'
        : command
          ? `Run ${command}`
          : 'Approve Codex request');

    return {
      id: `codex:${request.id}`,
      runtimeId: this.id,
      sessionId: sessionId ?? getString(params, 'threadId') ?? 'unknown',
      turnId,
      itemId,
      requestId: request.id,
      approvalType,
      tool,
      description,
      args: compactRecord({
        command,
        cwd,
        grantRoot,
        availableDecisions: params.availableDecisions,
        commandActions: params.commandActions,
        proposedExecpolicyAmendment: params.proposedExecpolicyAmendment,
      }),
      reason,
      requestedAt: Date.now(),
    };
  }

  private rememberTurnFromNotification(notification: CodexAppServerNotification): void {
    const params = notification.params;
    const turn = asObject(params?.turn);
    const turnId = getString(turn, 'id') ?? getString(params, 'turnId');
    const threadId = getString(turn, 'threadId') ?? getString(params, 'threadId');
    if (!turnId || !threadId || !this.sessions.has(threadId)) {
      return;
    }

    this.turnSessionIds.set(turnId, threadId);
    const session = this.sessions.get(threadId);
    if (session) {
      session.lastTurnId = turnId;
    }
  }

  private resolveSessionIdFromParams(params?: CodexJsonObject): string | null {
    const item = asObject(params?.item);
    const turn = asObject(params?.turn);
    const threadId =
      getString(params, 'threadId') ?? getString(item, 'threadId') ?? getString(turn, 'threadId');

    if (threadId && this.sessions.has(threadId)) {
      return threadId;
    }

    const turnId =
      getString(params, 'turnId') ?? getString(item, 'turnId') ?? getString(turn, 'id');

    return turnId ? (this.turnSessionIds.get(turnId) ?? null) : null;
  }
}

function getString(input: CodexJsonObject | null | undefined, key: string): string | null {
  const value = input?.[key];
  return typeof value === 'string' ? value : null;
}

function asObject(value: unknown): CodexJsonObject | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as CodexJsonObject;
}

function compactRecord(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined && value !== null),
  );
}

async function defaultCodexStatusProbe(): Promise<CodexStatusProbeResult> {
  try {
    return await invoke<CodexStatusProbeResult>('get_codex_status');
  } catch (error) {
    return {
      installed: false,
      authStatus: 'unknown',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
