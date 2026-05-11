import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, Loader2, RefreshCw } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';

import { useExternalAgentHostStatus, EXTERNAL_AGENT_STATUS_REFRESH_EVENT } from '@/agents/external';
import type { AISettings, AssistantRuntime } from '@/stores/settingsStore';
import { useProjectStore } from '@/stores';

interface ExternalAgentRuntimeSettingsProps {
  settings: AISettings;
  onUpdate: (values: Partial<AISettings>) => void;
  disabled?: boolean;
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
}

interface CodexAgentLoginResult {
  success: boolean;
  authStatus: string;
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
    slug: 'gpt-5.4',
    displayName: 'gpt-5.4',
    defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
  },
  {
    slug: 'gpt-5.4-mini',
    displayName: 'GPT-5.4-Mini',
    defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
  },
  {
    slug: 'gpt-5.3-codex',
    displayName: 'gpt-5.3-codex',
    defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
  },
];

const RUNTIME_OPTIONS: Array<{
  value: AssistantRuntime;
  title: string;
  badge: string;
}> = [
  { value: 'api', title: 'Built-in API model', badge: 'API key' },
  { value: 'codex', title: 'Codex account agent', badge: 'OAuth' },
];

function isAuthenticated(authStatus?: string | null): boolean {
  return authStatus === 'signed-in' || authStatus === 'api-key';
}

function formatAuthStatus(authStatus?: string | null): string {
  if (authStatus === 'signed-in') return 'Signed in';
  if (authStatus === 'api-key') return 'API key login';
  if (authStatus === 'signed-out') return 'Sign-in required';
  if (authStatus === 'error') return 'Auth error';
  return 'Checking';
}

function formatActionError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('Win32') || message.includes('os error 193') || message.includes('%1')) {
    return 'The selected Codex launcher is not executable on this OS. OpenReelio needs a native Codex CLI launcher such as codex.cmd or codex.exe.';
  }
  return message;
}

function SetupPill({
  label,
  ready,
  pending = false,
}: {
  label: string;
  ready: boolean;
  pending?: boolean;
}): JSX.Element {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] ${
        ready
          ? 'border-green-600/30 bg-green-600/10 text-green-300'
          : 'border-editor-border bg-editor-bg text-editor-text-muted'
      }`}
    >
      {pending ? (
        <Loader2 className="h-3 w-3 animate-spin" />
      ) : ready ? (
        <CheckCircle2 className="h-3 w-3" />
      ) : (
        <AlertCircle className="h-3 w-3" />
      )}
      {label}
    </span>
  );
}

export function ExternalAgentRuntimeSettings({
  settings,
  onUpdate,
  disabled = false,
}: ExternalAgentRuntimeSettingsProps): JSX.Element {
  const projectPath = useProjectStore((state) => state.meta?.path ?? null);
  const [setupResult, setSetupResult] = useState<ConfigureCodexAgentRuntimeResult | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [modelCatalog, setModelCatalog] = useState<CodexModelCatalogResult | null>(null);
  const [isConfiguring, setIsConfiguring] = useState(false);
  const [isSigningIn, setIsSigningIn] = useState(false);
  const lastAutoConfigureKeyRef = useRef<string | null>(null);
  const codexSelected = settings.assistantRuntime === 'codex';
  const codexStatus = useExternalAgentHostStatus({
    hostEnabled: codexSelected,
    codexEnabled: codexSelected,
  });
  const codexRuntime = codexStatus.summary.runtimes.find(
    (runtime) => runtime.runtimeId === 'codex',
  );

  const effectiveAuthStatus = setupResult?.authStatus ?? codexRuntime?.authStatus ?? 'unknown';
  const codexInstalled = Boolean(
    setupResult?.installed ?? codexRuntime?.installStatus === 'installed',
  );
  const authenticated = isAuthenticated(effectiveAuthStatus);
  const toolsReady = Boolean(
    setupResult?.pluginMarketplaceConfigured && setupResult?.mcpConfigured,
  );
  const runtimeReady = Boolean(setupResult?.ready || (codexRuntime?.ready && toolsReady));
  const requiresLogin = Boolean(
    codexInstalled &&
    (setupResult?.requiresLogin ||
      (!authenticated && codexSelected && effectiveAuthStatus !== 'error')),
  );
  const hasProject = Boolean(projectPath);
  const codexModels = modelCatalog?.models.length ? modelCatalog.models : FALLBACK_CODEX_MODELS;
  const selectedCodexModel =
    codexModels.find((model) => model.slug === settings.codexModel) ?? codexModels[0];
  const reasoningEfforts = selectedCodexModel?.supportedReasoningEfforts.length
    ? selectedCodexModel.supportedReasoningEfforts
    : ['low', 'medium', 'high', 'xhigh'];

  const refreshExternalAgentStatus = useCallback(() => {
    window.dispatchEvent(new Event(EXTERNAL_AGENT_STATUS_REFRESH_EVENT));
  }, []);

  const configureCodex = useCallback(async () => {
    if (!codexSelected) return;
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
      if (!result.ready && result.installed && !result.requiresLogin && result.message) {
        setActionError(result.message);
      }
      refreshExternalAgentStatus();
    } catch (error) {
      setActionError(formatActionError(error));
    } finally {
      setIsConfiguring(false);
    }
  }, [codexSelected, projectPath, refreshExternalAgentStatus]);

  useEffect(() => {
    if (!codexSelected) {
      lastAutoConfigureKeyRef.current = null;
      return;
    }

    const autoConfigureKey = `${projectPath ?? 'no-project'}:${effectiveAuthStatus}`;
    if (lastAutoConfigureKeyRef.current === autoConfigureKey) {
      return;
    }
    lastAutoConfigureKeyRef.current = autoConfigureKey;
    void configureCodex();
  }, [codexSelected, configureCodex, effectiveAuthStatus, projectPath]);

  useEffect(() => {
    if (!codexSelected) {
      return;
    }

    let cancelled = false;
    async function loadCodexModels(): Promise<void> {
      try {
        const result = await invoke<CodexModelCatalogResult>('get_codex_model_catalog');
        if (cancelled) {
          return;
        }
        setModelCatalog(result);
        if (!settings.codexModel && result.defaultModel) {
          onUpdate({
            codexModel: result.defaultModel,
            codexReasoningEffort:
              result.defaultReasoningEffort as AISettings['codexReasoningEffort'],
          });
        }
      } catch {
        if (!cancelled) {
          setModelCatalog(null);
        }
      }
    }

    void loadCodexModels();
    return () => {
      cancelled = true;
    };
  }, [codexSelected, onUpdate, settings.codexModel]);

  const handleRuntimeSelect = useCallback(
    (runtime: AssistantRuntime) => {
      onUpdate({ assistantRuntime: runtime });
      if (runtime === 'api') {
        setActionError(null);
        setSetupResult(null);
      }
    },
    [onUpdate],
  );

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

  const handleSignIn = useCallback(async () => {
    setIsSigningIn(true);
    setActionError(null);
    try {
      const result = await invoke<CodexAgentLoginResult>('start_codex_login');
      if (!result.success) {
        setActionError(result.message ?? 'Codex sign-in did not complete.');
      }
      await configureCodex();
      refreshExternalAgentStatus();
    } catch (error) {
      setActionError(formatActionError(error));
    } finally {
      setIsSigningIn(false);
    }
  }, [configureCodex, refreshExternalAgentStatus]);

  const statusLine = useMemo(() => {
    if (!codexSelected) return 'OpenReelio will use the API provider and model below.';
    if (isSigningIn) return 'Opening the Codex sign-in flow...';
    if (isConfiguring) return 'Connecting Codex to OpenReelio tools...';
    if (!hasProject) return 'Open a project to attach OpenReelio tools.';
    if (!codexInstalled) {
      return setupResult?.message ?? codexRuntime?.reason ?? 'Codex CLI was not found.';
    }
    if (runtimeReady) return 'Codex is ready with OpenReelio tools.';
    if (requiresLogin) return 'Sign in to Codex to continue.';
    if (effectiveAuthStatus === 'error') {
      return (
        setupResult?.message ?? codexRuntime?.reason ?? 'Codex authentication could not be read.'
      );
    }
    return setupResult?.message ?? codexRuntime?.reason ?? 'Codex is not ready yet.';
  }, [
    codexRuntime?.reason,
    codexSelected,
    codexInstalled,
    effectiveAuthStatus,
    hasProject,
    isConfiguring,
    isSigningIn,
    requiresLogin,
    runtimeReady,
    setupResult?.message,
  ]);

  return (
    <section>
      <div className="mb-3 border-b border-editor-border pb-2">
        <h3 className="text-sm font-medium text-editor-text">Assistant Runtime</h3>
        <p className="mt-1 text-xs text-editor-text-muted">
          API models use stored credentials. OAuth agents use an installed local account.
        </p>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        {RUNTIME_OPTIONS.map((option) => {
          const selected = settings.assistantRuntime === option.value;
          return (
            <button
              key={option.value}
              type="button"
              onClick={() => handleRuntimeSelect(option.value)}
              disabled={disabled}
              aria-pressed={selected}
              className={`flex min-h-12 items-center justify-between gap-2 rounded border px-3 py-2 text-left transition-colors ${
                selected
                  ? 'border-primary-500 bg-primary-500/10 text-editor-text'
                  : 'border-editor-border bg-editor-bg text-editor-text-muted hover:bg-editor-bg-hover'
              } disabled:cursor-not-allowed disabled:opacity-50`}
            >
              <span className="min-w-0 truncate text-sm font-medium">{option.title}</span>
              <span className="shrink-0 rounded border border-editor-border px-1.5 py-0.5 text-[10px] text-editor-text-muted">
                {option.badge}
              </span>
            </button>
          );
        })}
      </div>

      {codexSelected && (
        <div className="mt-3 rounded border border-editor-border bg-editor-bg/40 p-3">
          <div className="mb-3 grid gap-2 sm:grid-cols-2">
            <label className="block min-w-0">
              <span className="mb-1 block text-[11px] font-medium text-editor-text-muted">
                Codex Model
              </span>
              <select
                value={settings.codexModel || selectedCodexModel?.slug || 'gpt-5.4'}
                onChange={(event) => handleCodexModelChange(event.target.value)}
                disabled={disabled || isSigningIn || isConfiguring}
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
                disabled={disabled || isSigningIn || isConfiguring}
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
              {setupResult?.version && (
                <p className="mt-1 truncate text-[11px] text-editor-text-muted">
                  {setupResult.version}
                </p>
              )}
            </div>

            <div className="flex shrink-0 items-center gap-2">
              {requiresLogin && (
                <button
                  type="button"
                  onClick={handleSignIn}
                  disabled={disabled || isSigningIn || isConfiguring}
                  className="inline-flex h-8 items-center gap-1.5 rounded bg-primary-500 px-3 text-xs font-medium text-white hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isSigningIn && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  Sign in with Codex
                </button>
              )}
              <button
                type="button"
                onClick={configureCodex}
                disabled={disabled || isSigningIn || isConfiguring}
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

          {actionError && (
            <p className="mt-2 rounded border border-yellow-600/20 bg-yellow-600/10 px-2 py-1.5 text-xs leading-5 text-yellow-200">
              {actionError}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

export default ExternalAgentRuntimeSettings;
