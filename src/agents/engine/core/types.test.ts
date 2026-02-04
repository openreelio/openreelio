/**
 * Agentic Engine Types Tests
 */

import { describe, it, expect } from 'vitest';
import {
  createInitialState,
  createEmptyContext,
  mergeConfig,
  requiresApproval,
  generateId,
  DEFAULT_ENGINE_CONFIG,
} from './types';

describe('types', () => {
  describe('createInitialState', () => {
    it('should create initial state with correct values', () => {
      const sessionId = 'test-session-123';
      const input = 'Split clip at 5 seconds';
      const context = createEmptyContext('project-1');
      const config = DEFAULT_ENGINE_CONFIG;

      const state = createInitialState(sessionId, input, context, config);

      expect(state.sessionId).toBe(sessionId);
      expect(state.phase).toBe('idle');
      expect(state.iteration).toBe(0);
      expect(state.maxIterations).toBe(config.maxIterations);
      expect(state.input).toBe(input);
      expect(state.context).toBe(context);
      expect(state.thought).toBeNull();
      expect(state.plan).toBeNull();
      expect(state.executionHistory).toEqual([]);
      expect(state.error).toBeNull();
      expect(state.startedAt).toBeLessThanOrEqual(Date.now());
      expect(state.completedAt).toBeNull();
    });

    it('should use config maxIterations', () => {
      const context = createEmptyContext('project-1');
      const config = { ...DEFAULT_ENGINE_CONFIG, maxIterations: 50 };

      const state = createInitialState('session', 'input', context, config);

      expect(state.maxIterations).toBe(50);
    });
  });

  describe('createEmptyContext', () => {
    it('should create empty context with project ID', () => {
      const projectId = 'project-123';

      const context = createEmptyContext(projectId);

      expect(context.projectId).toBe(projectId);
      expect(context.playheadPosition).toBe(0);
      expect(context.timelineDuration).toBe(0);
      expect(context.selectedClips).toEqual([]);
      expect(context.selectedTracks).toEqual([]);
      expect(context.availableAssets).toEqual([]);
      expect(context.availableTracks).toEqual([]);
      expect(context.availableTools).toEqual([]);
      expect(context.recentOperations).toEqual([]);
      expect(context.userPreferences).toEqual({});
      expect(context.corrections).toEqual([]);
    });
  });

  describe('mergeConfig', () => {
    it('should return default config when no partial provided', () => {
      const config = mergeConfig();

      expect(config).toEqual(DEFAULT_ENGINE_CONFIG);
    });

    it('should return default config when empty partial provided', () => {
      const config = mergeConfig({});

      expect(config).toEqual(DEFAULT_ENGINE_CONFIG);
    });

    it('should override specific values', () => {
      const partial = {
        maxIterations: 50,
        enableStreaming: false,
      };

      const config = mergeConfig(partial);

      expect(config.maxIterations).toBe(50);
      expect(config.enableStreaming).toBe(false);
      expect(config.thinkingTimeout).toBe(DEFAULT_ENGINE_CONFIG.thinkingTimeout);
    });

    it('should not mutate default config', () => {
      const originalMaxIterations = DEFAULT_ENGINE_CONFIG.maxIterations;

      mergeConfig({ maxIterations: 100 });

      expect(DEFAULT_ENGINE_CONFIG.maxIterations).toBe(originalMaxIterations);
    });
  });

  describe('requiresApproval', () => {
    it('should return true when risk equals threshold', () => {
      expect(requiresApproval('high', 'high')).toBe(true);
    });

    it('should return true when risk exceeds threshold', () => {
      expect(requiresApproval('critical', 'high')).toBe(true);
      expect(requiresApproval('high', 'medium')).toBe(true);
      expect(requiresApproval('medium', 'low')).toBe(true);
    });

    it('should return false when risk below threshold', () => {
      expect(requiresApproval('low', 'high')).toBe(false);
      expect(requiresApproval('medium', 'high')).toBe(false);
      expect(requiresApproval('low', 'medium')).toBe(false);
    });

    it('should handle all risk level combinations', () => {
      // Low threshold - everything needs approval
      expect(requiresApproval('low', 'low')).toBe(true);
      expect(requiresApproval('medium', 'low')).toBe(true);
      expect(requiresApproval('high', 'low')).toBe(true);
      expect(requiresApproval('critical', 'low')).toBe(true);

      // Critical threshold - only critical needs approval
      expect(requiresApproval('low', 'critical')).toBe(false);
      expect(requiresApproval('medium', 'critical')).toBe(false);
      expect(requiresApproval('high', 'critical')).toBe(false);
      expect(requiresApproval('critical', 'critical')).toBe(true);
    });
  });

  describe('generateId', () => {
    it('should generate unique IDs', () => {
      const id1 = generateId();
      const id2 = generateId();

      expect(id1).not.toBe(id2);
    });

    it('should generate UUID format', () => {
      const id = generateId();
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

      expect(id).toMatch(uuidRegex);
    });

    it('should include prefix when provided', () => {
      const id = generateId('step');

      expect(id.startsWith('step_')).toBe(true);
    });

    it('should generate unique IDs with prefix', () => {
      const id1 = generateId('plan');
      const id2 = generateId('plan');

      expect(id1).not.toBe(id2);
      expect(id1.startsWith('plan_')).toBe(true);
      expect(id2.startsWith('plan_')).toBe(true);
    });
  });

  describe('DEFAULT_ENGINE_CONFIG', () => {
    it('should have sensible default values', () => {
      expect(DEFAULT_ENGINE_CONFIG.maxIterations).toBe(20);
      expect(DEFAULT_ENGINE_CONFIG.thinkingTimeout).toBe(30000);
      expect(DEFAULT_ENGINE_CONFIG.planningTimeout).toBe(30000);
      expect(DEFAULT_ENGINE_CONFIG.executionTimeout).toBe(60000);
      expect(DEFAULT_ENGINE_CONFIG.observationTimeout).toBe(15000);
      expect(DEFAULT_ENGINE_CONFIG.enableStreaming).toBe(true);
      expect(DEFAULT_ENGINE_CONFIG.enableMemory).toBe(true);
      expect(DEFAULT_ENGINE_CONFIG.enableCheckpoints).toBe(true);
      expect(DEFAULT_ENGINE_CONFIG.approvalThreshold).toBe('high');
      expect(DEFAULT_ENGINE_CONFIG.autoRetryOnFailure).toBe(true);
      expect(DEFAULT_ENGINE_CONFIG.maxRetries).toBe(2);
    });
  });
});
