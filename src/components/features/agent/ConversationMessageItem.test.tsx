/**
 * ConversationMessageItem Tests
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConversationMessageItem } from './ConversationMessageItem';
import type { ConversationMessage } from '@/agents/engine/core/conversation';

describe('ConversationMessageItem', () => {
  describe('user messages', () => {
    it('should render user message with right-aligned layout', () => {
      const message: ConversationMessage = {
        id: 'msg-1',
        role: 'user',
        parts: [{ type: 'text', content: 'Hello AI' }],
        timestamp: Date.now(),
      };
      render(<ConversationMessageItem message={message} />);

      const el = screen.getByTestId('conversation-message-user');
      expect(el).toBeInTheDocument();
      expect(screen.getByText('Hello AI')).toBeInTheDocument();
    });

    it('should display timestamp for user messages', () => {
      const timestamp = new Date(2026, 0, 15, 14, 30, 0).getTime();
      const message: ConversationMessage = {
        id: 'msg-1',
        role: 'user',
        parts: [{ type: 'text', content: 'Hello' }],
        timestamp,
      };
      render(<ConversationMessageItem message={message} />);

      // Check that some time string is rendered
      const timeEl = screen.getByText(/\d+:\d+/);
      expect(timeEl).toBeInTheDocument();
    });
  });

  describe('system messages', () => {
    it('should render system message centered', () => {
      const message: ConversationMessage = {
        id: 'msg-2',
        role: 'system',
        parts: [{ type: 'text', content: 'Session started' }],
        timestamp: Date.now(),
      };
      render(<ConversationMessageItem message={message} />);

      const el = screen.getByTestId('conversation-message-system');
      expect(el).toBeInTheDocument();
      expect(screen.getByText('Session started')).toBeInTheDocument();
    });
  });

  describe('assistant messages', () => {
    it('should render assistant message with left-aligned layout', () => {
      const message: ConversationMessage = {
        id: 'msg-3',
        role: 'assistant',
        parts: [{ type: 'text', content: 'I will help you edit.' }],
        timestamp: Date.now(),
      };
      render(<ConversationMessageItem message={message} />);

      const el = screen.getByTestId('conversation-message-assistant');
      expect(el).toBeInTheDocument();
    });

    it('should render text parts', () => {
      const message: ConversationMessage = {
        id: 'msg-3',
        role: 'assistant',
        parts: [{ type: 'text', content: 'Here is my response' }],
        timestamp: Date.now(),
      };
      render(<ConversationMessageItem message={message} />);

      expect(screen.getByTestId('text-part')).toBeInTheDocument();
      expect(screen.getByText('Here is my response')).toBeInTheDocument();
    });

    it('should render thinking parts', () => {
      const message: ConversationMessage = {
        id: 'msg-4',
        role: 'assistant',
        parts: [
          {
            type: 'thinking',
            thought: {
              understanding: 'Need to split clip',
              approach: 'Use split tool',
              requirements: [],
              uncertainties: [],
              needsMoreInfo: false,
            },
          },
        ],
        timestamp: Date.now(),
      };
      render(<ConversationMessageItem message={message} />);

      expect(screen.getByTestId('thinking-part')).toBeInTheDocument();
    });

    it('should render clarification parts', () => {
      const message: ConversationMessage = {
        id: 'msg-4b',
        role: 'assistant',
        parts: [
          {
            type: 'clarification',
            question: 'Which clip should be used as the background?',
          },
        ],
        timestamp: Date.now(),
      };
      render(<ConversationMessageItem message={message} />);

      expect(screen.getByTestId('clarification-part')).toBeInTheDocument();
    });

    it('should render error parts with retry', () => {
      const onRetry = vi.fn();
      const message: ConversationMessage = {
        id: 'msg-5',
        role: 'assistant',
        parts: [
          {
            type: 'error',
            code: 'TIMEOUT',
            message: 'Timed out',
            phase: 'executing',
            recoverable: true,
          },
        ],
        timestamp: Date.now(),
      };
      render(<ConversationMessageItem message={message} onRetry={onRetry} />);

      expect(screen.getByTestId('error-part')).toBeInTheDocument();
      expect(screen.getByTestId('error-retry-btn')).toBeInTheDocument();
    });

    it('should render multiple parts in order', () => {
      const message: ConversationMessage = {
        id: 'msg-6',
        role: 'assistant',
        parts: [
          {
            type: 'thinking',
            thought: {
              understanding: 'understanding',
              approach: 'approach',
              requirements: [],
              uncertainties: [],
              needsMoreInfo: false,
            },
          },
          { type: 'text', content: 'Summary text' },
        ],
        timestamp: Date.now(),
      };
      render(<ConversationMessageItem message={message} />);

      expect(screen.getByTestId('thinking-part')).toBeInTheDocument();
      expect(screen.getByTestId('text-part')).toBeInTheDocument();
    });

    it('should collapse tool-only artifacts behind a compact summary', async () => {
      const user = userEvent.setup();
      const message: ConversationMessage = {
        id: 'msg-7',
        role: 'assistant',
        parts: [
          {
            type: 'tool_call',
            stepId: 's1',
            tool: 'split_clip',
            args: {},
            description: 'Split it',
            riskLevel: 'low',
            status: 'completed',
          },
          {
            type: 'tool_result',
            stepId: 's1',
            tool: 'split_clip',
            success: true,
            duration: 100,
          },
        ],
        timestamp: Date.now(),
      };
      render(<ConversationMessageItem message={message} />);

      expect(screen.getByTestId('assistant-artifact-group')).toBeInTheDocument();
      expect(screen.getByText('Work Details')).toBeInTheDocument();
      expect(screen.queryByTestId('tool-call-part')).not.toBeInTheDocument();
      expect(screen.queryByTestId('tool-result-part')).not.toBeInTheDocument();

      await user.click(screen.getByTestId('assistant-artifact-toggle'));

      expect(screen.getByTestId('tool-call-part')).toBeInTheDocument();
      expect(screen.getByTestId('tool-result-part')).toBeInTheDocument();
    });

    it('collapses execution artifacts behind a summary when text is present', async () => {
      const user = userEvent.setup();
      const message: ConversationMessage = {
        id: 'msg-7b',
        role: 'assistant',
        parts: [
          { type: 'text', content: 'I updated the sequence.' },
          {
            type: 'tool_call',
            stepId: 's1',
            tool: 'split_clip',
            args: {},
            description: 'Split it',
            riskLevel: 'low',
            status: 'completed',
          },
          {
            type: 'tool_result',
            stepId: 's1',
            tool: 'split_clip',
            success: true,
            duration: 100,
          },
        ],
        timestamp: Date.now(),
      };
      render(<ConversationMessageItem message={message} />);

      expect(screen.getByTestId('assistant-artifact-group')).toBeInTheDocument();
      expect(screen.getByText('Work Details')).toBeInTheDocument();
      expect(screen.getByText('1 action')).toBeInTheDocument();
      expect(screen.queryByTestId('tool-call-part')).not.toBeInTheDocument();

      await user.click(screen.getByTestId('assistant-artifact-toggle'));

      expect(screen.getByTestId('tool-call-part')).toBeInTheDocument();
      expect(screen.getByTestId('tool-result-part')).toBeInTheDocument();
    });

    it('should reveal running and failed artifacts by default', () => {
      const runningMessage: ConversationMessage = {
        id: 'msg-7c',
        role: 'assistant',
        parts: [
          {
            type: 'tool_call',
            stepId: 's1',
            tool: 'render_preview',
            args: {},
            description: 'Render preview',
            riskLevel: 'medium',
            status: 'running',
          },
        ],
        timestamp: Date.now(),
      };
      const { rerender } = render(<ConversationMessageItem message={runningMessage} />);

      expect(screen.getByTestId('tool-call-part')).toBeInTheDocument();

      const failedMessage: ConversationMessage = {
        id: 'msg-7d',
        role: 'assistant',
        parts: [
          {
            type: 'tool_result',
            stepId: 's1',
            tool: 'render_preview',
            success: false,
            error: 'Render failed',
            duration: 100,
          },
        ],
        timestamp: Date.now(),
      };
      rerender(<ConversationMessageItem message={failedMessage} />);

      expect(screen.getByTestId('tool-result-part')).toBeInTheDocument();
    });
  });

  describe('className', () => {
    it('should apply custom className', () => {
      const message: ConversationMessage = {
        id: 'msg-8',
        role: 'user',
        parts: [{ type: 'text', content: 'test' }],
        timestamp: Date.now(),
      };
      render(<ConversationMessageItem message={message} className="custom" />);

      expect(screen.getByTestId('conversation-message-user')).toHaveClass('custom');
    });
  });
});
