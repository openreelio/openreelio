import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Download, Loader2, LogIn, LogOut, RefreshCw, UploadCloud } from 'lucide-react';

import { commands } from '@/bindings';
import type {
  ClaudeAgentLogoutResult,
  ClaudeCliInstallResult,
  ClaudeCliUpdateResult,
  ClaudeStatusProbeResult,
  ConfigureClaudeAgentRuntimeResult,
  Result,
  StartClaudeLoginResult,
} from '@/bindings';
import { EXTERNAL_AGENT_STATUS_REFRESH_EVENT } from '@/agents/external/useExternalAgentHostStatus';
import type { AISettings, ClaudeAuthMode, ClaudeEffort } from '@/stores/settingsStore';
import { useProjectStore } from '@/stores';

import { ClaudeAuthControls } from './ClaudeAuthControls';
import { ClaudeLoginFlow } from './ClaudeLoginFlow';
import { SetupPill } from './SetupPill';
import { useClaudeLoginSession } from './useClaudeLoginSession';
import {
  createRuntimeGuidance,
  formatAuthStatus,
  formatInstallProgress,
  formatRuntimeSource,
  isAuthenticated,
  isLauncherExecutableError,
  isRuntimeUpdateAvailable,
} from './runtimeControlsShared';
import { useRuntimeInstallProgress } from './useRuntimeInstallProgress';

interface ClaudeRuntimeControlsProps {
  settings: AISettings;
  onUpdate: (values: Partial<AISettings>) => void;
  disabled: boolean;
  showDiagnostics: boolean;
}

/** Fixed Claude Code model aliases; a free-text custom id is also supported. */
const CLAUDE_MODEL_ALIASES = ['sonnet', 'opus', 'haiku', 'fable'] as const;

/** Effort levels accepted by the Claude Code CLI. */
const CLAUDE_EFFORTS: ClaudeEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

const CUSTOM_MODEL_OPTION = 'custom';

/** Unwraps a generated `Result`, throwing the error branch as an `Error`. */
async function unwrapResult<T>(promise: Promise<Result<T, string>>): Promise<T> {
  const result = await promise;
  if (result.status === 'error') {
    throw new Error(result.error);
  }
  return result.data;
}

const { formatActionError, formatRuntimeMessage, getSafeRuntimeGuidance } = createRuntimeGuidance({
  productName: 'Claude',
  reinstallMessage:
    'Claude Code could not be started on this device. Reinstall it and make sure its native launcher is available.',
  notInstalledPattern: /claude(?: code)?(?: cli)? (?:was |is )?not (?:installed|found)/i,
  notInstalledMessage: 'Claude Code is not installed yet. Install it to continue.',
});

/**
 * Claude Code account-agent runtime controls: model/effort selection, auth-mode
 * (subscription OAuth or API key), install/update, sign-in/out, and readiness
 * status. Rendered only when Claude Code is the selected assistant runtime.
 */
export function ClaudeRuntimeControls({
  settings,
  onUpdate,
  disabled,
  showDiagnostics,
}: ClaudeRuntimeControlsProps): JSX.Element {
  const projectPath = useProjectStore((state) => state.meta?.path ?? null);
  const [setupResult, setSetupResult] = useState<ConfigureClaudeAgentRuntimeResult | null>(null);
  const [statusProbe, setStatusProbe] = useState<ClaudeStatusProbeResult | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [isConfiguring, setIsConfiguring] = useState(false);
  const [isSavingKey, setIsSavingKey] = useState(false);
  const [isSavingToken, setIsSavingToken] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [isInstalling, setIsInstalling] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [showCustomModel, setShowCustomModel] = useState(false);
  const lastAutoConfigureKeyRef = useRef<string | null>(null);

  const authMode: ClaudeAuthMode = settings.claudeAuthMode;
  const effectiveAuthStatus = setupResult?.authStatus ?? statusProbe?.authStatus ?? 'unknown';
  const claudeInstalled = Boolean(setupResult?.installed ?? statusProbe?.installed);
  const authenticated = isAuthenticated(effectiveAuthStatus);
  const runtimeReady = Boolean(setupResult?.ready);
  const requiresLogin = Boolean(
    claudeInstalled &&
    (setupResult?.requiresLogin || (!authenticated && effectiveAuthStatus !== 'error')),
  );
  const claudeVersion = setupResult?.version ?? statusProbe?.version ?? null;
  const configHome = setupResult?.configHome ?? statusProbe?.configHome ?? null;
  const runtimeSource = setupResult?.runtimeSource ?? statusProbe?.runtimeSource ?? null;
  const pinnedVersion = setupResult?.pinnedVersion ?? null;
  const runtimeSourceLabel = formatRuntimeSource(runtimeSource);
  const isLegacyManagedRuntime = runtimeSource === 'managed-legacy';
  const launcherExecutableError = isLauncherExecutableError(
    setupResult?.message ?? statusProbe?.reason,
  );
  const statusKnown = Boolean(setupResult || statusProbe) && !statusLoading;
  const canInstall = Boolean(statusKnown && !claudeInstalled && !launcherExecutableError);
  const canUpdate = Boolean(
    claudeInstalled &&
    !launcherExecutableError &&
    isRuntimeUpdateAvailable(claudeVersion, pinnedVersion),
  );
  const isPresetModel = (CLAUDE_MODEL_ALIASES as readonly string[]).includes(settings.claudeModel);
  const usingCustomModel = showCustomModel || !isPresetModel;

  const refreshExternalAgentStatus = useCallback(() => {
    window.dispatchEvent(new Event(EXTERNAL_AGENT_STATUS_REFRESH_EVENT));
  }, []);

  const applySuccessfulAuthResult = useCallback(
    (result: StartClaudeLoginResult | ClaudeAgentLogoutResult) => {
      const resultAuthenticated = isAuthenticated(result.authStatus);
      lastAutoConfigureKeyRef.current = `${projectPath ?? 'no-project'}:${result.authStatus}`;
      setSetupResult((current) => ({
        installed: current?.installed ?? claudeInstalled,
        version: current?.version ?? claudeVersion,
        authStatus: result.authStatus,
        ready: resultAuthenticated,
        requiresLogin: !resultAuthenticated,
        message: result.message ?? current?.message ?? null,
        runtimeSource: current?.runtimeSource ?? runtimeSource,
        configHome: current?.configHome ?? configHome,
        pinnedVersion: current?.pinnedVersion ?? pinnedVersion,
      }));
    },
    [claudeInstalled, claudeVersion, configHome, pinnedVersion, projectPath, runtimeSource],
  );

  const configureClaude = useCallback(async () => {
    setIsConfiguring(true);
    setActionError(null);
    try {
      const result = await unwrapResult(
        // Pass the CURRENT UI auth mode so a probe right after switching
        // subscription <-> api-key evaluates the fresh mode instead of the
        // stale persisted one.
        commands.configureClaudeAgentRuntime({
          projectPath,
          authMode: settings.claudeAuthMode,
        }),
      );
      setSetupResult(result);
      if (!result.ready && result.installed && !result.requiresLogin && result.message) {
        setActionError(
          formatRuntimeMessage(
            result.message,
            'Claude Code setup is not ready yet. Try reconnecting.',
            showDiagnostics,
          ),
        );
      }
      refreshExternalAgentStatus();
    } catch (error) {
      setActionError(formatActionError(error, showDiagnostics));
    } finally {
      setIsConfiguring(false);
      setStatusLoading(false);
    }
  }, [projectPath, refreshExternalAgentStatus, settings.claudeAuthMode, showDiagnostics]);

  // Fully in-app subscription sign-in (ConPTY-backed `claude setup-token`).
  const login = useClaudeLoginSession({
    onSuccess: (authStatus) => {
      applySuccessfulAuthResult({
        success: true,
        authStatus,
        message: 'Claude Code is signed in.',
      });
      setActionError(null);
      void configureClaude();
      refreshExternalAgentStatus();
    },
    onError: (message) => {
      // Surfaced inline by the login flow; also route through the panel's safe
      // messaging so diagnostics stay consistent.
      setActionError(formatActionError(new Error(message), showDiagnostics));
    },
  });

  const isSigningIn = login.isActive;
  const isRuntimeActionPending =
    isConfiguring ||
    isSigningIn ||
    isSavingKey ||
    isSavingToken ||
    isSigningOut ||
    isInstalling ||
    isUpdating;
  const showActionError = Boolean(
    actionError &&
    (!runtimeReady || !claudeInstalled || actionError !== setupResult?.message),
  );

  // Initial lightweight probe for install/version/auth before configure resolves.
  useEffect(() => {
    let cancelled = false;
    async function probe(): Promise<void> {
      try {
        const result = await unwrapResult(
          commands.getClaudeStatus({ authMode: settings.claudeAuthMode }),
        );
        if (!cancelled) {
          setStatusProbe(result);
        }
      } catch {
        if (!cancelled) {
          setStatusProbe(null);
        }
      }
    }
    void probe();
    return () => {
      cancelled = true;
    };
    // Initial mount-time probe only; configureClaude covers later mode changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const autoConfigureKey = `${projectPath ?? 'no-project'}:${effectiveAuthStatus}`;
    if (lastAutoConfigureKeyRef.current === autoConfigureKey) {
      return;
    }
    lastAutoConfigureKeyRef.current = autoConfigureKey;
    void configureClaude();
  }, [configureClaude, effectiveAuthStatus, projectPath]);

  // Surface native download/install progress while an install or update runs.
  const installActive = isInstalling || isUpdating;
  const installProgress = useRuntimeInstallProgress('claude', installActive);

  const handleModelChange = useCallback(
    (value: string) => {
      if (value === CUSTOM_MODEL_OPTION) {
        setShowCustomModel(true);
        return;
      }
      setShowCustomModel(false);
      onUpdate({ claudeModel: value });
    },
    [onUpdate],
  );

  const handleCustomModelChange = useCallback(
    (value: string) => {
      onUpdate({ claudeModel: value });
    },
    [onUpdate],
  );

  const handleEffortChange = useCallback(
    (value: string) => {
      onUpdate({ claudeEffort: value as ClaudeEffort });
    },
    [onUpdate],
  );

  const handleAuthModeChange = useCallback(
    (mode: ClaudeAuthMode) => {
      if (mode !== settings.claudeAuthMode) {
        onUpdate({ claudeAuthMode: mode });
      }
      setActionError(null);
    },
    [onUpdate, settings.claudeAuthMode],
  );

  const handleSignIn = useCallback(() => {
    // Fully in-app sign-in: spawn `claude setup-token` under a pseudo-terminal
    // (no visible window) and drive the browser + code flow inline. The legacy
    // visible-terminal path remains only as a manual fallback (surfaced in the
    // error message if the PTY spawn fails).
    setActionError(null);
    void login.start();
  }, [login]);

  const handleSaveApiKey = useCallback(
    async (key: string) => {
      const trimmed = key.trim();
      if (!trimmed) {
        setActionError('Enter your Claude API key first.');
        return;
      }
      setIsSavingKey(true);
      setActionError(null);
      try {
        const result = await unwrapResult(
          commands.startClaudeLogin({ mode: 'api-key', apiKey: trimmed }),
        );
        if (!result.success) {
          setActionError(
            formatRuntimeMessage(
              result.message,
              'Claude API key could not be saved.',
              showDiagnostics,
            ),
          );
          refreshExternalAgentStatus();
          return;
        }
        applySuccessfulAuthResult(result);
        await configureClaude();
        refreshExternalAgentStatus();
      } catch (error) {
        setActionError(formatActionError(error, showDiagnostics));
      } finally {
        setIsSavingKey(false);
      }
    },
    [applySuccessfulAuthResult, configureClaude, refreshExternalAgentStatus, showDiagnostics],
  );

  const handleSaveOauthToken = useCallback(
    async (token: string) => {
      const trimmed = token.trim();
      if (!trimmed) {
        setActionError('Paste the token from `claude setup-token` first.');
        return;
      }
      setIsSavingToken(true);
      setActionError(null);
      try {
        const result = await unwrapResult(
          commands.startClaudeLogin({ mode: 'oauth-token', apiKey: trimmed }),
        );
        if (!result.success) {
          setActionError(
            formatRuntimeMessage(
              result.message,
              'Claude sign-in token could not be saved.',
              showDiagnostics,
            ),
          );
          refreshExternalAgentStatus();
          return;
        }
        applySuccessfulAuthResult(result);
        await configureClaude();
        refreshExternalAgentStatus();
      } catch (error) {
        setActionError(formatActionError(error, showDiagnostics));
      } finally {
        setIsSavingToken(false);
      }
    },
    [applySuccessfulAuthResult, configureClaude, refreshExternalAgentStatus, showDiagnostics],
  );

  const handleSignOut = useCallback(async () => {
    setIsSigningOut(true);
    setActionError(null);
    try {
      const result = await unwrapResult(commands.logoutClaudeAgentRuntime());
      if (!result.success) {
        setActionError(
          formatRuntimeMessage(result.message, 'Claude sign-out did not complete.', showDiagnostics),
        );
        refreshExternalAgentStatus();
        return;
      }
      applySuccessfulAuthResult(result);
      await configureClaude();
      refreshExternalAgentStatus();
    } catch (error) {
      setActionError(formatActionError(error, showDiagnostics));
    } finally {
      setIsSigningOut(false);
    }
  }, [applySuccessfulAuthResult, configureClaude, refreshExternalAgentStatus, showDiagnostics]);

  const handleInstall = useCallback(async () => {
    setIsInstalling(true);
    setActionError(null);
    try {
      const result = await unwrapResult<ClaudeCliInstallResult>(commands.installClaudeCli());
      if (!result.success) {
        setActionError(
          formatRuntimeMessage(
            result.message,
            'Claude Code installation did not complete.',
            showDiagnostics,
          ),
        );
        refreshExternalAgentStatus();
        return;
      }
      await configureClaude();
      refreshExternalAgentStatus();
    } catch (error) {
      setActionError(formatActionError(error, showDiagnostics));
    } finally {
      setIsInstalling(false);
    }
  }, [configureClaude, refreshExternalAgentStatus, showDiagnostics]);

  const handleUpdate = useCallback(async () => {
    setIsUpdating(true);
    setActionError(null);
    try {
      const result = await unwrapResult<ClaudeCliUpdateResult>(commands.updateClaudeCli());
      if (!result.success) {
        setActionError(
          formatRuntimeMessage(result.message, 'Claude Code update did not complete.', showDiagnostics),
        );
        refreshExternalAgentStatus();
        return;
      }
      await configureClaude();
      refreshExternalAgentStatus();
    } catch (error) {
      setActionError(formatActionError(error, showDiagnostics));
    } finally {
      setIsUpdating(false);
    }
  }, [configureClaude, refreshExternalAgentStatus, showDiagnostics]);

  const statusLine = useMemo(() => {
    if (isSigningIn) return 'Signing in to Claude...';
    if (isSavingKey) return 'Saving your Claude API key...';
    if (isSavingToken) return 'Saving your Claude sign-in token...';
    if (isSigningOut) return 'Signing out of the OpenReelio Claude profile...';
    if (isInstalling) return 'Installing Claude Code CLI...';
    if (isUpdating) return 'Updating Claude Code CLI...';
    if (isConfiguring) return 'Checking Claude account access...';
    if (!claudeInstalled) {
      return showDiagnostics
        ? (setupResult?.message ?? statusProbe?.reason ?? 'Claude Code was not found.')
        : (getSafeRuntimeGuidance(setupResult?.message ?? statusProbe?.reason) ??
            'Claude Code is not installed yet.');
    }
    if (runtimeReady) {
      const readyLine =
        'Claude Code is signed in. OpenReelio tools will start when a session begins.';
      return isLegacyManagedRuntime
        ? `${readyLine} Using the managed (legacy npm) install — Update to migrate to the native binary.`
        : readyLine;
    }
    if (requiresLogin) {
      return authMode === 'api-key'
        ? 'Add your Claude API key to continue.'
        : 'Sign in to Claude to continue.';
    }
    if (effectiveAuthStatus === 'error') {
      return showDiagnostics
        ? (setupResult?.message ?? statusProbe?.reason ?? 'Claude authentication could not be read.')
        : 'Claude sign-in status could not be checked.';
    }
    return showDiagnostics
      ? (setupResult?.message ?? statusProbe?.reason ?? 'Claude Code is not ready yet.')
      : 'Claude Code is not ready yet.';
  }, [
    authMode,
    claudeInstalled,
    effectiveAuthStatus,
    isConfiguring,
    isInstalling,
    isLegacyManagedRuntime,
    isSavingKey,
    isSavingToken,
    isSigningIn,
    isSigningOut,
    isUpdating,
    requiresLogin,
    runtimeReady,
    showDiagnostics,
    setupResult?.message,
    statusProbe?.reason,
  ]);

  const installProgressLine = installActive ? formatInstallProgress(installProgress) : null;

  return (
    <div className="mt-3 rounded border border-editor-border bg-editor-bg/40 p-3">
      <div className="mb-3 grid gap-2 sm:grid-cols-2">
        <label className="block min-w-0">
          <span className="mb-1 block text-[11px] font-medium text-editor-text-muted">
            Claude Model
          </span>
          <select
            value={usingCustomModel ? CUSTOM_MODEL_OPTION : settings.claudeModel}
            onChange={(event) => handleModelChange(event.target.value)}
            disabled={disabled || isRuntimeActionPending}
            className="h-8 w-full rounded border border-editor-border bg-editor-bg px-2 text-xs capitalize text-editor-text outline-none focus:border-primary-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {CLAUDE_MODEL_ALIASES.map((alias) => (
              <option key={alias} value={alias}>
                {alias}
              </option>
            ))}
            <option value={CUSTOM_MODEL_OPTION}>Custom model id...</option>
          </select>
          {usingCustomModel && (
            <input
              type="text"
              value={isPresetModel ? '' : settings.claudeModel}
              onChange={(event) => handleCustomModelChange(event.target.value)}
              disabled={disabled || isRuntimeActionPending}
              placeholder="claude-sonnet-4-5-20251015"
              aria-label="Custom Claude model id"
              className="mt-1 h-8 w-full rounded border border-editor-border bg-editor-bg px-2 text-xs text-editor-text outline-none focus:border-primary-500 disabled:cursor-not-allowed disabled:opacity-50"
            />
          )}
        </label>
        <label className="block min-w-0">
          <span className="mb-1 block text-[11px] font-medium text-editor-text-muted">Effort</span>
          <select
            value={settings.claudeEffort}
            onChange={(event) => handleEffortChange(event.target.value)}
            disabled={disabled || isRuntimeActionPending}
            className="h-8 w-full rounded border border-editor-border bg-editor-bg px-2 text-xs capitalize text-editor-text outline-none focus:border-primary-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {CLAUDE_EFFORTS.map((effort) => (
              <option key={effort} value={effort}>
                {effort}
              </option>
            ))}
          </select>
        </label>
      </div>

      <ClaudeAuthControls
        authMode={authMode}
        claudeInstalled={claudeInstalled}
        disabled={disabled}
        isRuntimeActionPending={isRuntimeActionPending}
        isSavingKey={isSavingKey}
        isSavingToken={isSavingToken}
        onAuthModeChange={handleAuthModeChange}
        onSaveApiKey={handleSaveApiKey}
        onSaveToken={handleSaveOauthToken}
      />

      {authMode === 'subscription' && <ClaudeLoginFlow session={login} disabled={disabled} />}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <SetupPill label="Claude Code" ready={claudeInstalled} pending={statusLoading} />
            <SetupPill
              label={formatAuthStatus(effectiveAuthStatus)}
              ready={authenticated}
              pending={statusLoading || isSigningIn || isSavingKey}
            />
            <SetupPill label="OpenReelio tools" ready={runtimeReady} pending={isConfiguring} />
          </div>
          <p className="mt-2 text-xs leading-5 text-editor-text-muted">{statusLine}</p>
          {installProgressLine && (
            <p
              className="mt-1 text-[11px] leading-5 text-editor-text-muted"
              data-testid="claude-install-progress"
            >
              {installProgressLine}
            </p>
          )}
          {showDiagnostics && (
            <div data-testid="claude-runtime-diagnostics">
              {claudeVersion && (
                <p className="mt-1 truncate text-[11px] text-editor-text-muted">{claudeVersion}</p>
              )}
              <p className="mt-1 truncate text-[11px] text-editor-text-muted">
                Storage: OpenReelio-managed Claude profile
                {runtimeSourceLabel ? ` (${runtimeSourceLabel})` : ''}
              </p>
              {configHome && (
                <p className="mt-1 truncate text-[11px] text-editor-text-muted">
                  CLAUDE_CONFIG_DIR: {configHome}
                </p>
              )}
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {canInstall && (
            <button
              type="button"
              onClick={handleInstall}
              disabled={disabled || isRuntimeActionPending}
              className="inline-flex h-8 items-center gap-1.5 rounded bg-primary-500 px-3 text-xs font-medium text-white hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isInstalling ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Download className="h-3.5 w-3.5" />
              )}
              Install Claude Code
            </button>
          )}
          {canUpdate && (
            <button
              type="button"
              onClick={handleUpdate}
              disabled={disabled || isRuntimeActionPending}
              className="inline-flex h-8 items-center gap-1.5 rounded border border-editor-border px-2 text-xs text-editor-text hover:bg-editor-bg-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isUpdating ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <UploadCloud className="h-3.5 w-3.5" />
              )}
              {pinnedVersion ? `Update to ${pinnedVersion}` : 'Update Claude Code'}
            </button>
          )}
          {authMode === 'subscription' && requiresLogin && (
            <button
              type="button"
              onClick={handleSignIn}
              disabled={disabled || isRuntimeActionPending}
              className="inline-flex h-8 items-center gap-1.5 rounded bg-primary-500 px-3 text-xs font-medium text-white hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isSigningIn ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <LogIn className="h-3.5 w-3.5" />
              )}
              Sign in with Claude
            </button>
          )}
          {authenticated && (
            <button
              type="button"
              onClick={handleSignOut}
              disabled={disabled || isRuntimeActionPending}
              className="inline-flex h-8 items-center gap-1.5 rounded border border-editor-border px-2 text-xs text-editor-text hover:bg-editor-bg-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isSigningOut ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <LogOut className="h-3.5 w-3.5" />
              )}
              Sign out
            </button>
          )}
          <button
            type="button"
            onClick={configureClaude}
            disabled={disabled || isRuntimeActionPending}
            className="inline-flex h-8 items-center gap-1.5 rounded border border-editor-border px-2 text-xs text-editor-text hover:bg-editor-bg-hover disabled:cursor-not-allowed disabled:opacity-50"
            aria-label="Reconnect Claude Code"
            title="Reconnect Claude Code"
          >
            {isConfiguring ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            Reconnect
          </button>
        </div>
      </div>

      {showActionError && actionError && (
        <p className="mt-2 rounded border border-yellow-600/20 bg-yellow-600/10 px-2 py-1.5 text-xs leading-5 text-yellow-200">
          {actionError}
        </p>
      )}

      <div className="mt-3 border-t border-editor-border pt-3">
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            checked={settings.claudePreferSystem}
            onChange={(event) => onUpdate({ claudePreferSystem: event.target.checked })}
            disabled={disabled || isRuntimeActionPending}
            className="mt-0.5 h-3.5 w-3.5 shrink-0 disabled:cursor-not-allowed disabled:opacity-50"
          />
          <span className="min-w-0">
            <span className="block text-xs font-medium text-editor-text">
              Use system installation
            </span>
            <span className="mt-0.5 block text-[11px] leading-4 text-editor-text-muted">
              Prefer a Claude Code found on your PATH or system over the managed native binary.
              System installs can drift from the version OpenReelio was tested with.
            </span>
          </span>
        </label>
      </div>
    </div>
  );
}

export default ClaudeRuntimeControls;
