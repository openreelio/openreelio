/**
 * ChatInput Component Tests
 *
 * TDD tests for the chat input with auto-resize and submission.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChatInput } from './ChatInput';

// =============================================================================
// Mocks
// =============================================================================

const mockGenerateEditScript = vi.fn();
let mockIsGenerating = false;

vi.mock('@/stores/aiStore', () => ({
  useAIStore: (selector: (state: unknown) => unknown) => {
    const state = {
      isGenerating: mockIsGenerating,
      generateEditScript: mockGenerateEditScript,
    };
    return selector(state);
  },
}));

vi.mock('@/stores', () => ({
  useTimelineStore: (selector: (state: unknown) => unknown) => {
    const state = {
      playhead: 5.5,
      selectedClipIds: ['clip_001'],
      selectedTrackIds: ['track_001'],
    };
    return selector(state);
  },
}));

// =============================================================================
// Tests
// =============================================================================

describe('ChatInput', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsGenerating = false;
    mockGenerateEditScript.mockResolvedValue({});
  });

  describe('Rendering', () => {
    it('renders with test id', () => {
      render(<ChatInput />);
      expect(screen.getByTestId('chat-input')).toBeInTheDocument();
    });

    it('renders textarea with placeholder', () => {
      render(<ChatInput />);
      expect(
        screen.getByPlaceholderText(/Ask AI to edit your video/i)
      ).toBeInTheDocument();
    });

    it('renders send button', () => {
      render(<ChatInput />);
      expect(
        screen.getByRole('button', { name: /send message/i })
      ).toBeInTheDocument();
    });

    it('renders hint text', () => {
      render(<ChatInput />);
      expect(screen.getByText(/Press/)).toBeInTheDocument();
      expect(screen.getByText(/to send/)).toBeInTheDocument();
    });
  });

  describe('Input Handling', () => {
    it('updates input value when typing', async () => {
      const user = userEvent.setup();
      render(<ChatInput />);

      const input = screen.getByPlaceholderText(/Ask AI to edit your video/i);
      await user.type(input, 'Test message');

      expect(input).toHaveValue('Test message');
    });

    it('send button is disabled when input is empty', () => {
      render(<ChatInput />);
      const sendButton = screen.getByRole('button', { name: /send message/i });
      expect(sendButton).toBeDisabled();
    });

    it('send button is enabled when input has value', async () => {
      const user = userEvent.setup();
      render(<ChatInput />);

      const input = screen.getByPlaceholderText(/Ask AI to edit your video/i);
      await user.type(input, 'Test message');

      const sendButton = screen.getByRole('button', { name: /send message/i });
      expect(sendButton).not.toBeDisabled();
    });
  });

  describe('Submission', () => {
    it('calls generateEditScript when send button clicked', async () => {
      const user = userEvent.setup();
      render(<ChatInput />);

      const input = screen.getByPlaceholderText(/Ask AI to edit your video/i);
      await user.type(input, 'Test command');

      const sendButton = screen.getByRole('button', { name: /send message/i });
      await user.click(sendButton);

      expect(mockGenerateEditScript).toHaveBeenCalledWith('Test command', {
        playheadPosition: 5.5,
        selectedClips: ['clip_001'],
        selectedTracks: ['track_001'],
      });
    });

    it('calls generateEditScript when Enter pressed', async () => {
      const user = userEvent.setup();
      render(<ChatInput />);

      const input = screen.getByPlaceholderText(/Ask AI to edit your video/i);
      await user.type(input, 'Test command');
      await user.keyboard('{Enter}');

      expect(mockGenerateEditScript).toHaveBeenCalled();
    });

    it('does not submit on Shift+Enter', async () => {
      const user = userEvent.setup();
      render(<ChatInput />);

      const input = screen.getByPlaceholderText(/Ask AI to edit your video/i);
      await user.type(input, 'Test command');
      await user.keyboard('{Shift>}{Enter}{/Shift}');

      expect(mockGenerateEditScript).not.toHaveBeenCalled();
    });

    it('clears input after successful submission', async () => {
      const user = userEvent.setup();
      render(<ChatInput />);

      const input = screen.getByPlaceholderText(/Ask AI to edit your video/i);
      await user.type(input, 'Test command');
      await user.click(screen.getByRole('button', { name: /send message/i }));

      await waitFor(() => {
        expect(input).toHaveValue('');
      });
    });

    it('calls onSend callback when message sent', async () => {
      const user = userEvent.setup();
      const onSend = vi.fn();
      render(<ChatInput onSend={onSend} />);

      const input = screen.getByPlaceholderText(/Ask AI to edit your video/i);
      await user.type(input, 'Test message');
      await user.click(screen.getByRole('button', { name: /send message/i }));

      expect(onSend).toHaveBeenCalledWith('Test message');
    });
  });

  describe('Loading State', () => {
    it('shows stop button when generating', () => {
      mockIsGenerating = true;
      render(<ChatInput />);

      expect(
        screen.getByRole('button', { name: /stop generating/i })
      ).toBeInTheDocument();
    });

    it('disables textarea when generating', () => {
      mockIsGenerating = true;
      render(<ChatInput />);

      const input = screen.getByPlaceholderText(/Ask AI to edit your video/i);
      expect(input).toBeDisabled();
    });
  });
});
