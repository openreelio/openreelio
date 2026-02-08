/**
 * ConversationMessageItem Tests
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
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

    it('should render tool call and result parts', () => {
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

      expect(screen.getByTestId('tool-call-part')).toBeInTheDocument();
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
