import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { invoke } from '@tauri-apps/api/core';
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

  it('should start Codex login from the settings panel when sign-in is required', async () => {
    vi.mocked(invoke).mockImplementation((command) => {
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
      if (command === 'start_codex_login') {
        return Promise.resolve({
          success: true,
          authStatus: 'signed-in',
          message: 'Codex sign-in completed.',
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

    const signInButton = await screen.findByRole('button', { name: /sign in with codex/i });
    await userEvent.click(signInButton);

    expect(vi.mocked(invoke)).toHaveBeenCalledWith('start_codex_login');
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

  it('should update an old Codex CLI from the settings panel', async () => {
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

    const updateButton = await screen.findByRole('button', { name: /update codex/i });
    await userEvent.click(updateButton);

    expect(vi.mocked(invoke)).toHaveBeenCalledWith('update_codex_cli');
  });

  it('should not show sign-in when Codex cannot be launched on this OS', async () => {
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
        disabled={false}
      />,
    );

    await waitFor(() => expect(screen.getByText(/not executable on this OS/i)).toBeInTheDocument());
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
});
