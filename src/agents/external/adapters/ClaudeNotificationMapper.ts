import type { ExternalAgentRuntimeEvent, ExternalAgentRuntimeId } from '../types';
import { asArray, asObject, getBoolean, getString, type JsonObject } from './jsonNarrowing';

/**
 * Prefix Claude prepends to OpenReelio MCP tools. The agent sees
 * `mcp__openreelio__<name>`; OpenReelio events use the bare `<name>`.
 */
const OPENREELIO_MCP_TOOL_PREFIX = 'mcp__openreelio__';

/**
 * Mutable per-session mapping state. Claude's stream-json has no explicit turn
 * lifecycle, so the mapper synthesizes turns and tracks in-flight items here.
 */
export interface ClaudeMapperState {
  /** Claude's own session id captured from the `system/init` message. */
  claudeSessionId: string | null;
  /** Id of the synthesized turn currently in progress, if any. */
  activeTurnId: string | null;
  /** Monotonic counter used to synthesize turn ids when no message id exists. */
  turnCounter: number;
  /** Id of the most recent assistant text item, for `assistant_completed`. */
  textItemId: string | null;
  /** Whether the current turn produced any assistant text. */
  hadAssistantText: boolean;
  /** Maps a `tool_use` id to its bare tool name so results can be labelled. */
  toolNamesById: Map<string, string>;
}

/**
 * Create a fresh {@link ClaudeMapperState}. One instance is kept per OpenReelio
 * session for the lifetime of that session.
 */
export function createClaudeMapperState(): ClaudeMapperState {
  return {
    claudeSessionId: null,
    activeTurnId: null,
    turnCounter: 0,
    textItemId: null,
    hadAssistantText: false,
    toolNamesById: new Map<string, string>(),
  };
}

export interface MapClaudeStreamMessageInput {
  /** Raw Claude stream-json message (the payload of a `{type:"message"}` event). */
  message: unknown;
  /** OpenReelio runtime id emitting the events. */
  runtimeId: ExternalAgentRuntimeId | string;
  /** OpenReelio-internal session id; null when the session is not yet linked. */
  sessionId: string | null;
  /** Mutable mapping state for this session. */
  state: ClaudeMapperState;
}

/**
 * Translate a single Claude stream-json message into zero or more OpenReelio
 * external-agent runtime events.
 *
 * Claude has no explicit turn events, so a turn is synthesized on the first
 * assistant message and closed on the terminal `result` message.
 */
export function mapClaudeStreamMessageToExternalEvents(
  input: MapClaudeStreamMessageInput,
): ExternalAgentRuntimeEvent[] {
  const { message, runtimeId, sessionId, state } = input;
  const msg = asObject(message);
  if (!msg) {
    return [];
  }

  const type = getString(msg, 'type');
  switch (type) {
    case 'system':
      return mapSystemMessage(msg, runtimeId, sessionId, state);
    case 'assistant':
      return sessionId ? mapAssistantMessage(msg, runtimeId, sessionId, state) : [];
    case 'user':
      return sessionId ? mapUserMessage(msg, runtimeId, sessionId, state) : [];
    case 'result':
      return mapResultMessage(msg, runtimeId, sessionId, state);
    default:
      return [];
  }
}

function mapSystemMessage(
  msg: JsonObject,
  runtimeId: ExternalAgentRuntimeId | string,
  sessionId: string | null,
  state: ClaudeMapperState,
): ExternalAgentRuntimeEvent[] {
  const subtype = getString(msg, 'subtype');

  if (subtype === 'init') {
    const claudeSessionId = getString(msg, 'session_id');
    if (claudeSessionId) {
      state.claudeSessionId = claudeSessionId;
    }
    return [];
  }

  // `api_retry` is a transient, recoverable retry — it must NOT surface as a
  // runtime `error`, which terminates the session (chatRuntime.fail). Genuine
  // auth/fatal failures arrive on the terminal `result` (is_error) instead.
  if (subtype === 'api_retry') {
    return [];
  }

  // Fatal system-level errors surface as runtime errors.
  if (subtype === 'api_error' || subtype === 'error') {
    return [
      {
        type: 'error',
        runtimeId,
        sessionId,
        message: getErrorMessage(msg) ?? 'Claude reported a system error',
      },
    ];
  }

  // hook_started / hook_response and other informational system events.
  return [];
}

function mapAssistantMessage(
  msg: JsonObject,
  runtimeId: ExternalAgentRuntimeId | string,
  sessionId: string,
  state: ClaudeMapperState,
): ExternalAgentRuntimeEvent[] {
  const inner = asObject(msg.message);
  const content = asArray(inner?.content);
  const messageId = getString(inner, 'id');
  const events: ExternalAgentRuntimeEvent[] = [];

  // Synthesize a turn on the first assistant activity of the turn.
  if (!state.activeTurnId) {
    const turnId = messageId ?? `turn-${(state.turnCounter += 1)}`;
    state.activeTurnId = turnId;
    state.hadAssistantText = false;
    events.push({ type: 'turn_started', runtimeId, sessionId, turnId });
  }

  for (const block of content) {
    const entry = asObject(block);
    const blockType = getString(entry, 'type');

    if (blockType === 'text') {
      const text = getString(entry, 'text');
      if (!text) {
        continue;
      }
      state.textItemId = messageId ?? state.activeTurnId;
      state.hadAssistantText = true;
      events.push({
        type: 'assistant_delta',
        runtimeId,
        sessionId,
        itemId: state.textItemId,
        content: text,
      });
      continue;
    }

    if (blockType === 'thinking') {
      const thinking = getString(entry, 'thinking');
      if (!thinking) {
        continue;
      }
      events.push({
        type: 'reasoning_delta',
        runtimeId,
        sessionId,
        itemId: messageId,
        content: thinking,
      });
      continue;
    }

    if (blockType === 'tool_use') {
      const toolUseId = getString(entry, 'id');
      if (!toolUseId) {
        continue;
      }
      const tool = stripOpenReelioMcpPrefix(getString(entry, 'name') ?? 'tool');
      state.toolNamesById.set(toolUseId, tool);
      events.push({
        type: 'tool_started',
        runtimeId,
        sessionId,
        itemId: toolUseId,
        tool,
        description: `Run ${tool}`,
        args: asObject(entry?.input) ?? undefined,
      });
    }
  }

  return events;
}

function mapUserMessage(
  msg: JsonObject,
  runtimeId: ExternalAgentRuntimeId | string,
  sessionId: string,
  state: ClaudeMapperState,
): ExternalAgentRuntimeEvent[] {
  const inner = asObject(msg.message);
  const content = asArray(inner?.content);
  const events: ExternalAgentRuntimeEvent[] = [];

  for (const block of content) {
    const entry = asObject(block);
    if (getString(entry, 'type') !== 'tool_result') {
      continue;
    }
    const toolUseId = getString(entry, 'tool_use_id');
    if (!toolUseId) {
      continue;
    }
    const isError = getBoolean(entry, 'is_error') ?? false;
    const tool = state.toolNamesById.get(toolUseId) ?? 'tool';
    state.toolNamesById.delete(toolUseId);
    events.push({
      type: 'tool_completed',
      runtimeId,
      sessionId,
      itemId: toolUseId,
      tool,
      success: !isError,
      result: entry?.content,
      error: isError ? extractToolResultErrorText(entry?.content) : null,
    });
  }

  return events;
}

function mapResultMessage(
  msg: JsonObject,
  runtimeId: ExternalAgentRuntimeId | string,
  sessionId: string | null,
  state: ClaudeMapperState,
): ExternalAgentRuntimeEvent[] {
  const subtype = getString(msg, 'subtype');
  const isError = getBoolean(msg, 'is_error') ?? false;
  const resultText = getString(msg, 'result');
  const status = subtype === 'success' && !isError ? 'completed' : 'failed';
  const events: ExternalAgentRuntimeEvent[] = [];

  if (sessionId) {
    if (state.hadAssistantText) {
      events.push({
        type: 'assistant_completed',
        runtimeId,
        sessionId,
        itemId: state.textItemId,
        content: resultText ?? null,
      });
    }
    events.push({
      type: 'turn_completed',
      runtimeId,
      sessionId,
      turnId: state.activeTurnId,
      status,
      error: isError ? (resultText ?? null) : null,
    });
  }

  if (isError) {
    events.push({
      type: 'error',
      runtimeId,
      sessionId,
      message: resultText ?? 'Claude reported an error',
    });
  }

  // Reset per-turn state so the next assistant message starts a fresh turn.
  state.activeTurnId = null;
  state.hadAssistantText = false;
  state.textItemId = null;

  return events;
}

function stripOpenReelioMcpPrefix(name: string): string {
  return name.startsWith(OPENREELIO_MCP_TOOL_PREFIX)
    ? name.slice(OPENREELIO_MCP_TOOL_PREFIX.length)
    : name;
}

/**
 * Best-effort extraction of a human-readable error string from a tool_result
 * `content` payload, which may be a plain string or an array of content blocks.
 */
function extractToolResultErrorText(content: unknown): string | null {
  if (typeof content === 'string') {
    return content.trim() || null;
  }
  if (Array.isArray(content)) {
    for (const block of content) {
      const text = getString(asObject(block), 'text');
      if (text) {
        return text;
      }
    }
  }
  return null;
}

function getErrorMessage(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || null;
  }
  const object = asObject(value);
  if (!object) {
    return null;
  }
  const direct = getString(object, 'message') ?? getString(object, 'result');
  if (direct) {
    return direct;
  }
  const nested = asObject(object.error);
  return getString(nested, 'message');
}
