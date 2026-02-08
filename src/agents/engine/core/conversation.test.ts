/**
 * Tests for Conversation Model
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createConversation,
  createUserMessage,
  createAssistantMessage,
  createSystemMessage,
  createTextPart,
  createThinkingPart,
  createPlanPart,
  createToolCallPart,
  createToolResultPart,
  createErrorPart,
  createApprovalPart,
  toSimpleLLMMessage,
  toSimpleLLMMessages,
  isValidMessagePart,
  isValidConversationMessage,
  type MessagePart,
} from './conversation';
import type { Thought, Plan, PlanStep } from './types';

// =============================================================================
// Test Fixtures
// =============================================================================

function createTestThought(): Thought {
  return {
    understanding: 'Split the clip at 5 seconds',
    requirements: ['Find the clip', 'Determine split point'],
    uncertainties: [],
    approach: 'Use split_clip tool at 5s mark',
    needsMoreInfo: false,
  };
}

function createTestPlan(): Plan {
  return {
    goal: 'Split clip at 5 seconds',
    steps: [
      {
        id: 's1',
        tool: 'get_timeline_info',
        args: {},
        description: 'Get timeline info',
        riskLevel: 'low',
        estimatedDuration: 500,
      },
      {
        id: 's2',
        tool: 'split_clip',
        args: { clipId: 'clip_001', position: 5 },
        description: 'Split clip at 5s',
        riskLevel: 'medium',
        estimatedDuration: 1000,
        dependsOn: ['s1'],
      },
    ],
    estimatedTotalDuration: 1500,
    requiresApproval: false,
    rollbackStrategy: 'Undo split operation',
  };
}

function createTestStep(): PlanStep {
  return {
    id: 's1',
    tool: 'split_clip',
    args: { clipId: 'clip_001', position: 5 },
    description: 'Split clip at 5 seconds',
    riskLevel: 'medium',
    estimatedDuration: 1000,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('Conversation Model', () => {
  beforeEach(() => {
    vi.stubGlobal('crypto', {
      randomUUID: vi.fn().mockReturnValue('test-uuid'),
    });
  });

  // ===========================================================================
  // Factory Functions
  // ===========================================================================

  describe('createConversation', () => {
    it('should create a conversation with correct projectId', () => {
      const conv = createConversation('project-123');
      expect(conv.projectId).toBe('project-123');
      expect(conv.id).toBe('test-uuid');
      expect(conv.messages).toEqual([]);
      expect(conv.createdAt).toBeGreaterThan(0);
      expect(conv.updatedAt).toBeGreaterThan(0);
    });

    it('should create different conversations for different projects', () => {
      const conv1 = createConversation('project-a');
      const conv2 = createConversation('project-b');
      expect(conv1.projectId).toBe('project-a');
      expect(conv2.projectId).toBe('project-b');
    });
  });

  describe('createUserMessage', () => {
    it('should create a user message with text part', () => {
      const msg = createUserMessage('Hello');
      expect(msg.role).toBe('user');
      expect(msg.parts).toHaveLength(1);
      expect(msg.parts[0]).toEqual({ type: 'text', content: 'Hello' });
      expect(msg.id).toBe('test-uuid');
      expect(msg.timestamp).toBeGreaterThan(0);
    });

    it('should handle empty content', () => {
      const msg = createUserMessage('');
      expect(msg.parts[0]).toEqual({ type: 'text', content: '' });
    });
  });

  describe('createAssistantMessage', () => {
    it('should create an empty assistant message', () => {
      const msg = createAssistantMessage();
      expect(msg.role).toBe('assistant');
      expect(msg.parts).toEqual([]);
      expect(msg.sessionId).toBeUndefined();
    });

    it('should attach sessionId when provided', () => {
      const msg = createAssistantMessage('session-abc');
      expect(msg.sessionId).toBe('session-abc');
    });
  });

  describe('createSystemMessage', () => {
    it('should create a system message', () => {
      const msg = createSystemMessage('Welcome');
      expect(msg.role).toBe('system');
      expect(msg.parts).toHaveLength(1);
      expect(msg.parts[0]).toEqual({ type: 'text', content: 'Welcome' });
    });
  });

  // ===========================================================================
  // Part Factory Functions
  // ===========================================================================

  describe('createTextPart', () => {
    it('should create a text part', () => {
      const part = createTextPart('Hello world');
      expect(part.type).toBe('text');
      expect(part.content).toBe('Hello world');
    });
  });

  describe('createThinkingPart', () => {
    it('should create a thinking part from a Thought', () => {
      const thought = createTestThought();
      const part = createThinkingPart(thought);
      expect(part.type).toBe('thinking');
      expect(part.thought).toBe(thought);
    });
  });

  describe('createPlanPart', () => {
    it('should create a plan part with default status', () => {
      const plan = createTestPlan();
      const part = createPlanPart(plan);
      expect(part.type).toBe('plan');
      expect(part.plan).toBe(plan);
      expect(part.status).toBe('proposed');
    });

    it('should create a plan part with specified status', () => {
      const plan = createTestPlan();
      const part = createPlanPart(plan, 'approved');
      expect(part.status).toBe('approved');
    });
  });

  describe('createToolCallPart', () => {
    it('should create a tool call part from a PlanStep', () => {
      const step = createTestStep();
      const part = createToolCallPart(step);
      expect(part.type).toBe('tool_call');
      expect(part.stepId).toBe('s1');
      expect(part.tool).toBe('split_clip');
      expect(part.args).toEqual({ clipId: 'clip_001', position: 5 });
      expect(part.description).toBe('Split clip at 5 seconds');
      expect(part.riskLevel).toBe('medium');
      expect(part.status).toBe('pending');
    });
  });

  describe('createToolResultPart', () => {
    it('should create a successful tool result', () => {
      const part = createToolResultPart('s1', 'split_clip', true, 150, { newClipId: 'clip_002' });
      expect(part.type).toBe('tool_result');
      expect(part.stepId).toBe('s1');
      expect(part.tool).toBe('split_clip');
      expect(part.success).toBe(true);
      expect(part.duration).toBe(150);
      expect(part.data).toEqual({ newClipId: 'clip_002' });
      expect(part.error).toBeUndefined();
    });

    it('should create a failed tool result', () => {
      const part = createToolResultPart('s1', 'split_clip', false, 200, undefined, 'Clip not found');
      expect(part.success).toBe(false);
      expect(part.error).toBe('Clip not found');
    });
  });

  describe('createErrorPart', () => {
    it('should create an error part', () => {
      const part = createErrorPart('TIMEOUT', 'Operation timed out', 'executing', true);
      expect(part.type).toBe('error');
      expect(part.code).toBe('TIMEOUT');
      expect(part.message).toBe('Operation timed out');
      expect(part.phase).toBe('executing');
      expect(part.recoverable).toBe(true);
    });
  });

  describe('createApprovalPart', () => {
    it('should create an approval part with default status', () => {
      const plan = createTestPlan();
      const part = createApprovalPart(plan);
      expect(part.type).toBe('approval');
      expect(part.plan).toBe(plan);
      expect(part.status).toBe('pending');
    });

    it('should create an approval part with specified status', () => {
      const plan = createTestPlan();
      const part = createApprovalPart(plan, 'rejected');
      expect(part.status).toBe('rejected');
    });
  });

  // ===========================================================================
  // Conversion Helpers
  // ===========================================================================

  describe('toSimpleLLMMessage', () => {
    it('should convert a user text message to LLMMessage', () => {
      const msg = createUserMessage('Split the clip');
      const llm = toSimpleLLMMessage(msg);
      expect(llm.role).toBe('user');
      expect(llm.content).toBe('Split the clip');
    });

    it('should convert an assistant message with multiple parts', () => {
      const msg = createAssistantMessage();
      msg.parts = [
        createTextPart('I will split the clip.'),
        createThinkingPart(createTestThought()),
        createPlanPart(createTestPlan()),
      ];

      const llm = toSimpleLLMMessage(msg);
      expect(llm.role).toBe('assistant');
      expect(llm.content).toContain('I will split the clip.');
      expect(llm.content).toContain('[Thinking]');
      expect(llm.content).toContain('[Plan]');
    });

    it('should convert tool_call parts', () => {
      const msg = createAssistantMessage();
      msg.parts = [createToolCallPart(createTestStep())];
      const llm = toSimpleLLMMessage(msg);
      expect(llm.content).toContain('[Tool Call] split_clip');
    });

    it('should convert tool_result parts', () => {
      const msg = createAssistantMessage();
      msg.parts = [createToolResultPart('s1', 'split_clip', true, 150)];
      const llm = toSimpleLLMMessage(msg);
      expect(llm.content).toContain('[Tool Result] split_clip: success');
    });

    it('should convert error parts', () => {
      const msg = createAssistantMessage();
      msg.parts = [createErrorPart('TIMEOUT', 'Timed out', 'executing', true)];
      const llm = toSimpleLLMMessage(msg);
      expect(llm.content).toContain('[Error] Timed out');
    });

    it('should convert approval parts', () => {
      const msg = createAssistantMessage();
      msg.parts = [createApprovalPart(createTestPlan(), 'approved')];
      const llm = toSimpleLLMMessage(msg);
      expect(llm.content).toContain('[Approval] Plan approved');
    });

    it('should map system role correctly', () => {
      const msg = createSystemMessage('System info');
      const llm = toSimpleLLMMessage(msg);
      expect(llm.role).toBe('system');
    });
  });

  describe('toSimpleLLMMessages', () => {
    it('should convert multiple messages', () => {
      const messages = [
        createUserMessage('Hello'),
        createAssistantMessage(),
      ];
      // Add a text part to assistant message
      messages[1].parts.push(createTextPart('Hi there'));

      const llmMessages = toSimpleLLMMessages(messages);
      expect(llmMessages).toHaveLength(2);
      expect(llmMessages[0].role).toBe('user');
      expect(llmMessages[1].role).toBe('assistant');
    });

    it('should filter out empty messages', () => {
      const messages = [
        createUserMessage('Hello'),
        createAssistantMessage(), // Empty parts
        createUserMessage('World'),
      ];

      const llmMessages = toSimpleLLMMessages(messages);
      expect(llmMessages).toHaveLength(2);
      expect(llmMessages[0].content).toBe('Hello');
      expect(llmMessages[1].content).toBe('World');
    });

    it('should limit messages when maxMessages specified', () => {
      const messages = [
        createUserMessage('First'),
        createUserMessage('Second'),
        createUserMessage('Third'),
        createUserMessage('Fourth'),
      ];

      const llmMessages = toSimpleLLMMessages(messages, 2);
      expect(llmMessages).toHaveLength(2);
      expect(llmMessages[0].content).toBe('Third');
      expect(llmMessages[1].content).toBe('Fourth');
    });

    it('should handle empty array', () => {
      const llmMessages = toSimpleLLMMessages([]);
      expect(llmMessages).toEqual([]);
    });
  });

  // ===========================================================================
  // Validation
  // ===========================================================================

  describe('isValidMessagePart', () => {
    it('should validate text parts', () => {
      expect(isValidMessagePart({ type: 'text', content: 'hello' })).toBe(true);
      expect(isValidMessagePart({ type: 'text' })).toBe(false);
      expect(isValidMessagePart({ type: 'text', content: 123 })).toBe(false);
    });

    it('should validate thinking parts', () => {
      expect(isValidMessagePart({ type: 'thinking', thought: createTestThought() })).toBe(true);
      expect(isValidMessagePart({ type: 'thinking' })).toBe(false);
      expect(isValidMessagePart({ type: 'thinking', thought: null })).toBe(false);
    });

    it('should validate plan parts', () => {
      expect(isValidMessagePart({ type: 'plan', plan: createTestPlan(), status: 'proposed' })).toBe(true);
      expect(isValidMessagePart({ type: 'plan', plan: createTestPlan(), status: 'invalid' })).toBe(false);
      expect(isValidMessagePart({ type: 'plan' })).toBe(false);
    });

    it('should validate tool_call parts', () => {
      expect(
        isValidMessagePart({
          type: 'tool_call',
          stepId: 's1',
          tool: 'split_clip',
          status: 'pending',
        })
      ).toBe(true);
      expect(
        isValidMessagePart({
          type: 'tool_call',
          stepId: 's1',
          tool: 'split_clip',
          status: 'invalid',
        })
      ).toBe(false);
    });

    it('should validate tool_result parts', () => {
      expect(
        isValidMessagePart({
          type: 'tool_result',
          stepId: 's1',
          tool: 'split_clip',
          success: true,
        })
      ).toBe(true);
      expect(
        isValidMessagePart({
          type: 'tool_result',
          stepId: 's1',
          tool: 'split_clip',
        })
      ).toBe(false);
    });

    it('should validate error parts', () => {
      expect(
        isValidMessagePart({
          type: 'error',
          code: 'ERR',
          message: 'msg',
        })
      ).toBe(true);
      expect(
        isValidMessagePart({
          type: 'error',
          code: 'ERR',
        })
      ).toBe(false);
    });

    it('should validate approval parts', () => {
      expect(
        isValidMessagePart({
          type: 'approval',
          plan: createTestPlan(),
          status: 'pending',
        })
      ).toBe(true);
      expect(
        isValidMessagePart({
          type: 'approval',
          plan: null,
          status: 'pending',
        })
      ).toBe(false);
    });

    it('should reject null, undefined, non-objects', () => {
      expect(isValidMessagePart(null)).toBe(false);
      expect(isValidMessagePart(undefined)).toBe(false);
      expect(isValidMessagePart('string')).toBe(false);
      expect(isValidMessagePart(42)).toBe(false);
    });

    it('should reject unknown types', () => {
      expect(isValidMessagePart({ type: 'unknown' })).toBe(false);
    });
  });

  describe('isValidConversationMessage', () => {
    it('should validate a valid user message', () => {
      const msg = createUserMessage('Hello');
      expect(isValidConversationMessage(msg)).toBe(true);
    });

    it('should validate a valid assistant message with parts', () => {
      const msg = createAssistantMessage();
      msg.parts.push(createTextPart('Hi'));
      expect(isValidConversationMessage(msg)).toBe(true);
    });

    it('should validate a valid empty assistant message', () => {
      const msg = createAssistantMessage();
      expect(isValidConversationMessage(msg)).toBe(true);
    });

    it('should reject invalid role', () => {
      const msg = { ...createUserMessage('Hi'), role: 'invalid' as 'user' };
      expect(isValidConversationMessage(msg)).toBe(false);
    });

    it('should reject empty id', () => {
      const msg = { ...createUserMessage('Hi'), id: '' };
      expect(isValidConversationMessage(msg)).toBe(false);
    });

    it('should reject non-array parts', () => {
      const msg = { ...createUserMessage('Hi'), parts: 'not array' };
      expect(isValidConversationMessage(msg)).toBe(false);
    });

    it('should reject non-number timestamp', () => {
      const msg = { ...createUserMessage('Hi'), timestamp: 'not number' };
      expect(isValidConversationMessage(msg)).toBe(false);
    });

    it('should reject null/undefined', () => {
      expect(isValidConversationMessage(null)).toBe(false);
      expect(isValidConversationMessage(undefined)).toBe(false);
    });

    it('should reject message with invalid parts', () => {
      const msg = createUserMessage('Hi');
      msg.parts.push({ type: 'unknown' } as unknown as MessagePart);
      expect(isValidConversationMessage(msg)).toBe(false);
    });
  });
});
