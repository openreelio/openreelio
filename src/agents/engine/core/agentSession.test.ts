import { describe, expect, it } from 'vitest';

import {
  createAgentRun,
  createAgentSession,
} from './agentSession';

describe('agentSession', () => {
  it('should create a root session with safe defaults', () => {
    const session = createAgentSession({
      id: 'session-1',
      projectId: 'project-1',
      now: 123,
    });

    expect(session.id).toBe('session-1');
    expect(session.projectId).toBe('project-1');
    expect(session.runtimeKind).toBe('tpao');
    expect(session.agentProfileId).toBe('editor');
    expect(session.sessionMode).toBe('primary');
    expect(session.lineage).toEqual({
      parentSessionId: null,
      branchFromSessionId: null,
      rootSessionId: 'session-1',
    });
    expect(session.createdAt).toBe(123);
    expect(session.updatedAt).toBe(123);
  });

  it('should require an explicit root session id for child sessions', () => {
    expect(() =>
      createAgentSession({
        id: 'child-1',
        projectId: 'project-1',
        parentSessionId: 'parent-1',
      }),
    ).toThrowError('rootSessionId is required when creating a child or branch session');
  });

  it('should create a child session when root session id is provided', () => {
    const session = createAgentSession({
      id: 'child-1',
      projectId: 'project-1',
      sessionMode: 'child',
      parentSessionId: 'parent-1',
      rootSessionId: 'root-1',
      now: 456,
    });

    expect(session.sessionMode).toBe('child');
    expect(session.lineage).toEqual({
      parentSessionId: 'parent-1',
      branchFromSessionId: null,
      rootSessionId: 'root-1',
    });
    expect(session.createdAt).toBe(456);
  });

  it('should create a run shell with safe defaults', () => {
    const run = createAgentRun({
      id: 'run-1',
      sessionId: 'session-1',
      now: 789,
    });

    expect(run.id).toBe('run-1');
    expect(run.sessionId).toBe('session-1');
    expect(run.phase).toBe('initializing');
    expect(run.runtimeKind).toBe('tpao');
    expect(run.trigger).toBe('user');
    expect(run.maxIterations).toBe(20);
    expect(run.maxToolCalls).toBe(50);
    expect(run.startedAt).toBe(789);
    expect(run.updatedAt).toBe(789);
  });
});
