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
  pendingToolPermissionRequest: null,
};

export function useExternalAgentChatRuntime(
  options: UseExternalAgentChatRuntimeOptions,
): UseExternalAgentChatRuntimeResult {
  const [state, setState] = useState<ExternalAgentChatRuntimeState>(INITIAL_STATE);
  const conversation = useMemo(() => createConversationStoreExternalAgentGateway(), []);
  const controllerRef = useRef<ExternalAgentChatRuntimeController | null>(null);
  const activeSessionId = useConversationStore((store) => store.activeSessionId);

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

  useEffect(() => {
    controllerRef.current?.updateContext({
      adapter: options.adapter,
      projectId: options.projectId,
      cwd: options.cwd,
      enabled: options.enabled,
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
      controllerRef.current?.dispose();
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
