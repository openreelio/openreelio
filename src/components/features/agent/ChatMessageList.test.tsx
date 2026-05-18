import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationMessage } from '@/agents/engine/core/conversation';
import { ChatMessageList } from './ChatMessageList';

describe('ChatMessageList', () => {
  const scrollIntoView = vi.fn();
  const scrollTo = vi.fn();
  const originalScrollIntoView = Element.prototype.scrollIntoView;
  const originalScrollTo = HTMLElement.prototype.scrollTo;

  beforeEach(() => {
    scrollIntoView.mockReset();
    scrollTo.mockReset();
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value: scrollTo,
    });
  });

  afterEach(() => {
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: originalScrollIntoView,
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value: originalScrollTo,
    });
  });

  it('keeps automatic scrolling inside the message list container', async () => {
    const { rerender } = render(
      <ChatMessageList
        messages={[
          {
            id: 'msg-1',
            role: 'assistant',
            parts: [{ type: 'text', content: 'Starting work' }],
            timestamp: 1,
          },
        ]}
        error={null}
        onApprove={() => {}}
        onReject={() => {}}
        onRetry={() => {}}
        onToolAllow={() => {}}
        onToolAllowAlways={() => {}}
        onToolDeny={() => {}}
      />,
    );

    rerender(
      <ChatMessageList
        messages={[
          {
            id: 'msg-1',
            role: 'assistant',
            parts: [{ type: 'text', content: 'Starting work' }],
            timestamp: 1,
          },
          {
            id: 'msg-2',
            role: 'assistant',
            parts: [{ type: 'text', content: 'Streaming next token' }],
            timestamp: 2,
          },
        ]}
        error={null}
        onApprove={() => {}}
        onReject={() => {}}
        onRetry={() => {}}
        onToolAllow={() => {}}
        onToolAllowAlways={() => {}}
        onToolDeny={() => {}}
      />,
    );

    await waitFor(() => {
      expect(scrollTo).toHaveBeenCalled();
    });
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('scrolls to the latest matching artifact message without expanding inline details', async () => {
    const messages: ConversationMessage[] = [
      {
        id: 'msg-1',
        role: 'assistant',
        parts: [{ type: 'text', content: 'Plain response' }],
        timestamp: 1,
      },
      {
        id: 'msg-2',
        role: 'assistant',
        parts: [
          { type: 'text', content: 'I updated the sequence.' },
          {
            type: 'tool_call',
            stepId: 's1',
            tool: 'delete_clip',
            args: { clipId: 'clip-1' },
            description: 'Delete clip-1',
            riskLevel: 'medium',
            status: 'completed',
          },
          {
            type: 'tool_result',
            stepId: 's1',
            tool: 'delete_clip',
            success: true,
            duration: 20,
          },
        ],
        timestamp: 2,
      },
    ];

    render(
      <ChatMessageList
        messages={messages}
        error={null}
        onApprove={() => {}}
        onReject={() => {}}
        onRetry={() => {}}
        onToolAllow={() => {}}
        onToolAllowAlways={() => {}}
        onToolDeny={() => {}}
        artifactFocus={{ kind: 'tool', value: 'delete_clip' }}
      />,
    );

    await waitFor(() => {
      expect(scrollTo).toHaveBeenCalled();
    });

    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(screen.getByTestId('assistant-artifact-group')).toBeInTheDocument();
    expect(screen.queryByTestId('tool-call-part')).not.toBeInTheDocument();
  });
});
