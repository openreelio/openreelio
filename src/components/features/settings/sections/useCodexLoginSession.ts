import { useCallback, useEffect, useRef, useState } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

import { commands } from '@/bindings';

/**
 * Phases of the streamed, visible Codex sign-in.
 *
 * - `idle`: no session running.
 * - `starting`: the backend is spawning `codex login`.
 * - `browser`: waiting for the user to complete the browser OAuth handshake. The
 *   loopback callback auto-completes the flow — there is no code to paste.
 * - `success`: the CLI wrote credentials into `CODEX_HOME` and the re-probe
 *   reports an authenticated profile.
 * - `error`: the flow failed (surface `error` and let the user retry).
 */
export type CodexLoginPhase = 'idle' | 'starting' | 'browser' | 'success' | 'error';

/**
 * Stream event emitted by the backend on `codex:login:{sessionId}`. Mirrors the
 * Rust `CodexLoginEvent` enum (serde-tagged by `type`). Defined locally so the UI
 * does not depend on the event payload being wired into the generated bindings.
 */
type CodexLoginStreamEvent =
  | { type: 'state'; state: string }
  | { type: 'url'; url: string }
  | { type: 'output'; text: string }
  | { type: 'success'; authStatus: string }
  | { type: 'error'; message: string }
  | { type: 'exit' };

export interface CodexLoginSession {
  /** Current phase of the sign-in flow. */
  phase: CodexLoginPhase;
  /** Fallback sign-in URL, when the CLI surfaced one. */
  url: string | null;
  /** Failure message, when `phase === 'error'`. */
  error: string | null;
  /** Whether a session is currently in flight (starting/browser). */
  isActive: boolean;
  /** Starts a fresh streamed sign-in session. */
  start: () => Promise<void>;
  /** Cancels the running session and resets to idle. */
  cancel: () => Promise<void>;
}

export interface UseCodexLoginSessionOptions {
  /** Called when sign-in completes; receives the re-probed auth status. */
  onSuccess?: (authStatus: string) => void;
  /** Called when the flow fails. */
  onError?: (message: string) => void;
}

/** Prefix must match the backend `CODEX_LOGIN_EVENT_PREFIX`. */
const CODEX_LOGIN_EVENT_PREFIX = 'codex:login';

function codexLoginEventName(sessionId: string): string {
  return `${CODEX_LOGIN_EVENT_PREFIX}:${sessionId}`;
}

function generateSessionId(): string {
  const cryptoObj = globalThis.crypto;
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
    return cryptoObj.randomUUID();
  }
  return `codex-login-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

const ACTIVE_PHASES: ReadonlySet<CodexLoginPhase> = new Set<CodexLoginPhase>([
  'starting',
  'browser',
]);

/**
 * Drives the streamed, visible Codex sign-in.
 *
 * The client generates the session id up front so the stream event name is known
 * before the backend spawns the process; the listener is attached BEFORE
 * `startCodexLoginSession` is invoked so no early event can be missed (Tauri does
 * not buffer events for absent listeners). Credentials are written into
 * `CODEX_HOME` by the CLI and never cross the event channel — completion arrives
 * as a `success` event carrying only the re-probed auth status.
 */
export function useCodexLoginSession(
  options: UseCodexLoginSessionOptions = {},
): CodexLoginSession {
  const [phase, setPhase] = useState<CodexLoginPhase>('idle');
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const sessionIdRef = useRef<string | null>(null);
  const unlistenRef = useRef<UnlistenFn | null>(null);
  const phaseRef = useRef<CodexLoginPhase>('idle');
  const optionsRef = useRef(options);

  useEffect(() => {
    optionsRef.current = options;
  }, [options]);

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  const detachListener = useCallback(() => {
    unlistenRef.current?.();
    unlistenRef.current = null;
  }, []);

  const handleEvent = useCallback(
    (event: CodexLoginStreamEvent) => {
      switch (event.type) {
        case 'state':
          if (event.state === 'browserOpening') {
            setPhase('browser');
          }
          return;
        case 'url':
          setUrl(event.url);
          return;
        case 'output':
          // Raw progress is intentionally not surfaced as UI text; the phase
          // signals drive the visible state. Kept in the contract so the flow
          // can be extended without a backend change.
          return;
        case 'success':
          setPhase('success');
          detachListener();
          sessionIdRef.current = null;
          optionsRef.current.onSuccess?.(event.authStatus);
          return;
        case 'error':
          setPhase('error');
          setError(event.message);
          detachListener();
          sessionIdRef.current = null;
          optionsRef.current.onError?.(event.message);
          return;
        case 'exit':
          if (phaseRef.current !== 'success' && phaseRef.current !== 'error') {
            setPhase('error');
            setError('Sign-in ended before it finished. Please try again.');
            optionsRef.current.onError?.('Sign-in ended before it finished.');
          }
          detachListener();
          sessionIdRef.current = null;
          return;
      }
    },
    [detachListener],
  );

  const start = useCallback(async () => {
    if (ACTIVE_PHASES.has(phaseRef.current)) {
      return;
    }
    detachListener();
    setError(null);
    setUrl(null);
    setPhase('starting');

    const sessionId = generateSessionId();
    const eventName = codexLoginEventName(sessionId);

    // Subscribe BEFORE the backend can emit so no early event is dropped.
    try {
      unlistenRef.current = await listen<CodexLoginStreamEvent>(eventName, (event) =>
        handleEvent(event.payload),
      );
    } catch (listenError) {
      const message = listenError instanceof Error ? listenError.message : String(listenError);
      setPhase('error');
      setError(message);
      optionsRef.current.onError?.(message);
      return;
    }

    const result = await commands.startCodexLoginSession(sessionId);
    if (result.status === 'error') {
      detachListener();
      setPhase('error');
      setError(result.error);
      optionsRef.current.onError?.(result.error);
      return;
    }

    sessionIdRef.current = result.data.sessionId;
    // The event name is deterministic, but honor the backend value if it drifts.
    if (result.data.eventName !== eventName) {
      detachListener();
      unlistenRef.current = await listen<CodexLoginStreamEvent>(
        result.data.eventName,
        (event) => handleEvent(event.payload),
      );
    }
    // Only advance out of `starting` if a stream event has not already moved us.
    setPhase((current) => (current === 'starting' ? 'browser' : current));
  }, [detachListener, handleEvent]);

  const cancel = useCallback(async () => {
    const sessionId = sessionIdRef.current;
    detachListener();
    sessionIdRef.current = null;
    setPhase('idle');
    setUrl(null);
    setError(null);
    if (sessionId) {
      await commands.cancelCodexLoginSession(sessionId);
    }
  }, [detachListener]);

  // Best-effort teardown on unmount: drop the listener and cancel any live
  // session so no orphaned login child is left running.
  useEffect(() => {
    return () => {
      unlistenRef.current?.();
      unlistenRef.current = null;
      const sessionId = sessionIdRef.current;
      sessionIdRef.current = null;
      if (sessionId) {
        void commands.cancelCodexLoginSession(sessionId);
      }
    };
  }, []);

  return {
    phase,
    url,
    error,
    isActive: ACTIVE_PHASES.has(phase),
    start,
    cancel,
  };
}
