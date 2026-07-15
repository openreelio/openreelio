import { useCallback } from 'react';
import { Loader2, LogIn, X } from 'lucide-react';

import type { CodexLoginSession } from './useCodexLoginSession';

interface CodexLoginFlowProps {
  /** The streamed login session state and controls. */
  session: CodexLoginSession;
  /** Global disabled state from the settings panel. */
  disabled: boolean;
}

/**
 * Inline UI for the streamed, visible Codex sign-in. Driven by the session
 * phase: it shows browser-handshake progress and a selectable fallback sign-in
 * link. Unlike the Claude subscription flow there is no authorization code to
 * paste — the Codex CLI uses a loopback callback that auto-completes after the
 * user approves access in the browser.
 */
export function CodexLoginFlow({ session, disabled }: CodexLoginFlowProps): JSX.Element | null {
  const { phase, url, error, start, cancel } = session;

  const handleCopyUrl = useCallback(() => {
    if (url) {
      void navigator.clipboard?.writeText(url);
    }
  }, [url]);

  if (phase === 'idle' || phase === 'success') {
    return null;
  }

  const isError = phase === 'error';
  const busy = phase === 'starting' || phase === 'browser';

  const statusLine = ((): string => {
    switch (phase) {
      case 'starting':
        return 'Starting sign-in…';
      case 'browser':
        return 'Your browser opened to sign in to Codex. Approve access there to finish — this will complete on its own, no code to paste.';
      case 'error':
        return error ?? 'Sign-in could not be completed. Please try again.';
      default:
        return '';
    }
  })();

  return (
    <div
      data-testid="codex-login-flow"
      className={`mt-2 rounded border px-2 py-2 text-xs leading-5 ${
        isError
          ? 'border-yellow-600/20 bg-yellow-600/10 text-yellow-200'
          : 'border-primary-500/20 bg-primary-500/10 text-editor-text'
      }`}
    >
      <div className="flex items-start gap-2">
        {busy && <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin" />}
        <p className="min-w-0">{statusLine}</p>
      </div>

      {url && !isError && (
        <div className="mt-2">
          <p className="text-[11px] text-editor-text-muted">Browser didn&apos;t open? Open this link:</p>
          <div className="mt-1 flex items-center gap-2">
            <span className="min-w-0 flex-1 select-all break-all rounded border border-editor-border bg-editor-bg px-2 py-1 text-[11px] text-editor-text">
              {url}
            </span>
            <button
              type="button"
              onClick={handleCopyUrl}
              className="inline-flex h-7 shrink-0 items-center rounded border border-editor-border px-2 text-[11px] text-editor-text hover:bg-editor-bg-hover"
            >
              Copy
            </button>
          </div>
        </div>
      )}

      <div className="mt-2 flex items-center gap-2">
        {isError && (
          <button
            type="button"
            onClick={() => void start()}
            disabled={disabled}
            className="inline-flex h-7 items-center gap-1.5 rounded bg-primary-500 px-3 text-[11px] font-medium text-white hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <LogIn className="h-3 w-3" />
            Try again
          </button>
        )}
        <button
          type="button"
          onClick={() => void cancel()}
          disabled={disabled}
          className="inline-flex h-7 items-center gap-1.5 rounded border border-editor-border px-2 text-[11px] text-editor-text hover:bg-editor-bg-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          <X className="h-3 w-3" />
          {isError ? 'Dismiss' : 'Cancel'}
        </button>
      </div>
    </div>
  );
}

export default CodexLoginFlow;
