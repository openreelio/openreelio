import { useCallback, useEffect, useRef, useState } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

import { commands } from '@/bindings';

/**
 * Phases of the fully in-app Claude subscription sign-in.
 *
 * - `idle`: no session running.
 * - `starting`: the backend is spawning `claude setup-token` under a PTY.
 * - `browser`: waiting for the user to complete the browser OAuth handshake.
 * - `awaitingCode`: the CLI is asking for the authorization code to be pasted.
 * - `submitting`: the pasted code was sent; waiting for the token.
 * - `success`: the token was captured and stored server-side.
 * - `error`: the flow failed (surface `error` and let the user retry).
 */
export type ClaudeLoginPhase =
  | 'idle'
  | 'starting'
  | 'browser'
  | 'awaitingCode'
  | 'submitting'
  | 'success'
  | 'error';

/**
 * Stream event emitted by the backend on `claude:login:{sessionId}`. Mirrors the
 * Rust `ClaudeLoginEvent` enum (serde-tagged by `type`). Defined locally — like
 * the headless transport's event union — so the UI does not depend on the event
 * payload being wired into the generated bindings.
 */
type ClaudeLoginStreamEvent =
  | { type: 'state'; state: string }
  | { type: 'url'; url: string }
  | { type: 'awaitingCode' }
  | { type: 'output'; text: string }
  | { type: 'success'; authStatus: string }
  | { type: 'error'; message: string }
  | { type: 'exit' };

export interface ClaudeLoginSession {
  /** Current phase of the sign-in flow. */
  phase: ClaudeLoginPhase;
  /** Fallback sign-in URL, when the CLI surfaced one. */
  url: string | null;
  /** Failure message, when `phase === 'error'`. */
  error: string | null;
  /** Recent (secret-redacted) CLI output lines, for in-flow diagnostics. */
  recentOutput: string[];
  /** Whether a session is currently in flight (start/browser/code/submitting). */
  isActive: boolean;
  /** Starts a fresh in-app sign-in session. */
  start: () => Promise<void>;
  /** Submits the authorization code the user pasted. */
  submitCode: (code: string) => Promise<void>;
  /** Cancels the running session and resets to idle. */
  cancel: () => Promise<void>;
}

export interface UseClaudeLoginSessionOptions {
  /** Called when sign-in completes; receives the re-probed auth status. */
  onSuccess?: (authStatus: string) => void;
  /** Called when the flow fails. */
  onError?: (message: string) => void;
}

/** Prefix must match the backend `CLAUDE_LOGIN_EVENT_PREFIX`. */
const CLAUDE_LOGIN_EVENT_PREFIX = 'claude:login';

function claudeLoginEventName(sessionId: string): string {
  return `${CLAUDE_LOGIN_EVENT_PREFIX}:${sessionId}`;
}

function generateSessionId(): string {
  const cryptoObj = globalThis.crypto;
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
    return cryptoObj.randomUUID();
  }
  return `claude-login-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

const ACTIVE_PHASES: ReadonlySet<ClaudeLoginPhase> = new Set<ClaudeLoginPhase>([
  'starting',
  'browser',
  'awaitingCode',
  'submitting',
]);

/**
 * Drives the fully in-app Claude subscription sign-in.
 *
 * The client generates the session id up front so the stream event name is known
 * before the backend spawns the process; the listener is attached BEFORE
 * `startClaudeLoginSession` is invoked so no early event can be missed (Tauri
 * does not buffer events for absent listeners). The OAuth token is captured and
 * persisted server-side and never crosses the event channel — completion arrives
 * as a `success` event carrying only the re-probed auth status.
 */
export function useClaudeLoginSession(
  options: UseClaudeLoginSessionOptions = {},
): ClaudeLoginSession {
  const [phase, setPhase] = useState<ClaudeLoginPhase>('idle');
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recentOutput, setRecentOutput] = useState<string[]>([]);

  const sessionIdRef = useRef<string | null>(null);
  const unlistenRef = useRef<UnlistenFn | null>(null);
  const phaseRef = useRef<ClaudeLoginPhase>('idle');
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
    (event: ClaudeLoginStreamEvent) => {
      switch (event.type) {
        case 'state':
          if (event.state === 'browserOpening') {
            setPhase('browser');
          }
          return;
        case 'url':
          setUrl(event.url);
          return;
        case 'awaitingCode':
          setPhase('awaitingCode');
          return;
        case 'output': {
          // Secret-redacted (backend-side) progress lines, surfaced as a small
          // diagnostic so a stuck flow shows exactly what the CLI printed.
          const lines = event.text
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean);
          if (lines.length > 0) {
            setRecentOutput((prev) => [...prev, ...lines].slice(-8));
          }
          return;
        }
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
    setRecentOutput([]);
    setPhase('starting');

    const sessionId = generateSessionId();
    const eventName = claudeLoginEventName(sessionId);

    // Subscribe BEFORE the backend can emit so no early event is dropped.
    try {
      unlistenRef.current = await listen<ClaudeLoginStreamEvent>(eventName, (event) =>
        handleEvent(event.payload),
      );
    } catch (listenError) {
      const message = listenError instanceof Error ? listenError.message : String(listenError);
      setPhase('error');
      setError(message);
      optionsRef.current.onError?.(message);
      return;
    }

    // Expose the id BEFORE the backend call so `cancel()` during startup can
    // reach the session instead of finding a null ref.
    sessionIdRef.current = sessionId;

    try {
      const result = await commands.startClaudeLoginSession(sessionId);
      if (sessionIdRef.current !== sessionId) {
        // cancel() (or a newer start) ran while startup was in flight. The
        // backend session may have outlived the cancel that raced it — cancel
        // again now that it definitely exists, and leave the UI state alone.
        detachListener();
        void commands.cancelClaudeLoginSession(sessionId).catch(() => undefined);
        return;
      }
      if (result.status === 'error') {
        detachListener();
        sessionIdRef.current = null;
        setPhase('error');
        setError(result.error);
        optionsRef.current.onError?.(result.error);
        return;
      }
      // The event name is deterministic, but honor the backend value if it drifts.
      if (result.data.eventName !== eventName) {
        detachListener();
        unlistenRef.current = await listen<ClaudeLoginStreamEvent>(
          result.data.eventName,
          (event) => handleEvent(event.payload),
        );
      }
      // Only advance out of `starting` if a stream event has not already moved us.
      setPhase((current) => (current === 'starting' ? 'browser' : current));
    } catch (startError) {
      // An IPC-level rejection (not a command-declared error) would otherwise
      // strand the UI in `starting` with a leaked listener and possibly a live
      // PTY session — tear everything down and surface the failure.
      detachListener();
      sessionIdRef.current = null;
      void commands.cancelClaudeLoginSession(sessionId).catch(() => undefined);
      const message = startError instanceof Error ? startError.message : String(startError);
      setPhase('error');
      setError(message);
      optionsRef.current.onError?.(message);
    }
  }, [detachListener, handleEvent]);

  const submitCode = useCallback(async (code: string) => {
    const sessionId = sessionIdRef.current;
    const trimmed = code.trim();
    if (!sessionId || !trimmed) {
      return;
    }
    setPhase('submitting');
    setError(null);
    try {
      const result = await commands.submitClaudeLoginCode(sessionId, trimmed);
      if (result.status === 'error') {
        setPhase('awaitingCode');
        setError(result.error);
      }
    } catch (submitError) {
      // Return to the code prompt instead of hanging in `submitting`.
      const message = submitError instanceof Error ? submitError.message : String(submitError);
      setPhase('awaitingCode');
      setError(message);
    }
  }, []);

  const cancel = useCallback(async () => {
    const sessionId = sessionIdRef.current;
    detachListener();
    sessionIdRef.current = null;
    setPhase('idle');
    setUrl(null);
    setError(null);
    if (sessionId) {
      // Best-effort: the UI is already reset either way.
      await commands.cancelClaudeLoginSession(sessionId).catch(() => undefined);
    }
  }, [detachListener]);

  // Best-effort teardown on unmount: drop the listener and cancel any live
  // session so no orphaned PTY child is left running.
  useEffect(() => {
    return () => {
      unlistenRef.current?.();
      unlistenRef.current = null;
      const sessionId = sessionIdRef.current;
      sessionIdRef.current = null;
      if (sessionId) {
        void commands.cancelClaudeLoginSession(sessionId);
      }
    };
  }, []);

  return {
    phase,
    url,
    error,
    recentOutput,
    isActive: ACTIVE_PHASES.has(phase),
    start,
    submitCode,
    cancel,
  };
}
