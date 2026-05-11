import type {
  ExternalAgentApprovalDecision,
  ExternalAgentApprovalDecisionProvider,
  ExternalAgentApprovalRequest,
} from './types';

export interface ExternalAgentApprovalBrokerOptions {
  fallbackDecision?: ExternalAgentApprovalDecision;
  timeoutMs?: number;
  now?: () => number;
}

export interface ExternalAgentApprovalBrokerSnapshot {
  pending: ExternalAgentApprovalRequest | null;
}

export type ExternalAgentApprovalDecisionListener = (
  request: ExternalAgentApprovalRequest,
  decision: ExternalAgentApprovalDecision,
) => void;

interface PendingDecision {
  request: ExternalAgentApprovalRequest;
  resolve: (decision: ExternalAgentApprovalDecision) => void;
  timeoutId: ReturnType<typeof setTimeout> | null;
}

const DEFAULT_TIMEOUT_MS = 120_000;

export class ExternalAgentApprovalBroker {
  private readonly pending = new Map<string, PendingDecision>();
  private readonly listeners = new Set<(snapshot: ExternalAgentApprovalBrokerSnapshot) => void>();
  private readonly decisionListeners = new Set<ExternalAgentApprovalDecisionListener>();
  private readonly fallbackDecision: ExternalAgentApprovalDecision;
  private readonly timeoutMs: number;

  constructor(private readonly options: ExternalAgentApprovalBrokerOptions = {}) {
    this.fallbackDecision = options.fallbackDecision ?? 'decline';
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  requestDecision: ExternalAgentApprovalDecisionProvider = async (request) => {
    if (this.pending.has(request.id)) {
      this.resolve(request.id, this.fallbackDecision);
    }

    return new Promise<ExternalAgentApprovalDecision>((resolve) => {
      const timeoutId =
        this.timeoutMs > 0
          ? setTimeout(() => this.resolve(request.id, this.fallbackDecision), this.timeoutMs)
          : null;

      this.pending.set(request.id, {
        request: {
          ...request,
          requestedAt: request.requestedAt ?? this.options.now?.() ?? Date.now(),
        },
        resolve,
        timeoutId,
      });
      this.notify();
    });
  };

  subscribe(listener: (snapshot: ExternalAgentApprovalBrokerSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => this.listeners.delete(listener);
  }

  subscribeDecision(listener: ExternalAgentApprovalDecisionListener): () => void {
    this.decisionListeners.add(listener);
    return () => this.decisionListeners.delete(listener);
  }

  getSnapshot(): ExternalAgentApprovalBrokerSnapshot {
    return {
      pending: this.getLatestPendingRequest(),
    };
  }

  resolve(requestId: string, decision: ExternalAgentApprovalDecision): boolean {
    const pending = this.pending.get(requestId);
    if (!pending) {
      return false;
    }

    if (pending.timeoutId) {
      clearTimeout(pending.timeoutId);
    }
    this.pending.delete(requestId);
    pending.resolve(decision);
    this.notifyDecision(pending.request, decision);
    this.notify();
    return true;
  }

  resolveLatest(decision: ExternalAgentApprovalDecision): boolean {
    const pending = this.getLatestPendingRequest();
    return pending ? this.resolve(pending.id, decision) : false;
  }

  declineAll(): void {
    for (const requestId of Array.from(this.pending.keys())) {
      this.resolve(requestId, this.fallbackDecision);
    }
  }

  private getLatestPendingRequest(): ExternalAgentApprovalRequest | null {
    let latest: ExternalAgentApprovalRequest | null = null;
    for (const pending of this.pending.values()) {
      if (!latest || pending.request.requestedAt >= latest.requestedAt) {
        latest = pending.request;
      }
    }
    return latest;
  }

  private notify(): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }

  private notifyDecision(
    request: ExternalAgentApprovalRequest,
    decision: ExternalAgentApprovalDecision,
  ): void {
    for (const listener of this.decisionListeners) {
      listener(request, decision);
    }
  }
}
