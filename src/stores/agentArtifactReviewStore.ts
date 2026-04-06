import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import type { AgentArtifactFocus } from '@/components/features/agent/agentArtifactFocus';
import type {
  ConversationMessage,
  MessagePart,
  TokenUsage,
} from '@/agents/engine/core/conversation';

export interface AgentArtifactReviewSelection {
  focus: AgentArtifactFocus | null;
  projectId: string | null;
  conversationId: string | null;
  sourceLabel?: string | null;
  sourceAgentProfileId?: string | null;
}

export interface AgentArtifactReviewSource {
  conversationId: string;
  projectId: string;
  title: string;
  agentProfileId: string;
  messages: ConversationMessage[];
  createdAt: number;
  updatedAt: number;
}

interface AgentArtifactReviewStore {
  selection: AgentArtifactReviewSelection;
  sourcesByConversationId: Record<string, AgentArtifactReviewSource>;
  isLoadingByConversationId: Record<string, boolean>;
  lastErrorByConversationId: Record<string, string | null>;
  setSelection: (selection: AgentArtifactReviewSelection) => void;
  clearSelection: () => void;
  ensureSourceLoaded: (conversationId: string) => Promise<AgentArtifactReviewSource>;
}

interface ReviewSessionSummaryDto {
  id: string;
  projectId: string;
  title: string;
  agent: string;
  createdAt: number;
  updatedAt: number;
}

interface ReviewSessionMessageDto {
  id: string;
  sessionId: string;
  role: string;
  timestamp: number;
  parts: Array<{ partType: string; dataJson: string }>;
  usageJson: string | null;
}

function hydrateReviewMessage(message: ReviewSessionMessageDto): ConversationMessage {
  return {
    id: message.id,
    role: message.role as ConversationMessage['role'],
    parts: message.parts.map((part) => {
      try {
        return JSON.parse(part.dataJson) as MessagePart;
      } catch {
        return { type: 'text' as const, content: part.dataJson };
      }
    }),
    timestamp: message.timestamp,
    sessionId: message.sessionId,
    usage: message.usageJson
      ? (() => {
          try {
            return JSON.parse(message.usageJson) as TokenUsage;
          } catch {
            return undefined;
          }
        })()
      : undefined,
  };
}

const EMPTY_SELECTION: AgentArtifactReviewSelection = {
  focus: null,
  projectId: null,
  conversationId: null,
  sourceLabel: null,
  sourceAgentProfileId: null,
};

export const useAgentArtifactReviewStore = create<AgentArtifactReviewStore>((set) => ({
  selection: EMPTY_SELECTION,
  sourcesByConversationId: {},
  isLoadingByConversationId: {},
  lastErrorByConversationId: {},
  setSelection: (selection) => set({ selection }),
  clearSelection: () => set({ selection: EMPTY_SELECTION }),
  ensureSourceLoaded: async (conversationId) => {
    set((state) => ({
      isLoadingByConversationId: {
        ...state.isLoadingByConversationId,
        [conversationId]: true,
      },
      lastErrorByConversationId: {
        ...state.lastErrorByConversationId,
        [conversationId]: null,
      },
    }));

    try {
      const data = await invoke<{
        session: ReviewSessionSummaryDto;
        messages: ReviewSessionMessageDto[];
      }>('get_ai_session', { sessionId: conversationId });

      const source: AgentArtifactReviewSource = {
        conversationId: data.session.id,
        projectId: data.session.projectId,
        title: data.session.title,
        agentProfileId: data.session.agent,
        messages: data.messages.map(hydrateReviewMessage),
        createdAt: data.session.createdAt,
        updatedAt: data.session.updatedAt,
      };

      set((state) => ({
        sourcesByConversationId: {
          ...state.sourcesByConversationId,
          [conversationId]: source,
        },
        isLoadingByConversationId: {
          ...state.isLoadingByConversationId,
          [conversationId]: false,
        },
      }));

      return source;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set((state) => ({
        isLoadingByConversationId: {
          ...state.isLoadingByConversationId,
          [conversationId]: false,
        },
        lastErrorByConversationId: {
          ...state.lastErrorByConversationId,
          [conversationId]: message,
        },
      }));
      throw error;
    }
  },
}));
