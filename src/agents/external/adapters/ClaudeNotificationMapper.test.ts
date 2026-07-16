import { describe, expect, it } from 'vitest';

import type { ExternalAgentRuntimeEvent } from '../types';
import {
  createClaudeMapperState,
  mapClaudeStreamMessageToExternalEvents,
  type ClaudeMapperState,
} from './ClaudeNotificationMapper';

const RUNTIME_ID = 'claude_code';
const SESSION_ID = 'session-1';

function runSequence(
  messages: unknown[],
  sessionId: string | null = SESSION_ID,
  state: ClaudeMapperState = createClaudeMapperState(),
): ExternalAgentRuntimeEvent[] {
  return messages.flatMap((message) =>
    mapClaudeStreamMessageToExternalEvents({
      message,
      runtimeId: RUNTIME_ID,
      sessionId,
      state,
    }),
  );
}

describe('mapClaudeStreamMessageToExternalEvents', () => {
  it('should capture the claude session id and emit nothing when a system init arrives', () => {
    const state = createClaudeMapperState();
    const events = mapClaudeStreamMessageToExternalEvents({
      message: { type: 'system', subtype: 'init', session_id: 'claude-abc', model: 'sonnet' },
      runtimeId: RUNTIME_ID,
      sessionId: SESSION_ID,
      state,
    });

    expect(events).toEqual([]);
    expect(state.claudeSessionId).toBe('claude-abc');
  });

  it('should ignore hook system events', () => {
    expect(
      runSequence([
        { type: 'system', subtype: 'hook_started' },
        { type: 'system', subtype: 'hook_response' },
      ]),
    ).toEqual([]);
  });

  it('should synthesize a turn and stream assistant text through to completion', () => {
    const events = runSequence([
      { type: 'system', subtype: 'init', session_id: 'claude-abc' },
      {
        type: 'assistant',
        message: {
          id: 'msg_1',
          role: 'assistant',
          content: [{ type: 'text', text: 'Hello there' }],
        },
      },
      {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'Hello there',
        session_id: 'claude-abc',
      },
    ]);

    expect(events).toEqual([
      { type: 'turn_started', runtimeId: RUNTIME_ID, sessionId: SESSION_ID, turnId: 'msg_1' },
      {
        type: 'assistant_delta',
        runtimeId: RUNTIME_ID,
        sessionId: SESSION_ID,
        itemId: 'msg_1',
        content: 'Hello there',
      },
      {
        type: 'assistant_completed',
        runtimeId: RUNTIME_ID,
        sessionId: SESSION_ID,
        itemId: 'msg_1',
        content: 'Hello there',
      },
      {
        type: 'turn_completed',
        runtimeId: RUNTIME_ID,
        sessionId: SESSION_ID,
        turnId: 'msg_1',
        status: 'completed',
        error: null,
      },
    ]);
  });

  it('should emit a reasoning delta for thinking blocks', () => {
    const events = runSequence([
      {
        type: 'assistant',
        message: {
          id: 'msg_1',
          role: 'assistant',
          content: [{ type: 'thinking', thinking: 'Let me think' }],
        },
      },
    ]);

    expect(events).toContainEqual({
      type: 'reasoning_delta',
      runtimeId: RUNTIME_ID,
      sessionId: SESSION_ID,
      itemId: 'msg_1',
      content: 'Let me think',
    });
  });

  it('should map a tool_use block to tool_started with the bare tool name', () => {
    const events = runSequence([
      {
        type: 'assistant',
        message: {
          id: 'msg_1',
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_1',
              name: 'mcp__openreelio__project_state',
              input: { verbose: true },
            },
          ],
        },
      },
    ]);

    expect(events).toContainEqual({
      type: 'tool_started',
      runtimeId: RUNTIME_ID,
      sessionId: SESSION_ID,
      itemId: 'toolu_1',
      tool: 'project_state',
      description: 'Run project_state',
      args: { verbose: true },
    });
  });

  it('should pair a tool_result with the originating tool_use and report success', () => {
    const state = createClaudeMapperState();
    runSequence(
      [
        {
          type: 'assistant',
          message: {
            id: 'msg_1',
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'toolu_1',
                name: 'mcp__openreelio__timeline_snapshot',
                input: {},
              },
            ],
          },
        },
      ],
      SESSION_ID,
      state,
    );

    const completion = runSequence(
      [
        {
          type: 'user',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_1',
                content: '{"clips":[]}',
                is_error: false,
              },
            ],
          },
        },
      ],
      SESSION_ID,
      state,
    );

    expect(completion).toEqual([
      {
        type: 'tool_completed',
        runtimeId: RUNTIME_ID,
        sessionId: SESSION_ID,
        itemId: 'toolu_1',
        tool: 'timeline_snapshot',
        success: true,
        result: '{"clips":[]}',
        error: null,
      },
    ]);
  });

  it('should report a failed tool_result with its error text', () => {
    const state = createClaudeMapperState();
    runSequence(
      [
        {
          type: 'assistant',
          message: {
            id: 'msg_1',
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 'toolu_9', name: 'mcp__openreelio__plan_apply', input: {} },
            ],
          },
        },
      ],
      SESSION_ID,
      state,
    );

    const completion = runSequence(
      [
        {
          type: 'user',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_9',
                content: 'boom',
                is_error: true,
              },
            ],
          },
        },
      ],
      SESSION_ID,
      state,
    );

    expect(completion).toEqual([
      {
        type: 'tool_completed',
        runtimeId: RUNTIME_ID,
        sessionId: SESSION_ID,
        itemId: 'toolu_9',
        tool: 'plan_apply',
        success: false,
        result: 'boom',
        error: 'boom',
      },
    ]);
  });

  it('should emit an error and a failed turn for an auth-failure result', () => {
    const events = runSequence([
      {
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        result: 'Not logged in · Please run /login',
        session_id: null,
      },
    ]);

    expect(events).toEqual([
      {
        type: 'turn_completed',
        runtimeId: RUNTIME_ID,
        sessionId: SESSION_ID,
        turnId: null,
        status: 'failed',
        error: 'Not logged in · Please run /login',
      },
      {
        type: 'error',
        runtimeId: RUNTIME_ID,
        sessionId: SESSION_ID,
        message: 'Not logged in · Please run /login',
      },
    ]);
  });

  it('should not emit an error for transient system api_retry messages', () => {
    // api_retry is recoverable; surfacing it as `error` would terminate the
    // session via chatRuntime.fail. Fatal failures arrive on the result instead.
    const events = runSequence([
      { type: 'system', subtype: 'api_retry', message: 'Overloaded, retrying' },
    ]);

    expect(events).toEqual([]);
  });

  it('should emit an error for fatal system api_error messages', () => {
    const events = runSequence([
      { type: 'system', subtype: 'api_error', message: 'Fatal system error' },
    ]);

    expect(events).toEqual([
      {
        type: 'error',
        runtimeId: RUNTIME_ID,
        sessionId: SESSION_ID,
        message: 'Fatal system error',
      },
    ]);
  });

  it('should only emit error events when the session id is not linked', () => {
    const events = runSequence(
      [
        {
          type: 'assistant',
          message: { id: 'msg_1', role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
        },
        {
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          result: 'fatal',
        },
      ],
      null,
    );

    expect(events).toEqual([
      {
        type: 'error',
        runtimeId: RUNTIME_ID,
        sessionId: null,
        message: 'fatal',
      },
    ]);
  });
});
