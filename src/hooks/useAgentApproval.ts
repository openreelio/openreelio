/**
 * useAgentApproval Hook
 *
 * Manages human-in-the-loop approval requests for the AI agent system.
 * Provides request creation, approval/rejection, and history tracking.
 */

import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import type { RiskLevel } from '@/agents/registry/ToolMetadata';

// =============================================================================
// Types
// =============================================================================

/** Approval request options */
export interface ApprovalRequestOptions {
  toolName: string;
  description: string;
  riskLevel: RiskLevel;
  args?: Record<string, unknown>;
  onApprove?: () => void;
  onReject?: (reason?: string) => void;
}

/** An approval request (stored state - no callbacks) */
export interface ApprovalRequestData {
  id: string;
  toolName: string;
  description: string;
  riskLevel: RiskLevel;
  args?: Record<string, unknown>;
  createdAt: number;
}

/** A historical approval record */
export interface ApprovalHistoryRecord {
  id: string;
  toolName: string;
  description: string;
  riskLevel: RiskLevel;
  response: 'approved' | 'rejected';
  reason?: string;
  respondedAt: number;
}

/** Approval store state (only serializable data) */
interface ApprovalState {
  currentRequest: ApprovalRequestData | null;
  history: ApprovalHistoryRecord[];
}

/** Approval store actions */
interface ApprovalActions {
  setCurrentRequest: (request: ApprovalRequestData | null) => void;
  addToHistory: (record: ApprovalHistoryRecord) => void;
  clearHistory: () => void;
  reset: () => void;
}

type ApprovalStore = ApprovalState & ApprovalActions;

// =============================================================================
// Constants
// =============================================================================

const MAX_HISTORY_SIZE = 50;

// =============================================================================
// External Storage for Non-Serializable Data
// =============================================================================

// Store callbacks outside of Zustand/Immer (they're not serializable)
const callbackRegistry = new Map<string, {
  onApprove?: () => void;
  onReject?: (reason?: string) => void;
}>();

// Store promise resolvers outside of Zustand/Immer (Map doesn't work with Immer)
const pendingResolvers = new Map<string, { resolve: (approved: boolean) => void }>();

// =============================================================================
// Initial State
// =============================================================================

const initialState: ApprovalState = {
  currentRequest: null,
  history: [],
};

// =============================================================================
// Store
// =============================================================================

export const useAgentApprovalStore = create<ApprovalStore>()(
  immer((set) => ({
    ...initialState,

    setCurrentRequest: (request: ApprovalRequestData | null) => {
      set((state) => {
        state.currentRequest = request;
      });
    },

    addToHistory: (record: ApprovalHistoryRecord) => {
      set((state) => {
        state.history.unshift(record);
        if (state.history.length > MAX_HISTORY_SIZE) {
          state.history = state.history.slice(0, MAX_HISTORY_SIZE);
        }
      });
    },

    clearHistory: () => {
      set((state) => {
        state.history = [];
      });
    },

    reset: () => {
      // Clear external registries
      callbackRegistry.clear();
      pendingResolvers.clear();
      set(() => ({ ...initialState }));
    },
  }))
);

// =============================================================================
// Hook
// =============================================================================

export interface UseAgentApprovalReturn {
  // State
  currentRequest: ApprovalRequestData | null;
  hasPendingRequest: boolean;
  history: ApprovalHistoryRecord[];

  // Actions
  requestApproval: (options: ApprovalRequestOptions) => string | null;
  waitForApproval: (options: ApprovalRequestOptions) => Promise<boolean>;
  approve: (requestId: string) => void;
  reject: (requestId: string, reason?: string) => void;
  dismiss: () => void;
  clearHistory: () => void;
  reset: () => void;
}

export function useAgentApproval(): UseAgentApprovalReturn {
  const store = useAgentApprovalStore();

  const requestApproval = (options: ApprovalRequestOptions): string | null => {
    const { currentRequest } = useAgentApprovalStore.getState();

    // Don't create if already has pending request
    if (currentRequest !== null) {
      return null;
    }

    const id = crypto.randomUUID();
    const request: ApprovalRequestData = {
      id,
      toolName: options.toolName,
      description: options.description,
      riskLevel: options.riskLevel,
      args: options.args,
      createdAt: Date.now(),
    };

    // Store callbacks externally
    if (options.onApprove || options.onReject) {
      callbackRegistry.set(id, {
        onApprove: options.onApprove,
        onReject: options.onReject,
      });
    }

    store.setCurrentRequest(request);
    return id;
  };

  const approve = (requestId: string): void => {
    const { currentRequest } = useAgentApprovalStore.getState();

    if (!currentRequest || currentRequest.id !== requestId) {
      return;
    }

    // Call onApprove callback from external registry
    const callbacks = callbackRegistry.get(requestId);
    callbacks?.onApprove?.();

    // Resolve pending promise if any
    const resolver = pendingResolvers.get(requestId);
    if (resolver) {
      resolver.resolve(true);
      pendingResolvers.delete(requestId);
    }

    // Add to history
    const historyRecord: ApprovalHistoryRecord = {
      id: currentRequest.id,
      toolName: currentRequest.toolName,
      description: currentRequest.description,
      riskLevel: currentRequest.riskLevel,
      response: 'approved',
      respondedAt: Date.now(),
    };

    store.addToHistory(historyRecord);
    store.setCurrentRequest(null);

    // Clean up callback registry
    callbackRegistry.delete(requestId);
  };

  const reject = (requestId: string, reason?: string): void => {
    const { currentRequest } = useAgentApprovalStore.getState();

    if (!currentRequest || currentRequest.id !== requestId) {
      return;
    }

    // Call onReject callback from external registry
    const callbacks = callbackRegistry.get(requestId);
    callbacks?.onReject?.(reason);

    // Resolve pending promise if any
    const resolver = pendingResolvers.get(requestId);
    if (resolver) {
      resolver.resolve(false);
      pendingResolvers.delete(requestId);
    }

    // Add to history
    const historyRecord: ApprovalHistoryRecord = {
      id: currentRequest.id,
      toolName: currentRequest.toolName,
      description: currentRequest.description,
      riskLevel: currentRequest.riskLevel,
      response: 'rejected',
      reason,
      respondedAt: Date.now(),
    };

    store.addToHistory(historyRecord);
    store.setCurrentRequest(null);

    // Clean up callback registry
    callbackRegistry.delete(requestId);
  };

  const dismiss = (): void => {
    const { currentRequest } = useAgentApprovalStore.getState();

    if (currentRequest) {
      const resolver = pendingResolvers.get(currentRequest.id);
      if (resolver) {
        resolver.resolve(false);
        pendingResolvers.delete(currentRequest.id);
      }
      callbackRegistry.delete(currentRequest.id);
    }

    store.setCurrentRequest(null);
  };

  const waitForApproval = (options: ApprovalRequestOptions): Promise<boolean> => {
    return new Promise((resolve) => {
      const requestId = requestApproval(options);

      if (!requestId) {
        resolve(false);
        return;
      }

      // Store the resolver externally
      pendingResolvers.set(requestId, { resolve });
    });
  };

  return {
    // State
    currentRequest: store.currentRequest,
    hasPendingRequest: store.currentRequest !== null,
    history: store.history,

    // Actions
    requestApproval,
    waitForApproval,
    approve,
    reject,
    dismiss,
    clearHistory: store.clearHistory,
    reset: store.reset,
  };
}
