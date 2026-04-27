import { beforeEach, describe, expect, it } from 'vitest';
import type { DelegationRecord } from '@/agents/engine/core/agentSession';
import { useAgentDelegationStore } from './agentDelegationStore';

function createDelegationRecord(overrides: Partial<DelegationRecord> = {}): DelegationRecord {
  return {
    id: 'delegation-1',
    parentSessionId: 'parent-session',
    childSessionId: 'child-session',
    parentRunId: 'run-1',
    agentProfileId: 'editor',
    delegatedGoal: 'Review pacing',
    contextPacketJson: '{}',
    allowedToolsDeltaJson: null,
    permissionSnapshotJson: null,
    status: 'requested',
    mergeStatus: 'pending',
    summaryMessageId: null,
    resultJson: null,
    errorMessage: null,
    createdAt: 100,
    updatedAt: 100,
    completedAt: null,
    ...overrides,
  };
}

describe('agentDelegationStore', () => {
  beforeEach(() => {
    useAgentDelegationStore.getState().clear();
  });

  it('should preserve loaded empty buckets when clearing related session records', () => {
    useAgentDelegationStore.setState({
      recordsBySessionId: {
        'sibling-session': [
          createDelegationRecord({
            id: 'delegation-to-delete',
            parentSessionId: 'sibling-session',
            childSessionId: 'deleted-session',
          }),
        ],
        'unrelated-session': [
          createDelegationRecord({
            id: 'unrelated-delegation',
            parentSessionId: 'unrelated-session',
            childSessionId: 'other-session',
          }),
        ],
        'deleted-session': [
          createDelegationRecord({
            id: 'deleted-bucket-record',
            parentSessionId: 'deleted-session',
            childSessionId: 'child-session',
          }),
        ],
      },
      isLoadingBySessionId: {
        'deleted-session': false,
        'sibling-session': false,
      },
      lastErrorBySessionId: {
        'deleted-session': null,
        'sibling-session': null,
      },
    });

    useAgentDelegationStore.getState().clearForSession('deleted-session');

    const state = useAgentDelegationStore.getState();
    expect(state.recordsBySessionId['deleted-session']).toBeUndefined();
    expect(state.recordsBySessionId['sibling-session']).toEqual([]);
    expect(state.recordsBySessionId['unrelated-session']).toHaveLength(1);
    expect(state.isLoadingBySessionId['deleted-session']).toBeUndefined();
    expect(state.lastErrorBySessionId['deleted-session']).toBeUndefined();
  });
});
