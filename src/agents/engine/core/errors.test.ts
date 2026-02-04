/**
 * Agentic Engine Errors Tests
 */

import { describe, it, expect } from 'vitest';
import {
  ConfigurationError,
  SessionActiveError,
  SessionAbortedError,
  ThinkingTimeoutError,
  UnderstandingError,
  PlanningTimeoutError,
  PlanGenerationError,
  PlanValidationError,
  ToolNotFoundError,
  ApprovalRejectedError,
  ApprovalTimeoutError,
  ExecutionTimeoutError,
  ToolExecutionError,
  InvalidArgumentsError,
  DependencyError,
  ObservationTimeoutError,
  MaxIterationsError,
  LLMError,
  RateLimitError,
  AuthenticationError,
  ContextError,
  isAgentError,
  isRecoverable,
  wrapError,
  createTimeoutError,
} from './errors';
import type { PlanStep } from './types';

describe('errors', () => {
  const mockStep: PlanStep = {
    id: 'step-1',
    tool: 'split_clip',
    args: { clipId: 'clip-1', position: 5.0 },
    description: 'Split clip at 5 seconds',
    riskLevel: 'low',
    estimatedDuration: 100,
    dependsOn: [],
    optional: false,
  };

  describe('ConfigurationError', () => {
    it('should create error with message and field', () => {
      const error = new ConfigurationError('Invalid value', 'maxIterations');

      expect(error.message).toBe('Invalid value');
      expect(error.code).toBe('CONFIG_ERROR');
      expect(error.phase).toBe('idle');
      expect(error.recoverable).toBe(false);
      expect(error.invalidField).toBe('maxIterations');
    });

    it('should serialize to JSON', () => {
      const error = new ConfigurationError('Invalid', 'timeout');
      const json = error.toJSON();

      expect(json.code).toBe('CONFIG_ERROR');
      expect(json.invalidField).toBe('timeout');
    });
  });

  describe('SessionActiveError', () => {
    it('should include active session ID', () => {
      const error = new SessionActiveError('session-123');

      expect(error.message).toContain('session-123');
      expect(error.activeSessionId).toBe('session-123');
      expect(error.code).toBe('SESSION_ACTIVE');
    });
  });

  describe('SessionAbortedError', () => {
    it('should include reason and phase', () => {
      const error = new SessionAbortedError('User cancelled', 'executing');

      expect(error.message).toContain('User cancelled');
      expect(error.reason).toBe('User cancelled');
      expect(error.phase).toBe('executing');
      expect(error.recoverable).toBe(false);
    });
  });

  describe('ThinkingTimeoutError', () => {
    it('should include timeout duration', () => {
      const error = new ThinkingTimeoutError(30000);

      expect(error.message).toContain('30000ms');
      expect(error.timeoutMs).toBe(30000);
      expect(error.phase).toBe('thinking');
      expect(error.recoverable).toBe(true);
    });
  });

  describe('UnderstandingError', () => {
    it('should include message and details', () => {
      const error = new UnderstandingError('Failed to understand: Too ambiguous', 'additional details');

      expect(error.message).toBe('Failed to understand: Too ambiguous');
      expect(error.details).toBe('additional details');
      expect(error.recoverable).toBe(true);
    });

    it('should work without details', () => {
      const error = new UnderstandingError('Failed to understand input');

      expect(error.message).toBe('Failed to understand input');
      expect(error.details).toBeUndefined();
    });

    it('should accept object as details but not store it', () => {
      const error = new UnderstandingError('Failed to understand', { originalError: new Error('test') });

      expect(error.message).toBe('Failed to understand');
      expect(error.details).toBeUndefined();
    });
  });

  describe('PlanningTimeoutError', () => {
    it('should include timeout duration', () => {
      const error = new PlanningTimeoutError(30000);

      expect(error.timeoutMs).toBe(30000);
      expect(error.phase).toBe('planning');
    });
  });

  describe('PlanGenerationError', () => {
    it('should include reason', () => {
      const error = new PlanGenerationError('No tools available');

      expect(error.reason).toBe('No tools available');
      expect(error.recoverable).toBe(true);
    });
  });

  describe('PlanValidationError', () => {
    it('should include validation errors', () => {
      const errors = ['Missing tool', 'Invalid step order'];
      const error = new PlanValidationError('Plan validation failed', errors);

      expect(error.validationErrors).toEqual(errors);
      expect(error.message).toContain('Missing tool');
      expect(error.message).toContain('Plan validation failed');
    });
  });

  describe('ToolNotFoundError', () => {
    it('should include tool name', () => {
      const error = new ToolNotFoundError('unknown_tool');

      expect(error.toolName).toBe('unknown_tool');
      expect(error.recoverable).toBe(false);
    });
  });

  describe('ApprovalRejectedError', () => {
    it('should include plan ID', () => {
      const error = new ApprovalRejectedError('plan-123');

      expect(error.planId).toBe('plan-123');
      expect(error.reason).toBeUndefined();
    });

    it('should include reason when provided', () => {
      const error = new ApprovalRejectedError('plan-123', 'Too risky');

      expect(error.reason).toBe('Too risky');
      expect(error.message).toContain('Too risky');
    });
  });

  describe('ApprovalTimeoutError', () => {
    it('should include timeout', () => {
      const error = new ApprovalTimeoutError(60000);

      expect(error.timeoutMs).toBe(60000);
      expect(error.phase).toBe('awaiting_approval');
    });
  });

  describe('ExecutionTimeoutError', () => {
    it('should include step and timeout', () => {
      const error = new ExecutionTimeoutError(mockStep, 60000);

      expect(error.step).toBe(mockStep);
      expect(error.timeoutMs).toBe(60000);
      expect(error.phase).toBe('executing');
      expect(error.message).toContain(mockStep.tool);
    });
  });

  describe('ToolExecutionError', () => {
    it('should include step and error', () => {
      const error = new ToolExecutionError(mockStep, 'Clip not found');

      expect(error.step).toBe(mockStep);
      expect(error.toolError).toBe('Clip not found');
      expect(error.recoverable).toBe(true);
    });

    it('should allow specifying recoverability', () => {
      const error = new ToolExecutionError(mockStep, 'Fatal', false);

      expect(error.recoverable).toBe(false);
    });
  });

  describe('InvalidArgumentsError', () => {
    it('should include tool name and errors', () => {
      const errors = ['clipId is required', 'position must be positive'];
      const error = new InvalidArgumentsError('split_clip', errors);

      expect(error.toolName).toBe('split_clip');
      expect(error.validationErrors).toEqual(errors);
    });
  });

  describe('DependencyError', () => {
    it('should include step ID and missing dependencies', () => {
      const error = new DependencyError('step-3', ['step-1', 'step-2']);

      expect(error.stepId).toBe('step-3');
      expect(error.missingDependencies).toEqual(['step-1', 'step-2']);
      expect(error.recoverable).toBe(false);
    });
  });

  describe('ObservationTimeoutError', () => {
    it('should include timeout', () => {
      const error = new ObservationTimeoutError(15000);

      expect(error.timeoutMs).toBe(15000);
      expect(error.phase).toBe('observing');
    });
  });

  describe('MaxIterationsError', () => {
    it('should include max iterations and phase', () => {
      const error = new MaxIterationsError(20, 'executing');

      expect(error.maxIterations).toBe(20);
      expect(error.phase).toBe('executing');
      expect(error.recoverable).toBe(false);
    });
  });

  describe('LLMError', () => {
    it('should include provider and message', () => {
      const error = new LLMError('anthropic', 'Connection failed', 'thinking', 500);

      expect(error.provider).toBe('anthropic');
      expect(error.statusCode).toBe(500);
      expect(error.phase).toBe('thinking');
    });
  });

  describe('RateLimitError', () => {
    it('should extend LLMError', () => {
      const error = new RateLimitError('openai', 'planning', 60000);

      expect(error.provider).toBe('openai');
      expect(error.statusCode).toBe(429);
      expect(error.retryAfterMs).toBe(60000);
      expect(error.recoverable).toBe(true);
    });
  });

  describe('AuthenticationError', () => {
    it('should extend LLMError', () => {
      const error = new AuthenticationError('anthropic', 'thinking');

      expect(error.statusCode).toBe(401);
      expect(error.recoverable).toBe(false);
    });
  });

  describe('ContextError', () => {
    it('should include missing fields', () => {
      const error = new ContextError(['projectId', 'sequenceId'], 'thinking');

      expect(error.missingFields).toEqual(['projectId', 'sequenceId']);
      expect(error.phase).toBe('thinking');
    });
  });

  describe('isAgentError', () => {
    it('should return true for AgentError instances', () => {
      const error = new ThinkingTimeoutError(1000);
      expect(isAgentError(error)).toBe(true);
    });

    it('should return false for regular Error', () => {
      const error = new Error('Regular error');
      expect(isAgentError(error)).toBe(false);
    });

    it('should return false for non-errors', () => {
      expect(isAgentError('string')).toBe(false);
      expect(isAgentError(null)).toBe(false);
      expect(isAgentError(undefined)).toBe(false);
      expect(isAgentError({})).toBe(false);
    });
  });

  describe('isRecoverable', () => {
    it('should return true for recoverable errors', () => {
      expect(isRecoverable(new ThinkingTimeoutError(1000))).toBe(true);
      expect(isRecoverable(new ToolExecutionError(mockStep, 'error'))).toBe(true);
    });

    it('should return false for non-recoverable errors', () => {
      expect(isRecoverable(new ConfigurationError('msg', 'field'))).toBe(false);
      expect(isRecoverable(new ToolNotFoundError('tool'))).toBe(false);
    });

    it('should return false for non-AgentError', () => {
      expect(isRecoverable(new Error('regular'))).toBe(false);
      expect(isRecoverable('string')).toBe(false);
    });
  });

  describe('wrapError', () => {
    it('should return AgentError as-is', () => {
      const original = new ThinkingTimeoutError(1000);
      const wrapped = wrapError(original, 'thinking');

      expect(wrapped).toBe(original);
    });

    it('should wrap regular Error', () => {
      const original = new Error('Some error');
      const wrapped = wrapError(original, 'executing');

      expect(isAgentError(wrapped)).toBe(true);
      expect(wrapped.message).toContain('Some error');
    });

    it('should wrap string', () => {
      const wrapped = wrapError('String error', 'planning');

      expect(isAgentError(wrapped)).toBe(true);
      expect(wrapped.message).toContain('String error');
    });
  });

  describe('createTimeoutError', () => {
    it('should create ThinkingTimeoutError for thinking phase', () => {
      const error = createTimeoutError('thinking', 30000);

      expect(error).toBeInstanceOf(ThinkingTimeoutError);
      expect((error as ThinkingTimeoutError).timeoutMs).toBe(30000);
    });

    it('should create PlanningTimeoutError for planning phase', () => {
      const error = createTimeoutError('planning', 30000);

      expect(error).toBeInstanceOf(PlanningTimeoutError);
    });

    it('should create ObservationTimeoutError for observing phase', () => {
      const error = createTimeoutError('observing', 15000);

      expect(error).toBeInstanceOf(ObservationTimeoutError);
    });

    it('should create ExecutionTimeoutError for other phases', () => {
      const error = createTimeoutError('executing', 60000);

      expect(error).toBeInstanceOf(ExecutionTimeoutError);
    });
  });

  describe('toJSON', () => {
    it('should serialize all common properties', () => {
      const error = new ThinkingTimeoutError(30000);
      const json = error.toJSON();

      expect(json.name).toBe('ThinkingTimeoutError');
      expect(json.code).toBe('THINKING_TIMEOUT');
      expect(json.message).toBeDefined();
      expect(json.phase).toBe('thinking');
      expect(json.recoverable).toBe(true);
      expect(json.timestamp).toBeDefined();
      expect(typeof json.timestamp).toBe('number');
    });
  });
});
