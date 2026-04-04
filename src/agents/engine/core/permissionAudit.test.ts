import { beforeEach, describe, expect, it, vi } from 'vitest';

const { recordPermissionDecision, listPermissionDecisions, warn } = vi.hoisted(() => ({
  recordPermissionDecision: vi.fn(),
  listPermissionDecisions: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('./agentSessionBackend', () => ({
  createAgentSessionBackend: () => ({
    recordPermissionDecision,
    listPermissionDecisions,
  }),
}));

vi.mock('@/services/logger', () => ({
  createLogger: () => ({
    warn,
  }),
}));

import {
  buildPermissionTraceRecord,
  hydratePersistedPermissionRules,
  persistPermissionAudit,
} from './permissionAudit';
import { usePermissionStore } from '@/stores/permissionStore';

describe('permissionAudit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    recordPermissionDecision.mockResolvedValue({});
    listPermissionDecisions.mockResolvedValue([]);
    usePermissionStore.getState().loadDefaults();
  });

  it('should skip persistence when session id is missing', () => {
    persistPermissionAudit(
      null,
      null,
      'step-1',
      {
        subjectType: 'capability',
        subject: 'timeline.clip.split',
        matchedPattern: 'timeline.clip.split',
        matchedScope: 'global',
        source: 'global_policy',
      },
      'allow',
    );

    expect(recordPermissionDecision).not.toHaveBeenCalled();
  });

  it('should persist automatic decisions with rule-derived reasons', () => {
    persistPermissionAudit(
      'session-1',
      'run-1',
      'step-1',
      {
        subjectType: 'capability',
        subject: 'timeline.clip.delete',
        matchedPattern: 'timeline.clip.delete',
        matchedScope: 'global',
        source: 'global_policy',
      },
      'deny',
    );

    expect(recordPermissionDecision).toHaveBeenCalledWith({
      sessionId: 'session-1',
      runId: 'run-1',
      stepId: 'step-1',
      subjectType: 'capability',
      subject: 'timeline.clip.delete',
      action: 'deny',
      source: 'global_policy',
      reason: 'Resolved automatically as deny by global:timeline.clip.delete',
    });
  });

  it('should persist interactive approval reasons when a human resolves the prompt', () => {
    persistPermissionAudit(
      'session-1',
      'run-2',
      'step-2',
      {
        subjectType: 'resource',
        subject: 'timeline.clip.delete#clip:clip-7',
        matchedPattern: 'timeline.clip.delete',
        matchedScope: 'session',
        source: 'session_rule',
      },
      'allow_always',
      'interactive_approval',
    );

    expect(recordPermissionDecision).toHaveBeenCalledWith({
      sessionId: 'session-1',
      runId: 'run-2',
      stepId: 'step-2',
      subjectType: 'resource',
      subject: 'timeline.clip.delete#clip:clip-7',
      action: 'allow_always',
      source: 'interactive_approval',
      reason: 'Resolved interactively as allow_always for timeline.clip.delete#clip:clip-7',
    });
  });

  it('should warn when persistence fails', async () => {
    recordPermissionDecision.mockRejectedValueOnce(new Error('db down'));

    persistPermissionAudit(
      'session-1',
      'run-3',
      'step-3',
      {
        subjectType: 'capability',
        subject: 'timeline.clip.trim',
        matchedPattern: null,
        matchedScope: null,
        source: 'builtin',
      },
      'ask',
    );

    await Promise.resolve();
    await Promise.resolve();

    expect(warn).toHaveBeenCalledWith('Failed to persist permission decision', {
      sessionId: 'session-1',
      stepId: 'step-3',
      subject: 'timeline.clip.trim',
      action: 'ask',
      error: 'db down',
    });
  });

  it('should build normalized permission trace records', () => {
    expect(buildPermissionTraceRecord({
      runId: 'run-1',
      stepId: 'step-1',
      resolution: {
        subjectType: 'resource',
        subject: 'timeline.clip.delete#clip:clip-7',
        matchedPattern: 'timeline.clip.delete',
        matchedScope: 'session',
        source: 'session_rule',
      },
      action: 'allow_always',
      source: 'interactive_approval',
      recordedAt: 25,
    })).toEqual({
      decisionId: null,
      runId: 'run-1',
      stepId: 'step-1',
      subjectType: 'resource',
      subject: 'timeline.clip.delete#clip:clip-7',
      action: 'allow_always',
      source: 'interactive_approval',
      reason: 'Resolved interactively as allow_always for timeline.clip.delete#clip:clip-7',
      recordedAt: 25,
    });
  });

  it('hydrates persisted allow_always decisions back into session rules', async () => {
    listPermissionDecisions.mockResolvedValueOnce([
      {
        id: 'decision-1',
        sessionId: 'session-1',
        runId: 'run-1',
        stepId: 'step-1',
        subjectType: 'resource',
        subject: 'timeline.clip.delete#clip:clip-7',
        action: 'allow_always',
        source: 'interactive_approval',
        reason: null,
        createdAt: 10,
      },
      {
        id: 'decision-2',
        sessionId: 'session-1',
        runId: 'run-1',
        stepId: 'step-2',
        subjectType: 'capability',
        subject: 'timeline.clip.trim',
        action: 'deny',
        source: 'interactive_approval',
        reason: null,
        createdAt: 11,
      },
    ]);

    await hydratePersistedPermissionRules('session-1');

    expect(usePermissionStore.getState().sessionRules).toEqual([
      {
        id: 'decision-1',
        pattern: 'timeline.clip.delete#clip:clip-7',
        permission: 'allow',
        scope: 'session',
      },
    ]);
  });

  it('skips rehydration when the session has already been hydrated once', async () => {
    listPermissionDecisions.mockResolvedValueOnce([
      {
        id: 'decision-1',
        sessionId: 'session-1',
        runId: 'run-1',
        stepId: 'step-1',
        subjectType: 'resource',
        subject: 'timeline.clip.delete#clip:clip-7',
        action: 'allow_always',
        source: 'interactive_approval',
        reason: null,
        createdAt: 10,
      },
    ]);

    await hydratePersistedPermissionRules('session-1');
    await hydratePersistedPermissionRules('session-1');

    expect(listPermissionDecisions).toHaveBeenCalledTimes(1);
  });
});
