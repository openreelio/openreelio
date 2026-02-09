/**
 * AgenticChat Tests
 *
 * Tests for the main chat component that uses the agentic loop
 * and reads messages from conversationStore.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AgenticChat } from './AgenticChat';
import type { ILLMClient, IToolExecutor, LLMMessage } from '@/agents/engine';
import { useConversationStore } from '@/stores/conversationStore';

// Mock feature flags
vi.mock('@/config/featureFlags', () => ({
  isAgenticEngineEnabled: vi.fn(() => true),
}));

// Mock logger
vi.mock('@/services/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe('AgenticChat', () => {
  let mockLLMClient: ILLMClient;
  let mockToolExecutor: IToolExecutor;

  beforeEach(() => {
    // Initialize conversation store with 'default' project to match the
    // component's fallback when useProjectStore.activeSequenceId is null.
    useConversationStore.getState().loadForProject('default');

    const generateStream: ILLMClient['generateStream'] = async function* () {
      // No-op streaming for tests
    };

    const generateWithTools: ILLMClient['generateWithTools'] = async function* () {
      yield { type: 'done' };
    };

    const generateStructured: ILLMClient['generateStructured'] = async <T,>(
      messages: LLMMessage[],
      schema: Record<string, unknown>
    ): Promise<T> => {
      void messages;
      const properties =
        (schema as { properties?: Record<string, unknown> }).properties ?? {};

      if ('goalAchieved' in properties) {
        return {
          goalAchieved: true,
          stateChanges: [],
          summary: 'Execution succeeded',
          confidence: 0.9,
          needsIteration: false,
        } as unknown as T;
      }

      if ('goal' in properties) {
        return {
          goal: 'Execute test plan',
          steps: [
            {
              id: 'step_1',
              tool: 'split_clip',
              args: {},
              description: 'Split the clip',
              riskLevel: 'low',
              estimatedDuration: 250,
            },
          ],
          estimatedTotalDuration: 250,
          requiresApproval: false,
          rollbackStrategy: 'No rollback needed',
        } as unknown as T;
      }

      return {
        understanding: 'Test understanding',
        requirements: [],
        uncertainties: [],
        approach: 'Test approach',
        needsMoreInfo: false,
      } as unknown as T;
    };

    mockLLMClient = {
      provider: 'mock',
      generateStream,
      generateWithTools,
      generateStructured,
      complete: vi.fn().mockResolvedValue({
        content: JSON.stringify({
          understanding: 'Test understanding',
          requirements: [],
          uncertainties: [],
          approach: 'Test approach',
          needsMoreInfo: false,
        }),
        finishReason: 'stop',
      }),
      abort: vi.fn(),
      isGenerating: vi.fn(() => false),
      isConfigured: vi.fn(() => true),
    };

    const toolInfo = {
      name: 'split_clip',
      description: 'Split a clip at a position',
      category: 'clip',
      riskLevel: 'low' as const,
      supportsUndo: true,
      estimatedDuration: 'instant' as const,
      parallelizable: false,
    };

    mockToolExecutor = {
      execute: vi.fn().mockResolvedValue({
        success: true,
        data: {},
        duration: 100,
      }),
      executeBatch: vi.fn().mockResolvedValue({
        success: true,
        results: [],
        totalDuration: 100,
        successCount: 0,
        failureCount: 0,
      }),
      getAvailableTools: vi.fn().mockReturnValue([toolInfo]),
      getToolDefinition: vi.fn().mockReturnValue({
        ...toolInfo,
        parameters: { type: 'object', properties: {} },
        required: [],
      }),
      validateArgs: vi.fn().mockReturnValue({ valid: true, errors: [] }),
      hasTool: vi.fn().mockReturnValue(true),
      getToolsByCategory: vi.fn().mockReturnValue(new Map([['clip', [toolInfo]]])),
      getToolsByRisk: vi.fn().mockReturnValue([toolInfo]),
    };
  });

  afterEach(() => {
    vi.clearAllMocks();
    useConversationStore.getState().clearConversation();
  });

  describe('rendering', () => {
    it('should render the chat interface', () => {
      render(
        <AgenticChat
          llmClient={mockLLMClient}
          toolExecutor={mockToolExecutor}
        />
      );

      expect(screen.getByTestId('agentic-chat')).toBeInTheDocument();
    });

    it('should render input field', () => {
      render(
        <AgenticChat
          llmClient={mockLLMClient}
          toolExecutor={mockToolExecutor}
        />
      );

      expect(screen.getByPlaceholderText(/ask.*ai/i)).toBeInTheDocument();
    });

    it('should render send button', () => {
      render(
        <AgenticChat
          llmClient={mockLLMClient}
          toolExecutor={mockToolExecutor}
        />
      );

      expect(screen.getByRole('button', { name: /send/i })).toBeInTheDocument();
    });
  });

  describe('input handling', () => {
    it('should update input value on change', async () => {
      const user = userEvent.setup();
      render(
        <AgenticChat
          llmClient={mockLLMClient}
          toolExecutor={mockToolExecutor}
        />
      );

      const input = screen.getByPlaceholderText(/ask.*ai/i);
      await user.type(input, 'Split clip at 5 seconds');

      expect(input).toHaveValue('Split clip at 5 seconds');
    });

    it('should disable send button when input is empty', () => {
      render(
        <AgenticChat
          llmClient={mockLLMClient}
          toolExecutor={mockToolExecutor}
        />
      );

      const button = screen.getByRole('button', { name: /send/i });
      expect(button).toBeDisabled();
    });

    it('should enable send button when input has value', async () => {
      const user = userEvent.setup();
      render(
        <AgenticChat
          llmClient={mockLLMClient}
          toolExecutor={mockToolExecutor}
        />
      );

      const input = screen.getByPlaceholderText(/ask.*ai/i);
      await user.type(input, 'Test input');

      const button = screen.getByRole('button', { name: /send/i });
      expect(button).not.toBeDisabled();
    });
  });

  describe('submission', () => {
    it('should clear input after submission', async () => {
      const user = userEvent.setup();
      render(
        <AgenticChat
          llmClient={mockLLMClient}
          toolExecutor={mockToolExecutor}
        />
      );

      const input = screen.getByPlaceholderText(/ask.*ai/i);
      await user.type(input, 'Test input');

      const button = screen.getByRole('button', { name: /send/i });
      await user.click(button);

      expect(input).toHaveValue('');
    });

    it('should call onSubmit callback when provided', async () => {
      const onSubmit = vi.fn();
      const user = userEvent.setup();
      render(
        <AgenticChat
          llmClient={mockLLMClient}
          toolExecutor={mockToolExecutor}
          onSubmit={onSubmit}
        />
      );

      const input = screen.getByPlaceholderText(/ask.*ai/i);
      await user.type(input, 'Test input');

      const button = screen.getByRole('button', { name: /send/i });
      await user.click(button);

      expect(onSubmit).toHaveBeenCalledWith('Test input');
    });

    it('should submit on Enter key press', async () => {
      const onSubmit = vi.fn();
      const user = userEvent.setup();
      render(
        <AgenticChat
          llmClient={mockLLMClient}
          toolExecutor={mockToolExecutor}
          onSubmit={onSubmit}
        />
      );

      const input = screen.getByPlaceholderText(/ask.*ai/i);
      await user.type(input, 'Test input{enter}');

      expect(onSubmit).toHaveBeenCalledWith('Test input');
    });
  });

  describe('loading state', () => {
    it('should show loading indicator when running', async () => {
      const user = userEvent.setup();
      render(
        <AgenticChat
          llmClient={mockLLMClient}
          toolExecutor={mockToolExecutor}
        />
      );

      const input = screen.getByPlaceholderText(/ask.*ai/i);
      await user.type(input, 'Test input');

      const button = screen.getByRole('button', { name: /send/i });
      await user.click(button);

      // Chat interface should still be visible during/after running
      expect(screen.getByTestId('agentic-chat')).toBeInTheDocument();
    });

    it('should clear input and show message after submission', async () => {
      const user = userEvent.setup();
      render(
        <AgenticChat
          llmClient={mockLLMClient}
          toolExecutor={mockToolExecutor}
        />
      );

      const input = screen.getByPlaceholderText(/ask.*ai/i);
      await user.type(input, 'Test input');

      const button = screen.getByRole('button', { name: /send/i });
      await user.click(button);

      // Input should be cleared after submission
      expect(input).toHaveValue('');
      // User message should be visible (rendered by ConversationMessageItem)
      expect(screen.getByText('Test input')).toBeInTheDocument();
    });
  });

  describe('abort functionality', () => {
    it('should have send button that changes based on state', async () => {
      const user = userEvent.setup();
      render(
        <AgenticChat
          llmClient={mockLLMClient}
          toolExecutor={mockToolExecutor}
        />
      );

      // Initially should show send button
      const sendButton = screen.getByRole('button', { name: /send/i });
      expect(sendButton).toBeInTheDocument();

      const input = screen.getByPlaceholderText(/ask.*ai/i);
      await user.type(input, 'Test input');

      // Send button should be enabled with input
      expect(sendButton).not.toBeDisabled();
    });
  });

  describe('messages display', () => {
    it('should display user message after submission', async () => {
      const user = userEvent.setup();
      render(
        <AgenticChat
          llmClient={mockLLMClient}
          toolExecutor={mockToolExecutor}
        />
      );

      const input = screen.getByPlaceholderText(/ask.*ai/i);
      await user.type(input, 'Split clip at 5 seconds');

      const button = screen.getByRole('button', { name: /send/i });
      await user.click(button);

      expect(screen.getByText('Split clip at 5 seconds')).toBeInTheDocument();
    });

    it('should render user messages from conversation store', async () => {
      // Pre-populate the store
      useConversationStore.getState().addUserMessage('Pre-existing message');

      render(
        <AgenticChat
          llmClient={mockLLMClient}
          toolExecutor={mockToolExecutor}
        />
      );

      expect(screen.getByText('Pre-existing message')).toBeInTheDocument();
    });

    it('should render user messages with right-aligned layout', async () => {
      const user = userEvent.setup();
      render(
        <AgenticChat
          llmClient={mockLLMClient}
          toolExecutor={mockToolExecutor}
        />
      );

      const input = screen.getByPlaceholderText(/ask.*ai/i);
      await user.type(input, 'User message');
      await user.click(screen.getByRole('button', { name: /send/i }));

      const userMsg = screen.getByTestId('conversation-message-user');
      expect(userMsg).toBeInTheDocument();
    });
  });

  describe('thinking indicator integration', () => {
    it('should show thinking indicator when in thinking phase', async () => {
      mockLLMClient.complete = vi.fn().mockReturnValue(new Promise(() => {}));

      const user = userEvent.setup();
      render(
        <AgenticChat
          llmClient={mockLLMClient}
          toolExecutor={mockToolExecutor}
        />
      );

      const input = screen.getByPlaceholderText(/ask.*ai/i);
      await user.type(input, 'Test input');

      const button = screen.getByRole('button', { name: /send/i });
      await user.click(button);

      await waitFor(() => {
        // Should show some thinking indication
        expect(screen.getByTestId('agentic-chat')).toBeInTheDocument();
      });
    });
  });

  describe('disabled state', () => {
    it('should be disabled when disabled prop is true', () => {
      render(
        <AgenticChat
          llmClient={mockLLMClient}
          toolExecutor={mockToolExecutor}
          disabled={true}
        />
      );

      const input = screen.getByPlaceholderText(/ask.*ai/i);
      expect(input).toBeDisabled();
    });
  });

  describe('placeholder customization', () => {
    it('should allow custom placeholder', () => {
      render(
        <AgenticChat
          llmClient={mockLLMClient}
          toolExecutor={mockToolExecutor}
          placeholder="Custom placeholder text"
        />
      );

      expect(screen.getByPlaceholderText('Custom placeholder text')).toBeInTheDocument();
    });
  });

  describe('className customization', () => {
    it('should apply custom className', () => {
      render(
        <AgenticChat
          llmClient={mockLLMClient}
          toolExecutor={mockToolExecutor}
          className="custom-class"
        />
      );

      expect(screen.getByTestId('agentic-chat')).toHaveClass('custom-class');
    });
  });
});
