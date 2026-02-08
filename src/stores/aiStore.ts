/**
 * AI Store
 *
 * Manages AI-related state including provider configuration, proposals, and chat history.
 * Uses Zustand with Immer for immutable state updates.
 */

import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { persist, subscribeWithSelector } from 'zustand/middleware';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { createLogger } from '@/services/logger';
import {
  loadChatHistory,
  clearChatHistory as clearStoredChatHistory,
  createDebouncedSaver,
  cleanupOldHistories,
} from '@/services/chatStorage';
import { registerEditingTools, globalToolRegistry } from '@/agents';
import { useConversationStore } from './conversationStore';

const logger = createLogger('AIStore');

// Debounced saver for chat persistence (1 second delay)
const debouncedSaveChatHistory = createDebouncedSaver(1000);

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

// =============================================================================
// Unified Agent Types (Conversation Mode)
// =============================================================================

/** Intent type detected by AI */
export type AIIntentType = 'chat' | 'edit' | 'query' | 'clarify';

/** Unified AI response supporting both conversation and editing */
export interface AIResponse {
  /** Conversational response text - always present */
  message: string;
  /** Edit actions to execute - only present when user requests edits */
  actions?: EditCommand[];
  /** Whether user confirmation is needed before applying actions */
  needsConfirmation?: boolean;
  /** AI's understanding of the user's intent */
  intent?: {
    type: AIIntentType;
    confidence: number;
  };
  /** Risk assessment if actions are present */
  risk?: RiskAssessment;
  /** Clarifying questions if AI needs more info */
  clarifyingQuestions?: string[];
}

/** Message format for conversation history sent to AI */
export interface ConversationMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  /** Timestamp for context */
  timestamp?: string;
  /** Actions that were approved/applied (for assistant messages) */
  appliedActions?: EditCommand[];
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
  isCancelled: boolean;
  currentProjectId: string | null;

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
  /** Send a message to AI using conversation mode (unified agent) */
  sendMessage: (message: string, context?: AIContext) => Promise<AIResponse>;
  applyEditScript: (editScript: EditScript) => Promise<{ success: boolean; appliedOpIds: string[]; errors: string[] }>;
  cancelGeneration: () => void;

  // Actions - Proposals
  createProposal: (editScript: EditScript) => void;
  approveProposal: (proposalId: string) => Promise<void>;
  rejectProposal: (proposalId: string) => void;
  clearCurrentProposal: () => void;

  // Actions - Chat
  addChatMessage: (role: 'user' | 'assistant' | 'system', content: string, proposal?: AIProposal) => void;
  clearChatHistory: () => void;
  loadChatHistoryForProject: (projectId: string) => void;
  setCurrentProjectId: (projectId: string | null) => void;

  // Actions - Error handling
  setError: (error: string | null) => void;
  clearError: () => void;

  // Actions - Settings Sync
  syncFromSettings: () => Promise<void>;
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
  subscribeWithSelector(
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
      isCancelled: false,
      currentProjectId: null,
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

          // Sync to global settings (bidirectional sync)
          try {
            const { useSettingsStore } = await import('@/stores/settingsStore');
            const updateSettings = useSettingsStore.getState().updateSettings;

            // Build settings update based on provider type
            const settingsUpdate: Record<string, unknown> = {
              primaryProvider: config.providerType,
              primaryModel: config.model ?? status.currentModel,
            };

            // Update the appropriate API key field
            if (config.apiKey) {
              switch (config.providerType) {
                case 'openai':
                  settingsUpdate.openaiApiKey = config.apiKey;
                  break;
                case 'anthropic':
                  settingsUpdate.anthropicApiKey = config.apiKey;
                  break;
                case 'gemini':
                  settingsUpdate.googleApiKey = config.apiKey;
                  break;
              }
            }

            if (config.providerType === 'local' && config.baseUrl) {
              settingsUpdate.ollamaUrl = config.baseUrl;
            }

            await updateSettings('ai', settingsUpdate);
            logger.debug('AI settings synced to global settings');
          } catch (syncError) {
            // Don't fail the main operation if sync fails
            logger.warn('Failed to sync AI settings to global settings', { error: syncError });
          }
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

      // Cancel ongoing generation
      cancelGeneration: () => {
        // Atomically check and set cancellation flag
        // This prevents race conditions where cancellation is requested
        // just as generation completes
        set((state) => {
          if (state.isGenerating) {
            state.isCancelled = true;
            logger.info('Generation cancellation requested by user');
          }
        });
      },

      // Generate edit script from natural language
      generateEditScript: async (intent: string, context?: AIContext) => {
        set((state) => {
          state.isGenerating = true;
          state.isCancelled = false;
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

          // Check if cancelled during generation
          if (get().isCancelled) {
            set((state) => {
              state.isCancelled = false;
              state.isGenerating = false;
            });
            get().addChatMessage('system', 'Generation cancelled.');
            throw new Error('Generation cancelled');
          }

          set((state) => {
            state.isGenerating = false;
          });

          // Create proposal first, then add assistant message with it attached
          get().createProposal(editScript);
          get().addChatMessage('assistant', editScript.explanation, get().currentProposal ?? undefined);

          return editScript;
        } catch (error) {
          // Check if it was a cancellation
          if (get().isCancelled || (error instanceof Error && error.message === 'Generation cancelled')) {
            set((state) => {
              state.isCancelled = false;
              state.isGenerating = false;
            });
            // Only add message if not already added
            const messages = get().chatMessages;
            const lastMessage = messages[messages.length - 1];
            if (!lastMessage || lastMessage.content !== 'Generation cancelled.') {
              get().addChatMessage('system', 'Generation cancelled.');
            }
            throw new Error('Generation cancelled');
          }

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

            // Check if cancelled during fallback
            if (get().isCancelled) {
              set((state) => {
                state.isCancelled = false;
                state.isGenerating = false;
              });
              // Only add message if not already added
              const messages = get().chatMessages;
              const lastMessage = messages[messages.length - 1];
              if (!lastMessage || lastMessage.content !== 'Generation cancelled.') {
                get().addChatMessage('system', 'Generation cancelled.');
              }
              throw new Error('Generation cancelled');
            }

            set((state) => {
              state.isGenerating = false;
            });

            // Create proposal first, then add assistant message with it attached
            get().createProposal(editScript);
            get().addChatMessage('assistant', editScript.explanation, get().currentProposal ?? undefined);

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

      // Send message using conversation mode (unified agent)
      sendMessage: async (message: string, context?: AIContext) => {
        // Check if provider is configured, if not try to sync from settings first
        const currentStatus = get().providerStatus;
        if (!currentStatus.isConfigured) {
          logger.info('Provider not configured, attempting to sync from settings...');
          try {
            await get().syncFromSettings();
          } catch (syncError) {
            logger.warn('Failed to auto-sync provider', { error: syncError });
          }

          // Re-check after sync attempt
          const updatedStatus = get().providerStatus;
          if (!updatedStatus.isConfigured) {
            const errorMsg = 'No AI provider configured. Please configure an API key in Settings.';
            get().addChatMessage('user', message);
            get().addChatMessage('system', errorMsg);
            throw new Error(errorMsg);
          }
        }

        set((state) => {
          state.isGenerating = true;
          state.isCancelled = false;
          state.error = null;
        });

        // Add user message to chat
        get().addChatMessage('user', message);

        try {
          // Build conversation history from chat messages
          const chatHistory = get().chatMessages;
          const conversationMessages: ConversationMessage[] = chatHistory
            .filter((msg) => msg.role !== 'system') // Exclude system messages
            .map((msg) => ({
              role: msg.role,
              content: msg.content,
              timestamp: msg.timestamp,
              // Include applied actions for context
              appliedActions: msg.proposal?.status === 'applied'
                ? msg.proposal.editScript.commands.map((cmd) => ({
                    commandType: cmd.commandType,
                    params: cmd.params,
                    description: cmd.description,
                  }))
                : undefined,
            }));

          // Call unified agent chat endpoint
          const response = await invoke<AIResponse>('chat_with_ai', {
            messages: conversationMessages.map((m) => ({
              role: m.role,
              content: m.content,
            })),
            context: {
              playheadPosition: context?.playheadPosition ?? 0,
              selectedClips: context?.selectedClips ?? [],
              selectedTracks: context?.selectedTracks ?? [],
              timelineDuration: context?.timelineDuration,
              assetIds: context?.assetIds ?? [],
              trackIds: context?.trackIds ?? [],
            },
          });

          // Check if cancelled during generation
          if (get().isCancelled) {
            set((state) => {
              state.isCancelled = false;
              state.isGenerating = false;
            });
            get().addChatMessage('system', 'Generation cancelled.');
            throw new Error('Generation cancelled');
          }

          set((state) => {
            state.isGenerating = false;
          });

          // If response has actions, create a proposal
          if (response.actions && response.actions.length > 0) {
            const editScript: EditScript = {
              intent: message,
              commands: response.actions.map((a) => ({
                commandType: a.commandType,
                params: a.params as Record<string, unknown>,
                description: a.description,
              })),
              requires: [],
              qcRules: [],
              risk: response.risk ?? { copyright: 'none', nsfw: 'none' },
              explanation: response.message,
            };

            get().createProposal(editScript);
            get().addChatMessage('assistant', response.message, get().currentProposal ?? undefined);
          } else {
            // Pure conversation response (no actions)
            get().addChatMessage('assistant', response.message);
          }

          return response;
        } catch (error) {
          // Check if it was a cancellation
          if (get().isCancelled || (error instanceof Error && error.message === 'Generation cancelled')) {
            set((state) => {
              state.isCancelled = false;
              state.isGenerating = false;
            });
            throw new Error('Generation cancelled');
          }

          const errorMessage = error instanceof Error ? error.message : String(error);

          set((state) => {
            state.isGenerating = false;
            state.error = errorMessage;
          });

          logger.error('AI chat failed', { error: errorMessage });

          // Add error message to chat
          get().addChatMessage(
            'assistant',
            `I encountered an error: ${errorMessage}`
          );

          throw error;
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

      // Add chat message (bridges to conversationStore for unified storage)
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

        // Bridge: also write to conversationStore for unified access
        try {
          const convStore = useConversationStore.getState();
          if (convStore.activeConversation) {
            if (role === 'user') {
              convStore.addUserMessage(content);
            } else if (role === 'system') {
              convStore.addSystemMessage(content);
            } else {
              // For assistant messages, create a complete message with text
              const msgId = convStore.startAssistantMessage();
              convStore.appendPart(msgId, { type: 'text', content });
              convStore.finalizeMessage(msgId);
            }
          }
        } catch {
          // Silently ignore bridge errors to preserve backward compatibility
        }
      },

      // Clear chat history
      clearChatHistory: () => {
        const { currentProjectId } = get();
        set((state) => {
          state.chatMessages = [];
        });
        // Also clear from localStorage
        if (currentProjectId) {
          clearStoredChatHistory(currentProjectId);
        }
      },

      // Load chat history for a project
      loadChatHistoryForProject: (projectId: string) => {
        const messages = loadChatHistory(projectId);
        set((state) => {
          state.chatMessages = messages;
          state.currentProjectId = projectId;
        });
        logger.info('Loaded chat history for project', {
          projectId,
          messageCount: messages.length,
        });

        // Bridge: also load conversation for the project
        try {
          useConversationStore.getState().loadForProject(projectId);
        } catch {
          // Silently ignore bridge errors
        }
      },

      // Set current project ID (without loading history)
      setCurrentProjectId: (projectId: string | null) => {
        set((state) => {
          state.currentProjectId = projectId;
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

      // Sync AI provider from settings and encrypted vault
      // This calls a backend command that securely retrieves the API key
      // from the encrypted vault and configures the AI provider
      syncFromSettings: async () => {
        try {
          logger.info('Syncing AI provider from vault...');

          // Call backend to sync from vault - the API key never leaves the backend
          const status = await invoke<ProviderStatus>('sync_ai_from_vault');

          // Update local state with the result
          set((state) => {
            state.providerStatus = status;
          });

          if (status.isConfigured && status.isAvailable) {
            logger.info('AI provider synced successfully from vault', {
              provider: status.providerType,
              model: status.currentModel,
            });
          } else if (status.isConfigured && !status.isAvailable) {
            logger.warn('AI provider configured but not available', {
              provider: status.providerType,
              error: status.errorMessage,
            });
          } else {
            logger.info('AI provider not configured', {
              provider: status.providerType,
              message: status.errorMessage,
            });
          }
        } catch (error) {
          logger.error('Failed to sync AI provider from vault', { error });
          // Don't throw - just log the error and leave provider unconfigured
          set((state) => {
            state.providerStatus = {
              providerType: null,
              isConfigured: false,
              isAvailable: false,
              currentModel: null,
              availableModels: [],
              errorMessage: error instanceof Error ? error.message : String(error),
            };
          });
        }
      },
    })),
      {
        name: 'openreelio-ai-store',
        // Don't persist providerStatus - it will be synced from settingsStore on load
        // This prevents stale state issues where frontend thinks provider is configured
        // but backend (which resets on restart) doesn't have the provider
        partialize: () => ({}),
      }
    )
  )
);

// =============================================================================
// Chat Persistence Subscription
// =============================================================================

// Subscribe to chat message changes and auto-save to localStorage
useAIStore.subscribe(
  (state) => ({ messages: state.chatMessages, projectId: state.currentProjectId }),
  ({ messages, projectId }) => {
    if (projectId && messages.length > 0) {
      debouncedSaveChatHistory(projectId, messages);
    }
  },
  { equalityFn: (a, b) => a.messages === b.messages && a.projectId === b.projectId }
);

// Cleanup old histories on module load
if (typeof window !== 'undefined') {
  cleanupOldHistories();
}

// =============================================================================
// Settings Sync Subscription
// =============================================================================

// Flag to prevent re-entrant sync
let isSyncingFromSettings = false;

/**
 * Subscribe to SettingsStore AI settings changes and auto-sync to AIStore.
 * This ensures changes in global settings are reflected in the AI sidebar.
 */
async function setupSettingsSyncSubscription(): Promise<void> {
  try {
    // Dynamically import to avoid circular dependency
    const { useSettingsStore } = await import('@/stores/settingsStore');

    // Subscribe to AI settings changes
    useSettingsStore.subscribe((state, prevState) => {
      // Skip if we're already syncing (prevent loops)
      if (isSyncingFromSettings) return;

      const aiSettings = state.settings.ai;
      const prevAiSettings = prevState.settings.ai;

      // Check if relevant settings changed
      const providerChanged = aiSettings.primaryProvider !== prevAiSettings.primaryProvider;
      const modelChanged = aiSettings.primaryModel !== prevAiSettings.primaryModel;
      const openaiKeyChanged = aiSettings.openaiApiKey !== prevAiSettings.openaiApiKey;
      const anthropicKeyChanged = aiSettings.anthropicApiKey !== prevAiSettings.anthropicApiKey;
      const googleKeyChanged = aiSettings.googleApiKey !== prevAiSettings.googleApiKey;
      const ollamaUrlChanged = aiSettings.ollamaUrl !== prevAiSettings.ollamaUrl;

      const hasRelevantChange =
        providerChanged ||
        modelChanged ||
        openaiKeyChanged ||
        anthropicKeyChanged ||
        googleKeyChanged ||
        ollamaUrlChanged;

      if (!hasRelevantChange) return;

      logger.info('AI settings changed in global settings, syncing to AI provider', {
        providerChanged,
        modelChanged,
      });

      void (async () => {
        isSyncingFromSettings = true;
        try {
          await useAIStore.getState().syncFromSettings();
        } finally {
          isSyncingFromSettings = false;
        }
      })();
    });

    logger.debug('Settings sync subscription established');
  } catch (error) {
    logger.error('Failed to setup settings sync subscription', { error });
  }
}

// Setup subscription on module load (browser only)
if (typeof window !== 'undefined') {
  // Delay slightly to ensure stores are initialized
  setTimeout(() => {
    setupSettingsSyncSubscription().catch((error) => {
      logger.warn('Settings sync subscription setup failed', { error });
    });
  }, 100);
}

// =============================================================================
// Event Listeners
// =============================================================================

let aiEventUnlisteners: UnlistenFn[] = [];
let isSettingUpAIListeners = false;

function isTauriRuntime(): boolean {
  return typeof (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== 'undefined';
}

/**
 * Setup event listeners for AI-related events.
 *
 * Features:
 * - Re-entrant safe: prevents duplicate setup during async operations
 * - Error resilient: continues even if individual listeners fail
 * - Hot reload safe: cleans up existing listeners before setting up new ones
 */
export async function setupAIEventListeners(): Promise<void> {
  // Prevent re-entrant setup (especially during hot reload)
  if (isSettingUpAIListeners) {
    logger.debug('AI event listener setup already in progress');
    return;
  }

  isSettingUpAIListeners = true;

  try {
    await cleanupAIEventListeners();

    if (!isTauriRuntime()) {
      logger.debug('Skipping AI event listeners in non-Tauri environment');
      return;
    }

    const newUnlisteners: UnlistenFn[] = [];

    // Listen for AI completion events
    try {
      const unlistenCompletion = await listen<{ jobId: string; result: unknown }>(
        'ai-completion',
        (event) => {
          logger.info('AI completion event received', { jobId: event.payload.jobId });
        }
      );
      newUnlisteners.push(unlistenCompletion);
    } catch (error) {
      logger.error('Failed to setup ai-completion listener', { error });
    }

    // Listen for transcription complete events
    try {
      const unlistenTranscription = await listen<{ assetId: string; text: string }>(
        'transcription-complete',
        (event) => {
          logger.info('Transcription complete', { assetId: event.payload.assetId });
        }
      );
      newUnlisteners.push(unlistenTranscription);
    } catch (error) {
      logger.error('Failed to setup transcription-complete listener', { error });
    }

    // Only assign after all setup attempts complete
    aiEventUnlisteners = newUnlisteners;
    logger.info('AI event listeners initialized', { listenerCount: newUnlisteners.length });
  } finally {
    isSettingUpAIListeners = false;
  }
}

/**
 * Cleanup AI event listeners.
 * Safe to call multiple times - will not throw.
 */
export async function cleanupAIEventListeners(): Promise<void> {
  const listenersToCleanup = aiEventUnlisteners;
  aiEventUnlisteners = [];

  for (const unlisten of listenersToCleanup) {
    try {
      unlisten();
    } catch (error) {
      logger.warn('Error during AI listener cleanup', { error });
    }
  }

  if (listenersToCleanup.length > 0) {
    logger.debug('AI event listeners cleaned up', { count: listenersToCleanup.length });
  }
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

// =============================================================================
// Agent System Initialization
// =============================================================================

let isAgentSystemInitialized = false;

/**
 * Initialize the AI agent system.
 * Registers editing tools and sets up the agent framework.
 * Safe to call multiple times - will only initialize once.
 */
export function initializeAgentSystem(): void {
  if (isAgentSystemInitialized) {
    logger.debug('Agent system already initialized');
    return;
  }

  // Register editing tools with the global registry
  registerEditingTools();

  isAgentSystemInitialized = true;
  logger.info('Agent system initialized', {
    toolCount: globalToolRegistry.listAll().length,
  });
}

/**
 * Check if the agent system is initialized.
 */
export function isAgentInitialized(): boolean {
  return isAgentSystemInitialized;
}

/**
 * Get the list of available agent tools.
 */
export function getAvailableAgentTools(): string[] {
  return globalToolRegistry.listAll().map((t) => t.name);
}
