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
  createClarificationPart,
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
 *
 * Tracks the target sessionId so events continue to update the
 * original transcript even after the user opens another session.
 */
export function useAgentEventHandler() {
  const messageIdRef = useRef<string | null>(null);
  const messageIdBySessionRef = useRef<Map<string, string>>(new Map());

  const getOnlyTrackedMessageId = useCallback((): string | null => {
    const tracked = Array.from(messageIdBySessionRef.current.values());
    return tracked.length === 1 ? tracked[0] : null;
  }, []);

  const getMessageIdForEvent = useCallback(
    (event: AgentEvent): string | null => {
      const sessionId =
        event.sessionId || (event.type === 'session_complete' ? event.summary.sessionId : null);

      if (sessionId) {
        return messageIdBySessionRef.current.get(sessionId) ?? null;
      }

      return getOnlyTrackedMessageId() ?? messageIdRef.current;
    },
    [getOnlyTrackedMessageId],
  );

  const forgetMessageIdForEvent = useCallback(
    (event: AgentEvent, messageId: string): void => {
      const sessionId =
        event.sessionId || (event.type === 'session_complete' ? event.summary.sessionId : null);

      if (sessionId) {
        if (messageIdBySessionRef.current.get(sessionId) === messageId) {
          messageIdBySessionRef.current.delete(sessionId);
        }
      } else {
        for (const [trackedSessionId, trackedMessageId] of messageIdBySessionRef.current) {
          if (trackedMessageId === messageId) {
            messageIdBySessionRef.current.delete(trackedSessionId);
          }
        }
      }

      if (messageIdRef.current === messageId) {
        messageIdRef.current = getOnlyTrackedMessageId();
      }
    },
    [getOnlyTrackedMessageId],
  );

  const handleEvent = useCallback(
    (event: AgentEvent) => {
      const store = useConversationStore.getState();

      switch (event.type) {
        case 'session_start': {
          const msgId = store.startAssistantMessage(event.sessionId);
          messageIdBySessionRef.current.set(event.sessionId, msgId);
          messageIdRef.current = msgId;
          break;
        }

        case 'thinking_complete': {
          const messageId = getMessageIdForEvent(event);
          if (messageId) {
            store.appendPart(messageId, createThinkingPart(event.thought));
          }
          break;
        }

        case 'clarification_required': {
          const messageId = getMessageIdForEvent(event);
          if (messageId) {
            store.appendPart(messageId, createClarificationPart(event.question));
          }
          break;
        }

        case 'planning_complete': {
          const messageId = getMessageIdForEvent(event);
          if (messageId) {
            store.appendPart(messageId, createPlanPart(event.plan, 'proposed'));
          }
          break;
        }

        case 'approval_required': {
          const messageId = getMessageIdForEvent(event);
          if (messageId) {
            store.appendPart(messageId, createApprovalPart(event.plan, 'pending'));
          }
          break;
        }

        case 'approval_response': {
          const messageId = getMessageIdForEvent(event);
          if (messageId) {
            // Update approval/plan status parts so UI reflects the user decision.
            const parts = store.getMessageParts(messageId);
            if (parts) {
              const approvalPartIndex = parts.findIndex(
                (p) => p.type === 'approval' && p.status === 'pending',
              );
              if (approvalPartIndex >= 0) {
                store.updatePart(messageId, approvalPartIndex, {
                  status: event.approved ? 'approved' : 'rejected',
                });
              }

              const planPartIndex = parts.findIndex(
                (p) => p.type === 'plan' && p.status === 'proposed',
              );
              if (planPartIndex >= 0) {
                store.updatePart(messageId, planPartIndex, {
                  status: event.approved ? 'approved' : 'rejected',
                });
              }
            }
          }
          break;
        }

        case 'execution_start': {
          const messageId = getMessageIdForEvent(event);
          if (messageId) {
            store.appendPart(messageId, {
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
          const messageId = getMessageIdForEvent(event);
          if (messageId) {
            // Update the tool_call status to completed
            const parts = store.getMessageParts(messageId);
            if (parts) {
              const callIndex = parts.findIndex(
                (p) =>
                  p.type === 'tool_call' && p.stepId === event.step.id && p.status === 'running',
              );
              if (callIndex >= 0) {
                store.updatePart(messageId, callIndex, {
                  status: event.result.success ? 'completed' : 'failed',
                });
              }
            }

            // Add tool result part
            store.appendPart(
              messageId,
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
          const messageId = getMessageIdForEvent(event);
          if (messageId) {
            store.appendPart(messageId, createTextPart(event.observation.summary));
          }
          break;
        }

        case 'session_complete': {
          const messageId = getMessageIdForEvent(event);
          if (messageId) {
            store.finalizeMessage(messageId);
            forgetMessageIdForEvent(event, messageId);
          }
          break;
        }

        case 'session_failed': {
          const messageId = getMessageIdForEvent(event);
          if (messageId) {
            const error = event.error;
            store.appendPart(
              messageId,
              createErrorPart(
                isAgentError(error) ? error.code : 'UNKNOWN',
                error.message,
                isAgentError(error) ? error.phase : 'unknown',
                isAgentError(error) ? error.recoverable : false,
              ),
            );
            store.finalizeMessage(messageId);
            forgetMessageIdForEvent(event, messageId);
          }
          break;
        }

        case 'session_aborted': {
          const messageId = getMessageIdForEvent(event);
          if (messageId) {
            store.appendPart(messageId, createTextPart(`Session aborted: ${event.reason}`));
            store.finalizeMessage(messageId);
            forgetMessageIdForEvent(event, messageId);
          }
          break;
        }

        case 'tool_permission_request': {
          const messageId = getMessageIdForEvent(event);
          if (messageId) {
            store.appendPart(messageId, {
              type: 'tool_approval',
              stepId: event.step.id,
              tool: event.step.tool,
              args: event.step.args,
              description: event.step.description,
              riskLevel: event.step.riskLevel,
              status: 'pending',
            });
          }
          break;
        }

        case 'tool_permission_response': {
          const messageId = getMessageIdForEvent(event);
          if (messageId) {
            const parts = store.getMessageParts(messageId);
            if (parts) {
              const approvalIndex = parts.findIndex(
                (p) =>
                  p.type === 'tool_approval' &&
                  p.stepId === event.step.id &&
                  p.status === 'pending',
              );
              if (approvalIndex >= 0) {
                store.updatePart(messageId, approvalIndex, {
                  status: event.decision === 'deny' ? 'denied' : 'approved',
                });
              }
            }
          }
          break;
        }

        case 'doom_loop_detected': {
          const messageId = getMessageIdForEvent(event);
          if (messageId) {
            store.appendPart(
              messageId,
              createErrorPart(
                'DOOM_LOOP',
                `Detected repetitive loop: tool "${event.tool}" called ${event.count} times with identical arguments. Stopping execution.`,
                'executing',
                false,
              ),
            );
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
    },
    [forgetMessageIdForEvent, getMessageIdForEvent],
  );

  return { handleEvent, messageIdRef };
}
