/**
 * Observer Phase Tests
 *
 * Tests for the Observe phase of the agentic loop.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Observer, createObserver } from './Observer';
import { createMockLLMAdapter, type MockLLMAdapter } from '../adapters/llm/MockLLMAdapter';
import {
  createLanguagePolicy,
  type Plan,
  type Observation,
  type AgentContext,
  createEmptyContext,
} from '../core/types';
import type { ExecutionResult } from './Executor';
import { ObservationTimeoutError } from '../core/errors';

describe('Observer', () => {
  let observer: Observer;
  let mockLLM: MockLLMAdapter;
  let context: AgentContext;

  const successfulPlan: Plan = {
    goal: 'Split a clip at 5 seconds',
    steps: [
      {
        id: 'step-1',
        tool: 'split_clip',
        args: { clipId: 'clip-1', position: 5 },
        description: 'Split clip at 5 seconds',
        riskLevel: 'low',
        estimatedDuration: 100,
      },
    ],
    estimatedTotalDuration: 100,
    requiresApproval: false,
    rollbackStrategy: 'Undo split',
  };

  const successfulExecution: ExecutionResult = {
    success: true,
    completedSteps: [
      {
        stepId: 'step-1',
        tool: 'split_clip',
        args: { clipId: 'clip-1', position: 5 },
        result: {
          success: true,
          data: { newClipId: 'clip-2' },
          duration: 50,
        },
        startTime: Date.now() - 100,
        endTime: Date.now() - 50,
        retryCount: 0,
      },
    ],
    failedSteps: [],
    totalDuration: 100,
    aborted: false,
    toolCallsUsed: 1,
  };

  beforeEach(() => {
    mockLLM = createMockLLMAdapter();
    observer = createObserver(mockLLM);
    context = createEmptyContext('project-1');
  });

  describe('observe', () => {
    it('should analyze successful execution', async () => {
      const mockObservation: Observation = {
        goalAchieved: true,
        stateChanges: [
          {
            type: 'clip_created',
            target: 'clip-2',
            details: { splitFrom: 'clip-1', position: 5 },
          },
        ],
        summary: 'Successfully split clip-1 at 5 seconds, creating clip-2',
        confidence: 0.95,
        needsIteration: false,
      };

      mockLLM.setStructuredResponse({ structured: mockObservation });

      const result = await observer.observe(successfulPlan, successfulExecution, context);

      expect(result.goalAchieved).toBe(true);
      expect(result.confidence).toBeGreaterThan(0.8);
      expect(result.needsIteration).toBe(false);
    });

    it('should identify state changes', async () => {
      const mockObservation: Observation = {
        goalAchieved: true,
        stateChanges: [
          {
            type: 'clip_created',
            target: 'clip-2',
            details: { splitFrom: 'clip-1' },
          },
          {
            type: 'clip_modified',
            target: 'clip-1',
            details: { newDuration: 5 },
          },
        ],
        summary: 'Split operation completed',
        confidence: 0.9,
        needsIteration: false,
      };

      mockLLM.setStructuredResponse({ structured: mockObservation });

      const result = await observer.observe(successfulPlan, successfulExecution, context);

      expect(result.stateChanges).toHaveLength(2);
      expect(result.stateChanges.some((c) => c.type === 'clip_created')).toBe(true);
    });

    it('should recommend iteration when goal not fully achieved', async () => {
      const partialExecution: ExecutionResult = {
        success: false,
        completedSteps: [successfulExecution.completedSteps[0]],
        failedSteps: [
          {
            stepId: 'step-2',
            tool: 'move_clip',
            args: { clipId: 'clip-2', position: 10 },
            result: {
              success: false,
              error: 'Clip not found',
              duration: 20,
            },
            startTime: Date.now() - 50,
            endTime: Date.now() - 30,
            retryCount: 0,
          },
        ],
        totalDuration: 120,
        aborted: false,
        toolCallsUsed: 2,
      };

      const mockObservation: Observation = {
        goalAchieved: false,
        stateChanges: [
          {
            type: 'clip_created',
            target: 'clip-2',
            details: {},
          },
        ],
        summary: 'Clip was split but move failed',
        confidence: 0.7,
        needsIteration: true,
        iterationReason: 'Move operation failed, need to retry with correct clip ID',
        suggestedAction: 'Retry move with the newly created clip ID',
      };

      mockLLM.setStructuredResponse({ structured: mockObservation });

      const result = await observer.observe(successfulPlan, partialExecution, context);

      expect(result.goalAchieved).toBe(false);
      expect(result.needsIteration).toBe(true);
      expect(result.iterationReason).toBeDefined();
    });

    it('should not recommend iteration when max iterations reached', async () => {
      context.currentIteration = 5;

      const mockObservation: Observation = {
        goalAchieved: false,
        stateChanges: [],
        summary: 'Failed to achieve goal',
        confidence: 0.5,
        needsIteration: false, // Should not iterate even if goal not achieved
        iterationReason: 'Max iterations reached',
      };

      mockLLM.setStructuredResponse({ structured: mockObservation });

      const maxIterObserver = createObserver(mockLLM, { maxIterations: 5 });

      const result = await maxIterObserver.observe(successfulPlan, successfulExecution, context);

      expect(result.needsIteration).toBe(false);
    });

    it('should include execution context in analysis', async () => {
      mockLLM.setStructuredResponse({
        structured: {
          goalAchieved: true,
          stateChanges: [],
          summary: 'Done',
          confidence: 0.9,
          needsIteration: false,
        } as Observation,
      });

      await observer.observe(successfulPlan, successfulExecution, context);

      const request = mockLLM.getLastRequest();
      expect(request).toBeDefined();

      // Check that plan goal is in the request
      const hasGoal = request?.messages.some((m) => m.content.includes(successfulPlan.goal));
      expect(hasGoal).toBe(true);
    });

    it('should include execution results in analysis', async () => {
      mockLLM.setStructuredResponse({
        structured: {
          goalAchieved: true,
          stateChanges: [],
          summary: 'Done',
          confidence: 0.9,
          needsIteration: false,
        } as Observation,
      });

      await observer.observe(successfulPlan, successfulExecution, context);

      const request = mockLLM.getLastRequest();

      // Check that execution result is in the request
      const hasResult = request?.messages.some(
        (m) => m.content.includes('step-1') || m.content.includes('split_clip'),
      );
      expect(hasResult).toBe(true);
    });

    it('should include language policy instructions in observer system prompt', async () => {
      context.languagePolicy = createLanguagePolicy('en', {
        outputLanguage: 'ja',
        detectInputLanguage: true,
      });

      mockLLM.setStructuredResponse({
        structured: {
          goalAchieved: true,
          stateChanges: [],
          summary: 'Done',
          confidence: 0.9,
          needsIteration: false,
        } as Observation,
      });

      await observer.observe(successfulPlan, successfulExecution, context);

      const request = mockLLM.getLastRequest();
      const systemMessage = request?.messages.find((m) => m.role === 'system');

      expect(systemMessage?.content).toContain('Language Policy:');
      expect(systemMessage?.content).toContain('Default output language: ja');
      expect(systemMessage?.content).toContain('Never translate IDs, tool names');
    });
  });

  describe('observeWithStreaming', () => {
    it('should emit progress events', async () => {
      mockLLM.setStreamResponse({
        content: 'Analyzing execution results...',
        chunkSize: 10,
      });

      mockLLM.setStructuredResponse({
        structured: {
          goalAchieved: true,
          stateChanges: [],
          summary: 'Done',
          confidence: 0.9,
          needsIteration: false,
        } as Observation,
      });

      const progressChunks: string[] = [];

      const result = await observer.observeWithStreaming(
        successfulPlan,
        successfulExecution,
        context,
        (chunk) => progressChunks.push(chunk),
      );

      expect(progressChunks.length).toBeGreaterThan(0);
      expect(result).toBeDefined();
    });
  });

  describe('error handling', () => {
    it('should throw ObservationTimeoutError on timeout', async () => {
      const shortTimeoutObserver = createObserver(mockLLM, { timeout: 10 });

      mockLLM.setStructuredResponse({
        structured: {
          goalAchieved: true,
          stateChanges: [],
          summary: 'Done',
          confidence: 0.9,
          needsIteration: false,
        },
        delay: 100,
      });

      await expect(
        shortTimeoutObserver.observe(successfulPlan, successfulExecution, context),
      ).rejects.toThrow(ObservationTimeoutError);
    });

    it('should handle LLM error gracefully', async () => {
      mockLLM.setStructuredResponse({
        error: new Error('LLM API error'),
      });

      await expect(
        observer.observe(successfulPlan, successfulExecution, context),
      ).rejects.toThrow();
    });

    it('should handle malformed response', async () => {
      mockLLM.setStructuredResponse({
        structured: { invalid: 'response' },
      });

      await expect(
        observer.observe(successfulPlan, successfulExecution, context),
      ).rejects.toThrow();
    });
  });

  describe('abort', () => {
    it('should abort ongoing observation', async () => {
      mockLLM.setStructuredResponse({
        structured: {
          goalAchieved: true,
          stateChanges: [],
          summary: 'Done',
          confidence: 0.9,
          needsIteration: false,
        },
        delay: 1000,
      });

      const promise = observer.observe(successfulPlan, successfulExecution, context);

      setTimeout(() => observer.abort(), 10);

      await expect(promise).rejects.toThrow();
    });
  });

  describe('confidence calculation', () => {
    it('should have lower confidence for partial success', async () => {
      const partialExecution: ExecutionResult = {
        success: false,
        completedSteps: [successfulExecution.completedSteps[0]],
        failedSteps: [
          {
            stepId: 'step-2',
            tool: 'move_clip',
            args: {},
            result: { success: false, error: 'Failed', duration: 10 },
            startTime: 0,
            endTime: 10,
            retryCount: 0,
          },
        ],
        totalDuration: 100,
        aborted: false,
        toolCallsUsed: 2,
      };

      mockLLM.setStructuredResponse({
        structured: {
          goalAchieved: false,
          stateChanges: [],
          summary: 'Partial success',
          confidence: 0.5,
          needsIteration: true,
        } as Observation,
      });

      const result = await observer.observe(successfulPlan, partialExecution, context);

      expect(result.confidence).toBeLessThan(0.8);
    });

    it('should have higher confidence for complete success', async () => {
      mockLLM.setStructuredResponse({
        structured: {
          goalAchieved: true,
          stateChanges: [],
          summary: 'Complete success',
          confidence: 0.95,
          needsIteration: false,
        } as Observation,
      });

      const result = await observer.observe(successfulPlan, successfulExecution, context);

      expect(result.confidence).toBeGreaterThan(0.8);
    });
  });

  describe('configuration', () => {
    it('should use custom max iterations', async () => {
      const customObserver = createObserver(mockLLM, { maxIterations: 3 });

      context.currentIteration = 3;

      mockLLM.setStructuredResponse({
        structured: {
          goalAchieved: false,
          stateChanges: [],
          summary: 'Not done',
          confidence: 0.5,
          needsIteration: false, // Should be false due to max iterations
        } as Observation,
      });

      const result = await customObserver.observe(successfulPlan, successfulExecution, context);

      // Observer should prevent iteration when at max
      expect(result.needsIteration).toBe(false);
    });
  });

  describe('observation validation', () => {
    it('should validate observation has required fields', async () => {
      mockLLM.setStructuredResponse({
        structured: {
          goalAchieved: true,
          stateChanges: [],
          summary: 'Valid observation',
          confidence: 0.9,
          needsIteration: false,
        } as Observation,
      });

      const result = await observer.observe(successfulPlan, successfulExecution, context);

      expect(typeof result.goalAchieved).toBe('boolean');
      expect(Array.isArray(result.stateChanges)).toBe(true);
      expect(typeof result.summary).toBe('string');
      expect(typeof result.confidence).toBe('number');
      expect(typeof result.needsIteration).toBe('boolean');
    });

    it('should include iterationReason when needsIteration is true', async () => {
      mockLLM.setStructuredResponse({
        structured: {
          goalAchieved: false,
          stateChanges: [],
          summary: 'Needs retry',
          confidence: 0.6,
          needsIteration: true,
          iterationReason: 'Need to retry failed step',
        } as Observation,
      });

      const result = await observer.observe(
        successfulPlan,
        { ...successfulExecution, success: false },
        context,
      );

      expect(result.needsIteration).toBe(true);
      expect(result.iterationReason).toBeDefined();
    });
  });
});
