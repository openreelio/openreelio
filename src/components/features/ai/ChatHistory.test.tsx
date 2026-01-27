/**
 * ChatHistory Component Tests
 *
 * TDD tests for the chat history display and auto-scroll functionality.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ChatHistory } from './ChatHistory';
import type { ChatMessage } from '@/stores/aiStore';

// =============================================================================
// Mocks
// =============================================================================

const mockMessages: ChatMessage[] = [
  {
    id: 'msg_001',
    role: 'user',
    content: 'Cut the first 5 seconds',
    timestamp: new Date().toISOString(),
  },
  {
    id: 'msg_002',
    role: 'assistant',
    content: 'I will cut the first 5 seconds from the timeline.',
    timestamp: new Date().toISOString(),
  },
];

let mockChatMessages: ChatMessage[] = [];
let mockIsGenerating = false;

vi.mock('@/stores/aiStore', () => ({
  useAIStore: (selector: (state: unknown) => unknown) => {
    const state = {
      chatMessages: mockChatMessages,
      isGenerating: mockIsGenerating,
    };
    return selector(state);
  },
}));

// =============================================================================
// Tests
// =============================================================================

describe('ChatHistory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockChatMessages = [];
    mockIsGenerating = false;
  });

  describe('Rendering', () => {
    it('renders with test id', () => {
      render(<ChatHistory />);
      expect(screen.getByTestId('chat-history')).toBeInTheDocument();
    });

    it('shows empty state when no messages', () => {
      render(<ChatHistory />);
      expect(screen.getByText('Start a conversation')).toBeInTheDocument();
    });

    it('renders chat messages when present', () => {
      mockChatMessages = mockMessages;
      render(<ChatHistory />);

      expect(screen.getByText('Cut the first 5 seconds')).toBeInTheDocument();
      expect(
        screen.getByText('I will cut the first 5 seconds from the timeline.')
      ).toBeInTheDocument();
    });

    it('shows typing indicator when generating', () => {
      mockChatMessages = mockMessages;
      mockIsGenerating = true;
      render(<ChatHistory />);

      expect(screen.getByText('AI is thinking...')).toBeInTheDocument();
    });
  });

  describe('Styling', () => {
    it('has overflow-y-auto for scrolling', () => {
      render(<ChatHistory />);
      const container = screen.getByTestId('chat-history');
      expect(container).toHaveClass('overflow-y-auto');
    });

    it('applies custom className', () => {
      render(<ChatHistory className="custom-class" />);
      const container = screen.getByTestId('chat-history');
      expect(container).toHaveClass('custom-class');
    });
  });
});
