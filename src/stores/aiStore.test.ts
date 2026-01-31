/**
 * AI Store Tests
 *
 * Tests for Zustand AI store covering chat messages, proposals, and state management.
 * Async provider operations are tested separately with mocks.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { useAIStore, type EditScript, type AIProposal, type ProposalStatus } from './aiStore';

// Mock Tauri APIs
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

vi.mock('@/services/chatStorage', () => ({
  loadChatHistory: vi.fn(() => []),
  clearChatHistory: vi.fn(),
  createDebouncedSaver: vi.fn(() => vi.fn()),
  cleanupOldHistories: vi.fn(),
}));

vi.mock('@/agents', () => ({
  registerEditingTools: vi.fn(),
  globalToolRegistry: {
    register: vi.fn(),
    get: vi.fn(),
    list: vi.fn(() => []),
  },
}));

// =============================================================================
// Test Helpers
// =============================================================================

function createMockEditScript(overrides: Partial<EditScript> = {}): EditScript {
  return {
    intent: 'test intent',
    commands: [
      {
        commandType: 'test_command',
        params: { key: 'value' },
        description: 'Test command',
      },
    ],
    requires: [],
    qcRules: [],
    risk: { copyright: 'none', nsfw: 'none' },
    explanation: 'Test explanation',
    ...overrides,
  };
}

function createMockProposal(overrides: Partial<AIProposal> = {}): AIProposal {
  return {
    id: 'test-proposal-id',
    editScript: createMockEditScript(),
    status: 'pending' as ProposalStatus,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('aiStore', () => {
  beforeEach(() => {
    // Reset store to initial state
    useAIStore.setState({
      providerStatus: {
        providerType: null,
        isConfigured: false,
        isAvailable: false,
        currentModel: null,
        availableModels: [],
        errorMessage: null,
      },
      isConfiguring: false,
      isConnecting: false,
      currentProposal: null,
      proposalHistory: [],
      chatMessages: [],
      isGenerating: false,
      isCancelled: false,
      currentProjectId: null,
      error: null,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ===========================================================================
  // Initial State Tests
  // ===========================================================================

  describe('initial state', () => {
    it('should have correct initial state', () => {
      const state = useAIStore.getState();

      expect(state.providerStatus.providerType).toBeNull();
      expect(state.providerStatus.isConfigured).toBe(false);
      expect(state.providerStatus.isAvailable).toBe(false);
      expect(state.currentProposal).toBeNull();
      expect(state.proposalHistory).toEqual([]);
      expect(state.chatMessages).toEqual([]);
      expect(state.isGenerating).toBe(false);
      expect(state.error).toBeNull();
    });
  });

  // ===========================================================================
  // Chat Message Tests
  // ===========================================================================

  describe('chat messages', () => {
    describe('addChatMessage', () => {
      it('should add user message', () => {
        const { addChatMessage } = useAIStore.getState();

        addChatMessage('user', 'Hello AI');

        const state = useAIStore.getState();
        expect(state.chatMessages).toHaveLength(1);
        expect(state.chatMessages[0].role).toBe('user');
        expect(state.chatMessages[0].content).toBe('Hello AI');
        expect(state.chatMessages[0].id).toBeDefined();
        expect(state.chatMessages[0].timestamp).toBeDefined();
      });

      it('should add assistant message', () => {
        const { addChatMessage } = useAIStore.getState();

        addChatMessage('assistant', 'Hello human');

        const state = useAIStore.getState();
        expect(state.chatMessages).toHaveLength(1);
        expect(state.chatMessages[0].role).toBe('assistant');
        expect(state.chatMessages[0].content).toBe('Hello human');
      });

      it('should add system message', () => {
        const { addChatMessage } = useAIStore.getState();

        addChatMessage('system', 'Connection established');

        const state = useAIStore.getState();
        expect(state.chatMessages).toHaveLength(1);
        expect(state.chatMessages[0].role).toBe('system');
        expect(state.chatMessages[0].content).toBe('Connection established');
      });

      it('should add message with proposal', () => {
        const { addChatMessage } = useAIStore.getState();
        const proposal = createMockProposal();

        addChatMessage('assistant', 'Here is my suggestion', proposal);

        const state = useAIStore.getState();
        expect(state.chatMessages).toHaveLength(1);
        expect(state.chatMessages[0].proposal).toEqual(proposal);
      });

      it('should preserve message order', () => {
        const { addChatMessage } = useAIStore.getState();

        addChatMessage('user', 'First');
        addChatMessage('assistant', 'Second');
        addChatMessage('user', 'Third');

        const state = useAIStore.getState();
        expect(state.chatMessages).toHaveLength(3);
        expect(state.chatMessages[0].content).toBe('First');
        expect(state.chatMessages[1].content).toBe('Second');
        expect(state.chatMessages[2].content).toBe('Third');
      });

      it('should generate unique IDs for each message', () => {
        const { addChatMessage } = useAIStore.getState();

        addChatMessage('user', 'Message 1');
        addChatMessage('user', 'Message 2');

        const state = useAIStore.getState();
        expect(state.chatMessages[0].id).not.toBe(state.chatMessages[1].id);
      });
    });

    describe('clearChatHistory', () => {
      it('should clear all messages', () => {
        const { addChatMessage, clearChatHistory } = useAIStore.getState();

        addChatMessage('user', 'Message 1');
        addChatMessage('assistant', 'Message 2');
        clearChatHistory();

        const state = useAIStore.getState();
        expect(state.chatMessages).toEqual([]);
      });

      it('should work when already empty', () => {
        const { clearChatHistory } = useAIStore.getState();

        clearChatHistory();

        const state = useAIStore.getState();
        expect(state.chatMessages).toEqual([]);
      });
    });
  });

  // ===========================================================================
  // Proposal Tests
  // ===========================================================================

  describe('proposals', () => {
    describe('createProposal', () => {
      it('should create proposal from edit script', () => {
        const { createProposal } = useAIStore.getState();
        const editScript = createMockEditScript();

        createProposal(editScript);

        const state = useAIStore.getState();
        expect(state.currentProposal).not.toBeNull();
        expect(state.currentProposal?.editScript).toEqual(editScript);
        expect(state.currentProposal?.status).toBe('pending');
        expect(state.currentProposal?.id).toBeDefined();
        expect(state.currentProposal?.createdAt).toBeDefined();
      });

      it('should replace existing current proposal', () => {
        const { createProposal } = useAIStore.getState();
        const editScript1 = createMockEditScript({ intent: 'first' });
        const editScript2 = createMockEditScript({ intent: 'second' });

        createProposal(editScript1);
        const firstId = useAIStore.getState().currentProposal?.id;

        createProposal(editScript2);
        const state = useAIStore.getState();

        expect(state.currentProposal?.editScript.intent).toBe('second');
        expect(state.currentProposal?.id).not.toBe(firstId);
      });
    });

    describe('rejectProposal', () => {
      it('should update proposal status to rejected', () => {
        const { createProposal, rejectProposal } = useAIStore.getState();
        const editScript = createMockEditScript();

        createProposal(editScript);
        const proposalId = useAIStore.getState().currentProposal?.id;

        rejectProposal(proposalId!);

        const state = useAIStore.getState();
        expect(state.currentProposal?.status).toBe('rejected');
      });

      it('should not reject if ID does not match', () => {
        const { createProposal, rejectProposal } = useAIStore.getState();
        const editScript = createMockEditScript();

        createProposal(editScript);
        rejectProposal('wrong-id');

        const state = useAIStore.getState();
        // Status should remain pending when ID doesn't match
        expect(state.currentProposal?.status).toBe('pending');
      });
    });

    describe('clearCurrentProposal', () => {
      it('should clear current proposal', () => {
        const { createProposal, clearCurrentProposal } = useAIStore.getState();
        const editScript = createMockEditScript();

        createProposal(editScript);
        clearCurrentProposal();

        const state = useAIStore.getState();
        expect(state.currentProposal).toBeNull();
      });

      it('should work when no proposal exists', () => {
        const { clearCurrentProposal } = useAIStore.getState();

        clearCurrentProposal();

        const state = useAIStore.getState();
        expect(state.currentProposal).toBeNull();
      });
    });
  });

  // ===========================================================================
  // Error Handling Tests
  // ===========================================================================

  describe('error handling', () => {
    describe('setError', () => {
      it('should set error message', () => {
        const { setError } = useAIStore.getState();

        setError('Something went wrong');

        const state = useAIStore.getState();
        expect(state.error).toBe('Something went wrong');
      });

      it('should allow null to clear error', () => {
        const { setError } = useAIStore.getState();

        setError('An error');
        setError(null);

        const state = useAIStore.getState();
        expect(state.error).toBeNull();
      });
    });

    describe('clearError', () => {
      it('should clear error', () => {
        const { setError, clearError } = useAIStore.getState();

        setError('An error');
        clearError();

        const state = useAIStore.getState();
        expect(state.error).toBeNull();
      });

      it('should work when no error exists', () => {
        const { clearError } = useAIStore.getState();

        clearError();

        const state = useAIStore.getState();
        expect(state.error).toBeNull();
      });
    });
  });

  // ===========================================================================
  // Generation State Tests
  // ===========================================================================

  describe('generation state', () => {
    describe('cancelGeneration', () => {
      it('should set isCancelled flag', () => {
        // Simulate generation in progress
        useAIStore.setState({ isGenerating: true });

        const { cancelGeneration } = useAIStore.getState();
        cancelGeneration();

        const state = useAIStore.getState();
        expect(state.isCancelled).toBe(true);
      });
    });
  });

  // ===========================================================================
  // Project Context Tests
  // ===========================================================================

  describe('project context', () => {
    describe('setCurrentProjectId', () => {
      it('should set project ID', () => {
        const { setCurrentProjectId } = useAIStore.getState();

        setCurrentProjectId('project-123');

        const state = useAIStore.getState();
        expect(state.currentProjectId).toBe('project-123');
      });

      it('should allow null to clear project ID', () => {
        const { setCurrentProjectId } = useAIStore.getState();

        setCurrentProjectId('project-123');
        setCurrentProjectId(null);

        const state = useAIStore.getState();
        expect(state.currentProjectId).toBeNull();
      });
    });
  });

  // ===========================================================================
  // Integration Tests
  // ===========================================================================

  describe('integration', () => {
    it('should handle full chat flow with proposal', () => {
      const { addChatMessage, createProposal, rejectProposal } = useAIStore.getState();

      // User sends message
      addChatMessage('user', 'Cut the clip at 5 seconds');

      // Create and attach proposal
      const editScript = createMockEditScript({
        intent: 'Cut clip',
        explanation: 'I will cut the clip at 5 seconds',
      });
      createProposal(editScript);

      // Add assistant message with proposal
      const proposal = useAIStore.getState().currentProposal;
      addChatMessage('assistant', editScript.explanation, proposal ?? undefined);

      // Reject proposal
      rejectProposal(proposal!.id);

      const state = useAIStore.getState();

      // Verify final state
      expect(state.chatMessages).toHaveLength(2);
      expect(state.chatMessages[0].role).toBe('user');
      expect(state.chatMessages[1].role).toBe('assistant');
      // Note: The proposal attached to the message is a snapshot (copy)
      // at the time of attachment, so it retains its original status.
      // currentProposal status is updated to 'rejected'.
      expect(state.chatMessages[1].proposal).toBeDefined();
      expect(state.currentProposal?.status).toBe('rejected');
    });

    it('should maintain state consistency across multiple operations', () => {
      const { addChatMessage, createProposal, clearChatHistory, setError, clearError } =
        useAIStore.getState();

      // Multiple operations
      addChatMessage('user', 'Message 1');
      setError('Temporary error');
      createProposal(createMockEditScript());
      addChatMessage('assistant', 'Response');
      clearError();

      let state = useAIStore.getState();
      expect(state.chatMessages).toHaveLength(2);
      expect(state.currentProposal).not.toBeNull();
      expect(state.error).toBeNull();

      // Clear chat
      clearChatHistory();

      state = useAIStore.getState();
      expect(state.chatMessages).toHaveLength(0);
      expect(state.currentProposal).not.toBeNull(); // Proposal not cleared
    });
  });
});
