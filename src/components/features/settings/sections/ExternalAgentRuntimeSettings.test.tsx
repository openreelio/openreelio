import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AISettings } from '@/stores/settingsStore';
import { useProjectStore } from '@/stores';
import { ExternalAgentRuntimeSettings } from './ExternalAgentRuntimeSettings';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

const defaultSettings: AISettings = {
  assistantRuntime: 'api',
  codexModel: 'gpt-5.5',
  codexReasoningEffort: 'medium',
  claudeModel: 'sonnet',
  claudeEffort: 'medium',
  claudeAuthMode: 'subscription',
  codexPreferSystem: false,
  claudePreferSystem: false,
  primaryProvider: 'anthropic',
  primaryModel: 'claude-sonnet-4-5-20251015',
  visionProvider: null,
  visionModel: null,
  openaiApiKey: null,
  anthropicApiKey: null,
  googleApiKey: null,
  ollamaUrl: null,
  temperature: 0.3,
  maxTokens: 16384,
  frameExtractionRate: 1,
  monthlyBudgetCents: null,
  perRequestLimitCents: 50,
  currentMonthUsageCents: 0,
  currentUsageMonth: null,
  autoAnalyzeOnImport: false,
  autoCaptionOnImport: false,
  proposalReviewMode: 'always',
  cacheDurationHours: 24,
  localOnlyMode: false,
  seedanceApiKey: null,
  videoGenProvider: null,
  videoGenDefaultQuality: 'pro',
  videoGenBudgetCents: null,
  videoGenPerRequestLimitCents: 100,
};

describe('ExternalAgentRuntimeSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(invoke).mockImplementation((command) => {
      if (command === 'get_codex_status') {
        return Promise.resolve({
          installed: true,
          version: 'codex-cli 0.130.0',
          authStatus: 'signed-in',
          reason: null,
        });
      }
      if (command === 'configure_codex_agent_runtime') {
        return Promise.resolve({
          installed: true,
          version: 'codex-cli 0.130.0',
          authStatus: 'signed-in',
          ready: true,
          requiresLogin: false,
          pluginMarketplaceConfigured: true,
          mcpConfigured: true,
          message:
            'Codex is signed in. App-server tools will start when a session begins. No global Codex config was changed.',
        });
      }
      if (command === 'get_codex_model_catalog') {
        return Promise.resolve({
          installed: true,
          defaultModel: 'gpt-5.5',
          defaultReasoningEffort: 'medium',
          models: [
            {
              slug: 'gpt-5.5',
              displayName: 'gpt-5.5',
              defaultReasoningEffort: 'medium',
              supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
            },
            {
              slug: 'gpt-5.4-mini',
              displayName: 'GPT-5.4-Mini',
              defaultReasoningEffort: 'low',
              supportedReasoningEfforts: ['low', 'medium'],
            },
          ],
          reason: null,
        });
      }
      if (command === 'start_codex_login') {
        return Promise.resolve({
          success: true,
          authStatus: 'signed-in',
          message: 'Codex sign-in completed.',
        });
      }
      if (command === 'logout_codex_agent_runtime') {
        return Promise.resolve({
          success: true,
          authStatus: 'signed-out',
          message: 'Codex sign-out completed for the OpenReelio managed profile.',
        });
      }
      if (command === 'install_codex_cli') {
        return Promise.resolve({
          success: true,
          version: 'codex-cli 0.130.0',
          attemptedCommand: null,
          message: 'Codex CLI is already installed.',
        });
      }
      if (command === 'update_codex_cli') {
        return Promise.resolve({
          success: true,
          beforeVersion: 'codex-cli 0.130.0',
          afterVersion: 'codex-cli 0.130.0',
          attemptedCommand: 'codex update',
          message: 'Codex CLI update completed.',
        });
      }
      return Promise.reject(new Error(`Unexpected command: ${command}`));
    });
    useProjectStore.setState((state) => ({
      ...state,
      meta: {
        id: 'project-1',
        name: 'Project',
        path: '/project',
        createdAt: '2026-01-01T00:00:00.000Z',
        modifiedAt: '2026-01-01T00:00:00.000Z',
      },
    }));
  });

  it('should let users switch from API model runtime to Codex account agent', async () => {
    const onUpdate = vi.fn();

    render(
      <ExternalAgentRuntimeSettings
        settings={defaultSettings}
        onUpdate={onUpdate}
        disabled={false}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: /codex account agent/i }));

    expect(onUpdate).toHaveBeenCalledWith({ assistantRuntime: 'codex' });
  });

  it('should hide the legacy API runtime and coerce saved API settings to Codex', async () => {
    const onUpdate = vi.fn();

    render(
      <ExternalAgentRuntimeSettings
        settings={defaultSettings}
        onUpdate={onUpdate}
        disabled={false}
      />,
    );

    expect(screen.queryByRole('button', { name: /built-in api model/i })).not.toBeInTheDocument();
    expect(screen.getByText('Codex Model')).toBeInTheDocument();
    await waitFor(() => expect(onUpdate).toHaveBeenCalledWith({ assistantRuntime: 'codex' }));
  });

  it('should check Codex app-server readiness when Codex account agent is selected', async () => {
    render(
      <ExternalAgentRuntimeSettings
        settings={{ ...defaultSettings, assistantRuntime: 'codex' }}
        onUpdate={vi.fn()}
        disabled={false}
      />,
    );

    await waitFor(() => expect(screen.getByText(/Codex is signed in/i)).toBeInTheDocument());
    expect(screen.getByText('OpenReelio tools')).toBeInTheDocument();
    expect(vi.mocked(invoke)).toHaveBeenCalledWith('configure_codex_agent_runtime', {
      input: { projectPath: '/project' },
    });
  });

  it('should hide runtime paths and sources when diagnostics are disabled', async () => {
    vi.mocked(invoke).mockImplementation((command) => {
      if (command === 'get_codex_status') {
        return Promise.resolve({
          installed: true,
          version: 'codex-cli 0.130.0',
          authStatus: 'signed-in',
          reason: null,
          runtimeSource: 'private-runtime-source',
          codexHome: '/private/codex/home',
        });
      }
      if (command === 'configure_codex_agent_runtime') {
        return Promise.resolve({
          installed: true,
          version: 'codex-cli 0.130.0',
          authStatus: 'signed-in',
          ready: true,
          requiresLogin: false,
          pluginMarketplaceConfigured: true,
          mcpConfigured: true,
          message: 'Internal setup detail.',
          runtimeSource: 'private-runtime-source',
          codexHome: '/private/codex/home',
        });
      }
      if (command === 'get_codex_model_catalog') {
        return Promise.resolve({
          installed: true,
          defaultModel: 'gpt-5.5',
          defaultReasoningEffort: 'medium',
          models: [],
          reason: null,
        });
      }
      return Promise.reject(new Error(`Unexpected command: ${command}`));
    });

    render(
      <ExternalAgentRuntimeSettings
        settings={{ ...defaultSettings, assistantRuntime: 'codex' }}
        onUpdate={vi.fn()}
        diagnosticsEnabled={false}
      />,
    );

    await waitFor(() => expect(screen.getByText(/Codex is signed in/i)).toBeInTheDocument());
    expect(screen.queryByTestId('codex-runtime-diagnostics')).not.toBeInTheDocument();
    expect(screen.queryByText(/private-runtime-source/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/private\/codex\/home/i)).not.toBeInTheDocument();
  });

  it('should replace raw setup failures when diagnostics are disabled', async () => {
    vi.mocked(invoke).mockImplementation((command) => {
      if (command === 'get_codex_status') {
        return Promise.resolve({
          installed: true,
          version: 'codex-cli 0.130.0',
          authStatus: 'signed-in',
          reason: null,
        });
      }
      if (command === 'configure_codex_agent_runtime') {
        return Promise.reject(new Error('private-command --token secret-value'));
      }
      if (command === 'get_codex_model_catalog') {
        return Promise.resolve({
          installed: true,
          defaultModel: 'gpt-5.5',
          defaultReasoningEffort: 'medium',
          models: [],
          reason: null,
        });
      }
      return Promise.reject(new Error(`Unexpected command: ${command}`));
    });

    render(
      <ExternalAgentRuntimeSettings
        settings={{ ...defaultSettings, assistantRuntime: 'codex' }}
        onUpdate={vi.fn()}
        diagnosticsEnabled={false}
      />,
    );

    expect(
      await screen.findByText(
        'The Codex setup action could not be completed. Check your connection and try again.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/secret-value/i)).not.toBeInTheDocument();
  });

  it('should surface network guidance for native Codex download failures', async () => {
    vi.mocked(invoke).mockImplementation((command) => {
      if (command === 'get_codex_status') {
        return Promise.resolve({
          installed: false,
          version: null,
          authStatus: 'unknown',
          reason: 'Codex CLI was not found.',
        });
      }
      if (command === 'configure_codex_agent_runtime') {
        return Promise.resolve({
          installed: false,
          version: null,
          authStatus: 'unknown',
          ready: false,
          requiresLogin: false,
          pluginMarketplaceConfigured: false,
          mcpConfigured: false,
          message: 'Codex CLI was not found.',
        });
      }
      if (command === 'get_codex_model_catalog') {
        return Promise.resolve({
          installed: false,
          defaultModel: 'gpt-5.5',
          defaultReasoningEffort: 'medium',
          models: [],
          reason: 'Codex CLI was not found.',
        });
      }
      if (command === 'install_codex_cli') {
        return Promise.resolve({
          success: false,
          version: null,
          attemptedCommand: null,
          message:
            'Failed to download the Codex binary from https://internal.example/secret-token: network connection timed out.',
        });
      }
      return Promise.reject(new Error(`Unexpected command: ${command}`));
    });

    render(
      <ExternalAgentRuntimeSettings
        settings={{ ...defaultSettings, assistantRuntime: 'codex' }}
        onUpdate={vi.fn()}
        diagnosticsEnabled={false}
      />,
    );

    await userEvent.click(await screen.findByRole('button', { name: /install codex/i }));

    expect(
      await screen.findByText('Check your network connection and try again.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/secret-token/i)).not.toBeInTheDocument();
  });

  it('should treat native Codex app tools as ready even when optional MCP setup fails', async () => {
    vi.mocked(invoke).mockImplementation((command) => {
      if (command === 'get_codex_status') {
        return Promise.resolve({
          installed: true,
          version: 'codex-cli 0.130.0',
          authStatus: 'signed-in',
          reason: null,
        });
      }
      if (command === 'configure_codex_agent_runtime') {
        return Promise.resolve({
          installed: true,
          version: 'codex-cli 0.130.0',
          authStatus: 'signed-in',
          ready: false,
          requiresLogin: false,
          pluginMarketplaceConfigured: true,
          mcpConfigured: false,
          message: 'Codex MCP setup failed.',
        });
      }
      if (command === 'get_codex_model_catalog') {
        return Promise.resolve({
          installed: true,
          defaultModel: 'gpt-5.5',
          defaultReasoningEffort: 'medium',
          models: [],
          reason: null,
        });
      }
      return Promise.reject(new Error(`Unexpected command: ${command}`));
    });

    render(
      <ExternalAgentRuntimeSettings
        settings={{ ...defaultSettings, assistantRuntime: 'codex' }}
        onUpdate={vi.fn()}
        disabled={false}
      />,
    );

    await waitFor(() => expect(screen.getByText(/Codex is signed in/i)).toBeInTheDocument());
    expect(screen.queryByText('Codex MCP setup failed.')).not.toBeInTheDocument();
  });

  it('should start a streamed Codex sign-in and surface the fallback link', async () => {
    // Controllable `listen` so the test can drive the login stream events.
    const listeners = new Map<string, (payload: unknown) => void>();
    vi.mocked(listen).mockImplementation((eventName, callback) => {
      const name = String(eventName);
      listeners.set(name, (payload) => callback({ event: name, id: 0, payload }));
      return Promise.resolve(() => {
        listeners.delete(name);
      });
    });
    const emitLogin = (eventName: string, payload: unknown): void =>
      listeners.get(eventName)?.(payload);

    let capturedSessionId: string | null = null;
    const fallbackUrl = 'https://auth.openai.com/oauth/authorize?client_id=abc&state=xyz';

    vi.mocked(invoke).mockImplementation((command, args) => {
      if (command === 'get_codex_status') {
        return Promise.resolve({
          installed: true,
          version: 'codex-cli 0.130.0',
          authStatus: 'signed-out',
          reason: 'Codex is not authenticated',
        });
      }
      if (command === 'configure_codex_agent_runtime') {
        return Promise.resolve({
          installed: true,
          version: 'codex-cli 0.130.0',
          authStatus: 'signed-out',
          ready: false,
          requiresLogin: true,
          pluginMarketplaceConfigured: true,
          mcpConfigured: true,
          message: 'Codex needs sign-in.',
        });
      }
      if (command === 'get_codex_model_catalog') {
        return Promise.resolve({
          installed: true,
          defaultModel: 'gpt-5.5',
          defaultReasoningEffort: 'medium',
          models: [],
          reason: null,
        });
      }
      if (command === 'start_codex_login_session') {
        const sessionId = (args as { sessionId: string }).sessionId;
        capturedSessionId = sessionId;
        return Promise.resolve({ sessionId, eventName: `codex:login:${sessionId}` });
      }
      return Promise.reject(new Error(`Unexpected command: ${command}`));
    });

    render(
      <ExternalAgentRuntimeSettings
        settings={{ ...defaultSettings, assistantRuntime: 'codex' }}
        onUpdate={vi.fn()}
        disabled={false}
      />,
    );

    const signInButton = await screen.findByRole('button', { name: /sign in with codex/i });
    await userEvent.click(signInButton);

    // The streamed session starts; the legacy blocking command is not used.
    expect(vi.mocked(invoke)).toHaveBeenCalledWith(
      'start_codex_login_session',
      expect.objectContaining({ sessionId: expect.any(String) }),
    );
    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith('start_codex_login');

    await waitFor(() => expect(capturedSessionId).not.toBeNull());

    // The backend surfaces the OAuth URL; the flow shows it as a fallback link.
    emitLogin(`codex:login:${capturedSessionId}`, { type: 'url', url: fallbackUrl });

    await waitFor(() => expect(screen.getByText(fallbackUrl)).toBeInTheDocument());
    expect(screen.getByTestId('codex-login-flow')).toHaveTextContent(/open this link/i);
  });

  it('should reflect Codex sign-in completion from a success stream event', async () => {
    const listeners = new Map<string, (payload: unknown) => void>();
    vi.mocked(listen).mockImplementation((eventName, callback) => {
      const name = String(eventName);
      listeners.set(name, (payload) => callback({ event: name, id: 0, payload }));
      return Promise.resolve(() => {
        listeners.delete(name);
      });
    });
    const emitLogin = (eventName: string, payload: unknown): void =>
      listeners.get(eventName)?.(payload);

    let capturedSessionId: string | null = null;
    let loggedIn = false;

    vi.mocked(invoke).mockImplementation((command, args) => {
      if (command === 'get_codex_status') {
        return Promise.resolve({
          installed: true,
          version: 'codex-cli 0.130.0',
          authStatus: loggedIn ? 'signed-in' : 'signed-out',
          reason: null,
        });
      }
      if (command === 'configure_codex_agent_runtime') {
        return Promise.resolve({
          installed: true,
          version: 'codex-cli 0.130.0',
          authStatus: loggedIn ? 'signed-in' : 'signed-out',
          ready: loggedIn,
          requiresLogin: !loggedIn,
          pluginMarketplaceConfigured: true,
          mcpConfigured: true,
          message: loggedIn ? 'Codex is signed in.' : 'Codex needs sign-in.',
        });
      }
      if (command === 'get_codex_model_catalog') {
        return Promise.resolve({
          installed: true,
          defaultModel: 'gpt-5.5',
          defaultReasoningEffort: 'medium',
          models: [],
          reason: null,
        });
      }
      if (command === 'start_codex_login_session') {
        const sessionId = (args as { sessionId: string }).sessionId;
        capturedSessionId = sessionId;
        return Promise.resolve({ sessionId, eventName: `codex:login:${sessionId}` });
      }
      return Promise.reject(new Error(`Unexpected command: ${command}`));
    });

    render(
      <ExternalAgentRuntimeSettings
        settings={{ ...defaultSettings, assistantRuntime: 'codex' }}
        onUpdate={vi.fn()}
        disabled={false}
      />,
    );

    const signInButton = await screen.findByRole('button', { name: /sign in with codex/i });
    await userEvent.click(signInButton);

    await waitFor(() => expect(capturedSessionId).not.toBeNull());

    // Completion arrives as a success event carrying only the re-probed status.
    loggedIn = true;
    emitLogin(`codex:login:${capturedSessionId}`, { type: 'success', authStatus: 'signed-in' });

    await waitFor(() => expect(screen.getByText(/Codex is signed in/i)).toBeInTheDocument());
  });

  it('should sign out of the OpenReelio-managed Codex profile', async () => {
    render(
      <ExternalAgentRuntimeSettings
        settings={{ ...defaultSettings, assistantRuntime: 'codex' }}
        onUpdate={vi.fn()}
        disabled={false}
      />,
    );

    const signOutButton = await screen.findByRole('button', { name: /sign out/i });
    await userEvent.click(signOutButton);

    expect(vi.mocked(invoke)).toHaveBeenCalledWith('logout_codex_agent_runtime');
  });

  it('should keep Codex sign-out failures visible', async () => {
    vi.mocked(invoke).mockImplementation((command) => {
      if (command === 'get_codex_status') {
        return Promise.resolve({
          installed: true,
          version: 'codex-cli 0.130.0',
          authStatus: 'signed-in',
          reason: null,
        });
      }
      if (command === 'configure_codex_agent_runtime') {
        return Promise.resolve({
          installed: true,
          version: 'codex-cli 0.130.0',
          authStatus: 'signed-in',
          ready: true,
          requiresLogin: false,
          pluginMarketplaceConfigured: true,
          mcpConfigured: true,
          message: 'Codex is signed in.',
        });
      }
      if (command === 'get_codex_model_catalog') {
        return Promise.resolve({
          installed: true,
          defaultModel: 'gpt-5.5',
          defaultReasoningEffort: 'medium',
          models: [],
          reason: null,
        });
      }
      if (command === 'logout_codex_agent_runtime') {
        return Promise.resolve({
          success: false,
          authStatus: 'signed-in',
          message: 'Codex sign-out did not complete.',
        });
      }
      return Promise.reject(new Error(`Unexpected command: ${command}`));
    });

    render(
      <ExternalAgentRuntimeSettings
        settings={{ ...defaultSettings, assistantRuntime: 'codex' }}
        onUpdate={vi.fn()}
        disabled={false}
      />,
    );

    const signOutButton = await screen.findByRole('button', { name: /sign out/i });
    await userEvent.click(signOutButton);

    await waitFor(() =>
      expect(screen.getByText('Codex sign-out did not complete.')).toBeInTheDocument(),
    );
  });

  it('should show signed-out state when sign-out succeeds but reconfigure fails', async () => {
    let configureCalls = 0;
    vi.mocked(invoke).mockImplementation((command) => {
      if (command === 'get_codex_status') {
        return Promise.resolve({
          installed: true,
          version: 'codex-cli 0.130.0',
          authStatus: 'signed-in',
          reason: null,
        });
      }
      if (command === 'configure_codex_agent_runtime') {
        configureCalls += 1;
        if (configureCalls > 1) {
          return Promise.reject(new Error('Codex status refresh failed.'));
        }
        return Promise.resolve({
          installed: true,
          version: 'codex-cli 0.130.0',
          authStatus: 'signed-in',
          ready: true,
          requiresLogin: false,
          pluginMarketplaceConfigured: true,
          mcpConfigured: true,
          message: 'Codex is signed in.',
        });
      }
      if (command === 'get_codex_model_catalog') {
        return Promise.resolve({
          installed: true,
          defaultModel: 'gpt-5.5',
          defaultReasoningEffort: 'medium',
          models: [],
          reason: null,
        });
      }
      if (command === 'logout_codex_agent_runtime') {
        return Promise.resolve({
          success: true,
          authStatus: 'signed-out',
          message: 'Codex sign-out completed for the OpenReelio managed profile.',
        });
      }
      return Promise.reject(new Error(`Unexpected command: ${command}`));
    });

    render(
      <ExternalAgentRuntimeSettings
        settings={{ ...defaultSettings, assistantRuntime: 'codex' }}
        onUpdate={vi.fn()}
        disabled={false}
      />,
    );

    const signOutButton = await screen.findByRole('button', { name: /sign out/i });
    await userEvent.click(signOutButton);

    expect(await screen.findByRole('button', { name: /sign in with codex/i })).toBeInTheDocument();
    expect(screen.getByText('Codex status refresh failed.')).toBeInTheDocument();
  });

  it('should install Codex CLI from the settings panel when it is missing', async () => {
    vi.mocked(invoke).mockImplementation((command) => {
      if (command === 'get_codex_status') {
        return Promise.resolve({
          installed: false,
          version: null,
          authStatus: 'unknown',
          reason: 'Codex CLI was not found.',
        });
      }
      if (command === 'configure_codex_agent_runtime') {
        return Promise.resolve({
          installed: false,
          version: null,
          authStatus: 'unknown',
          ready: false,
          requiresLogin: false,
          pluginMarketplaceConfigured: false,
          mcpConfigured: false,
          message: 'Codex CLI was not found.',
        });
      }
      if (command === 'get_codex_model_catalog') {
        return Promise.resolve({
          installed: false,
          defaultModel: 'gpt-5.5',
          defaultReasoningEffort: 'medium',
          models: [],
          reason: 'Codex CLI was not found.',
        });
      }
      if (command === 'install_codex_cli') {
        return Promise.resolve({
          success: true,
          version: 'codex-cli 0.130.0',
          attemptedCommand: 'npm install -g @openai/codex',
          message: 'Codex CLI installation completed.',
        });
      }
      return Promise.reject(new Error(`Unexpected command: ${command}`));
    });

    render(
      <ExternalAgentRuntimeSettings
        settings={{ ...defaultSettings, assistantRuntime: 'codex' }}
        onUpdate={vi.fn()}
        disabled={false}
      />,
    );

    const installButton = await screen.findByRole('button', { name: /install codex/i });
    await userEvent.click(installButton);

    expect(vi.mocked(invoke)).toHaveBeenCalledWith('install_codex_cli');
  });

  it('should update Codex when the installed version differs from the pinned target', async () => {
    vi.mocked(invoke).mockImplementation((command) => {
      if (command === 'get_codex_status') {
        return Promise.resolve({
          installed: true,
          version: 'codex-cli 0.118.0',
          authStatus: 'signed-in',
          reason: null,
        });
      }
      if (command === 'configure_codex_agent_runtime') {
        return Promise.resolve({
          installed: true,
          version: 'codex-cli 0.118.0',
          authStatus: 'signed-in',
          ready: true,
          requiresLogin: false,
          pluginMarketplaceConfigured: true,
          mcpConfigured: true,
          message:
            'Codex is signed in. App-server tools will start when a session begins. No global Codex config was changed.',
          pinnedVersion: '0.144.4',
        });
      }
      if (command === 'get_codex_model_catalog') {
        return Promise.resolve({
          installed: true,
          defaultModel: 'gpt-5.4',
          defaultReasoningEffort: 'medium',
          models: [
            {
              slug: 'gpt-5.4',
              displayName: 'gpt-5.4',
              defaultReasoningEffort: 'medium',
              supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
            },
          ],
          reason: null,
        });
      }
      if (command === 'update_codex_cli') {
        return Promise.resolve({
          success: true,
          beforeVersion: 'codex-cli 0.118.0',
          afterVersion: 'codex-cli 0.130.0',
          attemptedCommand: 'codex update',
          message: 'Codex CLI update completed.',
        });
      }
      return Promise.reject(new Error(`Unexpected command: ${command}`));
    });

    render(
      <ExternalAgentRuntimeSettings
        settings={{ ...defaultSettings, assistantRuntime: 'codex' }}
        onUpdate={vi.fn()}
        disabled={false}
      />,
    );

    const updateButton = await screen.findByRole('button', { name: /update to 0\.144\.4/i });
    await userEvent.click(updateButton);

    expect(vi.mocked(invoke)).toHaveBeenCalledWith('update_codex_cli');
  });

  it('should hide the Codex update button when the installed version matches the pinned target', async () => {
    vi.mocked(invoke).mockImplementation((command) => {
      if (command === 'get_codex_status') {
        return Promise.resolve({
          installed: true,
          version: 'codex-cli 0.144.4',
          authStatus: 'signed-in',
          reason: null,
        });
      }
      if (command === 'configure_codex_agent_runtime') {
        return Promise.resolve({
          installed: true,
          version: 'codex-cli 0.144.4',
          authStatus: 'signed-in',
          ready: true,
          requiresLogin: false,
          pluginMarketplaceConfigured: true,
          mcpConfigured: true,
          message: 'Codex is signed in.',
          pinnedVersion: '0.144.4',
        });
      }
      if (command === 'get_codex_model_catalog') {
        return Promise.resolve({
          installed: true,
          defaultModel: 'gpt-5.5',
          defaultReasoningEffort: 'medium',
          models: [],
          reason: null,
        });
      }
      return Promise.reject(new Error(`Unexpected command: ${command}`));
    });

    render(
      <ExternalAgentRuntimeSettings
        settings={{ ...defaultSettings, assistantRuntime: 'codex' }}
        onUpdate={vi.fn()}
        disabled={false}
      />,
    );

    await waitFor(() => expect(screen.getByText(/Codex is signed in/i)).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /update to/i })).not.toBeInTheDocument();
  });

  it('should persist the Codex prefer-system setting from the advanced toggle', async () => {
    const onUpdate = vi.fn();

    render(
      <ExternalAgentRuntimeSettings
        settings={{ ...defaultSettings, assistantRuntime: 'codex' }}
        onUpdate={onUpdate}
        disabled={false}
      />,
    );

    const toggle = await screen.findByRole('checkbox', { name: /use system installation/i });
    await userEvent.click(toggle);

    expect(onUpdate).toHaveBeenCalledWith({ codexPreferSystem: true });
  });

  it('should show safe launcher guidance without exposing raw diagnostics', async () => {
    vi.mocked(invoke).mockImplementation((command) => {
      if (command === 'get_codex_status') {
        return Promise.resolve({
          installed: false,
          version: null,
          authStatus: 'unknown',
          reason:
            'Failed to run codex --version: The selected Codex launcher is not executable on this OS.',
        });
      }
      if (command === 'configure_codex_agent_runtime') {
        return Promise.resolve({
          installed: false,
          version: null,
          authStatus: 'unknown',
          ready: false,
          requiresLogin: false,
          pluginMarketplaceConfigured: false,
          mcpConfigured: false,
          message:
            'Failed to run codex --version: The selected Codex launcher is not executable on this OS.',
        });
      }
      if (command === 'get_codex_model_catalog') {
        return Promise.resolve({
          installed: false,
          defaultModel: 'gpt-5.5',
          defaultReasoningEffort: 'medium',
          models: [],
          reason: 'Codex is unavailable',
        });
      }
      return Promise.reject(new Error(`Unexpected command: ${command}`));
    });

    render(
      <ExternalAgentRuntimeSettings
        settings={{ ...defaultSettings, assistantRuntime: 'codex' }}
        onUpdate={vi.fn()}
        diagnosticsEnabled={false}
      />,
    );

    await waitFor(() =>
      expect(
        screen.getByText(
          'Codex could not be started on this device. Reinstall Codex and make sure its native launcher is available.',
        ),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByText(/not executable on this OS/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /sign in with codex/i })).not.toBeInTheDocument();
  });

  it('should let users select the Codex model and reasoning effort from the catalog', async () => {
    const onUpdate = vi.fn();

    const { rerender } = render(
      <ExternalAgentRuntimeSettings
        settings={{ ...defaultSettings, assistantRuntime: 'codex' }}
        onUpdate={onUpdate}
        disabled={false}
      />,
    );

    const modelSelect = await screen.findByLabelText(/codex model/i);
    await userEvent.selectOptions(modelSelect, 'gpt-5.4-mini');

    expect(onUpdate).toHaveBeenCalledWith({
      codexModel: 'gpt-5.4-mini',
      codexReasoningEffort: 'low',
    });

    rerender(
      <ExternalAgentRuntimeSettings
        settings={{
          ...defaultSettings,
          assistantRuntime: 'codex',
          codexModel: 'gpt-5.4-mini',
          codexReasoningEffort: 'low',
        }}
        onUpdate={onUpdate}
        disabled={false}
      />,
    );
    const effortSelect = screen.getByLabelText(/reasoning effort/i);
    await userEvent.selectOptions(effortSelect, 'medium');

    expect(onUpdate).toHaveBeenCalledWith({ codexReasoningEffort: 'medium' });
  });

  it('should replace an unavailable saved Codex model with the catalog default', async () => {
    vi.mocked(invoke).mockImplementation((command) => {
      if (command === 'get_codex_status') {
        return Promise.resolve({
          installed: true,
          version: 'codex-cli 0.129.0',
          authStatus: 'signed-in',
          reason: null,
        });
      }
      if (command === 'configure_codex_agent_runtime') {
        return Promise.resolve({
          installed: true,
          version: 'codex-cli 0.129.0',
          authStatus: 'signed-in',
          ready: true,
          requiresLogin: false,
          pluginMarketplaceConfigured: true,
          mcpConfigured: true,
          message:
            'Codex is signed in. App-server tools will start when a session begins. No global Codex config was changed.',
        });
      }
      if (command === 'get_codex_model_catalog') {
        return Promise.resolve({
          installed: true,
          defaultModel: 'gpt-5.4',
          defaultReasoningEffort: 'medium',
          models: [
            {
              slug: 'gpt-5.4',
              displayName: 'gpt-5.4',
              defaultReasoningEffort: 'medium',
              supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
            },
          ],
          reason: null,
        });
      }
      return Promise.reject(new Error(`Unexpected command: ${command}`));
    });
    const onUpdate = vi.fn();

    render(
      <ExternalAgentRuntimeSettings
        settings={{ ...defaultSettings, assistantRuntime: 'codex', codexModel: 'gpt-5.5' }}
        onUpdate={onUpdate}
        disabled={false}
      />,
    );

    await waitFor(() =>
      expect(onUpdate).toHaveBeenCalledWith({
        codexModel: 'gpt-5.4',
        codexReasoningEffort: 'medium',
      }),
    );
  });

  describe('Claude Code runtime', () => {
    // The global test setup mocks `listen` as a no-op. Restore a valid default
    // for every Claude test so a prior test that installed a controllable
    // emitter cannot leave `listen` returning `undefined`.
    beforeEach(() => {
      vi.mocked(listen).mockImplementation(() => Promise.resolve(() => {}));
    });

    /**
     * Installs a controllable `listen` mock keyed by event name and returns an
     * `emit(eventName, payload)` helper to drive per-session stream events.
     */
    function mockControllableListen(): (eventName: string, payload: unknown) => void {
      const listeners = new Map<string, (payload: unknown) => void>();
      vi.mocked(listen).mockImplementation((eventName, callback) => {
        const name = String(eventName);
        listeners.set(name, (payload) => callback({ event: name, id: 0, payload }));
        return Promise.resolve(() => {
          listeners.delete(name);
        });
      });
      return (eventName, payload) => listeners.get(eventName)?.(payload);
    }

    function mockClaudeCommands(
      overrides: Partial<Record<string, () => Promise<unknown>>> = {},
    ): void {
      vi.mocked(invoke).mockImplementation((command) => {
        const override = overrides[command];
        if (override) {
          return override();
        }
        if (command === 'get_claude_status') {
          return Promise.resolve({
            installed: true,
            version: 'claude 1.2.0',
            authStatus: 'signed-in',
            reason: null,
            runtimeSource: 'managed',
            configHome: '/managed/claude',
          });
        }
        if (command === 'configure_claude_agent_runtime') {
          return Promise.resolve({
            installed: true,
            version: 'claude 1.2.0',
            authStatus: 'signed-in',
            ready: true,
            requiresLogin: false,
            message: 'Claude Code is signed in.',
            runtimeSource: 'managed',
            configHome: '/managed/claude',
          });
        }
        return Promise.reject(new Error(`Unexpected command: ${command}`));
      });
    }

    it('should let users switch to the Claude account agent', async () => {
      const onUpdate = vi.fn();

      render(
        <ExternalAgentRuntimeSettings
          settings={defaultSettings}
          onUpdate={onUpdate}
          disabled={false}
        />,
      );

      await userEvent.click(screen.getByRole('button', { name: /claude account agent/i }));

      expect(onUpdate).toHaveBeenCalledWith({ assistantRuntime: 'claude_code' });
    });

    it('should check Claude readiness when the Claude runtime is selected', async () => {
      mockClaudeCommands();

      render(
        <ExternalAgentRuntimeSettings
          settings={{ ...defaultSettings, assistantRuntime: 'claude_code' }}
          onUpdate={vi.fn()}
          disabled={false}
        />,
      );

      await waitFor(() =>
        expect(screen.getByText(/Claude Code is signed in/i)).toBeInTheDocument(),
      );
      expect(screen.getByText('Claude Model')).toBeInTheDocument();
      expect(screen.getByText('Effort')).toBeInTheDocument();
      expect(vi.mocked(invoke)).toHaveBeenCalledWith('configure_claude_agent_runtime', {
        input: { projectPath: '/project', authMode: 'subscription' },
      });
    });

    it('should persist the selected Claude effort', async () => {
      mockClaudeCommands();
      const onUpdate = vi.fn();

      render(
        <ExternalAgentRuntimeSettings
          settings={{ ...defaultSettings, assistantRuntime: 'claude_code' }}
          onUpdate={onUpdate}
          disabled={false}
        />,
      );

      const effortSelect = await screen.findByLabelText('Effort');
      await userEvent.selectOptions(effortSelect, 'high');

      expect(onUpdate).toHaveBeenCalledWith({ claudeEffort: 'high' });
    });

    it('should reveal a custom model input and persist a custom model id', async () => {
      mockClaudeCommands();
      const onUpdate = vi.fn();

      render(
        <ExternalAgentRuntimeSettings
          settings={{ ...defaultSettings, assistantRuntime: 'claude_code' }}
          onUpdate={onUpdate}
          disabled={false}
        />,
      );

      const modelSelect = await screen.findByLabelText('Claude Model');
      await userEvent.selectOptions(modelSelect, 'custom');

      const customInput = await screen.findByLabelText('Custom Claude model id');
      await userEvent.type(customInput, 'x');

      expect(onUpdate).toHaveBeenCalledWith({ claudeModel: 'x' });
    });

    it('should complete a fully in-app subscription sign-in without a visible terminal', async () => {
      const emitLogin = mockControllableListen();
      let capturedSessionId: string | null = null;
      // Flipped only once the login success event is emitted; keeps the mount-time
      // readiness probes reporting signed-out so the sign-in button stays visible.
      let loggedIn = false;

      vi.mocked(invoke).mockImplementation((command, args) => {
        if (command === 'get_claude_status') {
          return Promise.resolve({
            installed: true,
            version: 'claude 1.2.0',
            authStatus: loggedIn ? 'signed-in' : 'signed-out',
            reason: null,
            runtimeSource: 'managed',
            configHome: '/managed/claude',
          });
        }
        if (command === 'configure_claude_agent_runtime') {
          return Promise.resolve({
            installed: true,
            version: 'claude 1.2.0',
            authStatus: loggedIn ? 'signed-in' : 'signed-out',
            ready: loggedIn,
            requiresLogin: !loggedIn,
            message: loggedIn ? 'Claude Code is signed in.' : 'Claude needs sign-in.',
            runtimeSource: 'managed',
            configHome: '/managed/claude',
          });
        }
        if (command === 'start_claude_login_session') {
          const sessionId = (args as { sessionId: string }).sessionId;
          capturedSessionId = sessionId;
          return Promise.resolve({ sessionId, eventName: `claude:login:${sessionId}` });
        }
        if (command === 'submit_claude_login_code') {
          return Promise.resolve(null);
        }
        return Promise.reject(new Error(`Unexpected command: ${command}`));
      });

      render(
        <ExternalAgentRuntimeSettings
          settings={{ ...defaultSettings, assistantRuntime: 'claude_code' }}
          onUpdate={vi.fn()}
          disabled={false}
        />,
      );

      const signInButton = await screen.findByRole('button', { name: /sign in with claude/i });
      await userEvent.click(signInButton);

      // The in-app session starts (no `start_claude_login` visible-terminal call).
      await waitFor(() => expect(capturedSessionId).not.toBeNull());
      const eventName = `claude:login:${capturedSessionId}`;

      // The browser opens. The code input must appear now, WITHOUT waiting for
      // an `awaitingCode` signal (the CLI's paste prompt does not reliably reach
      // the transcript in this manual code-paste flow).
      emitLogin(eventName, { type: 'state', state: 'browserOpening' });

      const codeInput = await screen.findByLabelText('Claude authorization code');
      await userEvent.type(codeInput, 'auth-code-123');
      await userEvent.click(screen.getByRole('button', { name: /finish sign-in/i }));

      expect(vi.mocked(invoke)).toHaveBeenCalledWith('submit_claude_login_code', {
        sessionId: capturedSessionId,
        code: 'auth-code-123',
      });

      // The token is captured server-side; completion arrives as a success event
      // carrying only the re-probed status (which the re-probe now reports).
      loggedIn = true;
      emitLogin(eventName, { type: 'success', authStatus: 'signed-in' });

      await waitFor(() =>
        expect(screen.getByText(/Claude Code is signed in/i)).toBeInTheDocument(),
      );

      // The legacy visible-terminal login command is never used in this flow.
      expect(vi.mocked(invoke)).not.toHaveBeenCalledWith(
        'start_claude_login',
        expect.objectContaining({ input: expect.objectContaining({ mode: 'subscription' }) }),
      );
    });

    it('should show the fallback sign-in link when a url event arrives', async () => {
      const emitLogin = mockControllableListen();
      let capturedSessionId: string | null = null;
      const fallbackUrl =
        'https://claude.com/cai/oauth/authorize?code=true&client_id=abc123&state=xyz';

      vi.mocked(invoke).mockImplementation((command, args) => {
        if (command === 'get_claude_status') {
          return Promise.resolve({
            installed: true,
            version: 'claude 1.2.0',
            authStatus: 'signed-out',
            reason: 'Claude is not authenticated',
            runtimeSource: 'managed',
            configHome: '/managed/claude',
          });
        }
        if (command === 'configure_claude_agent_runtime') {
          return Promise.resolve({
            installed: true,
            version: 'claude 1.2.0',
            authStatus: 'signed-out',
            ready: false,
            requiresLogin: true,
            message: 'Claude needs sign-in.',
            runtimeSource: 'managed',
            configHome: '/managed/claude',
          });
        }
        if (command === 'start_claude_login_session') {
          const sessionId = (args as { sessionId: string }).sessionId;
          capturedSessionId = sessionId;
          return Promise.resolve({ sessionId, eventName: `claude:login:${sessionId}` });
        }
        return Promise.reject(new Error(`Unexpected command: ${command}`));
      });

      render(
        <ExternalAgentRuntimeSettings
          settings={{ ...defaultSettings, assistantRuntime: 'claude_code' }}
          onUpdate={vi.fn()}
          disabled={false}
        />,
      );

      const signInButton = await screen.findByRole('button', { name: /sign in with claude/i });
      await userEvent.click(signInButton);

      await waitFor(() => expect(capturedSessionId).not.toBeNull());
      const eventName = `claude:login:${capturedSessionId}`;

      // The backend recovers the sign-in URL (now extracted from the OSC 8
      // hyperlink) and emits it as a fallback link.
      emitLogin(eventName, { type: 'url', url: fallbackUrl });

      await waitFor(() => expect(screen.getByText(fallbackUrl)).toBeInTheDocument());
      expect(screen.getByTestId('claude-login-flow')).toHaveTextContent(/open this link/i);
    });

    it('should surface the manual fallback when the in-app sign-in cannot start', async () => {
      mockControllableListen();
      mockClaudeCommands({
        get_claude_status: () =>
          Promise.resolve({
            installed: true,
            version: 'claude 1.2.0',
            authStatus: 'signed-out',
            reason: 'Claude is not authenticated',
            runtimeSource: 'managed',
            configHome: '/managed/claude',
          }),
        configure_claude_agent_runtime: () =>
          Promise.resolve({
            installed: true,
            version: 'claude 1.2.0',
            authStatus: 'signed-out',
            ready: false,
            requiresLogin: true,
            message: 'Claude needs sign-in.',
            runtimeSource: 'managed',
            configHome: '/managed/claude',
          }),
        start_claude_login_session: () =>
          // Tauri surfaces a Rust `Err(String)` as a rejected string.
          Promise.reject('claude setup-token could not start. Run it manually.'),
      });

      render(
        <ExternalAgentRuntimeSettings
          settings={{ ...defaultSettings, assistantRuntime: 'claude_code' }}
          onUpdate={vi.fn()}
          disabled={false}
        />,
      );

      const signInButton = await screen.findByRole('button', { name: /sign in with claude/i });
      await userEvent.click(signInButton);

      await waitFor(() =>
        expect(screen.getByTestId('claude-login-flow')).toHaveTextContent(/run it manually/i),
      );
    });

    it('should save a Claude API key in api-key mode and clear the input', async () => {
      mockClaudeCommands({
        get_claude_status: () =>
          Promise.resolve({
            installed: true,
            version: 'claude 1.2.0',
            authStatus: 'signed-out',
            reason: 'Claude API key required',
            runtimeSource: 'managed',
            configHome: '/managed/claude',
          }),
        configure_claude_agent_runtime: () =>
          Promise.resolve({
            installed: true,
            version: 'claude 1.2.0',
            authStatus: 'signed-out',
            ready: false,
            requiresLogin: true,
            message: 'Claude needs an API key.',
            runtimeSource: 'managed',
            configHome: '/managed/claude',
          }),
        start_claude_login: () =>
          Promise.resolve({
            success: true,
            authStatus: 'api-key',
            message: 'Claude API key stored.',
          }),
      });

      render(
        <ExternalAgentRuntimeSettings
          settings={{ ...defaultSettings, assistantRuntime: 'claude_code', claudeAuthMode: 'api-key' }}
          onUpdate={vi.fn()}
          disabled={false}
        />,
      );

      const keyInput = await screen.findByLabelText('Claude API key');
      await userEvent.type(keyInput, 'sk-test-key');
      await userEvent.click(screen.getByRole('button', { name: /save key/i }));

      expect(vi.mocked(invoke)).toHaveBeenCalledWith('start_claude_login', {
        input: { mode: 'api-key', apiKey: 'sk-test-key' },
      });
      await waitFor(() =>
        expect((screen.getByLabelText('Claude API key') as HTMLInputElement).value).toBe(''),
      );
    });

    it('should persist a pasted setup-token in subscription mode and reflect sign-in', async () => {
      let configureCalls = 0;
      mockClaudeCommands({
        get_claude_status: () =>
          Promise.resolve({
            installed: true,
            version: 'claude 1.2.0',
            authStatus: 'signed-out',
            reason: 'Claude is not authenticated',
            runtimeSource: 'managed',
            configHome: '/managed/claude',
          }),
        configure_claude_agent_runtime: () => {
          configureCalls += 1;
          // First probe on mount reports sign-in required; once the token is
          // saved, the refreshed configure reports a signed-in runtime.
          if (configureCalls === 1) {
            return Promise.resolve({
              installed: true,
              version: 'claude 1.2.0',
              authStatus: 'signed-out',
              ready: false,
              requiresLogin: true,
              message: 'Claude needs sign-in.',
              runtimeSource: 'managed',
              configHome: '/managed/claude',
            });
          }
          return Promise.resolve({
            installed: true,
            version: 'claude 1.2.0',
            authStatus: 'signed-in',
            ready: true,
            requiresLogin: false,
            message: 'Claude Code is signed in.',
            runtimeSource: 'managed',
            configHome: '/managed/claude',
          });
        },
        start_claude_login: () =>
          Promise.resolve({
            success: true,
            authStatus: 'signed-in',
            message: 'Claude sign-in token stored.',
          }),
      });

      render(
        <ExternalAgentRuntimeSettings
          settings={{ ...defaultSettings, assistantRuntime: 'claude_code' }}
          onUpdate={vi.fn()}
          disabled={false}
        />,
      );

      const tokenInput = await screen.findByLabelText('Paste token from setup-token');
      await userEvent.type(tokenInput, 'setup-token-value');
      await userEvent.click(screen.getByRole('button', { name: /save token/i }));

      // Behavior: the runtime reflects the refreshed signed-in status and the
      // raw token is cleared from the field once submitted.
      await waitFor(() =>
        expect(screen.getByText(/Claude Code is signed in/i)).toBeInTheDocument(),
      );
      expect((screen.getByLabelText('Paste token from setup-token') as HTMLInputElement).value).toBe(
        '',
      );
    });

    it('should install Claude Code from the settings panel when it is missing', async () => {
      mockClaudeCommands({
        get_claude_status: () =>
          Promise.resolve({
            installed: false,
            version: null,
            authStatus: 'unknown',
            reason: 'Claude Code was not found.',
            runtimeSource: null,
            configHome: null,
          }),
        configure_claude_agent_runtime: () =>
          Promise.resolve({
            installed: false,
            version: null,
            authStatus: 'unknown',
            ready: false,
            requiresLogin: false,
            message: 'Claude Code was not found.',
            runtimeSource: null,
            configHome: null,
          }),
        install_claude_cli: () =>
          Promise.resolve({
            success: true,
            version: 'claude 1.2.0',
            attemptedCommand: 'Install Claude Code v1.2.0 (native binary)',
            message: 'Claude Code installation completed.',
          }),
      });

      render(
        <ExternalAgentRuntimeSettings
          settings={{ ...defaultSettings, assistantRuntime: 'claude_code' }}
          onUpdate={vi.fn()}
          disabled={false}
        />,
      );

      const installButton = await screen.findByRole('button', { name: /install claude code/i });
      await userEvent.click(installButton);

      expect(vi.mocked(invoke)).toHaveBeenCalledWith('install_claude_cli');
    });

    it('should offer a Claude update when the installed version differs from the pinned target', async () => {
      mockClaudeCommands({
        configure_claude_agent_runtime: () =>
          Promise.resolve({
            installed: true,
            version: 'claude 1.2.0',
            authStatus: 'signed-in',
            ready: true,
            requiresLogin: false,
            message: 'Claude Code is signed in.',
            runtimeSource: 'managed',
            configHome: '/managed/claude',
            pinnedVersion: '2.1.202',
          }),
        update_claude_cli: () =>
          Promise.resolve({
            success: true,
            beforeVersion: 'claude 1.2.0',
            afterVersion: 'claude 2.1.202',
            attemptedCommand: null,
            message: 'Claude Code update completed.',
          }),
      });

      render(
        <ExternalAgentRuntimeSettings
          settings={{ ...defaultSettings, assistantRuntime: 'claude_code' }}
          onUpdate={vi.fn()}
          disabled={false}
        />,
      );

      const updateButton = await screen.findByRole('button', { name: /update to 2\.1\.202/i });
      await userEvent.click(updateButton);

      expect(vi.mocked(invoke)).toHaveBeenCalledWith('update_claude_cli');
    });

    it('should hide the Claude update button when the installed version matches the pinned target', async () => {
      mockClaudeCommands({
        get_claude_status: () =>
          Promise.resolve({
            installed: true,
            version: 'claude 2.1.202',
            authStatus: 'signed-in',
            reason: null,
            runtimeSource: 'managed',
            configHome: '/managed/claude',
          }),
        configure_claude_agent_runtime: () =>
          Promise.resolve({
            installed: true,
            version: 'claude 2.1.202',
            authStatus: 'signed-in',
            ready: true,
            requiresLogin: false,
            message: 'Claude Code is signed in.',
            runtimeSource: 'managed',
            configHome: '/managed/claude',
            pinnedVersion: '2.1.202',
          }),
      });

      render(
        <ExternalAgentRuntimeSettings
          settings={{ ...defaultSettings, assistantRuntime: 'claude_code' }}
          onUpdate={vi.fn()}
          disabled={false}
        />,
      );

      await waitFor(() =>
        expect(screen.getByText(/Claude Code is signed in/i)).toBeInTheDocument(),
      );
      expect(screen.queryByRole('button', { name: /update to/i })).not.toBeInTheDocument();
    });

    it('should persist the Claude prefer-system setting from the advanced toggle', async () => {
      mockClaudeCommands();
      const onUpdate = vi.fn();

      render(
        <ExternalAgentRuntimeSettings
          settings={{ ...defaultSettings, assistantRuntime: 'claude_code' }}
          onUpdate={onUpdate}
          disabled={false}
        />,
      );

      const toggle = await screen.findByRole('checkbox', { name: /use system installation/i });
      await userEvent.click(toggle);

      expect(onUpdate).toHaveBeenCalledWith({ claudePreferSystem: true });
    });
  });
});
