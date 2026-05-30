import { describe, expect, it } from 'vitest';

import { mapCodexNotificationToExternalEvents } from './CodexNotificationMapper';

describe('mapCodexNotificationToExternalEvents', () => {
  it('should map streamed assistant deltas into external runtime events', () => {
    const events = mapCodexNotificationToExternalEvents({
      runtimeId: 'codex',
      sessionId: 'thr_123',
      notification: {
        method: 'item/agentMessage/delta',
        params: { itemId: 'item_1', delta: 'Done' },
      },
    });

    expect(events).toEqual([
      {
        type: 'assistant_delta',
        runtimeId: 'codex',
        sessionId: 'thr_123',
        itemId: 'item_1',
        content: 'Done',
      },
    ]);
  });

  it('should map completed file changes into patch events', () => {
    const events = mapCodexNotificationToExternalEvents({
      runtimeId: 'codex',
      sessionId: 'thr_123',
      notification: {
        method: 'item/completed',
        params: {
          item: {
            id: 'item_patch',
            type: 'fileChange',
            status: 'completed',
            changes: [
              { path: '/project/src/app.ts', kind: 'update', diff: '--- a\n+++ b\n@@\n+edit' },
            ],
          },
        },
      },
    });

    expect(events).toEqual([
      {
        type: 'file_change',
        runtimeId: 'codex',
        sessionId: 'thr_123',
        itemId: 'item_patch',
        diff: '--- a\n+++ b\n@@\n+edit',
        files: ['/project/src/app.ts'],
        status: 'completed',
      },
    ]);
  });

  it('should map turn completion status and error messages', () => {
    const events = mapCodexNotificationToExternalEvents({
      runtimeId: 'codex',
      sessionId: 'thr_123',
      notification: {
        method: 'turn/completed',
        params: {
          turn: {
            id: 'turn_1',
            status: 'failed',
            error: { message: 'Usage limit exceeded' },
          },
        },
      },
    });

    expect(events).toEqual([
      {
        type: 'turn_completed',
        runtimeId: 'codex',
        sessionId: 'thr_123',
        turnId: 'turn_1',
        status: 'failed',
        error: 'Usage limit exceeded',
      },
    ]);
  });

  it('should map direct failed and interrupted turn notifications as terminal events', () => {
    const failedEvents = mapCodexNotificationToExternalEvents({
      runtimeId: 'codex',
      sessionId: 'thr_123',
      notification: {
        method: 'turn/failed',
        params: {
          turnId: 'turn_failed',
          error: { message: 'Network disconnected' },
        },
      },
    });
    const interruptedEvents = mapCodexNotificationToExternalEvents({
      runtimeId: 'codex',
      sessionId: 'thr_123',
      notification: {
        method: 'turn/interrupted',
        params: { turn: { id: 'turn_interrupted' } },
      },
    });

    expect(failedEvents).toEqual([
      {
        type: 'turn_completed',
        runtimeId: 'codex',
        sessionId: 'thr_123',
        turnId: 'turn_failed',
        status: 'failed',
        error: 'Network disconnected',
      },
    ]);
    expect(interruptedEvents).toEqual([
      {
        type: 'turn_completed',
        runtimeId: 'codex',
        sessionId: 'thr_123',
        turnId: 'turn_interrupted',
        status: 'interrupted',
        error: null,
      },
    ]);
  });

  it('should format dynamic OpenReelio tool calls with their namespace', () => {
    const events = mapCodexNotificationToExternalEvents({
      runtimeId: 'codex',
      sessionId: 'thr_123',
      notification: {
        method: 'item/started',
        params: {
          item: {
            id: 'tool_1',
            type: 'dynamicToolCall',
            namespace: 'openreelio',
            tool: 'host_context',
            arguments: {},
          },
        },
      },
    });

    expect(events).toEqual([
      {
        type: 'tool_started',
        runtimeId: 'codex',
        sessionId: 'thr_123',
        itemId: 'tool_1',
        tool: 'openreelio.host_context',
        description: 'Run openreelio.host_context',
        args: {},
      },
    ]);
  });

  it('should normalize Codex JSON error payload strings into readable messages', () => {
    const events = mapCodexNotificationToExternalEvents({
      runtimeId: 'codex',
      sessionId: 'thr_123',
      notification: {
        method: 'turn/completed',
        params: {
          turn: {
            id: 'turn_1',
            status: 'failed',
            error: JSON.stringify({
              type: 'error',
              status: 400,
              error: {
                type: 'invalid_request_error',
                message:
                  "The 'gpt-5.5' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again.",
              },
            }),
          },
        },
      },
    });

    expect(events).toEqual([
      {
        type: 'turn_completed',
        runtimeId: 'codex',
        sessionId: 'thr_123',
        turnId: 'turn_1',
        status: 'failed',
        error:
          'Codex model gpt-5.5 requires a newer Codex CLI. OpenReelio will use a compatible Codex model after reconnecting.',
      },
    ]);
  });

  it('should ignore session-scoped notifications when no session can be resolved', () => {
    const events = mapCodexNotificationToExternalEvents({
      runtimeId: 'codex',
      sessionId: null,
      notification: {
        method: 'item/agentMessage/delta',
        params: { itemId: 'item_1', delta: 'Done' },
      },
    });

    expect(events).toEqual([]);
  });
});
