import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Download, Loader2, LogOut, RefreshCw, UploadCloud } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';

import {
  useExternalAgentHostStatus,
  EXTERNAL_AGENT_STATUS_REFRESH_EVENT,
} from '@/agents/external/useExternalAgentHostStatus';
import type { AISettings } from '@/stores/settingsStore';
import { useProjectStore } from '@/stores';

import { CodexLoginFlow } from './CodexLoginFlow';
import { SetupPill } from './SetupPill';
import { useCodexLoginSession } from './useCodexLoginSession';
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

interface CodexRuntimeControlsProps {
  settings: AISettings;
  onUpdate: (values: Partial<AISettings>) => void;
  disabled: boolean;
  showDiagnostics: boolean;
}

interface ConfigureCodexAgentRuntimeResult {
  installed: boolean;
  version: string | null;
  authStatus: string;
  ready: boolean;
  requiresLogin: boolean;
  pluginMarketplaceConfigured: boolean;
  mcpConfigured: boolean;
  message: string | null;
  runtimeSource?: string | null;
  codexHome?: string | null;
  pinnedVersion?: string | null;
}

interface CodexAgentLoginResult {
  success: boolean;
  authStatus: string;
  message: string | null;
}

interface CodexAgentLogoutResult {
  success: boolean;
  authStatus: string;
  message: string | null;
}

interface CodexCliInstallResult {
  success: boolean;
  version: string | null;
  attemptedCommand: string | null;
  message: string | null;
}

interface CodexCliUpdateResult {
  success: boolean;
  beforeVersion: string | null;
  afterVersion: string | null;
  attemptedCommand: string | null;
  message: string | null;
}

interface CodexModelInfo {
  slug: string;
  displayName: string;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: string[];
}

interface CodexModelCatalogResult {
  installed: boolean;
  defaultModel: string;
  defaultReasoningEffort: string;
  models: CodexModelInfo[];
  reason: string | null;
}

const FALLBACK_CODEX_MODELS: CodexModelInfo[] = [
  {
    slug: 'gpt-5.6-terra',
    displayName: 'GPT-5.6-Terra',
    defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  },
  {
    slug: 'gpt-5.6-luna',
    displayName: 'GPT-5.6-Luna',
    defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
  {
    slug: 'gpt-5.5',
    displayName: 'gpt-5.5',
    defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
  },
  {
    slug: 'gpt-5.4-mini',
    displayName: 'GPT-5.4-Mini',
    defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
  },
];

const { formatActionError, formatRuntimeMessage, getSafeRuntimeGuidance } = createRuntimeGuidance({
  productName: 'Codex',
  reinstallMessage:
    'Codex could not be started on this device. Reinstall Codex and make sure its native launcher is available.',
  notInstalledPattern: /codex(?: cli)? (?:was |is )?not (?:installed|found)/i,
  notInstalledMessage: 'Codex is not installed yet. Install Codex to continue.',
});

/**
 * Codex account-agent runtime controls: model/effort selection, install,
 * sign-in/out, and readiness status. Rendered only when Codex is the selected
 * assistant runtime.
 */
export function CodexRuntimeControls({
  settings,
  onUpdate,
  disabled,
  showDiagnostics,
}: CodexRuntimeControlsProps): JSX.Element {
  const projectPath = useProjectStore((state) => state.meta?.path ?? null);
  const [setupResult, setSetupResult] = useState<ConfigureCodexAgentRuntimeResult | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [modelCatalog, setModelCatalog] = useState<CodexModelCatalogResult | null>(null);
  const [isConfiguring, setIsConfiguring] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [isInstalling, setIsInstalling] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const lastAutoConfigureKeyRef = useRef<string | null>(null);
  const codexStatus = useExternalAgentHostStatus({
    hostEnabled: true,
    codexEnabled: true,
    // This panel only cares about Codex; never let a slow Claude CLI probe
    // block the shared loading flag and withhold the Codex install/status UI.
    claudeEnabled: false,
  });
  const codexRuntime = codexStatus.summary.runtimes.find(
    (runtime) => runtime.runtimeId === 'codex',
  );

  const effectiveAuthStatus = setupResult?.authStatus ?? codexRuntime?.authStatus ?? 'unknown';
  const codexInstalled = Boolean(
    setupResult?.installed ?? codexRuntime?.installStatus === 'installed',
  );
  const authenticated = isAuthenticated(effectiveAuthStatus);
  const nativeToolsReady = Boolean(
    codexRuntime?.ready && codexRuntime.capabilities?.structuredToolCalls,
  );
  const runtimeReady = Boolean(setupResult?.ready || nativeToolsReady);
  const toolsReady = Boolean(
    runtimeReady || (setupResult?.pluginMarketplaceConfigured && setupResult?.mcpConfigured),
  );
  const requiresLogin = Boolean(
    codexInstalled &&
    (setupResult?.requiresLogin || (!authenticated && effectiveAuthStatus !== 'error')),
  );
  const hasProject = Boolean(projectPath);
  const codexModels = modelCatalog?.models.length ? modelCatalog.models : FALLBACK_CODEX_MODELS;
  const selectedCodexModel =
    codexModels.find((model) => model.slug === settings.codexModel) ?? codexModels[0];
  const reasoningEfforts = selectedCodexModel?.supportedReasoningEfforts.length
    ? selectedCodexModel.supportedReasoningEfforts
    : ['low', 'medium', 'high', 'xhigh'];
  const codexVersion = setupResult?.version ?? codexRuntime?.version ?? null;
  const codexHome = setupResult?.codexHome ?? codexRuntime?.codexHome ?? null;
  const runtimeSource = setupResult?.runtimeSource ?? codexRuntime?.runtimeSource ?? null;
  const pinnedVersion = setupResult?.pinnedVersion ?? null;
  const runtimeSourceLabel = formatRuntimeSource(runtimeSource);
  const isLegacyManagedRuntime = runtimeSource === 'managed-legacy';
  // A legacy npm-managed install is always update-eligible: "update" migrates
  // it to the managed native binary even when its version matches the pin (the
  // status line explicitly tells the user to do exactly that).
  const codexNeedsUpdate = Boolean(
    codexInstalled &&
    (isRuntimeUpdateAvailable(codexVersion, pinnedVersion) || isLegacyManagedRuntime),
  );
  const launcherExecutableError = isLauncherExecutableError(
    setupResult?.message ?? codexRuntime?.reason,
  );
  const codexStatusKnown = Boolean(setupResult || codexRuntime) && !codexStatus.loading;
  const canInstallCodex = Boolean(
    codexStatusKnown && !codexInstalled && !launcherExecutableError,
  );

  const refreshExternalAgentStatus = useCallback(() => {
    window.dispatchEvent(new Event(EXTERNAL_AGENT_STATUS_REFRESH_EVENT));
  }, []);

  const applySuccessfulCodexAuthResult = useCallback(
    (result: CodexAgentLoginResult | CodexAgentLogoutResult) => {
      const resultAuthenticated = isAuthenticated(result.authStatus);
      lastAutoConfigureKeyRef.current = `${projectPath ?? 'no-project'}:${result.authStatus}`;
      setSetupResult((current) => ({
        installed: current?.installed ?? codexInstalled,
        version: current?.version ?? codexVersion,
        authStatus: result.authStatus,
        ready: resultAuthenticated,
        requiresLogin: !resultAuthenticated,
        pluginMarketplaceConfigured: current?.pluginMarketplaceConfigured ?? false,
        mcpConfigured: current?.mcpConfigured ?? false,
        message: result.message ?? current?.message ?? null,
        runtimeSource: current?.runtimeSource ?? runtimeSource,
        codexHome: current?.codexHome ?? codexHome,
        pinnedVersion: current?.pinnedVersion ?? pinnedVersion,
      }));
    },
    [codexHome, codexInstalled, codexVersion, pinnedVersion, projectPath, runtimeSource],
  );

  const applyModelCatalogResult = useCallback(
    (result: CodexModelCatalogResult) => {
      setModelCatalog(result);
      const configuredModel = settings.codexModel?.trim();
      const configuredModelAvailable = Boolean(
        configuredModel && result.models.some((model) => model.slug === configuredModel),
      );
      const defaultModel =
        result.models.find((model) => model.slug === result.defaultModel) ?? result.models[0];
      if (!configuredModelAvailable && defaultModel) {
        onUpdate({
          codexModel: defaultModel.slug,
          codexReasoningEffort:
            defaultModel.defaultReasoningEffort as AISettings['codexReasoningEffort'],
        });
        return;
      }
      // The model survived, but its supported efforts may have changed across
      // catalog versions; an unsupported saved effort would fail session
      // starts, so reconcile it to the model's default.
      const activeModel = result.models.find((model) => model.slug === configuredModel);
      const configuredEffort = settings.codexReasoningEffort;
      if (
        activeModel &&
        configuredEffort &&
        activeModel.supportedReasoningEfforts.length > 0 &&
        !activeModel.supportedReasoningEfforts.includes(configuredEffort)
      ) {
        onUpdate({
          codexReasoningEffort:
            activeModel.defaultReasoningEffort as AISettings['codexReasoningEffort'],
        });
      }
    },
    [onUpdate, settings.codexModel, settings.codexReasoningEffort],
  );

  const loadCodexModels = useCallback(async () => {
    const result = await invoke<CodexModelCatalogResult>('get_codex_model_catalog');
    applyModelCatalogResult(result);
  }, [applyModelCatalogResult]);

  const configureCodex = useCallback(async () => {
    setIsConfiguring(true);
    setActionError(null);
    try {
      const result = await invoke<ConfigureCodexAgentRuntimeResult>(
        'configure_codex_agent_runtime',
        {
          input: { projectPath },
        },
      );
      setSetupResult(result);
      if (
        !result.ready &&
        !nativeToolsReady &&
        result.installed &&
        !result.requiresLogin &&
        result.message
      ) {
        setActionError(
          formatRuntimeMessage(
            result.message,
            'Codex setup is not ready yet. Try reconnecting.',
            showDiagnostics,
          ),
        );
      }
      refreshExternalAgentStatus();
    } catch (error) {
      setActionError(formatActionError(error, showDiagnostics));
    } finally {
      setIsConfiguring(false);
    }
  }, [nativeToolsReady, projectPath, refreshExternalAgentStatus, showDiagnostics]);

  // Streamed, visible sign-in: spawn `codex login`, stream progress, and open
  // the OAuth URL. The legacy blocking `start_codex_login` command remains only
  // as a non-streamed fallback and is no longer invoked from the UI.
  const login = useCodexLoginSession({
    onSuccess: (authStatus) => {
      applySuccessfulCodexAuthResult({
        success: true,
        authStatus,
        message: 'Codex is signed in.',
      });
      setActionError(null);
      void configureCodex();
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
    isConfiguring || isSigningIn || isSigningOut || isInstalling || isUpdating;
  const showActionError = Boolean(
    actionError &&
    (!runtimeReady || codexNeedsUpdate || !codexInstalled || actionError !== setupResult?.message),
  );

  useEffect(() => {
    const autoConfigureKey = `${projectPath ?? 'no-project'}:${effectiveAuthStatus}`;
    if (lastAutoConfigureKeyRef.current === autoConfigureKey) {
      return;
    }
    lastAutoConfigureKeyRef.current = autoConfigureKey;
    void configureCodex();
  }, [configureCodex, effectiveAuthStatus, projectPath]);

  useEffect(() => {
    let cancelled = false;
    async function loadCodexModelsForSelection(): Promise<void> {
      try {
        const result = await invoke<CodexModelCatalogResult>('get_codex_model_catalog');
        if (cancelled) {
          return;
        }
        applyModelCatalogResult(result);
      } catch {
        if (!cancelled) {
          setModelCatalog(null);
        }
      }
    }

    void loadCodexModelsForSelection();
    return () => {
      cancelled = true;
    };
  }, [applyModelCatalogResult]);

  // Surface native download/install progress while an install or update runs.
  const installActive = isInstalling || isUpdating;
  const installProgress = useRuntimeInstallProgress('codex', installActive);

  const handleCodexModelChange = useCallback(
    (modelSlug: string) => {
      const model = codexModels.find((candidate) => candidate.slug === modelSlug);
      onUpdate({
        codexModel: modelSlug,
        codexReasoningEffort: (model?.defaultReasoningEffort ??
          'medium') as AISettings['codexReasoningEffort'],
      });
    },
    [codexModels, onUpdate],
  );

  const handleCodexReasoningEffortChange = useCallback(
    (effort: string) => {
      onUpdate({ codexReasoningEffort: effort as AISettings['codexReasoningEffort'] });
    },
    [onUpdate],
  );

  const handleSignIn = useCallback(() => {
    // Streamed sign-in: spawn `codex login` and drive the browser flow inline
    // (progress + fallback link surfaced by CodexLoginFlow). The legacy blocking
    // `start_codex_login` command is no longer used from the UI.
    setActionError(null);
    void login.start();
  }, [login]);

  const handleSignOut = useCallback(async () => {
    setIsSigningOut(true);
    setActionError(null);
    try {
      const result = await invoke<CodexAgentLogoutResult>('logout_codex_agent_runtime');
      if (!result.success) {
        setActionError(
          formatRuntimeMessage(result.message, 'Codex sign-out did not complete.', showDiagnostics),
        );
        refreshExternalAgentStatus();
        return;
      }
      applySuccessfulCodexAuthResult(result);
      await configureCodex();
      refreshExternalAgentStatus();
    } catch (error) {
      setActionError(formatActionError(error, showDiagnostics));
    } finally {
      setIsSigningOut(false);
    }
  }, [applySuccessfulCodexAuthResult, configureCodex, refreshExternalAgentStatus, showDiagnostics]);

  const handleInstall = useCallback(async () => {
    setIsInstalling(true);
    setActionError(null);
    try {
      const result = await invoke<CodexCliInstallResult>('install_codex_cli');
      if (!result.success) {
        setActionError(
          formatRuntimeMessage(
            result.message,
            'Codex installation did not complete.',
            showDiagnostics,
          ),
        );
        refreshExternalAgentStatus();
        return;
      }
      await loadCodexModels().catch(() => setModelCatalog(null));
      await configureCodex();
      refreshExternalAgentStatus();
    } catch (error) {
      setActionError(formatActionError(error, showDiagnostics));
    } finally {
      setIsInstalling(false);
    }
  }, [configureCodex, loadCodexModels, refreshExternalAgentStatus, showDiagnostics]);

  const handleUpdate = useCallback(async () => {
    setIsUpdating(true);
    setActionError(null);
    try {
      const result = await invoke<CodexCliUpdateResult>('update_codex_cli');
      if (!result.success) {
        setActionError(
          formatRuntimeMessage(result.message, 'Codex update did not complete.', showDiagnostics),
        );
        refreshExternalAgentStatus();
        return;
      }
      await loadCodexModels().catch(() => setModelCatalog(null));
      await configureCodex();
      refreshExternalAgentStatus();
    } catch (error) {
      setActionError(formatActionError(error, showDiagnostics));
    } finally {
      setIsUpdating(false);
    }
  }, [configureCodex, loadCodexModels, refreshExternalAgentStatus, showDiagnostics]);

  const statusLine = useMemo(() => {
    if (isSigningIn) return 'Opening the Codex sign-in flow...';
    if (isSigningOut) return 'Signing out of the OpenReelio Codex profile...';
    if (isInstalling) return 'Installing Codex CLI...';
    if (isUpdating) return 'Updating Codex CLI...';
    if (isConfiguring) return 'Checking Codex account access...';
    if (!hasProject) return 'Open a project to attach OpenReelio tools.';
    if (!codexInstalled) {
      return showDiagnostics
        ? (setupResult?.message ?? codexRuntime?.reason ?? 'Codex was not found.')
        : (getSafeRuntimeGuidance(setupResult?.message ?? codexRuntime?.reason) ??
            'Codex is not installed yet.');
    }
    if (runtimeReady) {
      const readyLine = 'Codex is signed in. OpenReelio tools will start when a session begins.';
      return isLegacyManagedRuntime
        ? `${readyLine} Using the managed (legacy npm) install — Update to migrate to the native binary.`
        : readyLine;
    }
    if (requiresLogin) return 'Sign in to Codex to continue.';
    if (effectiveAuthStatus === 'error') {
      return showDiagnostics
        ? (setupResult?.message ??
            codexRuntime?.reason ??
            'Codex authentication could not be read.')
        : 'Codex sign-in status could not be checked.';
    }
    return showDiagnostics
      ? (setupResult?.message ?? codexRuntime?.reason ?? 'Codex is not ready yet.')
      : 'Codex is not ready yet.';
  }, [
    codexRuntime?.reason,
    codexInstalled,
    effectiveAuthStatus,
    hasProject,
    isConfiguring,
    isInstalling,
    isLegacyManagedRuntime,
    isSigningIn,
    isSigningOut,
    isUpdating,
    requiresLogin,
    runtimeReady,
    showDiagnostics,
    setupResult?.message,
  ]);

  const installProgressLine = installActive ? formatInstallProgress(installProgress) : null;

  return (
    <div className="mt-3 rounded border border-editor-border bg-editor-bg/40 p-3">
      <div className="mb-3 grid gap-2 sm:grid-cols-2">
        <label className="block min-w-0">
          <span className="mb-1 block text-[11px] font-medium text-editor-text-muted">
            Codex Model
          </span>
          <select
            value={selectedCodexModel?.slug || settings.codexModel || 'gpt-5.5'}
            onChange={(event) => handleCodexModelChange(event.target.value)}
            disabled={disabled || isRuntimeActionPending}
            className="h-8 w-full rounded border border-editor-border bg-editor-bg px-2 text-xs text-editor-text outline-none focus:border-primary-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {codexModels.map((model) => (
              <option key={model.slug} value={model.slug}>
                {model.displayName}
              </option>
            ))}
          </select>
        </label>
        <label className="block min-w-0">
          <span className="mb-1 block text-[11px] font-medium text-editor-text-muted">
            Reasoning Effort
          </span>
          <select
            value={settings.codexReasoningEffort || selectedCodexModel?.defaultReasoningEffort}
            onChange={(event) => handleCodexReasoningEffortChange(event.target.value)}
            disabled={disabled || isRuntimeActionPending}
            className="h-8 w-full rounded border border-editor-border bg-editor-bg px-2 text-xs capitalize text-editor-text outline-none focus:border-primary-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {reasoningEfforts.map((effort) => (
              <option key={effort} value={effort}>
                {effort}
              </option>
            ))}
          </select>
        </label>
      </div>

      <CodexLoginFlow session={login} disabled={disabled} />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <SetupPill label="Codex" ready={codexInstalled} pending={codexStatus.loading} />
            <SetupPill
              label={formatAuthStatus(effectiveAuthStatus)}
              ready={authenticated}
              pending={codexStatus.loading || isSigningIn}
            />
            <SetupPill label="OpenReelio tools" ready={toolsReady} pending={isConfiguring} />
          </div>
          <p className="mt-2 text-xs leading-5 text-editor-text-muted">{statusLine}</p>
          {installProgressLine && (
            <p
              className="mt-1 text-[11px] leading-5 text-editor-text-muted"
              data-testid="codex-install-progress"
            >
              {installProgressLine}
            </p>
          )}
          {showDiagnostics && (
            <div data-testid="codex-runtime-diagnostics">
              {codexVersion && (
                <p className="mt-1 truncate text-[11px] text-editor-text-muted">{codexVersion}</p>
              )}
              <p className="mt-1 truncate text-[11px] text-editor-text-muted">
                Storage: OpenReelio-managed Codex profile
                {runtimeSourceLabel ? ` (${runtimeSourceLabel})` : ''}
              </p>
              {codexHome && (
                <p className="mt-1 truncate text-[11px] text-editor-text-muted">
                  CODEX_HOME: {codexHome}
                </p>
              )}
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {canInstallCodex && (
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
              Install Codex
            </button>
          )}
          {codexNeedsUpdate && (
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
              {pinnedVersion ? `Update to ${pinnedVersion}` : 'Update Codex'}
            </button>
          )}
          {requiresLogin && (
            <button
              type="button"
              onClick={handleSignIn}
              disabled={disabled || isRuntimeActionPending}
              className="inline-flex h-8 items-center gap-1.5 rounded bg-primary-500 px-3 text-xs font-medium text-white hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isSigningIn && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Sign in with Codex
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
            onClick={configureCodex}
            disabled={disabled || isRuntimeActionPending}
            className="inline-flex h-8 items-center gap-1.5 rounded border border-editor-border px-2 text-xs text-editor-text hover:bg-editor-bg-hover disabled:cursor-not-allowed disabled:opacity-50"
            aria-label="Reconnect Codex"
            title="Reconnect Codex"
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
            checked={settings.codexPreferSystem}
            onChange={(event) => onUpdate({ codexPreferSystem: event.target.checked })}
            disabled={disabled || isRuntimeActionPending}
            className="mt-0.5 h-3.5 w-3.5 shrink-0 disabled:cursor-not-allowed disabled:opacity-50"
          />
          <span className="min-w-0">
            <span className="block text-xs font-medium text-editor-text">
              Use system installation
            </span>
            <span className="mt-0.5 block text-[11px] leading-4 text-editor-text-muted">
              Prefer a Codex found on your PATH or system over the managed native binary. System
              installs can drift from the version OpenReelio was tested with.
            </span>
          </span>
        </label>
      </div>
    </div>
  );
}

export default CodexRuntimeControls;
