export type CodexJsonObject = Record<string, unknown>;

export interface CodexAppServerClientInfo {
  name: string;
  title?: string | null;
  version?: string;
}

export interface CodexInitializeCapabilities {
  experimentalApi: boolean;
  optOutNotificationMethods?: string[] | null;
}

export interface CodexAppServerClientOptions {
  clientInfo?: CodexAppServerClientInfo;
  capabilities?: CodexInitializeCapabilities;
}

export interface CodexStartThreadInput {
  model?: string;
  approvalPolicy?: string;
  approvalsReviewer?: string;
  sandbox?: string | CodexJsonObject;
  sandboxPolicy?: CodexJsonObject;
  permissions?: CodexJsonObject;
  config?: CodexJsonObject;
  baseInstructions?: string;
  developerInstructions?: string;
  personality?: string;
  serviceName?: string;
  dynamicTools?: CodexDynamicToolSpec[];
}

export interface CodexResumeThreadInput extends CodexStartThreadInput {
  threadId: string;
}

export interface CodexStartTurnInput {
  model?: string;
  effort?: string;
  approvalPolicy?: string;
  approvalsReviewer?: string;
  sandboxPolicy?: CodexJsonObject;
  permissions?: CodexJsonObject;
  personality?: string;
  summary?: string;
}

export interface CodexDynamicToolSpec {
  namespace?: string;
  name: string;
  description: string;
  inputSchema: CodexJsonObject;
  deferLoading?: boolean;
}

export type CodexDynamicToolCallOutputContentItem =
  | {
      type: 'inputText';
      text: string;
    }
  | {
      type: 'inputImage';
      imageUrl: string;
    };

export function isCodexDynamicToolCallOutputTextItem(
  item: CodexDynamicToolCallOutputContentItem | undefined,
): item is Extract<CodexDynamicToolCallOutputContentItem, { type: 'inputText' }> {
  return item?.type === 'inputText';
}

export interface CodexDynamicToolCallResponse {
  contentItems: CodexDynamicToolCallOutputContentItem[];
  success: boolean;
}

export interface CodexThread {
  id: string;
  preview?: string;
  ephemeral?: boolean;
  modelProvider?: string;
  createdAt?: number;
  name?: string | null;
}

export interface CodexTurn {
  id: string;
  status: string;
  items?: unknown[];
  error?: unknown;
}

export interface CodexThreadStartResult {
  thread: CodexThread;
}

export interface CodexTurnStartResult {
  turn: CodexTurn;
}

export interface CodexTurnSteerResult {
  turnId: string;
}

export interface CodexAppServerNotification {
  method: string;
  params?: CodexJsonObject;
}

export interface CodexAppServerRequest {
  id: number;
  method: string;
  params?: CodexJsonObject;
}

export type CodexAppServerNotificationHandler = (notification: CodexAppServerNotification) => void;
export type CodexAppServerRequestHandler = (
  request: CodexAppServerRequest,
) => unknown | Promise<unknown>;

export type CodexAppServerOutgoingMessage =
  | {
      method: string;
      id: number;
      params?: CodexJsonObject;
    }
  | {
      method: string;
      params?: CodexJsonObject;
    }
  | {
      id: number;
      result?: unknown;
      error?: {
        code: number;
        message: string;
        data?: unknown;
      };
    };

export type CodexAppServerIncomingMessage =
  | {
      id: number;
      result?: unknown;
      error?: {
        code?: number;
        message?: string;
        data?: unknown;
      };
    }
  | {
      id: number;
      method: string;
      params?: CodexJsonObject;
    }
  | {
      method: string;
      params?: CodexJsonObject;
    };

export interface CodexAppServerTransport {
  send(message: CodexAppServerOutgoingMessage): Promise<void> | void;
  onMessage(handler: (message: CodexAppServerIncomingMessage) => void): () => void;
  onError?(handler: (error: Error) => void): () => void;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

export class CodexAppServerClient {
  private nextRequestId = 1;
  private initialized = false;
  private initializePromise: Promise<void> | null = null;
  private readonly pendingRequests = new Map<number, PendingRequest>();
  private readonly notificationHandlers = new Set<CodexAppServerNotificationHandler>();
  private readonly requestHandlers = new Set<CodexAppServerRequestHandler>();
  private readonly unsubscribeTransport: () => void;
  private readonly unsubscribeTransportError: (() => void) | null;
  private readonly clientInfo: CodexAppServerClientInfo;
  private readonly capabilities: CodexInitializeCapabilities;
  private transportError: Error | null = null;

  constructor(
    private readonly transport: CodexAppServerTransport,
    options: CodexAppServerClientOptions = {},
  ) {
    this.clientInfo = options.clientInfo ?? {
      name: 'openreelio',
      title: 'OpenReelio',
      version: '0.1.0',
    };
    this.capabilities = options.capabilities ?? {
      experimentalApi: true,
    };
    this.unsubscribeTransport = this.transport.onMessage((message) => this.handleMessage(message));
    this.unsubscribeTransportError =
      this.transport.onError?.((error) => this.handleTransportError(error)) ?? null;
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    if (!this.initializePromise) {
      this.initializePromise = this.request('initialize', {
        clientInfo: this.clientInfo,
        capabilities: this.capabilities,
      }).then(async () => {
        await this.notify('initialized', {});
        this.initialized = true;
      });
    }

    await this.initializePromise;
  }

  async startThread(input: CodexStartThreadInput = {}): Promise<CodexThread> {
    await this.initialize();
    const result = await this.request<CodexThreadStartResult>(
      'thread/start',
      compactObject({
        model: input.model,
        approvalPolicy: input.approvalPolicy,
        approvalsReviewer: input.approvalsReviewer,
        sandbox: input.sandbox ?? input.sandboxPolicy,
        permissions: input.permissions,
        config: input.config,
        baseInstructions: input.baseInstructions,
        developerInstructions: input.developerInstructions,
        personality: input.personality,
        serviceName: input.serviceName ?? 'openreelio',
        dynamicTools: input.dynamicTools,
      }),
    );

    return result.thread;
  }

  async resumeThread(input: CodexResumeThreadInput): Promise<CodexThread> {
    await this.initialize();
    const result = await this.request<CodexThreadStartResult>(
      'thread/resume',
      compactObject({
        threadId: input.threadId,
        model: input.model,
        approvalPolicy: input.approvalPolicy,
        approvalsReviewer: input.approvalsReviewer,
        sandbox: input.sandbox ?? input.sandboxPolicy,
        permissions: input.permissions,
        config: input.config,
        baseInstructions: input.baseInstructions,
        developerInstructions: input.developerInstructions,
        personality: input.personality,
      }),
    );

    return result.thread;
  }

  async startTurn(
    threadId: string,
    text: string,
    input: CodexStartTurnInput = {},
  ): Promise<CodexTurn> {
    await this.initialize();
    const result = await this.request<CodexTurnStartResult>(
      'turn/start',
      compactObject({
        threadId,
        input: [{ type: 'text', text }],
        model: input.model,
        effort: input.effort,
        approvalPolicy: input.approvalPolicy,
        approvalsReviewer: input.approvalsReviewer,
        sandboxPolicy: input.sandboxPolicy,
        permissions: input.permissions,
        personality: input.personality,
        summary: input.summary,
      }),
    );

    return result.turn;
  }

  async steerTurn(
    threadId: string,
    expectedTurnId: string,
    text: string,
  ): Promise<CodexTurnSteerResult> {
    await this.initialize();
    return await this.request<CodexTurnSteerResult>('turn/steer', {
      threadId,
      expectedTurnId,
      input: [{ type: 'text', text }],
    });
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    await this.initialize();
    await this.request('turn/interrupt', { threadId, turnId });
  }

  async unsubscribeThread(threadId: string): Promise<void> {
    await this.initialize();
    await this.request('thread/unsubscribe', { threadId });
  }

  onNotification(handler: CodexAppServerNotificationHandler): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  onServerRequest(handler: CodexAppServerRequestHandler): () => void {
    this.requestHandlers.add(handler);
    return () => this.requestHandlers.delete(handler);
  }

  dispose(): void {
    this.unsubscribeTransport();
    this.unsubscribeTransportError?.();
    for (const [, pending] of this.pendingRequests) {
      pending.reject(new Error('Codex app-server client disposed'));
    }
    this.pendingRequests.clear();
    this.notificationHandlers.clear();
    this.requestHandlers.clear();
  }

  private async request<T = unknown>(method: string, params?: CodexJsonObject): Promise<T> {
    if (this.transportError) {
      throw this.transportError;
    }

    const id = this.nextRequestId++;
    const response = new Promise<T>((resolve, reject) => {
      this.pendingRequests.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
    });

    await this.transport.send(
      compactObject({ method, id, params }) as CodexAppServerOutgoingMessage,
    );
    return response;
  }

  private async notify(method: string, params?: CodexJsonObject): Promise<void> {
    await this.transport.send(compactObject({ method, params }) as CodexAppServerOutgoingMessage);
  }

  private handleMessage(message: CodexAppServerIncomingMessage): void {
    if ('id' in message && 'method' in message) {
      void this.handleServerRequest({
        id: message.id,
        method: message.method,
        params: message.params,
      });
      return;
    }

    if ('id' in message) {
      const pending = this.pendingRequests.get(message.id);
      if (!pending) {
        return;
      }
      this.pendingRequests.delete(message.id);

      if (message.error) {
        pending.reject(
          new Error(
            normalizeCodexAppServerErrorMessage(
              message.error.message ?? `Codex app-server error ${message.id}`,
            ),
          ),
        );
        return;
      }

      pending.resolve(message.result);
      return;
    }

    if ('method' in message) {
      const notification = {
        method: message.method,
        params: message.params,
      };
      for (const handler of this.notificationHandlers) {
        handler(notification);
      }
    }
  }

  private async handleServerRequest(request: CodexAppServerRequest): Promise<void> {
    const handler = this.requestHandlers.values().next().value as
      | CodexAppServerRequestHandler
      | undefined;

    if (!handler) {
      await this.transport.send({
        id: request.id,
        error: {
          code: -32601,
          message: `Unsupported Codex app-server request: ${request.method}`,
        },
      });
      return;
    }

    try {
      const result = await handler(request);
      await this.transport.send({ id: request.id, result });
    } catch (error) {
      await this.transport.send({
        id: request.id,
        error: {
          code: -32000,
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  private handleTransportError(error: Error): void {
    const normalizedError = new Error(normalizeCodexAppServerErrorMessage(error.message));
    this.transportError = normalizedError;
    for (const [, pending] of this.pendingRequests) {
      pending.reject(normalizedError);
    }
    this.pendingRequests.clear();
    this.initializePromise = Promise.reject(normalizedError);
    this.initializePromise.catch(() => undefined);
  }
}

function compactObject<T extends Record<string, unknown>>(input: T): CodexJsonObject {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  ) as CodexJsonObject;
}

function normalizeCodexAppServerErrorMessage(message: string): string {
  const trimmed = message.trim();
  const parsed = parseJsonObject(trimmed);
  const nestedMessage =
    getString(parsed, 'message') ?? getString(asObject(parsed?.error), 'message');
  if (nestedMessage && nestedMessage !== trimmed) {
    return normalizeCodexAppServerErrorMessage(nestedMessage);
  }

  if (trimmed.includes('requires a newer version of Codex') && trimmed.includes('gpt-5.5')) {
    return 'Codex model gpt-5.5 requires a newer Codex CLI. OpenReelio will use a compatible Codex model after reconnecting.';
  }

  return trimmed;
}

function parseJsonObject(value: string): CodexJsonObject | null {
  if (!value.startsWith('{')) {
    return null;
  }

  try {
    return asObject(JSON.parse(value));
  } catch {
    return null;
  }
}

function asObject(value: unknown): CodexJsonObject | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as CodexJsonObject;
}

function getString(input: CodexJsonObject | null | undefined, key: string): string | null {
  const value = input?.[key];
  return typeof value === 'string' ? value : null;
}
