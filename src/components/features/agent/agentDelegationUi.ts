export interface ParentRunSnapshot {
  session: { currentRunId: string | null };
  runs: Array<{ id: string; updatedAt: number }>;
}

export function resolveLatestParentRunId(snapshot: ParentRunSnapshot | null): string | null {
  if (!snapshot) {
    return null;
  }

  if (snapshot.session.currentRunId) {
    return snapshot.session.currentRunId;
  }

  return [...snapshot.runs].sort((left, right) => right.updatedAt - left.updatedAt)[0]?.id ?? null;
}

export function formatDelegationStatus(status: string): string {
  switch (status) {
    case 'requested':
      return 'Requested';
    case 'running':
      return 'Running';
    case 'completed':
      return 'Completed';
    case 'failed':
      return 'Failed';
    case 'cancelled':
      return 'Cancelled';
    default:
      return status;
  }
}
