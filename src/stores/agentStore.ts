/**
 * Agent Store
 *
 * Zustand store for managing agent session state.
 * Handles current session, history, and user preferences.
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';
import type { AgentPhase, RiskLevel } from '@/agents/engine';

// =============================================================================
// Types
// =============================================================================

/**
 * Current session state
 */
export interface SessionState {
  /** Session ID */
  id: string;
  /** User input that started the session */
  input: string;
  /** Project ID */
  projectId: string;
  /** Current phase */
  phase: AgentPhase;
  /** Session status */
  status: 'running' | 'paused' | 'completed' | 'failed' | 'aborted';
  /** When session started */
  startedAt: number;
  /** Tools used in this session */
  toolsUsed: string[];
  /** Number of events emitted */
  eventsCount: number;
  /** Current iteration */
  iteration: number;
  /** Error message if failed */
  error?: string;
}

/**
 * Session summary for history
 */
export interface SessionSummary {
  /** Session ID */
  id: string;
  /** User input */
  input: string;
  /** Project ID */
  projectId: string;
  /** Final status */
  status: 'completed' | 'failed' | 'aborted';
  /** When session started */
  startedAt: number;
  /** When session ended */
  completedAt: number;
  /** Duration in ms */
  duration?: number;
  /** Tools used */
  toolsUsed: string[];
  /** Total events */
  eventsCount: number;
  /** Error if failed */
  error?: string;
}

/**
 * Agent preferences
 */
export interface AgentPreferences {
  /** Risk level below which to auto-approve */
  autoApproveRiskLevel: RiskLevel;
  /** Whether to show thinking process */
  showThinkingProcess: boolean;
  /** Whether to show plan details */
  showPlanDetails: boolean;
  /** Max iterations before warning */
  maxIterationsWarning: number;
  /** Default timeout in ms */
  defaultTimeout: number;
}

/**
 * Agent store state
 */
interface AgentState {
  /** Current active session */
  currentSession: SessionState | null;
  /** Session history */
  history: SessionSummary[];
  /** User preferences */
  preferences: AgentPreferences;
}

/**
 * Agent store actions
 */
interface AgentActions {
  // Session actions
  startSession: (input: string, projectId: string) => void;
  updateSession: (update: Partial<SessionState>) => void;
  endSession: (status?: 'completed' | 'failed' | 'aborted', error?: string) => void;

  // History actions
  addToHistory: (summary: SessionSummary) => void;
  clearHistory: () => void;
  removeFromHistory: (sessionId: string) => void;

  // Preference actions
  updatePreferences: (update: Partial<AgentPreferences>) => void;

  // Selectors
  getSessionById: (id: string) => SessionSummary | undefined;
  getHistoryByProject: (projectId: string) => SessionSummary[];

  // Reset
  reset: () => void;
}

type AgentStore = AgentState & AgentActions;

// =============================================================================
// Constants
// =============================================================================

const MAX_HISTORY_SIZE = 50;

const DEFAULT_PREFERENCES: AgentPreferences = {
  autoApproveRiskLevel: 'low',
  showThinkingProcess: true,
  showPlanDetails: true,
  maxIterationsWarning: 5,
  defaultTimeout: 60000,
};

const initialState: AgentState = {
  currentSession: null,
  history: [],
  preferences: { ...DEFAULT_PREFERENCES },
};

// =============================================================================
// Store
// =============================================================================

export const useAgentStore = create<AgentStore>()(
  persist(
    immer((set, get) => ({
      ...initialState,

      // =========================================================================
      // Session Actions
      // =========================================================================

      startSession: (input: string, projectId: string) => {
        set((state) => {
          state.currentSession = {
            id: crypto.randomUUID(),
            input,
            projectId,
            phase: 'thinking',
            status: 'running',
            startedAt: Date.now(),
            toolsUsed: [],
            eventsCount: 0,
            iteration: 0,
          };
        });
      },

      updateSession: (update: Partial<SessionState>) => {
        set((state) => {
          if (!state.currentSession) return;
          Object.assign(state.currentSession, update);
        });
      },

      endSession: (status: 'completed' | 'failed' | 'aborted' = 'completed', error?: string) => {
        const { currentSession } = get();
        if (!currentSession) return;

        const summary: SessionSummary = {
          id: currentSession.id,
          input: currentSession.input,
          projectId: currentSession.projectId,
          status,
          startedAt: currentSession.startedAt,
          completedAt: Date.now(),
          duration: Date.now() - currentSession.startedAt,
          toolsUsed: currentSession.toolsUsed,
          eventsCount: currentSession.eventsCount,
          error,
        };

        set((state) => {
          // Add to history
          state.history.unshift(summary);
          if (state.history.length > MAX_HISTORY_SIZE) {
            state.history = state.history.slice(0, MAX_HISTORY_SIZE);
          }

          // Clear current session
          state.currentSession = null;
        });
      },

      // =========================================================================
      // History Actions
      // =========================================================================

      addToHistory: (summary: SessionSummary) => {
        set((state) => {
          state.history.unshift(summary);
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

      removeFromHistory: (sessionId: string) => {
        set((state) => {
          state.history = state.history.filter((s) => s.id !== sessionId);
        });
      },

      // =========================================================================
      // Preference Actions
      // =========================================================================

      updatePreferences: (update: Partial<AgentPreferences>) => {
        set((state) => {
          Object.assign(state.preferences, update);
        });
      },

      // =========================================================================
      // Selectors
      // =========================================================================

      getSessionById: (id: string) => {
        return get().history.find((s) => s.id === id);
      },

      getHistoryByProject: (projectId: string) => {
        return get().history.filter((s) => s.projectId === projectId);
      },

      // =========================================================================
      // Reset
      // =========================================================================

      reset: () => {
        set(() => ({ ...initialState, preferences: { ...DEFAULT_PREFERENCES } }));
      },
    })),
    {
      name: 'openreelio-agent-store',
      partialize: (state) => ({
        history: state.history,
        preferences: state.preferences,
      }),
    }
  )
);

// =============================================================================
// Derived Hooks
// =============================================================================

/**
 * Hook to check if there's an active session
 */
export function useHasActiveSession(): boolean {
  return useAgentStore((state) => state.currentSession !== null);
}

/**
 * Hook to get current session phase
 */
export function useCurrentPhase(): AgentPhase | null {
  return useAgentStore((state) => state.currentSession?.phase ?? null);
}

/**
 * Hook to get session history
 */
export function useSessionHistory(): SessionSummary[] {
  return useAgentStore((state) => state.history);
}

/**
 * Hook to get preferences
 */
export function useAgentPreferences(): AgentPreferences {
  return useAgentStore((state) => state.preferences);
}
