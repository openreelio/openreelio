import type { ExternalAgentRuntimeEvent, ExternalAgentRuntimeId } from '../types';
import type { CodexAppServerNotification, CodexJsonObject } from './CodexAppServerClient';

export interface MapCodexNotificationInput {
  notification: CodexAppServerNotification;
  runtimeId: ExternalAgentRuntimeId | string;
  sessionId: string | null;
}

export function mapCodexNotificationToExternalEvents(
  input: MapCodexNotificationInput,
): ExternalAgentRuntimeEvent[] {
  const { notification, runtimeId, sessionId } = input;
  const params = notification.params ?? {};

  if (notification.method === 'error') {
    return [
      {
        type: 'error',
        runtimeId,
        sessionId,
        message: getErrorMessage(params) ?? 'Codex app-server reported an error',
      },
    ];
  }

  if (!sessionId) {
    return [];
  }

  switch (notification.method) {
    case 'turn/started': {
      const turn = asObject(params.turn);
      const turnId = getString(turn, 'id') ?? getString(params, 'turnId');
      return turnId ? [{ type: 'turn_started', runtimeId, sessionId, turnId }] : [];
    }

    case 'turn/completed': {
      const turn = asObject(params.turn);
      const turnId = getString(turn, 'id') ?? getString(params, 'turnId');
      const status = getString(turn, 'status') ?? getString(params, 'status') ?? 'completed';
      const error = getErrorMessage(turn?.error ?? params.error);
      return [
        {
          type: 'turn_completed',
          runtimeId,
          sessionId,
          turnId,
          status,
          error,
        },
      ];
    }

    case 'item/agentMessage/delta': {
      const content = getFirstString(params, ['delta', 'text', 'content']);
      if (!content) {
        return [];
      }
      return [
        {
          type: 'assistant_delta',
          runtimeId,
          sessionId,
          itemId: getString(params, 'itemId'),
          content,
        },
      ];
    }

    case 'item/reasoning/summaryTextDelta':
    case 'item/reasoning/textDelta': {
      const content = getFirstString(params, ['delta', 'text', 'content']);
      if (!content) {
        return [];
      }
      return [
        {
          type: 'reasoning_delta',
          runtimeId,
          sessionId,
          itemId: getString(params, 'itemId'),
          content,
        },
      ];
    }

    case 'turn/diff/updated': {
      const diff = getString(params, 'diff');
      if (!diff) {
        return [];
      }
      return [
        {
          type: 'file_change',
          runtimeId,
          sessionId,
          itemId: getString(params, 'turnId') ?? 'turn-diff',
          diff,
          files: extractFilesFromDiff(diff),
          status: 'inProgress',
        },
      ];
    }

    case 'item/started':
      return mapStartedItem(params, runtimeId, sessionId);

    case 'item/completed':
      return mapCompletedItem(params, runtimeId, sessionId);

    default:
      return [];
  }
}

function mapStartedItem(
  params: CodexJsonObject,
  runtimeId: ExternalAgentRuntimeId | string,
  sessionId: string,
): ExternalAgentRuntimeEvent[] {
  const item = asObject(params.item);
  const itemType = getString(item, 'type');
  const itemId = getString(item, 'id') ?? getString(params, 'itemId');

  if (!item || !itemType || !itemId) {
    return [];
  }

  if (itemType === 'commandExecution') {
    const command = getString(item, 'command') ?? 'command';
    return [
      {
        type: 'tool_started',
        runtimeId,
        sessionId,
        itemId,
        tool: 'commandExecution',
        description: command,
        args: compactRecord({
          command,
          cwd: getString(item, 'cwd'),
        }),
      },
    ];
  }

  if (itemType === 'mcpToolCall' || itemType === 'dynamicToolCall') {
    const tool = formatToolName(item, itemType);
    return [
      {
        type: 'tool_started',
        runtimeId,
        sessionId,
        itemId,
        tool,
        description: `Run ${tool}`,
        args: asObject(item.arguments) ?? undefined,
      },
    ];
  }

  if (itemType === 'fileChange') {
    return mapFileChangeItem(item, runtimeId, sessionId, itemId);
  }

  return [];
}

function mapCompletedItem(
  params: CodexJsonObject,
  runtimeId: ExternalAgentRuntimeId | string,
  sessionId: string,
): ExternalAgentRuntimeEvent[] {
  const item = asObject(params.item);
  const itemType = getString(item, 'type');
  const itemId = getString(item, 'id') ?? getString(params, 'itemId');

  if (!item || !itemType || !itemId) {
    return [];
  }

  if (itemType === 'agentMessage') {
    return [
      {
        type: 'assistant_completed',
        runtimeId,
        sessionId,
        itemId,
        content: getString(item, 'text'),
      },
    ];
  }

  if (itemType === 'commandExecution') {
    return [
      {
        type: 'tool_completed',
        runtimeId,
        sessionId,
        itemId,
        tool: 'commandExecution',
        success: getString(item, 'status') !== 'failed',
        result: getFirstString(item, ['aggregatedOutput', 'output']),
        error: getString(item, 'error'),
        durationMs: getNumber(item, 'durationMs'),
      },
    ];
  }

  if (itemType === 'mcpToolCall' || itemType === 'dynamicToolCall') {
    const tool = formatToolName(item, itemType);
    return [
      {
        type: 'tool_completed',
        runtimeId,
        sessionId,
        itemId,
        tool,
        success: getBoolean(item, 'success') ?? getString(item, 'status') !== 'failed',
        result: item.result ?? item.contentItems,
        error: getString(item, 'error'),
        durationMs: getNumber(item, 'durationMs'),
      },
    ];
  }

  if (itemType === 'fileChange') {
    return mapFileChangeItem(item, runtimeId, sessionId, itemId);
  }

  return [];
}

function mapFileChangeItem(
  item: CodexJsonObject,
  runtimeId: ExternalAgentRuntimeId | string,
  sessionId: string,
  itemId: string,
): ExternalAgentRuntimeEvent[] {
  const changes = Array.isArray(item.changes) ? item.changes : [];
  const files: string[] = [];
  const diffs: string[] = [];

  for (const change of changes) {
    const entry = asObject(change);
    const path = getString(entry, 'path');
    const diff = getString(entry, 'diff');
    if (path) {
      files.push(path);
    }
    if (diff) {
      diffs.push(diff);
    }
  }

  if (files.length === 0 && diffs.length === 0) {
    return [];
  }

  return [
    {
      type: 'file_change',
      runtimeId,
      sessionId,
      itemId,
      diff: diffs.join('\n'),
      files,
      status: getString(item, 'status'),
    },
  ];
}

function formatToolName(item: CodexJsonObject, fallback: string): string {
  const server = getString(item, 'server');
  const tool = getString(item, 'tool');

  if (server && tool) {
    return `${server}/${tool}`;
  }

  return tool ?? fallback;
}

function extractFilesFromDiff(diff: string): string[] {
  const files = new Set<string>();
  for (const line of diff.split('\n')) {
    if (!line.startsWith('+++ b/')) {
      continue;
    }
    files.add(line.slice('+++ b/'.length));
  }
  return Array.from(files);
}

function getErrorMessage(value: unknown): string | null {
  if (!value) {
    return null;
  }

  if (typeof value === 'string') {
    return normalizeErrorMessage(value);
  }

  const object = asObject(value);
  if (!object) {
    return null;
  }

  const nested = asObject(object.error);
  return normalizeErrorMessage(getString(object, 'message') ?? getString(nested, 'message'));
}

function normalizeErrorMessage(message: string | null): string | null {
  if (!message) {
    return null;
  }

  const trimmed = message.trim();
  const parsed = parseJsonObject(trimmed);
  if (parsed) {
    const nestedMessage =
      getString(parsed, 'message') ?? getString(asObject(parsed.error), 'message');
    if (nestedMessage && nestedMessage !== trimmed) {
      return normalizeErrorMessage(nestedMessage);
    }
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

function compactRecord(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function getFirstString(input: CodexJsonObject | null | undefined, keys: string[]): string | null {
  for (const key of keys) {
    const value = getString(input, key);
    if (value) {
      return value;
    }
  }
  return null;
}

function getString(input: CodexJsonObject | null | undefined, key: string): string | null {
  const value = input?.[key];
  return typeof value === 'string' ? value : null;
}

function getNumber(input: CodexJsonObject | null | undefined, key: string): number | null {
  const value = input?.[key];
  return typeof value === 'number' ? value : null;
}

function getBoolean(input: CodexJsonObject | null | undefined, key: string): boolean | null {
  const value = input?.[key];
  return typeof value === 'boolean' ? value : null;
}

function asObject(value: unknown): CodexJsonObject | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as CodexJsonObject;
}
