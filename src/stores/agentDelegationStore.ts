import { create } from 'zustand';
import { createAgentSessionBackend, type AgentSession } from '@/agents/engine';
import type { DelegationRecord } from '@/agents/engine/core/agentSession';

const backend = createAgentSessionBackend();

function sortDelegations(records: DelegationRecord[]): DelegationRecord[] {
  return [...records].sort((left, right) => right.createdAt - left.createdAt);
}

function upsertDelegationRecord(
  records: DelegationRecord[],
  nextRecord: DelegationRecord,
): DelegationRecord[] {
  return sortDelegations([nextRecord, ...records.filter((record) => record.id !== nextRecord.id)]);
}

export interface CreateDelegatedSessionInput {
  parentSessionId: string;
  parentRunId: string | null;
  projectId: string;
  sequenceId?: string | null;
  agentProfileId: string;
  title: string;
  delegatedGoal: string;
  modelProvider?: string | null;
  modelId?: string | null;
  contextPacketJson?: string;
}

interface AgentDelegationStore {
  recordsBySessionId: Record<string, DelegationRecord[]>;
  isLoadingBySessionId: Record<string, boolean>;
  lastErrorBySessionId: Record<string, string | null>;
  loadDelegations: (sessionId: string) => Promise<DelegationRecord[]>;
  createDelegatedSession: (input: CreateDelegatedSessionInput) => Promise<{
    childSession: AgentSession;
    delegationRecord: DelegationRecord | null;
    delegationErrorMessage: string | null;
  }>;
  updateDelegationRecord: (input: {
    id: string;
    status?: DelegationRecord['status'];
    mergeStatus?: DelegationRecord['mergeStatus'];
    summaryMessageId?: string | null;
    resultJson?: string | null;
    errorMessage?: string | null;
    completedAt?: number | null;
  }) => Promise<DelegationRecord>;
  clearForSession: (sessionId: string) => void;
  clear: () => void;
}

export const useAgentDelegationStore = create<AgentDelegationStore>((set) => ({
  recordsBySessionId: {},
  isLoadingBySessionId: {},
  lastErrorBySessionId: {},

  loadDelegations: async (sessionId) => {
    set((state) => ({
      isLoadingBySessionId: { ...state.isLoadingBySessionId, [sessionId]: true },
      lastErrorBySessionId: { ...state.lastErrorBySessionId, [sessionId]: null },
    }));

    try {
      const records = sortDelegations(await backend.listDelegationRecords(sessionId));
      set((state) => ({
        recordsBySessionId: { ...state.recordsBySessionId, [sessionId]: records },
        isLoadingBySessionId: { ...state.isLoadingBySessionId, [sessionId]: false },
      }));
      return records;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set((state) => ({
        isLoadingBySessionId: { ...state.isLoadingBySessionId, [sessionId]: false },
        lastErrorBySessionId: { ...state.lastErrorBySessionId, [sessionId]: message },
      }));
      throw error;
    }
  },

  createDelegatedSession: async (input) => {
    const childSession = await backend.createSession({
      projectId: input.projectId,
      sequenceId: input.sequenceId ?? null,
      title: input.title,
      runtimeKind: 'subagent',
      agentProfileId: input.agentProfileId,
      sessionMode: 'child',
      parentSessionId: input.parentSessionId,
      modelProvider: input.modelProvider ?? null,
      modelId: input.modelId ?? null,
    });

    if (!input.parentRunId) {
      return {
        childSession,
        delegationRecord: null,
        delegationErrorMessage: 'Parent session has no persisted run yet.',
      };
    }

    try {
      const delegationRecord = await backend.createDelegationRecord({
        parentSessionId: input.parentSessionId,
        childSessionId: childSession.id,
        parentRunId: input.parentRunId,
        agentProfileId: input.agentProfileId,
        delegatedGoal: input.delegatedGoal,
        contextPacketJson: input.contextPacketJson ?? '{}',
        status: 'requested',
        mergeStatus: 'pending',
      });

      set((state) => ({
        recordsBySessionId: {
          ...state.recordsBySessionId,
          [input.parentSessionId]: upsertDelegationRecord(
            state.recordsBySessionId[input.parentSessionId] ?? [],
            delegationRecord,
          ),
          [childSession.id]: upsertDelegationRecord(
            state.recordsBySessionId[childSession.id] ?? [],
            delegationRecord,
          ),
        },
      }));

      return {
        childSession,
        delegationRecord,
        delegationErrorMessage: null,
      };
    } catch (error) {
      return {
        childSession,
        delegationRecord: null,
        delegationErrorMessage: error instanceof Error ? error.message : String(error),
      };
    }
  },

  updateDelegationRecord: async (input) => {
    const record = await backend.updateDelegationRecord(input);

    set((state) => ({
      recordsBySessionId: {
        ...state.recordsBySessionId,
        [record.parentSessionId]: upsertDelegationRecord(
          state.recordsBySessionId[record.parentSessionId] ?? [],
          record,
        ),
        [record.childSessionId]: upsertDelegationRecord(
          state.recordsBySessionId[record.childSessionId] ?? [],
          record,
        ),
      },
    }));

    return record;
  },

  clearForSession: (sessionId) => {
    set((state) => {
      const nextRecords = Object.fromEntries(
        Object.entries(state.recordsBySessionId)
          .filter(([bucketSessionId]) => bucketSessionId !== sessionId)
          .map(([bucketSessionId, records]) => [
            bucketSessionId,
            records.filter(
              (record) =>
                record.parentSessionId !== sessionId && record.childSessionId !== sessionId,
            ),
          ]),
      );
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { [sessionId]: _loading, ...nextLoading } = state.isLoadingBySessionId;
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { [sessionId]: _error, ...nextErrors } = state.lastErrorBySessionId;
      return {
        recordsBySessionId: nextRecords,
        isLoadingBySessionId: nextLoading,
        lastErrorBySessionId: nextErrors,
      };
    });
  },

  clear: () => {
    set({
      recordsBySessionId: {},
      isLoadingBySessionId: {},
      lastErrorBySessionId: {},
    });
  },
}));
