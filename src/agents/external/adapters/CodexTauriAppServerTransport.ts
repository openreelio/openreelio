import { invoke } from '@tauri-apps/api/core';
import { listen, type Event, type UnlistenFn } from '@tauri-apps/api/event';

import {
  CodexAppServerClient,
  type CodexAppServerIncomingMessage,
  type CodexAppServerOutgoingMessage,
  type CodexAppServerTransport,
} from './CodexAppServerClient';

export interface StartCodexAppServerInput {
  serverId?: string | null;
  projectPath?: string | null;
  model?: string | null;
  reasoningEffort?: string | null;
}

export interface CodexAppServerStartResult {
  serverId: string;
  eventName: string;
  command: string;
  args: string[];
  bridgeCwd: string;
}

export type CodexAppServerStreamEvent =
  | { type: 'message'; message: CodexAppServerIncomingMessage }
  | { type: 'stderr'; text: string }
  | { type: 'error'; message: string }
  | { type: 'exit'; exitCode: number | null };

type TauriInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;
type TauriListen = <T>(event: string, handler: (event: Event<T>) => void) => Promise<UnlistenFn>;

// Must match the backend constant `CODEX_APP_SERVER_EVENT_PREFIX`
// (src-tauri/src/core/codex_app_server.rs). Used only to predict the stream
// event name so we can subscribe before the backend spawns the process; the
// backend-reported `eventName` remains authoritative if this ever drifts.
const CODEX_APP_SERVER_EVENT_PREFIX = 'codex:app-server';

function codexAppServerEventName(serverId: string): string {
  return `${CODEX_APP_SERVER_EVENT_PREFIX}:${serverId}`;
}

/**
 * Generate a client-side server id so the stream event name is known before the
 * backend spawns the codex process. The backend accepts any non-empty id
 * (<= 128 chars) and reuses it verbatim.
 */
function generateCodexServerId(): string {
  const cryptoObj = globalThis.crypto;
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
    return cryptoObj.randomUUID();
  }
  return `codex-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

function normalizeCodexServerId(serverId?: string | null): string {
  const trimmed = serverId?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : generateCodexServerId();
}

export interface CodexTauriAppServerTransportDependencies {
  invoke?: TauriInvoke;
  listen?: TauriListen;
}

export interface CodexTauriAppServerTransportOptions {
  autoStopOnDispose?: boolean;
}

export class CodexTauriAppServerTransport implements CodexAppServerTransport {
  private readonly invokeCommand: TauriInvoke;
  private readonly handlers = new Set<(message: CodexAppServerIncomingMessage) => void>();
  private readonly errorHandlers = new Set<(error: Error) => void>();
  private readonly unlistenPromise: Promise<UnlistenFn>;
  private disposed = false;
  private lastStderrLine: string | null = null;
  // Events that arrive before a consumer registers (e.g. an immediate process
  // crash emitted right after spawn) are buffered and replayed on registration
  // so they are never silently dropped.
  private readonly bufferedMessages: CodexAppServerIncomingMessage[] = [];
  private pendingError: Error | null = null;

  private constructor(
    readonly startResult: CodexAppServerStartResult,
    dependencies: CodexTauriAppServerTransportDependencies = {},
    private readonly options: CodexTauriAppServerTransportOptions = {},
    unlistenPromise: Promise<UnlistenFn> = Promise.resolve(() => undefined),
  ) {
    this.invokeCommand = dependencies.invoke ?? invoke;
    this.unlistenPromise = unlistenPromise;
  }

  static async start(
    input: StartCodexAppServerInput = {},
    dependencies: CodexTauriAppServerTransportDependencies = {},
    options: CodexTauriAppServerTransportOptions = {},
  ): Promise<CodexTauriAppServerTransport> {
    const invokeCommand = dependencies.invoke ?? invoke;
    const listenEvent = dependencies.listen ?? listen;

    // Derive the server id (and therefore the stream event name) on the client so
    // we can subscribe BEFORE the backend spawns the codex process. The backend
    // spawns its stdout/stderr readers before start_codex_app_server returns and
    // Tauri does not buffer events for absent listeners, so a process that fails
    // immediately could emit its exit/error before a post-start listener attached
    // - leaving the caller waiting forever.
    const serverId = normalizeCodexServerId(input.serverId);
    const predictedEventName = codexAppServerEventName(serverId);

    // Until the transport exists, route incoming events into a buffer.
    const earlyEvents: CodexAppServerStreamEvent[] = [];
    let sink: (event: CodexAppServerStreamEvent) => void = (event) => {
      earlyEvents.push(event);
    };

    let unlistenPromise = listenEvent<CodexAppServerStreamEvent>(
      predictedEventName,
      (event) => sink(event.payload),
    );
    // Ensure the subscription is active before the backend can emit.
    await unlistenPromise;

    let startResult: CodexAppServerStartResult;
    try {
      startResult = (await invokeCommand('start_codex_app_server', {
        input: {
          serverId,
          projectPath: input.projectPath ?? null,
          model: input.model ?? null,
          reasoningEffort: input.reasoningEffort ?? null,
        },
      })) as CodexAppServerStartResult;
    } catch (error) {
      sink = () => undefined;
      (await unlistenPromise)();
      throw error;
    }

    // The backend-reported event name is authoritative. If it differs from our
    // prediction (e.g. the naming scheme changed), drop the optimistic listener
    // and subscribe to the real channel so correctness never depends on the
    // predicted name matching.
    if (startResult.eventName !== predictedEventName) {
      (await unlistenPromise)();
      unlistenPromise = listenEvent<CodexAppServerStreamEvent>(
        startResult.eventName,
        (event) => sink(event.payload),
      );
      await unlistenPromise;
    }

    const transport = new CodexTauriAppServerTransport(
      startResult,
      dependencies,
      options,
      unlistenPromise,
    );

    // Route future events into the transport and replay any that arrived before
    // it was constructed.
    sink = (event) => transport.handleStreamEvent(event);
    for (const event of earlyEvents.splice(0)) {
      transport.handleStreamEvent(event);
    }

    return transport;
  }

  send(message: CodexAppServerOutgoingMessage): Promise<void> {
    return this.invokeCommand('write_codex_app_server_message', {
      input: {
        serverId: this.startResult.serverId,
        message,
      },
    }).then(() => undefined);
  }

  onMessage(handler: (message: CodexAppServerIncomingMessage) => void): () => void {
    this.handlers.add(handler);
    // Replay any messages buffered before a consumer was registered.
    if (this.bufferedMessages.length > 0) {
      for (const message of this.bufferedMessages.splice(0)) {
        handler(message);
      }
    }
    return () => this.handlers.delete(handler);
  }

  onError(handler: (error: Error) => void): () => void {
    this.errorHandlers.add(handler);
    // Replay an error buffered before an error consumer was registered.
    if (this.pendingError) {
      const error = this.pendingError;
      this.pendingError = null;
      handler(error);
    }
    return () => this.errorHandlers.delete(handler);
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;

    const unlisten = await this.unlistenPromise;
    unlisten();
    this.handlers.clear();
    this.errorHandlers.clear();
    this.bufferedMessages.length = 0;
    this.pendingError = null;

    if (this.options.autoStopOnDispose ?? true) {
      await this.invokeCommand('stop_codex_app_server', {
        input: { serverId: this.startResult.serverId },
      });
    }
  }

  private handleStreamEvent(event: CodexAppServerStreamEvent): void {
    if (this.disposed) {
      return;
    }

    if (event.type === 'message') {
      if (this.handlers.size === 0) {
        // Buffer until a consumer registers (see onMessage).
        this.bufferedMessages.push(event.message);
        return;
      }
      for (const handler of this.handlers) {
        handler(event.message);
      }
      return;
    }

    if (event.type === 'stderr') {
      this.lastStderrLine = event.text;
      return;
    }

    if (event.type === 'error') {
      this.emitError(event.message);
      return;
    }

    if (event.type === 'exit') {
      const suffix = this.lastStderrLine ? ` Last stderr: ${this.lastStderrLine}` : '';
      const exitCode =
        event.exitCode === null ? 'without an exit code' : `with exit code ${event.exitCode}`;
      this.emitError(`Codex app-server exited ${exitCode}.${suffix}`);
    }
  }

  private emitError(message: string): void {
    const error = new Error(message);
    if (this.errorHandlers.size === 0) {
      // Retain the first error until an error consumer registers (see onError).
      if (!this.pendingError) {
        this.pendingError = error;
      }
      return;
    }
    for (const handler of this.errorHandlers) {
      handler(error);
    }
  }
}

export async function createCodexTauriAppServerClient(
  input: StartCodexAppServerInput = {},
  dependencies: CodexTauriAppServerTransportDependencies = {},
): Promise<CodexAppServerClient> {
  const transport = await CodexTauriAppServerTransport.start(input, dependencies);
  return new CodexAppServerClient(transport);
}
