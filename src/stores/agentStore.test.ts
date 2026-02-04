/**
 * Agent Store Tests
 *
 * Tests for the Zustand store managing agent session state.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { useAgentStore, type SessionSummary } from './agentStore';

describe('agentStore', () => {
  beforeEach(() => {
    useAgentStore.getState().reset();
  });

  describe('initial state', () => {
    it('should have correct initial state', () => {
      const state = useAgentStore.getState();

      expect(state.currentSession).toBeNull();
      expect(state.history).toEqual([]);
      expect(state.preferences).toBeDefined();
      expect(state.preferences.autoApproveRiskLevel).toBe('low');
    });
  });

  describe('startSession', () => {
    it('should start a new session', () => {
      const state = useAgentStore.getState();

      state.startSession('Test input', 'test-project');

      const updated = useAgentStore.getState();
      expect(updated.currentSession).not.toBeNull();
      expect(updated.currentSession?.input).toBe('Test input');
      expect(updated.currentSession?.projectId).toBe('test-project');
      expect(updated.currentSession?.status).toBe('running');
    });

    it('should generate unique session IDs', () => {
      const state = useAgentStore.getState();

      state.startSession('Input 1', 'project-1');
      const session1 = useAgentStore.getState().currentSession;

      state.endSession();
      state.startSession('Input 2', 'project-2');
      const session2 = useAgentStore.getState().currentSession;

      expect(session1?.id).not.toBe(session2?.id);
    });
  });

  describe('updateSession', () => {
    it('should update current session', () => {
      const state = useAgentStore.getState();

      state.startSession('Test input', 'test-project');
      state.updateSession({
        phase: 'planning',
        status: 'running',
      });

      const updated = useAgentStore.getState();
      expect(updated.currentSession?.phase).toBe('planning');
    });

    it('should not update if no current session', () => {
      const state = useAgentStore.getState();

      state.updateSession({ phase: 'planning' });

      expect(useAgentStore.getState().currentSession).toBeNull();
    });
  });

  describe('endSession', () => {
    it('should end session and add to history', () => {
      const state = useAgentStore.getState();

      state.startSession('Test input', 'test-project');
      state.endSession('completed');

      const updated = useAgentStore.getState();
      expect(updated.currentSession).toBeNull();
      expect(updated.history).toHaveLength(1);
      expect(updated.history[0].input).toBe('Test input');
      expect(updated.history[0].status).toBe('completed');
    });

    it('should include error in summary when failed', () => {
      const state = useAgentStore.getState();

      state.startSession('Test input', 'test-project');
      state.endSession('failed', 'Test error');

      const updated = useAgentStore.getState();
      expect(updated.history[0].status).toBe('failed');
      expect(updated.history[0].error).toBe('Test error');
    });
  });

  describe('addToHistory', () => {
    it('should add summary to history', () => {
      const state = useAgentStore.getState();

      const summary: SessionSummary = {
        id: 'test-id',
        input: 'Test input',
        projectId: 'test-project',
        status: 'completed',
        startedAt: Date.now(),
        completedAt: Date.now(),
        toolsUsed: ['split_clip'],
        eventsCount: 10,
      };

      state.addToHistory(summary);

      const updated = useAgentStore.getState();
      expect(updated.history).toHaveLength(1);
      expect(updated.history[0].id).toBe('test-id');
    });

    it('should maintain max history size', () => {
      const state = useAgentStore.getState();

      // Add more than max
      for (let i = 0; i < 60; i++) {
        state.addToHistory({
          id: `id-${i}`,
          input: `Input ${i}`,
          projectId: 'test',
          status: 'completed',
          startedAt: Date.now(),
          completedAt: Date.now(),
          toolsUsed: [],
          eventsCount: 0,
        });
      }

      const updated = useAgentStore.getState();
      expect(updated.history.length).toBeLessThanOrEqual(50);
    });
  });

  describe('clearHistory', () => {
    it('should clear all history', () => {
      const state = useAgentStore.getState();

      state.addToHistory({
        id: 'test-id',
        input: 'Test',
        projectId: 'test',
        status: 'completed',
        startedAt: Date.now(),
        completedAt: Date.now(),
        toolsUsed: [],
        eventsCount: 0,
      });

      state.clearHistory();

      expect(useAgentStore.getState().history).toEqual([]);
    });
  });

  describe('preferences', () => {
    it('should update preferences', () => {
      const state = useAgentStore.getState();

      state.updatePreferences({
        autoApproveRiskLevel: 'medium',
        showThinkingProcess: false,
      });

      const updated = useAgentStore.getState();
      expect(updated.preferences.autoApproveRiskLevel).toBe('medium');
      expect(updated.preferences.showThinkingProcess).toBe(false);
    });

    it('should merge with existing preferences', () => {
      const state = useAgentStore.getState();

      state.updatePreferences({ autoApproveRiskLevel: 'medium' });
      state.updatePreferences({ showThinkingProcess: false });

      const updated = useAgentStore.getState();
      expect(updated.preferences.autoApproveRiskLevel).toBe('medium');
      expect(updated.preferences.showThinkingProcess).toBe(false);
    });
  });

  describe('reset', () => {
    it('should reset all state', () => {
      const state = useAgentStore.getState();

      state.startSession('Test', 'project');
      state.addToHistory({
        id: 'test-id',
        input: 'Test',
        projectId: 'test',
        status: 'completed',
        startedAt: Date.now(),
        completedAt: Date.now(),
        toolsUsed: [],
        eventsCount: 0,
      });
      state.updatePreferences({ autoApproveRiskLevel: 'high' });

      state.reset();

      const updated = useAgentStore.getState();
      expect(updated.currentSession).toBeNull();
      expect(updated.history).toEqual([]);
      expect(updated.preferences.autoApproveRiskLevel).toBe('low');
    });
  });

  describe('selectors', () => {
    it('should get session by ID from history', () => {
      const state = useAgentStore.getState();

      state.addToHistory({
        id: 'target-id',
        input: 'Target input',
        projectId: 'test',
        status: 'completed',
        startedAt: Date.now(),
        completedAt: Date.now(),
        toolsUsed: [],
        eventsCount: 0,
      });

      const session = state.getSessionById('target-id');
      expect(session?.input).toBe('Target input');
    });

    it('should get history by project', () => {
      const state = useAgentStore.getState();

      state.addToHistory({
        id: 'id-1',
        input: 'Input 1',
        projectId: 'project-A',
        status: 'completed',
        startedAt: Date.now(),
        completedAt: Date.now(),
        toolsUsed: [],
        eventsCount: 0,
      });

      state.addToHistory({
        id: 'id-2',
        input: 'Input 2',
        projectId: 'project-B',
        status: 'completed',
        startedAt: Date.now(),
        completedAt: Date.now(),
        toolsUsed: [],
        eventsCount: 0,
      });

      const projectAHistory = state.getHistoryByProject('project-A');
      expect(projectAHistory).toHaveLength(1);
      expect(projectAHistory[0].projectId).toBe('project-A');
    });
  });
});
