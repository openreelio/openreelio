import { listen, type Event, type UnlistenFn } from '@tauri-apps/api/event';

import { commands } from '@/bindings';
import type { ClaudeMcpToolSpec, JsonValue, StartClaudeHeadlessInput } from '@/bindings';

/**
 * Auth mode forwarded to the Claude headless runtime. `subscription` relies on
 * the CLI's stored account; `api-key` injects `ANTHROPIC_API_KEY`.
 */
export type ClaudeAuthMode = 'subscription' | 'api-key';

/**
 * Result of starting a Claude headless session. Mirrors the backend
 * `ClaudeHeadlessStartResult` shape.
 */
export interface ClaudeHeadlessStartResult {
  serverId: string;
  eventName: string;
  command: string;
  args: string[];
  bridgeCwd: string;
  mcpUrl: string;
}

/**
 * Raw stream event emitted by the backend on `claude:headless:{serverId}`.
 * Discriminated by `type`.
 */
export type ClaudeHeadlessStreamEvent =
  | { type: 'message'; message: unknown }
  | { type: 'stderr'; text: string }
  | { type: 'error'; message: string }
  | { type: 'exit'; exitCode: number | null };

/**
 * Terminal notification delivered when the Claude headless process exits. This
 * is a distinct signal from {@link ClaudeHeadlessTransport.onError}: a process
 * ending (even cleanly, with `exitCode === null` on EOF) is not inherently a
 * failure, so consumers decide whether an exit warrants a user-facing error.
 */
export interface ClaudeHeadlessExitInfo {
  /** Process exit code, or null when the stream reached EOF without one. */
  exitCode: number | null;
  /** Most recent stderr line, retained to enrich a mid-turn exit message. */
  lastStderrLine: string | null;
}

type TauriListen = <T>(event: string, handler: (event: Event<T>) => void) => Promise<UnlistenFn>;

/**
 * Dependencies for the Claude headless transport. Injectable so tests can drive
 * the transport without a live Tauri backend.
 */
export interface ClaudeHeadlessTransportDependencies {
  start?: (input: StartClaudeHeadlessInput) => Promise<ClaudeHeadlessStartResult>;
  write?: (input: { serverId: string; message: JsonValue }) => Promise<void>;
  stop?: (input: { serverId: string }) => Promise<void>;
  listen?: TauriListen;
}

/**
 * Configuration for a Claude headless session. `serverId` is optional; the
 * transport generates one on the client so the stream event name is known
 * before the backend spawns the process.
 */
export interface CreateClaudeHeadlessTransportInput {
  serverId?: string | null;
  projectPath?: string | null;
  model?: string | null;
  effort?: string | null;
  authMode: ClaudeAuthMode;
  apiKey?: string | null;
  tools: ClaudeMcpToolSpec[];
  /**
   * Optional prior Claude session id to resume via `--resume <id>`. When set,
   * the backend resumes instead of starting a fresh session. The first user
   * turn is always written by the caller after the transport is wired.
   */
  resumeSessionId?: string | null;
  /**
   * OpenReelio developer instructions appended to the system prompt. Without
   * them Claude behaves like a generic coding agent instead of driving the
   * OpenReelio MCP tools.
   */
  developerInstructions?: string | null;
}

export interface ClaudeHeadlessTransportOptions {
  autoStopOnDispose?: boolean;
}

// Must match the backend stream event prefix. Used only to predict the event
// name so we can subscribe before the backend spawns the process; the
// backend-reported `eventName` remains authoritative if this ever drifts.
const CLAUDE_HEADLESS_EVENT_PREFIX = 'claude:headless';

function claudeHeadlessEventName(serverId: string): string {
  return `${CLAUDE_HEADLESS_EVENT_PREFIX}:${serverId}`;
}

/**
 * Generate a client-side server id so the stream event name is known before the
 * backend spawns the Claude process. The backend accepts any non-empty id and
 * reuses it verbatim.
 */
function generateClaudeServerId(): string {
  const cryptoObj = globalThis.crypto;
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
    return cryptoObj.randomUUID();
  }
  return `claude-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

function normalizeClaudeServerId(serverId?: string | null): string {
  const trimmed = serverId?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : generateClaudeServerId();
}

async function defaultStart(input: StartClaudeHeadlessInput): Promise<ClaudeHeadlessStartResult> {
  const result = await commands.startClaudeHeadless(input);
  if (result.status === 'error') {
    throw new Error(result.error);
  }
  return result.data;
}

async function defaultWrite(input: { serverId: string; message: JsonValue }): Promise<void> {
  const result = await commands.writeClaudeHeadlessMessage(input);
  if (result.status === 'error') {
    throw new Error(result.error);
  }
}

async function defaultStop(input: { serverId: string }): Promise<void> {
  const result = await commands.stopClaudeHeadless(input);
  if (result.status === 'error') {
    throw new Error(result.error);
  }
}

/**
 * Transport that manages a single Claude headless session over the Tauri
 * event bridge. It subscribes to the stream event BEFORE spawning the process
 * (early-event buffering) so an immediate crash is never lost, delivers raw
 * `message` payloads to consumers via {@link onMessage}, surfaces genuine
 * reader/transport failures via {@link onError}, and reports process
 * termination separately via {@link onExit} (an exit is not by itself an
 * error).
 */
export class ClaudeHeadlessTransport {
  private readonly writeMessage: (input: { serverId: string; message: JsonValue }) => Promise<void>;
  private readonly stopSession: (input: { serverId: string }) => Promise<void>;
  private readonly messageHandlers = new Set<(message: unknown) => void>();
  private readonly errorHandlers = new Set<(error: Error) => void>();
  private readonly exitHandlers = new Set<(info: ClaudeHeadlessExitInfo) => void>();
  private readonly unlistenPromise: Promise<UnlistenFn>;
  private disposed = false;
  /** Single-flight backend stop; reset on failure so a later dispose retries. */
  private stopPromise: Promise<void> | null = null;
  private lastStderrLine: string | null = null;
  // Events that arrive before a consumer registers are buffered and replayed on
  // registration so they are never silently dropped.
  private readonly bufferedMessages: unknown[] = [];
  private readonly bufferedErrors: Error[] = [];
  private readonly bufferedExits: ClaudeHeadlessExitInfo[] = [];

  private constructor(
    readonly startResult: ClaudeHeadlessStartResult,
    dependencies: ClaudeHeadlessTransportDependencies,
    private readonly options: ClaudeHeadlessTransportOptions,
    unlistenPromise: Promise<UnlistenFn>,
  ) {
    this.writeMessage = dependencies.write ?? defaultWrite;
    this.stopSession = dependencies.stop ?? defaultStop;
    this.unlistenPromise = unlistenPromise;
  }

  static async start(
    input: CreateClaudeHeadlessTransportInput,
    dependencies: ClaudeHeadlessTransportDependencies = {},
    options: ClaudeHeadlessTransportOptions = {},
  ): Promise<ClaudeHeadlessTransport> {
    const startCommand = dependencies.start ?? defaultStart;
    const listenEvent = dependencies.listen ?? listen;

    // Derive the server id (and therefore the stream event name) on the client
    // so we can subscribe BEFORE the backend spawns the Claude process. Tauri
    // does not buffer events for absent listeners, so a process that fails
    // immediately could emit its exit/error before a post-start listener
    // attached - leaving the caller waiting forever.
    const serverId = normalizeClaudeServerId(input.serverId);
    const predictedEventName = claudeHeadlessEventName(serverId);

    // Until the transport exists, route incoming events into a buffer.
    const earlyEvents: ClaudeHeadlessStreamEvent[] = [];
    let sink: (event: ClaudeHeadlessStreamEvent) => void = (event) => {
      earlyEvents.push(event);
    };

    let unlistenPromise = listenEvent<ClaudeHeadlessStreamEvent>(
      predictedEventName,
      (event) => sink(event.payload),
    );
    // Ensure the subscription is active before the backend can emit.
    await unlistenPromise;

    let startResult: ClaudeHeadlessStartResult;
    try {
      startResult = await startCommand({
        serverId,
        projectPath: input.projectPath ?? null,
        model: input.model ?? null,
        effort: input.effort ?? null,
        authMode: input.authMode,
        apiKey: input.apiKey ?? null,
        tools: input.tools,
        resumeSessionId: input.resumeSessionId ?? null,
        developerInstructions: input.developerInstructions ?? null,
      });
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
      unlistenPromise = listenEvent<ClaudeHeadlessStreamEvent>(
        startResult.eventName,
        (event) => sink(event.payload),
      );
      await unlistenPromise;
    }

    const transport = new ClaudeHeadlessTransport(
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

  /** Write a stream-json message to the Claude process stdin. */
  send(message: JsonValue): Promise<void> {
    return this.writeMessage({ serverId: this.startResult.serverId, message });
  }

  /** Register a consumer for raw Claude stream-json messages. */
  onMessage(handler: (message: unknown) => void): () => void {
    this.messageHandlers.add(handler);
    if (this.bufferedMessages.length > 0) {
      for (const message of this.bufferedMessages.splice(0)) {
        handler(message);
      }
    }
    return () => this.messageHandlers.delete(handler);
  }

  /** Register a consumer for genuine reader/transport errors. */
  onError(handler: (error: Error) => void): () => void {
    this.errorHandlers.add(handler);
    if (this.bufferedErrors.length > 0) {
      for (const error of this.bufferedErrors.splice(0)) {
        handler(error);
      }
    }
    return () => this.errorHandlers.delete(handler);
  }

  /**
   * Register a consumer for process termination. Fires once when the Claude
   * process exits; the consumer decides whether the exit is benign (idle
   * teardown) or should surface as a user-facing error (e.g. mid-turn death).
   */
  onExit(handler: (info: ClaudeHeadlessExitInfo) => void): () => void {
    this.exitHandlers.add(handler);
    if (this.bufferedExits.length > 0) {
      for (const info of this.bufferedExits.splice(0)) {
        handler(info);
      }
    }
    return () => this.exitHandlers.delete(handler);
  }

  async dispose(): Promise<void> {
    if (!this.disposed) {
      this.disposed = true;

      // Best-effort: a failed listener registration must not block the
      // process stop below.
      const unlisten = await this.unlistenPromise.catch(() => undefined);
      unlisten?.();
      this.messageHandlers.clear();
      this.errorHandlers.clear();
      this.exitHandlers.clear();
      this.bufferedMessages.length = 0;
      this.bufferedErrors.length = 0;
      this.bufferedExits.length = 0;
    }

    // Kept OUTSIDE the `disposed` guard: a failed backend stop resets the
    // single-flight promise so a later dispose() can retry instead of
    // silently leaving the process alive behind an already-true flag.
    if (this.options.autoStopOnDispose ?? true) {
      this.stopPromise ??= this.stopSession({ serverId: this.startResult.serverId }).catch(
        (stopError: unknown) => {
          this.stopPromise = null;
          throw stopError;
        },
      );
      await this.stopPromise;
    }
  }

  private handleStreamEvent(event: ClaudeHeadlessStreamEvent): void {
    if (this.disposed) {
      return;
    }

    if (event.type === 'message') {
      if (this.messageHandlers.size === 0) {
        this.bufferedMessages.push(event.message);
        return;
      }
      for (const handler of this.messageHandlers) {
        handler(event.message);
      }
      return;
    }

    if (event.type === 'stderr') {
      // Retained only to enrich a subsequent exit error; not surfaced directly.
      this.lastStderrLine = event.text;
      return;
    }

    if (event.type === 'error') {
      this.emitError(event.message);
      return;
    }

    if (event.type === 'exit') {
      // Process termination is a distinct terminal signal from a reader error:
      // a clean exit (or EOF with a null code) is not itself a failure. Deliver
      // the raw exit info and let the consumer decide whether to surface it.
      this.emitExit({ exitCode: event.exitCode, lastStderrLine: this.lastStderrLine });
    }
  }

  private emitError(message: string): void {
    const error = new Error(message);
    if (this.errorHandlers.size === 0) {
      this.bufferedErrors.push(error);
      return;
    }
    for (const handler of this.errorHandlers) {
      handler(error);
    }
  }

  private emitExit(info: ClaudeHeadlessExitInfo): void {
    if (this.exitHandlers.size === 0) {
      this.bufferedExits.push(info);
      return;
    }
    for (const handler of this.exitHandlers) {
      handler(info);
    }
  }
}

/**
 * Start a Claude headless transport backed by the Tauri command bridge.
 */
export async function createClaudeTauriHeadlessTransport(
  input: CreateClaudeHeadlessTransportInput,
  dependencies: ClaudeHeadlessTransportDependencies = {},
  options: ClaudeHeadlessTransportOptions = {},
): Promise<ClaudeHeadlessTransport> {
  return ClaudeHeadlessTransport.start(input, dependencies, options);
}
