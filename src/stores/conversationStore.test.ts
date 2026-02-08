/**
 * Tests for ConversationStore
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { useConversationStore } from './conversationStore';
import type { MessagePart } from '@/agents/engine/core/conversation';
import {
  createTextPart,
  createThinkingPart,
  createPlanPart,
  createToolResultPart,
} from '@/agents/engine/core/conversation';
import type { Thought, Plan } from '@/agents/engine/core/types';

// =============================================================================
// Test Fixtures
// =============================================================================

function createTestThought(): Thought {
  return {
    understanding: 'Split the clip at 5 seconds',
    requirements: ['Find the clip'],
    uncertainties: [],
    approach: 'Use split_clip tool',
    needsMoreInfo: false,
  };
}

function createTestPlan(): Plan {
  return {
    goal: 'Split clip at 5s',
    steps: [
      {
        id: 's1',
        tool: 'split_clip',
        args: { clipId: 'c1', position: 5 },
        description: 'Split clip',
        riskLevel: 'low',
        estimatedDuration: 500,
      },
    ],
    estimatedTotalDuration: 500,
    requiresApproval: false,
    rollbackStrategy: 'Undo',
  };
}

// =============================================================================
// Setup
// =============================================================================

let mockStorage: Map<string, string>;

beforeEach(() => {
  // Reset store state
  useConversationStore.setState({
    activeConversation: null,
    isGenerating: false,
    streamingMessageId: null,
    activeProjectId: null,
  });

  // Mock localStorage
  mockStorage = new Map();
  vi.stubGlobal('localStorage', {
    getItem: vi.fn((key: string) => mockStorage.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => mockStorage.set(key, value)),
    removeItem: vi.fn((key: string) => mockStorage.delete(key)),
    length: 0,
    key: vi.fn(() => null),
    clear: vi.fn(() => mockStorage.clear()),
  });

  // Mock crypto.randomUUID
  let uuidCounter = 0;
  vi.stubGlobal('crypto', {
    randomUUID: vi.fn(() => `uuid-${++uuidCounter}`),
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// =============================================================================
// Tests
// =============================================================================

describe('ConversationStore', () => {
  describe('loadForProject', () => {
    it('should create a new conversation when none exists', () => {
      const store = useConversationStore.getState();
      store.loadForProject('project-1');

      const state = useConversationStore.getState();
      expect(state.activeConversation).not.toBeNull();
      expect(state.activeConversation!.projectId).toBe('project-1');
      expect(state.activeConversation!.messages).toEqual([]);
      expect(state.activeProjectId).toBe('project-1');
      expect(state.isGenerating).toBe(false);
      expect(state.streamingMessageId).toBeNull();
    });

    it('should load existing conversation from localStorage', () => {
      const existing = {
        id: 'conv-1',
        projectId: 'project-1',
        messages: [
          {
            id: 'msg-1',
            role: 'user',
            parts: [{ type: 'text', content: 'Hello' }],
            timestamp: Date.now(),
          },
        ],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      mockStorage.set('openreelio_conversation_project-1', JSON.stringify(existing));

      const store = useConversationStore.getState();
      store.loadForProject('project-1');

      const state = useConversationStore.getState();
      expect(state.activeConversation!.id).toBe('conv-1');
      expect(state.activeConversation!.messages).toHaveLength(1);
      expect(state.activeConversation!.messages[0].parts[0]).toEqual({
        type: 'text',
        content: 'Hello',
      });
    });

    it('should switch between projects', () => {
      const store = useConversationStore.getState();
      store.loadForProject('project-a');
      store.addUserMessage('Message in A');

      store.loadForProject('project-b');
      expect(useConversationStore.getState().activeProjectId).toBe('project-b');
      expect(useConversationStore.getState().activeConversation!.messages).toHaveLength(0);
    });

    it('should reset generating state on project switch', () => {
      const store = useConversationStore.getState();
      store.loadForProject('project-1');
      store.startAssistantMessage();

      expect(useConversationStore.getState().isGenerating).toBe(true);

      store.loadForProject('project-2');
      expect(useConversationStore.getState().isGenerating).toBe(false);
      expect(useConversationStore.getState().streamingMessageId).toBeNull();
    });
  });

  describe('addUserMessage', () => {
    it('should add a user message and return its ID', () => {
      const store = useConversationStore.getState();
      store.loadForProject('project-1');

      const msgId = store.addUserMessage('Hello AI');

      const state = useConversationStore.getState();
      expect(msgId).toBeTruthy();
      expect(state.activeConversation!.messages).toHaveLength(1);

      const msg = state.activeConversation!.messages[0];
      expect(msg.role).toBe('user');
      expect(msg.parts).toHaveLength(1);
      expect(msg.parts[0]).toEqual({ type: 'text', content: 'Hello AI' });
    });

    it('should do nothing if no active conversation', () => {
      const store = useConversationStore.getState();
      const msgId = store.addUserMessage('Hello');
      expect(msgId).toBeTruthy(); // Returns ID even if no conversation
    });
  });

  describe('startAssistantMessage', () => {
    it('should create an empty assistant message and set generating state', () => {
      const store = useConversationStore.getState();
      store.loadForProject('project-1');

      const msgId = store.startAssistantMessage('session-1');

      const state = useConversationStore.getState();
      expect(state.isGenerating).toBe(true);
      expect(state.streamingMessageId).toBe(msgId);
      expect(state.activeConversation!.messages).toHaveLength(1);

      const msg = state.activeConversation!.messages[0];
      expect(msg.role).toBe('assistant');
      expect(msg.parts).toEqual([]);
      expect(msg.sessionId).toBe('session-1');
    });
  });

  describe('appendPart', () => {
    it('should append a text part to a message', () => {
      const store = useConversationStore.getState();
      store.loadForProject('project-1');
      const msgId = store.startAssistantMessage();

      store.appendPart(msgId, createTextPart('Hello'));

      const state = useConversationStore.getState();
      const msg = state.activeConversation!.messages[0];
      expect(msg.parts).toHaveLength(1);
      expect(msg.parts[0]).toEqual({ type: 'text', content: 'Hello' });
    });

    it('should append multiple parts to the same message', () => {
      const store = useConversationStore.getState();
      store.loadForProject('project-1');
      const msgId = store.startAssistantMessage();

      store.appendPart(msgId, createTextPart('Thinking...'));
      store.appendPart(msgId, createThinkingPart(createTestThought()));
      store.appendPart(msgId, createPlanPart(createTestPlan()));

      const state = useConversationStore.getState();
      const msg = state.activeConversation!.messages[0];
      expect(msg.parts).toHaveLength(3);
      expect(msg.parts[0].type).toBe('text');
      expect(msg.parts[1].type).toBe('thinking');
      expect(msg.parts[2].type).toBe('plan');
    });

    it('should ignore append for non-existent message', () => {
      const store = useConversationStore.getState();
      store.loadForProject('project-1');

      // Should not throw
      store.appendPart('nonexistent', createTextPart('test'));

      const state = useConversationStore.getState();
      expect(state.activeConversation!.messages).toHaveLength(0);
    });
  });

  describe('updatePart', () => {
    it('should update an existing part', () => {
      const store = useConversationStore.getState();
      store.loadForProject('project-1');
      const msgId = store.startAssistantMessage();

      store.appendPart(msgId, {
        type: 'tool_call',
        stepId: 's1',
        tool: 'split_clip',
        args: {},
        description: 'Split clip',
        riskLevel: 'low',
        status: 'pending',
      });

      store.updatePart(msgId, 0, { status: 'running' } as Partial<MessagePart>);

      const state = useConversationStore.getState();
      const part = state.activeConversation!.messages[0].parts[0];
      expect(part.type).toBe('tool_call');
      if (part.type === 'tool_call') {
        expect(part.status).toBe('running');
      }
    });

    it('should ignore update for invalid indices', () => {
      const store = useConversationStore.getState();
      store.loadForProject('project-1');
      const msgId = store.startAssistantMessage();
      store.appendPart(msgId, createTextPart('test'));

      // Should not throw
      store.updatePart(msgId, 5, { content: 'updated' } as Partial<MessagePart>);

      const state = useConversationStore.getState();
      expect(state.activeConversation!.messages[0].parts[0]).toEqual({
        type: 'text',
        content: 'test',
      });
    });
  });

  describe('finalizeMessage', () => {
    it('should mark generation as complete', () => {
      const store = useConversationStore.getState();
      store.loadForProject('project-1');
      const msgId = store.startAssistantMessage();

      expect(useConversationStore.getState().isGenerating).toBe(true);

      store.finalizeMessage(msgId);

      const state = useConversationStore.getState();
      expect(state.isGenerating).toBe(false);
      expect(state.streamingMessageId).toBeNull();
    });

    it('should attach usage information when provided', () => {
      const store = useConversationStore.getState();
      store.loadForProject('project-1');
      const msgId = store.startAssistantMessage();

      store.finalizeMessage(msgId, {
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
      });

      const state = useConversationStore.getState();
      const msg = state.activeConversation!.messages[0];
      expect(msg.usage).toEqual({
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
      });
    });
  });

  describe('addSystemMessage', () => {
    it('should add a system message', () => {
      const store = useConversationStore.getState();
      store.loadForProject('project-1');

      const msgId = store.addSystemMessage('Operation cancelled');

      const state = useConversationStore.getState();
      expect(msgId).toBeTruthy();
      const msg = state.activeConversation!.messages[0];
      expect(msg.role).toBe('system');
      expect(msg.parts[0]).toEqual({ type: 'text', content: 'Operation cancelled' });
    });
  });

  describe('getMessagesForContext', () => {
    it('should return LLMMessages from conversation', () => {
      const store = useConversationStore.getState();
      store.loadForProject('project-1');

      store.addUserMessage('Hello');
      const assistantId = store.startAssistantMessage();
      store.appendPart(assistantId, createTextPart('Hi there'));
      store.finalizeMessage(assistantId);
      store.addUserMessage('How are you?');

      const messages = store.getMessagesForContext();
      expect(messages).toHaveLength(3);
      expect(messages[0]).toEqual({ role: 'user', content: 'Hello' });
      expect(messages[1]).toEqual({ role: 'assistant', content: 'Hi there' });
      expect(messages[2]).toEqual({ role: 'user', content: 'How are you?' });
    });

    it('should respect maxMessages limit', () => {
      const store = useConversationStore.getState();
      store.loadForProject('project-1');

      store.addUserMessage('First');
      store.addUserMessage('Second');
      store.addUserMessage('Third');

      const messages = store.getMessagesForContext(2);
      expect(messages).toHaveLength(2);
      expect(messages[0].content).toBe('Second');
      expect(messages[1].content).toBe('Third');
    });

    it('should return empty array when no conversation', () => {
      const messages = useConversationStore.getState().getMessagesForContext();
      expect(messages).toEqual([]);
    });
  });

  describe('getLastUserInput', () => {
    it('should return the last user input text', () => {
      const store = useConversationStore.getState();
      store.loadForProject('project-1');

      store.addUserMessage('First question');
      store.addUserMessage('Second question');

      expect(store.getLastUserInput()).toBe('Second question');
    });

    it('should skip non-user messages', () => {
      const store = useConversationStore.getState();
      store.loadForProject('project-1');

      store.addUserMessage('My question');
      store.addSystemMessage('System note');

      expect(useConversationStore.getState().getLastUserInput()).toBe('My question');
    });

    it('should return null when no user messages', () => {
      const store = useConversationStore.getState();
      store.loadForProject('project-1');

      expect(store.getLastUserInput()).toBeNull();
    });

    it('should return null when no conversation', () => {
      expect(useConversationStore.getState().getLastUserInput()).toBeNull();
    });
  });

  describe('clearConversation', () => {
    it('should clear the conversation and remove from storage', () => {
      const store = useConversationStore.getState();
      store.loadForProject('project-1');
      store.addUserMessage('Hello');
      store.startAssistantMessage();

      store.clearConversation();

      const state = useConversationStore.getState();
      expect(state.activeConversation!.messages).toEqual([]);
      expect(state.isGenerating).toBe(false);
      expect(state.streamingMessageId).toBeNull();
      expect(localStorage.removeItem).toHaveBeenCalledWith('openreelio_conversation_project-1');
    });

    it('should handle clear when no project is active', () => {
      const store = useConversationStore.getState();
      store.clearConversation(); // Should not throw
      expect(useConversationStore.getState().activeConversation).toBeNull();
    });
  });

  describe('setGenerating', () => {
    it('should set generating state', () => {
      const store = useConversationStore.getState();
      store.setGenerating(true);
      expect(useConversationStore.getState().isGenerating).toBe(true);

      store.setGenerating(false);
      const state = useConversationStore.getState();
      expect(state.isGenerating).toBe(false);
      expect(state.streamingMessageId).toBeNull();
    });
  });

  describe('persistence', () => {
    it('should persist user messages via debounced save', () => {
      vi.useFakeTimers();
      const store = useConversationStore.getState();
      store.loadForProject('project-1');

      store.addUserMessage('Hello');

      // Not saved immediately
      expect(localStorage.setItem).not.toHaveBeenCalled();

      // After debounce
      vi.advanceTimersByTime(1100);
      expect(localStorage.setItem).toHaveBeenCalled();

      const savedData = JSON.parse(mockStorage.get('openreelio_conversation_project-1')!);
      expect(savedData.messages).toHaveLength(1);
      expect(savedData.messages[0].parts[0].content).toBe('Hello');
    });

    it('should persist on finalize', () => {
      vi.useFakeTimers();
      const store = useConversationStore.getState();
      store.loadForProject('project-1');

      const msgId = store.startAssistantMessage();
      store.appendPart(msgId, createTextPart('response'));
      store.finalizeMessage(msgId);

      vi.advanceTimersByTime(1100);
      expect(localStorage.setItem).toHaveBeenCalled();
    });

    it('should load persisted conversation on next loadForProject', () => {
      vi.useFakeTimers();
      const store = useConversationStore.getState();
      store.loadForProject('project-1');
      store.addUserMessage('Persisted message');
      vi.advanceTimersByTime(1100); // Trigger save

      // Simulate reload
      useConversationStore.setState({
        activeConversation: null,
        activeProjectId: null,
      });

      store.loadForProject('project-1');
      const state = useConversationStore.getState();
      expect(state.activeConversation!.messages).toHaveLength(1);
      expect(state.activeConversation!.messages[0].parts[0]).toEqual({
        type: 'text',
        content: 'Persisted message',
      });
    });
  });

  describe('end-to-end conversation flow', () => {
    it('should support a full conversation cycle', () => {
      const store = useConversationStore.getState();
      store.loadForProject('project-1');

      // User sends message
      store.addUserMessage('Split the clip at 5 seconds');

      // Assistant starts responding
      const assistantId = store.startAssistantMessage('session-abc');
      expect(useConversationStore.getState().isGenerating).toBe(true);

      // Thinking phase
      store.appendPart(assistantId, createThinkingPart(createTestThought()));

      // Planning phase
      store.appendPart(assistantId, createPlanPart(createTestPlan()));

      // Tool execution
      const step = createTestPlan().steps[0];
      store.appendPart(assistantId, {
        type: 'tool_call',
        stepId: step.id,
        tool: step.tool,
        args: step.args,
        description: step.description,
        riskLevel: step.riskLevel,
        status: 'running',
        startedAt: Date.now(),
      });

      // Tool result
      store.appendPart(
        assistantId,
        createToolResultPart(step.id, step.tool, true, 150, { success: true })
      );

      // Final text summary
      store.appendPart(assistantId, createTextPart('Successfully split the clip at 5 seconds.'));

      // Finalize
      store.finalizeMessage(assistantId, {
        promptTokens: 500,
        completionTokens: 200,
        totalTokens: 700,
      });

      const state = useConversationStore.getState();
      expect(state.isGenerating).toBe(false);
      expect(state.activeConversation!.messages).toHaveLength(2);

      const assistantMsg = state.activeConversation!.messages[1];
      expect(assistantMsg.parts).toHaveLength(5);
      expect(assistantMsg.parts[0].type).toBe('thinking');
      expect(assistantMsg.parts[1].type).toBe('plan');
      expect(assistantMsg.parts[2].type).toBe('tool_call');
      expect(assistantMsg.parts[3].type).toBe('tool_result');
      expect(assistantMsg.parts[4].type).toBe('text');
      expect(assistantMsg.usage?.totalTokens).toBe(700);

      // Context for multi-turn
      const context = store.getMessagesForContext();
      expect(context).toHaveLength(2);
      expect(context[0].role).toBe('user');
      expect(context[1].role).toBe('assistant');
    });
  });
});
