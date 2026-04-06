import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationMessage } from '@/agents/engine/core/conversation';
import { ChatMessageList } from './ChatMessageList';

describe('ChatMessageList', () => {
  const scrollIntoView = vi.fn();
  const originalScrollIntoView = Element.prototype.scrollIntoView;

  beforeEach(() => {
    scrollIntoView.mockReset();
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });
  });

  afterEach(() => {
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: originalScrollIntoView,
    });
  });

  it('scrolls to and expands the latest matching artifact message when focused', async () => {
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
      expect(scrollIntoView).toHaveBeenCalled();
    });

    expect(screen.getByTestId('tool-call-part')).toBeInTheDocument();
    expect(screen.getByTestId('assistant-artifact-group')).toBeInTheDocument();
  });
});
