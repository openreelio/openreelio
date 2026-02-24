/**
 * Agent Manager Store
 *
 * Zustand store for managing multiple concurrent agent instances.
 * Tracks active agents, their status, and inbox notifications.
 */

import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import type { AgentDefinition } from '@/agents/engine/core/agentDefinitions';

// =============================================================================
// Types
// =============================================================================

export type AgentInstanceStatus =
  | 'idle'
  | 'running'
  | 'waiting_approval'
  | 'completed'
  | 'failed'
  | 'aborted';

export interface AgentInstance {
  id: string;
  definition: AgentDefinition;
  sessionId: string;
  status: AgentInstanceStatus;
  lastMessage?: string;
  startedAt: number;
  updatedAt: number;
  error?: string;
}

export type InboxItemType = 'approval_request' | 'completion' | 'error' | 'info';

export interface InboxItem {
  id: string;
  agentId: string;
  agentName: string;
  type: InboxItemType;
  message: string;
  timestamp: number;
  read: boolean;
  actionRequired: boolean;
}

// =============================================================================
// State & Actions
// =============================================================================

interface AgentManagerState {
  activeAgents: Map<string, AgentInstance>;
  inbox: InboxItem[];
  focusedAgentId: string | null;
}

interface AgentManagerActions {
  /** Register a new agent instance */
  addAgent: (instance: AgentInstance) => void;
  /** Remove an agent instance */
  removeAgent: (agentId: string) => void;
  /** Update an agent's status */
  updateAgentStatus: (agentId: string, status: AgentInstanceStatus, message?: string) => void;
  /** Set the focused agent (shown in main chat view) */
  setFocusedAgent: (agentId: string | null) => void;
  /** Add an inbox notification */
  addInboxItem: (item: Omit<InboxItem, 'id' | 'timestamp' | 'read'>) => void;
  /** Mark an inbox item as read */
  markInboxRead: (itemId: string) => void;
  /** Mark all inbox items as read */
  markAllInboxRead: () => void;
  /** Clear all inbox items */
  clearInbox: () => void;
  /** Get unread count */
  getUnreadCount: () => number;
  /** Get agents by status */
  getAgentsByStatus: (status: AgentInstanceStatus) => AgentInstance[];
}

// =============================================================================
// Store
// =============================================================================

export const useAgentManagerStore = create<AgentManagerState & AgentManagerActions>()(
  immer((set, get) => ({
    activeAgents: new Map(),
    inbox: [],
    focusedAgentId: null,

    addAgent: (instance) => {
      set((state) => {
        state.activeAgents.set(instance.id, instance);
      });
    },

    removeAgent: (agentId) => {
      set((state) => {
        state.activeAgents.delete(agentId);
        if (state.focusedAgentId === agentId) {
          state.focusedAgentId = null;
        }
      });
    },

    updateAgentStatus: (agentId, status, message) => {
      set((state) => {
        const agent = state.activeAgents.get(agentId);
        if (agent) {
          agent.status = status;
          agent.updatedAt = Date.now();
          if (message) agent.lastMessage = message;
        }
      });
    },

    setFocusedAgent: (agentId) => {
      set((state) => {
        state.focusedAgentId = agentId;
      });
    },

    addInboxItem: (item) => {
      set((state) => {
        state.inbox.unshift({
          ...item,
          id: crypto.randomUUID(),
          timestamp: Date.now(),
          read: false,
        });
      });
    },

    markInboxRead: (itemId) => {
      set((state) => {
        const item = state.inbox.find((i) => i.id === itemId);
        if (item) item.read = true;
      });
    },

    markAllInboxRead: () => {
      set((state) => {
        for (const item of state.inbox) {
          item.read = true;
        }
      });
    },

    clearInbox: () => {
      set((state) => {
        state.inbox = [];
      });
    },

    getUnreadCount: () => {
      return get().inbox.filter((i) => !i.read).length;
    },

    getAgentsByStatus: (status) => {
      return Array.from(get().activeAgents.values()).filter((a) => a.status === status);
    },
  })),
);
