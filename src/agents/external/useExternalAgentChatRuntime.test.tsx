import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useConversationStore } from '@/stores/conversationStore';

import { useExternalAgentChatRuntime } from './useExternalAgentChatRuntime';
import type {
  ExternalAgentRuntimeAdapter,
  ExternalAgentRuntimeEvent,
  ExternalAgentRuntimeEventHandler,
} from './types';

class FakeExternalAgentAdapter implements ExternalAgentRuntimeAdapter {
  readonly id = 'codex' as const;
  readonly displayName = 'Codex';
  readonly startSession = vi.fn(async () => ({ sessionId: 'thr_123', runtimeId: this.id }));
  readonly sendMessage = vi.fn(async () => undefined);
  readonly interrupt = vi.fn(async () => undefined);
  readonly shutdown = vi.fn(async () => undefined);
  private handler: ExternalAgentRuntimeEventHandler | null = null;

  async detect() {
    return {
      runtimeId: this.id,
      displayName: this.displayName,
      installStatus: 'installed' as const,
      authStatus: 'signed-in' as const,
      available: true,
      version: '1.0.0',
      reason: null,
    };
  }

  async authStatus() {
    return 'signed-in' as const;
  }

  async capabilities() {
    return {
      streamingEvents: true,
      interrupt: true,
      mcpClient: true,
      approvalAware: true,
      localAccountAuth: true,
      sessionResume: true,
      structuredToolCalls: true,
    };
  }

  subscribe(handler: ExternalAgentRuntimeEventHandler): () => void {
    this.handler = handler;
    return () => {
      this.handler = null;
    };
  }

  emit(event: ExternalAgentRuntimeEvent): void {
    this.handler?.(event);
  }
}

describe('useExternalAgentChatRuntime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useConversationStore.setState((state) => ({
      ...state,
      activeProjectId: 'project-1',
      activeSessionId: 'session-1',
      activeConversation: {
        id: 'session-1',
        projectId: 'project-1',
        messages: [],
        createdAt: 100,
        updatedAt: 100,
      },
      conversationsBySessionId: {},
      sessionGenerationBySessionId: {},
      isGenerating: false,
      streamingMessageId: null,
    }));
  });

  it('should retain a running Codex controller across chat surface unmounts', async () => {
    const adapter = new FakeExternalAgentAdapter();
    const firstHook = renderHook(() =>
      useExternalAgentChatRuntime({
        adapter,
        projectId: 'project-1',
        cwd: '/project',
        enabled: true,
        retainAcrossUnmount: true,
      }),
    );

    await act(async () => {
      await firstHook.result.current.executeMessage('Long running edit');
    });

    await waitFor(() => {
      expect(firstHook.result.current.isRunning).toBe(true);
    });

    firstHook.unmount();

    expect(adapter.shutdown).not.toHaveBeenCalled();

    act(() => {
      adapter.emit({
        type: 'assistant_delta',
        runtimeId: 'codex',
        sessionId: 'thr_123',
        itemId: 'item_1',
        content: 'Still working',
      });
    });

    const nextAdapter = new FakeExternalAgentAdapter();
    const secondHook = renderHook(() =>
      useExternalAgentChatRuntime({
        adapter: nextAdapter,
        projectId: 'project-1',
        cwd: '/project',
        enabled: true,
        retainAcrossUnmount: true,
      }),
    );

    await waitFor(() => {
      expect(secondHook.result.current.isRunning).toBe(true);
    });

    expect(adapter.shutdown).not.toHaveBeenCalled();
    expect(nextAdapter.startSession).not.toHaveBeenCalled();
    expect(useConversationStore.getState().activeConversation?.messages[0]?.parts).toEqual([
      { type: 'text', content: 'Still working' },
    ]);

    act(() => {
      adapter.emit({
        type: 'turn_completed',
        runtimeId: 'codex',
        sessionId: 'thr_123',
        turnId: 'turn_1',
        status: 'completed',
      });
    });

    await waitFor(() => {
      expect(secondHook.result.current.isRunning).toBe(false);
    });

    secondHook.unmount();

    expect(adapter.shutdown).toHaveBeenCalledWith('thr_123');
  });

  it('should dispose a retained Codex controller after it becomes idle', async () => {
    const adapter = new FakeExternalAgentAdapter();
    const firstHook = renderHook(() =>
      useExternalAgentChatRuntime({
        adapter,
        projectId: 'project-1',
        cwd: '/project',
        enabled: true,
        retainAcrossUnmount: true,
      }),
    );

    await act(async () => {
      await firstHook.result.current.executeMessage('Short edit');
    });
    act(() => {
      adapter.emit({
        type: 'turn_completed',
        runtimeId: 'codex',
        sessionId: 'thr_123',
        turnId: 'turn_1',
        status: 'completed',
      });
    });
    await waitFor(() => {
      expect(firstHook.result.current.isRunning).toBe(false);
    });

    firstHook.unmount();

    expect(adapter.shutdown).toHaveBeenCalledWith('thr_123');

    const nextAdapter = new FakeExternalAgentAdapter();
    const secondHook = renderHook(() =>
      useExternalAgentChatRuntime({
        adapter: nextAdapter,
        projectId: 'project-1',
        cwd: '/project',
        enabled: true,
        retainAcrossUnmount: true,
      }),
    );

    await act(async () => {
      await secondHook.result.current.executeMessage('Fresh edit');
    });

    expect(nextAdapter.startSession).toHaveBeenCalledTimes(1);
    expect(nextAdapter.sendMessage).toHaveBeenCalledWith('thr_123', {
      content: 'Fresh edit',
      cwd: '/project',
    });
    expect(adapter.sendMessage).toHaveBeenCalledTimes(1);

    act(() => {
      nextAdapter.emit({
        type: 'turn_completed',
        runtimeId: 'codex',
        sessionId: 'thr_123',
        turnId: 'turn_2',
        status: 'completed',
      });
    });
    await waitFor(() => {
      expect(secondHook.result.current.isRunning).toBe(false);
    });
    secondHook.unmount();
  });
});
