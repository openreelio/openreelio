/**
 * Agent Loop Event Handler Hook
 *
 * Bridges AgentLoopEvent emissions into the conversation store's
 * multi-part message model so the fast loop can render in the same chat UI.
 */

import { useCallback, useRef } from 'react';
import {
  createCompactionPart,
  createErrorPart,
  createReasoningPart,
  createTextPart,
  createToolResultPart,
} from '@/agents/engine/core/conversation';
import type { AgentLoopEvent } from '@/agents/engine/AgentLoop';
import { useConversationStore } from '@/stores/conversationStore';

type ToolPermissionDecision = 'allow' | 'deny' | 'allow_always';

export function useAgentLoopEventHandler() {
  const messageIdRef = useRef<string | null>(null);
  const boundSessionIdRef = useRef<string | null>(null);

  const getBoundMessageId = useCallback((): string | null => {
    const store = useConversationStore.getState();
    const activeSessionId = store.activeSessionId ?? null;

    if (
      boundSessionIdRef.current
      && activeSessionId
      && activeSessionId !== boundSessionIdRef.current
    ) {
      return null;
    }

    if (!messageIdRef.current) {
      boundSessionIdRef.current = activeSessionId;
      messageIdRef.current = store.startAssistantMessage(activeSessionId ?? undefined);
    }

    return messageIdRef.current;
  }, []);

  const updateTrailingPart = useCallback(
    (
      messageId: string,
      type: 'text' | 'reasoning',
      appendContent: string,
    ): void => {
      const store = useConversationStore.getState();
      const message = store.activeConversation?.messages.find((entry) => entry.id === messageId);
      if (!message) {
        return;
      }

      const lastIndex = message.parts.length - 1;
      const lastPart = lastIndex >= 0 ? message.parts[lastIndex] : null;
      if (!lastPart || lastPart.type !== type) {
        store.appendPart(
          messageId,
          type === 'text' ? createTextPart(appendContent) : createReasoningPart(appendContent),
        );
        return;
      }

      if (type === 'text') {
        store.updatePart(messageId, lastIndex, {
          content: lastPart.content + appendContent,
        });
        return;
      }

      store.updatePart(messageId, lastIndex, {
        content: lastPart.content + appendContent,
      });
    },
    [],
  );

  const updateToolApprovalStatus = useCallback(
    (messageId: string, stepId: string, decision: ToolPermissionDecision): void => {
      const store = useConversationStore.getState();
      const message = store.activeConversation?.messages.find((entry) => entry.id === messageId);
      if (!message) {
        return;
      }

      const approvalIndex = message.parts.findIndex(
        (part) => part.type === 'tool_approval' && part.stepId === stepId && part.status === 'pending',
      );
      if (approvalIndex < 0) {
        return;
      }

      store.updatePart(messageId, approvalIndex, {
        status: decision === 'deny' ? 'denied' : 'approved',
      });
    },
    [],
  );

  const finalizeBoundMessage = useCallback((tailText?: string): void => {
    const messageId = messageIdRef.current;
    if (!messageId) {
      return;
    }

    const store = useConversationStore.getState();
    if (tailText) {
      store.appendPart(messageId, createTextPart(tailText));
    }
    store.finalizeMessage(messageId);
    messageIdRef.current = null;
    boundSessionIdRef.current = null;
  }, []);

  const handleEvent = useCallback(
    (event: AgentLoopEvent) => {
      if (event.type === 'done' && !messageIdRef.current) {
        return;
      }

      const messageId = event.type === 'done' ? messageIdRef.current : getBoundMessageId();
      if (!messageId) {
        return;
      }

      const store = useConversationStore.getState();

      switch (event.type) {
        case 'text_delta':
          updateTrailingPart(messageId, 'text', event.content);
          break;

        case 'reasoning_delta':
          updateTrailingPart(messageId, 'reasoning', event.content);
          break;

        case 'tool_call_start':
          store.appendPart(messageId, {
            type: 'tool_call',
            stepId: event.id,
            tool: event.name,
            args: event.args,
            description: `Execute ${event.name}`,
            riskLevel: 'low',
            status: 'running',
            startedAt: Date.now(),
          });
          break;

        case 'tool_call_complete': {
          const message = store.activeConversation?.messages.find((entry) => entry.id === messageId);
          const callIndex = message?.parts.findIndex(
            (part) => part.type === 'tool_call' && part.stepId === event.id && part.status === 'running',
          ) ?? -1;

          if (callIndex >= 0) {
            store.updatePart(messageId, callIndex, {
              status: event.result.success ? 'completed' : 'failed',
            });
          }

          store.appendPart(
            messageId,
            createToolResultPart(
              event.id,
              event.name,
              event.result.success,
              event.result.duration,
              event.result.data,
              event.result.error,
            ),
          );
          break;
        }

        case 'tool_permission_request':
          store.appendPart(messageId, {
            type: 'tool_approval',
            stepId: event.id,
            tool: event.tool,
            args: event.args,
            description: `Permission required for ${event.tool}`,
            riskLevel: event.riskLevel,
            status: 'pending',
          });
          break;

        case 'tool_permission_response':
          updateToolApprovalStatus(messageId, event.id, event.decision);
          break;

        case 'tools_executed':
          break;

        case 'compacted':
          store.appendPart(messageId, createCompactionPart(event.summary, true));
          break;

        case 'doom_loop_detected':
          store.appendPart(
            messageId,
            createErrorPart(
              'DOOM_LOOP',
              `Doom loop detected: ${event.tool} called ${event.count} times`,
              'loop',
              false,
            ),
          );
          break;

        case 'error':
          store.appendPart(
            messageId,
            createErrorPart('AGENT_LOOP_ERROR', event.error.message, 'loop', false),
          );
          break;

        case 'done':
          finalizeBoundMessage();
          break;
      }
    },
    [finalizeBoundMessage, getBoundMessageId, updateToolApprovalStatus, updateTrailingPart],
  );

  const handleAbort = useCallback((reason = 'Session aborted by user'): void => {
    finalizeBoundMessage(reason);
  }, [finalizeBoundMessage]);

  const reset = useCallback((): void => {
    messageIdRef.current = null;
    boundSessionIdRef.current = null;
  }, []);

  return {
    handleEvent,
    handleAbort,
    reset,
  };
}
