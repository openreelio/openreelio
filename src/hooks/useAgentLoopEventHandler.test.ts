import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useConversationStore } from '@/stores/conversationStore';
import { useAgentLoopEventHandler } from './useAgentLoopEventHandler';

beforeEach(() => {
  useConversationStore.setState({
    activeConversation: {
      id: 'conv-1',
      projectId: 'project-1',
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
    isGenerating: false,
    streamingMessageId: null,
    activeProjectId: 'project-1',
    activeSessionId: 'session-1',
  });

  let uuidCounter = 0;
  vi.stubGlobal('crypto', {
    randomUUID: vi.fn(() => `uuid-${++uuidCounter}`),
  });
});

describe('useAgentLoopEventHandler', () => {
  it('should stream text deltas into a single assistant text part and finalize on done', () => {
    const { result } = renderHook(() => useAgentLoopEventHandler());

    act(() => {
      result.current.handleEvent({
        type: 'text_delta',
        content: 'Hello',
      });
      result.current.handleEvent({
        type: 'text_delta',
        content: ' world',
      });
      result.current.handleEvent({
        type: 'done',
      });
    });

    const state = useConversationStore.getState();
    expect(state.activeConversation?.messages).toHaveLength(1);
    expect(state.activeConversation?.messages[0]?.parts).toEqual([
      {
        type: 'text',
        content: 'Hello world',
      },
    ]);
    expect(state.isGenerating).toBe(false);
    expect(state.streamingMessageId).toBeNull();
  });

  it('should render and resolve tool permission parts', () => {
    const { result } = renderHook(() => useAgentLoopEventHandler());

    act(() => {
      result.current.handleEvent({
        type: 'tool_permission_request',
        id: 'permission-1',
        tool: 'delete_clip',
        args: { clipId: 'clip-1' },
        riskLevel: 'high',
      });
      result.current.handleEvent({
        type: 'tool_permission_response',
        id: 'permission-1',
        tool: 'delete_clip',
        decision: 'allow_always',
      });
    });

    const message = useConversationStore.getState().activeConversation?.messages[0];
    expect(message?.parts).toHaveLength(1);
    expect(message?.parts[0]).toMatchObject({
      type: 'tool_approval',
      stepId: 'permission-1',
      tool: 'delete_clip',
      args: { clipId: 'clip-1' },
      status: 'approved',
      riskLevel: 'high',
    });
  });

  it('should finalize the assistant message when aborted mid-run', () => {
    const { result } = renderHook(() => useAgentLoopEventHandler());

    act(() => {
      result.current.handleEvent({
        type: 'reasoning_delta',
        content: 'Inspecting timeline',
      });
      result.current.handleAbort('Session aborted by user');
    });

    const state = useConversationStore.getState();
    expect(state.activeConversation?.messages).toHaveLength(1);
    expect(state.activeConversation?.messages[0]?.parts).toEqual([
      {
        type: 'reasoning',
        content: 'Inspecting timeline',
      },
      {
        type: 'text',
        content: 'Session aborted by user',
      },
    ]);
    expect(state.isGenerating).toBe(false);
  });
});
