/**
 * AISettingsSection Tests
 *
 * Tests for the AI settings section component in the settings dialog.
 * Tests model dropdown, secure API key storage, and parameter controls.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AISettingsSection, type AISettingsSectionProps } from './AISettingsSection';
import type { AISettings, ProviderType } from '@/stores/settingsStore';
import { invalidateModelCache } from '@/hooks/useAIModels';

// Mock Tauri invoke for credential and model operations
const mockInvoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

// Mock logger
vi.mock('@/services/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const defaultAISettings: AISettings = {
  primaryProvider: 'anthropic',
  primaryModel: 'claude-sonnet-4-5-20251015',
  visionProvider: null,
  visionModel: null,
  openaiApiKey: null,
  anthropicApiKey: null,
  googleApiKey: null,
  ollamaUrl: null,
  temperature: 0.3,
  maxTokens: 4096,
  frameExtractionRate: 1.0,
  monthlyBudgetCents: null,
  perRequestLimitCents: 50,
  currentMonthUsageCents: 0,
  currentUsageMonth: null,
  autoAnalyzeOnImport: false,
  autoCaptionOnImport: false,
  proposalReviewMode: 'always',
  cacheDurationHours: 24,
  localOnlyMode: false,
};

describe('AISettingsSection', () => {
  const mockOnUpdate = vi.fn();

  const defaultProps: AISettingsSectionProps = {
    settings: defaultAISettings,
    onUpdate: mockOnUpdate,
    disabled: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    invalidateModelCache();
    // Default mock implementation
    mockInvoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'get_credential_status') {
        return { openai: false, anthropic: false, google: false };
      }
      if (command === 'get_available_ai_models') {
        const provider = args?.providerType as string;
        switch (provider) {
          case 'openai':
            return ['gpt-5.2', 'gpt-5.1', 'gpt-4.1'];
          case 'anthropic':
            return [
              'claude-opus-4-5-20251115',
              'claude-sonnet-4-5-20251015',
              'claude-haiku-4-5-20251015',
            ];
          case 'gemini':
            return ['gemini-3-pro-preview', 'gemini-3-flash-preview'];
          case 'local':
            return ['llama3.2', 'mistral', 'codellama'];
          default:
            return [];
        }
      }
      return undefined;
    });
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('Rendering', () => {
    it('should render all sections', async () => {
      render(<AISettingsSection {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText('Provider Configuration')).toBeInTheDocument();
        expect(screen.getByText('Generation Parameters')).toBeInTheDocument();
        expect(screen.getByText('Cost Controls')).toBeInTheDocument();
        expect(screen.getByText('Behavior')).toBeInTheDocument();
      });
    });

    it('should render provider selector', async () => {
      render(<AISettingsSection {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByLabelText(/primary provider/i)).toBeInTheDocument();
      });
    });

    it('should render temperature slider', async () => {
      render(<AISettingsSection {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByLabelText(/temperature/i)).toBeInTheDocument();
      });
    });

    it('should render model dropdown with available models', async () => {
      render(<AISettingsSection {...defaultProps} />);
      await waitFor(() => {
        const modelSelect = screen.getByRole('combobox', { name: /model/i });
        expect(modelSelect).toBeInTheDocument();
        expect(modelSelect).toHaveValue('claude-sonnet-4-5-20251015');
      });
    });
  });

  describe('Provider Selection', () => {
    it('should display current provider', async () => {
      render(<AISettingsSection {...defaultProps} />);
      await waitFor(() => {
        const select = screen.getByLabelText(/primary provider/i) as HTMLSelectElement;
        expect(select.value).toBe('anthropic');
      });
    });

    it('should call onUpdate when provider changes', async () => {
      const user = userEvent.setup();
      render(<AISettingsSection {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByLabelText(/primary provider/i)).toBeInTheDocument();
      });

      const select = screen.getByLabelText(/primary provider/i);
      await user.selectOptions(select, 'openai');

      expect(mockOnUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ primaryProvider: 'openai', primaryModel: 'gpt-5.2' }),
      );
    });

    it('should show all provider options', async () => {
      render(<AISettingsSection {...defaultProps} />);
      await waitFor(() => {
        const select = screen.getByLabelText(/primary provider/i);
        expect(select).toContainHTML('OpenAI');
        expect(select).toContainHTML('Anthropic');
        expect(select).toContainHTML('Google Gemini');
        expect(select).toContainHTML('Local');
      });
    });
  });

  describe('API Key Fields', () => {
    it('should show API key field for OpenAI when selected', async () => {
      const settings = { ...defaultAISettings, primaryProvider: 'openai' as ProviderType };
      render(<AISettingsSection {...defaultProps} settings={settings} />);
      await waitFor(() => {
        expect(screen.getByText(/openai api key/i)).toBeInTheDocument();
      });
    });

    it('should show API key field for Anthropic when selected', async () => {
      render(<AISettingsSection {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByText(/anthropic api key/i)).toBeInTheDocument();
      });
    });

    it('should show API key field for Gemini when selected', async () => {
      const settings = { ...defaultAISettings, primaryProvider: 'gemini' as ProviderType };
      render(<AISettingsSection {...defaultProps} settings={settings} />);
      await waitFor(() => {
        expect(screen.getByText(/google api key/i)).toBeInTheDocument();
      });
    });

    it('should show Ollama URL for local provider', async () => {
      const settings = { ...defaultAISettings, primaryProvider: 'local' as ProviderType };
      render(<AISettingsSection {...defaultProps} settings={settings} />);
      await waitFor(() => {
        expect(screen.getByLabelText(/ollama url/i)).toBeInTheDocument();
      });
    });

    it('should mask API key input', async () => {
      render(<AISettingsSection {...defaultProps} />);
      await waitFor(() => {
        const input = screen.getByPlaceholderText(/sk-ant-/i);
        expect(input).toHaveAttribute('type', 'password');
      });
    });

    it('should show credential status badge', async () => {
      render(<AISettingsSection {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByText('Not configured')).toBeInTheDocument();
      });
    });

    it('should show configured status when credential exists', async () => {
      mockInvoke.mockImplementation(async (command: string) => {
        if (command === 'get_credential_status') {
          return { openai: false, anthropic: true, google: false };
        }
        if (command === 'get_available_ai_models') {
          return ['claude-sonnet-4-5-20251015'];
        }
        return undefined;
      });

      render(<AISettingsSection {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByText('Configured')).toBeInTheDocument();
      });
    });

    it('should show secure storage message', async () => {
      render(<AISettingsSection {...defaultProps} />);
      await waitFor(() => {
        expect(
          screen.getByText(/Your API key will be encrypted and stored securely/i),
        ).toBeInTheDocument();
      });
    });
  });

  describe('Generation Parameters', () => {
    it('should display current temperature', async () => {
      render(<AISettingsSection {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByText('0.3')).toBeInTheDocument();
      });
    });

    it('should call onUpdate when temperature changes', async () => {
      render(<AISettingsSection {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByLabelText(/temperature/i)).toBeInTheDocument();
      });

      const slider = screen.getByLabelText(/temperature/i);
      fireEvent.change(slider, { target: { value: '0.7' } });

      expect(mockOnUpdate).toHaveBeenCalledWith(expect.objectContaining({ temperature: 0.7 }));
    });

    it('should display max tokens input', async () => {
      render(<AISettingsSection {...defaultProps} />);
      await waitFor(() => {
        const input = screen.getByLabelText(/max tokens/i) as HTMLInputElement;
        expect(input.value).toBe('4096');
      });
    });
  });

  describe('Behavior Settings', () => {
    it('should display proposal review mode selector', async () => {
      render(<AISettingsSection {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByLabelText(/proposal review mode/i)).toBeInTheDocument();
      });
    });

    it('should call onUpdate when review mode changes', async () => {
      const user = userEvent.setup();
      render(<AISettingsSection {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByLabelText(/proposal review mode/i)).toBeInTheDocument();
      });

      const select = screen.getByLabelText(/proposal review mode/i);
      await user.selectOptions(select, 'smart');

      expect(mockOnUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ proposalReviewMode: 'smart' }),
      );
    });

    it('should display auto-analyze toggle', async () => {
      render(<AISettingsSection {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByLabelText(/auto-analyze on import/i)).toBeInTheDocument();
      });
    });

    it('should call onUpdate when auto-analyze changes', async () => {
      const user = userEvent.setup();
      render(<AISettingsSection {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByLabelText(/auto-analyze on import/i)).toBeInTheDocument();
      });

      const checkbox = screen.getByLabelText(/auto-analyze on import/i);
      await user.click(checkbox);

      expect(mockOnUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ autoAnalyzeOnImport: true }),
      );
    });

    it('should display local only mode toggle', async () => {
      render(<AISettingsSection {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByLabelText(/local only mode/i)).toBeInTheDocument();
      });
    });
  });

  describe('CostControlPanel Integration', () => {
    it('should display cost control panel', async () => {
      render(<AISettingsSection {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByText('Cost Controls')).toBeInTheDocument();
      });
    });

    it('should pass disabled prop to cost control panel', async () => {
      render(<AISettingsSection {...defaultProps} disabled={true} />);
      await waitFor(() => {
        expect(screen.getByLabelText(/monthly budget/i)).toBeDisabled();
      });
    });
  });

  describe('Disabled State', () => {
    it('should disable all inputs when disabled is true', async () => {
      render(<AISettingsSection {...defaultProps} disabled={true} />);

      await waitFor(() => {
        expect(screen.getByLabelText(/primary provider/i)).toBeDisabled();
        expect(screen.getByLabelText(/temperature/i)).toBeDisabled();
        expect(screen.getByLabelText(/max tokens/i)).toBeDisabled();
      });
    });
  });

  describe('Model Selection', () => {
    it('should load models from backend', async () => {
      render(<AISettingsSection {...defaultProps} />);

      await waitFor(() => {
        const modelSelect = screen.getByRole('combobox', { name: /model/i });
        const options = modelSelect.querySelectorAll('option');
        expect(options.length).toBe(3); // 3 Anthropic models
      });

      expect(mockInvoke).toHaveBeenCalledWith('get_available_ai_models', {
        providerType: 'anthropic',
      });
    });

    it('should update models when provider changes', async () => {
      const { rerender } = render(<AISettingsSection {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByLabelText(/primary provider/i)).toBeInTheDocument();
      });

      // Change to OpenAI
      const settings = {
        ...defaultAISettings,
        primaryProvider: 'openai' as ProviderType,
        primaryModel: 'gpt-5.2',
      };
      rerender(<AISettingsSection {...defaultProps} settings={settings} />);

      await waitFor(() => {
        expect(mockInvoke).toHaveBeenCalledWith('get_available_ai_models', {
          providerType: 'openai',
        });
      });
    });

    it('should handle model loading error gracefully', async () => {
      mockInvoke.mockImplementation(async (command: string) => {
        if (command === 'get_credential_status') {
          return { openai: false, anthropic: false, google: false };
        }
        if (command === 'get_available_ai_models') {
          throw new Error('Network error');
        }
        return undefined;
      });

      render(<AISettingsSection {...defaultProps} />);

      await waitFor(() => {
        // Should show fallback models even on error
        const modelSelect = screen.getByRole('combobox', { name: /model/i });
        expect(modelSelect).toBeInTheDocument();
      });
    });
  });

  describe('Security', () => {
    it('should not store API keys in settings object', async () => {
      const user = userEvent.setup();
      render(<AISettingsSection {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByPlaceholderText(/sk-ant-/i)).toBeInTheDocument();
      });

      const input = screen.getByPlaceholderText(/sk-ant-/i);
      await user.type(input, 'sk-ant-test123');

      // onUpdate should not have been called with the API key
      const allCalls = mockOnUpdate.mock.calls;
      const hasApiKey = allCalls.some((call) => JSON.stringify(call).includes('sk-ant-test123'));
      expect(hasApiKey).toBe(false);
    });

    it('should use password type for API key inputs', async () => {
      render(<AISettingsSection {...defaultProps} />);

      await waitFor(() => {
        const input = screen.getByPlaceholderText(/sk-ant-/i);
        expect(input).toHaveAttribute('type', 'password');
      });
    });

    it('should prevent autocomplete for API key inputs', async () => {
      render(<AISettingsSection {...defaultProps} />);

      await waitFor(() => {
        const input = screen.getByPlaceholderText(/sk-ant-/i);
        expect(input).toHaveAttribute('autocomplete', 'new-password');
      });
    });
  });
});
