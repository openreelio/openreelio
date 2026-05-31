import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  createConversationStoreExternalAgentGateway,
  ExternalAgentChatRuntimeController,
  type ExternalAgentChatRuntimeState,
} from './chatRuntime';
import type { ExternalAgentApprovalDecision, ExternalAgentRuntimeAdapter } from './types';
import type { ExternalAgentApprovalBroker } from './approvalBroker';
import type { ExternalAgentSessionPersistence } from './sessionPersistence';
import { useConversationStore } from '@/stores/conversationStore';

export interface UseExternalAgentChatRuntimeOptions {
  adapter: ExternalAgentRuntimeAdapter;
  projectId: string | null;
  cwd?: string | null;
  enabled?: boolean;
  approvalBroker?: ExternalAgentApprovalBroker;
  sessionPersistence?: ExternalAgentSessionPersistence;
  retainAcrossUnmount?: boolean;
  onComplete?: () => void;
  onAbort?: () => void;
  onError?: (error: Error) => void;
}

export interface UseExternalAgentChatRuntimeResult extends ExternalAgentChatRuntimeState {
  executeMessage: (message: string) => Promise<void>;
  abort: () => void;
  resolveApproval: (decision: ExternalAgentApprovalDecision) => void;
}

const INITIAL_STATE: ExternalAgentChatRuntimeState = {
  phase: 'idle',
  isRunning: false,
  error: null,
  startedTools: 0,
  completedTools: 0,
  latestIteration: 0,
  currentActivity: null,
  runStartedAt: null,
  lastActivityAt: null,
  pendingToolPermissionRequest: null,
};

const retainedRuntimeControllers = new Map<string, ExternalAgentChatRuntimeController>();

function getRetainedRuntimeKey(
  options: UseExternalAgentChatRuntimeOptions,
  activeSessionId: string | null,
): string | null {
  if (!options.retainAcrossUnmount || !options.projectId || !activeSessionId) {
    return null;
  }

  return `${options.adapter.id}:${options.projectId}:${activeSessionId}`;
}

export function useExternalAgentChatRuntime(
  options: UseExternalAgentChatRuntimeOptions,
): UseExternalAgentChatRuntimeResult {
  const [state, setState] = useState<ExternalAgentChatRuntimeState>(INITIAL_STATE);
  const conversation = useMemo(() => createConversationStoreExternalAgentGateway(), []);
  const controllerRef = useRef<ExternalAgentChatRuntimeController | null>(null);
  const retainKeyRef = useRef<string | null>(null);
  const activeSessionId = useConversationStore((store) => store.activeSessionId);
  const retainKey = getRetainedRuntimeKey(options, activeSessionId);

  if (!controllerRef.current) {
    controllerRef.current =
      retainKey !== null ? (retainedRuntimeControllers.get(retainKey) ?? null) : null;

    if (!controllerRef.current) {
      controllerRef.current = new ExternalAgentChatRuntimeController({
        adapter: options.adapter,
        conversation,
        projectId: options.projectId,
        cwd: options.cwd,
        enabled: options.enabled,
        approvalBroker: options.approvalBroker,
        sessionPersistence: options.sessionPersistence,
        onStateChange: setState,
        onComplete: options.onComplete,
        onAbort: options.onAbort,
        onError: options.onError,
      });
    }

    if (retainKey !== null) {
      retainedRuntimeControllers.set(retainKey, controllerRef.current);
      retainKeyRef.current = retainKey;
    }
  }

  useEffect(() => {
    const controller = controllerRef.current;
    if (!controller || retainKey === retainKeyRef.current) {
      return;
    }

    const previousKey = retainKeyRef.current;
    if (previousKey && retainedRuntimeControllers.get(previousKey) === controller) {
      retainedRuntimeControllers.delete(previousKey);
    }

    if (retainKey !== null) {
      retainedRuntimeControllers.set(retainKey, controller);
    }
    retainKeyRef.current = retainKey;
  }, [retainKey]);

  useEffect(() => {
    controllerRef.current?.updateContext({
      adapter: options.adapter,
      projectId: options.projectId,
      cwd: options.cwd,
      enabled: options.enabled,
      onStateChange: setState,
      onComplete: options.onComplete,
      onAbort: options.onAbort,
      onError: options.onError,
    });
  }, [
    options.adapter,
    options.cwd,
    options.enabled,
    options.onAbort,
    options.onComplete,
    options.onError,
    options.projectId,
  ]);

  useEffect(() => {
    return () => {
      const controller = controllerRef.current;
      controller?.updateCallbacks({ onStateChange: null });
      const retainedKey = retainKeyRef.current;
      if (controller && retainedKey && controller.hasRunningState()) {
        controllerRef.current = null;
        return;
      }

      controller?.dispose();
      if (retainedKey && retainedRuntimeControllers.get(retainedKey) === controller) {
        retainedRuntimeControllers.delete(retainedKey);
      }
      controllerRef.current = null;
    };
  }, []);

  useEffect(() => {
    controllerRef.current?.refreshState();
  }, [activeSessionId]);

  const executeMessage = useCallback(async (message: string) => {
    await controllerRef.current?.sendMessage(message);
  }, []);

  const abort = useCallback(() => {
    void controllerRef.current?.interrupt();
  }, []);

  const resolveApproval = useCallback((decision: ExternalAgentApprovalDecision) => {
    controllerRef.current?.resolveApproval(decision);
  }, []);

  return {
    ...state,
    executeMessage,
    abort,
    resolveApproval,
  };
}
