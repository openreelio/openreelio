/**
 * AI Store
 *
 * Manages AI-related state including provider configuration, proposals, and chat history.
 * Uses Zustand with Immer for immutable state updates.
 */

import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { persist } from 'zustand/middleware';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { createLogger } from '@/services/logger';

const logger = createLogger('AIStore');

// =============================================================================
// Types
// =============================================================================

/** Supported AI provider types */
export type ProviderType = 'openai' | 'anthropic' | 'gemini' | 'local';

/** AI provider status */
export interface ProviderStatus {
  providerType: ProviderType | null;
  isConfigured: boolean;
  isAvailable: boolean;
  currentModel: string | null;
  availableModels: string[];
  errorMessage: string | null;
}

/** AI provider configuration */
export interface ProviderConfig {
  providerType: ProviderType;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

/** Connection error codes */
export type ConnectionErrorCode =
  | 'not_configured'
  | 'invalid_credentials'
  | 'rate_limited'
  | 'network_error'
  | 'service_unavailable'
  | 'unknown';

/** Result of a connection test */
export interface ConnectionTestResult {
  success: boolean;
  provider: string;
  model: string;
  latencyMs: number | null;
  message: string;
  errorCode: ConnectionErrorCode | null;
  errorDetails: string | null;
}

/** Edit command from AI */
export interface EditCommand {
  commandType: string;
  params: Record<string, unknown>;
  description?: string;
}

/** Risk assessment for edits */
export interface RiskAssessment {
  copyright: 'none' | 'low' | 'medium' | 'high';
  nsfw: 'none' | 'low' | 'medium' | 'high';
}

/** AI-generated edit script */
export interface EditScript {
  intent: string;
  commands: EditCommand[];
  requires: Array<{
    kind: string;
    query?: string;
    provider?: string;
    params?: Record<string, unknown>;
  }>;
  qcRules: string[];
  risk: RiskAssessment;
  explanation: string;
  previewPlan?: {
    ranges: Array<{ startSec: number; endSec: number }>;
    fullRender: boolean;
  };
}

/** AI proposal status */
export type ProposalStatus = 'pending' | 'reviewing' | 'approved' | 'rejected' | 'applied' | 'failed';

/** AI proposal */
export interface AIProposal {
  id: string;
  editScript: EditScript;
  status: ProposalStatus;
  createdAt: string;
  appliedOpIds?: string[];
  error?: string;
}

/** Chat message */
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  proposal?: AIProposal;
}

/** AI store state */
interface AIState {
  // Provider state
  providerStatus: ProviderStatus;
  isConfiguring: boolean;
  isConnecting: boolean;

  // Proposals
  currentProposal: AIProposal | null;
  proposalHistory: AIProposal[];

  // Chat
  chatMessages: ChatMessage[];
  isGenerating: boolean;

  // Error handling
  error: string | null;

  // Actions - Provider
  configureProvider: (config: ProviderConfig) => Promise<void>;
  clearProvider: () => Promise<void>;
  testConnection: () => Promise<ConnectionTestResult>;
  getAvailableModels: (providerType: ProviderType) => Promise<string[]>;
  refreshProviderStatus: () => Promise<void>;

  // Actions - AI Generation
  generateEditScript: (intent: string, context?: AIContext) => Promise<EditScript>;
  applyEditScript: (editScript: EditScript) => Promise<{ success: boolean; appliedOpIds: string[]; errors: string[] }>;

  // Actions - Proposals
  createProposal: (editScript: EditScript) => void;
  approveProposal: (proposalId: string) => Promise<void>;
  rejectProposal: (proposalId: string) => void;
  clearCurrentProposal: () => void;

  // Actions - Chat
  addChatMessage: (role: 'user' | 'assistant' | 'system', content: string, proposal?: AIProposal) => void;
  clearChatHistory: () => void;

  // Actions - Error handling
  setError: (error: string | null) => void;
  clearError: () => void;
}

/** Context for AI intent analysis */
export interface AIContext {
  playheadPosition?: number;
  selectedClips?: string[];
  selectedTracks?: string[];
  transcriptContext?: string;
  timelineDuration?: number;
  assetIds?: string[];
  trackIds?: string[];
}

// =============================================================================
// Store
// =============================================================================

export const useAIStore = create<AIState>()(
  persist(
    immer((set, get) => ({
      // Initial state
      providerStatus: {
        providerType: null,
        isConfigured: false,
        isAvailable: false,
        currentModel: null,
        availableModels: [],
        errorMessage: null,
      },
      isConfiguring: false,
      isConnecting: false,
      currentProposal: null,
      proposalHistory: [],
      chatMessages: [],
      isGenerating: false,
      error: null,

      // Configure AI provider
      configureProvider: async (config: ProviderConfig) => {
        set((state) => {
          state.isConfiguring = true;
          state.error = null;
        });

        try {
          const status = await invoke<ProviderStatus>('configure_ai_provider', {
            config: {
              providerType: config.providerType,
              apiKey: config.apiKey,
              baseUrl: config.baseUrl,
              model: config.model,
            },
          });

          set((state) => {
            state.providerStatus = status;
            state.isConfiguring = false;
          });

          logger.info('AI provider configured', { providerType: config.providerType });
        } catch (error) {
          set((state) => {
            state.isConfiguring = false;
            state.error = error instanceof Error ? error.message : String(error);
          });
          throw error;
        }
      },

      // Clear AI provider
      clearProvider: async () => {
        try {
          await invoke('clear_ai_provider');

          set((state) => {
            state.providerStatus = {
              providerType: null,
              isConfigured: false,
              isAvailable: false,
              currentModel: null,
              availableModels: [],
              errorMessage: null,
            };
          });

          logger.info('AI provider cleared');
        } catch (error) {
          set((state) => {
            state.error = error instanceof Error ? error.message : String(error);
          });
          throw error;
        }
      },

      // Test AI connection
      testConnection: async () => {
        set((state) => {
          state.isConnecting = true;
          state.error = null;
        });

        try {
          const result = await invoke<ConnectionTestResult>('test_ai_connection');

          set((state) => {
            state.isConnecting = false;
            if (!result.success) {
              state.error = result.message;
            }
          });

          return result;
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          set((state) => {
            state.isConnecting = false;
            state.error = errorMsg;
          });
          // Return a failure result instead of throwing
          return {
            success: false,
            provider: 'unknown',
            model: 'unknown',
            latencyMs: null,
            message: errorMsg,
            errorCode: 'unknown' as const,
            errorDetails: errorMsg,
          };
        }
      },

      // Get available models for a provider
      getAvailableModels: async (providerType: ProviderType) => {
        try {
          const models = await invoke<string[]>('get_available_ai_models', { providerType });
          return models;
        } catch (error) {
          logger.error('Failed to get available models', { error });
          return [];
        }
      },

      // Refresh provider status
      refreshProviderStatus: async () => {
        try {
          const status = await invoke<ProviderStatus>('get_ai_provider_status');

          set((state) => {
            state.providerStatus = status;
          });
        } catch (error) {
          logger.error('Failed to refresh provider status', { error });
        }
      },

      // Generate edit script from natural language
      generateEditScript: async (intent: string, context?: AIContext) => {
        set((state) => {
          state.isGenerating = true;
          state.error = null;
        });

        // Add user message to chat
        get().addChatMessage('user', intent);

        try {
          const editScript = await invoke<EditScript>('generate_edit_script_with_ai', {
            intent,
            context: context ?? {
              playheadPosition: 0,
              selectedClips: [],
              selectedTracks: [],
            },
          });

          set((state) => {
            state.isGenerating = false;
          });

          // Add assistant message with the proposal
          get().addChatMessage('assistant', editScript.explanation);

          // Create proposal
          get().createProposal(editScript);

          return editScript;
        } catch (error) {
          // Fall back to local intent parsing
          try {
            const editScript = await invoke<EditScript>('analyze_intent', {
              intent,
              context: context ?? {
                playheadPosition: 0,
                selectedClips: [],
                selectedTracks: [],
              },
            });

            set((state) => {
              state.isGenerating = false;
            });

            get().addChatMessage('assistant', editScript.explanation);
            get().createProposal(editScript);

            return editScript;
          } catch (fallbackError) {
            const primaryErrorMessage = error instanceof Error ? error.message : String(error);
            const fallbackErrorMessage =
              fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
            const combinedErrorMessage = `AI generation failed: ${primaryErrorMessage}; fallback failed: ${fallbackErrorMessage}`;

            set((state) => {
              state.isGenerating = false;
              state.error = combinedErrorMessage;
            });

            logger.error('AI generation and fallback both failed', {
              primaryError: primaryErrorMessage,
              fallbackError: fallbackErrorMessage,
            });

            get().addChatMessage(
              'assistant',
              `I encountered an error: ${combinedErrorMessage}`
            );

            throw new Error(combinedErrorMessage);
          }
        }
      },

      // Apply edit script
      applyEditScript: async (editScript: EditScript) => {
        try {
          const result = await invoke<{ success: boolean; appliedOpIds: string[]; errors: string[] }>(
            'apply_edit_script',
            { editScript }
          );

          if (result.success) {
            set((state) => {
              if (state.currentProposal) {
                state.currentProposal.status = 'applied';
                state.currentProposal.appliedOpIds = result.appliedOpIds;
              }
            });
          } else {
            set((state) => {
              if (state.currentProposal) {
                state.currentProposal.status = 'failed';
                state.currentProposal.error = result.errors.join('; ');
              }
            });
          }

          return result;
        } catch (error) {
          set((state) => {
            state.error = error instanceof Error ? error.message : String(error);
            if (state.currentProposal) {
              state.currentProposal.status = 'failed';
              state.currentProposal.error = error instanceof Error ? error.message : String(error);
            }
          });
          throw error;
        }
      },

      // Create proposal
      createProposal: (editScript: EditScript) => {
        const proposal: AIProposal = {
          id: crypto.randomUUID(),
          editScript,
          status: 'pending',
          createdAt: new Date().toISOString(),
        };

        set((state) => {
          state.currentProposal = proposal;
          state.proposalHistory.unshift(proposal);
          // Keep only last 50 proposals
          if (state.proposalHistory.length > 50) {
            state.proposalHistory = state.proposalHistory.slice(0, 50);
          }
        });
      },

      // Approve proposal
      approveProposal: async (proposalId: string) => {
        const { currentProposal, applyEditScript } = get();

        if (currentProposal?.id !== proposalId) {
          throw new Error('Proposal not found or not current');
        }

        set((state) => {
          if (state.currentProposal) {
            state.currentProposal.status = 'approved';
          }
        });

        await applyEditScript(currentProposal.editScript);
      },

      // Reject proposal
      rejectProposal: (proposalId: string) => {
        set((state) => {
          if (state.currentProposal?.id === proposalId) {
            state.currentProposal.status = 'rejected';
          }
          const proposal = state.proposalHistory.find((p) => p.id === proposalId);
          if (proposal) {
            proposal.status = 'rejected';
          }
        });
      },

      // Clear current proposal
      clearCurrentProposal: () => {
        set((state) => {
          state.currentProposal = null;
        });
      },

      // Add chat message
      addChatMessage: (role: 'user' | 'assistant' | 'system', content: string, proposal?: AIProposal) => {
        const message: ChatMessage = {
          id: crypto.randomUUID(),
          role,
          content,
          timestamp: new Date().toISOString(),
          proposal,
        };

        set((state) => {
          state.chatMessages.push(message);
          // Keep only last 100 messages
          if (state.chatMessages.length > 100) {
            state.chatMessages = state.chatMessages.slice(-100);
          }
        });
      },

      // Clear chat history
      clearChatHistory: () => {
        set((state) => {
          state.chatMessages = [];
        });
      },

      // Set error
      setError: (error: string | null) => {
        set((state) => {
          state.error = error;
        });
      },

      // Clear error
      clearError: () => {
        set((state) => {
          state.error = null;
        });
      },
    })),
    {
      name: 'openreelio-ai-store',
      // Only persist certain fields
      partialize: (state) => ({
        providerStatus: {
          providerType: state.providerStatus.providerType,
          currentModel: state.providerStatus.currentModel,
          isConfigured: state.providerStatus.isConfigured,
        },
      }),
    }
  )
);

// =============================================================================
// Event Listeners
// =============================================================================

let aiEventUnlisteners: UnlistenFn[] = [];

function isTauriRuntime(): boolean {
  return typeof (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== 'undefined';
}

/**
 * Setup event listeners for AI-related events.
 */
export async function setupAIEventListeners(): Promise<void> {
  await cleanupAIEventListeners();

  if (!isTauriRuntime()) {
    return;
  }

  // Listen for AI completion events
  const unlistenCompletion = await listen<{ jobId: string; result: unknown }>(
    'ai-completion',
    (event) => {
      logger.info('AI completion event received', { jobId: event.payload.jobId });
    }
  );
  aiEventUnlisteners.push(unlistenCompletion);

  logger.info('AI event listeners initialized');
}

/**
 * Cleanup AI event listeners.
 */
export async function cleanupAIEventListeners(): Promise<void> {
  for (const unlisten of aiEventUnlisteners) {
    unlisten();
  }
  aiEventUnlisteners = [];
}

// =============================================================================
// Selectors
// =============================================================================

/** Selector for whether AI is ready to use */
export const selectIsAIReady = (state: AIState) =>
  state.providerStatus.isConfigured && state.providerStatus.isAvailable;

/** Selector for current provider type */
export const selectProviderType = (state: AIState) => state.providerStatus.providerType;

/** Selector for whether a proposal is pending */
export const selectHasPendingProposal = (state: AIState) =>
  state.currentProposal?.status === 'pending' || state.currentProposal?.status === 'reviewing';
