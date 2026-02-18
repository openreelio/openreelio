/**
 * useNewChat Hook Tests
 */

import { renderHook, act } from '@testing-library/react';
import { useNewChat } from './useNewChat';
import { useConversationStore } from '@/stores/conversationStore';

// Reset the store before each test
beforeEach(() => {
  useConversationStore.setState({
    activeConversation: null,
    isGenerating: false,
    streamingMessageId: null,
    activeProjectId: null,
  });
});

describe('useNewChat', () => {
  it('should return canCreateNew=false when no messages', () => {
    const { result } = renderHook(() => useNewChat());
    expect(result.current.canCreateNew).toBe(false);
  });

  it('should return canCreateNew=true when messages exist', () => {
    // Set up a conversation with messages
    useConversationStore.getState().loadForProject('test-project');
    useConversationStore.getState().addUserMessage('Hello');

    const { result } = renderHook(() => useNewChat());
    expect(result.current.canCreateNew).toBe(true);
  });

  it('should clear conversation on newChat', () => {
    useConversationStore.getState().loadForProject('test-project');
    useConversationStore.getState().addUserMessage('Hello');

    const { result } = renderHook(() => useNewChat());

    act(() => {
      result.current.newChat();
    });

    const state = useConversationStore.getState();
    expect(state.activeConversation?.messages ?? []).toHaveLength(0);
  });

  it('should call abort before clearing when abort is provided', () => {
    useConversationStore.getState().loadForProject('test-project');
    useConversationStore.getState().addUserMessage('Hello');

    const mockAbort = vi.fn();
    const { result } = renderHook(() =>
      useNewChat({ abort: mockAbort }),
    );

    act(() => {
      result.current.newChat();
    });

    expect(mockAbort).toHaveBeenCalledTimes(1);
  });

  it('should not throw when abort is not provided', () => {
    useConversationStore.getState().loadForProject('test-project');
    useConversationStore.getState().addUserMessage('Hello');

    const { result } = renderHook(() => useNewChat());

    act(() => {
      result.current.newChat();
    });

    const state = useConversationStore.getState();
    expect(state.activeConversation?.messages ?? []).toHaveLength(0);
  });
});
