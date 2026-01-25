/**
 * AISettingsSection Tests
 *
 * Tests for the AI settings section component in the settings dialog.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AISettingsSection, type AISettingsSectionProps } from './AISettingsSection';
import type { AISettings, ProviderType } from '@/stores/settingsStore';

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
  });

  describe('Rendering', () => {
    it('should render all sections', () => {
      render(<AISettingsSection {...defaultProps} />);

      expect(screen.getByText('Provider Configuration')).toBeInTheDocument();
      expect(screen.getByText('Generation Parameters')).toBeInTheDocument();
      expect(screen.getByText('Cost Controls')).toBeInTheDocument();
      expect(screen.getByText('Behavior')).toBeInTheDocument();
    });

    it('should render provider selector', () => {
      render(<AISettingsSection {...defaultProps} />);
      expect(screen.getByLabelText(/primary provider/i)).toBeInTheDocument();
    });

    it('should render temperature slider', () => {
      render(<AISettingsSection {...defaultProps} />);
      expect(screen.getByLabelText(/temperature/i)).toBeInTheDocument();
    });
  });

  describe('Provider Selection', () => {
    it('should display current provider', () => {
      render(<AISettingsSection {...defaultProps} />);
      const select = screen.getByLabelText(/primary provider/i) as HTMLSelectElement;
      expect(select.value).toBe('anthropic');
    });

    it('should call onUpdate when provider changes', async () => {
      const user = userEvent.setup();
      render(<AISettingsSection {...defaultProps} />);

      const select = screen.getByLabelText(/primary provider/i);
      await user.selectOptions(select, 'openai');

      expect(mockOnUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ primaryProvider: 'openai' })
      );
    });

    it('should show all provider options', () => {
      render(<AISettingsSection {...defaultProps} />);
      const select = screen.getByLabelText(/primary provider/i);

      expect(select).toContainHTML('OpenAI');
      expect(select).toContainHTML('Anthropic');
      expect(select).toContainHTML('Google Gemini');
      expect(select).toContainHTML('Local');
    });
  });

  describe('API Key Fields', () => {
    it('should show API key field for OpenAI when selected', () => {
      const settings = { ...defaultAISettings, primaryProvider: 'openai' as ProviderType };
      render(<AISettingsSection {...defaultProps} settings={settings} />);
      expect(screen.getByLabelText(/openai api key/i)).toBeInTheDocument();
    });

    it('should show API key field for Anthropic when selected', () => {
      render(<AISettingsSection {...defaultProps} />);
      expect(screen.getByLabelText(/anthropic api key/i)).toBeInTheDocument();
    });

    it('should show API key field for Gemini when selected', () => {
      const settings = { ...defaultAISettings, primaryProvider: 'gemini' as ProviderType };
      render(<AISettingsSection {...defaultProps} settings={settings} />);
      expect(screen.getByLabelText(/google api key/i)).toBeInTheDocument();
    });

    it('should show Ollama URL for local provider', () => {
      const settings = { ...defaultAISettings, primaryProvider: 'local' as ProviderType };
      render(<AISettingsSection {...defaultProps} settings={settings} />);
      expect(screen.getByLabelText(/ollama url/i)).toBeInTheDocument();
    });

    it('should mask API key input', () => {
      render(<AISettingsSection {...defaultProps} />);
      const input = screen.getByLabelText(/anthropic api key/i);
      expect(input).toHaveAttribute('type', 'password');
    });
  });

  describe('Generation Parameters', () => {
    it('should display current temperature', () => {
      render(<AISettingsSection {...defaultProps} />);
      expect(screen.getByText('0.3')).toBeInTheDocument();
    });

    it('should call onUpdate when temperature changes', () => {
      render(<AISettingsSection {...defaultProps} />);

      const slider = screen.getByLabelText(/temperature/i);
      // Simulate slider change
      fireEvent.change(slider, { target: { value: '0.7' } });

      expect(mockOnUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ temperature: 0.7 })
      );
    });

    it('should display max tokens input', () => {
      render(<AISettingsSection {...defaultProps} />);
      const input = screen.getByLabelText(/max tokens/i) as HTMLInputElement;
      expect(input.value).toBe('4096');
    });
  });

  describe('Behavior Settings', () => {
    it('should display proposal review mode selector', () => {
      render(<AISettingsSection {...defaultProps} />);
      expect(screen.getByLabelText(/proposal review mode/i)).toBeInTheDocument();
    });

    it('should call onUpdate when review mode changes', async () => {
      const user = userEvent.setup();
      render(<AISettingsSection {...defaultProps} />);

      const select = screen.getByLabelText(/proposal review mode/i);
      await user.selectOptions(select, 'smart');

      expect(mockOnUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ proposalReviewMode: 'smart' })
      );
    });

    it('should display auto-analyze toggle', () => {
      render(<AISettingsSection {...defaultProps} />);
      expect(screen.getByLabelText(/auto-analyze on import/i)).toBeInTheDocument();
    });

    it('should call onUpdate when auto-analyze changes', async () => {
      const user = userEvent.setup();
      render(<AISettingsSection {...defaultProps} />);

      const checkbox = screen.getByLabelText(/auto-analyze on import/i);
      await user.click(checkbox);

      expect(mockOnUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ autoAnalyzeOnImport: true })
      );
    });

    it('should display local only mode toggle', () => {
      render(<AISettingsSection {...defaultProps} />);
      expect(screen.getByLabelText(/local only mode/i)).toBeInTheDocument();
    });
  });

  describe('CostControlPanel Integration', () => {
    it('should display cost control panel', () => {
      render(<AISettingsSection {...defaultProps} />);
      expect(screen.getByText('Cost Controls')).toBeInTheDocument();
    });

    it('should pass disabled prop to cost control panel', () => {
      render(<AISettingsSection {...defaultProps} disabled={true} />);
      expect(screen.getByLabelText(/monthly budget/i)).toBeDisabled();
    });
  });

  describe('Disabled State', () => {
    it('should disable all inputs when disabled is true', () => {
      render(<AISettingsSection {...defaultProps} disabled={true} />);

      expect(screen.getByLabelText(/primary provider/i)).toBeDisabled();
      expect(screen.getByLabelText(/temperature/i)).toBeDisabled();
      expect(screen.getByLabelText(/max tokens/i)).toBeDisabled();
    });
  });
});
