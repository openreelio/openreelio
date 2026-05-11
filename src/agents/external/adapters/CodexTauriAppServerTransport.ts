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
  cwd?: string | null;
  model?: string | null;
  reasoningEffort?: string | null;
}

export interface CodexAppServerStartResult {
  serverId: string;
  eventName: string;
  command: string;
  args: string[];
  cwd: string;
}

export type CodexAppServerStreamEvent =
  | { type: 'message'; message: CodexAppServerIncomingMessage }
  | { type: 'stderr'; text: string }
  | { type: 'error'; message: string }
  | { type: 'exit'; exitCode: number | null };

type TauriInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;
type TauriListen = <T>(event: string, handler: (event: Event<T>) => void) => Promise<UnlistenFn>;

export interface CodexTauriAppServerTransportDependencies {
  invoke?: TauriInvoke;
  listen?: TauriListen;
}

export interface CodexTauriAppServerTransportOptions {
  autoStopOnDispose?: boolean;
}

export class CodexTauriAppServerTransport implements CodexAppServerTransport {
  private readonly invokeCommand: TauriInvoke;
  private readonly listenEvent: TauriListen;
  private readonly handlers = new Set<(message: CodexAppServerIncomingMessage) => void>();
  private readonly unlistenPromise: Promise<UnlistenFn>;
  private disposed = false;

  private constructor(
    readonly startResult: CodexAppServerStartResult,
    dependencies: CodexTauriAppServerTransportDependencies = {},
    private readonly options: CodexTauriAppServerTransportOptions = {},
  ) {
    this.invokeCommand = dependencies.invoke ?? invoke;
    this.listenEvent = dependencies.listen ?? listen;
    this.unlistenPromise = this.listenEvent<CodexAppServerStreamEvent>(
      startResult.eventName,
      (event) => this.handleStreamEvent(event.payload),
    );
  }

  static async start(
    input: StartCodexAppServerInput = {},
    dependencies: CodexTauriAppServerTransportDependencies = {},
    options: CodexTauriAppServerTransportOptions = {},
  ): Promise<CodexTauriAppServerTransport> {
    const invokeCommand = dependencies.invoke ?? invoke;
    const startResult = (await invokeCommand('start_codex_app_server', {
      input: {
        serverId: input.serverId ?? null,
        cwd: input.cwd ?? null,
        model: input.model ?? null,
        reasoningEffort: input.reasoningEffort ?? null,
      },
    })) as CodexAppServerStartResult;

    return new CodexTauriAppServerTransport(startResult, dependencies, options);
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
    return () => this.handlers.delete(handler);
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;

    const unlisten = await this.unlistenPromise;
    unlisten();
    this.handlers.clear();

    if (this.options.autoStopOnDispose ?? true) {
      await this.invokeCommand('stop_codex_app_server', {
        input: { serverId: this.startResult.serverId },
      });
    }
  }

  private handleStreamEvent(event: CodexAppServerStreamEvent): void {
    if (event.type !== 'message') {
      return;
    }

    for (const handler of this.handlers) {
      handler(event.message);
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
