import { listen, type Event, type UnlistenFn } from '@tauri-apps/api/event';

import { commands } from '@/bindings';

import {
  executeOpenReelioAgentToolCall,
  type OpenReelioAgentToolCallResult,
} from './adapters/openreelioCodexTools';
import type {
  ExternalAgentApprovalDecision,
  ExternalAgentApprovalDecisionProvider,
} from './types';

/**
 * Tauri event name carrying loopback MCP tool-call requests from the Claude
 * headless bridge. Must match the backend emitter.
 */
const OPENREELIO_MCP_CALL_EVENT = 'openreelio:mcp:call';

/**
 * Tauri event name signalling that a pending `tools/call` was cancelled by the
 * backend (its 300s timeout elapsed or its session was deregistered with calls
 * in flight). Rust has already answered Claude with a timeout error, so the
 * frontend must stop waiting on approval and skip its own late response.
 */
const OPENREELIO_MCP_CANCEL_EVENT = 'openreelio:mcp:cancel';

/**
 * Payload of an `openreelio:mcp:call` event: a single pending `tools/call`
 * dispatched by the loopback MCP server for a Claude headless session.
 */
export interface OpenReelioMcpCallEvent {
  callId: string;
  serverId: string;
  sessionId: string | null;
  /** Bare OpenReelio tool name (no `mcp__openreelio__` prefix). */
  tool: string;
  args: unknown;
}

/**
 * Payload of an `openreelio:mcp:cancel` event: a `tools/call` the backend has
 * given up on (timeout or session deregistration).
 */
export interface OpenReelioMcpCancelEvent {
  callId: string;
  serverId: string;
}

/**
 * Per-session context required to resolve a tool call to a project and session.
 */
export interface OpenReelioMcpSessionContext {
  projectId: string;
  sessionId: string;
  cwd: string | null;
  approvalDecisionProvider?: ExternalAgentApprovalDecisionProvider;
}

type TauriListen = <T>(event: string, handler: (event: Event<T>) => void) => Promise<UnlistenFn>;

type RespondMcpCall = (
  callId: string,
  response: OpenReelioAgentToolCallResult,
) => Promise<void>;

async function defaultRespond(
  callId: string,
  response: OpenReelioAgentToolCallResult,
): Promise<void> {
  const result = await commands.respondOpenreelioMcpCall(callId, {
    text: response.text,
    isError: response.isError,
  });
  if (result.status === 'error') {
    throw new Error(result.error);
  }
}

/**
 * Optional dependency injection surface for tests.
 */
export interface OpenReelioMcpBridgeDependencies {
  listen?: TauriListen;
  respond?: RespondMcpCall;
}

/**
 * Singleton bridge that routes loopback MCP tool calls from Claude headless
 * sessions to the OpenReelio dynamic-tool handler and returns their results.
 *
 * A single `openreelio:mcp:call` subscription is installed lazily and shared
 * across all sessions; sessions register/unregister their context by
 * `serverId`.
 */
export class OpenReelioMcpBridge {
  private readonly sessions = new Map<string, OpenReelioMcpSessionContext>();
  private readonly listenEvent: TauriListen;
  private readonly respond: RespondMcpCall;
  private callSubscription: Promise<UnlistenFn> | null = null;
  private cancelSubscription: Promise<UnlistenFn> | null = null;
  /** Cancellation hooks for tool calls currently awaiting execution/approval. */
  private readonly inflightCalls = new Map<string, { cancel: () => void }>();

  constructor(dependencies: OpenReelioMcpBridgeDependencies = {}) {
    this.listenEvent = dependencies.listen ?? listen;
    this.respond = dependencies.respond ?? defaultRespond;
  }

  /**
   * Register a session context and ensure the shared event subscriptions are
   * active. Awaits the `openreelio:mcp:call` subscription so callers can be sure
   * the bridge is receiving before Claude spawns and issues its first tool call.
   * Safe to call repeatedly for the same `serverId`.
   */
  async registerMcpSession(
    serverId: string,
    context: OpenReelioMcpSessionContext,
  ): Promise<void> {
    this.sessions.set(serverId, context);
    await this.ensureSubscribed();
  }

  /** Remove a session context. Tool calls for it will then be rejected. */
  unregisterMcpSession(serverId: string): void {
    this.sessions.delete(serverId);
  }

  private async ensureSubscribed(): Promise<void> {
    if (!this.callSubscription) {
      this.callSubscription = this.listenEvent<OpenReelioMcpCallEvent>(
        OPENREELIO_MCP_CALL_EVENT,
        (event) => {
          void this.handleCall(event.payload);
        },
      );
    }
    if (!this.cancelSubscription) {
      this.cancelSubscription = this.listenEvent<OpenReelioMcpCancelEvent>(
        OPENREELIO_MCP_CANCEL_EVENT,
        (event) => {
          this.handleCancel(event.payload);
        },
      );
    }
    // Await both listeners so registration only resolves once the bridge is
    // actually receiving events (the call subscription is the load-bearing one).
    await Promise.all([this.callSubscription, this.cancelSubscription]);
  }

  private handleCancel(payload: OpenReelioMcpCancelEvent): void {
    this.inflightCalls.get(payload.callId)?.cancel();
  }

  private async handleCall(payload: OpenReelioMcpCallEvent): Promise<void> {
    // A cancel event races the pending approval: when it wins, the wrapped
    // approval provider resolves `'cancel'` so the executor returns without
    // applying any mutation, and we skip our own response (Rust already answered
    // Claude with a timeout error).
    let cancelled = false;
    let markCancelled: (() => void) | null = null;
    const cancellation = new Promise<ExternalAgentApprovalDecision>((resolve) => {
      markCancelled = () => {
        cancelled = true;
        resolve('cancel');
      };
    });
    this.inflightCalls.set(payload.callId, { cancel: () => markCancelled?.() });

    // Respond only while the call is still live. If it was cancelled, a late
    // response would hit an 'Unknown call id' on the backend; skip it.
    const settle = async (response: OpenReelioAgentToolCallResult): Promise<void> => {
      if (cancelled) {
        return;
      }
      await this.respond(payload.callId, response);
    };

    try {
      const context = this.sessions.get(payload.serverId);
      if (!context) {
        await settle({
          text: JSON.stringify({
            status: 'error',
            message: `No active OpenReelio session for serverId '${payload.serverId}'.`,
          }),
          isError: true,
        });
        return;
      }

      const result = await executeOpenReelioAgentToolCall({
        toolName: payload.tool,
        args: payload.args,
        context: {
          projectId: context.projectId,
          cwd: context.cwd,
          runtimeId: 'claude_code',
          sessionId: context.sessionId,
          sessionKnown: true,
          approvalDecisionProvider: wrapApprovalProviderWithCancellation(
            context.approvalDecisionProvider,
            cancellation,
          ),
        },
      });

      await settle(result);
    } catch (error) {
      await settle({
        text: JSON.stringify({
          status: 'error',
          message: error instanceof Error ? error.message : String(error),
        }),
        isError: true,
      }).catch(() => undefined);
    } finally {
      this.inflightCalls.delete(payload.callId);
    }
  }
}

/**
 * Wrap an approval provider so a pending approval races against a per-call
 * cancellation. When the backend cancels the call, the wrapped provider resolves
 * `'cancel'` (a non-accept {@link ExternalAgentApprovalDecision}) and the tool
 * executor returns without applying its mutation.
 *
 * NOTE: cancellation only helps while the tool is still awaiting approval. If
 * the mutation is already executing (past the approval gate), it runs to
 * completion; only the outgoing response is suppressed.
 */
function wrapApprovalProviderWithCancellation(
  provider: ExternalAgentApprovalDecisionProvider | undefined,
  cancellation: Promise<ExternalAgentApprovalDecision>,
): ExternalAgentApprovalDecisionProvider | undefined {
  if (!provider) {
    return undefined;
  }
  return (request) => Promise.race([Promise.resolve(provider(request)), cancellation]);
}

let sharedBridge: OpenReelioMcpBridge | null = null;

/**
 * Return the process-wide {@link OpenReelioMcpBridge} singleton, creating it on
 * first use.
 */
export function getOpenReelioMcpBridge(): OpenReelioMcpBridge {
  if (!sharedBridge) {
    sharedBridge = new OpenReelioMcpBridge();
  }
  return sharedBridge;
}

/**
 * Register a Claude headless session with the shared MCP bridge. Resolves once
 * the shared `openreelio:mcp:call` subscription is active.
 */
export function registerMcpSession(
  serverId: string,
  context: OpenReelioMcpSessionContext,
): Promise<void> {
  return getOpenReelioMcpBridge().registerMcpSession(serverId, context);
}

/**
 * Unregister a Claude headless session from the shared MCP bridge.
 */
export function unregisterMcpSession(serverId: string): void {
  getOpenReelioMcpBridge().unregisterMcpSession(serverId);
}
