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
  codexModel: 'gpt-5.4',
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
          message: 'Codex is connected with OpenReelio tools.',
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

  it('should automatically configure Codex tools when Codex account agent is selected', async () => {
    render(
      <ExternalAgentRuntimeSettings
        settings={{ ...defaultSettings, assistantRuntime: 'codex' }}
        onUpdate={vi.fn()}
        disabled={false}
      />,
    );

    await waitFor(() => expect(screen.getByText(/Codex is ready/i)).toBeInTheDocument());
    expect(screen.getByText('OpenReelio tools')).toBeInTheDocument();
    expect(vi.mocked(invoke)).toHaveBeenCalledWith('configure_codex_agent_runtime', {
      input: { projectPath: '/project' },
    });
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
          defaultModel: 'gpt-5.4',
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
          defaultModel: 'gpt-5.4',
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

    render(
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

    const effortSelect = screen.getByLabelText(/reasoning effort/i);
    await userEvent.selectOptions(effortSelect, 'high');

    expect(onUpdate).toHaveBeenCalledWith({ codexReasoningEffort: 'high' });
  });
});
