import { useCallback, useState } from 'react';
import { KeyRound, Loader2, UploadCloud } from 'lucide-react';

import type { ClaudeAuthMode } from '@/stores/settingsStore';

/**
 * Copy shown under the subscription auth mode. The `Sign in with Claude` button
 * runs the sign-in fully in-app (a hidden pseudo-terminal drives
 * `claude setup-token`, which opens your browser); the token-paste field below
 * remains as an optional manual fallback.
 */
export const CLAUDE_SUBSCRIPTION_HINT =
  'Sign in opens Claude in your browser and finishes right here in the app. Prefer to do it yourself? Paste a token from `claude setup-token` below.';

interface ClaudeAuthControlsProps {
  /** Currently selected auth mode. */
  authMode: ClaudeAuthMode;
  /** Whether the Claude CLI is installed (gates the credential inputs). */
  claudeInstalled: boolean;
  /** Global disabled state from the settings panel. */
  disabled: boolean;
  /** Whether any runtime action (sign-in, install, etc.) is in flight. */
  isRuntimeActionPending: boolean;
  /** Whether an API-key save is in flight. */
  isSavingKey: boolean;
  /** Whether an OAuth-token save is in flight. */
  isSavingToken: boolean;
  /** Switch the auth mode. */
  onAuthModeChange: (mode: ClaudeAuthMode) => void;
  /** Persist a raw Anthropic API key. Resolves when the attempt settles. */
  onSaveApiKey: (key: string) => Promise<void>;
  /** Persist a pasted `claude setup-token` output. Resolves when settled. */
  onSaveToken: (token: string) => Promise<void>;
}

/**
 * Claude auth-mode selector plus the credential inputs for each mode:
 * subscription (open a terminal, then paste the resulting setup-token) or
 * API key. Owns only the transient credential inputs so raw secrets never
 * outlive submission; all persistence is delegated to the parent.
 */
export function ClaudeAuthControls({
  authMode,
  claudeInstalled,
  disabled,
  isRuntimeActionPending,
  isSavingKey,
  isSavingToken,
  onAuthModeChange,
  onSaveApiKey,
  onSaveToken,
}: ClaudeAuthControlsProps): JSX.Element {
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [tokenInput, setTokenInput] = useState('');

  const handleSaveApiKey = useCallback(async () => {
    const key = apiKeyInput.trim();
    if (!key) {
      return;
    }
    try {
      await onSaveApiKey(key);
    } finally {
      // Never retain the raw key in component state once submitted.
      setApiKeyInput('');
    }
  }, [apiKeyInput, onSaveApiKey]);

  const handleSaveToken = useCallback(async () => {
    const token = tokenInput.trim();
    if (!token) {
      return;
    }
    try {
      await onSaveToken(token);
    } finally {
      // Never retain the raw token in component state once submitted.
      setTokenInput('');
    }
  }, [tokenInput, onSaveToken]);

  return (
    <div className="mb-3">
      <span className="mb-1 block text-[11px] font-medium text-editor-text-muted">Auth Mode</span>
      <div className="grid gap-2 sm:grid-cols-2">
        <button
          type="button"
          onClick={() => onAuthModeChange('subscription')}
          disabled={disabled || isRuntimeActionPending}
          aria-pressed={authMode === 'subscription'}
          className={`flex min-h-8 items-center justify-center rounded border px-3 py-1.5 text-xs font-medium transition-colors ${
            authMode === 'subscription'
              ? 'border-primary-500 bg-primary-500/10 text-editor-text'
              : 'border-editor-border bg-editor-bg text-editor-text-muted hover:bg-editor-bg-hover'
          } disabled:cursor-not-allowed disabled:opacity-50`}
        >
          Subscription (OAuth)
        </button>
        <button
          type="button"
          onClick={() => onAuthModeChange('api-key')}
          disabled={disabled || isRuntimeActionPending}
          aria-pressed={authMode === 'api-key'}
          className={`flex min-h-8 items-center justify-center rounded border px-3 py-1.5 text-xs font-medium transition-colors ${
            authMode === 'api-key'
              ? 'border-primary-500 bg-primary-500/10 text-editor-text'
              : 'border-editor-border bg-editor-bg text-editor-text-muted hover:bg-editor-bg-hover'
          } disabled:cursor-not-allowed disabled:opacity-50`}
        >
          API key
        </button>
      </div>

      {authMode === 'subscription' && (
        <>
          <p className="mt-1.5 text-[11px] leading-4 text-editor-text-muted">
            {CLAUDE_SUBSCRIPTION_HINT}
          </p>
          {claudeInstalled && (
            <div className="mt-2 flex items-center gap-2">
              <input
                type="password"
                value={tokenInput}
                onChange={(event) => setTokenInput(event.target.value)}
                disabled={disabled || isRuntimeActionPending}
                placeholder="Paste token from setup-token"
                aria-label="Paste token from setup-token"
                autoComplete="off"
                className="h-8 min-w-0 flex-1 rounded border border-editor-border bg-editor-bg px-2 text-xs text-editor-text outline-none focus:border-primary-500 disabled:cursor-not-allowed disabled:opacity-50"
              />
              <button
                type="button"
                onClick={handleSaveToken}
                disabled={disabled || isRuntimeActionPending || !tokenInput.trim()}
                className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded bg-primary-500 px-3 text-xs font-medium text-white hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isSavingToken ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <UploadCloud className="h-3.5 w-3.5" />
                )}
                Save token
              </button>
            </div>
          )}
        </>
      )}

      {authMode === 'api-key' && claudeInstalled && (
        <div className="mt-2 flex items-center gap-2">
          <input
            type="password"
            value={apiKeyInput}
            onChange={(event) => setApiKeyInput(event.target.value)}
            disabled={disabled || isRuntimeActionPending}
            placeholder="Claude API key"
            aria-label="Claude API key"
            autoComplete="off"
            className="h-8 min-w-0 flex-1 rounded border border-editor-border bg-editor-bg px-2 text-xs text-editor-text outline-none focus:border-primary-500 disabled:cursor-not-allowed disabled:opacity-50"
          />
          <button
            type="button"
            onClick={handleSaveApiKey}
            disabled={disabled || isRuntimeActionPending || !apiKeyInput.trim()}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded bg-primary-500 px-3 text-xs font-medium text-white hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isSavingKey ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <KeyRound className="h-3.5 w-3.5" />
            )}
            Save key
          </button>
        </div>
      )}
    </div>
  );
}

export default ClaudeAuthControls;
