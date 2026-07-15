import { commands } from '@/bindings';
import type { ClaudeMcpToolSpec, JsonValue } from '@/bindings';

import {
  registerMcpSession,
  unregisterMcpSession,
} from '../openreelioMcpBridge';
import type {
  AgentUserMessage,
  ExternalAgentApprovalDecisionProvider,
  ExternalAgentAuthStatus,
  ExternalAgentRuntimeAdapter,
  ExternalAgentRuntimeCapabilities,
  ExternalAgentRuntimeEventHandler,
  ExternalAgentRuntimeStatus,
  ExternalAgentSessionHandle,
  StartAgentSessionInput,
} from '../types';
import {
  createClaudeMapperState,
  mapClaudeStreamMessageToExternalEvents,
  type ClaudeMapperState,
} from './ClaudeNotificationMapper';
import {
  ClaudeHeadlessTransport,
  createClaudeTauriHeadlessTransport,
  type ClaudeAuthMode,
  type ClaudeHeadlessExitInfo,
  type CreateClaudeHeadlessTransportInput,
} from './ClaudeHeadlessTransport';
import {
  buildOpenReelioCodexDeveloperInstructions,
  OPENREELIO_CODEX_DYNAMIC_TOOLS,
} from './openreelioCodexTools';

/**
 * Probe result describing the local Claude CLI install and auth state.
 */
export interface ClaudeStatusProbeResult {
  installed: boolean;
  version?: string | null;
  authStatus: ExternalAgentAuthStatus;
  reason?: string | null;
  runtimeSource?: string | null;
  configHome?: string | null;
}

export type ClaudeStatusProbe = () => Promise<ClaudeStatusProbeResult>;

/**
 * Optional dependency used to start a headless transport; injectable for tests.
 */
export type ClaudeHeadlessTransportFactory = (
  input: CreateClaudeHeadlessTransportInput,
) => Promise<ClaudeHeadlessTransport>;

export interface ClaudeCodeAdapterOptions {
  approvalDecisionProvider?: ExternalAgentApprovalDecisionProvider;
  model?: string;
  effort?: string;
  authMode?: ClaudeAuthMode;
  /** Optional inline API key for one-off api-key runs (falls back to stored key). */
  apiKey?: string;
  /** Overridable transport factory for tests. */
  transportFactory?: ClaudeHeadlessTransportFactory;
  /** Overridable MCP session registration for tests. */
  registerMcpSession?: typeof registerMcpSession;
  unregisterMcpSession?: typeof unregisterMcpSession;
}

const NOOP = (): void => undefined;

/**
 * Per-OpenReelio-session runtime state.
 *
 * The OpenReelio-facing `sessionId` (the map key) stays stable for the whole
 * conversation. `serverId` tracks the CURRENT Claude headless process/MCP
 * registration and diverges from `sessionId` once the session is resumed after
 * an interrupt. `processAlive` is `false` between an interrupt (or an
 * unexpected process death) and the next lazy respawn on `sendMessage`.
 */
interface ClaudeSessionState {
  /** Current MCP serverId of the live (or most recent) transport. Mutable. */
  serverId: string;
  projectId: string;
  cwd: string | null;
  /** Live transport, or `null` while the process is torn down between turns. */
  transport: ClaudeHeadlessTransport | null;
  mapperState: ClaudeMapperState;
  unsubscribeMessage: () => void;
  unsubscribeError: () => void;
  unsubscribeExit: () => void;
  /** Whether a Claude process is currently running for this session. */
  processAlive: boolean;
  /**
   * The Claude session id passed to `--resume` for the CURRENT transport, or
   * `null` when it was spawned fresh. Used to detect a resume that fails before
   * producing any output (a stale `--resume` id).
   */
  resumeInFlightId: string | null;
  /** Whether the current transport has produced any stream message yet. */
  sawTransportMessage: boolean;
  /** Whether the one-time "starting fresh" resume-failure notice was emitted. */
  resumeFailureNotified: boolean;
}

const DEFAULT_CLAUDE_AUTH_MODE: ClaudeAuthMode = 'subscription';

const CLAUDE_CAPABILITIES: ExternalAgentRuntimeCapabilities = {
  streamingEvents: true,
  interrupt: true,
  mcpClient: true,
  approvalAware: true,
  localAccountAuth: true,
  // Interrupt keeps the session record and lazily resumes via `--resume` on the
  // next message, so the conversation survives an interrupt.
  sessionResume: true,
  structuredToolCalls: true,
};

/**
 * External-agent runtime adapter for the Claude Code CLI headless backend.
 *
 * Each OpenReelio session owns one Claude headless process (a
 * {@link ClaudeHeadlessTransport}). Stream-json messages are translated into
 * OpenReelio runtime events, and OpenReelio tool calls are served over the
 * loopback MCP bridge.
 */
export class ClaudeCodeAdapter implements ExternalAgentRuntimeAdapter {
  readonly id = 'claude_code' as const;
  readonly displayName = 'Claude Code';
  private readonly sessions = new Map<string, ClaudeSessionState>();
  private readonly runtimeEventHandlers = new Set<ExternalAgentRuntimeEventHandler>();
  private readonly registerSession: typeof registerMcpSession;
  private readonly unregisterSession: typeof unregisterMcpSession;
  private readonly transportFactory: ClaudeHeadlessTransportFactory;

  constructor(
    private readonly probeStatus: ClaudeStatusProbe = defaultClaudeStatusProbe,
    private readonly options: ClaudeCodeAdapterOptions = {},
  ) {
    this.registerSession = options.registerMcpSession ?? registerMcpSession;
    this.unregisterSession = options.unregisterMcpSession ?? unregisterMcpSession;
    this.transportFactory = options.transportFactory ?? createClaudeTauriHeadlessTransport;
  }

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
      runtimeSource: probe.runtimeSource ?? null,
    };
  }

  async authStatus(): Promise<ExternalAgentAuthStatus> {
    return (await this.detect()).authStatus;
  }

  async capabilities(): Promise<ExternalAgentRuntimeCapabilities> {
    return CLAUDE_CAPABILITIES;
  }

  subscribe(handler: ExternalAgentRuntimeEventHandler): () => void {
    this.runtimeEventHandlers.add(handler);
    return () => this.runtimeEventHandlers.delete(handler);
  }

  async startSession(input: StartAgentSessionInput): Promise<ExternalAgentSessionHandle> {
    const cwd = input.cwd ?? null;
    // Spawn the process first; the backend no longer sends the first turn.
    const transport = await this.spawnTransport(input.projectId, cwd, null);

    // The OpenReelio-facing session id is the first transport's server id. It
    // stays stable for the whole conversation even after a resume swaps the
    // underlying server id, so writes/stops and chatRuntime's handle stay valid.
    const sessionId = transport.startResult.serverId;
    const session: ClaudeSessionState = {
      serverId: transport.startResult.serverId,
      projectId: input.projectId,
      cwd,
      transport: null,
      mapperState: createClaudeMapperState(),
      unsubscribeMessage: NOOP,
      unsubscribeError: NOOP,
      unsubscribeExit: NOOP,
      processAlive: false,
      resumeInFlightId: null,
      sawTransportMessage: false,
      resumeFailureNotified: false,
    };
    this.sessions.set(sessionId, session);

    // Order matters: register the MCP session (awaiting the subscription) BEFORE
    // wiring the message stream, then send the first prompt so tool calls can
    // never race an inactive bridge subscription.
    await this.attachTransport(sessionId, session, transport, null);

    const initialPrompt = input.prompt?.trim() ? input.prompt : null;
    if (initialPrompt) {
      await this.writeUserMessage(session, initialPrompt);
    }

    return { sessionId, runtimeId: this.id };
  }

  async sendMessage(sessionId: string, message: AgentUserMessage): Promise<void> {
    const session = this.requireSession(sessionId);
    session.cwd = message.cwd ?? session.cwd;
    // The process may have been torn down by a previous interrupt (or died on
    // its own). Transparently resume before writing so the conversation
    // continues from where it left off.
    if (!session.processAlive || !session.transport) {
      await this.resumeTransport(sessionId, session);
    }
    await this.writeUserMessage(session, message.content);
  }

  async interrupt(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    // Kill the process and unregister its MCP server, but KEEP the session
    // record (with its captured Claude session id) so the next message resumes.
    await this.deactivateSession(session);
  }

  async shutdown(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    this.sessions.delete(sessionId);
    await this.deactivateSession(session);
    session.mapperState.toolNamesById.clear();
  }

  /** Spawn a fresh headless transport for this session (optionally resuming). */
  private async spawnTransport(
    projectId: string,
    cwd: string | null,
    resumeSessionId: string | null,
  ): Promise<ClaudeHeadlessTransport> {
    return this.transportFactory({
      projectPath: cwd,
      model: this.resolveModel(),
      effort: this.resolveEffort(),
      authMode: this.resolveAuthMode(),
      apiKey: this.options.apiKey ?? null,
      tools: buildClaudeToolCatalog(),
      resumeSessionId,
      developerInstructions: buildClaudeDeveloperInstructions(projectId, cwd),
    });
  }

  /**
   * Wire a freshly spawned transport into a session: register the MCP bridge
   * under the transport's server id, then subscribe to its stream. The
   * OpenReelio-facing `sessionId` is passed to the bridge so tool calls resolve
   * to the stable session regardless of the underlying server id.
   */
  private async attachTransport(
    sessionId: string,
    session: ClaudeSessionState,
    transport: ClaudeHeadlessTransport,
    resumeSessionId: string | null,
  ): Promise<void> {
    const serverId = transport.startResult.serverId;
    session.transport = transport;
    session.serverId = serverId;
    session.resumeInFlightId = resumeSessionId;
    session.sawTransportMessage = false;
    // A fresh spawn means we are past any prior resume wedge; allow the next
    // resume failure (if one ever happens) to surface its notice again.
    if (resumeSessionId === null) {
      session.resumeFailureNotified = false;
    }

    await this.registerSession(serverId, {
      projectId: session.projectId,
      sessionId,
      cwd: session.cwd,
      approvalDecisionProvider: this.options.approvalDecisionProvider,
    });

    session.unsubscribeMessage = transport.onMessage((message) => {
      session.sawTransportMessage = true;
      const events = mapClaudeStreamMessageToExternalEvents({
        message,
        runtimeId: this.id,
        sessionId,
        state: session.mapperState,
      });
      for (const event of events) {
        this.emit(event);
      }
    });

    // Genuine reader/transport failures always warrant a user-facing error.
    session.unsubscribeError = transport.onError((error) => {
      this.handleTransportTermination(sessionId, session, {
        message: error.message,
        surfaceWhenIdle: true,
      });
    });

    // A plain process exit is NOT inherently a failure: a benign idle teardown
    // stays silent, and only a death mid-turn surfaces an error banner.
    session.unsubscribeExit = transport.onExit((info) => {
      this.handleTransportTermination(sessionId, session, {
        message: formatClaudeExitMessage(info),
        surfaceWhenIdle: false,
      });
    });

    session.processAlive = true;

    // Hold the first message until Claude has actually fetched the MCP tool
    // list. The CLI connects to MCP servers asynchronously and starts the
    // model turn without waiting, so a message sent immediately runs with NO
    // tools — the model then role-plays the OpenReelio tool calls as plain
    // text, fabricating results (observed live). Best-effort: on timeout or
    // command failure the message proceeds degraded rather than blocking.
    try {
      await commands.waitOpenreelioMcpReady(serverId, null);
    } catch {
      // Older backend without the command, or a transient IPC failure: the
      // session still works, just with the original race window.
    }
  }

  /**
   * Handle a terminal transport signal (a genuine {@link onError} failure or a
   * process {@link onExit}). Both tear the live process down while KEEPING the
   * session record so the next message lazily resumes, mirroring the
   * interrupt-then-continue flow. They differ only in when a user-facing error
   * is warranted:
   * - a stale `--resume` that terminates before any message surfaces a one-time
   *   "starting fresh" notice (and clears the captured id);
   * - a genuine error always surfaces (`surfaceWhenIdle`);
   * - a plain exit surfaces only when a turn was in flight (`activeTurnId`), so
   *   an idle-session exit produces no error banner.
   */
  private handleTransportTermination(
    sessionId: string,
    session: ClaudeSessionState,
    options: { message: string; surfaceWhenIdle: boolean },
  ): void {
    const isResumeFailure =
      session.resumeInFlightId !== null && !session.sawTransportMessage;
    if (isResumeFailure) {
      // Drop the stale id so the next lazy respawn starts a FRESH session
      // instead of looping the same failing `--resume` forever.
      session.mapperState.claudeSessionId = null;
      if (!session.resumeFailureNotified) {
        session.resumeFailureNotified = true;
        this.emit({
          type: 'error',
          runtimeId: this.id,
          sessionId,
          message:
            'Could not resume the previous Claude conversation; starting a fresh session on the next message.',
        });
      }
    } else if (options.surfaceWhenIdle || session.mapperState.activeTurnId !== null) {
      this.emit({ type: 'error', runtimeId: this.id, sessionId, message: options.message });
    }
    void this.deactivateSession(session).catch(() => undefined);
  }

  /** Lazily respawn a torn-down session, resuming Claude's own session id. */
  private async resumeTransport(
    sessionId: string,
    session: ClaudeSessionState,
  ): Promise<void> {
    const resumeSessionId = session.mapperState.claudeSessionId ?? null;
    const transport = await this.spawnTransport(session.projectId, session.cwd, resumeSessionId);
    await this.attachTransport(sessionId, session, transport, resumeSessionId);
  }

  /**
   * Tear down the live process for a session without removing its record:
   * unsubscribe handlers, unregister the MCP server, dispose the transport, and
   * mark the process dead. Safe to call when already deactivated.
   */
  private async deactivateSession(session: ClaudeSessionState): Promise<void> {
    session.processAlive = false;
    session.unsubscribeMessage();
    session.unsubscribeError();
    session.unsubscribeExit();
    session.unsubscribeMessage = NOOP;
    session.unsubscribeError = NOOP;
    session.unsubscribeExit = NOOP;
    this.unregisterSession(session.serverId);
    const transport = session.transport;
    session.transport = null;
    if (transport) {
      await transport.dispose();
    }
  }

  private async writeUserMessage(
    session: ClaudeSessionState,
    content: string,
  ): Promise<void> {
    if (!session.transport) {
      throw new Error('Claude Code session has no active transport');
    }
    const envelope: JsonValue = {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: content }],
      },
    };
    await session.transport.send(envelope);
  }

  private requireSession(sessionId: string): ClaudeSessionState {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Claude Code session ${sessionId} is not active`);
    }
    return session;
  }

  private emit(event: Parameters<ExternalAgentRuntimeEventHandler>[0]): void {
    for (const handler of this.runtimeEventHandlers) {
      handler(event);
    }
  }

  private resolveModel(): string | null {
    return this.options.model?.trim() || null;
  }

  private resolveEffort(): string | null {
    return this.options.effort?.trim() || null;
  }

  private resolveAuthMode(): ClaudeAuthMode {
    return this.options.authMode ?? DEFAULT_CLAUDE_AUTH_MODE;
  }

  private defaultUnavailableReason(probe: ClaudeStatusProbeResult): string {
    if (!probe.installed) {
      return 'claude executable not found';
    }
    if (probe.authStatus === 'signed-out' || probe.authStatus === 'unknown') {
      return 'Claude Code is not authenticated';
    }
    if (probe.authStatus === 'error') {
      return 'Claude Code authentication status could not be read';
    }
    return 'Claude Code is unavailable';
  }
}

/**
 * Build a user-facing message for a process that exited while a turn was still
 * in flight. The raw exit code is intentionally omitted; the last stderr line
 * is appended when present to aid diagnosis.
 */
function formatClaudeExitMessage(info: ClaudeHeadlessExitInfo): string {
  const base = 'Claude Code stopped unexpectedly before finishing the response.';
  return info.lastStderrLine ? `${base} Last output: ${info.lastStderrLine}` : base;
}

/**
 * Build the OpenReelio developer instructions for a Claude session.
 *
 * Reuses the shared instruction text but rewrites every tool reference from
 * Codex's `openreelio.<name>` form to the `mcp__openreelio__<name>` names
 * Claude actually sees, so the guidance points at callable tools. Without
 * these instructions Claude behaves like a generic coding agent in an empty
 * bridge directory (observed: it explored the cwd and attempted shell
 * commands instead of using the OpenReelio tools).
 */
function buildClaudeDeveloperInstructions(projectId: string, cwd: string | null): string {
  let instructions = buildOpenReelioCodexDeveloperInstructions({ projectId, cwd });
  for (const tool of OPENREELIO_CODEX_DYNAMIC_TOOLS) {
    instructions = instructions
      .split(`openreelio.${tool.name}`)
      .join(`mcp__openreelio__${tool.name}`);
  }
  return instructions;
}

/**
 * Map the OpenReelio dynamic-tool catalog to the MCP tool spec Claude expects.
 * Names are kept bare; Claude namespaces them as `mcp__openreelio__<name>`.
 */
function buildClaudeToolCatalog(): ClaudeMcpToolSpec[] {
  return OPENREELIO_CODEX_DYNAMIC_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema as unknown as JsonValue,
  }));
}

/**
 * Normalize the backend `authStatus` string into an {@link ExternalAgentAuthStatus}.
 */
function normalizeAuthStatus(value: string): ExternalAgentAuthStatus {
  switch (value) {
    case 'signed-in':
    case 'api-key':
    case 'signed-out':
    case 'error':
      return value;
    default:
      return 'unknown';
  }
}

async function defaultClaudeStatusProbe(): Promise<ClaudeStatusProbeResult> {
  try {
    const result = await commands.getClaudeStatus(null);
    if (result.status === 'error') {
      return { installed: false, authStatus: 'error', reason: result.error };
    }
    const data = result.data;
    return {
      installed: data.installed,
      version: data.version,
      authStatus: normalizeAuthStatus(data.authStatus),
      reason: data.reason,
      runtimeSource: data.runtimeSource,
      configHome: data.configHome,
    };
  } catch (error) {
    return {
      installed: false,
      authStatus: 'unknown',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
