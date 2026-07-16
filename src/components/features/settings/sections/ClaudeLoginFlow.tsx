import { useCallback, useState } from 'react';
import { Loader2, LogIn, X } from 'lucide-react';

import type { ClaudeLoginSession } from './useClaudeLoginSession';

interface ClaudeLoginFlowProps {
  /** The in-app login session state and controls. */
  session: ClaudeLoginSession;
  /** Global disabled state from the settings panel. */
  disabled: boolean;
}

/**
 * Inline UI for the fully in-app Claude subscription sign-in. Driven by the
 * session phase: it shows browser-handshake progress, a fallback sign-in link,
 * and — crucially for this manual code-paste flow — an authorization-code input
 * that is visible from the moment the session goes live. The CLI redirects to a
 * page that displays a code the user copies back into the app; there is no
 * localhost callback and the CLI's paste prompt does not reliably render in the
 * PTY transcript, so the input must NOT wait on an `awaitingCode` signal.
 */
export function ClaudeLoginFlow({ session, disabled }: ClaudeLoginFlowProps): JSX.Element | null {
  const { phase, url, error, recentOutput, start, submitCode, cancel } = session;
  const [codeInput, setCodeInput] = useState('');

  const handleSubmitCode = useCallback(async () => {
    const code = codeInput.trim();
    if (!code) {
      return;
    }
    try {
      await submitCode(code);
    } finally {
      setCodeInput('');
    }
  }, [codeInput, submitCode]);

  const handleCopyUrl = useCallback(() => {
    if (url) {
      void navigator.clipboard?.writeText(url);
    }
  }, [url]);

  if (phase === 'idle' || phase === 'success') {
    return null;
  }

  const isError = phase === 'error';
  const isSubmitting = phase === 'submitting';
  const busy = phase === 'starting' || isSubmitting;
  // The code input is shown as soon as the session is live (browser handshake
  // onward). `awaitingCode` is treated as cosmetic emphasis only.
  const showCodeInput = phase === 'browser' || phase === 'awaitingCode' || isSubmitting;
  // A failed code submission returns the flow to `awaitingCode` with `error`
  // set; surface it inline so the user can correct and retry.
  const inlineError = !isError && showCodeInput ? error : null;

  const statusLine = ((): string => {
    switch (phase) {
      case 'starting':
        return 'Starting sign-in…';
      case 'browser':
        return 'Your browser opened for sign-in. After you approve access, claude.com shows an authorization code — paste it below to finish.';
      case 'awaitingCode':
        return 'Claude is ready for your authorization code — paste it below to finish.';
      case 'submitting':
        return 'Finishing sign-in…';
      case 'error':
        return error ?? 'Sign-in could not be completed. Please try again.';
      default:
        return '';
    }
  })();

  return (
    <div
      data-testid="claude-login-flow"
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

      {showCodeInput && (
        <div className="mt-2">
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={codeInput}
              onChange={(event) => setCodeInput(event.target.value)}
              disabled={disabled || isSubmitting}
              placeholder="Paste authorization code"
              aria-label="Claude authorization code"
              autoComplete="off"
              className="h-8 min-w-0 flex-1 rounded border border-editor-border bg-editor-bg px-2 text-xs text-editor-text outline-none focus:border-primary-500 disabled:cursor-not-allowed disabled:opacity-50"
            />
            <button
              type="button"
              onClick={handleSubmitCode}
              disabled={disabled || isSubmitting || !codeInput.trim()}
              className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded bg-primary-500 px-3 text-xs font-medium text-white hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isSubmitting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Finish sign-in
            </button>
          </div>
          {inlineError && <p className="mt-1 text-[11px] text-yellow-300">{inlineError}</p>}
        </div>
      )}

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

      {recentOutput.length > 0 && (
        <details className="mt-2">
          <summary className="cursor-pointer text-[11px] text-editor-text-muted">
            Sign-in details
          </summary>
          <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap break-all rounded border border-editor-border bg-editor-bg px-2 py-1 text-[10px] leading-4 text-editor-text-muted">
            {recentOutput.join('\n')}
          </pre>
        </details>
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

export default ClaudeLoginFlow;
