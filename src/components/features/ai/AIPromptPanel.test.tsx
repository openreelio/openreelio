/**
 * AIPromptPanel Component Tests
 *
 * TDD tests for the AI prompt input and command processing.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AIPromptPanel } from './AIPromptPanel';

// =============================================================================
// Mocks
// =============================================================================

// Mock useAIAgent hook
const mockAnalyzeIntent = vi.fn();
const mockApplyEditScript = vi.fn();
const mockRejectProposal = vi.fn();
const mockClearError = vi.fn();

vi.mock('@/hooks/useAIAgent', () => ({
  useAIAgent: () => ({
    isLoading: false,
    error: null,
    currentProposal: null,
    analyzeIntent: mockAnalyzeIntent,
    applyEditScript: mockApplyEditScript,
    rejectProposal: mockRejectProposal,
    clearError: mockClearError,
  }),
}));

// Mock stores
vi.mock('@/stores', () => ({
  useTimelineStore: (selector: (state: unknown) => unknown) => {
    const state = {
      selectedClipIds: ['clip_001'],
      selectedTrackIds: ['track_001'],
    };
    return selector(state);
  },
  usePlaybackStore: (selector: (state: unknown) => unknown) => {
    const state = {
      currentTime: 5.5,
    };
    return selector(state);
  },
}));

// =============================================================================
// Test Setup
// =============================================================================

function renderAIPromptPanel(props = {}) {
  return render(<AIPromptPanel {...props} />);
}

// =============================================================================
// Tests
// =============================================================================

describe('AIPromptPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAnalyzeIntent.mockResolvedValue({});
  });

  describe('Rendering', () => {
    it('renders the AI Assistant header', () => {
      renderAIPromptPanel();
      expect(screen.getByText('AI Assistant')).toBeInTheDocument();
    });

    it('renders the command input field', () => {
      renderAIPromptPanel();
      expect(
        screen.getByPlaceholderText(/Type a command/i)
      ).toBeInTheDocument();
    });

    it('renders the Run button', () => {
      renderAIPromptPanel();
      expect(screen.getByRole('button', { name: /Run/i })).toBeInTheDocument();
    });

    it('renders example commands', () => {
      renderAIPromptPanel();
      expect(screen.getByText('Cut the first 5 seconds')).toBeInTheDocument();
      expect(screen.getByText('Delete selected clips')).toBeInTheDocument();
      expect(screen.getByText('Move clip to 10 seconds')).toBeInTheDocument();
      expect(screen.getByText('Add clip at the end')).toBeInTheDocument();
    });

    it('displays playhead position', () => {
      renderAIPromptPanel();
      expect(screen.getByText(/Playhead: 5.50s/i)).toBeInTheDocument();
    });

    it('displays selected clip count', () => {
      renderAIPromptPanel();
      expect(screen.getByText(/Selected: 1 clip/i)).toBeInTheDocument();
    });
  });

  describe('Input Handling', () => {
    it('updates input value when typing', async () => {
      const user = userEvent.setup();
      renderAIPromptPanel();

      const input = screen.getByPlaceholderText(/Type a command/i);
      await user.type(input, 'Cut the first 3 seconds');

      expect(input).toHaveValue('Cut the first 3 seconds');
    });

    it('fills input when clicking an example command', async () => {
      const user = userEvent.setup();
      renderAIPromptPanel();

      const exampleButton = screen.getByText('Delete selected clips');
      await user.click(exampleButton);

      const input = screen.getByPlaceholderText(/Type a command/i);
      expect(input).toHaveValue('Delete selected clips');
    });

    it('clears input after successful submission', async () => {
      const user = userEvent.setup();
      renderAIPromptPanel();

      const input = screen.getByPlaceholderText(/Type a command/i);
      await user.type(input, 'Test command');

      const form = input.closest('form')!;
      fireEvent.submit(form);

      await waitFor(() => {
        expect(input).toHaveValue('');
      });
    });
  });

  describe('Form Submission', () => {
    it('calls analyzeIntent when form is submitted', async () => {
      const user = userEvent.setup();
      renderAIPromptPanel();

      const input = screen.getByPlaceholderText(/Type a command/i);
      await user.type(input, 'Cut the first 5 seconds');

      const form = input.closest('form')!;
      fireEvent.submit(form);

      await waitFor(() => {
        expect(mockAnalyzeIntent).toHaveBeenCalledWith(
          'Cut the first 5 seconds',
          expect.objectContaining({
            playheadPosition: 5.5,
            selectedClips: ['clip_001'],
            selectedTracks: ['track_001'],
          })
        );
      });
    });

    it('does not submit when input is empty', async () => {
      renderAIPromptPanel();

      const input = screen.getByPlaceholderText(/Type a command/i);
      const form = input.closest('form')!;
      fireEvent.submit(form);

      expect(mockAnalyzeIntent).not.toHaveBeenCalled();
    });

    it('does not submit when input contains only whitespace', async () => {
      const user = userEvent.setup();
      renderAIPromptPanel();

      const input = screen.getByPlaceholderText(/Type a command/i);
      await user.type(input, '   ');

      const form = input.closest('form')!;
      fireEvent.submit(form);

      expect(mockAnalyzeIntent).not.toHaveBeenCalled();
    });
  });

  describe('Run Button', () => {
    it('is disabled when input is empty', () => {
      renderAIPromptPanel();
      const runButton = screen.getByRole('button', { name: /Run/i });
      expect(runButton).toBeDisabled();
    });

    it('is enabled when input has value', async () => {
      const user = userEvent.setup();
      renderAIPromptPanel();

      const input = screen.getByPlaceholderText(/Type a command/i);
      await user.type(input, 'Test');

      const runButton = screen.getByRole('button', { name: /Run/i });
      expect(runButton).not.toBeDisabled();
    });
  });

  describe('Command History', () => {
    it('stores submitted commands in history', async () => {
      const user = userEvent.setup();
      renderAIPromptPanel();

      const input = screen.getByPlaceholderText(/Type a command/i);

      // Submit first command
      await user.type(input, 'First command');
      const form = input.closest('form')!;
      fireEvent.submit(form);

      await waitFor(() => {
        expect(input).toHaveValue('');
      });

      // Submit second command
      await user.type(input, 'Second command');
      fireEvent.submit(form);

      await waitFor(() => {
        expect(input).toHaveValue('');
      });

      // Navigate up to see history
      fireEvent.keyDown(input, { key: 'ArrowUp' });
      expect(input).toHaveValue('Second command');

      fireEvent.keyDown(input, { key: 'ArrowUp' });
      expect(input).toHaveValue('First command');
    });

    it('navigates down through history', async () => {
      const user = userEvent.setup();
      renderAIPromptPanel();

      const input = screen.getByPlaceholderText(/Type a command/i);

      // Submit commands
      await user.type(input, 'First command');
      fireEvent.submit(input.closest('form')!);
      await waitFor(() => expect(input).toHaveValue(''));

      await user.type(input, 'Second command');
      fireEvent.submit(input.closest('form')!);
      await waitFor(() => expect(input).toHaveValue(''));

      // Navigate up twice
      fireEvent.keyDown(input, { key: 'ArrowUp' });
      fireEvent.keyDown(input, { key: 'ArrowUp' });
      expect(input).toHaveValue('First command');

      // Navigate down
      fireEvent.keyDown(input, { key: 'ArrowDown' });
      expect(input).toHaveValue('Second command');

      // Navigate down to clear
      fireEvent.keyDown(input, { key: 'ArrowDown' });
      expect(input).toHaveValue('');
    });
  });

  describe('Callbacks', () => {
    it('passes onEditApplied prop to component', () => {
      const onEditApplied = vi.fn();
      renderAIPromptPanel({ onEditApplied });

      // Verify component renders with the callback prop
      // The actual callback invocation happens through ProposalDialog integration
      expect(screen.getByText('AI Assistant')).toBeInTheDocument();
    });

    it('calls onError when analysis fails', async () => {
      const onError = vi.fn();
      mockAnalyzeIntent.mockRejectedValueOnce(new Error('Analysis failed'));

      const user = userEvent.setup();
      renderAIPromptPanel({ onError });

      const input = screen.getByPlaceholderText(/Type a command/i);
      await user.type(input, 'Test command');

      const form = input.closest('form')!;
      fireEvent.submit(form);

      await waitFor(() => {
        expect(onError).toHaveBeenCalledWith('Analysis failed');
      });
    });
  });

  describe('Edge Cases', () => {
    it('does not submit again when input becomes empty after first submit', async () => {
      const user = userEvent.setup();
      renderAIPromptPanel();

      const input = screen.getByPlaceholderText(/Type a command/i);
      await user.type(input, 'Command 1');

      const form = input.closest('form')!;

      // First submission should work
      fireEvent.submit(form);

      await waitFor(() => {
        expect(mockAnalyzeIntent).toHaveBeenCalledTimes(1);
        expect(input).toHaveValue(''); // Input cleared after submit
      });

      // Second submission with empty input should not call analyzeIntent
      fireEvent.submit(form);

      // Still only 1 call since input is empty now
      expect(mockAnalyzeIntent).toHaveBeenCalledTimes(1);
    });

    it('trims input before submission', async () => {
      const user = userEvent.setup();
      renderAIPromptPanel();

      const input = screen.getByPlaceholderText(/Type a command/i);
      await user.type(input, '  Test command  ');

      const form = input.closest('form')!;
      fireEvent.submit(form);

      await waitFor(() => {
        expect(mockAnalyzeIntent).toHaveBeenCalledWith(
          'Test command',
          expect.any(Object)
        );
      });
    });

    it('does not submit when only spaces are entered', async () => {
      const user = userEvent.setup();
      renderAIPromptPanel();

      const input = screen.getByPlaceholderText(/Type a command/i);
      await user.type(input, '     ');

      const form = input.closest('form')!;
      fireEvent.submit(form);

      expect(mockAnalyzeIntent).not.toHaveBeenCalled();
    });
  });
});
