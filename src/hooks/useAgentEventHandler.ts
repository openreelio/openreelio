/**
 * Agent Event Handler Hook
 *
 * Translates AgentEvent emissions from the AgenticEngine into
 * conversationStore mutations, creating the bridge between
 * the engine's event stream and the unified message model.
 */

import { useCallback, useRef } from 'react';
import { useConversationStore } from '@/stores/conversationStore';
import {
  createTextPart,
  createThinkingPart,
  createPlanPart,
  createToolResultPart,
  createErrorPart,
  createApprovalPart,
} from '@/agents/engine/core/conversation';
import type { AgentEvent } from '@/agents/engine';
import { isAgentError } from '@/agents/engine';

/**
 * Hook that returns an event handler translating AgentEvents
 * into conversationStore actions.
 */
export function useAgentEventHandler() {
  const messageIdRef = useRef<string | null>(null);

  const handleEvent = useCallback((event: AgentEvent) => {
    const store = useConversationStore.getState();

    switch (event.type) {
      case 'session_start': {
        // Start a new assistant message for this session
        const msgId = store.startAssistantMessage(event.sessionId);
        messageIdRef.current = msgId;
        break;
      }

      case 'thinking_complete': {
        if (messageIdRef.current) {
          store.appendPart(messageIdRef.current, createThinkingPart(event.thought));
        }
        break;
      }

      case 'clarification_required': {
        if (messageIdRef.current) {
          store.appendPart(messageIdRef.current, createTextPart(event.question));
        }
        break;
      }

      case 'planning_complete': {
        if (messageIdRef.current) {
          store.appendPart(messageIdRef.current, createPlanPart(event.plan, 'proposed'));
        }
        break;
      }

      case 'approval_required': {
        if (messageIdRef.current) {
          store.appendPart(messageIdRef.current, createApprovalPart(event.plan, 'pending'));
        }
        break;
      }

      case 'approval_response': {
        if (messageIdRef.current) {
          // Update approval/plan status parts so UI reflects the user decision.
          const conv = store.activeConversation;
          if (conv) {
            const msg = conv.messages.find((m) => m.id === messageIdRef.current);
            if (msg) {
              const approvalPartIndex = msg.parts.findIndex(
                (p) => p.type === 'approval' && p.status === 'pending',
              );
              if (approvalPartIndex >= 0) {
                store.updatePart(messageIdRef.current, approvalPartIndex, {
                  status: event.approved ? 'approved' : 'rejected',
                });
              }

              const planPartIndex = msg.parts.findIndex(
                (p) => p.type === 'plan' && p.status === 'proposed',
              );
              if (planPartIndex >= 0) {
                store.updatePart(messageIdRef.current, planPartIndex, {
                  status: event.approved ? 'approved' : 'rejected',
                });
              }
            }
          }
        }
        break;
      }

      case 'execution_start': {
        if (messageIdRef.current) {
          store.appendPart(messageIdRef.current, {
            type: 'tool_call',
            stepId: event.step.id,
            tool: event.step.tool,
            args: event.step.args,
            description: event.step.description,
            riskLevel: event.step.riskLevel,
            status: 'running',
            startedAt: event.timestamp,
          });
        }
        break;
      }

      case 'execution_complete': {
        if (messageIdRef.current) {
          // Update the tool_call status to completed
          const conv = store.activeConversation;
          if (conv) {
            const msg = conv.messages.find((m) => m.id === messageIdRef.current);
            if (msg) {
              const callIndex = msg.parts.findIndex(
                (p) =>
                  p.type === 'tool_call' && p.stepId === event.step.id && p.status === 'running',
              );
              if (callIndex >= 0) {
                store.updatePart(messageIdRef.current, callIndex, {
                  status: event.result.success ? 'completed' : 'failed',
                });
              }
            }
          }

          // Add tool result part
          store.appendPart(
            messageIdRef.current,
            createToolResultPart(
              event.step.id,
              event.step.tool,
              event.result.success,
              event.result.duration,
              event.result.data,
              event.result.error,
            ),
          );
        }
        break;
      }

      case 'observation_complete': {
        if (messageIdRef.current) {
          store.appendPart(messageIdRef.current, createTextPart(event.observation.summary));
        }
        break;
      }

      case 'session_complete': {
        if (messageIdRef.current) {
          store.finalizeMessage(messageIdRef.current);
          messageIdRef.current = null;
        }
        break;
      }

      case 'session_failed': {
        if (messageIdRef.current) {
          const error = event.error;
          store.appendPart(
            messageIdRef.current,
            createErrorPart(
              isAgentError(error) ? error.code : 'UNKNOWN',
              error.message,
              isAgentError(error) ? error.phase : 'unknown',
              isAgentError(error) ? error.recoverable : false,
            ),
          );
          store.finalizeMessage(messageIdRef.current);
          messageIdRef.current = null;
        }
        break;
      }

      case 'session_aborted': {
        if (messageIdRef.current) {
          store.appendPart(
            messageIdRef.current,
            createTextPart(`Session aborted: ${event.reason}`),
          );
          store.finalizeMessage(messageIdRef.current);
          messageIdRef.current = null;
        }
        break;
      }

      // Ignored events (handled by UI directly)
      case 'thinking_start':
      case 'thinking_progress':
      case 'planning_start':
      case 'planning_progress':
      case 'execution_progress':
      case 'iteration_complete':
        break;
    }
  }, []);

  return { handleEvent, messageIdRef };
}
