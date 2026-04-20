import { useCallback, useState } from 'react';

export type SessionTransitionLabel = 'new' | 'switch' | 'delegate' | null;

export interface UseAgentSessionTransitionResult {
  chatSurfaceKey: number;
  isSessionTransitionPending: boolean;
  sessionTransitionLabel: SessionTransitionLabel;
  runSessionTransition: (
    label: Exclude<SessionTransitionLabel, null>,
    action: () => Promise<unknown>,
  ) => Promise<void>;
  resetSessionTransition: (options?: { bumpChatSurfaceKey?: boolean }) => void;
}

export function useAgentSessionTransition(): UseAgentSessionTransitionResult {
  const [chatSurfaceKey, setChatSurfaceKey] = useState(0);
  const [isSessionTransitionPending, setIsSessionTransitionPending] = useState(false);
  const [sessionTransitionLabel, setSessionTransitionLabel] =
    useState<SessionTransitionLabel>(null);

  const resetSessionTransition = useCallback((options?: { bumpChatSurfaceKey?: boolean }) => {
    if (options?.bumpChatSurfaceKey) {
      setChatSurfaceKey((prev) => prev + 1);
    }
    setIsSessionTransitionPending(false);
    setSessionTransitionLabel(null);
  }, []);

  const runSessionTransition = useCallback(
    async (label: Exclude<SessionTransitionLabel, null>, action: () => Promise<unknown>) => {
      setIsSessionTransitionPending(true);
      setSessionTransitionLabel(label);
      setChatSurfaceKey((prev) => prev + 1);

      try {
        await action();
      } finally {
        setIsSessionTransitionPending(false);
        setSessionTransitionLabel(null);
      }
    },
    [],
  );

  return {
    chatSurfaceKey,
    isSessionTransitionPending,
    sessionTransitionLabel,
    runSessionTransition,
    resetSessionTransition,
  };
}
